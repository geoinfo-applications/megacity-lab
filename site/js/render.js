// Forward renderer: sky, outer context terrain, the 25 m block, instanced buildings, shadow map.
// World: X east, Y up, Z south, metres, origin at the block centre. Y = elevation - base.
import { program, use, texture, fullscreen, FULLSCREEN_VS } from './gl.js';
import { lookAt, multiply } from './camera.js';

// Shared by the live and the stills renderer. Kinds as in gen/buildings.js.
export const FACADE = `
struct Facade { vec3 albedo; float glass; float pane; float cover; vec2 id; float tone; };
float facadeHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec3 facadeLinear(vec3 c) { return pow(c, vec3(2.2)); }
float leafNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(fract(sin(dot(i, vec3(12.7, 78.2, 37.7))) * 43758.5), fract(sin(dot(i + vec3(1, 0, 0), vec3(12.7, 78.2, 37.7))) * 43758.5), f.x);
    float b = mix(fract(sin(dot(i + vec3(0, 1, 0), vec3(12.7, 78.2, 37.7))) * 43758.5), fract(sin(dot(i + vec3(1, 1, 0), vec3(12.7, 78.2, 37.7))) * 43758.5), f.x);
    float c = mix(fract(sin(dot(i + vec3(0, 0, 1), vec3(12.7, 78.2, 37.7))) * 43758.5), fract(sin(dot(i + vec3(1, 0, 1), vec3(12.7, 78.2, 37.7))) * 43758.5), f.x);
    float d = mix(fract(sin(dot(i + vec3(0, 1, 1), vec3(12.7, 78.2, 37.7))) * 43758.5), fract(sin(dot(i + vec3(1, 1, 1), vec3(12.7, 78.2, 37.7))) * 43758.5), f.x);
    return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
// A figure from one box: body and head as two ellipsoids, the rest discarded. Returns 0 miss, 1 legs, 2 torso, 3 head.
float personShape(vec3 world, vec3 eye, vec3 base, vec3 size, out vec3 normal) {
    vec3 d = normalize(world - eye);
    float height = size.y, best = 1e9, part = 0.0;
    vec3 centres[3];
    vec3 radii[3];
    centres[0] = vec3(0.0, height * 0.27, 0.0); radii[0] = vec3(0.16, height * 0.29, 0.13);
    centres[1] = vec3(0.0, height * 0.63, 0.0); radii[1] = vec3(0.23, height * 0.21, 0.15);
    centres[2] = vec3(0.0, height * 0.92, 0.0); radii[2] = vec3(0.11, 0.13, 0.11);
    for (int i = 0; i < 3; i++) {
        vec3 o = (eye - base - centres[i]) / radii[i], q = d / radii[i];
        float a = dot(q, q), b = dot(o, q), h = b * b - a * (dot(o, o) - 1.0);
        if (h < 0.0) continue;
        float t = (-b - sqrt(h)) / a;
        if (t < best) { best = t; part = float(i) + 1.0; normal = normalize((o + q * t) / radii[i]); }
    }
    return part;
}
// A tree from one box: the ray meets an ellipsoid crown or a trunk inside it, the rest of the box is discarded.
// Returns 0 for a miss, 1 for leaves, 2 for bark. leaf is the light and dark of the foliage at the hit.
float treeShape(vec3 world, vec3 eye, vec3 base, vec3 size, out vec3 normal, out float leaf) {
    vec3 radii = vec3(size.x * 0.5, size.y * 0.40, size.z * 0.5);
    vec3 centre = base + vec3(0.0, size.y * 0.59, 0.0);
    vec3 d = normalize(world - eye);
    vec3 o = (eye - centre) / radii, q = d / radii;
    float a = dot(q, q), b = dot(o, q);
    for (int shell = 0; shell < 3; shell++) {
        float r = 0.86 + 0.14 * float(shell) / 2.0;
        float h = b * b - a * (dot(o, o) - r * r);
        if (h < 0.0) continue;
        vec3 hit = o + q * ((-b - sqrt(h)) / a);
        float clump = leafNoise(hit * 3.1 + base * 0.13);
        if (shell < 2 && clump < 0.46 + 0.14 * float(shell)) continue;
        float fine = leafNoise(hit * 11.0 + base.zxy * 0.17);
        vec3 bump = vec3(leafNoise(hit * 6.0 + 7.1), leafNoise(hit * 6.0 + 19.3), leafNoise(hit * 6.0 + 31.7)) - 0.5;
        normal = normalize(hit / radii + bump * 1.7 / radii);
        leaf = clump * 0.4 + fine * 0.3 + leafNoise(hit * 34.0 + base * 0.31) * 0.3;
        return 1.0;
    }
    vec2 toAxis = eye.xz - base.xz, planar = d.xz;
    float along = -dot(toAxis, planar) / max(dot(planar, planar), 1e-5);
    vec3 nearest = eye + d * along;
    float reach = length(nearest.xz - base.xz);
    if (reach < size.x * 0.055 && nearest.y < centre.y && nearest.y > base.y) {
        normal = normalize(vec3(nearest.x - base.x, 0.0, nearest.z - base.z) + 1e-3);
        leaf = 0.0;
        return 2.0;
    }
    return 0.0;
}
Facade wallFacade(float kind, float seed, vec3 local, vec3 size, vec3 normalL, vec3 base) {
    bool wide = abs(normalL.x) < 0.5;
    float width = wide ? size.x : size.z;
    float along = (wide ? local.x : local.z) + width * 0.5;
    float y = local.y;
    bool towerLike = kind > 2.5 && kind < 3.5 || kind > 5.5 && kind < 6.5;
    bool slab = kind > 0.5 && kind < 1.5;
    bool shed = kind > 3.5 && kind < 4.5;
    float style = floor(fract(seed * 17.31) * 4.0);
    float floorH = towerLike ? 3.9 : (shed ? 6.0 : 2.9);
    float colW = 3.2;
    if (kind < 0.5 || kind > 6.5) colW = 3.4;
    else if (slab) colW = 3.6;
    else if (towerLike) colW = style < 0.5 ? 1.6 : (style > 2.5 ? 1.9 : 3.2);
    else if (kind > 1.5 && kind < 2.5) colW = 2.8 + fract(seed * 5.7);
    vec2 grid = vec2(along / colW, y / floorH);
    vec2 id = floor(grid);
    vec2 f = fract(grid);
    vec2 fw = fwidth(grid);
    float detail = 1.0 - smoothstep(0.3, 0.75, max(fw.x, fw.y));
    float pane = 0.0, cover = 0.0;
    vec3 wall = base;
    float fin = 0.0;
    if (slab) {
        if (abs(normalL.x) > 0.5) {
            float stair = 1.0 - smoothstep(1.0, 1.3, abs(along - width * 0.5));
            pane = stair * smoothstep(0.35, 0.4, f.y) * (1.0 - smoothstep(0.65, 0.7, f.y));
            cover = 0.03;
        } else {
            float bay = fract(along / (colW * 3.0));
            float party = smoothstep(0.0, 0.03, bay) * (1.0 - smoothstep(0.97, 1.0, bay));
            pane = smoothstep(0.34, 0.38, f.y) * (1.0 - smoothstep(0.86, 0.9, f.y)) * party;
            pane *= smoothstep(0.05, 0.1, f.x) * (1.0 - smoothstep(0.9, 0.95, f.x));
            cover = 0.34;
            float edge = 1.0 - smoothstep(0.1, 0.14, f.y);
            float rail = smoothstep(0.1, 0.14, f.y) * (1.0 - smoothstep(0.32, 0.36, f.y));
            wall = mix(mix(base * 0.72, base, party), base * 1.12, edge);
            wall = mix(wall, base * 0.86, rail * 0.8 * detail);
        }
    } else if (towerLike) {
        if (style < 0.5) {
            pane = smoothstep(0.03, 0.07, f.x) * (1.0 - smoothstep(0.93, 0.97, f.x)) * smoothstep(0.08, 0.12, f.y) * (1.0 - smoothstep(0.92, 0.96, f.y));
            cover = 0.88;
        } else if (style < 1.5) {
            pane = smoothstep(0.30, 0.34, f.y) * (1.0 - smoothstep(0.92, 0.96, f.y)) * smoothstep(0.015, 0.03, f.x);
            cover = 0.6;
        } else if (style < 2.5) {
            pane = smoothstep(0.2, 0.25, f.x) * (1.0 - smoothstep(0.75, 0.8, f.x)) * smoothstep(0.24, 0.3, f.y) * (1.0 - smoothstep(0.84, 0.9, f.y));
            cover = 0.33;
        } else {
            fin = 1.0 - smoothstep(0.18, 0.24, f.x);
            pane = smoothstep(0.24, 0.3, f.x) * (1.0 - smoothstep(0.95, 1.0, f.x)) * smoothstep(0.12, 0.16, f.y);
            cover = 0.62;
            wall = mix(base, base * 1.18, fin);
        }
        float period = 10.0 + floor(fract(seed * 7.77) * 14.0);
        if (mod(id.y, period) < 1.0 && y > floorH * 3.0) { pane = 0.0; cover *= 0.5; wall = base * 0.55; }
        if (y < floorH * 1.4) { pane = smoothstep(0.03, 0.07, f.x) * (1.0 - smoothstep(0.93, 0.97, f.x)); cover = 0.85; }
    } else if (shed) {
        wall = base * (0.93 + 0.1 * sin(along * 5.0) * detail);
        pane = (1.0 - smoothstep(0.08, 0.1, abs(y / size.y - 0.8)));
        cover = 0.14;
    } else {
        float sill = smoothstep(0.26, 0.3, f.y) * (1.0 - smoothstep(0.78, 0.82, f.y));
        pane = smoothstep(0.2, 0.26, f.x) * (1.0 - smoothstep(0.74, 0.8, f.x)) * sill;
        cover = kind < 0.5 || kind > 6.5 ? 0.27 : 0.33;
        if (kind > 4.5 && kind < 5.5 || kind > 1.5 && kind < 2.5) {
            float shop = 1.0 - step(floorH * 1.25, y);
            if (shop > 0.5) { pane = smoothstep(0.06, 0.1, f.x) * (1.0 - smoothstep(0.9, 0.94, f.x)) * (1.0 - smoothstep(0.7, 0.74, y / floorH)); cover = 0.65; }
            float awning = (1.0 - smoothstep(0.03, 0.05, abs(y / floorH - 0.84))) * shop;
            wall = mix(wall, mix(vec3(0.46, 0.09, 0.05), vec3(0.08, 0.2, 0.28), step(0.5, facadeHash(vec2(id.x, seed)))), awning * step(0.45, facadeHash(vec2(id.x, seed * 3.0))));
        }
    }
    float streak = facadeHash(vec2(floor(along / 1.7), seed * 11.0));
    float height = clamp(y / max(size.y, 1.0), 0.0, 1.0);
    wall *= 1.0 - 0.2 * streak * streak * mix(0.4, 1.0, height) * detail;
    wall *= 0.86 + 0.28 * facadeHash(vec2(seed * 3.0, 7.0));
    float parapet = smoothstep(size.y - 1.3, size.y - 1.0, y);
    pane *= 1.0 - parapet;
    float tone = facadeHash(id + seed * 37.0);
    vec3 glassColour = facadeLinear(mix(vec3(0.10, 0.14, 0.17), vec3(0.20, 0.26, 0.28), tone));
    if (tone > 0.84) glassColour = mix(glassColour, facadeLinear(vec3(0.58, 0.55, 0.50)), 0.7);
    float mask = mix(cover * (1.0 - parapet), pane, detail);
    Facade r;
    r.albedo = mix(wall, glassColour, mask * (slab ? 0.82 : 0.92));
    r.glass = mask;
    r.pane = pane;
    r.cover = cover;
    r.id = id;
    r.tone = tone;
    return r;
}
`;

