// Minimal CDP driver for a visible chromium on :9333.
// usage: node cdp.mjs <cmd> [args]
//   nav <url>            navigate the first page tab and wait for load
//   eval <js>            evaluate (awaits promises), print JSON result
//   shot <file> [w h]    screenshot PNG
//   console              print captured console lines since the last call (stored in window.__log)
import { writeFileSync } from 'node:fs';

const base = `http://127.0.0.1:${process.env.CDP_PORT ?? 9333}`;
const tabs = await (await fetch(`${base}/json`)).json();
const page = tabs.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    } else events.push(msg);
};
await new Promise((r) => (ws.onopen = r));
function send(method, params = {}) {
    return new Promise((resolve) => {
        const i = ++id;
        pending.set(i, resolve);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
}

const [cmd, ...args] = process.argv.slice(2);
await send('Runtime.enable');
await send('Page.enable');
if (cmd === 'nav') {
    events.length = 0;
    await send('Page.navigate', { url: args[0] });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !events.some((e) => e.method === 'Page.loadEventFired')) await new Promise((r) => setTimeout(r, 100));
    const wait = Number(args[1] ?? 0);
    const logs = [];
    const t1 = Date.now();
    while (Date.now() - t1 < wait) await new Promise((r) => setTimeout(r, 100));
    const start = events.findIndex((e) => e.method === 'Page.frameNavigated');
    for (const e of events.slice(Math.max(0, start))) {
        if (e.method === 'Runtime.consoleAPICalled') logs.push(e.params.type + ': ' + e.params.args.map((a) => a.value ?? a.description).join(' '));
        if (e.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (e.params.exceptionDetails.exception?.description ?? JSON.stringify(e.params.exceptionDetails)).slice(0, 600));
    }
    console.log(logs.join('\n'));
} else if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: args[0], awaitPromise: true, returnByValue: true, timeout: 60000 });
    console.log(JSON.stringify(r.result.result?.value ?? r.result, null, 1));
} else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
    console.log('saved', args[0]);
} else if (cmd === 'emulate') {
    // emulate <w> <h> [dpr] | emulate off
    if (args[0] === 'off') await send('Emulation.clearDeviceMetricsOverride');
    else await send('Emulation.setDeviceMetricsOverride', { width: +args[0], height: +args[1], deviceScaleFactor: +(args[2] ?? 1), mobile: +args[0] < 800 });
} else if (cmd === 'record') {
    // record <seconds> <outdir> [js to run at start]: screencast frames + an ffmpeg concat list with real durations.
    const { mkdirSync } = await import('node:fs');
    const [seconds, outdir, startJs] = args;
    mkdirSync(outdir, { recursive: true });
    const frames = [];
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        } else if (msg.method === 'Page.screencastFrame') {
            const n = frames.length + 1;
            const file = `${outdir}/f${String(n).padStart(5, '0')}.jpg`;
            writeFileSync(file, Buffer.from(msg.params.data, 'base64'));
            frames.push({ file, t: msg.params.metadata.timestamp });
            ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }));
        }
    };
    if (startJs) await send('Runtime.evaluate', { expression: startJs });
    await send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
    await new Promise((r) => setTimeout(r, Number(seconds) * 1000));
    await send('Page.stopScreencast');
    const lines = [];
    for (let i = 0; i < frames.length; i++) {
        const dur = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1 / 30;
        lines.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(4)}`);
    }
    lines.push(`file '${frames[frames.length - 1].file}'`);
    writeFileSync(`${outdir}/list.txt`, lines.join('\n') + '\n');
    console.log('frames', frames.length);
} else if (cmd === 'key') {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: args[0], code: args[1] ?? args[0] });
} else if (cmd === 'mouse') {
    // mouse <type> x y [button]
    await send('Input.dispatchMouseEvent', { type: args[0], x: +args[1], y: +args[2], button: args[3] ?? 'left', clickCount: 1 });
}
ws.close();
process.exit(0);
