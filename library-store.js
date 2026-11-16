'use strict';

// Recordings library for the main process: scans the save folder for videos,
// and lazily generates duration + thumbnail metadata with ffmpeg (one process
// per file, concurrency-capped). Results are cached in userData by
// path+mtime: thumbnails as JPEGs, durations in index.json, so a file is
// only ever probed once across launches.

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
    this._known = null;      // cacheKey -> { durationSeconds, thumbPath }, loaded on first use
    this._saveTimer = null;
  }

  _indexPath() { return path.join(this.cacheDir, 'index.json'); }

  async _loadIndex() {
    if (this._known) return;
    this._known = new Map();
    try {
      const raw = JSON.parse(await fs.readFile(this._indexPath(), 'utf-8'));
      for (const [key, value] of Object.entries(raw)) {
        this._known.set(key, {
          durationSeconds: value.durationSeconds ?? null,
          thumbPath: value.hasThumb ? path.join(this.cacheDir, `${key}.jpg`) : null,
        });
      }
    } catch { /* first run or unreadable index: rebuilt as files are probed */ }
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveIndex().catch(() => {}); }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  async _saveIndex() {
    clearTimeout(this._saveTimer);
    const out = {};
    for (const [key, value] of this._known) {
      out[key] = { durationSeconds: value.durationSeconds, hasThumb: !!value.thumbPath };
    }
    await fs.mkdir(this.cacheDir, { recursive: true });
    const tmp = this._indexPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(out));
    await fs.rename(tmp, this._indexPath());
  }

  // Thumbnail + duration for one file, generating them if needed.
  async metaFor(filePath) {
    await this._loadIndex();
    const stat = await fs.stat(filePath);
    const key = this._cacheKey(filePath, stat.mtimeMs);
    let cached = this._known.get(key);
    if (!cached) {
      await this._process({ filePath, mtimeMs: stat.mtimeMs, onMeta: null });
      cached = this._known.get(key);
    }
    let thumbnailDataUrl = null;
    if (cached && cached.thumbPath) {
      try { thumbnailDataUrl = await this._readThumb(cached.thumbPath); } catch { /* cache file gone */ }
    }
    return { path: filePath, durationSeconds: cached ? cached.durationSeconds : null, thumbnailDataUrl };
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

    await this._loadIndex();
    const seen = new Set();
    const entries = [];
    for (const name of names) {
      if (name.startsWith('.')) continue; // hidden files, including saves still in progress
      if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
      const filePath = path.join(folder, name);
      let stat;
      try { stat = await fs.stat(filePath); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;

      const key = this._cacheKey(filePath, stat.mtimeMs);
      seen.add(key);
      const cached = this._known.get(key);
      const entry = {
        path: filePath,
        name,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        durationSeconds: cached ? cached.durationSeconds : null,
        thumbnailDataUrl: null,
      };
      let needsProbe = !cached;
      if (cached && cached.thumbPath) {
        try {
          entry.thumbnailDataUrl = await this._readThumb(cached.thumbPath);
        } catch { needsProbe = true; /* cache file gone: regenerate */ }
      }
      // A file already probed without a usable frame is not probed again.
      if (needsProbe) this._enqueue(filePath, stat.mtimeMs, onMeta);
      entries.push(entry);
    }

    this._prune(seen);
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries;
  }

  // Drop cache entries for files that are gone (or changed) so the cache
  // stays the size of the current folder.
  _prune(seen) {
    let changed = false;
    for (const [key, value] of this._known) {
      if (seen.has(key)) continue;
      if (this._queue.some((q) => this._cacheKey(q.filePath, q.mtimeMs) === key)) continue;
      this._known.delete(key);
      changed = true;
      if (value.thumbPath) fs.rm(value.thumbPath, { force: true }).catch(() => {});
    }
    if (changed) this._scheduleSave();
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

    // One ffmpeg run: grab a frame for the thumbnail, parse duration from
    // stderr. A clip shorter than a second has no frame at 1s, so fall back
    // to its first frame.
    await fs.rm(thumbPath, { force: true });
    let durationSeconds = null;
    let thumbnailDataUrl = null;
    for (const seek of ['1', '0']) {
      const stderr = await this._runFfmpeg([
        '-ss', seek, '-i', filePath,
        '-frames:v', '1', '-vf', 'scale=480:-2',
        '-y', thumbPath,
      ]);
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) durationSeconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      try { thumbnailDataUrl = await this._readThumb(thumbPath); } catch { /* no frame at this position */ }
      if (thumbnailDataUrl) break;
    }

    await this._loadIndex();
    this._known.set(key, { durationSeconds, thumbPath: thumbnailDataUrl ? thumbPath : null });
    this._scheduleSave();
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
