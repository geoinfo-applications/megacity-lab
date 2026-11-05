// What makes a street read as a street, built around the view for stills only: smoothed roads with clean lane
// marks, cars, people, lamps, furniture and entrances. Display only, so it cannot move a statistic or a seed.
import { rng } from './fields.js';
import { ROAD, ROAD_WIDTH } from './roads.js';
import { KIND } from './buildings.js';

const STEP = 8;
const SIDEWALK = 2.5;

function chaikin(points, rounds) {
    let p = Array.from(points);
    for (let round = 0; round < rounds; round++) {
        const next = [p[0], p[1]];
        for (let k = 0; k + 3 < p.length; k += 2) {
            next.push(p[k] * 0.75 + p[k + 2] * 0.25, p[k + 1] * 0.75 + p[k + 3] * 0.25, p[k] * 0.25 + p[k + 2] * 0.75, p[k + 1] * 0.25 + p[k + 3] * 0.75);
        }
        next.push(p[p.length - 2], p[p.length - 1]);
        p = next;
    }
    return p;
}

function samplesOf(points, cx, cz, reach) {
    const out = [];
    let carry = 0;
    for (let k = 0; k + 3 < points.length; k += 2) {
        const ax = points[k], az = points[k + 1], dx = points[k + 2] - ax, dz = points[k + 3] - az;
        const length = Math.hypot(dx, dz);
        if (length < 1e-3) continue;
        const ux = dx / length, uz = dz / length;
        let t = carry;
        for (; t < length; t += STEP) {
            const x = ax + ux * t, z = az + uz * t;
            if (Math.hypot(x - cx, z - cz) <= reach) out.push({ x, z, ux, uz, clear: true });
            else out.push(null);
        }
        carry = t - length;
    }
    return out;
}

const priority = (line) => [line.level, -line.length];
function outranks(a, b) {
    const [la, lb] = [priority(a), priority(b)];
    return la[0] !== lb[0] ? la[0] < lb[0] : (la[1] !== lb[1] ? la[1] < lb[1] : a.index < b.index);
}

// A road that runs through a better road loses its marks and traffic there: junctions stay clean, overlaps do not double up.
function roadGrid(lines) {
    const size = 48;
    const grid = new Map();
    for (const line of lines) {
        for (const s of line.samples) {
            if (!s) continue;
            const key = Math.floor(s.x / size) + 100003 * Math.floor(s.z / size);
            const cell = grid.get(key);
            if (cell) cell.push(line, s); else grid.set(key, [line, s]);
        }
    }
    return { grid, size };
}

function markOverlaps(lines, { grid, size }) {
    for (const line of lines) {
        const own = ROAD_WIDTH[line.level] / 2;
        for (const s of line.samples) {
            if (!s) continue;
            const gx = Math.floor(s.x / size), gz = Math.floor(s.z / size);
            for (let dz = -1; dz <= 1 && s.clear; dz++) for (let dx = -1; dx <= 1 && s.clear; dx++) {
                const cell = grid.get(gx + dx + 100003 * (gz + dz));
                if (!cell) continue;
                for (let k = 0; k < cell.length; k += 2) {
                    const other = cell[k];
                    if (other === line || !outranks(other, line)) continue;
                    const q = cell[k + 1];
                    const limit = own + ROAD_WIDTH[other.level] / 2 + 1;
                    if ((q.x - s.x) ** 2 + (q.z - s.z) ** 2 < limit * limit) { s.clear = false; break; }
                }
            }
        }
    }
}

// True when no road surface covers the spot, so a pole or a bench does not end up in a neighbouring carriageway.
function offRoads({ grid, size }, x, z) {
    const gx = Math.floor(x / size), gz = Math.floor(z / size);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const cell = grid.get(gx + dx + 100003 * (gz + dz));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 2) {
            const limit = ROAD_WIDTH[cell[k].level] / 2 + 0.2;
            if ((cell[k + 1].x - x) ** 2 + (cell[k + 1].z - z) ** 2 < limit * limit) return false;
        }
    }
    return true;
}

