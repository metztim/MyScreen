'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const { trimArgs, trimRange } = require('../video-trim.js');

test('the kept part is limited to the recording', () => {
  assert.deepStrictEqual(
    trimRange({ start: -3, end: 8, durationSeconds: 10 }),
    { start: 0, end: 8, length: 8, cutsStart: false, cutsEnd: true },
  );
  const both = trimRange({ start: 2, end: 99, durationSeconds: 10 });
  assert.strictEqual(both.start, 2);
  assert.strictEqual(both.end, 10);
  assert.strictEqual(both.cutsEnd, false);
});

test('a trim that changes nothing or leaves too little is refused', () => {
  assert.throws(() => trimRange({ start: 0, end: 10, durationSeconds: 10 }), /Nothing to trim/);
  assert.throws(() => trimRange({ start: 0.01, end: 9.99, durationSeconds: 10 }), /Nothing to trim/);
  assert.throws(() => trimRange({ start: 5, end: 5.2, durationSeconds: 10 }), /too short/);
  assert.throws(() => trimRange({ start: 8, end: 3, durationSeconds: 10 }), /too short/);
  assert.throws(() => trimRange({ start: 1, end: 3, durationSeconds: 0 }), /unknown/);
});

test('cutting only the end copies the streams', () => {
  const { args, reencodes } = trimArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', start: 0, end: 6, durationSeconds: 10 });
  assert.strictEqual(reencodes, false);
  assert.ok(!args.includes('-ss'));
  assert.strictEqual(args[args.indexOf('-c') + 1], 'copy');
  assert.strictEqual(args[args.indexOf('-t') + 1], '6.000');
});

test('cutting the start encodes again, in the codec of the container', () => {
  const mp4 = trimArgs({ inputPath: '/in.mp4', outputPath: '/.in.part.mp4', start: 2, end: 6, durationSeconds: 10 });
  assert.strictEqual(mp4.reencodes, true);
  assert.ok(mp4.args.indexOf('-ss') < mp4.args.indexOf('-i'));
  assert.strictEqual(mp4.args[mp4.args.indexOf('-t') + 1], '4.000');
  assert.ok(mp4.args.includes('libx264'));
  const webm = trimArgs({ inputPath: '/in.webm', outputPath: '/.in.part.webm', start: 2, end: 6, durationSeconds: 10 });
  assert.ok(webm.args.includes('libvpx-vp9'));
  assert.strictEqual(webm.args[webm.args.indexOf('-f') + 1], 'webm');
});

// Length of a video in seconds, read from ffmpeg's own report.
function lengthOf(file) {
  const out = spawnSync(ffmpeg, ['-hide_banner', '-i', file]).stderr.toString();
  const m = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(out);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

test('the bundled ffmpeg trims a real video to the asked length', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myscreen-trim-'));
  try {
    const src = path.join(dir, 'clip.mp4');
    // 6 seconds with a keyframe only every 3, like a screen recording.
    execFileSync(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '6', '-c:v', 'libx264', '-g', '90', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', src], { stdio: 'ignore' });

    const end = path.join(dir, 'end.mp4');
    execFileSync(ffmpeg, trimArgs({ inputPath: src, outputPath: end, start: 0, end: 4, durationSeconds: 6 }).args, { stdio: 'ignore' });
    assert.ok(Math.abs(lengthOf(end) - 4) < 0.15, `end cut is ${lengthOf(end)}s`);

    // 1.5 s is between keyframes: only a re-encode starts there.
    const both = path.join(dir, 'both.mp4');
    execFileSync(ffmpeg, trimArgs({ inputPath: src, outputPath: both, start: 1.5, end: 5, durationSeconds: 6 }).args, { stdio: 'ignore' });
    assert.ok(Math.abs(lengthOf(both) - 3.5) < 0.15, `start and end cut is ${lengthOf(both)}s`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
