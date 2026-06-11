'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const RecordingEngine = require('../recording-engine');
const RecordingWriter = require('../recording-writer');

// --- minimal browser fakes ---------------------------------------------------

function fakeBlob(buf) {
  return { size: buf.length, arrayBuffer: async () => Uint8Array.from(buf).buffer };
}

class FakeTrack {
  constructor(kind) { this.kind = kind; this.stopped = false; }
  stop() { this.stopped = true; }
}

class FakeMediaStream {
  constructor(tracks = []) { this._tracks = [...tracks]; }
  addTrack(t) { this._tracks.push(t); }
  getTracks() { return this._tracks; }
  getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
}

class FakeMediaRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    FakeMediaRecorder.instances.push(this);
  }
  static isTypeSupported() { return true; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    // Real MediaRecorder dispatches 'stop' asynchronously after the final
    // 'dataavailable'. Defer so any chunks emitted before stop() are chained.
    setTimeout(() => { if (this.onstop) this.onstop(); }, 0);
  }
  pause() { if (this.state === 'recording') this.state = 'paused'; }
  resume() { if (this.state === 'paused') this.state = 'recording'; }
  emit(buf) { if (this.ondataavailable) this.ondataavailable({ data: fakeBlob(buf) }); }
}
FakeMediaRecorder.instances = [];

const fakeMediaDevices = {
  getUserMedia: async (constraints) => {
    const tracks = [];
    if (constraints.video) tracks.push(new FakeTrack('video'));
    if (constraints.audio) tracks.push(new FakeTrack('audio'));
    return new FakeMediaStream(tracks);
  },
};

async function freshBaseDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-engine-test-'));
}

// API bound to a real RecordingWriter, with per-chunk latency we control to
// stress the ordering guarantee.
function makeApi(writer, delays = []) {
  let i = 0;
  return {
    recordingStart: (meta) => writer.start(meta),
    recordingChunk: async (recordingId, chunk) => {
      const d = delays[i++] ?? 0;
      if (d) await new Promise((r) => setTimeout(r, d));
      return writer.write(recordingId, Buffer.from(chunk));
    },
    recordingFinalize: (recordingId) => writer.finalize(recordingId),
    recordingAbort: (recordingId) => writer.abort(recordingId),
  };
}

function makeEngine(api) {
  return new RecordingEngine({
    api,
    MediaRecorder: FakeMediaRecorder,
    MediaStream: FakeMediaStream,
    mediaDevices: fakeMediaDevices,
    now: () => 1,
  });
}

// --- tests -------------------------------------------------------------------

