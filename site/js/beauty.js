// N frames are averaged. Sun frames jitter the sun inside its disc, sky frames light the scene from one random
// dome direction through a shadow map: together that gives soft shadows and true sky occlusion.
import { program, use, texture, FULLSCREEN_VS } from './gl.js';
import { lookAt, multiply, invert, perspective } from './camera.js';
import { BUILDING_ATTR, TERRAIN_COMMON, FACADE } from './render.js';

const ATMOSPHERE = `
const float PI = 3.14159265;
const float Re = 6371e3, Ra = 6471e3;
const vec3 betaR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const vec3 betaO = vec3(0.9e-6, 2.6e-6, 0.12e-6);
uniform float uBetaM;
uniform float uSunI;
uniform vec3 uSunDir;
uniform float uBaseElev;
vec2 sphere(vec3 o, vec3 d, float r) {
    float b = dot(o, d), c = dot(o, o) - r * r, h = b * b - c;
    if (h < 0.0) return vec2(1e12, -1e12);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
}
vec3 densities(float height) {
    float o = max(0.0, 1.0 - abs(height - 25000.0) / 15000.0);
    return vec3(exp(-height / 8000.0), exp(-height / 1400.0), o);
}
vec3 opticalDepth(vec3 p, vec3 d, int steps) {
    float tMax = sphere(p, d, Ra).y;
    vec3 sum = vec3(0.0);
    float previous = 0.0;
    for (int i = 0; i < steps; i++) {
        float u = (float(i) + 1.0) / float(steps), t = tMax * u * u;
        sum += densities(length(p + d * 0.5 * (previous + t)) - Re) * (t - previous);
        previous = t;
    }
    return sum;
}
vec3 extinction(vec3 od) { return exp(-(betaR * od.x + 1.1 * uBetaM * od.y + betaO * od.z)); }
vec3 scatter(float elevation, vec3 d) {
    vec3 o = vec3(0.0, Re + elevation, 0.0);
    vec2 top = sphere(o, d, Ra);
    float tMax = top.y;
    vec2 ground = sphere(o, d, Re);
    if (ground.x > 0.0) tMax = min(tMax, ground.x);
    float dt = tMax / 16.0;
    vec3 od = vec3(0.0), sumR = vec3(0.0), sumM = vec3(0.0);
    for (int i = 0; i < 16; i++) {
        vec3 p = o + d * (float(i) + 0.5) * dt;
        vec3 dens = densities(length(p) - Re) * dt;
        od += dens;
        if (sphere(p, uSunDir, Re).x > 0.0 && sphere(p, uSunDir, Re).y > 0.0) continue;
        vec3 t = extinction(od + opticalDepth(p, uSunDir, 14));
        sumR += t * dens.x;
        sumM += t * dens.y;
    }
    float mu = dot(d, uSunDir);
    float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
    const float g = 0.78;
    float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    return uSunI * (sumR * betaR * pR + sumM * uBetaM * pM);
}
`;

const CLOUDS = `
uniform highp sampler3D uNoise;
uniform vec4 uCloud;     // base, top (elevation m), cover 0..1, scale m
uniform float uCirrus;
uniform vec2 uWind;
float deckDensity(vec2 q, float size, float cover) {
    float n = texture(uNoise, vec3(q / size, 0.13)).r * 0.56 + texture(uNoise, vec3(q / (size * 0.33), 0.41)).g * 0.27
        + texture(uNoise, vec3(q / (size * 0.11), 0.73)).b * 0.12 + texture(uNoise, vec3(q / (size * 0.04), 0.27)).r * 0.05;
    float threshold = 0.72 - cover * 0.5;
    return smoothstep(threshold, threshold + 0.18, n);
}
`;

const SKY_FS = ATMOSPHERE + CLOUDS + `
in vec2 vUv;
uniform mat4 uInverse;
uniform vec3 uEye;
uniform int uLatLong;
uniform vec3 uMoonDir;
uniform float uStars;
uniform vec3 uNightSky;
uniform float uDiscScale;
uniform float uSkyJit;
uniform float uSkyGain;
uniform vec3 uUnderglow;
uniform vec3 uSkyFill;
out vec4 outColor;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 sunlightAt(float elevation, vec3 dir) {
    vec3 p = vec3(0.0, Re + max(elevation, 0.0), 0.0);
    if (sphere(p, dir, Re).y > 0.0 && sphere(p, dir, Re).x > 0.0) return vec3(0.0);
    return uSunI * extinction(opticalDepth(p, dir, 16));
}
vec3 direction() {
    if (uLatLong == 1) {
        float lon = (vUv.x - 0.5) * 6.2831853, lat = (vUv.y - 0.5) * PI;
        return vec3(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat));
    }
    vec4 far = uInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    return normalize(far.xyz / far.w - uEye);
}
void main() {
    vec3 d = direction();
    float eyeElevation = uEye.y + uBaseElev;
    vec3 sky = scatter(max(eyeElevation, 1.0), vec3(d.x, max(d.y, 0.002), d.z));
    sky += uNightSky * (0.35 + 0.65 * pow(1.0 - max(d.y, 0.0), 3.0));
    sky += uSkyFill * (0.55 + 0.45 * d.y) * smoothstep(-0.14, 0.06, uSunDir.y);
    if (uLatLong == 0) {
        float a = dot(d, uSunDir);
        vec3 sunC = sunlightAt(eyeElevation, uSunDir);
        sky += sunC * smoothstep(cos(0.0062 * uDiscScale), cos(0.0044 * uDiscScale), a) * 900.0;
        sky += sunC * (pow(max(a, 0.0), 700.0) * 0.5 + pow(max(a, 0.0), 90.0) * 0.05);
        if (uStars > 0.0 && d.y > 0.0) {
            vec3 cell = floor(d * 620.0);
            float h = hash(cell);
            float r = length(fract(d * 620.0) - 0.5);
            sky += vec3(0.85, 0.9, 1.0) * step(0.9972, h) * (1.0 - smoothstep(0.05, 0.4, r)) * uStars * smoothstep(0.0, 0.3, d.y) * (0.3 + 3.0 * fract(h * 917.0));
        }
    }
    // Two lit decks: a slab march bands at the grazing angles a portrait horizon lives on, a projected deck does not.
    vec3 c = sky;
    if (uCloud.z > 0.0 && d.y > 0.004) {
        vec3 up = scatter(5000.0, vec3(0.0, 1.0, 0.0));
        for (int deck = 1; deck >= 0; deck--) {
            float height = deck == 1 ? uCloud.y : uCloud.x;
            float size = uCloud.w * (deck == 1 ? 2.3 : 1.0);
            float cover = uCloud.z * (deck == 1 ? 0.8 : 1.0);
            float t = (height - eyeElevation) / d.y;
            if (t <= 0.0 || t > 400000.0) continue;
            vec2 q = vec2(uEye.x, uEye.z) + d.xz * t + uWind + float(deck) * 40000.0;
            float density = deckDensity(q, size, cover);
            if (density <= 0.002) continue;
            vec2 toSun = normalize(uSunDir.xz + 1e-4) * size * 0.05;
            float od = deckDensity(q + toSun, size, cover) + 0.7 * deckDensity(q + toSun * 2.2, size, cover) + 0.5 * deckDensity(q + toSun * 4.0, size, cover);
            float lightT = exp(-1.3 * od);
            float mu = dot(d, uSunDir);
            float forward = 0.0796 * (1.0 - 0.49) / pow(1.0 + 0.49 - 1.4 * mu, 1.5);
            vec3 sunC = sunlightAt(height, uSunDir);
            vec3 li = sunC * (0.075 + forward * 0.9) * (0.25 + 0.75 * lightT) * (1.15 - 0.55 * density) + up * (0.95 - 0.4 * density);
            float air = exp(-t / 75000.0);
            c = mix(c, mix(sky, li + uUnderglow * exp(-t / 26000.0), air), density * 0.96 * smoothstep(0.004, 0.07, d.y));
        }
    }
    if (uCirrus > 0.0 && d.y > 0.01) {
        vec2 q = (d.xz / d.y) * 9000.0 + uWind * 0.5;
        float n = texture(uNoise, vec3(q / vec2(52000.0, 15000.0), 0.3)).r * 0.65 + texture(uNoise, vec3(q / vec2(11000.0, 4000.0), 0.7)).g * 0.35;
        float a = smoothstep(0.52, 0.86, n) * uCirrus * smoothstep(0.04, 0.22, d.y);
        vec3 sunC = sunlightAt(9000.0, uSunDir);
        float mu = dot(d, uSunDir);
        vec3 li = sunC * (0.05 + 0.32 * pow(max(mu, 0.0), 6.0)) + sky * 0.8;
        c = mix(c, li, a * 0.75);
    }
    outColor = vec4(c * uSkyGain, 1.0);
}`;

