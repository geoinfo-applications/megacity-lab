// Procedural city on a real 25 m terrain window. Pure: typed arrays in, typed arrays out, no DOM, same seed same city.
// Grid: row 0 = north, cell (i, j) centre at x = (i + 0.5 - N/2) * cell, z = (j + 0.5 - N/2) * cell (X east, Z south).
import { rng, fbm, boxBlur, chamfer, labelComponents } from './fields.js';
import { traceRoads } from './roads.js';
import { placeBuildings, KIND } from './buildings.js';
import { routeMetro } from './metro.js';
import { assignCommute } from './commute.js';

export const COVER = { OPEN: 0, WATER: 1, FOREST: 2, ROCK: 3, RIVER: 4 };

export const DEFAULTS = {
    population: 9_640_000,      // Seoul, Q1 2024 (Seoul statistics portal)
    density: 15_900,            // people per km² of city footprint: 9.64 M / 605 km²
    floorPerPerson: 33,         // m² of home per person, assumption
    jobsPerPerson: 0.5,         // assumption
    floorPerJob: 28,            // m², assumption
    maxFloors: 60,
    centres: 5,
    danji: 0.6,                 // share of housing in apartment estates, assumption
    slopeLimit: 18,             // degrees: steeper stays green, as Seoul's mountains do
    riverWiden: 220,            // metres added on each side of real rivers and lakes: 0 keeps today's banks
    spareForest: true,
    seed: 1,
};

