// Morning commute: homes to jobs over the street network, on a 50 m grid. Gravity choice of job centre, all-or-nothing routing,
// one congestion pass. Good enough to see where a city chokes; nothing here is calibrated against anything.
import { ROAD } from './roads.js';

const SPEED = { [ROAD.MOTORWAY]: 22, [ROAD.ARTERIAL]: 11, [ROAD.COLLECTOR]: 8, [ROAD.LOCAL]: 5 };
const CAPACITY = { [ROAD.MOTORWAY]: 8000, [ROAD.ARTERIAL]: 3600, [ROAD.COLLECTOR]: 1200, [ROAD.LOCAL]: 400 };
const CAR_SHARE = 0.25;  // of commuters; the rest ride the metro or walk; assumption
const PEAK_SHARE = 0.4;  // of commuters on the road in the busiest hour, set against hourly capacities; assumption
const MAX_DELAY = 4;     // congestion slows a street at most this much, or trips leave the network for free

export function assignCommute({ N, cell, urban, water, roads, homes, jobs, jobsPerPerson }) {
    const R = 2;
    const M = Math.floor(N / R);
    const size = cell * R;
    const halfExtent = N * cell / 2;
    const level = new Int8Array(M * M).fill(-1);
    for (const line of roads.lines) {
        if (line.level === ROAD.RAIL) continue;
        const pts = line.points;
        for (let p = 2; p < pts.length; p += 2) {
            const steps = Math.ceil(Math.hypot(pts[p] - pts[p - 2], pts[p + 1] - pts[p - 1]) / (size * 0.5));
            for (let s = 0; s <= steps; s++) {
                const x = pts[p - 2] + (pts[p] - pts[p - 2]) * s / Math.max(steps, 1), z = pts[p - 1] + (pts[p + 1] - pts[p - 1]) * s / Math.max(steps, 1);
                const i = Math.floor((x + halfExtent) / size), j = Math.floor((z + halfExtent) / size);
                if (i < 0 || j < 0 || i >= M || j >= M) continue;
                const k = j * M + i;
                if (level[k] < 0 || line.level < level[k]) level[k] = line.level;
            }
        }
    }
    // Water is impassable except on a street that crosses it.
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) if (level[j * M + i] < 0 && water[(j * R + 1) * N + i * R + 1]) level[j * M + i] = -2;
    const homeGrid = new Float32Array(M * M), jobGrid = new Float32Array(M * M);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = Math.min(j >> 1, M - 1) * M + Math.min(i >> 1, M - 1);
        homeGrid[k] += homes[j * N + i];
        jobGrid[k] += jobs[j * N + i];
    }
    // Job hubs: the heaviest 12 tiles of a 2.5 km mesh.
    const hubMesh = Math.max(1, Math.floor(2500 / size));
    const hubs = [];
    for (let y = 0; y < M; y += hubMesh) for (let x = 0; x < M; x += hubMesh) {
        let sum = 0, bx = x, by = y, best = -1;
        for (let b = y; b < Math.min(y + hubMesh, M); b++) for (let a = x; a < Math.min(x + hubMesh, M); a++) {
            const v = jobGrid[b * M + a];
            sum += v;
            if (v > best && level[b * M + a] >= 0) { best = v; bx = a; by = b; }
        }
        if (sum > 0) hubs.push({ x: bx, y: by, jobs: sum });
    }
    hubs.sort((a, b) => b.jobs - a.jobs);
    const top = hubs.slice(0, 12);
    if (!top.length) return { load: new Float32Array(M * M), M, size, stats: { commuteMinutes: 0, congested: 0 } };

    let extra = null;
    let load = new Float32Array(M * M);
    let meanMinutes = 0, congested = 0;
    for (let pass = 0; pass < 2; pass++) {
        const trees = top.map((hub) => dijkstra(hub, level, extra, M, size));
        const sumLoad = new Float32Array(M * M);
        let totalTime = 0, totalPeople = 0;
        const shares = new Float32Array(top.length);
        const dest = new Int16Array(M * M).fill(-1);
        const weights = new Float32Array(M * M);
        for (let k = 0; k < M * M; k++) {
            const people = homeGrid[k];
            if (!people) continue;
            let sum = 0, bestTree = -1, bestScore = -1;
            for (let t = 0; t < top.length; t++) {
                const time = trees[t].time[k];
                shares[t] = time < 1e8 ? top[t].jobs * Math.exp(-time / 1500) : 0;
                sum += shares[t];
                if (shares[t] > bestScore) { bestScore = shares[t]; bestTree = t; }
            }
            if (bestTree < 0 || sum <= 0) continue;
            // The trip actually routed: everyone in the tile goes to its strongest hub.
            totalTime += trees[bestTree].time[k] * people;
            totalPeople += people;
            dest[k] = bestTree;
            weights[k] = people * jobsPerPerson * CAR_SHARE * PEAK_SHARE;
        }
        // Accumulate along each tree in decreasing time order.
        for (let t = 0; t < top.length; t++) {
            const flow = new Float32Array(M * M);
            for (let k = 0; k < M * M; k++) if (dest[k] === t) flow[k] = weights[k];
            for (const k of trees[t].order) {
                const up = trees[t].parent[k];
                if (up >= 0 && flow[k] > 0) flow[up] += flow[k];
            }
            for (let k = 0; k < M * M; k++) sumLoad[k] += flow[k];
        }
        // Average with the first pass, or all traffic jumps off the streets the first pass filled.
        for (let k = 0; k < M * M; k++) load[k] = pass === 0 ? sumLoad[k] : 0.5 * (load[k] + sumLoad[k]);
        meanMinutes = totalPeople > 0 ? totalTime / totalPeople / 60 : 0;
        // Bureau of Public Roads delay for the second pass.
        extra = new Float32Array(M * M);
        congested = 0;
        let roadCells = 0;
        for (let k = 0; k < M * M; k++) {
            if (level[k] < 0) continue;
            const ratio = load[k] / CAPACITY[level[k]];
            extra[k] = Math.min(MAX_DELAY, 1 + 0.15 * Math.pow(ratio, 4));
            // Share of city streets: rural arterials would dilute it.
            const j = (k - k % M) / M, i = k % M;
            if (!urban[j * R * N + i * R]) continue;
            roadCells++;
            if (ratio > 1) congested++;
        }
        congested = roadCells ? congested / roadCells : 0;
    }
    return { load, M, size, stats: { commuteMinutes: meanMinutes, congested }, capacity: Array.from(level, (v) => (v < 0 ? 0 : CAPACITY[v])) };
}