const LIGHT = `
const float PI = 3.14159265;
uniform vec3 uL;
uniform float uSunFrame;
uniform float uE;
uniform vec3 uEye;
uniform float uBaseElev;
uniform float uClipY;
uniform vec3 uBounce;
uniform float uNight;
uniform sampler2D uEnv;
uniform sampler2D uTrans;
uniform highp sampler3D uNoise;
uniform highp sampler2DShadow uShN;
uniform highp sampler2DShadow uShF;
uniform mat4 uLightN;
uniform mat4 uLightF;
uniform float uNearTexel;
uniform vec4 uCloud;
uniform vec2 uWind;
vec2 latLong(vec3 d) { return vec2(atan(d.x, -d.z) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5); }
vec3 env(vec3 d, float lod) { return textureLod(uEnv, latLong(normalize(vec3(d.x, max(d.y, 0.0), d.z))), lod).rgb; }
vec3 sunAt(float elevation) { return uE * texture(uTrans, vec2(clamp(elevation / 7000.0, 0.0, 1.0), 0.5)).rgb; }
float shadowOf(vec3 w, vec3 n) {
    vec4 p = uLightN * vec4(w + n * uNearTexel * 2.5, 1.0);
    vec3 q = p.xyz * 0.5 + 0.5;
    float s = 1.0;
    if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0 && q.z < 1.0) s = texture(uShN, q);
    vec4 pf = uLightF * vec4(w + uL * 90.0, 1.0);
    vec3 qf = pf.xyz * 0.5 + 0.5;
    if (qf.x > 0.0 && qf.x < 1.0 && qf.y > 0.0 && qf.y < 1.0 && qf.z < 1.0) s *= texture(uShF, qf);
    return s;
}
float cloudShadow(vec3 w) {
    if (uCloud.z <= 0.0 || uSunFrame < 0.5) return 1.0;
    float elevation = w.y + uBaseElev;
    float t = (mix(uCloud.x, uCloud.y, 0.3) - elevation) / max(uL.y, 0.04);
    vec3 q = vec3(w.x + uWind.x, 0.0, w.z + uWind.y) + vec3(uL.x, 0.0, uL.z) * t;
    float n = texture(uNoise, vec3(q.x, mix(uCloud.x, uCloud.y, 0.3), q.z) / (uCloud.w * vec3(1.0, 0.45, 1.0))).r;
    return 1.0 - 0.82 * smoothstep(1.0 - uCloud.z, 1.0 - uCloud.z + 0.20, n * 0.86);
}
vec3 lit(vec3 albedo, vec3 n, vec3 w) {
    float elevation = w.y + uBaseElev;
    float cosine = max(dot(n, uL), 0.0);
    vec3 c = vec3(0.0);
    if (cosine > 0.0) {
        float s = shadowOf(w, n);
        if (uSunFrame > 0.5) c = albedo / PI * sunAt(elevation) * cosine * s * cloudShadow(w);
        else c = albedo * env(uL, 2.0) * 2.0 * cosine * s;
    }
    c *= 2.0;
    if (uSunFrame < 0.5) c += 2.0 * albedo * uBounce * (0.5 - 0.5 * n.y);
    return c;
}
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

const GROUND_SHADE = `
uniform vec4 uLandmarks[2];
uniform float uIsLandmark;
bool inLandmark(vec2 p) {
    for (int i = 0; i < 2; i++) if (p.x > uLandmarks[i].x && p.y > uLandmarks[i].y && p.x < uLandmarks[i].z && p.y < uLandmarks[i].w) return true;
    return false;
}
uniform float uSnow;
uniform float uGradeLand;
uniform float uMirrorOn;
uniform float uMirrorY;
uniform sampler2D uMirror;
uniform vec2 uResolution;
uniform vec2 uWave;
vec3 crag(vec3 n, vec3 w) {
    float steep = smoothstep(0.97, 0.78, n.y);
    if (steep <= 0.0) return n;
    vec2 g = vec2(0.0);
    for (int i = 0; i < 3; i++) {
        float size = i == 0 ? 410.0 : (i == 1 ? 130.0 : 46.0);
        vec3 q = vec3(w.x, w.y * 0.35, w.z) / size;
        float h = 0.09 / size;
        float c = abs(texture(uNoise, q).r - 0.5);
        g += vec2(abs(texture(uNoise, q + vec3(h, 0.0, 0.0)).r - 0.5) - c, abs(texture(uNoise, q + vec3(0.0, 0.0, h)).r - 0.5) - c) / 0.09 * (i == 0 ? 0.55 : (i == 2 ? 0.8 : 1.0));
    }
    return normalize(n + vec3(g.x, 0.0, g.y) * 0.5 * steep);
}
vec3 landAlbedo(vec3 a, float elevation, vec3 n, vec3 w) {
    float l = dot(a, vec3(0.3, 0.6, 0.1));
    a = mix(vec3(l), a, 1.05) * vec3(1.03, 1.0, 0.88) * uGradeLand;
    float meadow = texture(uNoise, vec3(w.x, 0.0, w.z) / 210.0).g * 0.6 + texture(uNoise, vec3(w.z, 0.3, w.x) / 47.0).b * 0.4;
    a *= mix(0.72 + 0.56 * meadow, 1.0, uIsLandmark);
    float breakup = texture(uNoise, vec3(w.x, 0.0, w.z) / 3100.0).r + texture(uNoise, vec3(w.x, 0.0, w.z) / 640.0).g * 0.5;
    float line = uSnow + (breakup - 0.75) * 420.0;
    float cover = smoothstep(line - 90.0, line + 160.0, elevation) * smoothstep(0.60, 0.80, n.y + (breakup - 0.75) * 0.22);
    float rock = smoothstep(line - 500.0, line, elevation) * smoothstep(0.82, 0.62, n.y);
    a = mix(a, vec3(0.20, 0.19, 0.18) * (0.75 + 0.5 * breakup), rock * 0.8);
    return mix(a, vec3(0.86, 0.89, 0.93), cover);
}
vec3 waterShade(vec3 world, vec3 view, float elevation, float shade) {
    vec2 p = world.xz;
    float a = texture(uNoise, vec3(p / 95.0 + uWave, uWave.x)).r - 0.5, b = texture(uNoise, vec3(p.yx / 118.0 - uWave, uWave.y)).g - 0.5;
    float c = texture(uNoise, vec3(p / 21.0 + uWave.yx, uWave.y)).b - 0.5, e = texture(uNoise, vec3(p.yx / 25.0 + uWave, uWave.x)).r - 0.5;
    vec3 wn = normalize(vec3((a + c * 0.6) * 0.09, 1.0, (b + e * 0.6) * 0.09));
    float fres = 0.025 + 0.975 * pow(1.0 - max(dot(view, wn), 0.0), 5.0);
    fres = min(fres * 1.5, 1.0);
    vec3 refl;
    if (uMirrorOn > 0.5 && abs(world.y - uMirrorY) < 6.0) {
        float dist = length(uEye - world);
        vec2 uv = gl_FragCoord.xy / uResolution + vec2(wn.x * 0.35, wn.z * 1.6) * (260.0 / (dist * 0.03 + 260.0)) * 0.42;
        refl = texture(uMirror, clamp(uv, 0.001, 0.999)).rgb;
    } else {
        refl = env(reflect(-view, wn), 1.0);
    }
    vec3 body = vec3(0.006, 0.022, 0.030);
    vec3 c2 = uSunFrame < 0.5 ? 2.0 * body * env(vec3(0.0, 1.0, 0.0), 6.0) : vec3(0.0);
    vec3 glint = vec3(0.0);
    if (uSunFrame > 0.5) {
        vec3 h = normalize(uL + view);
        glint = sunAt(elevation) * pow(max(dot(wn, h), 0.0), 900.0) * 34.0 * shade;
    }
    return c2 + refl * fres + glint;
}
`;

const TERRAIN_FS = LIGHT + TERRAIN_COMMON + GROUND_SHADE + `
uniform sampler2D uImage;
uniform sampler2D uCover;
uniform sampler2D uGround;
uniform sampler2D uGlow;
uniform sampler2D uPatch;
uniform sampler2D uPools;
uniform vec4 uPatchRect;
uniform vec2 uSize;
in vec2 vUv;
in vec3 vWorld;
out vec4 outColor;
void main() {
    if (vWorld.y < uClipY || inLandmark(vWorld.xz)) discard;
    vec2 e = 1.0 / uSize;
    vec2 cell = uExtent * e;
    // The store's relief is smoother than its 25 m grid: a wide kernel hides the source's facets.
    vec2 gradient = vec2(0.0);
    for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
        vec2 at = vUv + vec2(float(x), float(y)) * e * 1.5;
        gradient.x += bedAt(at + vec2(e.x * 2.0, 0.0)) - bedAt(at - vec2(e.x * 2.0, 0.0));
        gradient.y += bedAt(at + vec2(0.0, e.y * 2.0)) - bedAt(at - vec2(0.0, e.y * 2.0));
    }
    gradient /= 25.0 * 4.0;
    vec3 n = normalize(vec3(-gradient.x / cell.x, 1.0, -gradient.y / cell.y));
    float elevation = vWorld.y + uBaseElev;
    vec3 albedo = landAlbedo(texture(uImage, vUv).rgb, elevation, n, vWorld);
    n = crag(n, vWorld);
    vec4 ground = texture(uGround, vUv);
    float built = ground.a;
    albedo = mix(albedo, ground.rgb * 0.52, built);
    float near = 1.0 - smoothstep(150.0, 2600.0, length(uEye - vWorld));
    if (near > 0.0) {
        float forest = smoothstep(0.35, 0.65, texture(uCover, vUv).g);
        float open = near * (1.0 - built);
        vec3 q = vec3(vWorld.x, 0.2, vWorld.z);
        float size = mix(13.0, 24.0, forest), probe = 0.04;
        float centre = texture(uNoise, q / size).r;
        vec2 slope = vec2(texture(uNoise, q / size + vec3(probe, 0.0, 0.0)).r - centre, texture(uNoise, q / size + vec3(0.0, 0.0, probe)).r - centre) / probe;
        n = normalize(n + vec3(slope.x, 0.0, slope.y) * open * mix(0.5, 1.7, forest));
        albedo *= 1.0 + open * ((texture(uNoise, q / 6.0).g - 0.5) * 0.55 + (texture(uNoise, q / 2.0).b - 0.5) * 0.35) - open * forest * 0.25;
    }
    vec2 patchUv = (vWorld.xz - uPatchRect.xy) / (uPatchRect.zw - uPatchRect.xy);
    if (patchUv.x > 0.0 && patchUv.y > 0.0 && patchUv.x < 1.0 && patchUv.y < 1.0) {
        vec4 street = texture(uPatch, patchUv);
        vec2 edge = min(patchUv, 1.0 - patchUv);
        float grain = 0.82 + 0.36 * texture(uNoise, vec3(vWorld.x, 0.6, vWorld.z) / 5.0).r;
        albedo = mix(albedo, street.rgb * grain, street.a * smoothstep(0.0, 0.06, min(edge.x, edge.y)));
    }
    vec2 coverAt = vUv * uSize - 0.5;
    vec2 coverCell = (floor(coverAt) + 0.5) * e, coverF = fract(coverAt);
    float coverR = mix(mix(texture(uCover, coverCell).r, texture(uCover, coverCell + vec2(e.x, 0.0)).r, coverF.x),
        mix(texture(uCover, coverCell + vec2(0.0, e.y)).r, texture(uCover, coverCell + e).r, coverF.x), coverF.y);
    float water = smoothstep(0.42, 0.58, coverR) * (1.0 - built);
    vec3 view = normalize(uEye - vWorld);
    vec3 c = lit(albedo, n, vWorld);
    if (water > 0.0) {
        float s = shadowOf(vWorld, vec3(0.0, 1.0, 0.0)) * cloudShadow(vWorld);
        c = mix(c, waterShade(vWorld, view, elevation, s), water);
    }
    // The city-wide street glow is a far-view stand-in. Inside the street patch, lamps light the ground instead.
    float patchFade = 0.0;
    if (patchUv.x > 0.0 && patchUv.y > 0.0 && patchUv.x < 1.0 && patchUv.y < 1.0) {
        vec2 border = min(patchUv, 1.0 - patchUv);
        patchFade = smoothstep(0.0, 0.08, min(border.x, border.y));
        c += albedo * texture(uPools, patchUv).rgb * uNight * 8.0 * patchFade;
    }
    c += texture(uGlow, vUv).rgb * uNight * 2.2 * (1.0 - patchFade);
    outColor = vec4(c, 1.0);
}`;

const OUTER_VS = `
in vec2 aPos;
uniform sampler2D uHeight;
uniform mat4 uViewProj;
uniform vec4 uRect;
uniform float uBase;
out vec2 vUv;
out vec3 vWorld;
void main() {
    vUv = aPos;
    vec3 w = vec3(uRect.x + aPos.x * uRect.z, textureLod(uHeight, aPos, 0.0).r - uBase, uRect.y + aPos.y * uRect.w);
    vWorld = w;
    gl_Position = uViewProj * vec4(w, 1.0);
}`;

const OUTER_FS = LIGHT + GROUND_SHADE + `
uniform sampler2D uImage;
uniform sampler2D uHeight;
uniform vec2 uCellSize;
uniform vec4 uHole;
in vec2 vUv;
in vec3 vWorld;
out vec4 outColor;
void main() {
    if (uIsLandmark < 0.5) {
        if (vWorld.x > uHole.x && vWorld.x < uHole.z && vWorld.z > uHole.y && vWorld.z < uHole.w) discard;
        if (inLandmark(vWorld.xz)) discard;
    }
    if (vWorld.y < uClipY) discard;
    vec2 e = vec2(1.0) / vec2(textureSize(uHeight, 0));
    float dx = textureLod(uHeight, vUv + vec2(e.x, 0.0), 0.0).r - textureLod(uHeight, vUv - vec2(e.x, 0.0), 0.0).r;
    float dz = textureLod(uHeight, vUv + vec2(0.0, e.y), 0.0).r - textureLod(uHeight, vUv - vec2(0.0, e.y), 0.0).r;
    vec3 n = normalize(vec3(-dx / (2.0 * uCellSize.x), 1.0, -dz / (2.0 * uCellSize.y)));
    vec3 raw = texture(uImage, vUv).rgb;
    float elevation = vWorld.y + uBaseElev;
    vec3 albedo = landAlbedo(raw, elevation, n, vWorld);
    if (uIsLandmark < 0.5) n = crag(n, vWorld);
    outColor = vec4(lit(albedo, n, vWorld), 1.0);
}`;

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

const BUILDING_FS = LIGHT + FACADE + `
in vec3 vWorld;
in vec3 vLocal;
in vec3 vSize;
in vec3 vNormalW;
in vec3 vNormalL;
flat in vec3 vBase;
flat in float vKind;
flat in float vSeed;
uniform float uLit;
out vec4 outColor;
float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 propColour(float k, float s, float figure, vec3 local, vec3 size, vec3 nL, inout vec3 glow, inout float gloss) {
    if (k < 12.5) {
        vec3 paint = s < 0.3 ? vec3(0.74) : (s < 0.5 ? vec3(0.09) : (s < 0.68 ? vec3(0.33, 0.35, 0.37) : (s < 0.82 ? vec3(0.42, 0.07, 0.06) : vec3(0.07, 0.15, 0.30))));
        gloss = 0.55;
        if (local.y < size.y * 0.3 || (abs(nL.x) > 0.5 && local.y < size.y * 0.45)) { gloss = 0.0; return vec3(0.02); }
        // Lights on the two ends of the body, on the upper half.
        if (abs(nL.x) > 0.5 && local.y > size.y * 0.45) {
            bool front = nL.x > 0.0;
            float pair = smoothstep(0.32, 0.5, abs(local.z) / (size.z * 0.5));
            glow += (front ? vec3(1.0, 0.92, 0.72) * 4.5 : vec3(1.0, 0.04, 0.03) * 2.0) * pair * uNight;
        }
        return paint;
    }
    if (k < 13.5) { gloss = 1.0; return vec3(0.025, 0.03, 0.035); }
    if (k < 14.5) {
        if (figure > 2.5) return mix(vec3(0.55, 0.38, 0.28), vec3(0.32, 0.20, 0.14), step(0.6, s));
        float t = fract(s * 7.31);
        vec3 top = t < 0.3 ? vec3(0.06) : (t < 0.5 ? vec3(0.5, 0.5, 0.48) : (t < 0.7 ? vec3(0.12, 0.2, 0.4) : (t < 0.85 ? vec3(0.5, 0.1, 0.08) : vec3(0.6, 0.55, 0.35))));
        return figure > 1.5 ? top : mix(vec3(0.05, 0.06, 0.09), vec3(0.13, 0.11, 0.09), step(0.5, fract(s * 13.7)));
    }
    if (k < 15.5) return vec3(0.1, 0.105, 0.11);
    if (k < 16.5) { glow += vec3(1.0, 0.86, 0.62) * 28.0 * uNight; return vec3(0.45); }
    if (k < 17.5) return s < 0.3 ? vec3(0.11, 0.07, 0.04) : (s < 0.7 ? vec3(0.07, 0.08, 0.08) : vec3(0.36, 0.37, 0.38));
    if (k < 18.5) {
        gloss = 0.9;
        glow += vec3(1.0, 0.72, 0.42) * 2.4 * uNight;
        return vec3(0.03, 0.04, 0.05);
    }
    if (k < 19.5) { gloss = 0.8; return vec3(0.16, 0.2, 0.22); }
    if (k > 20.5 && k < 21.5) {
        vec2 stones = vec2((abs(nL.x) > 0.5 ? local.z : local.x) / 3.4, local.y / 3.6);
        float slit = smoothstep(0.42, 0.46, fract(stones.x)) * (1.0 - smoothstep(0.54, 0.58, fract(stones.x))) * smoothstep(0.3, 0.34, fract(stones.y)) * (1.0 - smoothstep(0.74, 0.78, fract(stones.y)));
        float keep = step(0.62, fract(sin(dot(floor(stones), vec2(12.9, 78.2)) + s * 91.0) * 43758.5));
        return nL.y > 0.5 ? vec3(0.22, 0.21, 0.2) : mix(vec3(0.34, 0.31, 0.26), vec3(0.03), slit * keep * step(4.0, local.y));
    }
    if (k > 21.5 && k < 22.5) return vec3(0.27, 0.13, 0.09);
    if (k > 22.5) { return vec3(0.68, 0.68, 0.66); }
    float slot = fract(local.y / size.y * 3.0);
    float light = floor(local.y / size.y * 3.0);
    if (nL.y < 0.5 && abs(slot - 0.5) < 0.32) {
        vec3 on = light > 1.5 ? vec3(1.0, 0.05, 0.03) : (light > 0.5 ? vec3(0.08, 0.05, 0.0) : vec3(0.02, 0.08, 0.03));
        glow += on * (1.5 + 3.5 * uNight);
    }
    return vec3(0.015);
}
vec3 palette(float k, float s) {
    if (k < 0.5) return mix(mix(vec3(0.62, 0.50, 0.42), vec3(0.74, 0.68, 0.60), step(0.45, s)), vec3(0.78, 0.76, 0.72), step(0.82, s));
    if (k < 1.5) {
        vec3 a = mix(vec3(0.86, 0.85, 0.81), vec3(0.80, 0.81, 0.82), fract(s * 3.0));
        return mix(a, fract(s * 11.0) > 0.5 ? vec3(0.86, 0.79, 0.70) : vec3(0.76, 0.81, 0.84), step(0.7, s));
    }
    if (k < 2.5) return mix(vec3(0.60, 0.57, 0.53), vec3(0.42, 0.44, 0.47), s);
    if (k > 10.5 || (k > 7.5 && k < 8.5)) return mix(vec3(0.20, 0.26, 0.14), vec3(0.27, 0.32, 0.17), s);
    if (k > 9.5) return vec3(0.80, 0.79, 0.76);
    if (k > 8.5) return mix(vec3(0.42, 0.43, 0.44), vec3(0.60, 0.60, 0.58), s);
    if (k < 3.5 || (k > 5.5 && k < 6.5)) {
        vec3 g = mix(vec3(0.24, 0.32, 0.38), vec3(0.40, 0.46, 0.50), fract(s * 5.0));
        return mix(g, vec3(0.72, 0.68, 0.61), step(0.72, s));
    }
    if (k < 4.5) return mix(vec3(0.60, 0.60, 0.58), vec3(0.42, 0.50, 0.56), s);
    if (k < 5.5) return mix(vec3(0.46, 0.43, 0.40), vec3(0.56, 0.52, 0.46), s);
    return vec3(0.68, 0.64, 0.58);
}
void main() {
    if (vWorld.y < uClipY) discard;
    vec3 n = normalize(vNormalW);
    float leaf = 0.0, treePart = 0.0;
    bool prop = vKind > 11.5;
    if (vKind > 10.5 && vKind < 11.5) {
        treePart = treeShape(vWorld, uEye, vBase, vSize, n, leaf);
        if (treePart < 0.5) discard;
    }
    float figurePart = 0.0;
    if (vKind > 13.5 && vKind < 14.5) {
        figurePart = personShape(vWorld, uEye, vBase, vSize, n);
        if (figurePart < 0.5) discard;
    }
    vec3 view = normalize(uEye - vWorld);
    vec3 base = toLinear(palette(vKind, vSeed));
    vec3 glow = vec3(0.0);
    vec3 albedo = base;
    float gloss = 0.0;
    float tone = 0.5;
    float y = vLocal.y;
    if (prop) {
        albedo = propColour(vKind, vSeed, figurePart, vLocal, vSize, vNormalL, glow, gloss);
    } else if (vKind > 10.5) {
        albedo = treePart > 1.5 ? toLinear(vec3(0.27, 0.22, 0.18)) : base * (0.28 + 0.95 * leaf);
    } else if (vKind > 7.5 && vKind < 8.5) {
        albedo = base * (0.75 + 0.5 * h21(floor(vWorld.xz / 2.0) + vSeed));
    } else if (vKind > 8.5 && vKind < 9.5) {
        albedo = base * (0.85 + 0.2 * step(0.5, fract(vLocal.y / 0.9 + vSeed)));
    } else if (vNormalL.y > 0.5) {
        vec2 q = abs(vLocal.xz) / (vSize.xz * 0.5);
        float rim = smoothstep(0.86, 0.96, max(q.x, q.y));
        vec3 roof = vKind < 0.5 ? mix(vec3(0.46, 0.27, 0.20), vec3(0.42, 0.38, 0.35), step(0.55, fract(vSeed * 13.0))) : vec3(0.38, 0.38, 0.37);
        albedo = mix(toLinear(roof), base * 0.7, rim);
    } else {
        bool core = vKind > 9.5;
        Facade wall = wallFacade(core ? 1.0 : vKind, vSeed, vLocal, vSize, core ? vec3(1.0, 0.0, 0.0) : vNormalL, base);
        albedo = wall.albedo;
        gloss = wall.glass;
        tone = wall.tone;
        float detail = 1.0 - smoothstep(0.3, 0.75, fwidth(y / 2.9));
        float lit_ = step(1.0 - uLit, wall.tone);
        vec3 warm = mix(vec3(1.0, 0.70, 0.40), vec3(0.88, 0.94, 1.0), step(0.86, h21(wall.id * 1.7 + vSeed * 7.0)));
        float bh = h21(vec2(vSeed * 31.0, 2.0));
        float household = (0.12 + 1.5 * bh * bh) * (vKind < 0.5 ? 0.3 : 1.0);
        float dimmer = 0.15 + 0.85 * pow(h21(wall.id * 3.1 + vSeed), 3.0);
        float towerBoost = vKind > 2.5 && vKind < 3.5 ? 1.5 : 1.0;
        glow = warm * mix(uLit * wall.cover * 0.55 * household * household * towerBoost, lit_ * wall.pane * 1.5 * household * dimmer, detail) * uNight;
        if (vKind < 2.5 && y < 3.2) glow += mix(vec3(1.0, 0.45, 0.25), vec3(0.3, 0.8, 1.0), step(0.5, h21(vec2(wall.id.x, vSeed)))) * uNight * 0.5;
    }
    vec3 c = lit(albedo, n, vWorld);
    float contact = vNormalL.y > 0.5 ? 1.0 : 0.72 + 0.28 * (1.0 - exp(-y / 6.0));
    c *= contact;
    if (gloss > 0.0) {
        float fres = 0.08 + 0.92 * pow(1.0 - max(dot(view, n), 0.0), 4.0);
        vec3 r = normalize(reflect(-view, n) + vec3(tone - 0.5, 0.0, fract(tone * 7.0) - 0.5) * 0.05);
        fres *= gloss;
        if (uSunFrame < 0.5) c += 2.0 * env(r, 2.0) * fres * 0.9;
        else {
            float spec = pow(max(dot(r, uL), 0.0), 420.0) * 90.0;
            c += 2.0 * sunAt(vWorld.y + uBaseElev) * spec * fres * shadowOf(vWorld, n) * cloudShadow(vWorld) * 0.05;
        }
    }
    if (vNormalL.y > 0.5 && vSize.y > 150.0 && vKind < 7.5) {
        glow += vec3(1.0, 0.05, 0.03) * uNight * 30.0 * (1.0 - smoothstep(0.0, 0.3, length(vLocal.xz) / max(vSize.x, 1.0)));
    }
    outColor = vec4(c + glow, 1.0);
}`;

const FOG_FS = LIGHT + `
in vec2 vUv;
uniform sampler2D uHdr;
uniform highp sampler2D uDepth;
uniform sampler2D uCityGlow;
uniform mat4 uInverse;
uniform vec2 uRes;
uniform float uFrame;
uniform float uHaze;
uniform vec4 uFog;       // top elevation, softness m, relief m, density /m
uniform float uAir;
uniform vec3 uSunDir;
uniform vec4 uExtentRect;
out vec4 outColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float fogDensity(vec3 p, float elevation) {
    float n = texture(uNoise, vec3(p.x, elevation * 0.4, p.z) / 7200.0).r;
    float m = texture(uNoise, vec3(p.x, elevation * 0.8, p.z) / 1500.0 + 0.2).g;
    float top = uFog.x + (n - 0.5) * uFog.z + (m - 0.5) * uFog.z * 0.45;
    return uFog.w * smoothstep(top, top - uFog.y, elevation);
}
vec3 cityGlowAt(vec3 p, float elevation) {
    if (uNight < 0.02) return vec3(0.0);
    vec2 uv = (p.xz - uExtentRect.xy) / (uExtentRect.zw - uExtentRect.xy);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec3(0.0);
    return textureLod(uCityGlow, uv, 6.0).rgb * exp(-max(p.y, 0.0) / 1100.0);
}
void main() {
    vec3 c = texture(uHdr, vUv).rgb;
    float z = texture(uDepth, vUv).r;
    vec4 far = uInverse * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
    vec3 point = far.xyz / far.w;
    vec3 ray = point - uEye;
    float dist = length(ray);
    vec3 d = ray / dist;
    bool sky = z >= 1.0;
    if (sky) dist = 60000.0;
    else {
        float meanElevation = 0.5 * (uEye.y + point.y) + uBaseElev;
        float tau = uAir * exp(-max(meanElevation - 400.0, 0.0) / 3600.0) * dist;
        c = mix(c, env(vec3(d.x, 0.01, d.z), 1.0) , 1.0 - exp(-tau));
    }
    float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803);
    vec3 scat = vec3(0.0);
    float T = 1.0;
    float mu = dot(d, uSunDir);
    float pMie = 0.0796 * (1.0 - 0.5776) / pow(1.0 + 0.5776 - 1.52 * mu, 1.5);
    float pFog = 0.0796 * (1.0 - 0.16) / pow(1.0 + 0.16 - 0.8 * mu, 1.5) * 0.7 + 0.06;
    vec3 up = env(vec3(0.0, 1.0, 0.0), 5.0);
    if (uFog.w > 0.0) {
        float bandTop = uFog.x + uFog.z * 0.8, bandLow = uFog.x - uFog.y * 3.0;
        float e0 = uEye.y + uBaseElev;
        float tA = 0.0, tB = dist;
        if (abs(d.y) > 1e-4) {
            float t1 = (bandTop - e0) / d.y, t2 = (bandLow - e0) / d.y;
            float lo = min(t1, t2), hi = max(t1, t2);
            tA = max(tA, lo);
            tB = min(tB, hi);
        }
        if (tB > tA) {
            const int steps = 40;
            float dt = (tB - tA) / float(steps);
            for (int i = 0; i < steps && T > 0.004; i++) {
                float t = tA + (float(i) + jit) * dt;
                vec3 p = uEye + d * t;
                float elevation = p.y + uBaseElev;
                float s = fogDensity(p, elevation);
                if (s <= 0.0) continue;
                float depthBelow = max(uFog.x + uFog.z * 0.2 - elevation, 0.0);
                vec3 Li;
                if (uSunFrame > 0.5) {
                    float selfT = exp(-depthBelow * uFog.w * 0.22 / max(uL.y, 0.12));
                    Li = 2.0 * sunAt(elevation) * pFog * mix(selfT, 0.16, 0.24) * shadowOf(p, vec3(0.0)) * cloudShadow(p);
                } else {
                    Li = 2.0 * up * (0.55 + 0.45 * exp(-depthBelow / 300.0));
                }
                Li += cityGlowAt(p, elevation) * 5.0;
                float st = exp(-s * dt);
                scat += T * (1.0 - st) * Li;
                T *= st;
            }
        }
    }
    float reach = min(dist, 45000.0);
    float dtH = reach / 28.0;
    for (int i = 0; i < 28; i++) {
        float t = (float(i) + jit) * dtH;
        vec3 p = uEye + d * t;
        float elevation = p.y + uBaseElev;
        float s = uHaze * exp(-max(p.y, 0.0) / 750.0);
        vec3 Li;
        if (uSunFrame > 0.5) Li = 2.0 * sunAt(elevation) * pMie * shadowOf(p, vec3(0.0)) * cloudShadow(p);
        else Li = 2.0 * up * 0.75;
        Li += cityGlowAt(p, elevation) * 4.5;
        float st = exp(-s * dtH);
        scat += T * (1.0 - st) * Li;
        T *= st;
    }
    outColor = vec4(c * T + scat, 1.0);
}`;

const DOWN_FS = `
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uGain;
out vec4 outColor;
void main() {
    vec3 c = texture(uTex, vUv).rgb * 4.0;
    c += texture(uTex, vUv + uStep * vec2(-1, -1)).rgb + texture(uTex, vUv + uStep * vec2(1, -1)).rgb;
    c += texture(uTex, vUv + uStep * vec2(-1, 1)).rgb + texture(uTex, vUv + uStep * vec2(1, 1)).rgb;
    outColor = vec4(min(c / 8.0 * uGain, vec3(3.2)), 1.0);
}`;

const UP_FS = `
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 outColor;
void main() {
    vec3 c = vec3(0.0);
    c += texture(uTex, vUv + uStep * vec2(-2, 0)).rgb + texture(uTex, vUv + uStep * vec2(2, 0)).rgb;
    c += texture(uTex, vUv + uStep * vec2(0, -2)).rgb + texture(uTex, vUv + uStep * vec2(0, 2)).rgb;
    c += 2.0 * (texture(uTex, vUv + uStep * vec2(-1, -1)).rgb + texture(uTex, vUv + uStep * vec2(1, -1)).rgb);
    c += 2.0 * (texture(uTex, vUv + uStep * vec2(-1, 1)).rgb + texture(uTex, vUv + uStep * vec2(1, 1)).rgb);
    outColor = vec4(c / 12.0, 1.0);
}`;

const FINISH_FS = `
in vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomAmount;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform vec3 uShadowTint;
uniform float uVignette;
uniform float uGrain;
uniform float uScale;
out vec4 outColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// Plain per-channel ACES turns every sunset yellow-white, so part of the tone curve follows luminance.
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
    vec3 c = texture(uTex, vUv).rgb * uScale;
    c = mix(c, texture(uBloom, vUv).rgb, uBloomAmount);
    c *= uExposure * uTint;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec3 tonedLum = c * (aces(vec3(l)).r / max(l, 1e-5));
    c = mix(aces(c), clamp(tonedLum, 0.0, 1.0), 0.45);
    c = pow(max(c, 0.0), vec3(1.0 / 2.2));
    float g = dot(c, vec3(0.3, 0.6, 0.1));
    c = mix(vec3(g), c, uSaturation);
    c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
    c += uShadowTint * pow(1.0 - clamp(g, 0.0, 1.0), 3.0);
    vec2 q = vUv - 0.5;
    c *= 1.0 - uVignette * smoothstep(0.25, 0.95, dot(q, q) * 2.0);
    c += (ign(gl_FragCoord.xy) - 0.5) * uGrain;
    outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const COPY_FS = `
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

const DEFAULTS = {
    samples: 96, sunAz: 270, sunEl: 8, sunDisc: 0.27, sunI: 22, betaM: 9e-6,
    cloudBase: 2800, cloudTop: 5000, cloudCover: 0.36, cloudScale: 15000, cirrus: 0.5, wind: [0, 0],
    haze: 1 / 170000, air: 1 / 48000, fogTop: 0, fogSoft: 160, fogRelief: 130, fogDensity: 0,
    snow: 2150, land: 1, night: 0, lit: 0.45, stars: 0, moonAz: 150, moonEl: 40, moonE: 0.05, nightSky: [0, 0, 0],
    mirrorY: null, nearRadius: null, exposure: 0.5, bloom: 0.05, saturation: 1.1, contrast: 0.34,
    tint: [0.97, 0.98, 1.07], shadowTint: [-0.006, 0.0, 0.012], vignette: 0.28, grain: 0.012, skyScale: 1, underglow: [0, 0, 0], skyFill: [0.035, 0.085, 0.22], mirrorElev: null, targetElev: null,
};

// JS twin of the shader's opticalDepth, so fragments can read sun colour by height from one table.
function transmittanceTable(sunDir, betaM) {
    const Re = 6371e3, Ra = 6471e3;
    const out = new Float32Array(128 * 4);
    for (let i = 0; i < 128; i++) {
        const elevation = (i + 0.5) / 128 * 7000;
        const py = Re + elevation;
        const b = py * sunDir[1];
        const c = py * py - Ra * Ra;
        const tMax = -b + Math.sqrt(b * b - c);
        const groundC = py * py - Re * Re;
        const groundH = b * b - groundC;
        const blocked = groundH > 0 && -b - Math.sqrt(groundH) > 0;
        let r = 0, m = 0, o = 0;
        const steps = 64;
        let previous = 0;
        for (let k = 0; k < steps; k++) {
            const end = tMax * ((k + 1) / steps) ** 2;
            const dt = end - previous, t = 0.5 * (previous + end);
            previous = end;
            const x = sunDir[0] * t, y = py + sunDir[1] * t, z = sunDir[2] * t;
            const h = Math.hypot(x, y, z) - Re;
            r += Math.exp(-h / 8000) * dt;
            m += Math.exp(-h / 1400) * dt;
            o += Math.max(0, 1 - Math.abs(h - 25000) / 15000) * dt;
        }
        const ext = (br, bo) => Math.exp(-(br * r + 1.1 * betaM * m + bo * o));
        const open = blocked ? 0 : 1;
        out.set([ext(5.8e-6, 0.9e-6) * open, ext(13.5e-6, 2.6e-6) * open, ext(33.1e-6, 0.12e-6) * open, 1], i * 4);
    }
    return out;
}

function tileableNoiseVolume(gl) {
    const N = 96;
    const data = new Uint8Array(N * N * N * 4);
    const lattice = (period, seed) => {
        const v = new Float32Array(period * period * period);
        let s = seed * 2654435761 >>> 0;
        for (let i = 0; i < v.length; i++) {
            s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0;
            v[i] = s / 4294967296;
        }
        return { v, period };
    };
    const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const sample = ({ v, period }, x, y, z) => {
        const fx = x * period, fy = y * period, fz = z * period;
        const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
        const tx = smooth(fx - ix), ty = smooth(fy - iy), tz = smooth(fz - iz);
        const at = (a, b, c) => v[((a % period + period) % period) + period * (((b % period + period) % period) + period * ((c % period + period) % period))];
        const l = (a, b, t) => a + (b - a) * t;
        return l(l(l(at(ix, iy, iz), at(ix + 1, iy, iz), tx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), tx), ty),
            l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), tx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), tx), ty), tz);
    };
    const channels = [
        [4, 8, 16, 32].map((p, i) => lattice(p, 11 + i)),
        [5, 10, 20, 40].map((p, i) => lattice(p, 37 + i)),
        [8, 16, 32, 48].map((p, i) => lattice(p, 71 + i)),
    ];
    let w = 0;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        for (let ch = 0; ch < 3; ch++) {
            let sum = 0, amp = 0.5, norm = 0;
            for (const octave of channels[ch]) { sum += amp * sample(octave, x / N, y / N, z / N); norm += amp; amp *= 0.5; }
            // Stretch to full range: fbm piles up around the middle and the thresholds need the tails.
            data[w++] = Math.max(0, Math.min(255, ((sum / norm - 0.5) * 2.1 + 0.5) * 255));
        }
        data[w++] = 255;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, axis, gl.REPEAT);
    return tex;
}

function depthTexture(gl, w, h, compare, format = gl.DEPTH_COMPONENT32F) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    const filter = compare ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (compare) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    }
    return tex;
}

function target(gl, colour, depth) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (colour) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colour, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    } else {
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
    }
    if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Beauty framebuffer incomplete: 0x${status.toString(16)}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
}

function direction(azimuth, elevation) {
    const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

const halton = (i, base) => { let f = 1, r = 0; while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); } return r; };

function orthoLight(dir, centre, radius) {
    const eye = [centre[0] + dir[0] * radius * 3, centre[1] + dir[1] * radius * 3, centre[2] + dir[2] * radius * 3];
    const view = lookAt(eye, centre, Math.abs(dir[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0]);
    const near = radius * 0.2, far = radius * 6;
    const proj = new Float32Array([1 / radius, 0, 0, 0, 0, 1 / radius, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1]);
    return multiply(proj, view);
}

let shared = null;
function programs(gl, renderer) {
    if (shared) return shared;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const nearSize = Math.min(8192, limit), farSize = Math.min(4096, limit);
    const shN = depthTexture(gl, nearSize, nearSize, true, gl.DEPTH_COMPONENT24);
    const shF = depthTexture(gl, farSize, farSize, true, gl.DEPTH_COMPONENT24);
    shared = {
        sky: program(gl, FULLSCREEN_VS, SKY_FS, 'beautySky'),
        terrain: program(gl, TERRAIN_VS, TERRAIN_FS, 'beautyTerrain'),
        outer: program(gl, OUTER_VS, OUTER_FS, 'beautyOuter'),
        building: renderer.buildingProgram(BUILDING_VS, BUILDING_FS, 'beautyBuilding'),
        fog: program(gl, FULLSCREEN_VS, FOG_FS, 'beautyFog'),
        down: program(gl, FULLSCREEN_VS, DOWN_FS, 'beautyDown'),
        up: program(gl, FULLSCREEN_VS, UP_FS, 'beautyUp'),
        finish: program(gl, FULLSCREEN_VS, FINISH_FS, 'beautyFinish'),
        copy: program(gl, FULLSCREEN_VS, COPY_FS, 'beautyCopy'),
        noise: tileableNoiseVolume(gl),
        shN, shF, nearSize, farSize,
        shNFb: target(gl, null, shN),
        shFFb: target(gl, null, shF),
    };
    return shared;
}

function frameTargets(gl, w, h) {
    const hdr = texture(gl, w, h, 'rgba16f', null, 'linear');
    const depth = depthTexture(gl, w, h, false);
    const accum = texture(gl, w, h, 'rgba32f', null, 'linear');
    const mirrorW = w, mirrorH = h;
    const mirror = texture(gl, mirrorW, mirrorH, 'rgba16f', null, 'linear');
    const mirrorDepth = depthTexture(gl, mirrorW, mirrorH, false);
    const skyFront = texture(gl, w, h, 'rgba16f', null, 'linear');
    const skyMirror = texture(gl, mirrorW, mirrorH, 'rgba16f', null, 'linear');
    const levels = [];
    let lw = w, lh = h;
    for (let i = 0; i < 6; i++) {
        lw = Math.max(2, lw >> 1); lh = Math.max(2, lh >> 1);
        const t = texture(gl, lw, lh, 'rgba16f', null, 'linear');
        levels.push({ t, fb: target(gl, t.tex, null), w: lw, h: lh });
    }
    const bloom = texture(gl, w, h, 'rgba16f', null, 'linear');
    const out = texture(gl, w, h, 'rgba8', null, 'nearest');
    const list = {
        hdr, depth, accum, mirror, mirrorDepth, skyFront, skyMirror, levels, bloom, out,
        hdrFb: target(gl, hdr.tex, depth),
        accumFb: target(gl, accum.tex, null),
        mirrorFb: target(gl, mirror.tex, mirrorDepth),
        skyFrontFb: target(gl, skyFront.tex, null),
        skyMirrorFb: target(gl, skyMirror.tex, null),
        bloomFb: target(gl, bloom.tex, null),
        outFb: target(gl, out.tex, null),
        release() {
            for (const t of [hdr, accum, mirror, skyFront, skyMirror, bloom, out, ...levels.map((l) => l.t)]) gl.deleteTexture(t.tex);
            gl.deleteTexture(depth); gl.deleteTexture(mirrorDepth);
            for (const fb of [list.hdrFb, list.accumFb, list.mirrorFb, list.skyFrontFb, list.skyMirrorFb, list.bloomFb, list.outFb, ...levels.map((l) => l.fb)]) gl.deleteFramebuffer(fb);
        },
    };
    return list;
}

function nextTick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

let cachedTargets = null;
function targetsFor(gl, w, h) {
    if (cachedTargets?.w === w && cachedTargets?.h === h) return cachedTargets;
    cachedTargets?.release();
    cachedTargets = Object.assign(frameTargets(gl, w, h), { w, h });
    return cachedTargets;
}
export function releaseTargets() { cachedTargets?.release(); cachedTargets = null; }

// opts: DEFAULTS plus w, h and optionally camera { target, distance, yaw or heading, pitch, fov }; without one, the current view.
export function createSession(mc, optsIn) {
    const o = { ...DEFAULTS, ...optsIn };
    const { renderer, terrainField, gl } = mc;
    const p = programs(gl, renderer);
    const { w, h } = o;
    const t = targetsFor(gl, w, h);
    const terrain = renderer.terrain, outer = renderer.outerHq ?? renderer.outer, city = renderer.city;
    const baseElev = terrain.base;
    if (city?.glow && !city.glow.mipped) {
        gl.bindTexture(gl.TEXTURE_2D, city.glow.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        city.glow.mipped = true;
    }

    const camera = mc.camera;
    if (o.eye) {
        // A camera put at a spot, for rooftops and shorelines. The orbit camera underneath looks at a point ahead of it.
        const { x, y, z, heading, down = 0, fov = 0.6, ahead = 600 } = o.eye;
        const pitch = down * Math.PI / 180, yaw = (360 - heading) * Math.PI / 180;
        const across = Math.cos(pitch) * ahead;
        Object.assign(camera, { distance: ahead, pitch, yaw, fov, target: [x - Math.sin(yaw) * across, y - Math.sin(pitch) * ahead, z - Math.cos(yaw) * across], anim: null });
    }
    if (o.camera) {
        const cam = { ...o.camera };
        if (cam.heading !== undefined) cam.yaw = (360 - cam.heading) * Math.PI / 180;
        cam.target = cam.target ?? [0, 0, 0];
        if (o.targetElev !== null) cam.target = [cam.target[0], o.targetElev - baseElev, cam.target[2]];
        if (o.aboveGround !== undefined) cam.target = [cam.target[0], mc.groundAt(cam.target[0], cam.target[2]) + o.aboveGround, cam.target[2]];
        Object.assign(camera, cam);
        camera.anim = null;
    }
    const streets = mc.groundPatchFor?.() ?? null;
    const landmarks = (o.landmarks ?? []).map((name) => mc.landmarkMeshes?.[name]).filter(Boolean);
    const landmarkRects = new Float32Array(8);
    landmarks.forEach((m, i) => landmarkRects.set([m.rect[0], m.rect[1], m.rect[0] + m.rect[2], m.rect[1] + m.rect[3]], i * 4));
    const aspect = w / h;
    const eyeOrbit = camera.eye();
    const view = lookAt(eyeOrbit, camera.target, [0, 1, 0]);
    const near = Math.max(4, camera.distance * 0.004);
    const baseProj = perspective(camera.fov, aspect, near, camera.distance * 12 + 220000);
    const sunDir = direction(o.sunAz, o.sunEl);
    const night = o.night;
    const moonDir = direction(o.moonAz, o.moonEl);
    const keyDir = night > 0.5 ? moonDir : sunDir;
    const keyE = night > 0.5 ? o.moonE : o.sunI;

    const transData = night > 0.5 ? new Float32Array(128 * 4).fill(1) : transmittanceTable(sunDir, o.betaM);
    const trans = texture(gl, 128, 1, 'rgba32f', transData, 'linear');
    const shared3d = { noise: p.noise };

    const skyValues = (inverse, eye, latLong) => ({
        uInverse: inverse, uEye: eye, uLatLong: { int: latLong }, uSunDir: sunDir, uBaseElev: baseElev, uBetaM: o.betaM, uSunI: o.sunI,
        uCloud: [o.cloudBase, o.cloudTop, o.cloudCover, o.cloudScale], uCirrus: o.cirrus, uWind: o.wind, uStars: o.stars, uNightSky: o.nightSky,
        uDiscScale: o.skyScale, uSkyJit: 0, uSkyGain: 1, uUnderglow: o.underglow, uSkyFill: o.skyFill,
    });
    const SKY_PASSES = 2;
    const accumulateSky = async (fb, inverse, eye) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        for (let i = 0; i < SKY_PASSES; i++) {
            // The live view may draw between passes, so all state is set again and put back around each one.
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.viewport(0, 0, w, h);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            use(gl, p.sky, { ...skyValues(inverse, eye, 0), uSkyJit: i * 0.61803, uSkyGain: 1 / SKY_PASSES });
            bindNoise(p.sky, 15);
            renderer.draw();
            restore();
            gl.finish();
            await nextTick();
        }
    };
    const bindNoise = (prog, unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_3D, shared3d.noise);
        if (prog.u.uNoise) gl.uniform1i(prog.u.uNoise, unit);
    };

    const viewProjFor = (viewMatrix, jx, jy) => {
        const proj = new Float32Array(baseProj);
        proj[8] += jx * 2 / w;
        proj[9] += jy * 2 / h;
        return multiply(proj, viewMatrix);
    };
    const mirrorY = o.mirrorElev !== null ? o.mirrorElev - baseElev : o.mirrorY;
    const mirrorOn = mirrorY !== null;
    const reflectY = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 2 * (mirrorY ?? 0), 0, 1]);
    const mirrorView = multiply(view, reflectY);
    const eyeMirror = [eyeOrbit[0], 2 * (mirrorY ?? 0) - eyeOrbit[1], eyeOrbit[2]];

    const envW = 1024, envH = 512;
    const envTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, envTex);
    gl.texStorage2D(gl.TEXTURE_2D, 9, gl.RGBA16F, envW, envH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const envFb = target(gl, envTex, null);
    let frames = 0;
    let prepared = false;
    const prepare = async () => {
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, envFb);
        gl.viewport(0, 0, envW, envH);
        use(gl, p.sky, skyValues(new Float32Array(16), [eyeOrbit[0], eyeOrbit[1], eyeOrbit[2]], 1));
        bindNoise(p.sky, 15);
        renderer.draw();
        gl.bindTexture(gl.TEXTURE_2D, envTex);
        gl.generateMipmap(gl.TEXTURE_2D);
        await accumulateSky(t.skyFrontFb, invert(viewProjFor(view, 0, 0)), eyeOrbit);
        if (mirrorOn) await accumulateSky(t.skyMirrorFb, invert(viewProjFor(mirrorView, 0, 0)), eyeMirror);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.accumFb);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        prepared = true;
        restore();
    };
    // The interactive renderer sets up what it needs per frame, except for these.
    const restore = () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        gl.disable(gl.POLYGON_OFFSET_FILL);
        gl.depthMask(true);
        gl.activeTexture(gl.TEXTURE0);
    };

    const half = terrain.extent[0] / 2;
    const groundE = night > 0.5 ? keyE * Math.max(moonDir[1], 0.1) : o.sunI * transData[4] * Math.max(sunDir[1], 0.02);
    const bounce = [groundE * 0.16 / Math.PI + 0.02, groundE * 0.15 / Math.PI + 0.02, groundE * 0.13 / Math.PI + 0.02];
    const eyeDirFlat = [camera.target[0], camera.target[1], camera.target[2]];
    const nearRadius = o.nearRadius ?? Math.min(Math.max(2500, camera.distance * 1.4), 22000);
    const shadowCentre = o.shadowCentre ?? eyeDirFlat;
    const farRadius = 90000;
    const nearTexel = nearRadius * 2 / p.nearSize;

    const lightUniforms = (L, isSun, lightN, lightF, eye) => ({
        uL: L, uSunFrame: isSun ? 1 : 0, uE: keyE, uEye: eye, uBaseElev: baseElev, uBounce: bounce, uNight: night,
        uLightN: lightN, uLightF: lightF, uNearTexel: nearTexel, uCloud: [o.cloudBase, o.cloudTop, o.cloudCover, o.cloudScale], uWind: o.wind,
        uEnv: { tex: envTex, unit: 8 }, uTrans: { tex: trans.tex, unit: 9 },
    });
    const bindShadows = (prog) => {
        gl.activeTexture(gl.TEXTURE10);
        gl.bindTexture(gl.TEXTURE_2D, p.shN);
        if (prog.u.uShN) gl.uniform1i(prog.u.uShN, 10);
        gl.activeTexture(gl.TEXTURE11);
        gl.bindTexture(gl.TEXTURE_2D, p.shF);
        if (prog.u.uShF) gl.uniform1i(prog.u.uShF, 11);
    };
    const groundValues = (mirrorPass, frame) => ({
        uSnow: o.snow, uGradeLand: o.land, uMirrorOn: mirrorOn && !mirrorPass ? 1 : 0, uMirrorY: mirrorY ?? 0, uMirror: { tex: mirrorPass ? renderer.blank.tex : t.mirror.tex, unit: 12 },
        uResolution: [w, h], uWave: [halton(frame + 1, 5), halton(frame + 1, 7)],
    });

    const drawScene = (viewProj, L, isSun, lightN, lightF, eye, clipY, frame, mirrorPass) => {
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        const common = lightUniforms(L, isSun, lightN, lightF, eye);
        if (outer) {
            const prog = p.outer;
            use(gl, prog, {
                ...common, ...groundValues(mirrorPass, frame), uViewProj: viewProj, uClipY: clipY, uHeight: { tex: outer.heightTex.tex, unit: 0 }, uImage: { tex: outer.image.tex, unit: 1 },
                uRect: outer.rect, uBase: baseElev, uCellSize: [outer.rect[2] / outer.w, outer.rect[3] / outer.h], uHole: [-half, -half, half, half],
            });
            gl.uniform4fv(prog.u.uLandmarks, landmarkRects);
            gl.uniform1f(prog.u.uIsLandmark, 0);
            bindShadows(prog);
            bindNoise(prog, 15);
            gl.bindVertexArray(outer.mesh.vao);
            gl.drawElements(gl.TRIANGLES, outer.mesh.count, gl.UNSIGNED_INT, 0);
            for (const mesh of landmarks) {
                use(gl, prog, { uHeight: { tex: mesh.heightTex.tex, unit: 0 }, uImage: { tex: mesh.image.tex, unit: 1 }, uRect: mesh.rect, uCellSize: [mesh.rect[2] / mesh.w, mesh.rect[3] / mesh.h] });
                gl.uniform1f(prog.u.uIsLandmark, 1);
                gl.bindVertexArray(mesh.mesh.vao);
                gl.drawElements(gl.TRIANGLES, mesh.mesh.count, gl.UNSIGNED_INT, 0);
            }
        }
        {
            const prog = p.terrain;
            use(gl, prog, {
                ...common, ...groundValues(mirrorPass, frame), uViewProj: viewProj, uClipY: clipY, uC: { tex: terrainField.height.tex, unit: 0 }, uExtent: terrain.extent, uBase: baseElev,
                uSize: [terrain.w, terrain.h], uImage: { tex: terrain.image.tex, unit: 1 }, uCover: { tex: terrain.cover.tex, unit: 2 },
                uGround: { tex: city?.ground?.tex ?? renderer.blank.tex, unit: 3 }, uGlow: { tex: city?.glow?.tex ?? renderer.blank.tex, unit: 4 },
                uPatch: { tex: streets?.tex ?? renderer.blank.tex, unit: 13 }, uPools: { tex: streets?.pools ?? renderer.blank.tex, unit: 14 }, uPatchRect: streets?.rect ?? [1, 1, 0, 0],
            });
            gl.uniform4fv(prog.u.uLandmarks, landmarkRects);
            gl.uniform1f(prog.u.uIsLandmark, 0);
            bindShadows(prog);
            bindNoise(prog, 15);
            gl.bindVertexArray(terrain.mesh.vao);
            gl.drawElements(gl.TRIANGLES, terrain.mesh.count, gl.UNSIGNED_INT, 0);
        }
        gl.bindVertexArray(null);
        if (city) {
            const prog = p.building;
            use(gl, prog, { ...common, uViewProj: viewProj, uClipY: clipY, uGrow: o.grow ?? 1, uLit: o.lit });
            bindShadows(prog);
            bindNoise(prog, 15);
            renderer.drawChunks(renderer.visibleChunks(null, eye));
            if (streets?.buffer) renderer.drawInstances(streets.buffer, streets.count);
            if (mc.landmarkProps?.count) renderer.drawInstances(mc.landmarkProps.buffer, mc.landmarkProps.count);
        }
    };

    const blitSky = (tex) => {
        gl.disable(gl.DEPTH_TEST);
        use(gl, p.copy, { uTex: { tex, unit: 0 } });
        renderer.draw();
    };

    const sample = () => {
        const frame = frames;
        const lodScale = renderer.lodScale;
        renderer.lodScale = 1000;
        gl.disable(gl.CULL_FACE);
        const isSun = frame % 2 === 0;
        const index = Math.floor(frame / 2) + 1;
        let L;
        if (isSun) {
            const r = Math.sqrt(halton(index, 2)) * o.sunDisc * Math.PI / 180, a = halton(index, 3) * 6.2831853;
            const base = keyDir;
            let ux = base[1], uy = -base[0], uz = 0;
            const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul;
            const vx = base[1] * uz - base[2] * uy, vy = base[2] * ux - base[0] * uz, vz = base[0] * uy - base[1] * ux;
            const c = Math.cos(a) * r, s = Math.sin(a) * r;
            L = [base[0] + ux * c + vx * s, base[1] + uy * c + vy * s, base[2] + vz * s];
            const len = Math.hypot(...L);
            L = L.map((v) => v / len);
            L[1] = Math.max(L[1], 0.008);
        } else {
            const y = Math.max(halton(index, 2), 0.03);
            const a = halton(index, 3) * 6.2831853;
            const rr = Math.sqrt(1 - y * y);
            L = [Math.cos(a) * rr, y, Math.sin(a) * rr];
        }
        const lightN = orthoLight(L, shadowCentre, nearRadius);
        const lightF = orthoLight(L, shadowCentre, farRadius);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.5, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, p.shNFb);
        gl.viewport(0, 0, p.nearSize, p.nearSize);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        use(gl, renderer.terrainShadowProg, { uC: { tex: terrainField.height.tex, unit: 0 }, uExtent: terrain.extent, uBase: baseElev, uLight: lightN });
        gl.bindVertexArray(terrain.mesh.vao);
        gl.drawElements(gl.TRIANGLES, terrain.mesh.count, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
        if (city) {
            use(gl, renderer.shadowProg, { uLight: lightN, uGrow: o.grow ?? 1 });
            renderer.drawChunks(renderer.visibleChunks(null, camera.target, shadowCentre, nearRadius * 1.5));
            if (streets?.buffer) renderer.drawInstances(streets.buffer, streets.count);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, p.shFFb);
        gl.viewport(0, 0, p.farSize, p.farSize);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        if (outer) {
            use(gl, p.outerShadow ?? (p.outerShadow = program(gl, OUTER_SHADOW_VS, 'void main() {}', 'beautyOuterShadow')), { uHeight: { tex: outer.heightTex.tex, unit: 0 }, uRect: outer.rect, uBase: baseElev, uLight: lightF });
            const shadowMesh = outer.shadowMesh ?? outer.mesh;
            gl.bindVertexArray(shadowMesh.vao);
            gl.drawElements(gl.TRIANGLES, shadowMesh.count, gl.UNSIGNED_INT, 0);
            gl.bindVertexArray(null);
        }
        gl.disable(gl.POLYGON_OFFSET_FILL);

        const jx = halton(frame + 1, 2) - 0.5, jy = halton(frame + 1, 3) - 0.5;
        if (mirrorOn) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.mirrorFb);
            gl.viewport(0, 0, w, h);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            blitSky(t.skyMirror.tex);
            // A little above the plane, or the lake's own surface hides everything mirrored in it.
            drawScene(viewProjFor(mirrorView, jx, jy), L, isSun, lightN, lightF, eyeMirror, mirrorY + 2.5, frame, true);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.hdrFb);
        gl.viewport(0, 0, w, h);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        blitSky(t.skyFront.tex);
        const vp = viewProjFor(view, jx, jy);
        drawScene(vp, L, isSun, lightN, lightF, eyeOrbit, -1e6, frame, false);
        if (night > 0.5 && renderer.movers.length && !streets) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.depthMask(false);
            for (const mover of renderer.movers) {
                use(gl, renderer.moverProg, { uSun: sunDir, uNight: 1, uEye: eyeOrbit, uFogK: 1 / 120000, uViewProj: vp, uClock: 500, uSizeM: mover.size, uStrength: mover.strength });
                gl.bindVertexArray(mover.vao);
                gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, mover.count);
            }
            gl.bindVertexArray(null);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
        }

        gl.disable(gl.DEPTH_TEST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.accumFb);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        use(gl, p.fog, {
            ...lightUniforms(L, isSun, lightN, lightF, eyeOrbit), uHdr: { tex: t.hdr.tex, unit: 0 }, uDepth: { tex: t.depth, unit: 1 }, uCityGlow: { tex: city?.glow?.tex ?? renderer.blank.tex, unit: 2 },
            uInverse: invert(vp), uRes: [w, h], uFrame: frame, uHaze: o.haze, uFog: [o.fogTop, o.fogSoft, o.fogRelief, o.fogDensity], uAir: o.air, uSunDir: keyDir,
            uExtentRect: [-half, -half, half, half],
        });
        bindShadows(p.fog);
        bindNoise(p.fog, 15);
        renderer.draw();
        gl.disable(gl.BLEND);
        frames++;
        renderer.lodScale = lodScale;
        restore();
    };

    const finish = (fb, width, height) => {
    const scale = 1 / Math.max(frames, 1);
    let source = t.accum;
    gl.disable(gl.DEPTH_TEST);
    for (let i = 0; i < t.levels.length; i++) {
        const level = t.levels[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, level.fb);
        gl.viewport(0, 0, level.w, level.h);
        use(gl, p.down, { uTex: { tex: source.tex, unit: 0 }, uStep: [1 / source.w, 1 / source.h], uGain: i === 0 ? scale : 1 });
        renderer.draw();
        source = level.t;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = t.levels.length - 1; i > 0; i--) {
        const dest = t.levels[i - 1], from = t.levels[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fb);
        gl.viewport(0, 0, dest.w, dest.h);
        use(gl, p.up, { uTex: { tex: from.t.tex, unit: 0 }, uStep: [1 / from.w, 1 / from.h] });
        renderer.draw();
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.bloomFb);
    gl.viewport(0, 0, w, h);
    use(gl, p.up, { uTex: { tex: t.levels[0].t.tex, unit: 0 }, uStep: [1 / t.levels[0].w, 1 / t.levels[0].h] });
    renderer.draw();

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, width, height);
    use(gl, p.finish, {
        uTex: { tex: t.accum.tex, unit: 0 }, uBloom: { tex: t.bloom.tex, unit: 1 }, uExposure: o.exposure, uBloomAmount: o.bloom, uSaturation: o.saturation, uContrast: o.contrast,
        uTint: o.tint, uShadowTint: o.shadowTint, uVignette: o.vignette, uGrain: o.grain, uScale: scale,
    });
    renderer.draw();
    };

    const present = () => {
        finish(null, gl.drawingBufferWidth, gl.drawingBufferHeight);
        restore();
    };
    const toPng = (credit) => {
        finish(t.outFb, w, h);
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        restore();
        const canvas2d = document.createElement('canvas');
        canvas2d.width = w;
        canvas2d.height = h;
        const ctx = canvas2d.getContext('2d', { willReadFrequently: true });
        const image = ctx.createImageData(w, h);
        for (let y = 0; y < h; y++) image.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        ctx.putImageData(image, 0, 0);
        if (credit) drawCredit(ctx, credit, w, h);
        return canvas2d.toDataURL('image/png');
    };
    const dispose = () => {
        gl.deleteTexture(envTex);
        gl.deleteFramebuffer(envFb);
        gl.deleteTexture(trans.tex);
    };
    return { prepare, sample, present, toPng, dispose, get frames() { return frames; }, get prepared() { return prepared; }, samples: o.samples };
}

function drawCredit(ctx, credit, w, h) {
    const size = Math.max(12, Math.round(w / 110));
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = size * 0.5;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(credit, size, h - size * 0.8);
}

export async function renderStill(mc, options) {
    const started = performance.now();
    const session = createSession(mc, options);
    await session.prepare();
    for (let i = 0; i < session.samples; i++) {
        session.sample();
        mc.beautyProgress = (i + 1) / session.samples;
        // One long task can make the watchdog kill the GPU process.
        if (i % 4 === 3) { mc.gl.finish(); await nextTick(); }
    }
    const url = session.toPng(options.credit);
    session.dispose();
    releaseTargets();
    return { url, ms: performance.now() - started, error: mc.gl.getError(), lost: mc.gl.isContextLost() };
}

export function lookOptions(look, { sun, night, baseElev }) {
    if (look === 'golden') return { sunAz: 285, sunEl: 4, cloudCover: 0.42 };
    if (look === 'fog') return { sunAz: 110, sunEl: 8, cloudCover: 0.25, fogTop: baseElev + 280, fogSoft: 70, fogRelief: 200, fogDensity: 0.005, exposure: 0.4 };
    if (look === 'blue') {
        return { sunAz: 320, sunEl: -5, night: 1, lit: 0.27, cloudCover: 0.32, haze: 5e-5, exposure: 1.9, nightSky: [0.01, 0.016, 0.04], moonE: 0.06, moonAz: 200, moonEl: 35, underglow: [0.1, 0.05, 0.02] };
    }
    const azimuth = (Math.atan2(sun[0], -sun[2]) * 180 / Math.PI + 360) % 360;
    const elevation = Math.asin(sun[1]) * 180 / Math.PI;
    if (night > 0.5) return { sunAz: azimuth, sunEl: elevation, night, lit: 0.27, cloudCover: 0.32, haze: 5e-5, exposure: 0.5 + 1.4 * night, nightSky: [0.01, 0.016, 0.04], moonE: 0.06, moonAz: 200, moonEl: 35, underglow: [0.1, 0.05, 0.02] };
    return { sunAz: azimuth, sunEl: elevation, night, exposure: 0.5 + 0.8 * night };
}

const OUTER_SHADOW_VS = `
in vec2 aPos;
uniform sampler2D uHeight;
uniform mat4 uLight;
uniform vec4 uRect;
uniform float uBase;
void main() {
    vec3 w = vec3(uRect.x + aPos.x * uRect.z, textureLod(uHeight, aPos, 0.0).r - uBase, uRect.y + aPos.y * uRect.w);
    gl_Position = uLight * vec4(w, 1.0);
}`;