const LIGHT = `
uniform vec3 uSun;
uniform float uNight;     // 0 day, 1 full night
uniform vec3 uEye;
uniform float uFogK;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 skyColour(vec3 d) {
    float up = clamp(d.y, -0.05, 1.0);
    vec3 dayZenith = vec3(0.16, 0.34, 0.66), dayHorizon = vec3(0.72, 0.80, 0.90);
    vec3 nightZenith = vec3(0.003, 0.005, 0.014), nightHorizon = vec3(0.022, 0.022, 0.040);
    float t = pow(1.0 - up, 3.5);
    vec3 day = mix(dayZenith, dayHorizon, t);
    vec3 night = mix(nightZenith, nightHorizon, t);
    vec3 c = mix(day, night, uNight);
    // Low sun: warm band towards the sun's azimuth.
    float dusk = (1.0 - smoothstep(0.02, 0.30, uSun.y)) * smoothstep(-0.22, 0.0, uSun.y);
    float toward = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSun.x, 0.0, uSun.z))), 0.0);
    c += vec3(1.0, 0.42, 0.16) * dusk * pow(toward, 3.0) * t * 0.7 * (1.0 - uNight * 0.92);
    return c;
}
vec3 fogged(vec3 c, vec3 world) {
    vec3 v = world - uEye;
    float d = length(v);
    float f = 1.0 - exp(-d * uFogK);
    vec3 dir = v / max(d, 1.0);
    vec3 fogC = skyColour(vec3(dir.x, 0.02, dir.z));
    return mix(c, fogC, f);
}
vec3 sunlight() { return mix(vec3(1.0, 0.95, 0.88) * 2.1, vec3(0.0), uNight) * mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(0.02, 0.35, uSun.y)); }
vec3 ambient(float up) {
    vec3 day = mix(vec3(0.34, 0.33, 0.32), vec3(0.58, 0.68, 0.88), up);
    vec3 night = mix(vec3(0.010), vec3(0.022, 0.028, 0.055), up);
    return mix(day, night, uNight);
}
`;