function runsOf(samples) {
    const runs = [];
    let run = null;
    for (const s of samples) {
        if (s?.clear) { if (run) run.push(s); else run = [s]; } else { if (run && run.length >= 3) runs.push(run); run = null; }
    }
    if (run && run.length >= 3) runs.push(run);
    return runs;
}

function writer(capacity) {
    const buffer = new ArrayBuffer(capacity * 28);
    const f = new Float32Array(buffer), u8 = new Uint8Array(buffer);
    let count = 0;
    const add = (x, base, z, w, d, h, yaw, kind, seed) => {
        if (count >= capacity) return;
        const o = count * 7, m = count * 28 + 24;
        f[o] = x; f[o + 1] = base; f[o + 2] = z; f[o + 3] = w; f[o + 4] = d; f[o + 5] = h;
        u8[m] = Math.round(((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * 255);
        u8[m + 1] = kind;
        u8[m + 2] = Math.floor(seed * 255);
        u8[m + 3] = 0;
        count++;
    };
    return { add, get count() { return count; }, buffer };
}

function addCar(add, surfaceAt, x, z, ux, uz, seed) {
    const yaw = Math.atan2(-uz, ux);
    const y = surfaceAt(x, z);
    add(x, y + 0.22, z, 4.4, 1.8, 0.72, yaw, KIND.CAR, seed);
    add(x - ux * 0.25, y + 0.94, z - uz * 0.25, 2.3, 1.62, 0.56, yaw, KIND.CAR_GLASS, seed);
}

function addTraffic(add, surfaceAt, run, level, random) {
    const half = ROAD_WIDTH[level] / 2;
    const lanes = level === ROAD.MOTORWAY ? [half * 0.3, half * 0.7] : (level === ROAD.ARTERIAL ? [half * 0.3, half * 0.72] : (level === ROAD.COLLECTOR ? [half * 0.5] : [half * 0.42]));
    const gap = level === ROAD.LOCAL ? 75 : (level === ROAD.COLLECTOR ? 42 : 55);
    for (const side of [-1, 1]) for (const lane of lanes) {
        for (let k = Math.floor(random() * 4); k < run.length; k += Math.max(1, Math.round((gap + random() * gap * 2.2) / STEP))) {
            const s = run[k];
            const x = s.x - s.uz * side * lane, z = s.z + s.ux * side * lane;
            addCar(add, surfaceAt, x, z, side * s.ux, side * s.uz, random());
        }
    }
    if (level === ROAD.LOCAL) {
        for (let k = 0; k < run.length; k++) {
            if (random() > 0.14) continue;
            const s = run[k], side = random() < 0.5 ? -1 : 1, off = half + 0.1;
            addCar(add, surfaceAt, s.x - s.uz * side * off, s.z + s.ux * side * off, s.ux, s.uz, random());
        }
    }
}

function addLamp(add, surfaceAt, x, z, towardRoadX, towardRoadZ, random) {
    add.lamps.push(x + towardRoadX * 2.1, z + towardRoadZ * 2.1);
    const y = surfaceAt(x, z);
    const yaw = Math.atan2(-towardRoadZ, towardRoadX);
    add(x, y, z, 0.2, 0.2, 8, 0, KIND.POLE, random());
    add(x + towardRoadX * 1.1, y + 7.9, z + towardRoadZ * 1.1, 2.3, 0.14, 0.12, yaw, KIND.POLE, random());
    add(x + towardRoadX * 2.1, y + 7.72, z + towardRoadZ * 2.1, 0.72, 0.26, 0.18, yaw, KIND.LAMP, random());
}

function addShelter(add, surfaceAt, x, z, ux, uz, nx, nz, random) {
    const y = surfaceAt(x, z);
    const yaw = Math.atan2(-uz, ux);
    add(x, y + 2.5, z, 6, 2, 0.14, yaw, KIND.FURNITURE, 0.9);
    add(x + nx * 0.9, y, z + nz * 0.9, 6, 0.08, 2.5, yaw, KIND.SHELTER_GLASS, random());
    for (const end of [-1, 1]) add(x + ux * end * 2.9 + nx * 0.9, y, z + uz * end * 2.9 + nz * 0.9, 0.12, 0.12, 2.5, 0, KIND.POLE, random());
    add(x + nx * 0.4, y + 0.42, z + nz * 0.4, 3.2, 0.5, 0.08, yaw, KIND.FURNITURE, 0.1);
}

function addSidewalk(add, surfaceAt, run, level, people, roads, random) {
    const half = ROAD_WIDTH[level] / 2;
    const lampEvery = Math.round(34 / STEP), benchEvery = Math.round(72 / STEP), shelterEvery = Math.round(320 / STEP);
    for (const side of [-1, 1]) {
        for (let k = Math.floor(random() * lampEvery); k < run.length; k++) {
            const s = run[k];
            const nx = -s.uz * side, nz = s.ux * side;
            const px = s.x + nx * (half + SIDEWALK * 0.5), pz = s.z + nz * (half + SIDEWALK * 0.5);
            if (level !== ROAD.LOCAL && k % lampEvery === 0) {
                const lx = s.x + nx * (half + 0.4), lz = s.z + nz * (half + 0.4);
                if (offRoads(roads, lx, lz)) addLamp(add, surfaceAt, lx, lz, -nx, -nz, random);
            }
            const walkable = offRoads(roads, px, pz);
            if (walkable && k % benchEvery === 3) {
                const y = surfaceAt(px, pz);
                const yaw = Math.atan2(-s.uz, s.ux);
                if (random() < 0.5) {
                    add(px, y, pz, 1.8, 0.48, 0.44, yaw, KIND.FURNITURE, 0.5);
                    add(px + nx * 0.28, y + 0.44, pz + nz * 0.28, 1.8, 0.06, 0.42, yaw, KIND.FURNITURE, 0.1);
                } else add(px, y, pz, 0.46, 0.46, 0.95, 0, KIND.FURNITURE, 0.5);
            }
            if (walkable && level === ROAD.ARTERIAL && k % shelterEvery === 7) addShelter(add, surfaceAt, px, pz, s.ux, s.uz, nx, nz, random);
            if (people) {
                const wanted = (level === ROAD.ARTERIAL ? 0.9 : (level === ROAD.COLLECTOR ? 0.6 : 0.16));
                for (let n = Math.floor(wanted + random()); n > 0; n--) {
                    const across = half + 0.5 + random() * (SIDEWALK - 1), ahead = (random() - 0.5) * STEP;
                    const x = s.x + nx * across + s.ux * ahead, z = s.z + nz * across + s.uz * ahead;
                    if (!offRoads(roads, x, z)) continue;
                    add(x, surfaceAt(x, z), z, 0.62, 0.62, 1.55 + random() * 0.32, random() * 6.28, KIND.PERSON, random());
                }
            }
        }
    }
}

function addJunctionEnds(line, run, atStart, add, surfaceAt, crossings, random) {
    const s = atStart ? run[0] : run[run.length - 1];
    const ux = atStart ? s.ux : -s.ux, uz = atStart ? s.uz : -s.uz;
    const half = ROAD_WIDTH[line.level] / 2;
    crossings.push({ level: line.level, x: s.x + ux * 3, z: s.z + uz * 3, ux, uz, half });
    if (line.level > ROAD.COLLECTOR) return;
    const x = s.x + -uz * (half + 0.5), z = s.z + ux * (half + 0.5), y = surfaceAt(x, z);
    const yaw = Math.atan2(-ux, -uz);
    add(x, y, z, 0.16, 0.16, 3.8, 0, KIND.POLE, random());
    add(x - ux * 0.05, y + 3.0, z - uz * 0.05, 0.34, 0.26, 0.86, yaw, KIND.SIGNAL, random());
}

function addEntrances(add, surfaceAt, buildings, cx, cz, reach, random) {
    const f = new Float32Array(buildings.buffer), u8 = new Uint8Array(buildings.buffer);
    for (let k = 0; k < buildings.count; k++) {
        const x = f[k * 7], z = f[k * 7 + 2];
        if (Math.abs(x - cx) > reach || Math.abs(z - cz) > reach) continue;
        const kind = u8[k * 28 + 25];
        const eligible = kind === KIND.APARTMENT || kind === KIND.MIXED || kind === KIND.VILLA || kind === KIND.PODIUM || kind === KIND.SPIRE;
        if (!eligible) continue;
        const w = f[k * 7 + 3], d = f[k * 7 + 4], base = f[k * 7 + 1];
        const yaw = u8[k * 28 + 24] / 255 * Math.PI * 2;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const doors = kind === KIND.APARTMENT ? Math.max(1, Math.round(w / 24)) : 1;
        const large = kind === KIND.PODIUM || kind === KIND.SPIRE;
        for (let i = 0; i < doors; i++) {
            const u = ((i + 0.5) / doors - 0.5) * w * 0.9, v = -d / 2 - 0.12;
            const px = x + u * c + v * s, pz = z - u * s + v * c;
            const y = Math.max(surfaceAt(px, pz), base);
            add(px, y, pz, large ? 5 : 1.9, 0.3, large ? 3.6 : 2.5, yaw, KIND.DOOR, random());
            const hood = -d / 2 - (large ? 1.3 : 0.75);
            const hx = x + u * c + hood * s, hz = z - u * s + hood * c;
            add(hx, y + (large ? 3.7 : 2.6), hz, large ? 8 : 2.8, large ? 2.6 : 1.5, 0.18, yaw, KIND.FURNITURE, 0.9);
        }
    }
}

export function buildStreetDetail({ roads, buildings, surfaceAt, centre, radius, seed }) {
    const [cx, cz] = centre;
    const random = rng(Math.floor(seed * 7907 + cx * 3 + cz * 5 + radius));
    const reach = radius * 1.05;
    const lines = [];
    roads.forEach((road, index) => {
        if (road.level === ROAD.RAIL) { lines.push({ level: road.level, points: road.points, index, samples: [], length: 0, rail: true }); return; }
        let near = false;
        for (let k = 0; k < road.points.length && !near; k += 2) near = Math.hypot(road.points[k] - cx, road.points[k + 1] - cz) < reach + 200;
        if (!near) return;
        const points = chaikin(road.points, 2);
        const samples = samplesOf(points, cx, cz, reach);
        lines.push({ level: road.level, points, index, samples, length: samples.length });
    });
    const surfaces = lines.filter((line) => !line.rail);
    const grid = roadGrid(surfaces);
    markOverlaps(surfaces, grid);
    const out = writer(400000);
    out.add.lamps = [];
    const crossings = [];
    const people = radius <= 1100, furniture = radius <= 1700;
    for (const line of lines) {
        if (line.rail) continue;
        line.runs = runsOf(line.samples);
        for (const run of line.runs) {
            addTraffic(out.add, surfaceAt, run, line.level, random);
            if (furniture && line.level !== ROAD.MOTORWAY) addSidewalk(out.add, surfaceAt, run, line.level, people, grid, random);
            const firstIndex = line.samples.indexOf(run[0]), lastIndex = line.samples.indexOf(run[run.length - 1]);
            if (line.level !== ROAD.MOTORWAY) {
                if (line.samples[firstIndex - 1]) addJunctionEnds(line, run, true, out.add, surfaceAt, crossings, random);
                if (line.samples[lastIndex + 1]) addJunctionEnds(line, run, false, out.add, surfaceAt, crossings, random);
            }
        }
    }
    if (furniture) addEntrances(out.add, surfaceAt, buildings, cx, cz, reach, random);
    return { lines, crossings, lamps: out.add.lamps, instances: out.buffer.slice(0, out.count * 28), count: out.count };
}
