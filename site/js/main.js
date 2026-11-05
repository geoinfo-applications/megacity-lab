// Megacity Lab: pick a place, set a few numbers, watch a city rise on real Swiss terrain.
import { createContext, imageTexture, texture } from './gl.js';
import { OrbitCamera, transform } from './camera.js';
import { lv95ToWgs84, solarPosition, sunVector } from './sun.js';
import { TerrainField } from './terrain.js';
import { Renderer } from './render.js';
import { loadJson, loadDem, loadImage, NationalStore } from './data.js';
import { rankPlaces } from './gen/places.js';
import { ROAD, ROAD_WIDTH } from './gen/roads.js';
import { buildStreetDetail } from './gen/streetdetail.js';

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-CH');
const canvas = $('view');
const gl = createContext(canvas);
const terrainField = new TerrainField(gl);
const renderer = new Renderer(gl);
const camera = new OrbitCamera();
let worker = startWorker();

const CELL = 25;
const PARAMS = [
    { id: 'population', label: 'People', colour: 'l1', min: 5.0, max: 7.45, step: 0.01, log: true, format: (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} M` : fmt.format(Math.round(v / 1000) * 1000)) },
    { id: 'density', label: 'People per km²', colour: 'l2', min: 3.3, max: 4.7, step: 0.01, log: true, format: (v) => fmt.format(Math.round(v / 100) * 100) },
    { id: 'maxFloors', label: 'Height limit', colour: 'l3', min: 6, max: 110, step: 1, format: (v) => `${v} floors` },
    { id: 'centres', label: 'Centres', colour: 'l4', min: 1, max: 9, step: 1, format: (v) => String(v) },
    { id: 'danji', label: 'Apartment estates', colour: 'l5', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)} %` },
    { id: 'slopeLimit', label: 'Build up to slope', colour: 'l6', min: 8, max: 30, step: 1, format: (v) => `${v}°` },
    { id: 'riverWiden', label: 'Widen the main river', colour: 'l7', min: 0, max: 500, step: 10, format: (v) => (v ? `${v * 2} m wider` : 'as it is') },
];
const PRESETS = [
    { name: 'Seoul', title: '9.64 M people on 605 km²', values: { population: 9_640_000, density: 15_900, maxFloors: 60, centres: 5, danji: 0.6, slopeLimit: 18, riverWiden: 220 } },
    { name: 'Tower city', title: 'Hong Kong-like: very dense, very tall', values: { population: 7_500_000, density: 45_000, maxFloors: 90, centres: 3, danji: 0.9, slopeLimit: 24, riverWiden: 0 } },
    { name: 'Sprawl', title: 'Low and wide, about the density of Los Angeles', values: { population: 3_800_000, density: 3_200, maxFloors: 14, centres: 7, danji: 0.05, slopeLimit: 14, riverWiden: 0 } },
    { name: 'Swiss town', title: 'Twice St. Gallen, at a Swiss density', values: { population: 160_000, density: 4_000, maxFloors: 12, centres: 2, danji: 0.2, slopeLimit: 14, riverWiden: 0 } },
];
const LAYERS = [['none', 'City'], ['metro', 'Metro'], ['traffic', 'Traffic'], ['people', 'People']];

const state = {
    params: { ...PRESETS[0].values, seed: 1 },
    e: null, n: null, name: null,
    city: null, overlayCache: {}, layer: 'none',
    grow: 1, growFrom: null, hour: 16.5, base: 0, domain: null, national: null, names: [], clock: 0,
    token: 0,
};

function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    for (const p of PARAMS) if (q.has(p.id)) state.params[p.id] = +q.get(p.id);
    if (q.has('seed')) state.params.seed = +q.get('seed');
    if (q.has('maxRise')) state.params.maxRise = +q.get('maxRise');
    if (q.has('clearE')) state.clearing = { e: +q.get('clearE'), n: +q.get('clearN'), r: +q.get('clearR') };
    if (q.has('hour')) state.hour = +q.get('hour');
    state.still = q.has('still');
    if (q.has('e') && q.has('n')) { state.e = +q.get('e'); state.n = +q.get('n'); state.name = q.get('name'); return true; }
    return false;
}

function writeHash() {
    const q = new URLSearchParams();
    q.set('e', Math.round(state.e));
    q.set('n', Math.round(state.n));
    if (state.name) q.set('name', state.name);
    for (const p of PARAMS) q.set(p.id, state.params[p.id]);
    q.set('seed', state.params.seed);
    q.set('hour', state.hour);
    history.replaceState(null, '', `#${q}`);
}

const blockCellsFor = (params) => {
    // City area plus the room terrain, water and greenbelt usually take, snapped to a block between 16 and 40 km.
    const km = Math.sqrt(params.population / params.density * 1.7);
    return Math.max(640, Math.min(1600, Math.round(km * 40 / 8) * 8));
};

// ---------- Panel ----------
function buildPanel() {
    const host = $('params');
    for (const p of PARAMS) {
        const div = document.createElement('div');
        div.className = 'line';
        div.innerHTML = `<label for="p-${p.id}">${p.label} <output id="o-${p.id}"></output></label><input id="p-${p.id}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" style="--c:var(--${p.colour})">`;
        host.append(div);
        const input = div.querySelector('input');
        input.addEventListener('input', () => {
            const raw = +input.value;
            state.params[p.id] = p.log ? Math.pow(10, raw) : raw;
            syncPanel(false);
        });
        input.addEventListener('change', () => build(false));
    }
    for (const preset of PRESETS) {
        const b = document.createElement('button');
        b.className = 'pill';
        b.textContent = preset.name;
        b.title = preset.title;
        b.addEventListener('click', () => {
            Object.assign(state.params, preset.values);
            syncPanel(true);
            if (state.e !== null) build(true);
        });
        $('presets').append(b);
    }
    for (const [id, label] of LAYERS) {
        const b = document.createElement('button');
        b.className = 'pill';
        b.textContent = label;
        b.dataset.layer = id;
        b.addEventListener('click', () => setLayer(id));
        $('layers').append(b);
    }
    $('reroll').addEventListener('click', () => { state.params.seed = (state.params.seed % 9999) + 1; build(true); });
    $('moveCity').addEventListener('click', openPicker);
    $('closePicker').addEventListener('click', () => { $('picker').hidden = true; });
    $('hour').addEventListener('input', () => { state.hour = +$('hour').value; syncView(); });
    $('grow').addEventListener('input', () => {
        state.grow = +$('grow').value / 100;
        state.growFrom = null;
        syncView();
    });
    syncPanel(true);
    syncView();
}

function syncPanel(setInputs) {
    for (const p of PARAMS) {
        const value = state.params[p.id];
        if (setInputs) $(`p-${p.id}`).value = p.log ? Math.log10(value) : value;
        $(`o-${p.id}`).textContent = p.format(value);
    }
    for (const b of $('presets').children) {
        const preset = PRESETS.find((x) => x.name === b.textContent);
        const on = Object.entries(preset.values).every(([k, v]) => Math.abs(state.params[k] - v) <= Math.abs(v) * 0.01);
        b.setAttribute('aria-pressed', String(on));
    }
    drawFootInfo();
}

