// Rank real places by how much is built around them today: buildings within 1.2 km. swissNAMES ranks barely separate towns from hamlets.
export function rankPlaces(places, settlementCells, N, cell = 25) {
    const mesh = Math.ceil(1200 / cell);
    const side = Math.ceil(N / mesh) + 1;
    const counts = new Int32Array(side * side);
    for (let k = 0; k < settlementCells.length; k += 2) {
        const i = settlementCells[k], j = settlementCells[k + 1];
        if (i >= 0 && j >= 0 && i < N && j < N) counts[Math.floor(j / mesh) * side + Math.floor(i / mesh)]++;
    }
    for (const p of places) {
        const a = Math.floor(p.i / mesh), b = Math.floor(p.j / mesh);
        let sum = 0;
        for (let y = Math.max(b - 1, 0); y <= Math.min(b + 1, side - 1); y++) for (let x = Math.max(a - 1, 0); x <= Math.min(a + 1, side - 1); x++) {
            sum += counts[y * side + x] * (x === a && y === b ? 1 : 0.35);
        }
        p.rank = sum;
    }
    return places;
}
