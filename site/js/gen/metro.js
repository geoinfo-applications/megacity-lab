// Metro lines through the centres: one ring through the sub-centres (Seoul's Line 2), then radials. Tunnels, so slopes do not bend them.
export const LINE_COLOURS = ['#0052a4', '#00a84d', '#ef7c1c', '#00a5de', '#996cac', '#cd7c2f', '#747f00', '#e6186c', '#bdb092'];

export function routeMetro({ N, cell, centres, buildable, random, radiusKm, population }) {
    const lines = [];
    const stations = [];
    const reach = Math.min(radiusKm * 1000 * 1.25, N * cell * 0.48);
    const toCell = (x, z) => [Math.floor(x / cell + N / 2), Math.floor(z / cell + N / 2)];
    const c0 = centres[0];
    const x0 = (c0.i + 0.5 - N / 2) * cell, z0 = (c0.j + 0.5 - N / 2) * cell;
    const count = Math.max(2, Math.min(LINE_COLOURS.length, Math.round(population / 1.05e6)));
    const others = centres.slice(1).map((c) => ({ x: (c.i + 0.5 - N / 2) * cell, z: (c.j + 0.5 - N / 2) * cell }));

    // Ring: sub-centres ordered by bearing, filled with points on a wobbling circle so it stays closed.
    const ringRadius = reach * 0.46;
    const ringPoints = [];
    for (let k = 0; k < 10; k++) {
        const a = k / 10 * Math.PI * 2;
        const r = ringRadius * (0.85 + 0.3 * random());
        ringPoints.push({ x: x0 + Math.cos(a) * r, z: z0 + Math.sin(a) * r, a });
    }
    for (const o of others) {
        const a = (Math.atan2(o.z - z0, o.x - x0) + Math.PI * 2) % (Math.PI * 2);
        if (Math.hypot(o.x - x0, o.z - z0) < ringRadius * 1.5) ringPoints.push({ x: o.x, z: o.z, a });
    }
    ringPoints.sort((a, b) => a.a - b.a);
    addLine(smooth([...ringPoints, ringPoints[0]]), true);

    // Radials: a straight-ish line through the primary centre, kinked towards a sub-centre when one lies close to its bearing.
    for (let l = 1; l < count; l++) {
        const bearing = (l - 1) / Math.max(count - 1, 1) * Math.PI + random() * 0.5;
        const half = [];
        for (const side of [-1, 1]) {
            const a = bearing + (side < 0 ? Math.PI : 0);
            let target = null;
            for (const o of others) {
                const diff = Math.atan2(Math.sin(Math.atan2(o.z - z0, o.x - x0) - a), Math.cos(Math.atan2(o.z - z0, o.x - x0) - a));
                if (Math.abs(diff) < 0.5) target = o;
            }
            const end = { x: x0 + Math.cos(a) * reach * (0.75 + 0.25 * random()), z: z0 + Math.sin(a) * reach * (0.75 + 0.25 * random()) };
            const mid = target ?? { x: x0 + Math.cos(a + (random() - 0.5) * 0.5) * reach * 0.5, z: z0 + Math.sin(a + (random() - 0.5) * 0.5) * reach * 0.5 };
            half.push(side < 0 ? [end, mid] : [mid, end]);
        }
        addLine(smooth([...half[0], { x: x0, z: z0 }, ...half[1]]), false);
    }
    return { lines, stations };

    function addLine(points, ring) {
        const clipped = points.filter((q) => Math.abs(q.x) < N * cell * 0.49 && Math.abs(q.z) < N * cell * 0.49);
        if (clipped.length < 2) return;
        const index = lines.length;
        const here = [];
        let run = 0;
        for (let k = 1; k < clipped.length; k++) {
            run += Math.hypot(clipped[k].x - clipped[k - 1].x, clipped[k].z - clipped[k - 1].z);
            if (run < 1150) continue;
            const [i, j] = toCell(clipped[k].x, clipped[k].z);
            if (i < 0 || j < 0 || i >= N || j >= N) continue;
            if (buildable[j * N + i] < 0.2) continue;
            run = 0;
            const known = stations.find((s) => Math.hypot(s.x - clipped[k].x, s.z - clipped[k].z) < 500);
            if (known) { known.lines.push(index); here.push(known); continue; }
            const s = { x: clipped[k].x, z: clipped[k].z, i, j, lines: [index] };
            stations.push(s);
            here.push(s);
        }
        lines.push({ index, colour: LINE_COLOURS[index % LINE_COLOURS.length], ring, points: clipped, stations: here });
    }
}

// Catmull-Rom through the control points, about every 100 m.
function smooth(points) {
    const out = [];
    for (let k = 0; k < points.length - 1; k++) {
        const p0 = points[Math.max(k - 1, 0)], p1 = points[k], p2 = points[k + 1], p3 = points[Math.min(k + 2, points.length - 1)];
        const steps = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / 100));
        for (let s = 0; s < steps; s++) {
            const t = s / steps, t2 = t * t, t3 = t2 * t;
            out.push({
                x: 0.5 * (2 * p1.x + (p2.x - p0.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (3 * p1.x - p0.x - 3 * p2.x + p3.x) * t3),
                z: 0.5 * (2 * p1.z + (p2.z - p0.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (3 * p1.z - p0.z - 3 * p2.z + p3.z) * t3),
            });
        }
    }
    out.push(points[points.length - 1]);
    return out;
}
