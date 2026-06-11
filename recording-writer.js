'use strict';

// Streams MediaRecorder chunks straight to a single file on disk.
//
// One recording = one continuous WebM produced by one MediaRecorder. Its
// timeslice chunks arrive in order via IPC and are appended to one WriteStream.
// Appending them in order reconstructs exactly the file MediaRecorder would
// have produced with no timeslice: a valid, seekable WebM, with bounded memory
// and crash recovery for free (the partial file on disk is already playable).
//
// Deliberately Electron-free (pure fs/path) so it can be unit-tested directly.
// The main process supplies baseDir (e.g. <userData>/in-progress) and owns the
// save/convert orchestration; this module only owns bytes-to-disk and the
// sidecar metadata that lets recovery find orphaned recordings after a crash.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

class RecordingWriter {
  constructor({ baseDir }) {
    if (!baseDir) throw new Error('RecordingWriter requires a baseDir');
    this.baseDir = baseDir;
    this.active = new Map(); // recordingId -> { stream, filePath, sidecarPath, meta, bytesWritten }
  }

  filePathFor(recordingId) {
    return path.join(this.baseDir, `${recordingId}.webm`);
  }

  sidecarPathFor(recordingId) {
    return path.join(this.baseDir, `${recordingId}.json`);
  }

  async _writeSidecar(recordingId, data) {
    await fsp.writeFile(this.sidecarPathFor(recordingId), JSON.stringify(data, null, 2));
  }

  // Open a write stream + sidecar for a new recording.
  async start({ recordingId, mimeType, suggestedName }) {
    if (!recordingId) throw new Error('start requires a recordingId');
    if (this.active.has(recordingId)) {
      throw new Error(`Recording already active: ${recordingId}`);
    }
    await fsp.mkdir(this.baseDir, { recursive: true });

    const filePath = this.filePathFor(recordingId);
    const sidecarPath = this.sidecarPathFor(recordingId);
    const meta = {
      recordingId,
      mimeType: mimeType || 'video/webm',
      suggestedName: suggestedName || null,
      status: 'recording',
      startedAt: Date.now(),
    };

    const stream = fs.createWriteStream(filePath);
    // Surface open errors instead of letting them become unhandled.
    await new Promise((resolve, reject) => {
      stream.once('open', resolve);
      stream.once('error', reject);
    });

    await this._writeSidecar(recordingId, meta);
    this.active.set(recordingId, { stream, filePath, sidecarPath, meta, bytesWritten: 0 });
    return { filePath, sidecarPath };
  }

  // Append one chunk, honoring backpressure (await 'drain' when buffered).
  async write(recordingId, chunk) {
    const entry = this.active.get(recordingId);
    if (!entry) throw new Error(`No active recording: ${recordingId}`);

    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return entry.bytesWritten;
    entry.bytesWritten += buf.length;

    const ok = entry.stream.write(buf);
    if (!ok) {
      await new Promise((resolve, reject) => {
        const onDrain = () => { entry.stream.off('error', onError); resolve(); };
        const onError = (err) => { entry.stream.off('drain', onDrain); reject(err); };
        entry.stream.once('drain', onDrain);
        entry.stream.once('error', onError);
      });
    }
    return entry.bytesWritten;
  }

  // Close the stream cleanly. The file is now a complete, valid recording.
  async finalize(recordingId) {
    const entry = this.active.get(recordingId);
    if (!entry) throw new Error(`No active recording: ${recordingId}`);

    await new Promise((resolve, reject) => {
      entry.stream.once('error', reject);
      entry.stream.end(resolve); // flushes buffered data, then fires the callback on 'finish'
    });
    this.active.delete(recordingId);

    await this._writeSidecar(recordingId, {
      ...entry.meta,
      status: 'finalized',
      bytesWritten: entry.bytesWritten,
      finalizedAt: Date.now(),
    });
    return { filePath: entry.filePath, bytesWritten: entry.bytesWritten, sidecarPath: entry.sidecarPath };
  }

  // Cancel an in-progress recording: close the stream and remove its artifacts.
  async abort(recordingId) {
    const entry = this.active.get(recordingId);
    if (entry) {
      await new Promise((resolve) => entry.stream.end(resolve));
      this.active.delete(recordingId);
    }
    await this.discard(recordingId);
  }

  // Remove a recording's file + sidecar (after a successful save, or to discard).
  async discard(recordingId) {
    await fsp.rm(this.filePathFor(recordingId), { force: true });
    await fsp.rm(this.sidecarPathFor(recordingId), { force: true });
  }

  // Find recordings left on disk by a crash: any sidecar present at launch.
  // Returns the sidecar metadata plus the on-disk file path and size.
  async listOrphans() {
    let entries;
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const orphans = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const recordingId = name.slice(0, -'.json'.length);
      // Skip recordings still being written in this process.
      if (this.active.has(recordingId)) continue;

      const filePath = this.filePathFor(recordingId);
      let meta;
      try {
        meta = JSON.parse(await fsp.readFile(path.join(this.baseDir, name), 'utf-8'));
      } catch {
        continue; // unreadable sidecar, skip
      }
      let size = 0;
      try {
        size = (await fsp.stat(filePath)).size;
      } catch {
        // file missing for this sidecar: stale sidecar, clean it up
        await fsp.rm(path.join(this.baseDir, name), { force: true });
        continue;
      }
      if (size === 0) {
        await this.discard(recordingId);
        continue;
      }
      orphans.push({ ...meta, recordingId, filePath, size });
    }
    // Newest first.
    orphans.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return orphans;
  }
}

module.exports = RecordingWriter;