const SHADOW = `
uniform highp sampler2DShadow uShadowMap;
uniform mat4 uLight;
float shadowAt(vec3 world, float slopeBias) {
    vec4 p = uLight * vec4(world, 1.0);
    vec3 q = p.xyz * 0.5 + 0.5;
    if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0 || q.z > 1.0) return 1.0;
    q.z -= slopeBias;
    float s = 0.0;
    vec2 t = vec2(1.0 / 4096.0);
    s += texture(uShadowMap, q + vec3(-t.x, -t.y, 0.0));
    s += texture(uShadowMap, q + vec3(t.x, -t.y, 0.0));
    s += texture(uShadowMap, q + vec3(-t.x, t.y, 0.0));
    s += texture(uShadowMap, q + vec3(t.x, t.y, 0.0));
    return s * 0.25;
}
`;

const SKY_FS = LIGHT + `
in vec2 vUv;
uniform mat4 uInverse;
out vec4 outColor;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
    vec4 far = uInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 d = normalize(far.xyz / far.w - uEye);
    vec3 c = skyColour(d);
    float a = max(dot(d, uSun), 0.0);
    c += sunlight() * (pow(a, 1800.0) * 6.0 + pow(a, 60.0) * 0.08);
    if (uNight > 0.3 && d.y > 0.0) {
        vec3 cell = floor(d * 420.0);
        vec3 inCell = fract(d * 420.0) - 0.5;
        float h = hash(cell);
        c += vec3(0.8, 0.85, 1.0) * step(0.9985, h) * (1.0 - smoothstep(0.05, 0.35, length(inCell))) * uNight * smoothstep(0.02, 0.25, d.y) * 0.5;
    }
    outColor = vec4(pow(aces(c), vec3(1.0 / 2.2)), 1.0);
}`;

export const TERRAIN_COMMON = `
uniform sampler2D uC;
uniform vec2 uExtent;
uniform float uBase;
float bedAt(vec2 uv) { return textureLod(uC, uv, 0.0).y; }
`;

const TERRAIN_VS = TERRAIN_COMMON + `
in vec2 aPos;
uniform mat4 uViewProj;
out vec2 vUv;
out vec3 vWorld;
void main() {
    vUv = aPos;
    vec3 w = vec3((aPos.x - 0.5) * uExtent.x, bedAt(aPos) - uBase, (aPos.y - 0.5) * uExtent.y);
    vWorld = w;
    gl_Position = uViewProj * vec4(w, 1.0);
}`;

const TERRAIN_FS = LIGHT + SHADOW + TERRAIN_COMMON + `
uniform sampler2D uImage;
uniform sampler2D uCover;   // r water, g forest (1 px per cell)
uniform sampler2D uGround;  // city ground, a = coverage
uniform sampler2D uGlow;    // night emission
uniform sampler2D uGrowth;  // arrival time per coarse cell
uniform sampler2D uOverlay;
uniform int uHasCity;
uniform int uHasOverlay;
uniform float uGrow;
uniform vec2 uSize;
uniform float uClock;
in vec2 vUv;
in vec3 vWorld;
out vec4 outColor;
float nz(vec2 p) { return fract(sin(dot(floor(p), vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(nz(i), nz(i + vec2(1, 0)), f.x), mix(nz(i + vec2(0, 1)), nz(i + vec2(1, 1)), f.x), f.y);
}
void main() {
    vec2 e = 1.0 / uSize;
    vec2 cell = uExtent * e;
    float l = bedAt(vUv - vec2(e.x, 0.0)), r = bedAt(vUv + vec2(e.x, 0.0)), u = bedAt(vUv - vec2(0.0, e.y)), d = bedAt(vUv + vec2(0.0, e.y));
    vec3 n = normalize(vec3(-(r - l) / (2.0 * cell.x), 1.0, -(d - u) / (2.0 * cell.y)));
    vec3 view = normalize(uEye - vWorld);
    vec4 cover = texture(uCover, vUv);
    vec3 albedo = texture(uImage, vUv).rgb;
    float built = 0.0;
    vec3 glow = vec3(0.0);
    if (uHasCity == 1) {
        float arrival = texture(uGrowth, vUv).r;
        vec2 near = vWorld.xz;
        float front = smoothstep(0.0, 0.02, uGrow - arrival - (vnoise(near / 180.0) - 0.5) * 0.015);
        vec4 ground = texture(uGround, vUv);
        built = ground.a * front;
        albedo = mix(albedo, ground.rgb * 0.62, built);
        glow = texture(uGlow, vUv).rgb * front * uNight;
    }
    float water = smoothstep(0.35, 0.65, cover.r) * (1.0 - built);
    vec3 c;
    float shade = shadowAt(vWorld, 0.0009);
    float lambert = max(dot(n, uSun), 0.0);
    c = albedo * (sunlight() * lambert * shade * 0.72 + ambient(0.55 + 0.45 * n.y));
    if (water > 0.0) {
        float ripple = vnoise(vWorld.xz / 9.0 + uClock * 0.4) + vnoise(vWorld.zx / 23.0 - uClock * 0.25);
        vec3 wn = normalize(vec3((ripple - 1.0) * 0.05, 1.0, (vnoise(vWorld.xz / 13.0) - 0.5) * 0.08));
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(view, wn), 0.0), 5.0);
        vec3 refl = skyColour(reflect(-view, wn));
        vec3 body = vec3(0.010, 0.040, 0.060);
        vec3 wc = body * (ambient(1.0) + sunlight() * 0.25 * shade) + refl * fres;
        wc += sunlight() * pow(max(dot(reflect(-uSun, wn), view), 0.0), 220.0) * 1.5 * shade;
        c = mix(c, wc, water);
    }
    c += glow * 1.4;
    c = fogged(c, vWorld);
    if (uHasOverlay == 1) {
        vec4 o = texture(uOverlay, vUv);
        c = mix(c, o.rgb, o.a);
    }
    outColor = vec4(pow(aces(c), vec3(1.0 / 2.2)), 1.0);
}`;

const OUTER_VS = `
in vec2 aPos;
uniform sampler2D uHeight;
uniform mat4 uViewProj;
uniform vec4 uRect;   // world x0, z0, width, depth
uniform float uBase;
out vec2 vUv;
out vec3 vWorld;
void main() {
    vUv = aPos;
    float h = textureLod(uHeight, aPos, 0.0).r;
    vec3 w = vec3(uRect.x + aPos.x * uRect.z, h - uBase, uRect.y + aPos.y * uRect.w);
    vWorld = w;
    gl_Position = uViewProj * vec4(w, 1.0);
}`;

