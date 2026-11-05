// Grid helpers shared by the generator.

// mulberry32: small, seedable, same stream in the browser and in node.
export function rng(seed) {
    let a = (seed * 2654435761) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Value noise fbm in 0..1, by summing bilinearly upsampled random lattices.
export function fbm(N, octaves, baseCells, random) {
    const out = new Float32Array(N * N);
    let amplitude = 1, total = 0, spacing = baseCells;
    for (let o = 0; o < octaves && spacing >= 2; o++) {
        const m = Math.ceil(N / spacing) + 2;
        const lattice = new Float32Array(m * m);
        for (let k = 0; k < lattice.length; k++) lattice[k] = random();
        for (let j = 0; j < N; j++) {
            const fy = j / spacing, y0 = Math.floor(fy);
            let ty = fy - y0;
            ty = ty * ty * (3 - 2 * ty);
            for (let i = 0; i < N; i++) {
                const fx = i / spacing, x0 = Math.floor(fx);
                let tx = fx - x0;
                tx = tx * tx * (3 - 2 * tx);
                const a = lattice[y0 * m + x0], b = lattice[y0 * m + x0 + 1], c = lattice[(y0 + 1) * m + x0], d = lattice[(y0 + 1) * m + x0 + 1];
                out[j * N + i] += amplitude * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
            }
        }
        total += amplitude;
        amplitude *= 0.5;
        spacing = Math.floor(spacing / 2);
    }
    for (let k = 0; k < out.length; k++) out[k] /= total;
    return out;
}

export function boxBlur(field, N, radius) {
    const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
    const width = 2 * radius + 1;
    for (let j = 0; j < N; j++) {
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += field[j * N + Math.min(Math.max(i, 0), N - 1)];
        for (let i = 0; i < N; i++) {
            tmp[j * N + i] = sum / width;
            sum += field[j * N + Math.min(i + radius + 1, N - 1)] - field[j * N + Math.max(i - radius, 0)];
        }
    }
    for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = -radius; j <= radius; j++) sum += tmp[Math.min(Math.max(j, 0), N - 1) * N + i];
        for (let j = 0; j < N; j++) {
            out[j * N + i] = sum / width;
            sum += tmp[Math.min(j + radius + 1, N - 1) * N + i] - tmp[Math.max(j - radius, 0) * N + i];
        }
    }
    return out;
}

// Distance in metres to the nearest set cell; two-pass 3-4 chamfer. Empty mask gives a large number everywhere.
export function chamfer(mask, N, cell) {
    const out = new Float32Array(N * N).fill(1e9);
    for (let k = 0; k < N * N; k++) if (mask[k]) out[k] = 0;
    const a = cell, b = cell * Math.SQRT2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i;
        let v = out[k];
        if (i > 0 && out[k - 1] + a < v) v = out[k - 1] + a;
        if (j > 0) {
            if (out[k - N] + a < v) v = out[k - N] + a;
            if (i > 0 && out[k - N - 1] + b < v) v = out[k - N - 1] + b;
            if (i < N - 1 && out[k - N + 1] + b < v) v = out[k - N + 1] + b;
        }
        out[k] = v;
    }
    for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
        const k = j * N + i;
        let v = out[k];
        if (i < N - 1 && out[k + 1] + a < v) v = out[k + 1] + a;
        if (j < N - 1) {
            if (out[k + N] + a < v) v = out[k + N] + a;
            if (i < N - 1 && out[k + N + 1] + b < v) v = out[k + N + 1] + b;
            if (i > 0 && out[k + N - 1] + b < v) v = out[k + N - 1] + b;
        }
        out[k] = v;
    }
    return out;
}

// 4-connected components by union-find. labels[k] = component id, sizes[id] = cells; label 0 = background.
export function labelComponents(mask, W, H = W) {
    const labels = new Int32Array(W * H);
    const parent = [0];
    const find = (x) => {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    };
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!mask[k]) continue;
        const left = i > 0 ? labels[k - 1] : 0, up = j > 0 ? labels[k - W] : 0;
        if (left && up) {
            const a = find(left), b = find(up);
            labels[k] = Math.min(a, b);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        } else if (left || up) labels[k] = left || up;
        else { labels[k] = parent.length; parent.push(parent.length); }
    }
    const remap = new Int32Array(parent.length);
    let next = 0;
    for (let x = 1; x < parent.length; x++) if (find(x) === x) remap[x] = ++next;
    const sizes = new Int32Array(next + 1);
    for (let k = 0; k < W * H; k++) {
        if (!labels[k]) continue;
        const id = remap[find(labels[k])];
        labels[k] = id;
        sizes[id]++;
    }
    return { labels, sizes, count: next };
}
