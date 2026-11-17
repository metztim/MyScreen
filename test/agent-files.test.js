'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AgentFiles = require('../agent-files');
const ffmpegPath = require('ffmpeg-static');

// A short "screen recording": three distinct screens of 4s each, with spoken
// narration when macOS speech synthesis is available.
function makeRecording(filePath, { speech = null } = {}) {
  const dir = path.dirname(filePath);
  const inputs = ['-f', 'lavfi', '-i', 'color=c=0x1b2a3a:s=640x400:d=4', '-f', 'lavfi', '-i', 'testsrc2=s=640x400:d=4', '-f', 'lavfi', '-i', 'color=c=0xf4f4f4:s=640x400:d=4'];
  let audio = ['-f', 'lavfi', '-t', '12', '-i', 'anullsrc=r=48000:cl=mono'];
  if (speech) {
    const aiff = path.join(dir, 'speech.aiff');
    const said = spawnSync('say', ['-o', aiff, speech]);
    if (said.status === 0) audio = ['-i', aiff];
  }
  const result = spawnSync(ffmpegPath, [
    '-v', 'error', '-y', ...inputs, ...audio,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a', '-pix_fmt', 'yuv420p', '-r', '10', '-c:a', 'aac', '-t', '12', filePath,
  ]);
  assert.strictEqual(result.status, 0, String(result.stderr));
}

async function freshDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-agent-'));
}

