// Thin WebGL2 helpers: programs, float textures, framebuffers, a fullscreen triangle.

export function createContext(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU cannot render to float textures (EXT_color_buffer_float).');
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_float_blend');
    return gl;
}

const VERSION = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';

function compile(gl, type, source, name) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, VERSION + source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        const numbered = (VERSION + source).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        console.error(name + '\n' + log + '\n' + numbered);
        throw new Error(`Shader ${name} failed: ${log}`);
    }
    return shader;
}

export function program(gl, vertexSource, fragmentSource, name = 'program') {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertexSource, name + '.vert'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragmentSource, name + '.frag'));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link ${name} failed: ${gl.getProgramInfoLog(p)}`);
    const uniforms = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(p, i);
        uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    return { p, u: uniforms, name };
}

// Sets uniforms by inferring the call from the JS value; textures are { tex, unit } pairs.
export function use(gl, prog, values = {}) {
    gl.useProgram(prog.p);
    for (const [key, value] of Object.entries(values)) {
        const loc = prog.u[key];
        if (loc === undefined || loc === null) continue;
        if (value && value.tex !== undefined) {
            gl.activeTexture(gl.TEXTURE0 + value.unit);
            gl.bindTexture(gl.TEXTURE_2D, value.tex);
            gl.uniform1i(loc, value.unit);
        } else if (typeof value === 'number') {
            gl.uniform1f(loc, value);
        } else if (typeof value === 'boolean') {
            gl.uniform1i(loc, value ? 1 : 0);
        } else if (value.int !== undefined) {
            gl.uniform1i(loc, value.int);
        } else if (value.length === 2) gl.uniform2fv(loc, value);
        else if (value.length === 3) gl.uniform3fv(loc, value);
        else if (value.length === 4) gl.uniform4fv(loc, value);
        else if (value.length === 16) gl.uniformMatrix4fv(loc, false, value);
    }
}

const FORMATS = {
    rgba32f: ['RGBA32F', 'RGBA', 'FLOAT'],
    rg32f: ['RG32F', 'RG', 'FLOAT'],
    r32f: ['R32F', 'RED', 'FLOAT'],
    rgba16f: ['RGBA16F', 'RGBA', 'HALF_FLOAT'],
    rgba8: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE'],
    rgb8: ['RGB8', 'RGB', 'UNSIGNED_BYTE'],
    r8: ['R8', 'RED', 'UNSIGNED_BYTE'],
};

export function texture(gl, w, h, format, data = null, filter = 'nearest') {
    const [internal, fmt, type] = FORMATS[format].map((k) => gl[k]);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, fmt, type, data);
    const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, w, h, format };
}

export function imageTexture(gl, source) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return { tex, w: source.width, h: source.height };
}

export function framebuffer(gl, textures) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    const attachments = textures.map((t, i) => {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0);
        return gl.COLOR_ATTACHMENT0 + i;
    });
    gl.drawBuffers(attachments);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}, context lost: ${gl.isContextLost()}, gl error: ${gl.getError()}, formats: ${textures.map((t) => `${t.format} ${t.w}x${t.h}`).join(', ')}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, w: textures[0].w, h: textures[0].h };
}

// One oversized triangle covering clip space; attribute 0.
export function fullscreen(gl) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return () => {
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
}

export const FULLSCREEN_VS = `
in vec2 aPos;
out vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;
