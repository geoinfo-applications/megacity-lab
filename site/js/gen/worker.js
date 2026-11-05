// Generation worker: terrain and params in, a city and its painted textures out.
import { generate } from './generate.js';
import { paintGround } from './paint.js';

self.onmessage = ({ data }) => {
    const { input, params, token } = data;
    try {
        const t0 = performance.now();
        const report = (message, fraction) => self.postMessage({ type: 'progress', token, message, fraction });
        const city = generate(input, params, report);
        report('Painting the streets', 0.94);
        const { ground, glow } = paintGround(city, input.N, input.cell);
        const roads = city.roads.map((r) => ({ level: r.level, points: r.points, real: !!r.real }));
        const out = {
            type: 'done', token, ms: performance.now() - t0, params: city.params, stats: city.stats, centres: city.centres, metro: city.metro,
            bed: city.bed, water: city.water, urban: city.urban, forest: city.forest, roads, buildings: city.buildings, count: city.count, chunks: city.chunks,
            growthRadius: city.growthRadius, ground, glow, homes: city.homes, jobs: city.jobs, load: city.commute.load, loadM: city.commute.M, loadSize: city.commute.size,
            intensity: city.intensity,
        };
        self.postMessage(out, [out.bed.buffer, out.water.buffer, out.urban.buffer, out.forest.buffer, out.buildings, out.ground, out.glow, out.homes.buffer, out.jobs.buffer, out.load.buffer, out.intensity.buffer]);
    } catch (error) {
        self.postMessage({ type: 'error', token, message: error.message, stack: error.stack });
    }
};
