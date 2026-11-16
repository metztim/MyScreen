'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LibraryStore = require('../library-store');
const ffmpegPath = require('ffmpeg-static');

async function freshDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// A real (tiny) video, so the store's ffmpeg probe has something to read.
function makeClip(filePath, seconds) {
  const result = spawnSync(ffmpegPath, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x200:rate=10`,
    '-t', String(seconds), '-pix_fmt', 'yuv420p', filePath,
  ]);
  assert.strictEqual(result.status, 0, String(result.stderr));
}

function listAndWaitForMeta(store, folder, expected) {
  return new Promise((resolve, reject) => {
    const metas = [];
    const timer = setTimeout(() => reject(new Error('timed out waiting for library metadata')), 20000);
    const done = (entries) => { clearTimeout(timer); resolve({ entries, metas }); };
    let listed = null;
    store.list(folder, (meta) => {
      metas.push(meta);
      if (listed && metas.length >= expected) done(listed);
    }).then((entries) => {
      listed = entries;
      if (metas.length >= expected) done(entries);
    }, reject);
  });
}

test('probes each file once: a second launch reads thumbnails and durations from the cache', async () => {
  const folder = await freshDir('myscreen-lib-');
  const cacheDir = await freshDir('myscreen-thumbs-');
  makeClip(path.join(folder, 'two-seconds.mp4'), 2);
  makeClip(path.join(folder, 'half-second.mp4'), 0.5); // no frame at 1s: needs the first-frame fallback
  await fsp.writeFile(path.join(folder, '.saving.part.mp4'), 'half-written output'); // must be ignored
  await fsp.writeFile(path.join(folder, 'notes.txt'), 'not a video');

  const first = new LibraryStore({ ffmpegPath, cacheDir });
  const { entries, metas } = await listAndWaitForMeta(first, folder, 2);
  assert.deepStrictEqual(entries.map((e) => e.name).sort(), ['half-second.mp4', 'two-seconds.mp4']);
  for (const meta of metas) {
    assert.ok(meta.thumbnailDataUrl && meta.thumbnailDataUrl.startsWith('data:image/jpeg'), `${meta.path} has a thumbnail`);
    assert.ok(meta.durationSeconds > 0, `${meta.path} has a duration`);
  }
  await first._saveIndex();

  // "Next launch": a new store over the same cache must not spawn ffmpeg.
  const second = new LibraryStore({ ffmpegPath, cacheDir });
  let probes = 0;
  second._runFfmpeg = async () => { probes++; return ''; };
  const again = await second.list(folder, () => {});
  assert.strictEqual(probes, 0);
  assert.strictEqual(again.length, 2);
  for (const entry of again) {
    assert.ok(entry.thumbnailDataUrl, `${entry.name} thumbnail comes from the cache`);
    assert.ok(entry.durationSeconds > 0, `${entry.name} duration comes from the cache`);
  }

  await fsp.rm(folder, { recursive: true, force: true });
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

test('metaFor returns the thumbnail for a single file and prunes entries for deleted files', async () => {
  const folder = await freshDir('myscreen-lib-');
  const cacheDir = await freshDir('myscreen-thumbs-');
  const clip = path.join(folder, 'clip.mp4');
  makeClip(clip, 2);

  const store = new LibraryStore({ ffmpegPath, cacheDir });
  const meta = await store.metaFor(clip);
  assert.ok(meta.thumbnailDataUrl.startsWith('data:image/jpeg'));
  assert.ok(meta.durationSeconds >= 1.9);
  const thumbs = (await fsp.readdir(cacheDir)).filter((n) => n.endsWith('.jpg'));
  assert.strictEqual(thumbs.length, 1);

  await fsp.rm(clip);
  assert.deepStrictEqual(await store.list(folder, () => {}), []);
  await new Promise((r) => setTimeout(r, 50)); // the thumbnail removal is fire-and-forget
  assert.deepStrictEqual((await fsp.readdir(cacheDir)).filter((n) => n.endsWith('.jpg')), []);

  await fsp.rm(folder, { recursive: true, force: true });
  await fsp.rm(cacheDir, { recursive: true, force: true });
});
