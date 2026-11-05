// Fill the street blocks with Seoul's building types, then calibrate floors so the homes add up to the asked population.
// Placement works on a 6.25 m occupancy raster: a rectangle goes in when all of it is free and inside one block.
import { labelComponents, rng } from './fields.js';
import { ROAD, ROAD_WIDTH } from './roads.js';

export const KIND = { VILLA: 0, APARTMENT: 1, MIXED: 2, TOWER: 3, SHED: 4, PODIUM: 5, SPIRE: 6, CHURCH: 7, TREE: 8, PLANT: 9, CORE: 10, ROUND_TREE: 11, CAR: 12, CAR_GLASS: 13, PERSON: 14, POLE: 15, LAMP: 16, FURNITURE: 17, DOOR: 18, SHELTER_GLASS: 19, SIGNAL: 20, STONE: 21, TILE_ROOF: 22, CONCRETE: 23 };
const isTree = (kind) => kind === KIND.TREE || kind === KIND.ROUND_TREE;
const FREE = 0, BLOCKED = 1, TAKEN = 2;
const FLOOR_M = 2.9;
// Share of gross floor that is living space: Seoul villas park at ground level, slabs lose stairs, lifts and shops. Assumption.
const NET_TO_GROSS = 0.62;

export function placeBuildings({ N, cell, bed, slope, water, urban, intensity, estate, roads, centres, metro, params, report }) {
    const open = params.openness ?? 1;
    let random = rng(params.seed * 7919 + 13);
    const scale = 4;
    const M = N * scale;
    const fine = cell / scale;
    const halfExtent = N * cell / 2;
    const occ = new Uint8Array(M * M);
    // Everything off the urban mask is blocked.
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        if (urban[j * N + i] && !water[j * N + i]) continue;
        for (let b = 0; b < scale; b++) occ.fill(BLOCKED, (j * scale + b) * M + i * scale, (j * scale + b) * M + i * scale + scale);
    }
    for (const line of roads.lines) stampLine(occ, M, fine, halfExtent, line.points, ROAD_WIDTH[line.level]);
    report?.('Raising buildings', 0.58);

    const free = new Uint8Array(M * M);
    for (let k = 0; k < M * M; k++) free[k] = occ[k] === FREE ? 1 : 0;
    const { labels, sizes, count } = labelComponents(free, M);
    const blocks = new Array(count + 1);
    for (let id = 1; id <= count; id++) blocks[id] = { id, cells: sizes[id], x0: M, x1: 0, y0: M, y1: 0, sx: 0, sy: 0 };
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
        const id = labels[y * M + x];
        if (!id) continue;
        const b = blocks[id];
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
        b.sx += x;
        b.sy += y;
    }

    const stationCells = new Uint8Array(N * N);
    for (const s of metro.stations) {
        const r = Math.ceil(350 / cell);
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            const i = s.i + di, j = s.j + dj;
            if (i >= 0 && j >= 0 && i < N && j < N && Math.hypot(di, dj) * cell < 350) stationCells[j * N + i] = 1;
        }
    }

    let out = [];
    const parks = [];
    const blockType = new Uint8Array(count + 1);
    const add = (x, z, w, d, h, yaw, kind, residential, lift = 0) => { out.push({ x, z, w, d, h, yaw, kind, residential, lift, seed: random() }); };
    const addTrees = (id, b, spacing) => {
        const bw = (b.x1 - b.x0) * fine, bh = (b.y1 - b.y0) * fine;
        const wanted = Math.min(600, Math.floor(b.cells * fine * fine / spacing));
        for (let t = 0; t < wanted * 2; t++) {
            const tx = (b.x0 + 0.5) * fine - halfExtent + random() * bw, tz = (b.y0 + 0.5) * fine - halfExtent + random() * bh;
            if (!inside(tx, tz, 7, 7, 0, id)) continue;
            const size = 7 + random() * 6;
            add(tx, tz, size, size, size * (1.2 + random() * 0.6), 0, (size * 7.3) % 1 < 0.7 ? KIND.ROUND_TREE : KIND.TREE, false);
            if (t >= wanted) break;
        }
    };
    const inside = (x, z, w, d, yaw, id) => testRect(occ, labels, M, fine, halfExtent, x, z, w, d, yaw, id);
    const take = (x, z, w, d, yaw, gap) => stampRect(occ, M, fine, halfExtent, x, z, w + gap, d + gap, yaw);

    const TYPE_CODE = { park: 1, villa: 2, mixed: 3, danji: 4, core: 5, shed: 6, unbuilt: 7 };
    // The landmark takes its plot first: the free spot nearest the primary centre that fits inside one block.
    const c0 = centres[0];
    const lx0 = (c0.i + 0.5 - N / 2) * cell, lz0 = (c0.j + 0.5 - N / 2) * cell;
    let landmark = null;
    if (params.maxFloors >= 50) {
        for (let radius = 0; radius < 900 && !landmark; radius += 25) {
            for (let a = 0; a < 16 && !landmark; a++) {
                const tx = lx0 + Math.cos(a / 16 * Math.PI * 2) * radius, tz = lz0 + Math.sin(a / 16 * Math.PI * 2) * radius;
                const k = Math.floor((tz + halfExtent) / fine) * M + Math.floor((tx + halfExtent) / fine);
                if (k < 0 || k >= M * M || !labels[k]) continue;
                if (testRect(occ, labels, M, fine, halfExtent, tx, tz, 76, 76, 0.3, labels[k])) landmark = { x: tx, z: tz };
            }
        }
        if (landmark) stampRect(occ, M, fine, halfExtent, landmark.x, landmark.z, 80, 80, 0.3);
    }
    const order = blocks.slice(1).filter((b) => b.cells * fine * fine >= 120);
    for (const b of order) {
        // Each block draws from its own stream, so a calibration pass changes spacing and not the kind of block.
        random = rng(params.seed * 7919 + b.id * 31);
        const cx = b.sx / b.cells, cy = b.sy / b.cells;
        const x = (cx + 0.5) * fine - halfExtent, z = (cy + 0.5) * fine - halfExtent;
        const area = b.cells * fine * fine;
        const k = Math.min(N - 1, Math.floor(cy / scale)) * N + Math.min(N - 1, Math.floor(cx / scale));
        const v = intensity[k], steep = slope[k];
        const angle = roads.fieldAngle(x, z);
        const near = stationCells[k];
        const r = random();
        const dCentre = Math.min(...centres.map((c) => Math.hypot((c.i + 0.5 - N / 2) * cell - x, (c.j + 0.5 - N / 2) * cell - z) / (c.primary ? 1 : 0.6)));
        let type;
        if (dCentre < 1500 && area > 900) type = 'core';
        else if (area > 2.2e4 && steep < 9 && r < 0.14) type = 'park';
        else if (steep > 11 || area < 1500) type = r < 0.2 && steep < 11 ? 'mixed' : 'villa';
        else if (estate[k] && area > 5000 && steep < 12) type = 'danji';
        else if (near || v > 0.72) type = 'mixed';
        else if (r > 0.93 && v < 0.35 && steep < 6 && area > 8000) type = 'shed';
        else type = r < 0.55 ? 'villa' : 'mixed';
        blockType[b.id] = TYPE_CODE[type];
        const placedBefore = out.length;
        if (type === 'park') { parks.push({ x, z, area, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, id: b.id }); addTrees(b.id, b, 260); continue; }
        const bx0 = (b.x0 + 0.5) * fine - halfExtent, bx1 = (b.x1 + 0.5) * fine - halfExtent;
        const bz0 = (b.y0 + 0.5) * fine - halfExtent, bz1 = (b.y1 + 0.5) * fine - halfExtent;
        const span = Math.hypot(bx1 - bx0, bz1 - bz0) / 2 + 20;
        const mx = (bx0 + bx1) / 2, mz = (bz0 + bz1) / 2;
        // Rows in a frame turned by yaw: u along the row, v across. World x = mx + u cos + v sin, z = mz - u sin + v cos.
        const scan = (yaw, uStep, vStep, cb) => {
            const c = Math.cos(yaw), s = Math.sin(yaw);
            for (let v2 = -span; v2 <= span; v2 += vStep()) for (let u = -span; u <= span; u += uStep()) cb(mx + u * c + v2 * s, mz - u * s + v2 * c);
        };
        if (type === 'danji') {
            // South-facing slabs: long side east-west, within a few degrees of due south, one height for the estate.
            const yaw = (random() - 0.5) * 0.5;
            const floors = 18 + Math.floor(random() * 15);
            const depth = 13 + random() * 3, length = 45 + random() * 45;
            const hMetres = floors * FLOOR_M;
            const rowGap = Math.max(26, hMetres * 0.72);
            scan(yaw, () => (length + 18) * (params.estateOpenness ?? 1), () => (depth + rowGap) * (params.estateOpenness ?? 1), (px, pz) => {
                if (!inside(px, pz, length, depth, yaw, b.id)) return;
                take(px, pz, length, depth, yaw, 6);
                add(px, pz, length, depth, hMetres, yaw, KIND.APARTMENT, true);
            });
            addTrees(b.id, b, 420);
        } else if (type === 'villa') {
            // Tight low-rise on the street angle: dense, four or five floors, narrow alleys.
            const yaw = -angle;
            const size = 9 + random() * 5;
            scan(yaw, () => (size + 1.5 + random() * 1.5) * open, () => (size + 3 + random() * 2) * open, (px, pz) => {
                const w = size * (0.8 + 0.4 * random()), d = size * (0.8 + 0.4 * random());
                if (!inside(px, pz, w, d, yaw, b.id)) return;
                take(px, pz, w, d, yaw, 1.5);
                const church = random() < 0.0035;
                add(px, pz, w, d, (random() < 0.7 ? 4 : 5) * FLOOR_M, yaw, church ? KIND.CHURCH : KIND.VILLA, !church);
            });
        } else if (type === 'mixed') {
            const yaw = -angle;
            const size = 16 + random() * 14;
            const floors = 4 + Math.floor(random() * 7) + Math.floor(v * 7);
            scan(yaw, () => (size + 4 + random() * 4) * Math.sqrt(open), () => (size + 8 + random() * 5) * Math.sqrt(open), (px, pz) => {
                const w = size * (0.85 + 0.3 * random()), d = size * (0.7 + 0.3 * random());
                if (!inside(px, pz, w, d, yaw, b.id)) return;
                take(px, pz, w, d, yaw, 3);
                add(px, pz, w, d, (floors + Math.floor(random() * 5)) * FLOOR_M, yaw, KIND.MIXED, random() < 0.55);
            });
        } else if (type === 'shed') {
            const yaw = -angle;
            scan(yaw, () => 70 + random() * 30, () => 60 + random() * 20, (px, pz) => {
                const w = 40 + random() * 40, d = 30 + random() * 25;
                if (!inside(px, pz, w, d, yaw, b.id)) return;
                take(px, pz, w, d, yaw, 8);
                add(px, pz, w, d, 9 + random() * 8, yaw, KIND.SHED, false);
            });
        } else if (type === 'core') {
            // Core: towers on podiums. Height falls with distance from the centre, with outliers.
            const yaw = -angle;
            scan(yaw, () => 34 + random() * 26, () => 34 + random() * 26, (px, pz) => {
                const w = 16 + random() * 24, d = 16 + random() * 24;
                if (!inside(px, pz, w + 8, d + 8, yaw, b.id)) return;
                take(px, pz, w + 8, d + 8, yaw, 4);
                const falloff = Math.max(0.15, 1 - dCentre / 1700);
                const heavy = random() ** 3;
                const floors = Math.min(params.maxFloors, 8 + (params.maxFloors - 8) * falloff * heavy * 1.2 + random() * 12);
                const metres = floors * 3.9;
                const podium = (3 + random() * 4) * FLOOR_M;
                add(px, pz, w + 8, d + 8, podium, yaw, KIND.PODIUM, false);
                const towerYaw = yaw + (random() < 0.2 ? 0.4 : 0);
                if (floors > 26 && random() < 0.45) {
                    // Setback: a slimmer shaft from two thirds up.
                    add(px, pz, w, d, metres * 0.66, towerYaw, KIND.TOWER, false);
                    out[out.length - 1].roofCovered = true;
                    add(px, pz, w * 0.68, d * 0.68, metres * 0.34, towerYaw, KIND.TOWER, false, metres * 0.66);
                } else add(px, pz, w, d, metres, towerYaw, KIND.TOWER, false);
            });
        }
        // An empty block stays open land, or the hills fill with paved pads that hold nothing.
        if (out.length === placedBefore) blockType[b.id] = TYPE_CODE.unbuilt;
    }
    report?.('Raising buildings', 0.72);

    // Calibrate: scale floors so homes house the population. Jobs fill whatever non-residential floor exists, reported, not forced.
    const footArea = (b) => b.w * b.d;
    let homeFloorArea = 0;
    const scalable = (b) => b.residential && b.kind !== KIND.VILLA;
    let fixedHome = 0, scaleHome = 0;
    for (const b of out) {
        if (!b.residential) continue;
        const area = footArea(b) * b.h / FLOOR_M * NET_TO_GROSS;
        if (scalable(b)) scaleHome += area; else fixedHome += area;
    }
    const wantHome = params.population * params.floorPerPerson;
    // Too many homes even at the lowest floors: a small city thins out rather than overbuilding its footprint.
    const leastHomes = fixedHome + scaleHome * 0.45;
    if (leastHomes > wantHome) {
        const keep = wantHome / leastHomes;
        const thin = rng(params.seed * 7919 + 7);
        out = out.filter((b) => !b.residential || thin() < keep);
        fixedHome *= keep;
        scaleHome *= keep;
    }
    const factor = scaleHome > 0 ? Math.max(0, (wantHome - fixedHome) / scaleHome) : 1;
    // Bounded: floors may not collapse to nothing or shoot to the cap everywhere; the shortfall or surplus shows in the stats.
    const bounded = Math.min(2.2, Math.max(0.45, factor));
    const capM = params.maxFloors * FLOOR_M;
    for (const b of out) {
        if (scalable(b)) b.h = Math.min(capM, Math.max(4 * FLOOR_M, b.h * bounded));
        // The limit binds every kind. Towers are capped where they are placed, at 3.9 m per floor.
        else if (b.kind !== KIND.TOWER && !isTree(b.kind)) b.h = Math.min(capM, b.h);
        
        // Measured before the foundation is added below: a plinth holds no flats.
        b.gross = footArea(b) * b.h / FLOOR_M;
        if (b.residential) homeFloorArea += b.gross * NET_TO_GROSS;
    }
    const housed = homeFloorArea / params.floorPerPerson;
    // Landmark: one supertall at the primary centre, when the height cap allows it.
    const lx = lx0, lz = lz0;
    if (landmark) add(landmark.x, landmark.z, 68, 68, Math.min(555, params.maxFloors * 5.0), 0.3, KIND.SPIRE, false);

    // Base heights: lowest terrain under the corners, so no floor hangs in the air on a slope.
    const bilinear = (x, z) => {
        const fx = x / cell + N / 2 - 0.5, fz = z / cell + N / 2 - 0.5;
        const i = Math.max(0, Math.min(N - 2, Math.floor(fx))), j = Math.max(0, Math.min(N - 2, Math.floor(fz)));
        const tx = fx - i, tz = fz - j, k = j * N + i;
        return (bed[k] * (1 - tx) + bed[k + 1] * tx) * (1 - tz) + (bed[k + N] * (1 - tx) + bed[k + N + 1] * tx) * tz;
    };
    let tallest = 0, floorArea = 0, jobFloor = 0, onSlope = 0, footprint = 0;
    const kinds = new Array(12).fill(0);
    const homesGrid = new Float32Array(N * N), jobsGrid = new Float32Array(N * N);
    for (const b of out) {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw), hw = b.w / 2, hd = b.d / 2;
        let low = Infinity;
        for (const [u, w] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]) low = Math.min(low, bilinear(b.x + u * c + w * s, b.z - u * s + w * c));
        b.base = low - 2 + (b.lift ? bilinear(b.x, b.z) - low + 2 + b.lift : 0);
        if (!b.lift) b.h += bilinear(b.x, b.z) - low + 2;
        if (isTree(b.kind)) continue;
        tallest = Math.max(tallest, b.h + (b.lift ?? 0));
        kinds[b.kind]++;
        const area = b.gross ?? footArea(b) * b.h / FLOOR_M;
        floorArea += area;
        footprint += footArea(b);
        const i = Math.max(0, Math.min(N - 1, Math.floor(b.x / cell + N / 2))), j = Math.max(0, Math.min(N - 1, Math.floor(b.z / cell + N / 2)));
        const k = j * N + i;
        if (b.residential) {
            const people = area * NET_TO_GROSS / params.floorPerPerson;
            homesGrid[k] += people;
            if (slope[k] > 15) onSlope += people;
        } else {
            jobFloor += area;
            jobsGrid[k] += area / params.floorPerJob;
        }
    }

    out = out.concat(buildingDetails(out, params.seed, (x, z) => { const k = Math.floor((z + halfExtent) / cell) * N + Math.floor((x + halfExtent) / cell); return !urban[k] || water[k]; }), streetTrees(roads, occ, M, fine, halfExtent, bilinear, params.seed));

    // Sort per chunk, tallest first: a far chunk draws a prefix.
    const G = 40;
    const size = N * cell / G;
    const chunkOf = (b) => Math.max(0, Math.min(G - 1, Math.floor((b.x + halfExtent) / size))) + G * Math.max(0, Math.min(G - 1, Math.floor((b.z + halfExtent) / size)));
    for (const b of out) b.chunk = chunkOf(b);
    out.sort((a, b) => a.chunk - b.chunk || b.h - a.h);
    let lowest = Infinity;
    for (let k = 0; k < N * N; k++) if (bed[k] < lowest) lowest = bed[k];
    const buffer = new ArrayBuffer(out.length * 28);
    const f = new Float32Array(buffer), u8 = new Uint8Array(buffer);
    const chunks = [];
    const ci = c0.i + 0.5 - N / 2, cj = c0.j + 0.5 - N / 2;
    const radius = Math.max(1, Math.hypot(...[N / 2 + Math.abs(ci), N / 2 + Math.abs(cj)]) * cell);
    for (let k = 0; k < out.length;) {
        const id = out[k].chunk;
        let end = k, c12 = 0, c30 = 0, c80 = 0, sumBase = 0, maxH = 0;
        while (end < out.length && out[end].chunk === id) {
            const h = out[end].h;
            if (h >= 18) c12++;
            if (h >= 38) c30++;
            if (h >= 75) c80++;
            sumBase += out[end].base;
            maxH = Math.max(maxH, h);
            end++;
        }
        const mean = sumBase / (end - k);
        chunks.push({
            offset: k, counts: [end - k, c12, c30, c80],
            x: ((id % G) + 0.5) * size - halfExtent, z: (Math.floor(id / G) + 0.5) * size - halfExtent,
            y: mean - lowest + maxH / 2, maxH,
            radius: Math.hypot(size / 2, size / 2, maxH / 2) + 90,
        });
        k = end;
    }
    for (let k = 0; k < out.length; k++) {
        const b = out[k];
        const o = k * 7;
        f[o] = b.x; f[o + 1] = b.base - lowest; f[o + 2] = b.z;
        f[o + 3] = b.w; f[o + 4] = b.d; f[o + 5] = b.h;
        const m = k * 28 + 24;
        const yaw = ((b.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        u8[m] = Math.round(yaw / (Math.PI * 2) * 255);
        u8[m + 1] = b.kind;
        u8[m + 2] = Math.floor(b.seed * 255);
        u8[m + 3] = Math.min(240, Math.floor(Math.hypot(b.x - lx, b.z - lz) / radius * 230 + b.seed * 10));
    }

    // A podium and a setback belong to their tower: count plots, not boxes.
    let trees = 0, parts = 0, details = 0;
    for (const b of out) {
        if (b.detail) { details++; continue; }
        if (isTree(b.kind)) trees++;
        if (b.lift) parts++;
    }
    const coverage = footprint / Math.max(1, urbanArea(urban, N, cell));
    const stats = {
        buildings: out.length - details - trees - kinds[KIND.PODIUM] - parts, trees, housed, floorAreaKm2: floorArea / 1e6, tallestM: tallest, floorScale: factor,
        apartments: kinds[KIND.APARTMENT], villas: kinds[KIND.VILLA], mixed: kinds[KIND.MIXED], towers: kinds[KIND.TOWER], sheds: kinds[KIND.SHED], churches: kinds[KIND.CHURCH],
        jobs: jobFloor / params.floorPerJob, jobsWanted: params.population * params.jobsPerPerson, onSlope, coverage, blocks: order.length, parks: parks.length,
    };
    // Block type per fine cell for the ground paint: 0 street or off-city.
    const typeRaster = new Uint8Array(M * M);
    for (let k = 0; k < M * M; k++) typeRaster[k] = blockType[labels[k]];
    return { buildings: buffer, count: out.length, chunks, parks, typeRaster, M, growthRadius: radius, stats, homes: homesGrid, jobs: jobsGrid, list: out };
}

// Stair cores, roof plant and masts. Not plots: they stay out of every statistic and draw from their own stream.
function buildingDetails(buildings, seed, isBlocked) {
    const random = rng(seed * 104729 + 3);
    const details = [];
    const part = (b, u, v, w, d, h, base, kind, partSeed) => {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        details.push({ x: b.x + u * c + v * s, z: b.z - u * s + v * c, w, d, h, yaw: b.yaw, base, kind, seed: partSeed, detail: true });
    };
    const roofBox = (b, w, d, h) => part(b, (random() - 0.5) * Math.max(b.w - w - 2, 0), (random() - 0.5) * Math.max(b.d - d - 2, 0), w, d, h, b.base + b.h, KIND.PLANT, random());
    for (const b of buildings) {
        if (b.roofCovered || isTree(b.kind) || b.kind === KIND.CHURCH) continue;
        if (b.kind === KIND.APARTMENT) {
            const cores = Math.max(1, Math.round(b.w / 24));
            for (let i = 0; i < cores; i++) {
                const u = ((i + 0.5) / cores - 0.5) * b.w;
                const c = Math.cos(b.yaw), s = Math.sin(b.yaw), v = b.d / 2 + 1.5;
                if (!isBlocked(b.x + u * c + (v + 2) * s, b.z - u * s + (v + 2) * c)) part(b, u, v, 6, 3.4, b.h, b.base, KIND.CORE, b.seed);
                part(b, u, b.d / 2 - 2, 6, 6, 3.4, b.base + b.h, KIND.PLANT, random());
            }
        } else if (b.kind === KIND.TOWER) {
            const units = 1 + Math.floor(random() * 3);
            for (let i = 0; i < units; i++) roofBox(b, b.w * (0.2 + random() * 0.3), b.d * (0.2 + random() * 0.3), 3 + random() * 5);
            if (b.h > 140 && random() < 0.45) part(b, 0, 0, 1.4, 1.4, 8 + random() * 16, b.base + b.h, KIND.PLANT, random());
        } else if (b.kind === KIND.MIXED || b.kind === KIND.SHED) {
            const units = 1 + Math.floor(random() * 2);
            for (let i = 0; i < units; i++) roofBox(b, 2.5 + random() * 4, 2.5 + random() * 4, 1.8 + random() * 1.6);
        } else if (b.kind === KIND.VILLA && random() < 0.35) {
            roofBox(b, 2.6, 2.6, 2.4);
        }
    }
    return details;
}

function streetTrees(roads, occ, M, fine, halfExtent, groundAt, seed) {
    const random = rng(seed * 15485863 + 5);
    const trees = [];
    for (const line of roads.lines) {
        if (line.level !== ROAD.ARTERIAL && line.level !== ROAD.COLLECTOR) continue;
        const offset = ROAD_WIDTH[line.level] / 2 + 2.5;
        let carry = 0;
        for (let p = 2; p < line.points.length; p += 2) {
            const ax = line.points[p - 2], az = line.points[p - 1], dx = line.points[p] - ax, dz = line.points[p + 1] - az;
            const length = Math.hypot(dx, dz);
            for (let t = carry; t < length; t += 17) {
                for (const side of [-1, 1]) {
                    const x = ax + dx / length * t + side * dz / length * offset, z = az + dz / length * t - side * dx / length * offset;
                    const k = Math.floor((z + halfExtent) / fine) * M + Math.floor((x + halfExtent) / fine);
                    if (k < 0 || k >= M * M || occ[k] !== FREE) continue;
                    const size = 5.5 + random() * 3.5;
                    trees.push({ x, z, w: size, d: size, h: size * (1.3 + random() * 0.5), yaw: 0, base: groundAt(x, z) - 0.5, kind: KIND.ROUND_TREE, seed: random(), detail: true });
                }
            }
            carry = Math.max(0, carry - length + Math.ceil(Math.max(length - carry, 0) / 17) * 17);
        }
    }
    return trees;
}

function urbanArea(urban, N, cell) {
    let n = 0;
    for (let k = 0; k < N * N; k++) n += urban[k];
    return n * cell * cell;
}

function stampLine(occ, M, fine, halfExtent, points, width) {
    const r = width / 2 / fine;
    const R = Math.ceil(r);
    for (let p = 2; p < points.length; p += 2) {
        const ax = (points[p - 2] + halfExtent) / fine, ay = (points[p - 1] + halfExtent) / fine;
        const bx = (points[p] + halfExtent) / fine, by = (points[p + 1] + halfExtent) / fine;
        const len = Math.hypot(bx - ax, by - ay);
        const steps = Math.max(1, Math.ceil(len));
        for (let s = 0; s <= steps; s++) {
            const x = Math.round(ax + (bx - ax) * s / steps), y = Math.round(ay + (by - ay) * s / steps);
            for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                if (dx * dx + dy * dy > r * r + 0.25) continue;
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < M && yy < M) occ[yy * M + xx] = BLOCKED;
            }
        }
    }
}