const OUTER_FS = LIGHT + `
uniform sampler2D uImage;
uniform sampler2D uHeight;
uniform vec2 uCellSize;
uniform vec4 uHole;   // inner block rectangle in world x0, z0, x1, z1
in vec2 vUv;
in vec3 vWorld;
out vec4 outColor;
void main() {
    if (vWorld.x > uHole.x && vWorld.x < uHole.z && vWorld.z > uHole.y && vWorld.z < uHole.w) discard;
    vec2 e = vec2(1.0) / vec2(textureSize(uHeight, 0));
    float dx = textureLod(uHeight, vUv + vec2(e.x, 0.0), 0.0).r - textureLod(uHeight, vUv - vec2(e.x, 0.0), 0.0).r;
    float dz = textureLod(uHeight, vUv + vec2(0.0, e.y), 0.0).r - textureLod(uHeight, vUv - vec2(0.0, e.y), 0.0).r;
    vec3 n = normalize(vec3(-dx / (2.0 * uCellSize.x), 1.0, -dz / (2.0 * uCellSize.y)));
    vec3 albedo = texture(uImage, vUv).rgb;
    vec3 c = albedo * (sunlight() * max(dot(n, uSun), 0.0) * 0.72 + ambient(0.55 + 0.45 * n.y));
    c = fogged(c, vWorld);
    outColor = vec4(pow(aces(c), vec3(1.0 / 2.2)), 1.0);
}`;

// Per instance: aPosI (x, base y, z), aSizeI (width, depth, height), aMetaI (yaw, kind, seed, arrival) as normalised bytes.
export const BUILDING_ATTR = `
in vec3 aVertex;
in vec3 aNormal;
in vec3 aPosI;
in vec3 aSizeI;
in vec4 aMetaI;
uniform float uGrow;
vec3 place(out vec3 local, out vec3 size, out float kindOut, out float seedOut, out vec3 normalW) {
    float yaw = aMetaI.x * 6.2831853;
    float kind = floor(aMetaI.y * 255.0 + 0.5);
    float grown = clamp((uGrow - aMetaI.w) * 14.0, 0.0, 1.0);
    grown = grown * grown * (3.0 - 2.0 * grown);
    float h = aSizeI.z * grown;
    float taper = kind > 21.5 && kind < 22.5 ? 1.0 - 0.97 * aVertex.y : kind > 22.5 ? 1.0 - 0.28 * aVertex.y : kind > 12.5 && kind < 13.5 ? 1.0 - 0.2 * aVertex.y : kind > 7.5 && kind < 8.5 ? 1.0 - 0.75 * aVertex.y : kind > 5.5 && kind < 6.5 ? 1.0 - 0.72 * aVertex.y * aVertex.y : (kind > 2.5 && kind < 3.5 ? 1.0 - 0.10 * aVertex.y * step(0.5, fract(aMetaI.z * 7.0)) : 1.0);
    // Not risen yet: collapse to nothing, or the flat roof pokes through the terrain.
    float exists = step(0.001, grown);
    vec3 p = vec3(aVertex.x * aSizeI.x * taper, aVertex.y * h, aVertex.z * aSizeI.y * taper) * exists;
    local = vec3(aVertex.x * aSizeI.x, aVertex.y * aSizeI.z, aVertex.z * aSizeI.y);
    size = vec3(aSizeI.x, aSizeI.z, aSizeI.y);
    kindOut = kind;
    seedOut = aMetaI.z;
    float c = cos(yaw), s = sin(yaw);
    normalW = vec3(c * aNormal.x + s * aNormal.z, aNormal.y, -s * aNormal.x + c * aNormal.z);
    return aPosI + vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
`;

const BUILDING_VS = BUILDING_ATTR + `
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vLocal;
out vec3 vSize;
out vec3 vNormalW;
out vec3 vNormalL;
flat out vec3 vBase;
flat out float vKind;
flat out float vSeed;
void main() {
    vec3 local, size, nw; float kind, seed;
    vec3 w = place(local, size, kind, seed, nw);
    vBase = aPosI;
    vWorld = w;
    vLocal = local;
    vSize = size;
    vNormalW = nw;
    vNormalL = aNormal;
    vKind = kind;
    vSeed = seed;
    gl_Position = uViewProj * vec4(w, 1.0);
}`;

