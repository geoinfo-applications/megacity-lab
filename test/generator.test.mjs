// Invariants of the generator on real terrain. Run: node --test --max-old-space-size=8192 test/generator.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadWindow } from './load_window.mjs';
import { generate, KIND } from '../site/js/gen/generate.js';
import { buildStreetDetail } from '../site/js/gen/streetdetail.js';
import { ROAD } from '../site/js/gen/roads.js';

const FURSTENLAND = [2731000, 1254000];
const SEOUL = { population: 9_640_000, density: 15_900 };
const SWISS_TOWN = { population: 160_000, density: 4_000, maxFloors: 12, centres: 2, danji: 0.2, slopeLimit: 14, riverWiden: 0 };

function decode(city) {
    const f = new Float32Array(city.buildings), u = new Uint8Array(city.buildings);
    return Array.from({ length: city.count }, (_, k) => ({ x: f[k * 7], base: f[k * 7 + 1], z: f[k * 7 + 2], w: f[k * 7 + 3], d: f[k * 7 + 4], h: f[k * 7 + 5], kind: u[k * 28 + 25] }));
}

test('same seed builds the same city, another seed does not', async () => {
    const w = await loadWindow(...FURSTENLAND, 640);

    const a = generate(w, { ...SWISS_TOWN, seed: 7 });
    const b = generate(w, { ...SWISS_TOWN, seed: 7 });
    const c = generate(w, { ...SWISS_TOWN, seed: 8 });

    const hash = (city) => createHash('sha1').update(new Uint8Array(city.buildings)).digest('hex');
    assert.equal(hash(a), hash(b));
    assert.notEqual(hash(a), hash(c));
});

test('Seoul on the Fuerstenland houses the people it was asked to', async () => {
    const w = await loadWindow(...FURSTENLAND, 1288);

    const city = generate(w, { ...SEOUL, seed: 1 });

    assert.equal(city.stats.footprintFits, true);
    assert.ok(Math.abs(city.stats.housed / SEOUL.population - 1) < 0.05, `housed ${city.stats.housed}`);
    assert.ok(Math.abs(city.stats.footprintKm2 / 606 - 1) < 0.05, `footprint ${city.stats.footprintKm2}`);
    assert.ok(city.stats.floorScale > 0.6 && city.stats.floorScale < 1.5, `floor scale ${city.stats.floorScale}`);
});

test('no building stands in water or outside the city footprint', async () => {
    const N = 1288;
    const w = await loadWindow(...FURSTENLAND, N);

    const city = generate(w, { ...SEOUL, seed: 2 });

    let wet = 0, outside = 0;
    for (const b of decode(city)) {
        const k = Math.floor(b.z / w.cell + N / 2) * N + Math.floor(b.x / w.cell + N / 2);
        if (city.water[k]) wet++;
        if (!city.urban[k]) outside++;
    }
    // The landmark and centres may sit on the snap point; anything more is a placement bug.
    assert.ok(wet <= 1, `${wet} in water`);
    assert.ok(outside <= 1, `${outside} outside`);
});

test('heights respect the limit and buildings stay on the terrain', async () => {
    const N = 1288;
    const w = await loadWindow(...FURSTENLAND, N);

    const city = generate(w, { ...SEOUL, maxFloors: 25, seed: 3 });

    let lowest = Infinity;
    for (const v of city.bed) if (v < lowest) lowest = v;
    for (const b of decode(city)) {
        if (b.kind === KIND.TREE) continue;
        // Foundation on a slope adds up to about 35 m under a long slab; towers get 3.9 m per floor.
        const storey = b.kind === KIND.TOWER ? 3.9 : 2.9;
        assert.ok(b.h <= 25 * storey + 35, `kind ${b.kind} height ${b.h}`);
        const k = Math.floor(b.z / w.cell + N / 2) * N + Math.floor(b.x / w.cell + N / 2);
        assert.ok(Math.abs(b.base + lowest - city.bed[k]) < 400 || b.h > 0, 'base far from terrain');
        assert.ok(Number.isFinite(b.x + b.z + b.w + b.d + b.h + b.base));
    }
});

test('a height limit that cannot fit everyone reports the shortfall', async () => {
    const w = await loadWindow(...FURSTENLAND, 800);

    const city = generate(w, { population: 20_000_000, density: 30_000, maxFloors: 8, seed: 1 });

    assert.ok(city.stats.housed < 20_000_000 * 0.95, `housed ${city.stats.housed}`);
});

test('the Matterhorn has nowhere to build, and says so without crashing', async () => {
    const w = await loadWindow(2617000, 1091000, 640);

    const city = generate(w, { ...SEOUL, seed: 1 });

    assert.equal(city.stats.footprintFits, false);
    assert.ok(city.stats.buildableKm2 < city.stats.footprintWantedKm2);
    assert.ok(Number.isFinite(city.stats.commuteMinutes));
});

test('a click on the national border still builds', async () => {
    const w = await loadWindow(2485000, 1115000, 640);

    const city = generate(w, { ...SWISS_TOWN, seed: 1 });

    assert.ok(Number.isFinite(city.stats.housed));
});

test('open water with no land at all gives an empty city, not an exception', async () => {
    const N = 64;
    const w = { N, cell: 25, bed: new Float32Array(N * N).fill(400), cover: new Uint8Array(N * N).fill(1), main: [], rail: [], places: [] };

    const city = generate(w, { ...SWISS_TOWN, seed: 1 });

    assert.equal(city.count, 0);
    assert.equal(city.stats.housed, 0);
});

