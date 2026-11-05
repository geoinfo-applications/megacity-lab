// Terrain heights as a float texture for the vertex shaders. Height sits in the green channel.
import { texture } from './gl.js';

export class TerrainField {
    constructor(gl) {
        this.gl = gl;
        this.height = null;
    }

    load(width, height, bed) {
        const texels = new Float32Array(width * height * 4);
        for (let i = 0; i < bed.length; i++) texels[4 * i + 1] = bed[i];
        if (this.height) this.gl.deleteTexture(this.height.tex);
        this.height = texture(this.gl, width, height, 'rgba32f', texels);
    }
}
