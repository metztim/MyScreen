'use strict';

// Recordings library for the main process: scans the save folder for videos,
// and lazily generates duration + thumbnail metadata with ffmpeg (one process
// per file, concurrency-capped, cached in userData by path+mtime).

const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { spawn } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.webm']);
const FFMPEG_TIMEOUT_MS = 30_000;

class LibraryStore {
  constructor({ ffmpegPath, cacheDir, concurrency = 2 }) {
    this.ffmpegPath = ffmpegPath;
    this.cacheDir = cacheDir;
    this.concurrency = concurrency;
    this._queue = [];
    this._running = 0;
    this._known = new Map(); // cacheKey -> { durationSeconds, thumbPath }
  }

  // List videos in `folder`, newest first. Returns entries immediately;
  // missing thumbnails/durations are generated in the background and reported
  // through `onMeta({ path, durationSeconds, thumbnailDataUrl })`.
  async list(folder, onMeta) {
    let names;
    try {
      names = await fs.readdir(folder);
    } catch {
      return []; // folder does not exist yet
    }

    const entries = [];
    for (const name of names) {
      if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
      const filePath = path.join(folder, name);
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;

      const key = this._cacheKey(filePath, stat.mtimeMs);
      const cached = this._known.get(key);
      const entry = {
        path: filePath,
        name,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        durationSeconds: cached ? cached.durationSeconds : null,
        thumbnailDataUrl: null,
      };
      if (cached && cached.thumbPath) {
        try {
          entry.thumbnailDataUrl = await this._readThumb(cached.thumbPath);
        } catch { /* regenerate below */ }
      }
      if (entry.thumbnailDataUrl == null) this._enqueue(filePath, stat.mtimeMs, onMeta);
      entries.push(entry);
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries;
  }

  _cacheKey(filePath, mtimeMs) {
    return crypto.createHash('sha1').update(`${filePath}|${mtimeMs}`).digest('hex');
  }

  async _readThumb(thumbPath) {
    const buf = await fs.readFile(thumbPath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  }

  _enqueue(filePath, mtimeMs, onMeta) {
    if (this._queue.some((q) => q.filePath === filePath)) return;
    this._queue.push({ filePath, mtimeMs, onMeta });
    this._drain();
  }

  _drain() {
    while (this._running < this.concurrency && this._queue.length) {
      const job = this._queue.shift();
      this._running++;
      this._process(job)
        .catch((err) => console.error('Thumbnail generation failed:', job.filePath, err.message))
        .finally(() => { this._running--; this._drain(); });
    }
  }

  async _process({ filePath, mtimeMs, onMeta }) {
    const key = this._cacheKey(filePath, mtimeMs);
    await fs.mkdir(this.cacheDir, { recursive: true });
    const thumbPath = path.join(this.cacheDir, `${key}.jpg`);

    // One ffmpeg run: grab a frame for the thumbnail, parse duration from stderr.
    const stderr = await this._runFfmpeg([
      '-ss', '1', '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=480:-2',
      '-y', thumbPath,
    ]);

    let durationSeconds = null;
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) durationSeconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);

    let thumbnailDataUrl = null;
    try { thumbnailDataUrl = await this._readThumb(thumbPath); } catch { /* very short/corrupt video */ }

    this._known.set(key, { durationSeconds, thumbPath: thumbnailDataUrl ? thumbPath : null });
    if (onMeta) onMeta({ path: filePath, durationSeconds, thumbnailDataUrl });
  }

  _runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, FFMPEG_TIMEOUT_MS);
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('close', () => { clearTimeout(timer); resolve(stderr); }); // non-zero exit still carries Duration
    });
  }
}

module.exports = LibraryStore;