// Rectangle centred on (x, z), width along the yaw axis. True when every sampled cell is free and in the block.
function testRect(occ, labels, M, fine, halfExtent, x, z, w, d, yaw, id) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nu = Math.max(2, Math.ceil(w / fine)), nv = Math.max(2, Math.ceil(d / fine));
    for (let a = 0; a <= nu; a++) {
        const u = (a / nu - 0.5) * w;
        for (let b = 0; b <= nv; b++) {
            const v = (b / nv - 0.5) * d;
            const px = Math.floor((x + u * c + v * s + halfExtent) / fine), py = Math.floor((z - u * s + v * c + halfExtent) / fine);
            if (px < 0 || py < 0 || px >= M || py >= M) return false;
            const k = py * M + px;
            if (occ[k] !== FREE || labels[k] !== id) return false;
        }
    }
    return true;
}

function stampRect(occ, M, fine, halfExtent, x, z, w, d, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const nu = Math.max(2, Math.ceil(w / fine) * 2), nv = Math.max(2, Math.ceil(d / fine) * 2);
    for (let a = 0; a <= nu; a++) {
        const u = (a / nu - 0.5) * w;
        for (let b = 0; b <= nv; b++) {
            const v = (b / nv - 0.5) * d;
            const px = Math.floor((x + u * c + v * s + halfExtent) / fine), py = Math.floor((z - u * s + v * c + halfExtent) / fine);
            if (px >= 0 && py >= 0 && px < M && py < M) occ[py * M + px] = TAKEN;
        }
    }
}

export { FLOOR_M, ROAD };