export function generate(input, params, report = () => {}) {
    const p = { ...DEFAULTS, ...params };
    const { N, cell, bed: sourceBed, cover, places, rail, main } = input;
    const random = rng(p.seed);
    const stats = {};
    const extent = N * cell;
    const worldOf = (i, j) => [(i + 0.5 - N / 2) * cell, (j + 0.5 - N / 2) * cell];
    report('Reading the terrain', 0.03);

    // Water: polygons from swissTLM3D, optionally widened into a Han-sized corridor. The bed is carved with it.
    const bed = sourceBed.slice();
    const water = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) water[k] = cover[k] === COVER.WATER ? 1 : 0;
    const rivers = riverCorridors(cover, bed, N, cell);
    stats.riverReachKm = rivers.lengthKm;
    if (p.riverWiden > 0) {
        // One Han: the trunk gets the full width, tapering out as it climbs. Side rivers get a fifth of it.
        // Two separate passes: in one pass a side cell on the trunk's bank would be the nearest seed there and cut the widening on that side.
        for (const [mask, share] of [[rivers.trunk, 1], [rivers.other, 0.2]]) {
            const reachOfSeed = new Float32Array(N * N);
            for (let k = 0; k < N * N; k++) if (mask[k]) reachOfSeed[k] = p.riverWiden * share * Math.max(0, 1 - (bed[k] - rivers.lowest) / 140);
            const dist = chamfer(mask, N, cell);
            const seedHeight = nearestSeedValue(mask, bed, N);
            const seedReach = nearestSeedValue(mask, reachOfSeed, N);
            for (let k = 0; k < N * N; k++) {
                const reach = seedReach[k];
                if (reach === Infinity || reach < 1) continue;
                const d = dist[k], bank = reach + 180 * Math.min(1, reach / 60);
                if (d >= bank) continue;
                if (d < reach) { bed[k] = Math.min(bed[k], seedHeight[k]); water[k] = 1; }
                else {
                    const t = (d - reach) / (bank - reach);
                    const smooth = t * t * (3 - 2 * t);
                    bed[k] = Math.min(bed[k], seedHeight[k] + (bed[k] - seedHeight[k]) * smooth + 3 * (1 - smooth));
                }
            }
        }
    }
    const distWet = chamfer(water, N, cell);

    // Slope after carving.
    const slope = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const l = bed[j * N + Math.max(i - 1, 0)], r = bed[j * N + Math.min(i + 1, N - 1)];
        const u = bed[Math.max(j - 1, 0) * N + i], d = bed[Math.min(j + 1, N - 1) * N + i];
        slope[j * N + i] = Math.atan(Math.hypot(r - l, d - u) / (2 * cell)) * 180 / Math.PI;
    }

    // Forest stands above 25 ha survive as parks when spared.
    const forest = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) if (cover[k] === COVER.FOREST) forest[k] = 1;
    if (p.spareForest) keepLargeComponents(forest, N, 400); else forest.fill(0);

    const buildable = new Uint8Array(N * N);
    // Ground a real landmark keeps to itself. Metres from the block centre.
    const inClearing = (k) => p.clearX !== undefined && Math.hypot((k % N + 0.5 - N / 2) * cell - p.clearX, (Math.floor(k / N) + 0.5 - N / 2) * cell - p.clearZ) < p.clearR;
    let valleyFloor = Infinity;
    if (p.maxRise) for (let k = 0; k < N * N; k++) valleyFloor = Math.min(valleyFloor, bed[k]);
    let buildableCells = 0;
    for (let k = 0; k < N * N; k++) {
        if ((p.maxRise && bed[k] - valleyFloor > p.maxRise) || inClearing(k) || water[k] || slope[k] > p.slopeLimit || cover[k] === COVER.ROCK || forest[k] || distWet[k] < 50) continue;
        buildable[k] = 1;
        buildableCells++;
    }
    stats.buildableKm2 = buildableCells * cell * cell / 1e6;

    // Centres: the click, then the largest real places, spaced so they stay districts of their own.
    report('Choosing the centres', 0.08);
    const smoothBuildable = boxBlur(Float32Array.from(buildable), N, 8);
    const centreI = Math.floor(N / 2), centreJ = Math.floor(N / 2);
    const first = snapToBuildable(centreI, centreJ, smoothBuildable, N, Math.floor(6000 / cell));
    const centres = [{ i: first[0], j: first[1], weight: 1, name: input.name ?? null, primary: true }];
    const minGap = Math.max(3500, Math.sqrt(p.population / p.density) * 1000 / (Math.sqrt(p.centres) + 1.2));
    const placeList = (places ?? []).filter((q) => q.i >= 0 && q.j >= 0 && q.i < N && q.j < N && smoothBuildable[q.j * N + q.i] > 0.25).sort((a, b) => b.rank - a.rank);
    for (const q of placeList) {
        if (centres.length >= p.centres) break;
        if (centres.some((c) => Math.hypot(c.i - q.i, c.j - q.j) * cell < minGap)) continue;
        centres.push({ i: q.i, j: q.j, weight: 0.42 + 0.3 * random(), name: q.name });
    }
    while (centres.length < p.centres) {
        let best = null, bestScore = -1;
        for (let t = 0; t < 400; t++) {
            const i = Math.floor(random() * N), j = Math.floor(random() * N);
            if (!buildable[j * N + i]) continue;
            const gap = Math.min(...centres.map((c) => Math.hypot(c.i - i, c.j - j) * cell));
            const near = Math.hypot(i - centreI, j - centreJ) * cell;
            const score = gap < minGap ? 0 : smoothBuildable[j * N + i] / (1 + near / 8000);
            if (score > bestScore) { bestScore = score; best = [i, j]; }
        }
        if (!best || bestScore <= 0) break;
        centres.push({ i: best[0], j: best[1], weight: 0.4 + 0.3 * random(), name: null });
    }

    // Metro first: stations pull density, so the city grows along the lines the way Seoul's did.
    report('Laying the metro', 0.12);
    const targetArea = p.population / p.density;
    const radiusKm = Math.sqrt(targetArea / Math.PI);
    const metro = routeMetro({ N, cell, centres, buildable: smoothBuildable, random, radiusKm, population: p.population });

    report('Spreading the people', 0.17);
    const noise = fbm(N, 6, 90, random);
    const attraction = new Float32Array(N * N);
    const lambdaMain = Math.max(1800, radiusKm * 1000 * 0.42);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (!buildable[k]) continue;
        let v = 0;
        for (const c of centres) {
            const d = Math.hypot(c.i - i, c.j - j) * cell;
            v = Math.max(v, c.weight * Math.exp(-d / (lambdaMain * (c.primary ? 1 : 0.62))));
        }
        v *= 0.72 + 0.56 * noise[k];
        v *= 1 - 0.55 * Math.pow(slope[k] / p.slopeLimit, 2);
        attraction[k] = v;
    }
    for (const s of metro.stations) {
        const r = Math.ceil(700 / cell);
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            const i = s.i + di, j = s.j + dj;
            if (i < 0 || j < 0 || i >= N || j >= N) continue;
            const k = j * N + i;
            if (!buildable[k]) continue;
            const d = Math.hypot(di, dj) * cell;
            if (d < 700) attraction[k] *= 1 + 0.5 * (1 - d / 700);
        }
    }
    // Footprint: the most attractive cells until population / density is covered.
    const wantCells = Math.floor(targetArea * 1e6 / (cell * cell));
    const ranked = [];
    for (let k = 0; k < N * N; k++) if (attraction[k] > 0) ranked.push(attraction[k]);
    ranked.sort((a, b) => b - a);
    const usedCells = Math.min(wantCells, ranked.length);
    const threshold = usedCells > 0 ? ranked[usedCells - 1] : Infinity;
    const urban = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) if (attraction[k] >= threshold && attraction[k] > 0) urban[k] = 1;
    closeMask(urban, buildable, N);
    let urbanCells = 0;
    for (let k = 0; k < N * N; k++) urbanCells += urban[k];
    stats.footprintWantedKm2 = targetArea;
    stats.footprintKm2 = urbanCells * cell * cell / 1e6;
    stats.footprintFits = wantCells <= ranked.length;
    // Intensity 0..1 by rank inside the footprint, then softened at the rim.
    const intensity = new Float32Array(N * N);
    const peak = ranked[0] ?? 1;
    for (let k = 0; k < N * N; k++) if (urban[k]) intensity[k] = Math.pow(Math.max(0, attraction[k] - threshold) / Math.max(peak - threshold, 1e-6), 0.6);

    // Estate districts: low-frequency patches taking the asked share of the city, outside the core.
    const zoneNoise = fbm(N, 3, 60, random);
    const zoneValues = [];
    for (let k = 0; k < N * N; k += 7) if (urban[k]) zoneValues.push(zoneNoise[k]);
    zoneValues.sort((a, b) => a - b);
    const zoneCut = zoneValues.length ? zoneValues[Math.min(zoneValues.length - 1, Math.floor(zoneValues.length * p.danji))] : 0;
    const estate = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) if (urban[k] && zoneNoise[k] <= zoneCut && p.danji > 0.01) estate[k] = 1;

    report('Tracing streets', 0.25);
    const roads = traceRoads({ N, cell, bed, slope, water, distWet, urban, buildable, intensity, estate, centres, random, slopeLimit: p.slopeLimit, main, rail, report });
    stats.roadKm = roads.lengthKm;
    stats.arterialKm = roads.arterialKm;
    stats.bridges = roads.bridges;

    report('Raising buildings', 0.55);
    // Two passes: the first measures how much too much land is built at nominal heights, the second opens the fabric up to match.
    const placement = (open, estateOpen = 1) => placeBuildings({
        N, cell, bed, slope, water, urban, intensity, estate, roads, centres, metro, random, params: { ...p, openness: open, estateOpenness: estateOpen }, attraction, report,
    });
    let placed = placement(1);
    if (placed.stats.floorScale < 0.85) {
        const open = Math.min(1.5, 1 / Math.max(placed.stats.floorScale, 0.2));
        placed = placement(open);
        // Villas opened as far as they go and the estates still hold too many homes: space the estates too, so they stay tall.
        if (placed.stats.floorScale < 0.8) placed = placement(open, Math.min(1.8, Math.sqrt(1 / Math.max(placed.stats.floorScale, 0.2))));
    }
    Object.assign(stats, placed.stats);

    report('Running the commute', 0.82);
    const commute = assignCommute({ N, cell, urban, water, roads, homes: placed.homes, jobs: placed.jobs, jobsPerPerson: p.jobsPerPerson });
    Object.assign(stats, commute.stats);

    stats.population = p.population;
    stats.densityGross = stats.housed / Math.max(stats.footprintKm2, 1e-6);
    stats.extentKm = extent / 1000;
    stats.radiusKm = radiusKm;
    stats.centres = centres.length;
    stats.stations = metro.stations.length;
    stats.metroLines = metro.lines.length;
    stats.onSlope = placed.stats.onSlope;
    report('Finishing', 0.92);
    return {
        params: p, stats, bed, water, urban, intensity, forest, centres, metro, roads: roads.lines,
        buildings: placed.buildings, count: placed.count, chunks: placed.chunks, parks: placed.parks,
        typeRaster: placed.typeRaster, M: placed.M, growthRadius: placed.growthRadius, list: placed.list, commute, homes: placed.homes, jobs: placed.jobs,
    };
}

