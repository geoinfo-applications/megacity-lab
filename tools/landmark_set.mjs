// Stills with a real landmark in frame, placed in LV95 from real coordinates. usage: OUT=dir CHROME_DIR=dir node tools/landmark_set.mjs 2160x2700 128 [name,name]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT;
mkdirSync(OUT, { recursive: true });
const [W, H] = (process.argv[2] ?? '648x810').split('x').map(Number);
const SAMPLES = +(process.argv[3] ?? 40);
const only = process.argv[4]?.split(',');
const CITY = 'population=7500000&density=45000&maxFloors=90&centres=3&danji=0.9&slopeLimit=24&riverWiden=0&seed=1&hour=14';
const NIGHT = { sunEl: -5, night: 1, lit: 0.27, cloudCover: 0.32, haze: 5e-5, exposure: 1.9, nightSky: [0.01, 0.016, 0.04], moonE: 0.06, moonAz: 200, moonEl: 35, underglow: [0.1, 0.05, 0.02] };
const CHURFIRSTEN = [['Leistchamm', 2734591, 1223193, 2101], ['Selun', 2737780, 1223996, 2205], ['Frümsel', 2738572, 1223980, 2266], ['Brisi', 2739423, 1224093, 2278], ['Zuestoll', 2740047, 1224215, 2234], ['Schibenstoll', 2740810, 1224265, 2235], ['Chäserrugg', 2742082, 1224343, 2261]];
const SAENTIS = [['Säntis', 2744171, 1234917, 2502], ['Altmann', 2746340, 1233872, 2435]];
const PLACES = [
    { name: 'Flawil', hash: 'e=2731000&n=1254000&maxRise=0', shots: [
        { id: 'flawil_saentis_abend', eye: [2726900, 1260300, 830], look: [2743900, 1235100, 1500], fov: 0.17, ahead: 7000, landmarks: ['alpstein'], labels: SAENTIS, snow: 1800, sunAz: 292, sunEl: 5, air: 1 / 110000 },
        { id: 'flawil_saentis_nebel', eye: [2726900, 1260300, 1010], look: [2743900, 1235100, 1450], fov: 0.17, ahead: 7000, landmarks: ['alpstein'], labels: SAENTIS, snow: 1800, sunAz: 120, sunEl: 8, air: 1 / 110000, cloudCover: 0.2, fogTop: 737, fogSoft: 70, fogRelief: 200, fogDensity: 0.005, exposure: 0.42 },
        { id: 'flawil_saentis_nacht', eye: [2726900, 1260300, 830], look: [2743900, 1235100, 1500], fov: 0.17, ahead: 7000, landmarks: ['alpstein'], labels: SAENTIS, snow: 1800, ...NIGHT, sunAz: 300, moonAz: 320, moonEl: 30, moonE: 0.26, air: 1 / 110000 },
    ] },
    { name: 'Rorschach', hash: 'e=2754800&n=1260675&maxRise=330', shots: [
        { id: 'rorschach_saentis_see', eye: [2757000, 1267300, 412], look: [2743700, 1235100, 1200], fov: 0.15, ahead: 7000, landmarks: ['alpstein'], labels: SAENTIS, snow: 1800, sunAz: 318, sunEl: 7, mirrorElev: 395.6, air: 1 / 110000, exposure: 0.6 },
        { id: 'rorschach_saentis_nacht', eye: [2757000, 1267300, 412], look: [2743700, 1235100, 1200], fov: 0.15, ahead: 7000, landmarks: ['alpstein'], labels: SAENTIS, snow: 1800, ...NIGHT, sunAz: 300, moonAz: 320, moonEl: 30, moonE: 0.26, mirrorElev: 395.6, air: 1 / 110000 },
    ] },
    { name: 'Rapperswil', hash: 'e=2704000&n=1231500&maxRise=0&clearE=2704193&clearN=1231616&clearR=210', shots: [
        { id: 'rapperswil_schloss_see', labels: [['Schloss Rapperswil', 2704193, 1231616, 487]], eye: [2702250, 1231330, 413], look: [2704300, 1231590, 500], fov: 0.3, ahead: 2000, sunAz: 275, sunEl: 7, mirrorElev: 406, exposure: 0.52 },
        { id: 'rapperswil_schloss_nah', labels: [['Schloss Rapperswil', 2704193, 1231616, 487]], eye: [2703560, 1231420, 412], look: [2704193, 1231616, 462], fov: 0.42, ahead: 660, sunAz: 265, sunEl: 11, mirrorElev: 406, exposure: 0.52 },
    ] },
    { name: 'Walenstadt', hash: 'e=2742350&n=1220950&maxRise=500', shots: [
        { id: 'walenstadt_churfirsten_flumserberg', eye: [2743500, 1215500, 1420], look: [2742300, 1224200, 950], fov: 0.82, ahead: 4000, landmarks: ['churfirsten'], labels: CHURFIRSTEN, snow: 1950, sunAz: 245, sunEl: 12, air: 1 / 110000, land: 0.85 },
        { id: 'walenstadt_churfirsten_see', eye: [2734300, 1220500, 432], look: [2742900, 1223100, 1000], fov: 0.95, ahead: 6000, landmarks: ['churfirsten'], labels: CHURFIRSTEN, snow: 1950, sunAz: 215, sunEl: 13, mirrorElev: 419.7, air: 1 / 110000, land: 0.85 },
    ] },
    { name: 'Nesslau', hash: 'e=2733350&n=1231825&maxRise=550', shots: [
        { id: 'nesslau_churfirsten_abend', eye: [2731000, 1236100, 1130], look: [2738600, 1224000, 1420], fov: 0.3, ahead: 5000, landmarks: ['churfirsten'], labels: CHURFIRSTEN, snow: 1950, sunAz: 292, sunEl: 8, air: 1 / 110000 },
        { id: 'nesslau_churfirsten_nacht', eye: [2731000, 1236100, 1130], look: [2738600, 1224000, 1420], fov: 0.3, ahead: 5000, landmarks: ['churfirsten'], labels: CHURFIRSTEN, snow: 1950, ...NIGHT, sunAz: 300, moonAz: 330, moonEl: 28, moonE: 0.26, air: 1 / 110000 },
    ] },
];
const port = 9350;
const chrome = spawn('chromium', ['--headless=new', `--remote-debugging-port=${port}`, '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=640,480', `--user-data-dir=${process.env.CHROME_DIR}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pend.get(d.id)?.(d); pend.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails).slice(0, 600)); else if (d.method === 'Runtime.consoleAPICalled' && d.params.type !== 'log') logs.push(d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 600)); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); if (r.result.exceptionDetails) logs.push('EV ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500)); return r.result.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable'); await send('Page.enable');
for (const place of PLACES) {
    const shots = place.shots.filter((s) => !only || only.includes(s.id));
    if (!shots.length) continue;
    await send('Page.navigate', { url: 'about:blank' }); await sleep(300);
    await send('Page.navigate', { url: `http://127.0.0.1:8820/index.html#${place.hash}&name=${place.name}&${CITY}&still` });
    await sleep(800);
    for (let i = 0; i < 200; i++) { if (await ev('window.__mc?.ready===true&&!!__mc.renderer.outer')) break; await sleep(500); }
    const stats = await ev('(({buildings,housed,tallestM})=>({buildings,housed:Math.round(housed),tallestM:Math.round(tallestM)}))(__mc.stats)');
    console.log(place.name, JSON.stringify(stats));
    for (const shot of shots) {
        const base = await ev('__mc.renderer.terrain.base');
        const worldEye = await ev(`__mc.worldOf(${shot.eye[0]},${shot.eye[1]})`);
        const heading = (Math.atan2(shot.look[0] - shot.eye[0], shot.look[1] - shot.eye[1]) * 180 / Math.PI + 360) % 360;
        const down = -Math.atan2(shot.look[2] - shot.eye[2], Math.hypot(shot.look[0] - shot.eye[0], shot.look[1] - shot.eye[1])) * 180 / Math.PI;
        const { id: name, eye, look, fov, ahead, labels, ...light } = shot;
        const opt = { ...light, w: W, h: H, samples: SAMPLES, eye: { x: worldEye.x, y: eye[2] - base, z: worldEye.z, heading, down, fov, ahead } };
        await ev(`window.__b=null;__mc.beauty(${JSON.stringify(opt)}).then(r=>window.__b=r).catch(e=>{console.error(e.stack||e);window.__b={failed:String(e)}});0`);
        for (let i = 0; i < 400; i++) { await sleep(400); if (await ev('!!window.__b')) break; }
        console.log(name, JSON.stringify(await ev('({ms:Math.round(__b.ms),e:__b.error,f:__b.failed})')));
        const placed = await ev(`(()=>{const m=__mc.camera.matrices(${W / H}).viewProj;const base=__mc.renderer.terrain.base;return ${JSON.stringify(labels ?? [])}.map(([label,e,n,elev])=>{const w=__mc.worldOf(e,n),y=elev-base;const c=[m[0]*w.x+m[4]*y+m[8]*w.z+m[12],m[1]*w.x+m[5]*y+m[9]*w.z+m[13],m[3]*w.x+m[7]*y+m[11]*w.z+m[15]];return {label,elev,x:(c[0]/c[2]*.5+.5),y:(.5-c[1]/c[2]*.5)}})})()`);
        writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ place: place.name, stats, labels: placed }, null, 1));
        const length = await ev('window.__b.url?.length??0');
        let url = '';
        for (let at = 0; at < length; at += 2000000) url += await ev(`window.__b.url.slice(${at},${at + 2000000})`);
        if (url) writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
}
console.log(logs.join('\n') || 'no errors');
chrome.kill(); process.exit(0);