function syncView() {
    const h = Math.floor(state.hour), m = Math.floor((state.hour - h) * 60);
    $('hourOut').textContent = `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    $('grow').value = state.grow * 100;
    $('growOut').textContent = `${Math.round(state.grow * 100)} %`;
}

function stat(value, label) { return `<div class="stat"><b>${value}</b><span>${label}</span></div>`; }

function showStats(s) {
    const millions = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : fmt.format(Math.round(v)));
    $('board').innerHTML = [
        stat(millions(s.housed), `housed of ${millions(s.population)} asked`),
        stat(`${fmt.format(Math.round(s.footprintKm2))} km²`, `city, in a ${s.extentKm.toFixed(0)} km block`),
        stat(fmt.format(s.buildings), 'buildings'),
        stat(`${Math.round(s.tallestM)} m`, 'tallest'),
        stat(`${fmt.format(Math.round(s.roadKm))} km`, `streets, ${s.bridges} new river bridges`),
        stat(String(s.stations), `metro stations on ${s.metroLines} lines`),
        stat(`${Math.round(s.commuteMinutes)} min`, 'mean commute, assumed speeds'),
        stat(`${Math.round(s.congested * 100)} %`, 'of city streets over capacity at peak'),
    ].join('');
    const notes = [];
    if (!s.footprintFits) notes.push(`Only ${fmt.format(Math.round(s.buildableKm2))} km² here is buildable, ${fmt.format(Math.round(s.footprintWantedKm2))} km² asked. The city packs in tighter.`);
    if (s.housed < s.population * 0.95) notes.push(`${millions(s.population - s.housed)} people have no home. Raise the height limit or lower the density.`);
    if (s.housed > s.population * 1.05) notes.push('More homes than people: lower the density or raise the people.');
    $('warning').textContent = notes.join(' ');
}

// ---------- Layers ----------
function setLayer(id) {
    state.layer = id;
    for (const b of $('layers').children) b.setAttribute('aria-pressed', String(b.dataset.layer === id));
    if (!state.city) return;
    if (id === 'none') { renderer.setOverlay(null); state.overlayCache = {}; return; }
    const bitmap = drawOverlay(id);
    renderer.setOverlay(imageTexture(gl, bitmap));
    bitmap.close();
}

function drawOverlay(id) {
    const S = 2048;
    const N = state.domain.w;
    const c = new OffscreenCanvas(S, S);
    const ctx = c.getContext('2d');
    const half = N * CELL / 2, s = S / (N * CELL);
    const city = state.city;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (id === 'metro') {
        ctx.fillStyle = 'rgba(16, 24, 38, .74)';
        ctx.fillRect(0, 0, S, S);
        for (const line of city.metro.lines) {
            ctx.strokeStyle = line.colour;
            ctx.lineWidth = 6;
            ctx.beginPath();
            line.points.forEach((p, k) => (k ? ctx.lineTo((p.x + half) * s, (p.z + half) * s) : ctx.moveTo((p.x + half) * s, (p.z + half) * s)));
            ctx.stroke();
        }
        for (const st of city.metro.stations) {
            ctx.beginPath();
            ctx.arc((st.x + half) * s, (st.z + half) * s, st.lines.length > 1 ? 6.5 : 4.5, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.lineWidth = 2.2;
            ctx.strokeStyle = st.lines.length > 1 ? '#17263a' : city.metro.lines[st.lines[0]].colour;
            ctx.stroke();
        }
    } else if (id === 'traffic') {
        ctx.fillStyle = 'rgba(16, 20, 30, .72)';
        ctx.fillRect(0, 0, S, S);
        const M = city.loadM, size = city.loadSize;
        for (const line of city.roads) {
            if (line.level === ROAD.RAIL || line.level === ROAD.LOCAL) continue;
            const p = line.points;
            for (let q = 2; q < p.length; q += 2) {
                const i = Math.floor((p[q] + half) / size), j = Math.floor((p[q + 1] + half) / size);
                if (i < 0 || j < 0 || i >= M || j >= M) continue;
                const capacity = line.level === ROAD.MOTORWAY ? 8000 : line.level === ROAD.ARTERIAL ? 3600 : 1200;
                const ratio = city.load[j * M + i] / capacity;
                ctx.strokeStyle = ratio < 0.3 ? '#2fae66' : ratio < 0.7 ? '#e7c83a' : ratio < 1 ? '#ef7c1c' : '#e0263a';
                ctx.lineWidth = line.level <= ROAD.ARTERIAL ? 3.5 : 1.6;
                ctx.beginPath();
                ctx.moveTo((p[q - 2] + half) * s, (p[q - 1] + half) * s);
                ctx.lineTo((p[q] + half) * s, (p[q + 1] + half) * s);
                ctx.stroke();
            }
        }
    } else if (id === 'people') {
        // People per km² from the homes grid, smoothed over 4 cells.
        const R = 4, M = Math.floor(N / R);
        const small = new OffscreenCanvas(M, M);
        const stx = small.getContext('2d');
        const img = stx.createImageData(M, M);
        const ramp = [[20, 30, 70], [0, 110, 170], [0, 168, 77], [239, 200, 40], [239, 80, 30], [255, 240, 240]];
        for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
            let sum = 0;
            for (let b = 0; b < R; b++) for (let a = 0; a < R; a++) sum += city.homes[(y * R + b) * N + x * R + a];
            const perKm2 = sum / (R * R * CELL * CELL / 1e6);
            const t = Math.min(0.9999, Math.log10(1 + perKm2) / 5) * (ramp.length - 1);
            const k = Math.floor(t), f = t - k;
            const o = (y * M + x) * 4;
            for (let ch = 0; ch < 3; ch++) img.data[o + ch] = ramp[k][ch] + (ramp[k + 1][ch] - ramp[k][ch]) * f;
            img.data[o + 3] = sum > 0 ? 235 : 0;
        }
        stx.putImageData(img, 0, 0);
        ctx.drawImage(small, 0, 0, S, S);
    }
    return c.transferToImageBitmap();
}

// ---------- Map picker ----------
async function initPicker() {
    const ix = state.national.index;
    const map = $('map');
    const ctx = map.getContext('2d');
    const overview = await loadImage('nat/overview.jpg');
    map.height = Math.round(map.width * overview.height / overview.width);
    ctx.drawImage(overview, 0, 0, map.width, map.height);
    const foot = $('foot');
    const toLv95 = (ev) => {
        const r = map.getBoundingClientRect();
        const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
        return { e: ix.e0 + fx * ix.cols * ix.tile, n: ix.n0 - fy * ix.rows * ix.tile, fx, fy, r };
    };
    map.addEventListener('pointermove', (ev) => {
        const p = toLv95(ev);
        const diameter = 2 * Math.sqrt(state.params.population / state.params.density / Math.PI) * 1000;
        const px = diameter / (ix.cols * ix.tile) * p.r.width;
        foot.style.display = 'block';
        foot.style.width = foot.style.height = `${px}px`;
        foot.style.left = `${p.fx * p.r.width}px`;
        foot.style.top = `${p.fy * p.r.height}px`;
        state.hover = nearestPlace(p.e, p.n);
        drawFootInfo();
    });
    map.addEventListener('pointerleave', () => { foot.style.display = 'none'; state.hover = null; drawFootInfo(); });
    map.addEventListener('click', (ev) => {
        const p = toLv95(ev);
        go(p.e, p.n, nearestPlace(p.e, p.n));
    });
    const input = $('place');
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const hits = $('hits');
        hits.textContent = '';
        if (q.length < 2) return;
        for (const p of state.names.filter((x) => x[3] === 'place' && x[0].toLowerCase().startsWith(q)).slice(0, 10)) {
            const b = document.createElement('button');
            b.textContent = p[0];
            b.addEventListener('click', () => go(p[1], p[2], p[0]));
            hits.append(b);
        }
    });
    $('goFurstenland').addEventListener('click', () => go(2731000, 1254000, 'Flawil'));
}

function nearestPlace(e, n) {
    let near = null, best = 5000;
    for (const q of state.names) {
        if (q[3] !== 'place' || q[4] < 4000) continue;
        const d = Math.hypot(q[1] - e, q[2] - n);
        if (d < best) { best = d; near = q[0]; }
    }
    return near;
}

function drawFootInfo() {
    const km2 = state.params.population / state.params.density;
    const text = `${PARAMS[0].format(state.params.population)} people on ${fmt.format(Math.round(km2))} km²`;
    $('footInfo').textContent = state.hover ? `${text}, around ${state.hover}` : text;
}

function openPicker() {
    $('picker').hidden = false;
    $('closePicker').classList.toggle('hidden', !state.city);
}

function go(e, n, name) {
    // On the 25 m grid: the hash stores whole metres, and an off-grid click would reload as a different city.
    state.e = Math.round(e / CELL) * CELL;
    state.n = Math.round(n / CELL) * CELL;
    state.name = name;
    $('picker').hidden = true;
    build(true);
}

// ---------- Building ----------
function setLoader(text, fraction) {
    $('loader').hidden = false;
    $('loaderText').textContent = text;
    $('progress').firstChild.style.width = `${Math.round(fraction * 100)}%`;
}

function toWorld(points, x0, y1, half) {
    const out = [];
    for (const [e, n] of points) out.push(e - x0 - half, y1 - n - half);
    return out;
}

async function build(animate) {
    if (state.e === null) return;
    const token = ++state.token;
    writeHash();
    setBusy(true);
    setLoader('Cutting the block out of the national terrain', 0.01);
    // A build still running is out of date: stop it rather than let it finish and drop its bitmaps.
    if (state.pending) {
        worker.terminate();
        worker = startWorker();
        state.pending.resolve({ token: -1 });
        state.pending = null;
    }
    try {
        await buildInner(token, animate);
    } catch (error) {
        if (token === state.token) showBuildError(error);
    }
}

async function buildInner(token, animate) {
    const N = blockCellsFor(state.params);
    const win = await state.national.window(state.e, state.n, N);
    if (token !== state.token) return;
    const half = N * CELL / 2;
    const places = state.names.filter((p) => p[3] === 'place')
        .map((p) => ({ name: p[0], rank: 0, i: Math.floor((p[1] - win.x0) / CELL), j: Math.floor((win.y1 - p[2]) / CELL) }))
        .filter((p) => p.i >= 0 && p.j >= 0 && p.i < N && p.j < N);
    const settlement = [];
    for (const [e, n] of win.infra?.buildingPoints ?? []) settlement.push(Math.floor((e - win.x0) / CELL), Math.floor((win.y1 - n) / CELL));
    rankPlaces(places, settlement, N);
    const input = {
        N, cell: CELL, bed: win.bed, cover: win.cover, places, name: state.name,
        main: (win.infra?.main ?? []).map((m) => ({ motorway: m.motorway, points: toWorld(m.c, win.x0, win.y1, half) })),
        rail: (win.infra?.rail ?? []).map((m) => ({ points: toWorld(m.c, win.x0, win.y1, half) })),
    };
    const clearing = state.clearing ? { clearX: state.clearing.e - win.x0 - half, clearZ: win.y1 - state.clearing.n - half, clearR: state.clearing.r } : {};
    worker.postMessage({ input, params: { ...state.params, ...clearing }, token });
    const result = await new Promise((resolve, reject) => { state.pending = { resolve, reject, token }; });
    state.pending = null;
    if (result.token !== state.token) return;
    await install(result, win, animate);
}

function startWorker() {
    const next = new Worker(new URL('./gen/worker.js', import.meta.url), { type: 'module' });
    next.onmessage = ({ data }) => {
        if (data.token !== state.token || !state.pending) return;
        if (data.type === 'progress') setLoader(data.message, data.fraction);
        else if (data.type === 'error') {
            console.error(data.stack);
            state.pending.reject(new Error(data.message));
        } else state.pending.resolve(data);
    };
    next.onerror = (event) => state.pending?.reject(new Error(event.message ?? 'the generator stopped'));
    return next;
}

function showBuildError(error) {
    console.error(error);
    $('loader').hidden = true;
    setBusy(false);
    $('warning').textContent = `Could not build this city: ${error.message}. Try another place or lower the numbers.`;
    if (!state.city) openPicker();
}

// While a city builds, the controls take no keyboard or mouse input.
function setBusy(busy) {
    for (const id of ['sign', 'dock']) $(id).inert = busy;
}

async function install(result, win, animate) {
    const N = win.w;
    let low = Infinity;
    for (const v of result.bed) if (v < low) low = v;
    state.base = low;
    terrainField.load(N, N, result.bed);
    const oldImage = renderer.terrain?.image, oldCover = renderer.terrain?.cover;
    if (oldImage) gl.deleteTexture(oldImage.tex);
    if (oldCover) gl.deleteTexture(oldCover.tex);
    renderer.setTerrain({ w: N, h: N, cell: CELL, base: low, image: imageTexture(gl, win.image), cover: coverTexture(N, (k) => result.water[k], result.forest) });
    win.image.close();
    state.domain = { w: N, h: N, x0: win.x0, y1: win.y1 };
    // Arrival time on a coarse grid: same formula as the instances, so ground and buildings rise together.
    const G = 256;
    const arrival = new Float32Array(G * G);
    const c0 = result.centres[0];
    const lx = (c0.i + 0.5 - N / 2) * CELL, lz = (c0.j + 0.5 - N / 2) * CELL;
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        const wx = ((x + 0.5) / G - 0.5) * N * CELL, wz = ((y + 0.5) / G - 0.5) * N * CELL;
        arrival[y * G + x] = (Math.hypot(wx - lx, wz - lz) / result.growthRadius * 230 + 5) / 255;
    }
    renderer.setCity({
        instances: result.buildings, count: result.count, chunks: result.chunks,
        ground: imageTexture(gl, result.ground), glow: imageTexture(gl, result.glow), growth: texture(gl, G, G, 'r32f', arrival, 'linear'),
    });
    result.ground.close();
    result.glow.close();
    state.city = result;
    state.lowest = low;
    setMovers(result, N);
    showStats(result.stats);
    state.overlayCache = {};
    setLayer(state.layer);
    buildLabels(result, win);
    const placeName = result.centres[0].name ?? state.name ?? 'Neu';
    $('cityName').textContent = placeName.replace(/\s+(SG|TG|AR|AI|ZH|BE|LU|GR|TI|VS|VD|GE|AG|BL|BS|SO|FR|NE|JU|SH|SZ|ZG|UR|OW|NW|GL)$/, '');
    $('cityWhere').textContent = `Seed ${result.params.seed}, built in ${(result.ms / 1000).toFixed(1)} s`;
    $('loader').hidden = true;
    setBusy(false);
    if (animate) {
        const extent = N * CELL;
        const target = [lx, 80, lz];
        camera.target = target.slice();
        camera.distance = extent * 0.95;
        camera.yaw = 0.35;
        camera.pitch = 0.62;
        camera.flyTo({ target, distance: Math.max(3000, extent * 0.32), yaw: 0.62, pitch: 0.34 }, 11);
        state.grow = 0;
        state.growFrom = matchMedia('(prefers-reduced-motion: reduce)').matches ? null : performance.now();
        if (state.growFrom === null) state.grow = 1;
    } else state.grow = 1;
    syncView();
    loadOuter(win).catch((error) => console.warn(error));
    window.__mc.ready = true;
    window.__mc.stats = result.stats;
}

function coverTexture(N, isWater, forest) {
    const cover = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) {
        cover[k * 4] = isWater(k) ? 255 : 0;
        cover[k * 4 + 1] = forest[k] ? 255 : 0;
    }
    return texture(gl, N, N, 'rgba8', cover, 'linear');
}

function setMovers(city, N) {
    const halfSize = city.loadSize;
    const half = N * CELL / 2;
    const heightAt = (x, z) => {
        const i = Math.max(0, Math.min(N - 1, Math.floor(x / CELL + N / 2))), j = Math.max(0, Math.min(N - 1, Math.floor(z / CELL + N / 2)));
        return city.bed[j * N + i] - state.lowest;
    };
    const cars = [];
    const speeds = { [ROAD.MOTORWAY]: 26, [ROAD.ARTERIAL]: 13, [ROAD.COLLECTOR]: 8 };
    for (const line of city.roads) {
        if (line.level > ROAD.COLLECTOR || line.level === ROAD.RAIL) continue;
        const p = line.points;
        for (let q = 2; q < p.length; q += 2) {
            const i = Math.floor((p[q] + half) / halfSize), j = Math.floor((p[q + 1] + half) / halfSize);
            const load = i >= 0 && j >= 0 && i < city.loadM && j < city.loadM ? city.load[j * city.loadM + i] : 0;
            const length = Math.hypot(p[q] - p[q - 2], p[q + 1] - p[q - 1]);
            const count = Math.min(6, Math.max(line.level <= ROAD.ARTERIAL ? 1 : 0, Math.round(load / 900 * length / 100)));
            for (let k = 0; k < count && cars.length < 130000 * 11; k++) {
                const forward = k % 2 === 0;
                const [ax, az, bx, bz] = forward ? [p[q - 2], p[q - 1], p[q], p[q + 1]] : [p[q], p[q + 1], p[q - 2], p[q - 1]];
                const colour = forward ? [1.0, 0.86, 0.62] : [1.0, 0.12, 0.08];
                cars.push(ax, az, bx, bz, heightAt(ax, az), heightAt(bx, bz), Math.random(), speeds[line.level] / Math.max(length, 1), ...colour);
            }
        }
    }
    renderer.setMovers(cars.length ? [{ data: new Float32Array(cars), size: 2.5, strength: 0.5, dayStrength: 0 }] : []);
}

const labelEls = [];
function buildLabels(city, win) {
    $('labels').textContent = '';
    labelEls.length = 0;
    const N = win.w;
    const add = (text, x, z, y, kind) => {
        const div = document.createElement('div');
        div.className = `label ${kind}`;
        div.textContent = text;
        $('labels').append(div);
        labelEls.push({ div, x, y, z });
    };
    const clean = (name) => name.replace(/\s+[A-Z]{2}$/, '');
    city.centres.forEach((c, index) => {
        const x = (c.i + 0.5 - N / 2) * CELL, z = (c.j + 0.5 - N / 2) * CELL;
        const y = city.bed[c.j * N + c.i] - state.lowest + 40;
        const text = index === 0 ? clean(c.name ?? state.name ?? 'Centre') : clean(c.name ?? `District ${index}`);
        add(text, x, z, y, index === 0 ? 'primary' : '');
    });
    // A few real summits on the horizon: the city still stands in Switzerland.
    const half = N * CELL / 2;
    const peaks = state.names.filter((p) => p[3] === 'peak' && Math.hypot(p[1] - state.e, p[2] - state.n) < 70000 && Math.hypot(p[1] - state.e, p[2] - state.n) > half)
        .sort((a, b) => (b[5] ?? 0) - (a[5] ?? 0));
    const shown = [];
    for (const p of peaks) {
        if (shown.length >= 5) break;
        if (shown.some((q) => Math.hypot(q[1] - p[1], q[2] - p[2]) < 15000)) continue;
        shown.push(p);
        add(p[0], p[1] - win.x0 - half, win.y1 - p[2] - half, (p[5] ?? 0) - state.lowest + 60, 'peak');
    }
}

// Low-resolution national terrain around the block, for the horizon. 25 km tiles at 300 m.
let outerToken = 0;
let outerKey = '';
async function loadOuter(win) {
    // Same place, same block: the horizon has not moved, even if the height base has.
    const key = `${state.e}|${state.n}|${win.w}`;
    if (key === outerKey) return;
    outerKey = key;
    state.outerWin = win;
    hqOuter = null;
    renderer.setOuter(null);
    const token = ++outerToken;
    const outer = await buildOuter(win, { span: 192000, size: 640, imageSize: 2048, folder: 'nat/horizon/', cells: 128 }, () => token === outerToken);
    if (outer) renderer.setOuter(outer);
}

let hqOuter = null;
function ensureHqOuter() {
    if (!state.outerWin) return Promise.resolve();
    if (!hqOuter) {
        const token = outerToken;
        hqOuter = buildOuter(state.outerWin, { span: 128000, size: 3200, imageSize: 8192 }, () => token === outerToken).then((outer) => {
            if (outer) renderer.setOuterHq(outer);
        });
    }
    return hqOuter;
}

async function buildOuter(win, { span, size, imageSize, folder = 'nat/', cells = state.national.index.cells }, isCurrent) {
    const ix = state.national.index;
    const px = span / size;
    const centerE = state.e, centerN = state.n;
    const west = centerE - span / 2, north = centerN + span / 2;
    const heights = new Float32Array(size * size).fill(NaN);
    const canvas2d = new OffscreenCanvas(imageSize, imageSize);
    // CPU raster: a GPU-rastered 8192² canvas made a later float-texture framebuffer fail.
    const ctx = canvas2d.getContext('2d', { willReadFrequently: imageSize > 4096 });
    ctx.fillStyle = '#7f8778';
    ctx.fillRect(0, 0, imageSize, imageSize);
    const c0 = Math.floor((west - ix.e0) / ix.tile), c1 = Math.floor((west + span - ix.e0) / ix.tile);
    const r0 = Math.floor((ix.n0 - north) / ix.tile), r1 = Math.floor((ix.n0 - north + span) / ix.tile);
    const jobs = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const key = `${c}_${r}`;
        const info = ix.tiles[key];
        if (!info) continue;
        jobs.push(Promise.all([loadDem(`${folder}dem_${key}.dem.png`, { w: cells, h: cells }), info.img ? loadImage(`${folder}img_${key}.jpg`) : null]).then(([dem, img]) => {
            if (!isCurrent()) { img?.close(); return; }
            const tileE = ix.e0 + c * ix.tile, tileN = ix.n0 - r * ix.tile;
            const scale = imageSize / span;
            if (img) {
                ctx.drawImage(img, (tileE - west) * scale, (north - tileN) * scale, ix.tile * scale, ix.tile * scale);
                img.close();
            }
            for (let y = 0; y < size; y++) {
                const n = north - (y + 0.5) * px;
                const row = Math.floor((tileN - n) / (ix.tile / cells));
                if (row < 0 || row >= cells) continue;
                for (let x = 0; x < size; x++) {
                    const e = west + (x + 0.5) * px;
                    const col = Math.floor((e - tileE) / (ix.tile / cells));
                    if (col >= 0 && col < cells) heights[y * size + x] = dem[row * cells + col];
                }
            }
        }));
    }
    await Promise.all(jobs);
    if (!isCurrent()) return null;
    // Beyond the national store: sink below the lowest terrain, so the block edge meets a flat haze.
    for (let k = 0; k < heights.length; k++) if (Number.isNaN(heights[k]) || heights[k] > 6000) heights[k] = state.lowest - 5;
    const half = win.w * CELL / 2;
    const rect = [west - win.x0 - half, north === 0 ? 0 : win.y1 - north - half, span, span];
    return { w: size, h: size, heights, image: imageTexture(gl, canvas2d.transferToImageBitmap()), rect };
}

// ---------- Input ----------
function installInput() {
    let drag = null;
    canvas.addEventListener('pointerdown', (ev) => {
        canvas.setPointerCapture(ev.pointerId);
        drag = { x: ev.clientX, y: ev.clientY, button: ev.button, shift: ev.shiftKey };
        camera.anim = null;
    });
    canvas.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        if (drag.button === 2 || drag.shift) {
            const scale = camera.distance * 0.0012;
            const c = Math.cos(camera.yaw), s = Math.sin(camera.yaw);
            camera.target[0] -= (dx * c + dy * s) * scale;
            camera.target[2] -= (dy * c - dx * s) * scale;
            followGround();
        } else {
            camera.yaw += dx * 0.005;
            camera.pitch = Math.max(0.03, Math.min(1.5, camera.pitch + dy * 0.004));
        }
    });
    const end = () => { drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        camera.anim = null;
        camera.distance = Math.max(120, Math.min(90000, camera.distance * Math.exp(ev.deltaY * 0.0012)));
        followGround();
    }, { passive: false });
}

function followGround() {
    if (!state.city) return;
    const N = state.domain.w;
    const i = Math.max(0, Math.min(N - 1, Math.floor(camera.target[0] / CELL + N / 2))), j = Math.max(0, Math.min(N - 1, Math.floor(camera.target[2] / CELL + N / 2)));
    camera.target[1] = state.city.bed[j * N + i] - state.lowest + Math.min(80, camera.distance * 0.02);
}

// ---------- Frame ----------
function resize() {
    const dpr = Math.min(window.devicePixelRatio ?? 1, 1.5);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
}

function sunNow() {
    const { lat, lon } = lv95ToWgs84(state.e ?? 2731000, state.n ?? 1254000);
    const h = state.hour;
    // A fixed June day: long shadows at either end, and a true night after 22:00.
    const date = new Date(Date.UTC(2026, 5, 21, Math.floor(h) - 2, Math.round((h % 1) * 60)));
    const pos = solarPosition(date, lat, lon);
    const sun = sunVector(pos.azimuth, pos.elevation);
    const night = Math.max(0, Math.min(1, (6 - pos.elevation) / 12));
    return { sun, night: night * night * (3 - 2 * night), elevation: pos.elevation };
}

function litShare(hour) {
    // Lights on: most at dusk, few at 3 am.
    if (hour < 5 || hour > 23) return 0.14 + 0.1 * Math.min(Math.abs(hour - 3) / 4, 1);
    if (hour > 17) return 0.55;
    return 0.35;
}

function placeLabels(viewProj) {
    const rect = canvas.getBoundingClientRect();
    for (const l of labelEls) {
        const c = transform(viewProj, [l.x, l.y, l.z, 1]);
        if (c[3] <= 0 || state.grow < 0.05) { l.div.style.display = 'none'; continue; }
        const x = (c[0] / c[3] * 0.5 + 0.5) * rect.width, y = (1 - (c[1] / c[3] * 0.5 + 0.5)) * rect.height;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) { l.div.style.display = 'none'; continue; }
        l.div.style.display = 'block';
        l.div.style.transform = `translate(${x}px, ${y}px)`;
    }
}

// ---------- Stills in the page ----------
const LOOKS = [['time', 'Time of day'], ['golden', 'Golden hour'], ['fog', 'Sea of fog'], ['blue', 'Blue hour']];
const REFINE = { rest: 250, samples: 96, slowFirstSample: 400 };
const refine = { on: !window.matchMedia('(pointer: coarse)').matches, session: null, key: '', changed: 0, starting: false, generation: 0, broken: false };

function stillOptions(w, h, samples) {
    const { sun, night } = sunNow();
    const lake = findLakeLevel();
    return { w, h, samples, mirrorElev: lake, ...lookOptions(state.look, { sun, night, baseElev: renderer.terrain.base }) };
}

function viewKey() {
    return [camera.target.join(), camera.distance, camera.yaw, camera.pitch, camera.fov, state.hour, state.look, canvas.width, canvas.height, state.params.seed].join('|');
}

function findLakeLevel() {
    if (!state.city) return null;
    const N = state.domain.w;
    const m = camera.matrices(canvas.width / canvas.height);
    const levels = [];
    for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
        const far = transform(m.inverse, [(col - 2) * 0.4, -0.8 + row * 0.35, 1, 1]);
        const d = [far[0] / far[3] - m.eye[0], far[1] / far[3] - m.eye[1], far[2] / far[3] - m.eye[2]];
        const length = Math.hypot(...d);
        for (let t = 50; t < 40000; t += 50) {
            const x = m.eye[0] + d[0] / length * t, y = m.eye[1] + d[1] / length * t, z = m.eye[2] + d[2] / length * t;
            const i = Math.floor(x / CELL + N / 2), j = Math.floor(z / CELL + N / 2);
            if (i < 0 || j < 0 || i >= N || j >= N) continue;
            const k = j * N + i;
            if (y > state.city.bed[k] - state.lowest) continue;
            if (state.city.water[k]) levels.push(state.city.bed[k]);
            break;
        }
    }
    if (levels.length < 3) return null;
    levels.sort((a, b) => a - b);
    return levels[levels.length >> 1];
}

// Streets drawn sharp around the view for stills: the city ground is 2 to 4 m per pixel, too coarse for a kerb or a lane.
const STREET_PATCH = { size: 4096, farthest: 3500, cache: null };

function strokePath(ctx, scale, trace, width, colour, dash) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, width * scale);
    ctx.setLineDash(dash ? dash.map((v) => v * scale) : []);
    ctx.beginPath();
    trace();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.stroke();
    ctx.restore();
}

function tracePoints(ctx, p) {
    ctx.moveTo(p[0], p[1]);
    for (let q = 2; q < p.length; q += 2) ctx.lineTo(p[q], p[q + 1]);
}

function traceRun(ctx, run) {
    ctx.moveTo(run[0].x, run[0].z);
    for (let k = 1; k < run.length; k++) ctx.lineTo(run[k].x, run[k].z);
}

const ASPHALT = '#3b3b3e';

function paintStreets(ctx, scale, detail) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const each = (level, draw) => { for (const line of detail.lines) if (line.level === level) draw(line); };
    const whole = (level, width, colour, dash) => each(level, (line) => strokePath(ctx, scale, () => tracePoints(ctx, line.points), width, colour, dash));
    whole(ROAD.LOCAL, ROAD_WIDTH[ROAD.LOCAL] + 5, '#8f8d87');
    whole(ROAD.COLLECTOR, ROAD_WIDTH[ROAD.COLLECTOR] + 5, '#8f8d87');
    whole(ROAD.ARTERIAL, ROAD_WIDTH[ROAD.ARTERIAL] + 5, '#8f8d87');
    whole(ROAD.RAIL, ROAD_WIDTH[ROAD.RAIL], '#5c554e');
    whole(ROAD.RAIL, 3.4, '#3a342e', [0.5, 0.7]);
    for (const level of [ROAD.LOCAL, ROAD.COLLECTOR, ROAD.ARTERIAL, ROAD.MOTORWAY]) whole(level, ROAD_WIDTH[level], ASPHALT);
    ctx.lineCap = 'butt';
    for (const level of [ROAD.COLLECTOR, ROAD.ARTERIAL, ROAD.MOTORWAY]) {
        const width = ROAD_WIDTH[level];
        each(level, (line) => {
            for (const run of line.runs ?? []) {
                const trace = () => traceRun(ctx, run);
                // Paired lines from one path: paint a wide stroke, then cover its middle with asphalt.
                strokePath(ctx, scale, trace, width - 1, '#a5a39b');
                strokePath(ctx, scale, trace, width - 1.4, ASPHALT);
                if (level !== ROAD.COLLECTOR) {
                    strokePath(ctx, scale, trace, width * 0.6, '#a5a39b', [3, 6]);
                    strokePath(ctx, scale, trace, width * 0.6 - 0.4, ASPHALT);
                    strokePath(ctx, scale, trace, width * 0.3, '#a5a39b', [3, 6]);
                    strokePath(ctx, scale, trace, width * 0.3 - 0.4, ASPHALT);
                }
                if (level === ROAD.MOTORWAY) strokePath(ctx, scale, trace, 1.6, '#6c6a60');
                else strokePath(ctx, scale, trace, 0.34, '#c9c7bf', level === ROAD.COLLECTOR ? [3, 5] : null);
            }
        });
    }
    for (const c of detail.crossings) {
        strokePath(ctx, scale, () => {
            ctx.moveTo(c.x - c.uz * (c.half - 0.5), c.z + c.ux * (c.half - 0.5));
            ctx.lineTo(c.x + c.uz * (c.half - 0.5), c.z - c.ux * (c.half - 0.5));
        }, 3, '#c9c7bf', [0.55, 0.55]);
    }
    ctx.setLineDash([]);
}

function paintLampPools(lamps, cx, cz, radius) {
    const size = 2048;
    const canvas2d = new OffscreenCanvas(size, size);
    const ctx = canvas2d.getContext('2d', { willReadFrequently: true });
    const scale = size / (radius * 2);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'lighter';
    const reach = 15 * scale;
    for (let k = 0; k < lamps.length; k += 2) {
        const x = (lamps[k] - cx + radius) * scale, y = (lamps[k + 1] - cz + radius) * scale;
        const pool = ctx.createRadialGradient(x, y, 0, x, y, reach);
        pool.addColorStop(0, 'rgba(255, 214, 160, 0.9)');
        pool.addColorStop(0.45, 'rgba(255, 190, 130, 0.3)');
        pool.addColorStop(1, 'rgba(255, 170, 110, 0)');
        ctx.fillStyle = pool;
        ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
    }
    return imageTexture(gl, canvas2d.transferToImageBitmap()).tex;
}

// The rendered ground: the terrain mesh's own triangles, or close-up props hover over slopes and sink into them.
function surfaceAt(x, z) {
    const t = renderer.terrain, cols = t.mesh.count ? Math.round(Math.sqrt(t.mesh.count / 6)) : t.w - 1;
    const u = Math.max(0, Math.min(1, x / t.extent[0] + 0.5)) * cols, v = Math.max(0, Math.min(1, z / t.extent[1] + 0.5)) * cols;
    const i = Math.min(cols - 1, Math.floor(u)), j = Math.min(cols - 1, Math.floor(v));
    const height = (a, b) => {
        const col = Math.min(t.w - 1, Math.floor(a / cols * t.w)), row = Math.min(t.h - 1, Math.floor(b / cols * t.h));
        return state.city.bed[row * t.w + col] - state.lowest;
    };
    const fx = u - i, fz = v - j;
    const h00 = height(i, j), h10 = height(i + 1, j), h01 = height(i, j + 1), h11 = height(i + 1, j + 1);
    return fx + fz < 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

function groundPatchFor() {
    if (!state.city || camera.distance > STREET_PATCH.farthest) return null;
    const radius = Math.max(300, Math.min(1600, camera.distance * 1.6));
    const cache = STREET_PATCH.cache;
    const [cx, cz] = [camera.target[0], camera.target[2]];
    const same = cache && cache.city === state.city && cache.radius === radius && Math.hypot(cache.cx - cx, cache.cz - cz) < radius * 0.25;
    if (same) return cache;
    const canvas2d = new OffscreenCanvas(STREET_PATCH.size, STREET_PATCH.size);
    const ctx = canvas2d.getContext('2d', { willReadFrequently: true });
    const scale = STREET_PATCH.size / (radius * 2);
    ctx.setTransform(scale, 0, 0, scale, (radius - cx) * scale, (radius - cz) * scale);
    const started = performance.now();
    const detail = buildStreetDetail({ roads: state.city.roads, buildings: { buffer: renderer.city.instances, count: renderer.city.count }, surfaceAt, centre: [cx, cz], radius, seed: state.params.seed });
    paintStreets(ctx, scale, detail);
    if (cache) { gl.deleteTexture(cache.tex); gl.deleteBuffer(cache.buffer); }
    if (cache?.pools) gl.deleteTexture(cache.pools);
    const pools = paintLampPools(detail.lamps, cx, cz, radius);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, detail.instances, gl.STATIC_DRAW);
    STREET_PATCH.cache = { city: state.city, radius, cx, cz, tex: imageTexture(gl, canvas2d.transferToImageBitmap()).tex, rect: [cx - radius, cz - radius, cx + radius, cz + radius], pools, buffer, count: detail.count, buildMs: performance.now() - started };
    return STREET_PATCH.cache;
}

// Real mountains and buildings for stills: sharp terrain from site/landmarks, swapped in by name.
const landmarkMeshes = {};
async function loadLandmark(name) {
    if (landmarkMeshes[name]) return landmarkMeshes[name];
    const index = await loadJson('landmarks/index.json');
    const info = index[name];
    const [heightsBuffer, picture] = await Promise.all([fetch(`landmarks/${name}.bin`).then((r) => r.arrayBuffer()), createImageBitmap(await (await fetch(`landmarks/${name}.jpg`)).blob())]);
    const heights = new Float32Array(heightsBuffer);
    const a = worldOf(info.e0, info.n1), b = worldOf(info.e1, info.n0);
    const mesh = renderer.landmarkMesh({ w: info.w, h: info.h, heights, image: imageTexture(gl, picture), rect: [a.x, a.z, b.x - a.x, b.z - a.z] });
    picture.close();
    landmarkMeshes[name] = Object.assign(mesh, { heights, info });
    return landmarkMeshes[name];
}

function worldOf(e, n) {
    const win = state.outerWin, half = win.w * CELL / 2;
    return { x: e - win.x0 - half, z: win.y1 - n - half };
}

function heightOnLandmark(mesh, e, n) {
    const { info, heights } = mesh;
    const col = Math.max(0, Math.min(info.w - 1, Math.round((e - info.e0) / (info.e1 - info.e0) * info.w)));
    const row = Math.max(0, Math.min(info.h - 1, Math.round((info.n1 - n) / (info.n1 - info.n0) * info.h)));
    return heights[row * info.w + col];
}

function highestNear(mesh, e, n, reach) {
    let best = { e, n, y: -Infinity };
    for (let de = -reach; de <= reach; de += 5) for (let dn = -reach; dn <= reach; dn += 5) {
        const y = heightOnLandmark(mesh, e + de, n + dn);
        if (y > best.y) best = { e: e + de, n: n + dn, y };
    }
    return best;
}

function setLandmarkProps(parts) {
    const buffer = new ArrayBuffer(parts.length * 28);
    const f = new Float32Array(buffer), u8 = new Uint8Array(buffer);
    parts.forEach((p, k) => {
        f.set([p.x, p.y, p.z, p.w, p.d, p.h], k * 7);
        u8[k * 28 + 24] = Math.round((((p.yaw ?? 0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2) * 255);
        u8[k * 28 + 25] = p.kind;
        u8[k * 28 + 26] = 120;
    });
    if (window.__mc.landmarkProps) gl.deleteBuffer(window.__mc.landmarkProps.buffer);
    const glBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    window.__mc.landmarkProps = { buffer: glBuffer, count: parts.length };
}

// The Säntis summit station: mast and terraced building. Sizes from photographs, not a survey.
function saentisParts(mesh) {
    const top = highestNear(mesh, 2744171, 1234917, 200);
    const at = worldOf(top.e, top.n), y = top.y - renderer.terrain.base;
    return [
        { x: at.x, y: y - 6, z: at.z, w: 66, d: 28, h: 24, kind: 23, yaw: 0.3 },
        { x: at.x + 6, y: y + 16, z: at.z - 4, w: 36, d: 20, h: 14, kind: 23, yaw: 0.3 },
        { x: at.x, y: y + 24, z: at.z, w: 13, d: 13, h: 60, kind: 23 },
        { x: at.x, y: y + 82, z: at.z, w: 5.5, d: 5.5, h: 30, kind: 23 },
        { x: at.x, y: y + 110, z: at.z, w: 1.6, d: 1.6, h: 32, kind: 23 },
    ];
}

// Schloss Rapperswil: three towers around a triangular court. Plan and heights approximated from photographs.
function rapperswilParts() {
    const c = worldOf(2704193, 1231616), y = surfaceAt(c.x, c.z);
    const part = (dx, dz, w, d, h, kind, yaw = 0.5, up = 0) => ({ x: c.x + dx, y: y + up - 3, z: c.z + dz, w, d, h, kind, yaw });
    return [
        part(0, 0, 56, 30, 19, 21), part(0, 0, 56, 30, 12, 22, 0.5, 22),
        part(-30, 15, 12, 12, 34, 21), part(-30, 15, 12, 12, 11, 22, 0.5, 37),
        part(31, 10, 13, 13, 40, 21), part(31, 10, 13, 13, 12, 22, 0.5, 43),
        part(4, -26, 14, 14, 44, 21), part(4, -26, 14, 14, 13, 22, 0.5, 47),
    ];
}

async function prepareLandmarks(names) {
    const parts = [];
    for (const name of names) {
        const mesh = await loadLandmark(name);
        if (name === 'alpstein') parts.push(...saentisParts(mesh));
    }
    if (state.clearing) parts.push(...rapperswilParts());
    setLandmarkProps(parts);
}

function refineAllowed() {
    return refine.on && !refine.broken && !state.still && state.city && state.layer === 'none' && state.grow >= 1 && state.growFrom === null && !camera.anim && $('picker').hidden && !state.photographing;
}

function stopRefine() {
    refine.generation++;
    refine.session?.dispose();
    refine.session = null;
}

// True while the frame on screen comes from the refinement, so the live render must not paint over it.
function refineStep(now) {
    const key = viewKey();
    if (key !== refine.key || !refineAllowed()) {
        refine.key = key;
        refine.changed = now;
        if (refine.session || refine.starting) stopRefine();
        refine.starting = false;
        return false;
    }
    if (refine.session?.prepared) {
        const session = refine.session;
        if (session.frames >= REFINE.samples) return true;
        const t0 = performance.now();
        session.sample();
        session.present();
        // readPixels forces the wait that finish() may skip.
        if (session.frames === 2) {
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
            if (performance.now() - t0 > REFINE.slowFirstSample) { refine.broken = true; stopRefine(); console.warn('Refine switched off: this GPU needs too long per sample.'); return false; }
        }
        return true;
    }
    if (!refine.starting && now - refine.changed > REFINE.rest) {
        refine.starting = true;
        const generation = ++refine.generation;
        startRefine(generation).catch((error) => { refine.broken = true; console.error(error); });
    }
    return false;
}

async function startRefine(generation) {
    const { createSession, lookOptions: looks } = await import('./beauty.js');
    lookOptions = looks;
    if (generation !== refine.generation) return;
    const session = createSession(window.__mc, stillOptions(canvas.width, canvas.height, REFINE.samples));
    await session.prepare();
    if (generation !== refine.generation) { session.dispose(); return; }
    refine.session = session;
    refine.starting = false;
}
let lookOptions = () => ({});

function setLook(id) {
    state.look = id;
    for (const b of $('looks').children) b.setAttribute('aria-pressed', String(b.dataset.look === id));
}

function buildStillControls() {
    state.look = 'time';
    for (const [id, label] of LOOKS) {
        const b = document.createElement('button');
        b.className = 'pill';
        b.textContent = label;
        b.dataset.look = id;
        b.addEventListener('click', () => setLook(id));
        $('looks').append(b);
    }
    setLook('time');
    syncRefineButton();
    $('refine').addEventListener('click', () => { refine.on = !refine.on; refine.broken = false; syncRefineButton(); });
    $('photo').addEventListener('click', () => takePhoto().catch(photoFailed));
    if (!gl.getExtension('EXT_float_blend')) {
        refine.broken = true;
        $('photo').disabled = true;
        $('refine').disabled = true;
        $('photo').title = 'This GPU cannot average float frames (EXT_float_blend).';
    }
}

function syncRefineButton() { $('refine').setAttribute('aria-pressed', String(refine.on)); }

function photoFailed(error) {
    console.error(error);
    state.photographing = false;
    $('photo').disabled = false;
    $('photo').textContent = 'Photo failed';
    $('photo').title = String(error.message ?? error);
}

async function takePhoto() {
    if (state.photographing || !state.city) return;
    state.photographing = true;
    stopRefine();
    const button = $('photo');
    button.disabled = true;
    button.title = '';
    button.textContent = 'Loading horizon';
    const module = await import('./beauty.js');
    lookOptions = module.lookOptions;
    await ensureHqOuter();
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const long = Math.min(coarse ? 1600 : 3200, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const scale = long / Math.max(canvas.width, canvas.height);
    const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale);
    const place = $('cityName').textContent;
    const timer = setInterval(() => { button.textContent = `Rendering ${Math.round((window.__mc.beautyProgress ?? 0) * 100)} %`; }, 200);
    window.__mc.beautyProgress = 0;
    const result = await module.renderStill(window.__mc, { ...stillOptions(w, h, coarse ? 48 : 128), credit: 'Toy, not a planning model. Buildings, clouds and snow invented. Terrain, imagery: © swisstopo' });
    clearInterval(timer);
    const link = document.createElement('a');
    link.href = result.url;
    link.download = `${place.replace(/[^\p{L}\p{N}]+/gu, '-')}_${state.look}_seed${state.params.seed}.png`;
    link.click();
    window.__mc.lastPhoto = { name: link.download, w, h, ms: result.ms, error: result.error };
    button.textContent = 'Photo';
    button.disabled = false;
    state.photographing = false;
}

let lastFrame = performance.now();
const frameTimes = [];
function frame(now) {
    requestAnimationFrame(frame);
    if (!renderer.terrain || window.__mc.paused) return;
    frameTimes.push(now - lastFrame);
    if (frameTimes.length > 240) frameTimes.shift();
    lastFrame = now;
    resize();
    camera.update(now);
    state.clock = now / 1000;
    if (state.growFrom !== null) {
        state.grow = Math.min(1, (now - state.growFrom) / 10000);
        if (state.grow >= 1) state.growFrom = null;
        syncView();
    }
    if (refineStep(now)) { placeLabels(camera.matrices(canvas.width / canvas.height).viewProj); return; }
    const { sun, night } = sunNow();
    const m = renderer.render(camera, canvas.width, canvas.height, { sun, night, lit: litShare(state.hour), grow: state.grow, clock: state.clock, fogK: 1 / 120000 }, terrainField);
    placeLabels(m.viewProj);
}

// ---------- Boot ----------
window.__mc = {
    ready: false, state, camera, renderer, terrainField, stats: null,
    fps() { const t = frameTimes.slice().sort((a, b) => a - b); return { medianMs: t[t.length >> 1], p95: t[Math.floor(t.length * 0.95)], ...renderer.stats }; },
    gl,
    landmarkMeshes, worldOf,
    async beauty(options) {
        this.paused = true;
        await ensureHqOuter();
        await prepareLandmarks(options.landmarks ?? []);
        const { renderStill } = await import('./beauty.js');
        return renderStill(this, options);
    },
    refine, setLook, takePhoto, findLakeLevel, groundPatchFor,
    groundAt(x, z) {
        const N = state.domain.w;
        const i = Math.max(0, Math.min(N - 1, Math.floor(x / CELL + N / 2))), j = Math.max(0, Math.min(N - 1, Math.floor(z / CELL + N / 2)));
        return state.city.bed[j * N + i] - state.lowest;
    },
    view(o) { Object.assign(camera, o); camera.anim = null; state.growFrom = null; state.grow = o.grow ?? 1; if (o.hour !== undefined) { state.hour = o.hour; syncView(); } followGround(); },
};

async function boot() {
    buildPanel();
    buildStillControls();
    installInput();
    state.national = new NationalStore(await loadJson('nat/index.json'));
    state.names = (await loadJson('nat/names.json')).places;
    await initPicker();
    setLayer('none');
    requestAnimationFrame(frame);
    window.__mc.booted = true;
    if (readHash()) {
        syncPanel(true);
        syncView();
        $('picker').hidden = true;
        await build(!state.still);
    }
}

boot().catch((error) => {
    console.error(error);
    setLoader(`Could not start: ${error.message}`, 0);
});
