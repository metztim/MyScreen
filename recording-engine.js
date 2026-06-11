'use strict';

// The recording core. One recording = one MediaRecorder whose timeslice chunks
// are streamed, in order, straight to disk via the recording IPC bridge.
//
// Design goals (the opposite of what made the old code unstable):
//   - ONE recorder, ONE output file, ONE save path. No segments, no in-memory
//     accumulation, no second recorder, no competing backup systems.
//   - ONE source of truth for state: a small idle -> acquiring -> recording ->
//     stopping -> idle machine (plus error). No parallel boolean flags, no
//     watchdog timers to un-stick it.
//   - Chunk writes are serialized through a promise chain so they always reach
//     disk in the order MediaRecorder produced them, regardless of how the
//     async IPC calls interleave.
//
// No DOM access. Browser/Electron globals (MediaRecorder, navigator, the IPC
// bridge) are injected, defaulting to the real ones, so the engine can be
// driven by fakes in tests.

const STATES = Object.freeze({
  IDLE: 'idle',
  ACQUIRING: 'acquiring',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  ERROR: 'error',
});

// Default camera-overlay layout (percent coords of the frame + width fraction),
// matching the original hardcoded top-right compositing.
const DEFAULT_OVERLAY = Object.freeze({ x: 80.5, y: 2.7, w: 0.18, shape: 'rounded', mirror: true });

const DEFAULT_BITRATE = 2_500_000;
const DEFAULT_TIMESLICE_MS = 1000;

class RecordingEngine {
  constructor(deps = {}) {
    // Injectable for testing; default to the renderer globals.
    this.api = deps.api || (typeof window !== 'undefined' ? window.electronAPI : undefined);
    this.mediaDevices = deps.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    this.MediaRecorder = deps.MediaRecorder || (typeof globalThis !== 'undefined' ? globalThis.MediaRecorder : undefined);
    this.MediaStream = deps.MediaStream || (typeof globalThis !== 'undefined' ? globalThis.MediaStream : undefined);
    this.document = deps.document || (typeof globalThis !== 'undefined' ? globalThis.document : undefined);
    this.requestAnimationFrame = deps.requestAnimationFrame
      || (typeof globalThis !== 'undefined' && globalThis.requestAnimationFrame
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : undefined);
    this.cancelAnimationFrame = deps.cancelAnimationFrame
      || (typeof globalThis !== 'undefined' && globalThis.cancelAnimationFrame
        ? globalThis.cancelAnimationFrame.bind(globalThis)
        : undefined);
    this.now = deps.now || (() => Date.now());

    this._state = STATES.IDLE;
    this._listeners = new Map(); // event -> Set<callback>
    this._reset();
  }

  _reset() {
    this._stream = null;
    this._recorder = null;
    this._recordingId = null;
    this._mimeType = null;
    this._startTime = null;
    this._writeChain = Promise.resolve();
    this._ownedStreams = [];
    this._drawFrame = null;
    this._pausedAccumMs = 0;
    this._pausedAt = null;
  }

