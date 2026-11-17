'use strict';

// Agent files: what a coding agent needs to "watch" a recording it cannot
// play. For <folder>/<name>.mp4 this module writes
//
//   <folder>/.myscreen/<name>/recording.md     summary + transcript + frame list (the file to hand an agent)
//   <folder>/.myscreen/<name>/recording.json   the same, structured (library and MCP server read this)
//   <folder>/.myscreen/<name>/frames/*.jpg     one image per screen change, sized for a model to read
//
// Pure Node (fs, path, child_process): the app's main process and the MCP
// server (mcp-server.js) both use it, and the tests run it directly.
//
// Transcripts come from whisper.cpp: the command-line tool ships with the
// app (scripts/build-whisper.sh), the speech model is downloaded once on
// request (model-download.js). Until a model is present the manifest says
// so in transcript.status; nothing is made up.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MANIFEST_VERSION = 1;
const AGENT_DIR = '.myscreen';
const VIDEO_EXT = new Set(['.mp4', '.webm']);

const MAX_FRAMES = 40;
const FRAME_LONG_SIDE = 1568;      // larger adds tokens without adding legible detail
// A frame when the screen changes (but not more than one every 2s), and at
// least one every 30s so long still stretches are still represented.
const FRAME_SELECT = "isnan(prev_selected_t)+gte(t-prev_selected_t,30)+gt(scene,0.02)*gte(t-prev_selected_t,2)";

// The engine, in order: the copy shipped in the app (Resources/whisper-cli,
// one level above this file's archive), the copy built in a checkout, then
// one installed with Homebrew.
const WHISPER_BINARIES = [
  path.join(__dirname, '..', 'whisper-cli'),
  path.join(__dirname, 'vendor-bin', 'whisper-cli'),
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
];
// Preference among models found: best speed/accuracy trade first.
const MODEL_PREFERENCE = ['turbo', 'small', 'base', 'medium', 'large', 'tiny'];

