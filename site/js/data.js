// Loading the shipped swisstopo data: .dem.png height grids, imagery, and national tiles.

// Height grid: grey PNG of 2h rows (low bytes, then high bytes) of a 2D-predicted uint16 at 0.1 m.
// Parsed directly so no canvas colour management can touch the bytes.
export async function loadDem(url, meta) {
    const raw = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
    const view = new DataView(raw.buffer);
    const idat = [];
    for (let p = 8; p < raw.length;) {
        const len = view.getUint32(p);
        const kind = String.fromCharCode(raw[p + 4], raw[p + 5], raw[p + 6], raw[p + 7]);
        if (kind === 'IDAT') idat.push(raw.subarray(p + 8, p + 8 + len));
        p += 12 + len;
    }
    const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
    const rows = new Uint8Array(await new Response(stream).arrayBuffer());
    const { w, h } = meta;
    const n = w * h;
    const q = new Uint16Array(n);
    for (let r = 0; r < h; r++) {
        const lo = r * (w + 1) + 1;
        const hi = (r + h) * (w + 1) + 1;
        for (let x = 0; x < w; x++) q[r * w + x] = rows[lo + x] | (rows[hi + x] << 8);
    }
    const out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            let v = q[i];
            if (x > 0) v += q[i - 1];
            if (y > 0) v += q[i - w];
            if (x > 0 && y > 0) v -= q[i - w - 1];
            q[i] = v & 0xffff;
            out[i] = q[i] / 10;
        }
    }
    return out;
}

// Grey PNG with filter 0 on every row (tools/recode_cover.py): bytes, row 0 = north.
export async function parseGrey8(raw, w, h) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const idat = [];
    for (let p = 8; p < raw.length;) {
        const len = view.getUint32(p);
        if (String.fromCharCode(raw[p + 4], raw[p + 5], raw[p + 6], raw[p + 7]) === 'IDAT') idat.push(raw.subarray(p + 8, p + 8 + len));
        p += 12 + len;
    }
    const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
    const rows = new Uint8Array(await new Response(stream).arrayBuffer());
    const out = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) out.set(rows.subarray(r * (w + 1) + 1, (r + 1) * (w + 1)), r * w);
    return out;
}

// Bytes received across all running downloads, for the loader.
export const progress = { loaded: 0, total: 0, listener: null };

async function fetchOk(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !progress.listener) return res;
    progress.total += total;
    const reader = res.body.getReader();
    const stream = new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            progress.loaded += value.byteLength;
            progress.listener?.(progress);
            controller.enqueue(value);
        },
    });
    return new Response(stream, { headers: res.headers });
}

export async function loadJson(url) {
    return (await fetchOk(url)).json();
}

export async function loadImage(url) {
    const blob = await (await fetchOk(url)).blob();
    return createImageBitmap(blob);
}

// National 25 m tiles. index: { e0, n0, tile, cells, cols, rows, tiles: { "c_r": { img: bool } } }
export class NationalStore {
    constructor(index) {
        this.index = index;
        this.cache = new Map();
    }

    async tile(c, r) {
        const key = `${c}_${r}`;
        if (!this.index.tiles[key]) return null;
        if (!this.cache.has(key)) {
            const info = this.index.tiles[key];
            const n = this.index.cells;
            this.cache.set(key, Promise.all([
                loadDem(`nat/dem_${key}.dem.png`, { w: n, h: n }),
                info.img ? loadImage(`nat/img_${key}.jpg`) : Promise.resolve(null),
                info.infra ? loadJson(`nat/infra_${key}.json`).catch(() => null) : Promise.resolve(null),
                fetch(`cover/cover_${key}.png`).then(async (res) => (res.ok ? parseGrey8(new Uint8Array(await res.arrayBuffer()), n, n) : null)).catch(() => null),
            ]).then(([dem, img, infra, cover]) => ({ dem, img, infra, cover })).catch((error) => {
                // A failed download must not stay cached as a rejected promise.
                this.cache.delete(key);
                throw error;
            }));
            // Oldest out: a tile holds a 1024² bitmap and two grids, and clicks across the country add up.
            while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
        }
        return this.cache.get(key);
    }

    // Assemble a size x size cell window centred on (e, n). Returns bed + an imagery canvas at 1 px per cell.
    async window(e, n, size) {
        const ix = this.index;
        const cell = ix.tile / ix.cells;
        const left = Math.round((e - ix.e0) / cell - size / 2);
        const top = Math.round((ix.n0 - n) / cell - size / 2);
        const bed = new Float32Array(size * size).fill(NaN);
        const cover = new Uint8Array(size * size);
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#6b6f66';
        ctx.fillRect(0, 0, size, size);
        let anyImage = false;
        const infra = { main: [], roads: [], rail: [], buildings: [], buildingPoints: [] };
        const c0 = Math.floor(left / ix.cells), c1 = Math.floor((left + size - 1) / ix.cells);
        const r0 = Math.floor(top / ix.cells), r1 = Math.floor((top + size - 1) / ix.cells);
        const jobs = [];
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) jobs.push(this.tile(c, r).then((t) => ({ t, c, r })));
        for (const { t, c, r } of await Promise.all(jobs)) {
            if (!t) continue;
            const ox = c * ix.cells - left, oy = r * ix.cells - top;
            for (let y = Math.max(0, oy); y < Math.min(size, oy + ix.cells); y++) {
                const src = (y - oy) * ix.cells;
                for (let x = Math.max(0, ox); x < Math.min(size, ox + ix.cells); x++) {
                    bed[y * size + x] = t.dem[src + x - ox];
                    if (t.cover) cover[y * size + x] = t.cover[src + x - ox];
                }
            }
            if (t.img) {
                ctx.drawImage(t.img, ox, oy);
                anyImage = true;
            }
            if (t.infra) {
                // Tile vectors are metres from the tile's south-west corner.
                const e0 = ix.e0 + c * ix.tile, n0 = ix.n0 - (r + 1) * ix.tile;
                const abs = (line) => line.map(([x, y]) => [e0 + x, n0 + y]);
                for (const m of t.infra.main) infra.main.push({ motorway: m.motorway, c: abs(m.c) });
                for (const l of t.infra.rail) infra.rail.push({ c: abs(l.c) });
                const b = t.infra.b;
                for (let k = 0; k < b.length; k += 2) infra.buildingPoints.push([e0 + b[k], n0 + b[k + 1]]);
            }
        }
        let fill = Infinity;
        for (const v of bed) if (v < fill) fill = v;
        for (let i = 0; i < bed.length; i++) if (Number.isNaN(bed[i])) bed[i] = Number.isFinite(fill) ? fill : 0;
        return {
            bed, cover, w: size, h: size, cell,
            x0: ix.e0 + left * cell, y1: ix.n0 - top * cell,
            image: anyImage ? canvas.transferToImageBitmap() : null,
            infra: infra.main.length || infra.rail.length || infra.buildingPoints.length ? infra : null,
        };
    }
}
