/* Marketing screenshot rig: drives the real UI over CDP with fake capture streams
   and saves 2x screenshots of key states (ready / recording / saved+share).

   Usage:
     1. Put content assets in /tmp/myscreen-shoot/: repo-page.png (fake screen content),
        tim-avatar.png (camera bubble content; any square JPEG works).
     2. BACK UP ~/Library/Application Support/myscreen-v2/settings.json (dev shares
        userData with the packaged app; UI state changes persist). Restore it after.
     3. npx electron . --remote-debugging-port=9223
     4. node test/marketing-screenshots.js   -> scenes saved to /tmp/myscreen-shoot/

   First used for the 2026-06-12 launch post; reuse for release marketing images. */
const fs = require('fs');

const OUT = '/tmp/myscreen-shoot';
const avatarB64 = fs.readFileSync(`${OUT}/tim-avatar.png`).toString('base64'); // jpeg content
const screenB64 = fs.readFileSync(`${OUT}/repo-page.png`).toString('base64');

let msgId = 0;
const pending = new Map();
let ws;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result && r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  console.log('captured', name);
}

async function main() {
  // find the page target
  let target;
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9223/json')).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (target) break;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  if (!target) throw new Error('no page target found');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  await send('Page.enable');
  // retina-crisp output
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });

  // wait for the app to mount
  for (let i = 0; i < 20; i++) {
    const ready = await evaluate('!!window.__ms', false);
    if (ready) break;
    await sleep(500);
  }

  // install fake capture BEFORE driving state, so syncPreview/syncCamera grab fake streams
  await evaluate(`(async () => {
    const mkImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img load failed')); i.src = src; });
    const avatar = await mkImg('data:image/jpeg;base64,${avatarB64}');
    const screenImg = await mkImg('data:image/png;base64,${screenB64}');
    const mkStream = (img, w, h) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      const draw = () => {
        const s = Math.max(w / img.width, h / img.height);
        const dw = img.width * s, dh = img.height * s;
        ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        requestAnimationFrame(draw);
      };
      draw();
      return c.captureStream(30);
    };
    const silentTrack = () => {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const dst = ac.createMediaStreamDestination();
      const osc = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0;
      osc.connect(g); g.connect(dst); osc.start();
      return dst.stream.getAudioTracks()[0];
    };
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const v = constraints && constraints.video;
      const isDesktop = v && v.mandatory && v.mandatory.chromeMediaSource === 'desktop';
      if (isDesktop) {
        const s = mkStream(screenImg, 1920, 1080);
        if (constraints.audio) s.addTrack(silentTrack());
        return s;
      }
      if (v) return mkStream(avatar, 640, 640);
      const s = new MediaStream(); s.addTrack(silentTrack()); return s;
    };
    return 'ok';
  })()`);
  console.log('getUserMedia overridden');

  // --- scene A: ready, full-screen source selected, camera bubble on ---
  await evaluate(`window.__ms.set({
    view: 'recorder', flow: 'ready', mode: 'screen',
    screenSource: { id: 'screen:0:0', name: 'Built-in Display' },
    camOn: true, micOn: true,
    permState: { screen: 'ok', cam: 'ok', mic: 'ok' },
  })`, false);
  await sleep(2000);
  await shot('scene-a-ready');

  // --- scene B: recording in progress ---
  await evaluate(`window.__ms.set({ flow: 'recording', elapsed: 83 })`, false);
  await sleep(800);
  await shot('scene-b-recording');

  // --- scene C: saved sheet with Dropbox share link ready ---
  await evaluate(`window.__ms.set({
    flow: 'saved',
    lastFileName: 'MyScreen 2026-06-12 at 10.41.32.mp4',
    lastDuration: 83, format: 'mp4', quality: 'balanced',
    folder: '~/Movies/MyScreen',
    shareLink: true,
    dropbox: { connected: true, account: 'Tim', appKeySet: true },
    shareState: 'ready',
    shareUrl: 'https://www.dropbox.com/s/9x2kqf/MyScreen-2026-06-12.mp4',
  })`, false);
  await sleep(800);
  await shot('scene-c-saved');

  // state dump for debugging
  const state = await evaluate(`(() => { const s = window.__ms.get(); return { flow: s.flow, view: s.view, camOn: s.camOn, hasPreview: !!s.previewStream, hasCam: !!s.camStream, perm: s.permState }; })()`, false);
  console.log('final state:', JSON.stringify(state));
  ws.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
