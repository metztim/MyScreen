'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const RecordingWriter = require('../recording-writer');

async function freshBaseDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-writer-test-'));
}

test('writes chunks to disk in order and reconstructs the exact stream', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const id = 'rec-order';

  await writer.start({ recordingId: id, mimeType: 'video/webm' });

  const chunks = [
    Buffer.from('EBML-header-and-first-cluster'),
    Buffer.from('second-cluster-bytes'),
    Buffer.from('third-cluster-bytes'),
  ];
  for (const c of chunks) await writer.write(id, c);

  const result = await writer.finalize(id);
  const onDisk = await fsp.readFile(result.filePath);

  assert.deepStrictEqual(onDisk, Buffer.concat(chunks), 'on-disk file must equal in-order concatenation');
  assert.strictEqual(result.bytesWritten, Buffer.concat(chunks).length);

  const sidecar = JSON.parse(await fsp.readFile(writer.sidecarPathFor(id), 'utf-8'));
  assert.strictEqual(sidecar.status, 'finalized');

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('accepts ArrayBuffer chunks (the IPC transfer shape)', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const id = 'rec-arraybuffer';

  await writer.start({ recordingId: id, mimeType: 'video/webm' });
  const ab = new Uint8Array([1, 2, 3, 4, 5]).buffer;
  await writer.write(id, ab);
  const result = await writer.finalize(id);

  const onDisk = await fsp.readFile(result.filePath);
  assert.deepStrictEqual(onDisk, Buffer.from([1, 2, 3, 4, 5]));

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('handles many small chunks (exercises backpressure path)', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const id = 'rec-many';

  await writer.start({ recordingId: id, mimeType: 'video/webm' });
  const chunk = Buffer.alloc(64 * 1024, 7); // 64 KB
  const n = 200; // ~12.8 MB, enough to fill the stream's buffer and force drains
  for (let i = 0; i < n; i++) await writer.write(id, chunk);
  const result = await writer.finalize(id);

  const stat = await fsp.stat(result.filePath);
  assert.strictEqual(stat.size, 64 * 1024 * n);
  assert.strictEqual(result.bytesWritten, 64 * 1024 * n);

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('listOrphans finds a recording that was never finalized (crash survivor)', async () => {
  const baseDir = await freshBaseDir();
  const id = 'rec-crash';

  // Simulate a crash: start + write, but never finalize, then "restart" with a new writer.
  const crashed = new RecordingWriter({ baseDir });
  await crashed.start({ recordingId: id, mimeType: 'video/webm', suggestedName: 'meeting.webm' });
  await crashed.write(id, Buffer.from('partial-but-valid-recording-bytes'));
  // (no finalize, no close: the stream is left open, mimicking kill -9)

  const restarted = new RecordingWriter({ baseDir });
  const orphans = await restarted.listOrphans();

  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].recordingId, id);
  assert.strictEqual(orphans[0].status, 'recording');
  assert.strictEqual(orphans[0].suggestedName, 'meeting.webm');
  assert.ok(orphans[0].size > 0);

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('abort removes the file and sidecar', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const id = 'rec-abort';

  await writer.start({ recordingId: id, mimeType: 'video/webm' });
  await writer.write(id, Buffer.from('some-bytes'));
  await writer.abort(id);

  assert.strictEqual(fs.existsSync(writer.filePathFor(id)), false);
  assert.strictEqual(fs.existsSync(writer.sidecarPathFor(id)), false);
  assert.deepStrictEqual(await writer.listOrphans(), []);

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('discard removes a finalized recording (post-save cleanup)', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const id = 'rec-discard';

  await writer.start({ recordingId: id, mimeType: 'video/webm' });
  await writer.write(id, Buffer.from('bytes'));
  await writer.finalize(id);
  await writer.discard(id);

  assert.strictEqual(fs.existsSync(writer.filePathFor(id)), false);
  assert.strictEqual(fs.existsSync(writer.sidecarPathFor(id)), false);

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('listOrphans cleans up a zero-byte recording rather than offering it', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const id = 'rec-empty';

  await writer.start({ recordingId: id, mimeType: 'video/webm' });
  // No writes at all, then crash (no finalize).
  const restarted = new RecordingWriter({ baseDir });
  const orphans = await restarted.listOrphans();

  assert.deepStrictEqual(orphans, []);
  assert.strictEqual(fs.existsSync(writer.sidecarPathFor(id)), false);

  await fsp.rm(baseDir, { recursive: true, force: true });
});
