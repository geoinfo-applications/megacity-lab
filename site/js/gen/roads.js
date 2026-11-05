// Street network from a tensor field (Chen et al. 2008, simplified): grids near centres, rings around the primary centre,
// contour-following on slopes. Arterials first at wide spacing, then local streets whose spacing follows the intensity.
// Real motorways stay, as arterials the city has to live with. Real rail stays too.
import { boxBlur } from './fields.js';

export const ROAD = { MOTORWAY: 0, ARTERIAL: 1, COLLECTOR: 2, LOCAL: 3, RAIL: 4 };
export const ROAD_WIDTH = { 0: 34, 1: 30, 2: 16, 3: 8, 4: 14 };

export function traceRoads({ N, cell, bed, slope, water, distWet, urban, buildable, intensity, estate, centres, random, slopeLimit, main, rail, report }) {
    const halfExtent = N * cell / 2;
    const toIndex = (x, z) => {
        const i = Math.floor(x / cell + N / 2), j = Math.floor(z / cell + N / 2);
        return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
    };
    const lines = [];

    // Districts keep one grid angle: one angle per centre, plus a slower random field so large cities do not read as one grid.
    const centreAngle = centres.map(() => random() * Math.PI / 2);
    const sx = new Float32Array(N * N), sz = new Float32Array(N * N);
    for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        sx[k] = (bed[k + 1] - bed[k - 1]) / (2 * cell);
        sz[k] = (bed[k + N] - bed[k - N]) / (2 * cell);
    }
    const gradX = boxBlur(sx, N, 3), gradZ = boxBlur(sz, N, 3);
    const c0 = centres[0];
    const px0 = (c0.i + 0.5 - N / 2) * cell, pz0 = (c0.j + 0.5 - N / 2) * cell;

    // Major direction angle of the blended tensor at (x, z), in radians.
    function fieldAngle(x, z) {
        let a = 0, b = 0;
        const add = (angle, weight) => { a += Math.cos(2 * angle) * weight; b += Math.sin(2 * angle) * weight; };
        for (let c = 0; c < centres.length; c++) {
            const cx = (centres[c].i + 0.5 - N / 2) * cell, cz = (centres[c].j + 0.5 - N / 2) * cell;
            const d2 = (x - cx) ** 2 + (z - cz) ** 2;
            const w = Math.exp(-d2 / (2 * 3500 * 3500));
            add(centreAngle[c], w + 0.02);
        }
        // Ring road feel around the primary centre, strongest about 4 km out.
        const dx = x - px0, dz = z - pz0;
        const r = Math.hypot(dx, dz);
        if (r > 1) add(Math.atan2(dz, dx), 0.5 * Math.exp(-(((r - 4500) / 3000) ** 2)));
        const k = toIndex(x, z);
        if (k >= 0) {
            // Slopes: run along the contour.
            const gx = gradX[k], gz = gradZ[k];
            const g = Math.hypot(gx, gz);
            if (g > 0.015) add(Math.atan2(gx, -gz), Math.min(5 * g * g * 100, 4));
        }
        return 0.5 * Math.atan2(b, a);
    }

    // Separation hash: one per family (major, minor), stores points; lookups scan a small neighbourhood.
    const HASH = 60;
    const side = Math.ceil(N * cell / HASH) + 2;
    const hashes = [new Map(), new Map()];
    const hashKey = (x, z) => Math.floor((x + halfExtent) / HASH) + side * Math.floor((z + halfExtent) / HASH);
    function addPoint(family, x, z) {
        const key = hashKey(x, z);
        const list = hashes[family].get(key);
        if (list) list.push(x, z); else hashes[family].set(key, [x, z]);
    }
    function nearestSame(family, x, z, radius) {
        const span = Math.ceil(radius / HASH);
        const cx = Math.floor((x + halfExtent) / HASH), cz = Math.floor((z + halfExtent) / HASH);
        const limit = radius * radius;
        for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
            const list = hashes[family].get(cx + dx + side * (cz + dz));
            if (!list) continue;
            for (let p = 0; p < list.length; p += 2) {
                if ((list[p] - x) ** 2 + (list[p + 1] - z) ** 2 < limit) return true;
            }
        }
        return false;
    }

    let bridges = 0;
    function allowedAt(x, z, level) {
        const k = toIndex(x, z);
        if (k < 0) return false;
        // Arterials may cross the green strip along the banks, or they never reach a bridge.
        if (level === ROAD.ARTERIAL) return urban[k] || water[k] || buildable[k] || distWet[k] < 260;
        return !!urban[k] && !water[k] && slope[k] < slopeLimit + 3;
    }

    // Trace from a seed in both directions. Returns point list [x, z, ...] or null when too short.
    function trace(family, seedX, seedZ, level, spacing) {
        const step = cell;
        const sides = [];
        let crossings = 0;
        for (const sign of [1, -1]) {
            const pts = [];
            let x = seedX, z = seedZ;
            let angle = fieldAngle(x, z) + (family ? Math.PI / 2 : 0);
            if (sign < 0) angle += Math.PI;
            let wetRun = 0, length = 0;
            const maxLength = level === ROAD.ARTERIAL ? 26000 : 3500;
            while (length < maxLength) {
                let next = fieldAngle(x, z) + (family ? Math.PI / 2 : 0);
                // Tensors have no sign: keep going the way we were heading.
                if (Math.cos(next - angle) < 0) next += Math.PI;
                angle = next;
                const nx = x + Math.cos(angle) * step, nz = z + Math.sin(angle) * step;
                const k = toIndex(nx, nz);
                if (k < 0) break;
                if (water[k]) {
                    if (level !== ROAD.ARTERIAL) break;
                    wetRun += step;
                    if (wetRun > 1400) { pts.length -= Math.min(pts.length, Math.floor(wetRun / step) * 2); break; }
                } else if (wetRun > 0) {
                    if (wetRun >= 100) crossings++;
                    wetRun = 0;
                }
                if (!allowedAt(nx, nz, level)) break;
                if (nearestSame(family, nx, nz, spacing * 0.72)) break;
                x = nx; z = nz;
                pts.push(x, z);
                length += step;
            }
            // A road never stops mid-river.
            if (wetRun > 0) pts.length = Math.max(0, pts.length - Math.ceil(wetRun / step) * 2);
            sides.push(pts);
        }
        const [a, b] = sides;
        const line = [];
        for (let p = b.length - 2; p >= 0; p -= 2) line.push(b[p], b[p + 1]);
        line.push(seedX, seedZ);
        for (let p = 0; p < a.length; p += 2) line.push(a[p], a[p + 1]);
        if (line.length < 8) return null;
        line.crossings = crossings;
        return line;
    }

    function commit(family, line, level) {
        bridges += line.crossings ?? 0;
        // Thin the stored polyline to every second point, except short ones.
        const thin = [];
        for (let p = 0; p < line.length; p += line.length > 16 ? 4 : 2) thin.push(line[p], line[p + 1]);
        if (thin[thin.length - 2] !== line[line.length - 2]) thin.push(line[line.length - 2], line[line.length - 1]);
        lines.push({ level, family, points: Float32Array.from(thin) });
        for (let p = 0; p < line.length; p += 2) addPoint(family, line[p], line[p + 1]);
    }

    // Real infrastructure first, so everything else avoids running on top of it.
    // National tiles carry whole lines: keep what lies in the block, or streets and cars count countryside outside it.
    const clip = (points) => {
        const runs = [];
        let run = [];
        for (let q = 0; q < points.length; q += 2) {
            if (Math.abs(points[q]) < halfExtent && Math.abs(points[q + 1]) < halfExtent) run.push(points[q], points[q + 1]);
            else { if (run.length >= 4) runs.push(run); run = []; }
        }
        if (run.length >= 4) runs.push(run);
        return runs;
    };
    for (const m of main ?? []) {
        const motorway = m.motorway === true;
        for (const run of clip(m.points)) lines.push({ level: motorway ? ROAD.MOTORWAY : ROAD.ARTERIAL, family: 2, points: Float32Array.from(run), real: true });
    }
    for (const r of rail ?? []) for (const run of clip(r.points)) lines.push({ level: ROAD.RAIL, family: 2, points: Float32Array.from(run), real: true });

    // Priority queue of seeds: both families alternate, seeds spawned sideways from committed lines.
    function grow(level, spacingAt, maxSteps, seeds) {
        let queue = seeds.slice();
        let steps = 0;
        while (queue.length && steps < maxSteps) {
            const next = [];
            for (const seed of queue) {
                if (steps++ >= maxSteps) break;
                const spacing = spacingAt(seed.x, seed.z);
                if (!allowedAt(seed.x, seed.z, level)) continue;
                if (nearestSame(seed.family, seed.x, seed.z, spacing * 0.9)) continue;
                const line = trace(seed.family, seed.x, seed.z, level, spacing);
                if (!line) continue;
                commit(seed.family, line, level);
                const gap = Math.max(1, Math.floor(spacing / cell / 1)) * 2;
                for (let p = gap; p < line.length; p += gap) {
                    const x = line[p], z = line[p + 1];
                    const angle = fieldAngle(x, z) + (seed.family ? Math.PI / 2 : 0);
                    for (const s of [1, -1]) {
                        next.push({ x: x - Math.sin(angle) * spacing * s, z: z + Math.cos(angle) * spacing * s, family: seed.family });
                    }
                    next.push({ x, z, family: 1 - seed.family });
                }
            }
            queue = next;
        }
    }

    const seeds = [];
    for (const c of centres) {
        const x = (c.i + 0.5 - N / 2) * cell, z = (c.j + 0.5 - N / 2) * cell;
        seeds.push({ x, z, family: 0 }, { x, z, family: 1 });
    }
    grow(ROAD.ARTERIAL, () => 750, 2400, seeds);
    report?.('Tracing streets', 0.32);
    const arterialCount = lines.length;

    // Collectors and local streets: spacing by intensity, narrow downtown, wide in estates.
    const urbanSeeds = [];
    for (let t = 0; t < 2600; t++) {
        const i = Math.floor(random() * N), j = Math.floor(random() * N);
        if (urban[j * N + i]) urbanSeeds.push({ x: (i + 0.5 - N / 2) * cell, z: (j + 0.5 - N / 2) * cell, family: t & 1 });
    }
    const fromArterials = [];
    for (let l = 0; l < arterialCount; l++) {
        const pts = lines[l].points;
        for (let p = 0; p < pts.length; p += 40) fromArterials.push({ x: pts[p], z: pts[p + 1], family: lines[l].family === 0 ? 1 : 0 });
    }
    shuffle(fromArterials, random);
    grow(ROAD.COLLECTOR, () => 340, 16000, [...fromArterials, ...urbanSeeds]);
    report?.('Tracing streets', 0.42);
    shuffle(urbanSeeds, random);
    const localSpacing = (x, z) => {
        const k = toIndex(x, z);
        if (k < 0) return 200;
        // Estates keep their superblocks: only collectors cross them.
        if (estate[k]) return 420;
        const v = intensity[k];
        return 95 + 80 * (1 - v);
    };
    grow(ROAD.LOCAL, localSpacing, 90000, [...fromArterials, ...urbanSeeds]);
    report?.('Tracing streets', 0.52);

    let lengthKm = 0, arterialKm = 0;
    for (const line of lines) {
        if (line.level === ROAD.RAIL) continue;
        let length = 0;
        for (let p = 2; p < line.points.length; p += 2) length += Math.hypot(line.points[p] - line.points[p - 2], line.points[p + 1] - line.points[p - 1]);
        lengthKm += length / 1000;
        if (line.level <= ROAD.ARTERIAL) arterialKm += length / 1000;
    }
    return { lines, lengthKm, arterialKm, bridges, fieldAngle };
}

function shuffle(list, random) {
    for (let k = list.length - 1; k > 0; k--) {
        const j = Math.floor(random() * (k + 1));
        [list[k], list[j]] = [list[j], list[k]];
    }
}