test('streams chunks to disk in capture order despite out-of-order write latency', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  // Earlier chunks resolve SLOWER than later ones: if writes were not
  // serialized, the on-disk order would be scrambled.
  const api = makeApi(writer, [40, 5, 30, 1, 25]);
  const engine = makeEngine(api);
  FakeMediaRecorder.instances = [];

  const finalized = new Promise((res) => engine.on('finalized', res));
  await engine.start({ source: { type: 'screen', id: 'screen:1' }, recordingId: 'engine-order' });

  const rec = FakeMediaRecorder.instances.at(-1);
  const chunks = [
    Buffer.from('AAAA-header'),
    Buffer.from('BBBB'),
    Buffer.from('CCCC'),
    Buffer.from('DDDD'),
    Buffer.from('EEEE-final'),
  ];
  for (const c of chunks) rec.emit(c); // fired synchronously, back-to-back
  await engine.stop();

  const result = await finalized;
  const onDisk = await fsp.readFile(result.filePath);
  assert.deepStrictEqual(onDisk, Buffer.concat(chunks), 'disk order must equal capture order');
  assert.strictEqual(engine.state, 'idle');

  const sidecar = JSON.parse(await fsp.readFile(writer.sidecarPathFor('engine-order'), 'utf-8'));
  assert.strictEqual(sidecar.status, 'finalized');

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('state machine: idle -> recording -> idle, and rejects double start', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const engine = makeEngine(makeApi(writer));
  FakeMediaRecorder.instances = [];

  assert.strictEqual(engine.state, 'idle');
  const states = [];
  engine.on('state', ({ to }) => states.push(to));

  await engine.start({ source: { type: 'screen', id: 's' }, recordingId: 'engine-sm' });
  assert.strictEqual(engine.state, 'recording');
  assert.strictEqual(engine.isRecording, true);

  await assert.rejects(
    () => engine.start({ source: { type: 'screen', id: 's' } }),
    /Cannot start recording from state "recording"/
  );

  const finalized = new Promise((res) => engine.on('finalized', res));
  const rec = FakeMediaRecorder.instances.at(-1);
  rec.emit(Buffer.from('data'));
  await engine.stop();
  await finalized;

  assert.strictEqual(engine.state, 'idle');
  assert.deepStrictEqual(states, ['acquiring', 'recording', 'stopping', 'idle']);

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('cancel deletes the in-progress recording', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const engine = makeEngine(makeApi(writer));
  FakeMediaRecorder.instances = [];

  await engine.start({ source: { type: 'screen', id: 's' }, recordingId: 'engine-cancel' });
  FakeMediaRecorder.instances.at(-1).emit(Buffer.from('bytes'));
  await engine.cancel();

  assert.strictEqual(engine.state, 'idle');
  assert.deepStrictEqual(await writer.listOrphans(), []);

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('a write failure transitions to error and emits error', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  const api = makeApi(writer);
  api.recordingChunk = async () => { throw new Error('disk full'); };
  const engine = makeEngine(api);
  FakeMediaRecorder.instances = [];

  const errored = new Promise((res) => engine.on('error', res));
  await engine.start({ source: { type: 'screen', id: 's' }, recordingId: 'engine-err' });
  FakeMediaRecorder.instances.at(-1).emit(Buffer.from('bytes'));

  const { error } = await errored;
  assert.match(error.message, /disk full/);
  assert.strictEqual(engine.state, 'error');

  engine.reset();
  assert.strictEqual(engine.state, 'idle');

  await fsp.rm(baseDir, { recursive: true, force: true });
});

test('pause/resume: transitions are guarded and paused time is excluded from duration', async () => {
  const baseDir = await freshBaseDir();
  const writer = new RecordingWriter({ baseDir });
  let t = 1000;
  const engine = new RecordingEngine({
    api: makeApi(writer),
    MediaRecorder: FakeMediaRecorder,
    MediaStream: FakeMediaStream,
    mediaDevices: fakeMediaDevices,
    now: () => t,
  });
  FakeMediaRecorder.instances = [];

  // pause/resume are no-ops outside their states
  engine.pause();
  assert.strictEqual(engine.state, 'idle');

  const finalized = new Promise((res) => engine.on('finalized', res));
  await engine.start({ source: { type: 'screen', id: 's' }, recordingId: 'engine-pause' });
  const rec = FakeMediaRecorder.instances.at(-1);

  engine.resume(); // no-op while recording
  assert.strictEqual(engine.state, 'recording');

  t = 5000;
  assert.strictEqual(engine.getDurationMs(), 4000);

  engine.pause();
  assert.strictEqual(engine.state, 'paused');
  assert.strictEqual(engine.isPaused, true);
  assert.strictEqual(engine.isRecording, true, 'a paused recording is still in progress');
  assert.strictEqual(rec.state, 'paused');

  t = 9000; // 4s pass while paused
  assert.strictEqual(engine.getDurationMs(), 4000, 'duration must freeze while paused');

  engine.resume();
  assert.strictEqual(engine.state, 'recording');
  assert.strictEqual(rec.state, 'recording');

  t = 11000;
  assert.strictEqual(engine.getDurationMs(), 6000, 'paused span must be excluded');

  // stopping straight from paused closes the open pause span
  engine.pause(); // pausedAt = 11000
  t = 12000;
  rec.emit(Buffer.from('bytes'));
  await engine.stop();

  const result = await finalized;
  assert.strictEqual(result.durationMs, 6000, 'finalized duration must exclude all paused spans');
  assert.strictEqual(engine.state, 'idle');

  await fsp.rm(baseDir, { recursive: true, force: true });
});
