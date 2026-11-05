// Top-down raster of a generated city for eyeballing: writes a PPM, converted to PNG by the caller.
import { writeFileSync } from 'node:fs';
import { loadWindow } from './load_window.mjs';
import { generate } from '../site/js/gen/generate.js';
const [e, n, size, json, out, zoom] = [+process.argv[2], +process.argv[3], +process.argv[4], process.argv[5], process.argv[6], process.argv[7]];
const w = await loadWindow(e, n, size);
const c = generate(w, JSON.parse(json));
const S = 2000, ext = size * w.cell, Z = +(zoom ?? 1), px = (x) => Math.floor((x + ext / (2 * Z)) / (ext / Z) * S);
const img = new Uint8Array(S * S * 3);
const put = (x, y, r, g, b) => { if (x >= 0 && y >= 0 && x < S && y < S) { const o = (y * S + x) * 3; img[o] = r; img[o + 1] = g; img[o + 2] = b; } };
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const X = (x + .5) / S * ext / Z - ext / (2 * Z), Z2 = (y + .5) / S * ext / Z - ext / (2 * Z);
    const i = Math.floor(X / w.cell + size / 2), j = Math.floor(Z2 / w.cell + size / 2), k = j * size + i;
    const v = c.water[k] ? [60, 110, 170] : c.urban[k] ? [228, 224, 214] : w.cover[k] === 2 ? [150, 180, 140] : [205, 215, 190];
    const sh = Math.max(.6, 1 - Math.abs(c.bed[k + 1] - c.bed[k]) * .03);
    put(x, y, v[0] * sh, v[1] * sh, v[2] * sh);
}
const col = { 0: [220, 80, 40], 1: [235, 150, 60], 2: [150, 150, 150], 3: [190, 190, 190], 4: [70, 70, 70] };
for (const l of c.roads) { const p = l.points; for (let q = 2; q < p.length; q += 2) { const n2 = Math.max(1, Math.ceil(Math.hypot(p[q] - p[q - 2], p[q + 1] - p[q - 1]) / (ext / Z / S))); for (let s = 0; s <= n2; s++) put(px(p[q - 2] + (p[q] - p[q - 2]) * s / n2), px(p[q - 1] + (p[q + 1] - p[q - 1]) * s / n2), ...col[l.level]); } }
const f = new Float32Array(c.buildings), u = new Uint8Array(c.buildings);
const kc = [[170, 90, 70], [60, 70, 170], [100, 100, 110], [200, 30, 150], [120, 150, 60], [50, 50, 50], [255, 0, 0], [255, 0, 0]];
for (let b = 0; b < c.count; b++) {
    const X = f[b * 7], Y = f[b * 7 + 2], W = f[b * 7 + 3], D = f[b * 7 + 4], yaw = u[b * 28 + 24] / 255 * 2 * Math.PI, kind = u[b * 28 + 25], C = Math.cos(yaw), Sn = Math.sin(yaw);
    const stepPx = ext / Z / S * .7;
    for (let a = -W / 2; a <= W / 2; a += stepPx) for (let d = -D / 2; d <= D / 2; d += stepPx) put(px(X + a * C + d * Sn), px(Y - a * Sn + d * C), ...kc[kind]);
}
for (const l of c.metro.lines) { const r = parseInt(l.colour.slice(1, 3), 16), g = parseInt(l.colour.slice(3, 5), 16), b = parseInt(l.colour.slice(5), 16); for (const q of l.points) for (let d = -1; d <= 1; d++) put(px(q.x) + d, px(q.z), r, g, b); }
writeFileSync(out, Buffer.concat([Buffer.from(`P6 ${S} ${S} 255\n`), Buffer.from(img)]));
console.log(c.centres.map((x) => x.name ?? '?').join(', '));
console.log(Object.entries(c.stats).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : v}`).join(' '));