  // --- events --------------------------------------------------------------
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(payload); } catch (err) { console.error(`RecordingEngine listener for "${event}" threw:`, err); }
    }
  }

  // --- state ---------------------------------------------------------------
  get state() { return this._state; }
  get recordingId() { return this._recordingId; }
  get isRecording() { return this._state === STATES.RECORDING || this._state === STATES.PAUSED; }
  get isPaused() { return this._state === STATES.PAUSED; }
  get stream() { return this._stream; }

  // Recorded duration: wall time minus the spans spent paused.
  getDurationMs() {
    if (!this._startTime) return 0;
    const end = this._pausedAt != null ? this._pausedAt : this.now();
    return end - this._startTime - this._pausedAccumMs;
  }

  _setState(next) {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    this._emit('state', { from: prev, to: next });
  }

  // --- lifecycle -----------------------------------------------------------

  // options: { source: {type:'screen'|'window'|'camera', id?}, mic, micDeviceId,
  //            systemAudio, preferH264, videoBitsPerSecond, timesliceMs,
  //            suggestedName, recordingId }
  async start(options = {}) {
    if (this._state !== STATES.IDLE) {
      throw new Error(`Cannot start recording from state "${this._state}"`);
    }
    this._setState(STATES.ACQUIRING);

    try {
      const recordingId = options.recordingId || `recording_${this.now()}_${Math.floor(Math.random() * 1e6)}`;
      const stream = await this.acquireStream(options);
      if (!stream || stream.getVideoTracks().length === 0) {
        throw new Error('No video track was captured from the selected source.');
      }
      const mimeType = this.chooseMimeType(options);

      const recorder = new this.MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: options.videoBitsPerSecond || DEFAULT_BITRATE,
      });

      this._stream = stream;
      this._recorder = recorder;
      this._recordingId = recordingId;
      this._mimeType = mimeType;

      await this.api.recordingStart({ recordingId, mimeType, suggestedName: options.suggestedName || null });

      this._attachRecorder(recorder);
      this._startTime = this.now();
      recorder.start(options.timesliceMs || DEFAULT_TIMESLICE_MS);

      this._setState(STATES.RECORDING);
      this._emit('started', { recordingId, mimeType });
      return { recordingId, mimeType };
    } catch (err) {
      this._stopTracks();
      // If the IPC start succeeded but something after failed, drop the orphan.
      if (this._recordingId) { try { await this.api.recordingAbort(this._recordingId); } catch { /* best effort */ } }
      this._fail(err);
      throw err;
    }
  }

  // Stop and finalize. Emits 'finalized' with { recordingId, mimeType, filePath }
  // once every chunk (including the final one) has been flushed to disk.
  async stop() {
    if (this._state !== STATES.RECORDING && this._state !== STATES.PAUSED) return;
    if (this._pausedAt != null) {
      // Close the open pause span so the reported duration is correct.
      this._pausedAccumMs += this.now() - this._pausedAt;
      this._pausedAt = null;
    }
    this._setState(STATES.STOPPING);
    // stop() dispatches the final 'dataavailable' then 'stop'; _handleStopped finalizes.
    this._recorder.stop();
  }

  pause() {
    if (this._state !== STATES.RECORDING) return;
    this._recorder.pause();
    this._pausedAt = this.now();
    this._setState(STATES.PAUSED);
  }

  resume() {
    if (this._state !== STATES.PAUSED) return;
    this._recorder.resume();
    this._pausedAccumMs += this.now() - this._pausedAt;
    this._pausedAt = null;
    this._setState(STATES.RECORDING);
  }

  // Abandon the current recording and delete its on-disk artifacts.
  async cancel() {
    if (this._state === STATES.IDLE) return;
    const id = this._recordingId;
    try {
      if (this._recorder && this._recorder.state !== 'inactive') this._recorder.stop();
    } catch { /* already stopped */ }
    this._stopTracks();
    try { await this._writeChain; } catch { /* ignore */ }
    if (id) { try { await this.api.recordingAbort(id); } catch { /* best effort */ } }
    this._reset();
    this._setState(STATES.IDLE);
  }

  // Recover from an error back to idle so the user can try again.
  reset() {
    if (this._state === STATES.ERROR) {
      this._reset();
      this._setState(STATES.IDLE);
    }
  }

  _attachRecorder(recorder) {
    this._writeChain = Promise.resolve();

    recorder.ondataavailable = (event) => {
      const blob = event && event.data;
      if (!blob || blob.size === 0) return;
      // Chain each write after the previous so disk order == capture order,
      // no matter how the async IPC calls interleave.
      this._writeChain = this._writeChain.then(async () => {
        if (this._state === STATES.ERROR) return;
        const buf = await blob.arrayBuffer();
        await this.api.recordingChunk(this._recordingId, buf);
      }).catch((err) => this._fail(err));
    };

    recorder.onstop = () => { this._handleStopped(); };
    recorder.onerror = (event) => { this._fail((event && event.error) || new Error('MediaRecorder error')); };
  }

  async _handleStopped() {
    if (this._state === STATES.ERROR) return;
    const recordingId = this._recordingId;
    const mimeType = this._mimeType;
    const durationMs = this.getDurationMs();
    try {
      await this._writeChain; // ensure all chunks, including the final one, are written
      this._stopTracks();
      const result = await this.api.recordingFinalize(recordingId);
      this._reset();
      this._setState(STATES.IDLE);
      this._emit('finalized', { recordingId, mimeType, durationMs, ...result });
    } catch (err) {
      this._fail(err);
    }
  }

  _fail(error) {
    if (this._state === STATES.ERROR) return;
    this._setState(STATES.ERROR);
    this._stopTracks();
    this._emit('error', { error });
  }

  _stopTracks() {
    if (this._drawFrame && this.cancelAnimationFrame) {
      try { this.cancelAnimationFrame(this._drawFrame); } catch { /* ignore */ }
      this._drawFrame = null;
    }
    for (const stream of this._ownedStreams) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    this._ownedStreams = [];
    if (this._stream) {
      for (const track of this._stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
  }

  // --- capture -------------------------------------------------------------

  async acquireStream(options = {}) {
    const source = options.source || { type: 'screen' };
    const base = await this._acquireVideoAndSystemAudio(source, options.systemAudio);

    const recordingStream = new this.MediaStream();
    if (options.cameraOverlay && source.type !== 'camera') {
      // cameraOverlay: true (legacy) or { x, y, w, shape, mirror }
      const layout = options.cameraOverlay === true
        ? DEFAULT_OVERLAY
        : { ...DEFAULT_OVERLAY, ...options.cameraOverlay };
      const composited = await this._composeCameraOverlayStream(base, options.cameraDeviceId, layout);
      for (const track of composited.getTracks()) recordingStream.addTrack(track);
    } else {
      for (const track of base.getTracks()) recordingStream.addTrack(track);
    }

    if (options.mic) {
      const micTracks = await this._acquireMicTracks(options.micDeviceId);
      for (const track of micTracks) recordingStream.addTrack(track);
    }
    return recordingStream;
  }

  async _composeCameraOverlayStream(base, cameraDeviceId, layout = DEFAULT_OVERLAY) {
    if (!this.document || !this.requestAnimationFrame) {
      throw new Error('Camera overlay compositing requires DOM canvas support.');
    }

    const sourceVideo = this.document.createElement('video');
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    sourceVideo.srcObject = base;

    const camera = await this.mediaDevices.getUserMedia({
      video: {
        ...(cameraDeviceId ? { deviceId: { ideal: cameraDeviceId } } : {}),
        width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 },
      },
      audio: false,
    });
    const cameraVideo = this.document.createElement('video');
    cameraVideo.muted = true;
    cameraVideo.playsInline = true;
    cameraVideo.srcObject = camera;

    await Promise.all([this._playVideo(sourceVideo), this._playVideo(cameraVideo)]);

    const settings = base.getVideoTracks()[0].getSettings ? base.getVideoTracks()[0].getSettings() : {};
    const width = sourceVideo.videoWidth || settings.width || 1280;
    const height = sourceVideo.videoHeight || settings.height || 720;

    const canvas = this.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create recording canvas.');

    // Overlay geometry from the layout (percent coords + width fraction), the
    // same coordinate system the preview bubble uses, so preview == output.
    const circle = layout.shape === 'circle';
    const ow = Math.round(width * layout.w);
    const oh = circle ? ow : Math.round(ow * 3 / 4);
    const ox = Math.round(width * layout.x / 100);
    const oy = Math.round(height * layout.y / 100);
    const cornerR = circle ? ow / 2 : Math.max(6, Math.round(ow * 0.07));

    const draw = () => {
      ctx.drawImage(sourceVideo, 0, 0, width, height);
      ctx.save();
      // Clip to the bubble shape, then draw the camera covering it (center-crop).
      ctx.beginPath();
      if (circle) ctx.arc(ox + ow / 2, oy + oh / 2, ow / 2, 0, Math.PI * 2);
      else if (ctx.roundRect) ctx.roundRect(ox, oy, ow, oh, cornerR);
      else ctx.rect(ox, oy, ow, oh);
      ctx.clip();

      const vw = cameraVideo.videoWidth || 640, vh = cameraVideo.videoHeight || 480;
      const va = vw / vh, da = ow / oh;
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (va > da) { sw = vh * da; sx = (vw - sw) / 2; }
      else { sh = vw / da; sy = (vh - sh) / 2; }

      if (layout.mirror) {
        ctx.translate(ox + ow, oy);
        ctx.scale(-1, 1);
        ctx.drawImage(cameraVideo, sx, sy, sw, sh, 0, 0, ow, oh);
      } else {
        ctx.drawImage(cameraVideo, sx, sy, sw, sh, ox, oy, ow, oh);
      }
      ctx.restore();
      this._drawFrame = this.requestAnimationFrame(draw);
    };
    draw();

    const stream = canvas.captureStream(30);
    for (const track of base.getAudioTracks()) stream.addTrack(track);

    this._ownedStreams.push(base, camera);
    return stream;
  }

  async _playVideo(video) {
    await new Promise((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.onloadedmetadata = resolve;
    });
    await video.play();
  }

  async _acquireVideoAndSystemAudio(source, systemAudio) {
    if (source.type === 'camera') {
      // Record the webcam directly. System audio does not apply.
      return await this.mediaDevices.getUserMedia({
        video: {
          ...(source.deviceId ? { deviceId: { ideal: source.deviceId } } : {}),
          width: { ideal: 1280 }, height: { ideal: 720 },
        },
        audio: false,
      });
    }

    // Screen or window via desktopCapturer source id.
    const videoMandatory = {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      maxWidth: 3840,
      maxHeight: 2160,
      minWidth: 640,
      minHeight: 360,
    };

    try {
      return await this.mediaDevices.getUserMedia({
        video: { mandatory: videoMandatory },
        audio: systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      });
    } catch (err) {
      if (systemAudio) {
        // Desktop-audio loopback is commonly unsupported (notably on macOS).
        // Degrade honestly: tell the UI, then capture video only.
        this._emit('warning', {
          code: 'system-audio-unavailable',
          message: 'System audio capture is not available on this system. Recording without it.',
        });
      }
      // Retry without size constraints (some protected windows reject them).
      return await this.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
      });
    }
  }

  async _acquireMicTracks(micDeviceId) {
    const constraints = micDeviceId
      ? { audio: { deviceId: { ideal: micDeviceId }, echoCancellation: true, noiseSuppression: true } }
      : { audio: { echoCancellation: true, noiseSuppression: true } };
    try {
      const stream = await this.mediaDevices.getUserMedia(constraints);
      return stream.getAudioTracks();
    } catch (err) {
      try {
        const stream = await this.mediaDevices.getUserMedia({ audio: true });
        this._emit('warning', { code: 'mic-fallback', message: 'Selected microphone unavailable; using the default.' });
        return stream.getAudioTracks();
      } catch (err2) {
        this._emit('warning', { code: 'mic-unavailable', message: 'Microphone unavailable; recording without it.' });
        return [];
      }
    }
  }

  chooseMimeType({ preferH264 = false } = {}) {
    const MR = this.MediaRecorder;
    const supported = (t) => !MR.isTypeSupported || MR.isTypeSupported(t);

    if (preferH264) {
      const mp4 = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
      ];
      for (const t of mp4) if (supported(t)) return t;
    }

    const webm = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
    ];
    for (const t of webm) if (supported(t)) return t;
    return 'video/webm';
  }
}

RecordingEngine.STATES = STATES;

// Export for both the renderer (script tag / window) and node tests (module.exports).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RecordingEngine;
}
if (typeof window !== 'undefined') {
  window.RecordingEngine = RecordingEngine;
}
