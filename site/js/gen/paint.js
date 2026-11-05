// Ground and night-glow textures for a generated city. Needs OffscreenCanvas, so it runs in the worker, not in node.
import { chamfer, boxBlur } from './fields.js';
import { ROAD, ROAD_WIDTH } from './roads.js';
import { KIND } from './buildings.js';

const TYPE_COLOUR = { 1: [84, 116, 70], 2: [116, 110, 104], 3: [130, 127, 122], 4: [122, 124, 106], 5: [148, 146, 142], 6: [126, 122, 114] };
const PAVEMENT = [112, 110, 106];
const EMBANKMENT = [104, 132, 84];
const ROOF = { [KIND.VILLA]: [124, 138, 120], [KIND.APARTMENT]: [164, 164, 160], [KIND.MIXED]: [142, 142, 140], [KIND.TOWER]: [112, 117, 122], [KIND.SHED]: [160, 168, 172], [KIND.PODIUM]: [128, 126, 122], [KIND.SPIRE]: [96, 100, 104], [KIND.CHURCH]: [176, 160, 144], [KIND.TREE]: [70, 100, 60] };

// Stamp a rotated rectangle into an RGBA raster, per pixel. A canvas path of 250 000 rectangles takes minutes to fill.
function stampRect(data, size, metresPerPx, half, b, colour, shrink) {
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw), hw = b.w / 2 * shrink, hd = b.d / 2 * shrink;
    const reach = Math.hypot(hw, hd);
    const x0 = Math.max(0, Math.floor((b.x - reach + half) / metresPerPx)), x1 = Math.min(size - 1, Math.ceil((b.x + reach + half) / metresPerPx));
    const y0 = Math.max(0, Math.floor((b.z - reach + half) / metresPerPx)), y1 = Math.min(size - 1, Math.ceil((b.z + reach + half) / metresPerPx));
    for (let y = y0; y <= y1; y++) {
        const wz = (y + 0.5) * metresPerPx - half - b.z;
        for (let x = x0; x <= x1; x++) {
            const wx = (x + 0.5) * metresPerPx - half - b.x;
            if (Math.abs(wx * c - wz * s) > hw || Math.abs(wx * s + wz * c) > hd) continue;
            const o = (y * size + x) * 4;
            data[o] = colour[0];
            data[o + 1] = colour[1];
            data[o + 2] = colour[2];
            data[o + 3] = 255;
        }
    }
}

export function paintGround(city, N, cell) {
    const M = city.M;
    const fine = new Uint8ClampedArray(M * M * 4);
    const scale = M / N;
    const distWater = chamfer(city.water, N, cell);
    const nearCity = boxBlur(Float32Array.from(city.urban), N, 6);
    let seed = 12345;
    for (let y = 0; y < M; y++) {
        const j = Math.floor(y / scale);
        for (let x = 0; x < M; x++) {
            const i = Math.floor(x / scale);
            const k = j * N + i;
            const type = city.typeRaster[y * M + x];
            let colour = null;
            if (type) colour = TYPE_COLOUR[type];
            else if (city.urban[k]) colour = PAVEMENT;
            else if (!city.water[k] && distWater[k] < 120 && nearCity[k] > 0.04) colour = EMBANKMENT;
            if (!colour) continue;
            seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
            const grain = ((seed >>> 24) - 128) / 128;
            const amount = type === 4 || type === 1 || !type ? 16 : 7;
            const o = (y * M + x) * 4;
            fine[o] = colour[0] + grain * amount;
            fine[o + 1] = colour[1] + grain * amount * 1.1;
            fine[o + 2] = colour[2] + grain * amount * 0.7;
            fine[o + 3] = 255;
        }
    }
    // Roofs under the streets' stroke order does not matter: blocks and streets do not overlap. Far chunks that drop low buildings still read as built.
    const metresPerFine = N * cell / M;
    const half = N * cell / 2;
    for (const b of city.list) if (b.kind !== KIND.TREE && b.kind !== KIND.ROUND_TREE && !b.detail) stampRect(fine, M, metresPerFine, half, b, ROOF[b.kind], 1);
    const S = 8192;
    const ppm = S / (N * cell);
    const fineCanvas = new OffscreenCanvas(M, M);
    fineCanvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(fine, M, M), 0, 0);
    const canvas = new OffscreenCanvas(S, S);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fineCanvas, 0, 0, S, S);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const px = (v) => (v + half) * ppm;
    const strokeLevel = (target, scale, level, colour, width) => {
        target.strokeStyle = colour;
        target.lineWidth = Math.max(0.7, width * scale);
        for (const line of city.roads) {
            if (line.level !== level) continue;
            const p = line.points;
            target.beginPath();
            target.moveTo((p[0] + half) * scale, (p[1] + half) * scale);
            for (let q = 2; q < p.length; q += 2) target.lineTo((p[q] + half) * scale, (p[q + 1] + half) * scale);
            target.stroke();
        }
    };
    strokeLevel(ctx, ppm, ROAD.RAIL, '#5c554e', ROAD_WIDTH[ROAD.RAIL]);
    strokeLevel(ctx, ppm, ROAD.LOCAL, '#4a4a4c', ROAD_WIDTH[ROAD.LOCAL]);
    strokeLevel(ctx, ppm, ROAD.COLLECTOR, '#3e3e42', ROAD_WIDTH[ROAD.COLLECTOR]);
    strokeLevel(ctx, ppm, ROAD.ARTERIAL, '#34343a', ROAD_WIDTH[ROAD.ARTERIAL]);
    strokeLevel(ctx, ppm, ROAD.ARTERIAL, '#6c6a60', 2);
    strokeLevel(ctx, ppm, ROAD.MOTORWAY, '#2c2c32', ROAD_WIDTH[ROAD.MOTORWAY]);
    strokeLevel(ctx, ppm, ROAD.MOTORWAY, '#8c8468', 2.5);

    // Night: a lit carpet for the buildings far LOD drops, then glowing streets.
    const G = 4096;
    const gs = G / (N * cell);
    const lit = new Uint8ClampedArray(G * G * 4);
    for (let k = 3; k < lit.length; k += 4) lit[k] = 255;
    const warm = [136, 104, 66], cool = [92, 90, 80];
    for (const b of city.list) {
        if (b.kind === KIND.VILLA) stampRect(lit, G, 1 / gs, half, b, warm, 0.9);
        else if (b.kind === KIND.APARTMENT || b.kind === KIND.MIXED) stampRect(lit, G, 1 / gs, half, b, cool, 0.9);
    }
    const glowCanvas = new OffscreenCanvas(G, G);
    const gtx = glowCanvas.getContext('2d', { willReadFrequently: true });
    gtx.putImageData(new ImageData(lit, G, G), 0, 0);
    gtx.lineCap = 'round';
    gtx.globalCompositeOperation = 'lighter';
    strokeLevel(gtx, gs, ROAD.LOCAL, '#3a2c1a', 10);
    strokeLevel(gtx, gs, ROAD.COLLECTOR, '#6a4c26', 16);
    strokeLevel(gtx, gs, ROAD.ARTERIAL, '#b07a3a', 26);
    strokeLevel(gtx, gs, ROAD.MOTORWAY, '#d09a50', 32);
    return { ground: canvas.transferToImageBitmap(), glow: glowCanvas.transferToImageBitmap() };
}
