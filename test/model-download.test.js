'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { SpeechModel, downloadFile, DEFAULT_MODEL } = require('../model-download');

// A stand-in for the model host: serves one "model" with range support and
// records what was asked of it.
async function startServer(body, { ignoreRange = false, slow = false } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const range = req.headers.range;
    requests.push(range || 'full');
    let start = 0;
    if (range && !ignoreRange) start = Number(range.match(/bytes=(\d+)-/)[1]);
    const slice = body.subarray(start);
    res.writeHead(range && !ignoreRange ? 206 : 200, { 'Content-Length': slice.length });
    if (!slow) { res.end(slice); return; }
    // Dribble it out so a test can cancel midway.
    for (let i = 0; i < slice.length; i += 4096) {
      if (res.destroyed) return;
      res.write(slice.subarray(i, i + 4096));
      await new Promise((r) => setTimeout(r, 5));
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/model.bin`, requests, close: () => new Promise((r) => server.close(r)) };
}

const body = crypto.randomBytes(200_000);
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const spec = (url) => ({ name: 'ggml-test.bin', label: 'test', url, sizeBytes: body.length, sha256 });

async function freshDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-model-'));
}

test('the pinned model is the published whisper.cpp file', () => {
  assert.match(DEFAULT_MODEL.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-.*\.bin$/);
  assert.strictEqual(DEFAULT_MODEL.sha256.length, 64);
  assert.ok(DEFAULT_MODEL.sizeBytes > 100e6);
});

test('downloads, reports progress, verifies, and only then exposes the model file', async () => {
  const dir = await freshDir();
  const server = await startServer(body);
  const model = new SpeechModel({ dir, spec: spec(server.url) });
  assert.strictEqual((await model.status()).installed, false);

  const events = [];
  assert.strictEqual(await model.start((e) => events.push(e)), true);

  assert.deepStrictEqual(await fsp.readFile(model.path), body);
  assert.strictEqual((await model.status()).installed, true);
  assert.strictEqual(events.at(-1).state, 'done');
  assert.ok(events.some((e) => e.state === 'verifying'));
  assert.ok(events.filter((e) => e.state === 'downloading').every((e) => e.percent >= 0 && e.percent <= 100));
  assert.deepStrictEqual((await fsp.readdir(dir)).sort(), ['ggml-test.bin'], 'no part file left behind');

  // Already installed: nothing is fetched again.
  await model.start();
  assert.strictEqual(server.requests.length, 1);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('resumes an interrupted download from where it stopped', async () => {
  const dir = await freshDir();
  const server = await startServer(body);
  const dest = path.join(dir, 'ggml-test.bin');
  await fsp.writeFile(`${dest}.part`, body.subarray(0, 50_000));

  await downloadFile({ url: server.url, destPath: dest, sizeBytes: body.length, sha256 });
  assert.deepStrictEqual(server.requests, ['bytes=50000-']);
  assert.deepStrictEqual(await fsp.readFile(dest), body);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('starts over when the server does not honor the resume request', async () => {
  const dir = await freshDir();
  const server = await startServer(body, { ignoreRange: true });
  const dest = path.join(dir, 'ggml-test.bin');
  await fsp.writeFile(`${dest}.part`, Buffer.alloc(50_000, 1)); // wrong bytes on purpose

  await downloadFile({ url: server.url, destPath: dest, sizeBytes: body.length, sha256 });
  assert.deepStrictEqual(await fsp.readFile(dest), body);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a file that fails the integrity check is discarded, never installed', async () => {
  const dir = await freshDir();
  const tampered = Buffer.from(body); tampered[1000] ^= 0xff;
  const server = await startServer(tampered);
  const model = new SpeechModel({ dir, spec: spec(server.url) });

  const events = [];
  assert.strictEqual(await model.start((e) => events.push(e)), false);
  assert.strictEqual(events.at(-1).state, 'failed');
  assert.match(events.at(-1).detail, /integrity check/);
  assert.deepStrictEqual(await fsp.readdir(dir), []);
  assert.strictEqual((await model.status()).installed, false);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('cancel stops the download and keeps what arrived for the next attempt', async () => {
  const dir = await freshDir();
  const server = await startServer(body, { slow: true });
  const model = new SpeechModel({ dir, spec: spec(server.url) });

  const events = [];
  const run = model.start((e) => { events.push(e); if (e.state === 'downloading' && e.percent >= 10) model.cancel(); });
  assert.strictEqual(model.downloading, true);
  assert.strictEqual(await run, false);
  assert.strictEqual(events.at(-1).state, 'cancelled');
  assert.strictEqual(model.downloading, false);

  const kept = (await fsp.stat(`${model.path}.part`)).size;
  assert.ok(kept > 0 && kept < body.length, 'a partial file remains');
  assert.strictEqual((await model.status()).installed, false);

  // The second attempt asks only for the rest.
  assert.strictEqual(await model.start(), true);
  assert.strictEqual(server.requests.at(-1), `bytes=${kept}-`);
  assert.deepStrictEqual(await fsp.readFile(model.path), body);

  await server.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a server error is reported as a failure', async () => {
  const dir = await freshDir();
  const server = http.createServer((req, res) => { res.writeHead(503); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const model = new SpeechModel({ dir, spec: spec(`http://127.0.0.1:${server.address().port}/x`) });
  const events = [];
  assert.strictEqual(await model.start((e) => events.push(e)), false);
  assert.match(events.at(-1).detail, /503/);
  await new Promise((r) => server.close(r));
  await fsp.rm(dir, { recursive: true, force: true });
});