// Real rivers: water polygons joined across gaps by their centre lines. The trunk is the longest walk up from the
// lowest point of the widest system, so ponds, lakes and most tributaries stay out of it.
function riverCorridors(cover, bed, N, cell) {
    const polygons = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) if (cover[k] === COVER.WATER) polygons[k] = 1;
    const dist = chamfer(polygons, N, cell);
    const joined = new Uint8Array(N * N);
    for (let k = 0; k < N * N; k++) if (polygons[k] || (cover[k] === COVER.RIVER && dist[k] < 240)) joined[k] = 1;
    const { labels, sizes, count } = labelComponents(joined, N);
    const trunk = new Uint8Array(N * N), other = new Uint8Array(N * N);
    const none = { trunk, other, lowest: 0, lengthKm: 0 };
    if (!count) return none;
    // The longest thin system: a lake holds more cells than a river, but fills its bounding box.
    const box = new Int32Array((count + 1) * 4);
    for (let id = 1; id <= count; id++) { box[id * 4] = N; box[id * 4 + 2] = N; }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const id = labels[j * N + i];
        if (!id) continue;
        box[id * 4] = Math.min(box[id * 4], i); box[id * 4 + 1] = Math.max(box[id * 4 + 1], i);
        box[id * 4 + 2] = Math.min(box[id * 4 + 2], j); box[id * 4 + 3] = Math.max(box[id * 4 + 3], j);
    }
    let bestId = 0, bestSpan = 0;
    for (let id = 1; id <= count; id++) {
        const span = Math.hypot(box[id * 4 + 1] - box[id * 4], box[id * 4 + 3] - box[id * 4 + 2]);
        if (span > bestSpan && sizes[id] < span * span * 0.2 && sizes[id] * cell * cell >= 300000) { bestSpan = span; bestId = id; }
    }
    if (!bestId) return none;
    let lowest = -1;
    for (let k = 0; k < N * N; k++) if (labels[k] === bestId && (lowest < 0 || bed[k] < bed[lowest])) lowest = k;
    // Breadth-first walk from the lowest cell, staying below the taper height, farthest cell closes the trunk.
    const parent = new Int32Array(N * N).fill(-2);
    const queue = new Int32Array(N * N);
    let head = 0, tail = 0, far = lowest;
    queue[tail++] = lowest;
    parent[lowest] = -1;
    while (head < tail) {
        const k = queue[head++];
        far = k;
        const i = k % N;
        for (const q of [i > 0 ? k - 1 : -1, i < N - 1 ? k + 1 : -1, k - N, k + N]) {
            if (q < 0 || q >= N * N || parent[q] !== -2 || labels[q] !== bestId) continue;
            if (bed[q] - bed[lowest] > 140) continue;
            parent[q] = k;
            queue[tail++] = q;
        }
    }
    let steps = 0;
    for (let k = far; k >= 0; k = parent[k]) { trunk[k] = 1; steps++; }
    for (let k = 0; k < N * N; k++) if (labels[k] && !trunk[k] && sizes[labels[k]] * cell * cell >= 200000) other[k] = 1;
    return { trunk, other, lowest: bed[lowest], lengthKm: steps * cell / 1000 };
}