test('homes on the grid add up to the housed total', async () => {
    const w = await loadWindow(...FURSTENLAND, 800);

    const city = generate(w, { ...SEOUL, population: 3_000_000, seed: 4 });

    const onGrid = city.homes.reduce((sum, v) => sum + v, 0);
    assert.ok(Math.abs(onGrid / city.stats.housed - 1) < 0.005, `${onGrid} vs ${city.stats.housed}`);
});

test('a lake with more cells than the river does not become the main river', () => {
    const N = 400;
    const bed = new Float32Array(N * N).fill(500);
    const cover = new Uint8Array(N * N);
    for (let j = 20; j < 120; j++) for (let i = 20; i < 120; i++) cover[j * N + i] = 1;
    for (let i = 0; i < N; i++) for (let d = 0; d < 3; d++) cover[(300 + d) * N + i] = 1;
    const w = { N, cell: 25, bed, cover, main: [], rail: [], places: [] };

    const city = generate(w, { population: 200_000, density: 8_000, centres: 1, riverWiden: 200, seed: 1 });

    assert.equal(city.water[306 * N + 200], 1);
    assert.equal(city.water[140 * N + 70], 0);
});

test('forest and rock holes one cell wide stay out of the footprint', () => {
    const N = 200;
    const bed = new Float32Array(N * N).fill(500);
    const cover = new Uint8Array(N * N);
    cover[100 * N + 100] = 3;
    const w = { N, cell: 25, bed, cover, main: [], rail: [], places: [] };

    const city = generate(w, { population: 300_000, density: 12_000, centres: 1, riverWiden: 0, seed: 1 });

    assert.equal(city.urban[100 * N + 100], 0);
});

test('a small city at a low density does not overbuild its footprint', async () => {
    const w = await loadWindow(...FURSTENLAND, 640);

    const city = generate(w, { ...SWISS_TOWN, seed: 1 });

    assert.ok(Math.abs(city.stats.housed / SWISS_TOWN.population - 1) < 0.1, `housed ${city.stats.housed}`);
});

test('street length counts only what lies in the block', async () => {
    const w = await loadWindow(...FURSTENLAND, 640);

    const city = generate(w, { ...SWISS_TOWN, seed: 1 });

    const half = 640 * w.cell / 2;
    for (const line of city.roads) for (let q = 0; q < line.points.length; q += 2) {
        assert.ok(Math.abs(line.points[q]) <= half + 30 && Math.abs(line.points[q + 1]) <= half + 30, 'road outside the block');
    }
});

test('commuters follow the jobs-per-person assumption', async () => {
    const w = await loadWindow(...FURSTENLAND, 640);

    const half = generate(w, { ...SWISS_TOWN, jobsPerPerson: 0.25, seed: 1 });
    const full = generate(w, { ...SWISS_TOWN, jobsPerPerson: 0.5, seed: 1 });

    const sum = (load) => load.reduce((total, v) => total + v, 0);
    assert.ok(sum(full.commute.load) > sum(half.commute.load) * 1.3);
});

function streetFixture() {
    const roads = [
        { level: ROAD.ARTERIAL, points: Float32Array.from([-800, 0, -300, 40, 300, -40, 800, 0]) },
        { level: ROAD.COLLECTOR, points: Float32Array.from([-800, 6, -300, 46, 300, -34, 800, 6]) },
        { level: ROAD.LOCAL, points: Float32Array.from([0, -500, 10, -200, 0, 500]) },
    ];
    const buildings = { buffer: new ArrayBuffer(0), count: 0 };
    return { roads, buildings, surfaceAt: () => 10, centre: [0, 0], radius: 600, seed: 3 };
}

test('street detail is reproducible and stays around the view', () => {
    const a = buildStreetDetail(streetFixture());
    const b = buildStreetDetail(streetFixture());

    assert.deepEqual(new Uint8Array(a.instances), new Uint8Array(b.instances));
    assert.ok(a.count > 100);
    const f = new Float32Array(a.instances);
    for (let k = 0; k < a.count; k++) assert.ok(Math.hypot(f[k * 7], f[k * 7 + 2]) < 600 * 1.05 + 40);
});

test('a road running through a better road keeps no marks or traffic there', () => {
    const detail = buildStreetDetail(streetFixture());

    const collector = detail.lines.find((line) => line.level === ROAD.COLLECTOR);
    const arterial = detail.lines.find((line) => line.level === ROAD.ARTERIAL);
    assert.equal(collector.runs.length, 0);
    assert.ok(arterial.runs.length > 0);
});

test('every junction end gets a crossing, an open road end at the edge does not', () => {
    const detail = buildStreetDetail(streetFixture());

    const local = detail.crossings.filter((c) => c.level === ROAD.LOCAL);
    assert.equal(local.length, 2);
});

test('every eligible building in reach gets a door', () => {
    const count = 3000;
    const buffer = new ArrayBuffer(count * 28);
    const f = new Float32Array(buffer), u8 = new Uint8Array(buffer);
    for (let k = 0; k < count; k++) {
        f.set([(k % 60) * 16 - 480, 0, Math.floor(k / 60) * 16 - 400, 10, 10, 15], k * 7);
        u8[k * 28 + 25] = KIND.VILLA;
    }

    const detail = buildStreetDetail({ roads: [], buildings: { buffer, count }, surfaceAt: () => 0, centre: [0, 0], radius: 600, seed: 1 });

    const kinds = new Uint8Array(detail.instances);
    let doors = 0;
    for (let k = 0; k < detail.count; k++) if (kinds[k * 28 + 25] === KIND.DOOR) doors++;
    assert.equal(doors, count);
});
