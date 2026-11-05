// Headless real-GPU driver. usage: shoot.mjs <hash> <outdir> '<json list of {name, view, wait}>' [w h]. Prints stats, console errors, fps per view.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const [hash, outdir, listJson, W = '1920', H = '1080'] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const port = 9342;
const chrome = spawn('chromium', ['--headless=new', `--remote-debugging-port=${port}`, '--use-angle=vulkan', '--ignore-gpu-blocklist', `--window-size=${W},${H}`, `--user-data-dir=${process.env.CHROME_DIR ?? '/tmp/chrome-shoot'}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onclose = () => { console.log('socket closed'); for (const f of pend.values()) f({ result: {} }); };
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pend.get(d.id)?.(d); pend.delete(d.id); } else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(d.params.exceptionDetails).slice(0, 1500)); else if (d.method === 'Runtime.consoleAPICalled' && d.params.type !== 'log') logs.push(d.params.type + ' ' + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 3000)); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.has(i)) { pend.delete(i); res({ result: { timeout: true } }); } }, 90000); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: 80000 }); return r.result.result?.value ?? r.result; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: +W < 800 ? 2 : 1, mobile: +W < 800 });
await send('Page.navigate', { url: `http://127.0.0.1:8820/index.html#${hash}` });
const t0 = Date.now();
for (let i = 0; i < 240; i++) { if (hash ? await ev('window.__mc?.ready===true') : await ev('window.__mc?.booted===true')) break; await sleep(500); }
console.log('ready after', Date.now() - t0, 'ms');
console.log(JSON.stringify(await ev('window.__mc?.stats')));
for (const v of JSON.parse(listJson.startsWith('@') ? readFileSync(listJson.slice(1), 'utf8') : listJson)) {
    if (v.eval) await ev(v.eval);
    if (v.view) await ev(`__mc.view(${JSON.stringify(v.view)})`);
    await sleep(v.wait ?? 4000);
    console.log(v.name, JSON.stringify(await ev('__mc.fps?.()')));
    if (v.name) { const s = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outdir}/${v.name}.png`, Buffer.from(s.result.data, 'base64')); }
}
console.log(logs.slice(-12).join('\n') || 'no console errors');
chrome.kill(); process.exit(0);