function run(command, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Where whisper.cpp models are looked for: the app's own folder first, then
// the places other tools on this Mac keep theirs.
function defaultModelDirs(userDataDir) {
  return [
    path.join(userDataDir, 'models'),
    path.join(os.homedir(), 'Library', 'Application Support', 'MacWhisper', 'models'),
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp',
  ];
}

// Local date and time, e.g. "2026-11-17 09:31".
function localStamp(ms) {
  return new Date(ms).toLocaleString('sv-SE').slice(0, 16);
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

class AgentFiles {
  // options: { ffmpegPath, modelDirs?: string[], whisperPath?, whisperModel? }
  constructor({ ffmpegPath, modelDirs = [], whisperPath = null, whisperModel = null, whisperBinaries = WHISPER_BINARIES }) {
    if (!ffmpegPath) throw new Error('AgentFiles requires ffmpegPath');
    this.ffmpegPath = ffmpegPath;
    this.modelDirs = modelDirs;
    this.whisperBinaries = whisperBinaries;
    this.whisperPath = whisperPath || process.env.MYSCREEN_WHISPER || null;
    this.whisperModel = whisperModel || process.env.MYSCREEN_WHISPER_MODEL || null;
    this._chain = Promise.resolve(); // builds run one at a time: they are CPU-heavy
    this._inFlight = new Map();      // videoPath -> promise
  }

  static isVideo(filePath) {
    return VIDEO_EXT.has(path.extname(filePath).toLowerCase());
  }

  dirFor(videoPath) {
    const ext = path.extname(videoPath);
    return path.join(path.dirname(videoPath), AGENT_DIR, path.basename(videoPath, ext));
  }

  summaryPathFor(videoPath) { return path.join(this.dirFor(videoPath), 'recording.md'); }
  manifestPathFor(videoPath) { return path.join(this.dirFor(videoPath), 'recording.json'); }

  // The manifest, if it exists and still describes this exact file.
  async read(videoPath) {
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(this.manifestPathFor(videoPath), 'utf-8'));
    } catch {
      return null;
    }
    let stat;
    try { stat = await fsp.stat(videoPath); } catch { return null; }
    if (manifest.version !== MANIFEST_VERSION || manifest.sizeBytes !== stat.size) return null;
    return manifest;
  }

  // Build (or return the existing) agent files. `context` is what the app
  // knew at record time: { source: { type, name }, microphone, camera }.
  ensure(videoPath, context = null) {
    if (this._inFlight.has(videoPath)) return this._inFlight.get(videoPath);
    const job = this._chain.then(async () => {
      const existing = await this.read(videoPath);
      if (!existing) return this._build(videoPath, context);
      // Prepared before a speech model was installed: redo it now that a
      // transcript is possible, keeping what the app knew at record time.
      if (existing.transcript.status === 'no-engine' && (await this.transcriber()).available) {
        const known = context || { source: existing.source, microphone: existing.microphone, camera: existing.camera };
        return this._build(videoPath, known);
      }
      return existing;
    });
    this._chain = job.catch(() => {});
    this._inFlight.set(videoPath, job);
    const done = () => { this._inFlight.delete(videoPath); };
    job.then(done, done);
    return job;
  }

  async remove(videoPath) {
    await fsp.rm(this.dirFor(videoPath), { recursive: true, force: true });
  }

  // --- transcription engine ---------------------------------------------------------

  // { available, binary, model, label } for whisper.cpp on this Mac.
  async transcriber() {
    let binary = null;
    for (const candidate of [this.whisperPath, ...this.whisperBinaries]) {
      if (candidate && await exists(candidate)) { binary = candidate; break; }
    }
    let model = this.whisperModel && await exists(this.whisperModel) ? this.whisperModel : null;
    if (!model) {
      const found = [];
      for (const dir of this.modelDirs) {
        let names;
        try { names = await fsp.readdir(dir); } catch { continue; }
        for (const name of names) {
          // "for-tests" models ship with Homebrew's whisper-cpp and transcribe nothing useful.
          if (/^ggml-.*\.bin$/.test(name) && !name.includes('for-tests')) found.push(path.join(dir, name));
        }
      }
      const rank = (p) => {
        const i = MODEL_PREFERENCE.findIndex((key) => path.basename(p).includes(key));
        return i === -1 ? MODEL_PREFERENCE.length : i;
      };
      found.sort((a, b) => rank(a) - rank(b));
      model = found[0] || null;
    }
    const available = !!(binary && model);
    const label = available
      ? `whisper.cpp (${path.basename(model).replace(/^ggml-(model-whisper-)?/, '').replace(/\.bin$/, '')})`
      : !binary
        ? 'the transcription engine is missing'
        : 'no speech model is installed';
    return { available, binary, model, label };
  }

  // --- build ----------------------------------------------------------------------

  async _build(videoPath, context) {
    const stat = await fsp.stat(videoPath);
    const dir = this.dirFor(videoPath);
    // Build beside the final location and swap in, so a reader never sees a
    // half-written folder.
    const tmpDir = `${dir}.building`;
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(path.join(tmpDir, 'frames'), { recursive: true });

    try {
      const info = await this._probe(videoPath);
      const frames = await this._extractFrames(videoPath, tmpDir);
      const transcript = await this._transcribe(videoPath, info);

      const manifest = {
        version: MANIFEST_VERSION,
        file: videoPath,
        name: path.basename(videoPath, path.extname(videoPath)),
        recordedAt: new Date(stat.mtimeMs).toISOString(),
        sizeBytes: stat.size,
        durationSeconds: info.durationSeconds,
        width: info.width,
        height: info.height,
        source: (context && context.source) || null,
        microphone: context ? !!context.microphone : info.hasAudio,
        camera: context ? !!context.camera : null,
        transcript,
        frames,
      };
      await fsp.writeFile(path.join(tmpDir, 'recording.json'), JSON.stringify(manifest, null, 2));
      await fsp.writeFile(path.join(tmpDir, 'recording.md'), this.renderSummary(manifest, dir));

      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rename(tmpDir, dir);
      return manifest;
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  async _probe(videoPath) {
    const { stderr } = await run(this.ffmpegPath, ['-hide_banner', '-i', videoPath], { timeoutMs: 30_000 });
    const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const v = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
    return {
      durationSeconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
      width: v ? Number(v[1]) : null,
      height: v ? Number(v[2]) : null,
      hasAudio: /Stream #.*Audio:/.test(stderr),
    };
  }

  async _extractFrames(videoPath, outDir) {
    const pattern = path.join(outDir, 'frames', 'f-%05d.jpg');
    const scale = `scale=w='if(gte(iw,ih),min(${FRAME_LONG_SIDE},iw),-2)':h='if(gte(iw,ih),-2,min(${FRAME_LONG_SIDE},ih))'`;
    const { stderr } = await run(this.ffmpegPath, [
      '-hide_banner', '-i', videoPath, '-an',
      '-vf', `select='${FRAME_SELECT}',showinfo,${scale}`,
      '-fps_mode', 'vfr', '-q:v', '4', '-y', pattern,
    ]);
    // showinfo prints one line per selected frame, in output order.
    const times = [...stderr.matchAll(/pts_time:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
    const files = (await fsp.readdir(path.join(outDir, 'frames'))).filter((n) => n.endsWith('.jpg')).sort();

    let picked = files.map((file, i) => ({ t: times[i] ?? null, file }));
    if (picked.length > MAX_FRAMES) {
      // Keep an evenly spaced subset (always including the first frame).
      const step = picked.length / MAX_FRAMES;
      const keep = new Set(Array.from({ length: MAX_FRAMES }, (_, i) => Math.floor(i * step)));
      for (let i = 0; i < picked.length; i++) {
        if (!keep.has(i)) await fsp.rm(path.join(outDir, 'frames', picked[i].file), { force: true });
      }
      picked = picked.filter((_, i) => keep.has(i));
    }

    // Rename to names that carry the timestamp, e.g. 003-0m12s.jpg.
    const frames = [];
    for (let i = 0; i < picked.length; i++) {
      const { t, file } = picked[i];
      const stamp = t == null ? 'unknown' : `${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
      const name = `${String(i + 1).padStart(3, '0')}-${stamp}.jpg`;
      await fsp.rename(path.join(outDir, 'frames', file), path.join(outDir, 'frames', name));
      frames.push({ t: t == null ? null : Math.round(t * 10) / 10, file: path.join('frames', name) });
    }
    return frames;
  }

  // A single frame at an exact moment, as a JPEG buffer (the MCP server uses
  // this when an agent asks about a time between two key frames).
  async frameAt(videoPath, seconds) {
    const tmp = path.join(os.tmpdir(), `myscreen-frame-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`);
    const scale = `scale=w='if(gte(iw,ih),min(${FRAME_LONG_SIDE},iw),-2)':h='if(gte(iw,ih),-2,min(${FRAME_LONG_SIDE},ih))'`;
    try {
      await run(this.ffmpegPath, ['-hide_banner', '-ss', String(Math.max(0, seconds)), '-i', videoPath, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-y', tmp], { timeoutMs: 60_000 });
      return await fsp.readFile(tmp);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async _transcribe(videoPath, info) {
    if (!info.hasAudio) return { status: 'no-audio', segments: [], detail: 'The recording has no audio track.' };
    const engine = await this.transcriber();
    if (!engine.available) {
      return {
        status: 'no-engine', segments: [],
        detail: engine.binary
          ? 'No speech model is installed yet. Download it in MyScreen under Output, Agent access, then ask for this recording again.'
          : 'The transcription engine is missing from this copy of MyScreen.',
      };
    }

    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-transcribe-'));
    try {
      const wav = path.join(work, 'audio.wav');
      const extracted = await run(this.ffmpegPath, ['-hide_banner', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', wav]);
      if (extracted.code !== 0) return { status: 'failed', segments: [], detail: 'Could not extract the audio track.' };

      const outBase = path.join(work, 'out');
      // Generous cap: transcription runs several times faster than real time.
      const timeoutMs = Math.max(5 * 60 * 1000, (info.durationSeconds || 0) * 1000 * 2);
      const result = await run(engine.binary, ['-m', engine.model, '-f', wav, '-l', 'auto', '-oj', '-of', outBase, '-np'], { timeoutMs });
      if (result.code !== 0) {
        return { status: 'failed', engine: engine.label, segments: [], detail: `whisper.cpp exited with ${result.code}: ${result.stderr.slice(-300).trim()}` };
      }
      const json = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf-8'));
      const segments = (json.transcription || [])
        .map((seg) => ({
          start: Math.round((seg.offsets ? seg.offsets.from : 0) / 100) / 10,
          end: Math.round((seg.offsets ? seg.offsets.to : 0) / 100) / 10,
          text: String(seg.text || '').trim(),
        }))
        // whisper marks silence and noise as [BLANK_AUDIO], (music), *bell rings*
        .filter((seg) => seg.text && !/^[\[(*].*[\])*]$/.test(seg.text));
      return {
        status: 'ok', engine: engine.label,
        language: (json.result && json.result.language) || null,
        segments,
      };
    } catch (err) {
      return { status: 'failed', engine: engine.label, segments: [], detail: err.message };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  // --- summary --------------------------------------------------------------------

  // recording.md: everything in one file an agent can read top to bottom.
  renderSummary(manifest, dir) {
    const lines = [`# ${manifest.name}`, ''];
    const facts = [`- Video file: ${manifest.file}`];
    facts.push(`- Recorded: ${localStamp(Date.parse(manifest.recordedAt))} (local time)`);
    if (manifest.durationSeconds != null) facts.push(`- Duration: ${clock(manifest.durationSeconds)}`);
    if (manifest.width && manifest.height) facts.push(`- Picture: ${manifest.width}×${manifest.height}`);
    if (manifest.source) {
      const kind = { screen: 'Full screen', window: 'App window', camera: 'Camera' }[manifest.source.type] || manifest.source.type;
      facts.push(`- Source: ${kind}${manifest.source.name ? ` (${manifest.source.name})` : ''}`);
    }
    if (manifest.camera != null) facts.push(`- Camera overlay: ${manifest.camera ? 'yes' : 'no'}`);
    lines.push(...facts, '');

    lines.push('## Transcript', '');
    const t = manifest.transcript;
    if (t.status === 'ok' && t.segments.length) {
      for (const seg of t.segments) lines.push(`[${clock(seg.start)}] ${seg.text}`);
      lines.push('', `Transcribed on this Mac with ${t.engine}${t.language ? `, language ${t.language}` : ''}. Speech recognition makes mistakes, especially with names and code.`);
    } else if (t.status === 'ok') {
      lines.push('No speech was detected.');
    } else {
      lines.push(`No transcript: ${t.detail}`);
    }
    lines.push('');

    lines.push('## Key frames', '');
    if (manifest.frames.length) {
      lines.push('One image per screen change, in order. Open the ones near the moment of interest.', '');
      for (const frame of manifest.frames) {
        lines.push(`- [${frame.t == null ? '?' : clock(frame.t)}] ${path.join(dir, frame.file)}`);
      }
    } else {
      lines.push('No frames could be extracted.');
    }
    lines.push('');
    return lines.join('\n');
  }
}

AgentFiles.AGENT_DIR = AGENT_DIR;
AgentFiles.clock = clock;
AgentFiles.localStamp = localStamp;
AgentFiles.defaultModelDirs = defaultModelDirs;

module.exports = AgentFiles;