test('writes a summary, a manifest, and one frame per screen change; says so when no transcript engine exists', async () => {
  const folder = await freshDir();
  const video = path.join(folder, 'Demo recording.mp4');
  makeRecording(video);

  // No model directories: the transcript must be reported as unavailable, not invented.
  const agent = new AgentFiles({ ffmpegPath, modelDirs: [], whisperPath: '/nonexistent/whisper-cli' });
  const manifest = await agent.ensure(video, { source: { type: 'window', name: 'Safari' }, microphone: true, camera: false });

  assert.strictEqual(manifest.name, 'Demo recording');
  assert.ok(Math.abs(manifest.durationSeconds - 12) < 0.5);
  assert.strictEqual(manifest.width, 640);
  assert.strictEqual(manifest.source.name, 'Safari');
  assert.ok(['no-engine', 'ok'].includes(manifest.transcript.status)); // 'ok' only if whisper-cli sits in a default location with a model given by env
  if (manifest.transcript.status === 'no-engine') assert.match(manifest.transcript.detail, /speech model|transcription engine/);

  // Three screens -> three key frames, at the changes.
  assert.strictEqual(manifest.frames.length, 3);
  assert.deepStrictEqual(manifest.frames.map((f) => Math.round(f.t)), [0, 4, 8]);
  for (const frame of manifest.frames) {
    const stat = await fsp.stat(path.join(agent.dirFor(video), frame.file));
    assert.ok(stat.size > 500);
  }

  const summary = await fsp.readFile(agent.summaryPathFor(video), 'utf-8');
  assert.match(summary, /^# Demo recording/);
  assert.match(summary, /Source: App window \(Safari\)/);
  assert.match(summary, /\[0:04\] .*frames\/002-0m04s\.jpg/);
  assert.strictEqual(agent.dirFor(video), path.join(folder, '.myscreen', 'Demo recording'));

  // A second call reads the manifest instead of rebuilding.
  let probes = 0;
  const original = agent._probe.bind(agent);
  agent._probe = async (...args) => { probes++; return original(...args); };
  assert.deepStrictEqual(await agent.ensure(video), manifest);
  assert.strictEqual(probes, 0);

  // A file that changed (different size) is rebuilt.
  await fsp.appendFile(video, Buffer.alloc(10));
  assert.strictEqual(await agent.read(video), null);

  await fsp.rm(folder, { recursive: true, force: true });
});

test('frameAt returns a JPEG for an exact moment', async () => {
  const folder = await freshDir();
  const video = path.join(folder, 'clip.mp4');
  makeRecording(video);
  const agent = new AgentFiles({ ffmpegPath });
  const jpeg = await agent.frameAt(video, 6);
  assert.ok(jpeg.length > 500);
  assert.strictEqual(jpeg[0], 0xff);
  assert.strictEqual(jpeg[1], 0xd8);
  await fsp.rm(folder, { recursive: true, force: true });
});

// Runs only where whisper.cpp and a model are installed (MYSCREEN_WHISPER_MODEL,
// or a ggml model in MYSCREEN_TEST_MODEL_DIR).
test('transcribes narration with whisper.cpp when it is installed', async (t) => {
  const modelDirs = process.env.MYSCREEN_TEST_MODEL_DIR ? [process.env.MYSCREEN_TEST_MODEL_DIR] : [];
  const agent = new AgentFiles({ ffmpegPath, modelDirs });
  const engine = await agent.transcriber();
  if (!engine.available) { t.skip(`no transcription engine: ${engine.label}`); return; }

  const folder = await freshDir();
  const video = path.join(folder, 'Narrated.mp4');
  makeRecording(video, { speech: 'The save button does nothing when I click it. Please fix the save button.' });
  const manifest = await agent.ensure(video);

  assert.strictEqual(manifest.transcript.status, 'ok');
  const text = manifest.transcript.segments.map((s) => s.text).join(' ').toLowerCase();
  assert.match(text, /save button/);
  assert.ok(manifest.transcript.segments[0].start >= 0);
  const summary = await fsp.readFile(agent.summaryPathFor(video), 'utf-8');
  assert.match(summary, /\[0:0\d\] .*save button/i);

  await fsp.rm(folder, { recursive: true, force: true });
});

test('prefers the engine shipped with the app, and says which piece is missing', async () => {
  const dir = await freshDir();
  const shipped = path.join(dir, 'whisper-cli');
  await fsp.writeFile(shipped, '#!/bin/sh\n');
  const models = path.join(dir, 'models');
  await fsp.mkdir(models);

  const agent = new AgentFiles({ ffmpegPath, modelDirs: [models], whisperBinaries: [shipped, '/opt/homebrew/bin/whisper-cli'] });
  let engine = await agent.transcriber();
  assert.strictEqual(engine.binary, shipped);
  assert.strictEqual(engine.available, false);
  assert.strictEqual(engine.label, 'no speech model is installed');

  // A download in progress is not a model yet.
  await fsp.writeFile(path.join(models, 'ggml-large-v3-turbo-q5_0.bin.part'), 'x');
  assert.strictEqual((await agent.transcriber()).available, false);

  await fsp.writeFile(path.join(models, 'ggml-base.bin'), 'x');
  await fsp.writeFile(path.join(models, 'ggml-large-v3-turbo-q5_0.bin'), 'x');
  engine = await agent.transcriber();
  assert.strictEqual(engine.available, true);
  assert.strictEqual(engine.label, 'whisper.cpp (large-v3-turbo-q5_0)', 'the turbo model wins over base');

  const none = new AgentFiles({ ffmpegPath, modelDirs: [models], whisperBinaries: [path.join(dir, 'missing')] });
  assert.strictEqual((await none.transcriber()).label, 'the transcription engine is missing');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('a recording prepared without a speech model gets its transcript once one is installed', async (t) => {
  const modelDir = process.env.MYSCREEN_TEST_MODEL_DIR;
  const probe = new AgentFiles({ ffmpegPath, modelDirs: modelDir ? [modelDir] : [] });
  if (!(await probe.transcriber()).available) { t.skip('no speech model on this machine'); return; }

  const folder = await freshDir();
  const video = path.join(folder, 'Before the model.mp4');
  makeRecording(video, { speech: 'This sentence was recorded before the speech model was downloaded.' });

  const without = new AgentFiles({ ffmpegPath, modelDirs: [] });
  const first = await without.ensure(video, { source: { type: 'screen', name: 'Built-in Display' }, microphone: true, camera: false });
  assert.strictEqual(first.transcript.status, 'no-engine');

  const withModel = new AgentFiles({ ffmpegPath, modelDirs: [modelDir] });
  const second = await withModel.ensure(video);
  assert.strictEqual(second.transcript.status, 'ok');
  assert.match(second.transcript.segments.map((s) => s.text).join(' ').toLowerCase(), /speech model/);
  assert.strictEqual(second.source.name, 'Built-in Display', 'what the app knew at record time is kept');

  await fsp.rm(folder, { recursive: true, force: true });
});
