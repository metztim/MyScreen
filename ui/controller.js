/* MyScreen — RecorderController: the bridge between the React UI and the
   RecordingEngine + electronAPI. The engine stays the source of truth for
   recording state; React owns view/config state. The controller maps engine
   events to the UI's flow vocabulary and owns all stream lifecycles.

   Phase 2 behavior notes:
   - Camera overlay during recording uses the engine's existing paths: canvas
     compositing (fixed top-right) for window capture, the floating OS camera
     window for full-screen. Preview-position editing arrives with the
     parameterized compositing (Phase 4+).
   - Saving is automatic: generated filename into the configured folder. */
(function () {
  const api = window.electronAPI;

  function pad(n) { return String(n).padStart(2, '0'); }

  function generateName(prefix = 'MyScreen') {
    const d = new Date();
    return `${prefix} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${d.getHours()}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  function mapQuality(q) { return q === 'small' ? 'slow' : (q || 'balanced'); }

  class RecorderController {
    constructor() {
      this.engine = new window.RecordingEngine();
      this._get = null;
      this._set = null;
      this._toast = null;
      this._previewStream = null;
      this._camStream = null;
      this._timer = null;
      this._countdownTimer = null;
      this._conversionStart = null;
      this._quitting = false;
      this._attachEngine();
      this._attachMainEvents();
    }

    bind({ get, set, toast }) {
      this._get = get;
      this._set = set;
      this._toast = toast;
    }

    set(patch) { if (this._set) this._set(patch); }
    get() { return this._get ? this._get() : {}; }
    toast(msg) { if (this._toast) this._toast(msg); }

    // --- startup -------------------------------------------------------------

    async init() {
      try {
        const settings = await api.getSettings();
        this.set({
          format: settings.format, quality: settings.quality,
          camOn: settings.camOn, camDeviceId: settings.camDeviceId,
          camMirror: settings.camMirror, camShape: settings.camShape,
          camX: settings.camX, camY: settings.camY, camW: settings.camW,
          micOn: settings.micOn, micDeviceId: settings.micDeviceId,
          countdownOn: settings.countdownOn, hwEncode: settings.hwEncode,
          floatingOn: settings.floatingOn,
          folder: settings.folderDisplay, folderAbs: settings.folder,
          shareLink: settings.shareLink,
        });
      } catch (err) {
        this.toast('Could not load settings; using defaults.');
      }

      await this.refreshDropboxStatus();

      await this.refreshDevices();
      await this.refreshSources({ selectDefaults: true });
      const permissionsOk = await this.checkPermissions();
      if (permissionsOk) await this.checkRecovery();
      // else: recovery is offered after the permissions sheet closes
    }

    async persistSettings(patch) {
      try { await api.setSettings(patch); } catch { /* non-fatal */ }
    }

    // --- devices & sources -----------------------------------------------------

    async refreshDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 8)}` }));
        const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId !== 'default')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `Camera ${d.deviceId.slice(0, 8)}` }));
        this.set({ mics, cams });
      } catch (err) {
        this.toast('Failed to detect audio/video devices.');
      }
    }

    async refreshSources({ selectDefaults = false } = {}) {
      let sources;
      try {
        sources = await api.getSources();
      } catch (err) {
        this.toast('Could not list screens and windows. Check the screen recording permission.');
        return;
      }
      const screens = sources
        .filter((s) => s.id.startsWith('screen'))
        .map((s, i) => ({ id: s.id, kind: 'screen', title: s.name || `Display ${i + 1}`, sub: 'Display', thumbnail: s.thumbnail }));
      const windows = sources
        .filter((s) => s.id.startsWith('window') && s.name && s.name !== 'Window' && !s.name.includes('Item-') && s.thumbnail)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({ id: s.id, kind: 'window', app: s.name, title: '', thumbnail: s.thumbnail, appIcon: s.appIcon }));

      const patch = { pickScreens: screens, pickWindows: windows };
      const st = this.get();
      if (selectDefaults && screens.length && !st.screenSource) patch.screenSource = screens[0];
      // refresh the selected sources' thumbnails / drop vanished windows
      if (st.screenSource) patch.screenSource = screens.find((x) => x.id === st.screenSource.id) || screens[0] || null;
      if (st.windowSource) patch.windowSource = windows.find((x) => x.id === st.windowSource.id) || st.windowSource;
      this.set(patch);
    }

    // --- preview streams -------------------------------------------------------

    // Reconcile the desktop/camera preview with the current mode + source.
    // Skipped while the engine owns the capture (recording/stopping).
    async syncPreview() {
      const s = this.get();
      if (this._engineOwnsStage()) return;

      if (s.mode === 'camera') {
        this._stopPreview();
        await this._ensureCamStream();
        return;
      }

      const source = s.mode === 'screen' ? s.screenSource : s.windowSource;
      if (!source) { this._stopPreview(); this.set({ previewStream: null }); return; }
      if (this._previewSourceId === source.id && this._previewStream) return;

      this._stopPreview();
      try {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 3840, maxHeight: 2160, minWidth: 640, minHeight: 360 } },
          });
        } catch (err) {
          // Some protected windows reject size constraints; retry without.
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
          });
        }
        this._previewStream = stream;
        this._previewSourceId = source.id;
        this.set({ previewStream: stream });
      } catch (err) {
        this.set({ previewStream: null });
        this.toast('Could not preview that source. Check the screen recording permission.');
      }
    }

    // Camera feed for the overlay bubble / camera-only stage.
    async syncCamera() {
      const s = this.get();
      if (this._engineOwnsStage()) return;
      const wantCam = s.mode === 'camera' || s.camOn;

      if (!wantCam) { this._stopCam(); return; }
      if (this._camStream && this._camDeviceId === (s.camDeviceId || '')) return;

      this._stopCam();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(s.camDeviceId ? { deviceId: { ideal: s.camDeviceId } } : {}),
            width: { ideal: 1280 }, height: { ideal: 720 },
          },
          audio: false,
        });
        this._camStream = stream;
        this._camDeviceId = s.camDeviceId || '';
        this.set({ camStream: stream });
        // Labels become available after the first permission grant.
        if (!(this.get().cams || []).some((c) => c.label && !c.label.startsWith('Camera '))) this.refreshDevices();
      } catch (err) {
        this.set({ camStream: null, camOn: s.mode === 'camera' ? s.camOn : false });
        this.toast('Unable to access the camera. Check it is connected and permitted.');
      }
    }

    _stopPreview() {
      if (this._previewStream) {
        this._previewStream.getTracks().forEach((t) => t.stop());
        this._previewStream = null;
        this._previewSourceId = null;
      }
    }

    _stopCam() {
      if (this._camStream) {
        this._camStream.getTracks().forEach((t) => t.stop());
        this._camStream = null;
        this._camDeviceId = null;
      }
      this.set({ camStream: null });
    }

    _engineOwnsStage() {
      return ['recording', 'stopping'].includes(this.engine.state);
    }

    async _restorePreviews() {
      this._previewSourceId = null; // force re-acquire
      await this.syncPreview();
      await this.syncCamera();
    }

    // --- recording flow ----------------------------------------------------------

    startRecording() {
      const s = this.get();
      if (s.flow !== 'ready' || this.engine.state !== 'idle') return;
      if (s.countdownOn) {
        this.set({ flow: 'countdown', countdownN: 3 });
        this._countdownTimer = setInterval(() => {
          const n = this.get().countdownN - 1;
          if (n <= 0) {
            clearInterval(this._countdownTimer); this._countdownTimer = null;
            this._begin();
          } else {
            this.set({ countdownN: n });
          }
        }, 850);
      } else {
        this.set({ flow: 'countdown', countdownN: 0 }); // transport shows "Starting…"
        this._begin();
      }
    }

    cancelCountdown() {
      if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null; }
      if (this.get().flow === 'countdown') this.set({ flow: 'ready' });
    }

    async _begin() {
      const s = this.get();
      const source = s.mode === 'camera'
        ? { type: 'camera', deviceId: s.camDeviceId || undefined, name: 'Camera' }
        : s.mode === 'screen'
          ? { type: 'screen', id: s.screenSource && s.screenSource.id, name: s.screenSource && s.screenSource.title }
          : { type: 'window', id: s.windowSource && s.windowSource.id, name: s.windowSource && s.windowSource.app };

      if (source.type !== 'camera' && !source.id) {
        this.set({ flow: 'ready' });
        this.toast('Pick a source first.');
        return;
      }

      // Overlay layout shares the preview bubble's coordinate system, so the
      // recorded output matches what the user arranged on the stage. Both
      // full-screen and window capture composite through the same canvas path.
      const cameraOverlay = s.mode !== 'camera' && s.camOn
        ? { x: s.camX, y: s.camY, w: s.camW, shape: s.camShape, mirror: s.camMirror }
        : false;
      if (cameraOverlay) {
        // The engine acquires its own camera for compositing; release the bubble's.
        this._stopCam();
        await new Promise((r) => setTimeout(r, 150));
      }

      try {
        await this.engine.start({
          source,
          cameraOverlay,
          cameraDeviceId: s.camDeviceId || undefined,
          mic: s.micOn,
          micDeviceId: s.micDeviceId || undefined,
          systemAudio: false, // not supported on macOS; shown as info in the panel
          preferH264: s.hwEncode,
          suggestedName: `${generateName()}.webm`,
        });
      } catch (err) {
        this.set({ flow: 'ready' });
        this.toast(`Could not start recording: ${err.message}`);
        this.engine.reset();
        await this._restorePreviews();
      }
    }

    stop() {
      if (this.engine.isRecording) this.engine.stop();
    }

    togglePause() {
      if (this.engine.isPaused) this.engine.resume();
      else if (this.engine.state === 'recording') this.engine.pause();
    }

    async discard() {
      this._stopTimer();
      await this.engine.cancel();
      this.set({ flow: 'ready', elapsed: 0 });
      this.toast('Recording discarded.');
      await this._restorePreviews();
    }

    // --- engine events -----------------------------------------------------------

    _attachEngine() {
      this.engine.on('started', () => {
        // The engine owns the capture now; show its stream and drop the preview
        // so the source is only captured once.
        this._stopPreview();
        this.set({ flow: 'recording', elapsed: 0, previewStream: this.engine.stream, camStream: null });
        this._startTimer();
      });
      this.engine.on('state', ({ to, from }) => {
        if (to === 'stopping') { this._stopTimer(); this.set({ flow: 'stopping' }); }
        else if (to === 'paused') this.set({ flow: 'paused' });
        else if (to === 'recording' && from === 'paused') this.set({ flow: 'recording' });
      });
      this.engine.on('finalized', (info) => { this._onFinalized(info); });
      this.engine.on('warning', ({ message }) => this.toast(message));
      this.engine.on('error', async ({ error }) => {
        this._stopTimer();
        this.engine.reset();
        this.set({ flow: 'ready', elapsed: 0, previewStream: null });
        this.toast(`Recording error: ${error.message}`);
        await this._restorePreviews();
      });
    }

    async _onFinalized({ recordingId, mimeType, durationMs }) {
      if (this._quitting) return; // leave the finalized file for next-launch recovery
      this.set({ previewStream: null });
      const s = this.get();

      let folder;
      try {
        folder = await api.ensureSaveFolder();
      } catch (err) {
        this.toast(`Cannot access the save folder: ${err.message}`);
        this.set({ flow: 'ready' });
        return;
      }

      const isMp4 = (mimeType || '').includes('mp4');
      const wantMp4 = s.format === 'mp4';
      const convert = wantMp4 && !isMp4;
      const ext = (isMp4 || wantMp4) ? '.mp4' : '.webm';
      const destPath = `${folder}/${generateName()}${ext}`;

      this.set({ flow: 'saving', saveProgress: convert ? 0 : 50, saveEta: '', lastDuration: Math.round((durationMs || 0) / 1000) });
      this._conversionStart = null;
      this._restorePreviews(); // background: stage is hidden behind the sheet

      try {
        const result = await api.recordingSave({
          recordingId, destPath, convert,
          quality: mapQuality(s.quality),
          durationSeconds: durationMs ? durationMs / 1000 : 0,
        });
        const savedPath = result.filePath || destPath;
        this.set({ flow: 'saved', saveProgress: 100, lastFileName: savedPath.split('/').pop(), lastFilePath: savedPath });
        if (result.conversionFailed) this.toast('MP4 conversion failed; saved as WebM instead.');
        this.maybeShare(savedPath);
      } catch (err) {
        this.set({ flow: 'ready' });
        this.toast(`Save failed: ${err.message}`);
      }
    }

    // --- Dropbox link sharing -------------------------------------------------------

    async refreshDropboxStatus() {
      try {
        this.set({ dropbox: await api.dropboxStatus() });
      } catch {
        this.set({ dropbox: { connected: false, account: '', appKeySet: false } });
      }
    }

    async connectDropbox() {
      this.toast('Continue in your browser to connect Dropbox…');
      try {
        const { account } = await api.dropboxConnect();
        await this.refreshDropboxStatus();
        this.set({ shareLink: true });
        this.toast(`Dropbox connected as ${account}.`);
      } catch (err) {
        this.toast(`Dropbox connection failed: ${err.message}`);
      }
    }

    async disconnectDropbox() {
      try {
        this.set({ dropbox: await api.dropboxDisconnect(), shareLink: false });
      } catch (err) {
        this.toast(`Could not disconnect: ${err.message}`);
      }
    }

    // Upload + create the shared link after a successful save, when enabled.
    maybeShare(filePath) {
      const s = this.get();
      if (!s.shareLink || !s.dropbox || !s.dropbox.connected) {
        this.set({ shareState: 'none', shareUrl: '', shareProgress: 0 });
        return;
      }
      this._share(filePath);
    }

    async _share(filePath) {
      this.set({ shareState: 'uploading', shareUrl: '', shareProgress: 0, sharePath: filePath });
      try {
        const { url } = await api.dropboxShare(filePath);
        this.set({ shareState: 'ready', shareUrl: url, shareProgress: 100 });
        try { await navigator.clipboard.writeText(url); this.toast('Dropbox link copied to clipboard.'); }
        catch { this.toast('Dropbox link is ready.'); }
      } catch (err) {
        this.set({ shareState: 'error' });
        this.toast(`Dropbox upload failed: ${err.message}`);
      }
    }

    retryShare() {
      const p = this.get().sharePath;
      if (p) this._share(p);
    }

    async copyShareUrl() {
      const url = this.get().shareUrl;
      if (!url) return false;
      try { await navigator.clipboard.writeText(url); return true; }
      catch { this.toast('Could not copy the link.'); return false; }
    }

    // --- timer ---------------------------------------------------------------------

    _startTimer() {
      this._stopTimer();
      this._timer = setInterval(() => {
        this.set({ elapsed: Math.floor(this.engine.getDurationMs() / 1000) });
      }, 250);
    }

    _stopTimer() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // --- conversion progress ---------------------------------------------------------

    _attachMainEvents() {
      api.onConversionProgress(({ progress, currentTime, totalTime }) => {
        if (this.get().flow !== 'saving') return;
        let eta = '';
        if (currentTime && totalTime && progress > 1) {
          if (!this._conversionStart) this._conversionStart = Date.now();
          const elapsed = (Date.now() - this._conversionStart) / 1000;
          if (elapsed > 2) {
            const secsLeft = Math.max(0, (100 - progress) / (progress / elapsed));
            if (secsLeft < 3600) {
              const m = Math.floor(secsLeft / 60), sec = Math.floor(secsLeft % 60);
              eta = `${m}:${pad(sec)} left`;
            }
          }
        }
        this.set({ saveProgress: progress, saveEta: eta });
      });
      api.onConversionStart(() => { this._conversionStart = null; });
      api.onConversionComplete(() => {});
      api.onConversionStatus(() => {});
      api.onLibraryMeta((meta) => this._mergeLibraryMeta(meta));
      api.onDropboxProgress(({ percent }) => {
        if (this.get().shareState === 'uploading') this.set({ shareProgress: percent });
      });

      // Window closing: stream-to-disk means the data is already safe. Finalize
      // cleanly without dialogs; recovery offers the file next launch.
      api.onAppClosing(async () => {
        this._quitting = true;
        if (this.engine.isRecording || this.engine.state === 'stopping') {
          try {
            await new Promise((resolve) => {
              const done = this.engine.on('finalized', () => { done(); resolve(); });
              setTimeout(resolve, 4000); // never block quit indefinitely
              this.engine.stop();
            });
          } catch { /* the partial file remains recoverable */ }
        }
        api.confirmQuit();
      });
    }

    // --- crash recovery -----------------------------------------------------------------

    async checkRecovery() {
      let orphans;
      try {
        orphans = await api.listRecoverable();
      } catch (err) {
        console.error('Recovery check failed:', err);
        return;
      }
      if (!orphans || orphans.length === 0) return;
      this.set({
        flow: 'recovery',
        recoverable: orphans.map((o) => ({
          recordingId: o.recordingId,
          mimeType: o.mimeType || 'video/webm',
          title: o.suggestedName || 'Screen recording',
          when: o.startedAt ? new Date(o.startedAt).toLocaleString() : 'Unknown time',
          detail: this._formatBytes(o.size),
        })),
      });
    }

    async recoverFirst() {
      const s = this.get();
      const item = (s.recoverable || [])[0];
      if (!item) { this.set({ flow: 'ready' }); return; }

      let folder;
      try {
        folder = await api.ensureSaveFolder();
      } catch (err) {
        this.toast(`Cannot access the save folder: ${err.message}`);
        return;
      }

      const isMp4 = item.mimeType.includes('mp4');
      const wantMp4 = s.format === 'mp4';
      const convert = wantMp4 && !isMp4;
      const ext = (isMp4 || wantMp4) ? '.mp4' : '.webm';
      const destPath = `${folder}/${generateName('MyScreen recovered')}${ext}`;
      const rest = (s.recoverable || []).slice(1);

      this.set({ flow: 'saving', saveProgress: convert ? 0 : 50, saveEta: '', lastDuration: 0, recoverable: rest });
      this._conversionStart = null;

      try {
        const result = await api.recoverRecording({ recordingId: item.recordingId, destPath, convert, quality: mapQuality(s.quality) });
        const savedPath = result.filePath || destPath;
        this.set({ flow: 'saved', saveProgress: 100, lastFileName: savedPath.split('/').pop(), lastFilePath: savedPath });
        if (result.conversionFailed) this.toast('MP4 conversion failed; recovered as WebM instead.');
        this.maybeShare(savedPath);
      } catch (err) {
        this.set({ flow: 'ready' });
        this.toast(`Recovery failed: ${err.message}`);
      }
    }

    async discardFirstRecoverable() {
      const s = this.get();
      const item = (s.recoverable || [])[0];
      const rest = (s.recoverable || []).slice(1);
      if (item) {
        try { await api.discardRecording(item.recordingId); } catch { /* best effort */ }
      }
      this.set(rest.length ? { recoverable: rest } : { flow: 'ready', recoverable: [] });
      this.toast('Unsaved recording discarded.');
    }

    reveal() {
      const p = this.get().lastFilePath;
      if (p) api.revealInFinder(p);
    }

    // --- permissions preflight ------------------------------------------------------

    _mapPerm(v) { return v === 'granted' ? 'ok' : 'todo'; }

    // Returns true when everything needed is already granted.
    async checkPermissions() {
      let p;
      try {
        p = await api.permissionsCheck();
      } catch {
        return true; // can't check: don't block the app
      }
      const permState = { screen: this._mapPerm(p.screen), cam: this._mapPerm(p.camera), mic: this._mapPerm(p.microphone) };
      this.set({ permState });
      // The screen permission is the only hard requirement; cam/mic prompt inline.
      if (permState.screen !== 'ok') {
        this.set({ flow: 'permissions' });
        this._startPermissionPolling();
        return false;
      }
      return true;
    }

    async requestPermission(key) {
      const type = key === 'cam' ? 'camera' : key === 'mic' ? 'microphone' : 'screen';
      try {
        await api.permissionsRequest(type); // cam/mic: OS prompt; screen: opens System Settings
      } catch { /* reflected by the next poll */ }
      await this._refreshPermState();
    }

    async _refreshPermState() {
      try {
        const p = await api.permissionsCheck();
        this.set({ permState: { screen: this._mapPerm(p.screen), cam: this._mapPerm(p.camera), mic: this._mapPerm(p.microphone) } });
      } catch { /* keep current */ }
    }

    _startPermissionPolling() {
      this._stopPermissionPolling();
      this._permPoll = setInterval(() => {
        if (this.get().flow !== 'permissions') { this._stopPermissionPolling(); return; }
        this._refreshPermState();
      }, 2000);
    }

    _stopPermissionPolling() {
      if (this._permPoll) { clearInterval(this._permPoll); this._permPoll = null; }
    }

    async relaunchApp() {
      try { await api.appRelaunch(); } catch { /* app is exiting */ }
    }

    async finishPermissions() {
      this._stopPermissionPolling();
      this.set({ flow: 'ready' });
      await this.refreshSources({ selectDefaults: true });
      await this._restorePreviews();
      await this.checkRecovery();
    }

    // --- recordings library ------------------------------------------------------------

    async loadLibrary() {
      let entries;
      try {
        entries = await api.libraryList();
      } catch (err) {
        this.toast(`Could not read the recordings folder: ${err.message}`);
        return;
      }
      this.set({ recordings: entries.map((en) => this._toLibraryItem(en)) });
    }

    _toLibraryItem(en) {
      return {
        id: en.path,
        path: en.path,
        title: en.name.replace(/\.(mp4|webm)$/i, ''),
        dur: en.durationSeconds != null ? this._fmtDur(en.durationSeconds) : '…',
        when: this._friendlyDate(en.mtimeMs),
        size: this._formatBytes(en.sizeBytes),
        src: en.name.toLowerCase().endsWith('.webm') ? 'WebM' : 'MP4',
        thumbnail: en.thumbnailDataUrl,
      };
    }

    _mergeLibraryMeta(meta) {
      const recs = this.get().recordings || [];
      this.set({
        recordings: recs.map((r) => r.path === meta.path
          ? { ...r, thumbnail: meta.thumbnailDataUrl || r.thumbnail, dur: meta.durationSeconds != null ? this._fmtDur(meta.durationSeconds) : r.dur }
          : r),
      });
    }

    openRecording(rec) {
      if (rec && rec.path) api.libraryOpen(rec.path);
    }

    async chooseFolder() {
      try {
        const result = await api.chooseFolder();
        if (result) this.set({ folder: result.folderDisplay, folderAbs: result.folder });
      } catch (err) {
        this.toast(`Could not change the folder: ${err.message}`);
      }
    }

    _fmtDur(sec) {
      sec = Math.round(sec);
      const m = Math.floor(sec / 60), s = sec % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    }

    _friendlyDate(ms) {
      const d = new Date(ms), now = new Date();
      const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
      const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (day(d) === day(now)) return `Today, ${time}`;
      const yest = new Date(now); yest.setDate(now.getDate() - 1);
      if (day(d) === day(yest)) return `Yesterday, ${time}`;
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    _formatBytes(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
    }
  }

  window.RecorderController = RecorderController;
})();