function dijkstra(hub, level, delay, M, size) {
    const time = new Float32Array(M * M).fill(1e9);
    const parent = new Int32Array(M * M).fill(-1);
    const order = new Int32Array(M * M);
    let filled = 0;
    const heap = new Heap(M * M);
    const start = hub.y * M + hub.x;
    time[start] = 0;
    heap.push(start, 0);
    const walk = size / 1.3;
    const done = new Uint8Array(M * M);
    while (heap.size) {
        const k = heap.pop();
        if (done[k]) continue;
        done[k] = 1;
        order[filled++] = k;
        const x = k % M, y = (k - x) / M;
        for (let n = 0; n < 4; n++) {
            const nx = x + (n === 0 ? 1 : n === 1 ? -1 : 0), ny = y + (n === 2 ? 1 : n === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= M || ny >= M) continue;
            const q = ny * M + nx;
            if (done[q]) continue;
            const lev = level[q];
            if (lev === -2) continue;
            let w = lev >= 0 ? size / SPEED[lev] : walk;
            if (delay && lev >= 0) w *= delay[q];
            const t = time[k] + w;
            if (t < time[q]) {
                time[q] = t;
                parent[q] = k;
                heap.push(q, t);
            }
        }
    }
    // Decreasing time: children before their parent.
    const reversed = order.slice(0, filled).reverse();
    return { time, parent, order: reversed };
}

class Heap {
    constructor(capacity) {
        this.keys = new Int32Array(capacity + 16);
        this.vals = new Float32Array(capacity + 16);
        this.size = 0;
    }

    push(key, value) {
        if (this.size === this.keys.length) {
            const k = new Int32Array(this.keys.length * 2), v = new Float32Array(this.keys.length * 2);
            k.set(this.keys);
            v.set(this.vals);
            this.keys = k;
            this.vals = v;
        }
        let i = this.size++;
        while (i > 0) {
            const up = (i - 1) >> 1;
            if (this.vals[up] <= value) break;
            this.keys[i] = this.keys[up];
            this.vals[i] = this.vals[up];
            i = up;
        }
        this.keys[i] = key;
        this.vals[i] = value;
    }

    pop() {
        const top = this.keys[0];
        const key = this.keys[--this.size], value = this.vals[this.size];
        let i = 0;
        while (true) {
            let child = 2 * i + 1;
            if (child >= this.size) break;
            if (child + 1 < this.size && this.vals[child + 1] < this.vals[child]) child++;
            if (this.vals[child] >= value) break;
            this.keys[i] = this.keys[child];
            this.vals[i] = this.vals[child];
            i = child;
        }
        this.keys[i] = key;
        this.vals[i] = value;
        return top;
    }
}
