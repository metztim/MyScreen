'use strict';

// The speech model for transcripts. The engine (whisper.cpp) ships inside
// the app; the model is too large for that (574 MB), so it is downloaded
// once, on request, into <userData>/models and verified before use.
//
// Pure Node (fetch, fs, crypto), so the tests drive it against a local
// HTTP server.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// whisper large-v3-turbo, 5-bit quantized: close to the full model's
// accuracy in every language at a third of the size. Size and SHA-256 are
// pinned to the file published by the whisper.cpp project.
const DEFAULT_MODEL = Object.freeze({
  name: 'ggml-large-v3-turbo-q5_0.bin',
  label: 'large-v3-turbo',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  sizeBytes: 574_041_195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
});

const FREE_SPACE_MARGIN = 1.1; // the part file and the final file never coexist, so little headroom is needed

function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Download `url` to `destPath`, resuming a previous attempt when a .part
// file is present. Rejects (and removes the file) if the result does not
// match `sizeBytes` / `sha256`. An abort keeps the .part file for next time.
async function downloadFile({ url, destPath, sizeBytes = 0, sha256 = null, onProgress = null, signal = null, fetchImpl = fetch }) {
  const partPath = `${destPath}.part`;
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  let offset = 0;
  try { offset = (await fsp.stat(partPath)).size; } catch { /* fresh download */ }
  if (sizeBytes && offset > sizeBytes) { await fsp.rm(partPath, { force: true }); offset = 0; }

  const report = (received, phase = 'downloading') => {
    if (onProgress) onProgress({ phase, receivedBytes: received, totalBytes: sizeBytes || 0, percent: sizeBytes ? Math.min(100, Math.floor((received / sizeBytes) * 100)) : 0 });
  };

  if (!(sizeBytes && offset === sizeBytes)) {
    const res = await fetchImpl(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal, redirect: 'follow' });
    if (offset && res.status === 200) {
      offset = 0; // the server ignored the range: start over
    } else if (!(res.ok || res.status === 206)) {
      throw new Error(`The download server answered ${res.status}.`);
    }

    const file = await fsp.open(partPath, offset ? 'a' : 'w');
    let received = offset;
    let lastReport = 0;
    report(received);
    try {
      for await (const chunk of res.body) {
        await file.write(chunk);
        received += chunk.length;
        const now = Date.now();
        if (now - lastReport > 200) { lastReport = now; report(received); }
      }
    } finally {
      await file.close();
    }
    report(received);
  }

  // Verify before the file can be picked up as a model.
  report(sizeBytes, 'verifying');
  const actualSize = (await fsp.stat(partPath)).size;
  const sizeOk = !sizeBytes || actualSize === sizeBytes;
  const hashOk = sizeOk && (!sha256 || (await sha256Of(partPath)) === sha256);
  if (!sizeOk || !hashOk) {
    await fsp.rm(partPath, { force: true });
    throw new Error(sizeOk ? 'The downloaded file failed its integrity check.' : 'The download was incomplete.');
  }
  await fsp.rename(partPath, destPath);
  return destPath;
}

// One model in one folder: is it there, fetch it, cancel a fetch.
class SpeechModel {
  constructor({ dir, spec = DEFAULT_MODEL, fetchImpl = fetch }) {
    this.dir = dir;
    this.spec = spec;
    this.fetchImpl = fetchImpl;
    this._active = null; // { controller, percent, promise }
  }

  get path() { return path.join(this.dir, this.spec.name); }
  get downloading() { return !!this._active; }

  async installed() {
    try {
      return (await fsp.stat(this.path)).size === this.spec.sizeBytes;
    } catch {
      return false;
    }
  }

  async status() {
    return {
      name: this.spec.name,
      label: this.spec.label,
      sizeBytes: this.spec.sizeBytes,
      installed: await this.installed(),
      downloading: this.downloading,
      percent: this._active ? this._active.percent : 0,
    };
  }

  // Starts (or joins) the download. `onEvent` receives
  // { state: 'downloading'|'verifying'|'done'|'cancelled'|'failed', percent, detail? }.
  start(onEvent = () => {}) {
    if (this._active) return this._active.promise;
    const controller = new AbortController();
    const active = { controller, percent: 0, promise: null };
    this._active = active;

    active.promise = (async () => {
      try {
        if (await this.installed()) { onEvent({ state: 'done', percent: 100 }); return true; }
        await this._checkFreeSpace();
        await downloadFile({
          url: this.spec.url, destPath: this.path,
          sizeBytes: this.spec.sizeBytes, sha256: this.spec.sha256,
          signal: controller.signal, fetchImpl: this.fetchImpl,
          onProgress: ({ phase, percent }) => {
            active.percent = percent;
            onEvent({ state: phase === 'verifying' ? 'verifying' : 'downloading', percent });
          },
        });
        onEvent({ state: 'done', percent: 100 });
        return true;
      } catch (err) {
        if (controller.signal.aborted) onEvent({ state: 'cancelled', percent: active.percent });
        else onEvent({ state: 'failed', percent: active.percent, detail: err.message });
        return false;
      } finally {
        this._active = null;
      }
    })();
    return active.promise;
  }

  cancel() {
    if (this._active) this._active.controller.abort();
  }

  async _checkFreeSpace() {
    if (!fsp.statfs) return;
    await fsp.mkdir(this.dir, { recursive: true });
    let already = 0;
    try { already = (await fsp.stat(`${this.path}.part`)).size; } catch { /* nothing yet */ }
    const { bavail, bsize } = await fsp.statfs(this.dir);
    const needed = (this.spec.sizeBytes - already) * FREE_SPACE_MARGIN;
    if (bavail * bsize < needed) {
      throw new Error(`Not enough free disk space: the speech model needs ${Math.ceil(needed / 1e6)} MB.`);
    }
  }
}

module.exports = { SpeechModel, downloadFile, DEFAULT_MODEL };