const BUILDING_FS = LIGHT + SHADOW + FACADE + `
in vec3 vWorld;
in vec3 vLocal;
in vec3 vSize;
in vec3 vNormalW;
in vec3 vNormalL;
flat in vec3 vBase;
flat in float vKind;
flat in float vSeed;
uniform float uLit;      // share of windows lit at this hour
uniform float uClock;
out vec4 outColor;
float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec3 palette(float k, float s) {
    if (k < 0.5) { // villa: brick and pale tile
        vec3 a = mix(vec3(0.46, 0.27, 0.20), vec3(0.66, 0.58, 0.48), step(0.45, s));
        return mix(a, vec3(0.72, 0.70, 0.66), step(0.82, s));
    }
    if (k < 1.5) { // apartment slab: mostly off-white, some cream, peach and pale blue
        vec3 a = mix(vec3(0.82, 0.81, 0.77), vec3(0.76, 0.78, 0.80), fract(s * 3.0));
        return mix(a, fract(s * 11.0) > 0.5 ? vec3(0.84, 0.76, 0.66) : vec3(0.70, 0.78, 0.84), step(0.7, s));
    }
    if (k < 2.5) return mix(vec3(0.54, 0.52, 0.50), vec3(0.34, 0.38, 0.42), s); // mixed use
    if (k > 10.5 || (k > 7.5 && k < 8.5)) return mix(vec3(0.20, 0.34, 0.16), vec3(0.30, 0.42, 0.20), s); // tree
    if (k > 9.5) return vec3(0.76, 0.75, 0.72); // stair core
    if (k > 8.5) return mix(vec3(0.42, 0.43, 0.44), vec3(0.60, 0.60, 0.58), s); // roof plant
    if (k < 3.5 || (k > 5.5 && k < 6.5)) {  // glass and stone
        vec3 g = mix(vec3(0.34, 0.46, 0.54), vec3(0.50, 0.58, 0.62), fract(s * 5.0));
        return mix(g, vec3(0.66, 0.62, 0.56), step(0.72, s));
    }
    if (k < 4.5) return mix(vec3(0.60, 0.60, 0.58), vec3(0.42, 0.50, 0.56), s); // shed
    if (k < 5.5) return mix(vec3(0.40, 0.38, 0.36), vec3(0.52, 0.48, 0.42), s); // podium
    return vec3(0.68, 0.64, 0.58);
}
void main() {
    vec3 n = normalize(vNormalW);
    float leaf = 0.0, treePart = 0.0;
    if (vKind > 10.5 && vKind < 11.5) {
        treePart = treeShape(vWorld, uEye, vBase, vSize, n, leaf);
        if (treePart < 0.5) discard;
    }
    vec3 view = normalize(uEye - vWorld);
    vec3 base = toLinear(palette(vKind, vSeed));
    float lambert = max(dot(n, uSun), 0.0);
    float shade = shadowAt(vWorld, 0.0012);
    vec3 glow = vec3(0.0);
    vec3 albedo = base;
    float gloss = 0.0;
    float y = vLocal.y;
    if (vKind > 10.5) {
        albedo = treePart > 1.5 ? toLinear(vec3(0.27, 0.22, 0.18)) : base * (0.32 + 1.05 * leaf);
    } else if (vKind > 7.5 && vKind < 8.5) {
        albedo = base * (0.75 + 0.5 * h21(floor(vWorld.xz / 2.0) + vSeed));
    } else if (vKind > 8.5 && vKind < 9.5) {
        albedo = base * (0.85 + 0.2 * step(0.5, fract(vLocal.y / 0.9 + vSeed)));
    } else if (vNormalL.y > 0.5) {
        // Roofs: green waterproofing on villas, grey plant elsewhere, a darker rim.
        vec2 q = abs(vLocal.xz) / (vSize.xz * 0.5);
        float rim = smoothstep(0.86, 0.96, max(q.x, q.y));
        vec3 roof = vKind < 0.5 ? mix(vec3(0.32, 0.46, 0.36), vec3(0.50, 0.50, 0.48), step(0.6, fract(vSeed * 13.0))) : vec3(0.42, 0.42, 0.42);
        albedo = mix(toLinear(roof), base * 0.7, rim);
    } else {
        bool core = vKind > 9.5;
        Facade wall = wallFacade(core ? 1.0 : vKind, vSeed, vLocal, vSize, core ? vec3(1.0, 0.0, 0.0) : vNormalL, base);
        albedo = wall.albedo;
        gloss = wall.glass;
        vec2 grid = fwidth(vec2(vLocal.y / 2.9, vLocal.y / 2.9));
        float detail = 1.0 - smoothstep(0.3, 0.75, grid.y);
        float lit = step(1.0 - uLit, wall.tone);
        vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.90, 0.95, 1.0), step(0.72, h21(wall.id * 1.7 + vSeed * 7.0)));
        float bh = h21(vec2(vSeed * 31.0, 2.0));
        float household = 0.15 + 2.6 * bh * bh * bh;
        float towerBoost = vKind > 2.5 && vKind < 3.5 ? 1.5 : 1.0;
        glow = warm * mix(uLit * wall.cover * 0.34 * household * towerBoost, lit * wall.pane * 0.75, detail) * uNight;
        // Ground-floor shops light up, a Seoul street at night is mostly signage.
        if (vKind < 2.5 && y < 3.2) glow += mix(vec3(1.0, 0.45, 0.25), vec3(0.3, 0.8, 1.0), step(0.5, h21(vec2(wall.id.x, vSeed)))) * uNight * 0.8;
    }
    float ao = vNormalL.y > 0.5 ? 1.0 : 0.55 + 0.45 * (1.0 - exp(-y / 7.0));
    vec3 c = albedo * (sunlight() * lambert * shade * 0.62 + ambient(0.5 + 0.5 * n.y) * ao * 0.8);
    if (gloss > 0.0) {
        float fres = 0.14 + 0.86 * pow(1.0 - max(dot(view, n), 0.0), 4.0);
        c = mix(c, skyColour(reflect(-view, n)) * 1.1, fres * 0.7 * gloss);
    }
    // Aviation light on anything tall.
    if (vNormalL.y > 0.5 && vSize.y > 150.0 && vKind < 7.5) {
        float blink = step(0.5, fract(uClock * 0.5 + vSeed));
        glow += vec3(1.0, 0.05, 0.03) * blink * uNight * 8.0 * (1.0 - smoothstep(0.0, 0.3, length(vLocal.xz) / max(vSize.x, 1.0)));
    }
    // Church: the red neon cross that dots a Seoul night, here as a glowing roof.
    if (vKind > 6.5 && vKind < 7.5 && vNormalL.y > 0.5) glow += vec3(1.0, 0.04, 0.05) * uNight * 5.0;
    c += glow;
    c = fogged(c, vWorld);
    outColor = vec4(pow(aces(c), vec3(1.0 / 2.2)), 1.0);
}`;

const SHADOW_VS = BUILDING_ATTR + `
uniform mat4 uLight;
void main() {
    vec3 local, size, nw; float kind, seed;
    vec3 w = place(local, size, kind, seed, nw);
    gl_Position = uLight * vec4(w, 1.0);
}`;

const TERRAIN_SHADOW_VS = TERRAIN_COMMON + `
in vec2 aPos;
uniform mat4 uLight;
void main() {
    vec3 w = vec3((aPos.x - 0.5) * uExtent.x, bedAt(aPos) - uBase, (aPos.y - 0.5) * uExtent.y);
    gl_Position = uLight * vec4(w, 1.0);
}`;

const EMPTY_FS = `void main() {}`;

