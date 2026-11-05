// Node loader for a national window: terrain, cover, real roads and rail, names. Same grid and vectors the page uses.
import { readFileSync, existsSync } from 'node:fs';
import { parseGrey8 } from '../site/js/data.js';
const NAT = new URL('../site/nat/', import.meta.url).pathname, COV = new URL('../site/cover/', import.meta.url).pathname;
const ix = JSON.parse(readFileSync(NAT + 'index.json'));
function dem(buf, n) {
    return parseGrey8(buf, n, 2 * n).then((rows) => {
        const q = new Uint16Array(n * n);
        for (let k = 0; k < n * n; k++) q[k] = rows[k] | (rows[k + n * n] << 8);
        const out = new Float32Array(n * n);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const i = y * n + x; let v = q[i];
            if (x > 0) v += q[i - 1];
            if (y > 0) v += q[i - n];
            if (x > 0 && y > 0) v -= q[i - n - 1];
            q[i] = v & 0xffff; out[i] = q[i] / 10;
        }
        return out;
    });
}
import { rankPlaces } from '../site/js/gen/places.js';
export async function loadWindow(e, n, size) {
    const cell = ix.tile / ix.cells, left = Math.round((e - ix.e0) / cell - size / 2), top = Math.round((ix.n0 - n) / cell - size / 2);
    const bed = new Float32Array(size * size).fill(NaN), cover = new Uint8Array(size * size);
    const main = [], rail = [], settlement = [];
    const x0 = ix.e0 + left * cell, y1 = ix.n0 - top * cell, half = size * cell / 2;
    for (let r = Math.floor(top / ix.cells); r <= Math.floor((top + size - 1) / ix.cells); r++) for (let c = Math.floor(left / ix.cells); c <= Math.floor((left + size - 1) / ix.cells); c++) {
        const key = `${c}_${r}`;
        if (!ix.tiles[key]) continue;
        const d = await dem(new Uint8Array(readFileSync(`${NAT}dem_${key}.dem.png`)), ix.cells);
        const cov = existsSync(`${COV}cover_${key}.png`) ? await parseGrey8(new Uint8Array(readFileSync(`${COV}cover_${key}.png`)), ix.cells, ix.cells) : null;
        const ox = c * ix.cells - left, oy = r * ix.cells - top;
        for (let y = Math.max(0, oy); y < Math.min(size, oy + ix.cells); y++) for (let x = Math.max(0, ox); x < Math.min(size, ox + ix.cells); x++) {
            bed[y * size + x] = d[(y - oy) * ix.cells + x - ox];
            if (cov) cover[y * size + x] = cov[(y - oy) * ix.cells + x - ox];
        }
        if (ix.tiles[key].infra) {
            const t = JSON.parse(readFileSync(`${NAT}infra_${key}.json`));
            const e0 = ix.e0 + c * ix.tile, n0 = ix.n0 - (r + 1) * ix.tile;
            const conv = (l) => l.flatMap(([a, b]) => [e0 + a - x0 - half, y1 - (n0 + b) - half]);
            for (const m of t.main) main.push({ motorway: m.motorway, points: conv(m.c) });
            for (const m of t.rail) rail.push({ points: conv(m.c) });
            for (let k = 0; k < t.b.length; k += 2) settlement.push(Math.floor((e0 + t.b[k] - x0) / cell), Math.floor((y1 - (n0 + t.b[k + 1])) / cell));
        }
    }
    let low = Infinity; for (const v of bed) if (v < low) low = v;
    for (let k = 0; k < bed.length; k++) if (Number.isNaN(bed[k])) bed[k] = low;
    const names = JSON.parse(readFileSync(NAT + 'names.json')).places;
    const places = names.filter((p) => p[3] === 'place').map((p) => ({ name: p[0], rank: p[4], i: Math.floor((p[1] - x0) / cell), j: Math.floor((y1 - p[2]) / cell) })).filter((p) => p.i >= 0 && p.j >= 0 && p.i < size && p.j < size);
    rankPlaces(places, settlement, size);
    return { N: size, cell, bed, cover, main, rail, places, x0, y1 };
}
