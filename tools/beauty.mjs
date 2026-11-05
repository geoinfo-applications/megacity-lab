// Offline stills through site/js/beauty.js. usage: beauty.mjs <hash> <outdir> @shots.json [only,names].
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const [hash, outdir, shotsArg, only] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const port = 9343;
const chrome = spawn('chromium', ['--headless=new', `--remote-debugging-port=${port}`, '--use-angle=vulkan', '--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--window-size=640,480', `--user-data-dir=${process.env.CHROME_DIR}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pend.get(d.id)?.(d); pend.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails).slice(0, 2500)); else if (d.method === 'Runtime.consoleAPICalled' && d.params.type !== 'log') logs.push(d.params.type + ' ' + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 2500)); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); if (r.result.exceptionDetails) logs.push('EV ' + JSON.stringify(r.result.exceptionDetails).slice(0, 800)); return r.result.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => { if (logs.length) console.log(logs.splice(0).join('\n')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:8820/index.html#${hash}&still` });
const t0 = Date.now();
for (let i = 0; i < 400; i++) { if (await ev('window.__mc?.ready===true && !!window.__mc.renderer.outer')) break; await sleep(500); flush(); }
console.log('ready after', Date.now() - t0, 'ms', JSON.stringify(await ev('(({buildings,trees,housed,tallestM,roadKm,bridges,footprintKm2})=>({buildings,trees,housed,tallestM,roadKm,bridges,footprintKm2}))(__mc.stats)')), JSON.stringify(await ev('({base:__mc.renderer.terrain.base, extent:__mc.renderer.terrain.extent, target:__mc.camera.target, outerRect:__mc.renderer.outer.rect})')));
const shots = JSON.parse(readFileSync(shotsArg.replace(/^@/, ''), 'utf8'));
for (const s of shots) {
    if (only && !only.split(',').includes(s.name)) continue;
    await ev(`window.__b=null;__mc.beauty(${JSON.stringify(s)}).then(r=>window.__b=r).catch(e=>{console.error(e.stack||e);window.__b={failed:String(e)}});0`);
    for (let i = 0; i < 1200; i++) { await sleep(500); flush(); if (await ev('!!window.__b')) break; }
    const meta = await ev('window.__b&&({ms:window.__b.ms,error:window.__b.error,lost:window.__b.lost,failed:window.__b.failed})');
    console.log(s.name, JSON.stringify(meta));
    // A 20 MB string in one CDP reply hangs the socket: fetch it in slices.
    const length = await ev('window.__b&&window.__b.url?window.__b.url.length:0');
    if (length) {
        let url = '';
        for (let at = 0; at < length; at += 2000000) url += await ev(`window.__b.url.slice(${at},${at + 2000000})`);
        writeFileSync(`${outdir}/${s.name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    }
    await ev('window.__b=null;0');
}
flush();
chrome.kill(); process.exit(0);