function keepLargeComponents(mask, N, minCells) {
    const { labels, sizes } = labelComponents(mask, N);
    for (let k = 0; k < N * N; k++) if (mask[k] && sizes[labels[k]] < minCells) mask[k] = 0;
}

// For every cell, the value at its nearest mask cell (two-pass chamfer propagation).
function nearestSeedValue(mask, values, N) {
    const out = new Float32Array(N * N).fill(Infinity);
    const dist = new Float32Array(N * N).fill(1e9);
    for (let k = 0; k < N * N; k++) if (mask[k]) { dist[k] = 0; out[k] = values[k]; }
    const relax = (k, n, w) => {
        if (dist[n] + w < dist[k]) { dist[k] = dist[n] + w; out[k] = out[n]; }
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (i > 0) relax(k, k - 1, 1);
        if (j > 0) { relax(k, k - N, 1); if (i > 0) relax(k, k - N - 1, 1.414); if (i < N - 1) relax(k, k - N + 1, 1.414); }
    }
    for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
        const k = j * N + i;
        if (i < N - 1) relax(k, k + 1, 1);
        if (j < N - 1) { relax(k, k + N, 1); if (i < N - 1) relax(k, k + N + 1, 1.414); if (i > 0) relax(k, k + N - 1, 1.414); }
    }
    return out;
}

function snapToBuildable(i, j, smooth, N, reach) {
    let best = [i, j], score = -1;
    for (let dj = -reach; dj <= reach; dj += 2) for (let di = -reach; di <= reach; di += 2) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) continue;
        const s = smooth[b * N + a] / (1 + Math.hypot(di, dj) / (reach * 0.4));
        if (s > score) { score = s; best = [a, b]; }
    }
    return best;
}

// One step of closing so single missing cells do not punch holes into the city.
function closeMask(mask, buildable, N) {
    const copy = mask.slice();
    for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (copy[k] || !buildable[k]) continue;
        const n = copy[k - 1] + copy[k + 1] + copy[k - N] + copy[k + N];
        if (n >= 3) mask[k] = 1;
    }
}

export { KIND };