// Metro trains and cars: small emissive quads whose position comes from a segment and the clock.
const MOVER_VS = `
in vec2 aCorner;
in vec4 aSeg;       // start x, z, end x, z
in vec4 aInfo;      // start y, end y, phase, speed (1/s along the segment)
in vec3 aColour;
uniform mat4 uViewProj;
uniform float uClock;
uniform float uSizeM;
uniform vec3 uEye;
out vec3 vColour;
out vec2 vCorner;
out vec3 vWorld;
void main() {
    float t = fract(aInfo.z + uClock * aInfo.w);
    vec3 a = vec3(aSeg.x, aInfo.x, aSeg.y), b = vec3(aSeg.z, aInfo.y, aSeg.w);
    vec3 p = mix(a, b, t) + vec3(0.0, 3.0, 0.0);
    float scale = uSizeM * sqrt(max(1.0, length(uEye - p) / 500.0));
    vec3 toEye = normalize(uEye - p);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
    vec3 up = cross(toEye, right);
    vWorld = p + (right * aCorner.x + up * aCorner.y) * scale;
    vColour = aColour;
    vCorner = aCorner;
    gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

const MOVER_FS = LIGHT + `
in vec3 vColour;
in vec2 vCorner;
in vec3 vWorld;
uniform float uStrength;
out vec4 outColor;
void main() {
    float r = 1.0 - smoothstep(0.2, 1.0, length(vCorner));
    vec3 c = vColour * r * uStrength;
    float d = length(vWorld - uEye);
    c *= exp(-d * uFogK);
    outColor = vec4(pow(aces(c), vec3(1.0 / 2.2)), r);
}`;

const BRIGHT_FS = `
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 outColor;
void main() {
    vec3 c = vec3(0.0);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) c += texture(uTex, vUv + vec2(x, y) * uStep).rgb;
    c /= 9.0;
    float luma = dot(c, vec3(0.3, 0.6, 0.1));
    outColor = vec4(c * smoothstep(0.72, 0.96, luma), 1.0);
}`;

const BLUR_FS = `
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 outColor;
void main() {
    vec3 c = texture(uTex, vUv).rgb * 0.227;
    c += (texture(uTex, vUv + uStep * 1.38).rgb + texture(uTex, vUv - uStep * 1.38).rgb) * 0.316;
    c += (texture(uTex, vUv + uStep * 3.23).rgb + texture(uTex, vUv - uStep * 3.23).rgb) * 0.070;
    outColor = vec4(c, 1.0);
}`;

const ADD_FS = `
in vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uAmount;
out vec4 outColor;
void main() { outColor = vec4((texture(uA, vUv).rgb * 0.6 + texture(uB, vUv).rgb) * uAmount, 1.0); }`;

const FLOAT = 5126, UBYTE = 5121;
const STRIDE = 28;

function boxMesh(gl) {
    // Five faces, y 0..1, x and z -0.5..0.5, no floor.
    const faces = [
        [[0, 0, 1], [[-.5, 0, .5], [.5, 0, .5], [.5, 1, .5], [-.5, 1, .5]]],
        [[0, 0, -1], [[.5, 0, -.5], [-.5, 0, -.5], [-.5, 1, -.5], [.5, 1, -.5]]],
        [[1, 0, 0], [[.5, 0, .5], [.5, 0, -.5], [.5, 1, -.5], [.5, 1, .5]]],
        [[-1, 0, 0], [[-.5, 0, -.5], [-.5, 0, .5], [-.5, 1, .5], [-.5, 1, -.5]]],
        [[0, 1, 0], [[-.5, 1, .5], [.5, 1, .5], [.5, 1, -.5], [-.5, 1, -.5]]],
    ];
    const v = [];
    for (const [n, q] of faces) for (const k of [0, 1, 2, 0, 2, 3]) v.push(...q[k], ...n);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    return { buffer, count: v.length / 6 };
}

function gridMesh(gl, n) {
    const verts = new Float32Array((n + 1) * (n + 1) * 2);
    let p = 0;
    for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) { verts[p++] = x / n; verts[p++] = y / n; }
    const idx = new Uint32Array(n * n * 6);
    p = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
        idx[p++] = a; idx[p++] = c; idx[p++] = b;
        idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length, buffers: [vb, ib] };
}

function deleteMesh(gl, mesh) {
    if (!mesh) return;
    gl.deleteVertexArray(mesh.vao);
    for (const b of mesh.buffers) gl.deleteBuffer(b);
}

export class Renderer {
    constructor(gl) {
        this.gl = gl;
        this.draw = fullscreen(gl);
        this.sky = program(gl, FULLSCREEN_VS, SKY_FS, 'sky');
        this.terrainProg = program(gl, TERRAIN_VS, TERRAIN_FS, 'terrain');
        this.outerProg = program(gl, OUTER_VS, OUTER_FS, 'outer');
        this.buildingProg = this.buildingProgram(BUILDING_VS, BUILDING_FS, 'building');
        this.shadowProg = this.buildingProgram(SHADOW_VS, EMPTY_FS, 'shadow');
        this.terrainShadowProg = program(gl, TERRAIN_SHADOW_VS, EMPTY_FS, 'terrainShadow');
        this.moverProg = program(gl, MOVER_VS, MOVER_FS, 'mover');
        this.brightProg = program(gl, FULLSCREEN_VS, BRIGHT_FS, 'bright');
        this.blurProg = program(gl, FULLSCREEN_VS, BLUR_FS, 'blur');
        this.addProg = program(gl, FULLSCREEN_VS, ADD_FS, 'add');
        this.bloom = null;
        this.box = boxMesh(gl);
        this.buildingVao = gl.createVertexArray();
        this.instanceBuffer = gl.createBuffer();
        gl.bindVertexArray(this.buildingVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.box.buffer);
        const locVertex = this.buildingLocations.aVertex, locNormal = this.buildingLocations.aNormal;
        gl.enableVertexAttribArray(locVertex);
        gl.vertexAttribPointer(locVertex, 3, FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(locNormal);
        gl.vertexAttribPointer(locNormal, 3, FLOAT, false, 24, 12);
        for (const name of ['aPosI', 'aSizeI', 'aMetaI']) {
            gl.enableVertexAttribArray(this.buildingLocations[name]);
            gl.vertexAttribDivisor(this.buildingLocations[name], 1);
        }
        gl.bindVertexArray(null);
        this.shadowSize = 4096;
        this.shadowTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        this.shadowFb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.shadowKey = '';
        this.city = null;
        this.terrain = null;
        this.outer = null;
        this.movers = [];
        this.lodScale = 1;
        this.stats = { instances: 0, draws: 0, triangles: 0 };
        this.blank = texture(gl, 1, 1, 'rgba8', new Uint8Array([0, 0, 0, 0]));
        this.neverArrives = texture(gl, 1, 1, 'r32f', new Float32Array([2]));
    }

    buildingProgram(vs, fs, name) {
        const prog = program(this.gl, vs, fs, name);
        const gl = this.gl;
        const loc = {};
        for (const a of ['aVertex', 'aNormal', 'aPosI', 'aSizeI', 'aMetaI']) loc[a] = gl.getAttribLocation(prog.p, a);
        if (!this.buildingLocations) {
            this.buildingLocations = loc;
        } else {
            // Both programs must agree: the VAO is shared. Relink the second with the first one's slots.
            for (const [a, l] of Object.entries(this.buildingLocations)) gl.bindAttribLocation(prog.p, l, a);
            gl.linkProgram(prog.p);
            const count = gl.getProgramParameter(prog.p, gl.ACTIVE_UNIFORMS);
            prog.u = {};
            for (let i = 0; i < count; i++) {
                const info = gl.getActiveUniform(prog.p, i);
                prog.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog.p, info.name);
            }
        }
        return prog;
    }

    // domain: { w, h, cell, base, image: texture, cover: texture }, TerrainField supplies uC.
    setTerrain(domain) {
        const gl = this.gl;
        deleteMesh(gl, this.terrain?.mesh);
        deleteMesh(gl, this.terrain?.coarse);
        const stride = domain.w > 1700 ? 2 : 1;
        this.terrain = {
            ...domain,
            mesh: gridMesh(gl, Math.floor((domain.w - 1) / stride)),
            coarse: gridMesh(gl, Math.floor((domain.w - 1) / 4)),
            extent: [domain.w * domain.cell, domain.h * domain.cell],
        };
        this.shadowKey = '';
    }

    // outer: { w, h, heights Float32Array, image texture, rect [x0, z0, width, depth] }
    setOuter(outer) {
        const gl = this.gl;
        if (this.outer) {
            gl.deleteTexture(this.outer.heightTex.tex);
            gl.deleteTexture(this.outer.image.tex);
            deleteMesh(gl, this.outer.mesh);
        }
        this.setOuterHq(null);
        if (!outer) { this.outer = null; return; }
        this.outer = { ...outer, heightTex: texture(gl, outer.w, outer.h, 'r32f', outer.heights, 'linear'), mesh: gridMesh(gl, outer.w - 1) };
    }

    landmarkMesh(info) {
        const gl = this.gl;
        return { ...info, heightTex: texture(gl, info.w, info.h, 'r32f', info.heights, 'linear'), mesh: gridMesh(gl, Math.min(2000, Math.max(info.w, info.h) - 1)) };
    }

    // Per-view instances in the building format, drawn with the building program.
    drawInstances(buffer, count) {
        const gl = this.gl;
        const loc = this.buildingLocations;
        gl.bindVertexArray(this.buildingVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.vertexAttribPointer(loc.aPosI, 3, FLOAT, false, STRIDE, 0);
        gl.vertexAttribPointer(loc.aSizeI, 3, FLOAT, false, STRIDE, 12);
        gl.vertexAttribPointer(loc.aMetaI, 4, UBYTE, true, STRIDE, 24);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, this.box.count, count);
        gl.bindVertexArray(null);
    }

    // Stills only: too many triangles for the live view, so it sits beside the interactive horizon.
    setOuterHq(outer) {
        const gl = this.gl;
        if (this.outerHq) {
            gl.deleteTexture(this.outerHq.heightTex.tex);
            gl.deleteTexture(this.outerHq.image.tex);
            deleteMesh(gl, this.outerHq.mesh);
            deleteMesh(gl, this.outerHq.shadowMesh);
        }
        this.outerHq = outer ? { ...outer, heightTex: texture(gl, outer.w, outer.h, 'r32f', outer.heights, 'linear'), mesh: gridMesh(gl, outer.w - 1), shadowMesh: gridMesh(gl, Math.floor((outer.w - 1) / 3)) } : null;
    }

    // city: { instances: ArrayBuffer of STRIDE bytes each, count, chunks: [{ offset, counts[4], x, z, radius }], ground, glow, growth textures }
    setCity(city) {
        const gl = this.gl;
        if (this.city) for (const t of [this.city.ground, this.city.glow, this.city.growth]) if (t?.tex) gl.deleteTexture(t.tex);
        this.city = city;
        if (city) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, city.instances, gl.STATIC_DRAW);
        }
        this.shadowKey = '';
    }

    setOverlay(tex) {
        if (this.overlay?.tex) this.gl.deleteTexture(this.overlay.tex);
        this.overlay = tex;
    }

    // Movers: Float32Array of 11 floats each (seg 4, info 4, colour 3); kinds keep their own size.
    setMovers(list) {
        const gl = this.gl;
        for (const m of this.movers) { gl.deleteBuffer(m.buffer); gl.deleteVertexArray(m.vao); }
        this.movers = [];
        if (!this.quad) {
            this.quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
        }
        const loc = {};
        for (const a of ['aCorner', 'aSeg', 'aInfo', 'aColour']) loc[a] = gl.getAttribLocation(this.moverProg.p, a);
        for (const { data, size, strength, dayStrength } of list) {
            const vao = gl.createVertexArray();
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
            gl.enableVertexAttribArray(loc.aCorner);
            gl.vertexAttribPointer(loc.aCorner, 2, FLOAT, false, 0, 0);
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
            const stride = 44;
            for (const [name, n, off] of [['aSeg', 4, 0], ['aInfo', 4, 16], ['aColour', 3, 32]]) {
                gl.enableVertexAttribArray(loc[name]);
                gl.vertexAttribPointer(loc[name], n, FLOAT, false, stride, off);
                gl.vertexAttribDivisor(loc[name], 1);
            }
            gl.bindVertexArray(null);
            this.movers.push({ vao, buffer, count: data.length / 11, size, strength, dayStrength: dayStrength ?? 0 });
        }
    }

    // Instances inside a chunk are sorted tallest first, so a far chunk draws a prefix of its list.
    chunkCount(chunk, distance) {
        const d = distance / this.lodScale;
        if (d < 9000) return chunk.counts[0];
        if (d < 26000) return chunk.counts[1];
        if (d < 50000) return chunk.counts[2];
        return chunk.counts[3];
    }

    visibleChunks(planes, eye, center, radius) {
        const out = [];
        for (const chunk of this.city.chunks) {
            const cy = chunk.y;
            let inside = true;
            if (planes) {
                for (const p of planes) {
                    if (p[0] * chunk.x + p[1] * cy + p[2] * chunk.z + p[3] < -chunk.radius) { inside = false; break; }
                }
            }
            if (!inside) continue;
            if (center) {
                if (Math.hypot(chunk.x - center[0], chunk.z - center[2]) > radius + chunk.radius) continue;
            }
            const distance = Math.hypot(chunk.x - eye[0], cy - eye[1], chunk.z - eye[2]);
            const count = this.chunkCount(chunk, distance);
            if (count > 0) out.push({ chunk, count });
        }
        return out;
    }

    drawChunks(list) {
        const gl = this.gl;
        const loc = this.buildingLocations;
        gl.bindVertexArray(this.buildingVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        let instances = 0;
        for (const { chunk, count } of list) {
            const base = chunk.offset * STRIDE;
            gl.vertexAttribPointer(loc.aPosI, 3, FLOAT, false, STRIDE, base);
            gl.vertexAttribPointer(loc.aSizeI, 3, FLOAT, false, STRIDE, base + 12);
            gl.vertexAttribPointer(loc.aMetaI, 4, UBYTE, true, STRIDE, base + 24);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, this.box.count, count);
            instances += count;
        }
        gl.bindVertexArray(null);
        return instances;
    }

    // Night glow: threshold the frame at quarter size, blur twice, add back. A lit city without it looks like cardboard.
    renderBloom(width, height, night) {
        const gl = this.gl;
        const w = Math.max(2, width >> 2), h = Math.max(2, height >> 2), w2 = w >> 1, h2 = h >> 1;
        if (!this.bloom || this.bloom.width !== width || this.bloom.height !== height) {
            if (this.bloom) {
                for (const t of this.bloom.textures) gl.deleteTexture(t.tex);
                for (const fb of this.bloom.fbs) gl.deleteFramebuffer(fb);
            }
            // RGB8 first: the canvas has no alpha, and copying it into RGBA is INVALID_OPERATION.
            const textures = [texture(gl, width, height, 'rgb8', null, 'linear'), texture(gl, w, h, 'rgba8', null, 'linear'), texture(gl, w, h, 'rgba8', null, 'linear'), texture(gl, w2, h2, 'rgba8', null, 'linear'), texture(gl, w2, h2, 'rgba8', null, 'linear')];
            const fbs = textures.map((t) => {
                const fb = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
                return fb;
            });
            this.bloom = { width, height, textures, fbs };
        }
        const b = this.bloom;
        gl.disable(gl.DEPTH_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, b.textures[0].tex);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
        const pass = (prog, target, tw, th, uniforms) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target);
            gl.viewport(0, 0, tw, th);
            use(gl, prog, uniforms);
            this.draw();
        };
        pass(this.brightProg, b.fbs[1], w, h, { uTex: { tex: b.textures[0].tex, unit: 0 }, uStep: [1 / width * 2, 1 / height * 2] });
        pass(this.blurProg, b.fbs[2], w, h, { uTex: { tex: b.textures[1].tex, unit: 0 }, uStep: [1 / w, 0] });
        pass(this.blurProg, b.fbs[1], w, h, { uTex: { tex: b.textures[2].tex, unit: 0 }, uStep: [0, 1 / h] });
        pass(this.blurProg, b.fbs[3], w2, h2, { uTex: { tex: b.textures[1].tex, unit: 0 }, uStep: [1 / w2, 0] });
        pass(this.blurProg, b.fbs[4], w2, h2, { uTex: { tex: b.textures[3].tex, unit: 0 }, uStep: [0, 1 / h2] });
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        use(gl, this.addProg, { uA: { tex: b.textures[1].tex, unit: 0 }, uB: { tex: b.textures[4].tex, unit: 1 }, uAmount: 0.7 * night });
        this.draw();
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
    }

    lightMatrix(camera, sun) {
        const radius = Math.min(Math.max(1500, camera.distance * 1.5), 40000);
        const t = camera.target;
        const eye = [t[0] + sun[0] * radius * 3, t[1] + sun[1] * radius * 3, t[2] + sun[2] * radius * 3];
        const view = lookAt(eye, t, Math.abs(sun[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0]);
        const near = radius * 0.2, far = radius * 6;
        const r = radius;
        const proj = new Float32Array([1 / r, 0, 0, 0, 0, 1 / r, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
        return { matrix: multiply(proj, view), radius };
    }

    renderShadow(camera, sun, terrainField, grow) {
        const gl = this.gl;
        const key = [camera.target.map((v) => Math.round(v / 40)).join(','), Math.round(Math.log(camera.distance) * 8), sun.map((v) => v.toFixed(3)).join(','), grow.toFixed(3)].join('|');
        if (key === this.shadowKey) return;
        this.shadowKey = key;
        this.light = this.lightMatrix(camera, sun);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
        gl.viewport(0, 0, this.shadowSize, this.shadowSize);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2, 4);
        gl.disable(gl.CULL_FACE);
        if (this.terrain) {
            use(gl, this.terrainShadowProg, { uC: { tex: terrainField.height.tex, unit: 0 }, uExtent: this.terrain.extent, uBase: this.terrain.base, uLight: this.light.matrix });
            gl.bindVertexArray(this.terrain.coarse.vao);
            gl.drawElements(gl.TRIANGLES, this.terrain.coarse.count, gl.UNSIGNED_INT, 0);
            gl.bindVertexArray(null);
        }
        if (this.city) {
            use(gl, this.shadowProg, { uLight: this.light.matrix, uGrow: grow });
            this.drawChunks(this.visibleChunks(null, camera.eye(), camera.target, this.light.radius));
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    render(camera, width, height, env, terrainField) {
        const gl = this.gl;
        const m = camera.matrices(width / height);
        const sun = env.sun;
        const grow = env.grow ?? 1;
        const night = env.night;
        const shadowed = night < 0.97;
        if (shadowed) this.renderShadow(camera, sun, terrainField, grow);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const fogK = env.fogK ?? 1 / 90000;
        const light = { uSun: sun, uNight: night, uEye: m.eye, uFogK: fogK };

        gl.disable(gl.DEPTH_TEST);
        use(gl, this.sky, { ...light, uInverse: m.inverse });
        this.draw();
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.frontFace(gl.CCW);

        if (this.outer && this.terrain) {
            const o = this.outer;
            const half = this.terrain.extent[0] / 2;
            use(gl, this.outerProg, {
                ...light, uViewProj: m.viewProj, uHeight: { tex: o.heightTex.tex, unit: 0 }, uImage: { tex: o.image.tex, unit: 1 },
                uRect: o.rect, uBase: this.terrain.base, uCellSize: [o.rect[2] / o.w, o.rect[3] / o.h], uHole: [-half, -half, half, half],
            });
            gl.bindVertexArray(o.mesh.vao);
            gl.drawElements(gl.TRIANGLES, o.mesh.count, gl.UNSIGNED_INT, 0);
            gl.bindVertexArray(null);
        }

        const stats = { instances: 0, draws: 0, triangles: 0 };
        if (this.terrain) {
            const t = this.terrain;
            const city = this.city;
            use(gl, this.terrainProg, {
                ...light, uViewProj: m.viewProj, uC: { tex: terrainField.height.tex, unit: 0 }, uExtent: t.extent, uBase: t.base, uSize: [t.w, t.h],
                uImage: { tex: t.image.tex, unit: 1 }, uCover: { tex: t.cover.tex, unit: 2 },
                uGround: { tex: city?.ground?.tex ?? this.blank.tex, unit: 3 }, uGlow: { tex: city?.glow?.tex ?? this.blank.tex, unit: 4 },
                uGrowth: { tex: city?.growth?.tex ?? this.neverArrives.tex, unit: 5 }, uOverlay: { tex: this.overlay?.tex ?? this.blank.tex, unit: 7 },
                uHasCity: { int: city?.ground ? 1 : 0 }, uHasOverlay: { int: this.overlay ? 1 : 0 }, uGrow: grow, uClock: env.clock ?? 0,
            });
            gl.uniformMatrix4fv(this.terrainProg.u.uLight, false, this.light?.matrix ?? new Float32Array(16));
            gl.activeTexture(gl.TEXTURE6);
            gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
            gl.uniform1i(this.terrainProg.u.uShadowMap, 6);
            gl.bindVertexArray(t.mesh.vao);
            gl.drawElements(gl.TRIANGLES, t.mesh.count, gl.UNSIGNED_INT, 0);
            gl.bindVertexArray(null);
            stats.triangles += t.mesh.count / 3;
            stats.draws++;
        }

        if (this.city) {
            use(gl, this.buildingProg, { ...light, uViewProj: m.viewProj, uGrow: grow, uLit: env.lit ?? 0.5, uClock: env.clock ?? 0 });
            gl.uniformMatrix4fv(this.buildingProg.u.uLight, false, this.light?.matrix ?? new Float32Array(16));
            gl.activeTexture(gl.TEXTURE6);
            gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
            gl.uniform1i(this.buildingProg.u.uShadowMap, 6);
            const list = this.visibleChunks(frustumPlanes(m.viewProj), m.eye);
            stats.instances = this.drawChunks(list);
            stats.draws += list.length;
            stats.triangles += stats.instances * 10;
        }

        if (this.movers.length && grow >= 1) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.depthMask(false);
            gl.disable(gl.CULL_FACE);
            for (const mover of this.movers) {
                const strength = mover.dayStrength + (mover.strength - mover.dayStrength) * night;
                if (strength <= 0.001) continue;
                use(gl, this.moverProg, { ...light, uViewProj: m.viewProj, uClock: env.clock ?? 0, uSizeM: mover.size, uStrength: strength });
                gl.bindVertexArray(mover.vao);
                gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, mover.count);
                gl.bindVertexArray(null);
            }
            gl.depthMask(true);
            gl.disable(gl.BLEND);
        }
        gl.disable(gl.CULL_FACE);
        if (night > 0.15) this.renderBloom(width, height, night);
        this.stats = stats;
        return m;
    }
}

function frustumPlanes(m) {
    const planes = [];
    const row = (i) => [m[i], m[i + 4], m[i + 8], m[i + 12]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    for (const [a, s] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]]) {
        const p = [r3[0] + s * a[0], r3[1] + s * a[1], r3[2] + s * a[2], r3[3] + s * a[3]];
        const len = Math.hypot(p[0], p[1], p[2]);
        planes.push(p.map((v) => v / len));
    }
    return planes;
}
