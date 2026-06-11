/* MyScreen — root app. React owns view/config state; RecorderController owns
   the engine, streams, and IPC. Flow vocabulary:
   ready|picker|overlayEdit|countdown|recording|stopping|saving|saved|permissions|recovery
   ('paused' joins in the pause/resume phase.) */
(function () {
  const e = React.createElement;
  const { useState, useEffect, useRef } = React;
  const Icon = window.Icon;

  const INITIAL = {
    view: 'recorder',
    flow: 'ready',
    mode: 'screen',
    screenSource: null,
    windowSource: null,
    pickScreens: [], pickWindows: [],
    camOn: false, camDeviceId: '', camMirror: true, camShape: 'rounded',
    camX: 70, camY: 64, camW: 0.2,
    overlayEditable: true,         // engine composites the overlay at the arranged layout (window mode)
    micOn: true, micDeviceId: '',
    mics: [], cams: [],
    format: 'mp4', quality: 'balanced',
    folder: '~/Movies/MyScreen', folderAbs: '',
    shareLink: false,
    dropbox: { connected: false, account: '', appKeySet: false },
    shareState: 'none', shareUrl: '', shareProgress: 0, sharePath: '',
    countdownOn: true,
    hwEncode: false, floatingOn: true,
    countdownN: 3,
    elapsed: 0, lastDuration: 0,
    saveProgress: 0, saveEta: '',
    lastFileName: '', lastFilePath: '',
    recoverable: [],
    previewStream: null, camStream: null,
    permState: { screen: 'ok', cam: 'ok', mic: 'ok' },
    toastMsg: '',
  };

  // settings persisted across sessions (must exist in main.js SETTINGS_DEFAULTS)
  const PERSISTED = ['format', 'quality', 'camOn', 'camDeviceId', 'camMirror', 'camShape',
    'camX', 'camY', 'camW', 'micOn', 'micDeviceId', 'countdownOn', 'hwEncode', 'floatingOn',
    'shareLink'];

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function App() {
    const [s, setS] = useState(INITIAL);
    const set = (patch) => setS((p) => ({ ...p, ...patch }));
    const sRef = useRef(s); sRef.current = s;
    const toastT = useRef(null);

    function toast(msg) {
      set({ toastMsg: msg || '' });
      clearTimeout(toastT.current);
      toastT.current = setTimeout(() => set({ toastMsg: '' }), 3200);
    }

    // one controller for the app's lifetime
    const ctrlRef = useRef(null);
    if (!ctrlRef.current) ctrlRef.current = new window.RecorderController();
    const c = ctrlRef.current;
    c.bind({ get: () => sRef.current, set, toast });

    useEffect(() => { c.init(); }, []);
    useEffect(() => { window.__ms = { set, get: () => sRef.current, controller: c }; });

    // reconcile streams with mode/source/camera config
    const screenId = s.screenSource && s.screenSource.id;
    const windowId = s.windowSource && s.windowSource.id;
    useEffect(() => { c.syncPreview(); }, [s.mode, screenId, windowId]);
    useEffect(() => { c.syncCamera(); }, [s.mode, s.camOn, s.camDeviceId]);

    // persist settings (debounced)
    const persistT = useRef(null);
    const persistKey = PERSISTED.map((k) => JSON.stringify(s[k])).join('|');
    const hydrated = useRef(false);
    useEffect(() => {
      if (!hydrated.current) { hydrated.current = true; return; } // skip pre-hydration state
      clearTimeout(persistT.current);
      persistT.current = setTimeout(() => {
        const patch = {};
        for (const k of PERSISTED) patch[k] = sRef.current[k];
        c.persistSettings(patch);
      }, 500);
    }, [persistKey]);

    // --- actions -------------------------------------------------------------
    function setMode(m) {
      if (m === 'window' && !sRef.current.windowSource) { openPicker(m); return; }
      set({ mode: m });
    }
    const source = s.mode === 'screen' ? s.screenSource : s.mode === 'window' ? s.windowSource : null;

    async function openPicker(pendingMode) {
      set({ flow: 'picker', pickerPendingMode: pendingMode || null });
      c.refreshSources();
    }
    function closePicker() { set({ flow: 'ready', pickerPendingMode: null }); }
    function confirmPicker(item) {
      if (!item) return;
      if (item.kind === 'screen') set({ screenSource: item, mode: 'screen', flow: 'ready', pickerPendingMode: null });
      else set({ windowSource: item, mode: 'window', flow: 'ready', pickerPendingMode: null });
    }
    function editOverlay() {
      if (!sRef.current.overlayEditable) return;
      set({ flow: 'overlayEdit' });
    }
    function setFlow(f) { set({ flow: f }); }

    function recordAgain() { set({ flow: 'ready', elapsed: 0, saveProgress: 0 }); }
    function doneSaved() {
      const next = sRef.current.recoverable.length ? 'recovery' : 'ready';
      set({ flow: next, view: next === 'ready' ? 'library' : 'recorder', elapsed: 0, saveProgress: 0 });
    }
    function newRecording() { set({ view: 'recorder', flow: 'ready', elapsed: 0 }); }

    const pauseSupported = typeof c.engine.pause === 'function';

    const actions = {
      setMode, openPicker, closePicker, confirmPicker, editOverlay, setFlow,
      startRecording: () => c.startRecording(),
      togglePause: () => c.togglePause(),
      stop: () => c.stop(),
      discardRecording: () => c.discard(),
      recordAgain, doneSaved, newRecording,
      grant: (k) => c.requestPermission(k),
      finishPermissions: () => c.finishPermissions(),
      relaunch: () => c.relaunchApp(),
      probeMic: () => c.probeMic(),
      recover: () => c.recoverFirst(),
      discardRecovery: () => c.discardFirstRecoverable(),
      reveal: () => c.reveal(),
      openRecording: (r) => c.openRecording(r),
      chooseFolder: () => c.chooseFolder(),
      connectDropbox: () => c.connectDropbox(),
      disconnectDropbox: () => c.disconnectDropbox(),
      retryShare: () => c.retryShare(),
      copyShareUrl: () => c.copyShareUrl(),
      toast, fmt,
    };

    // refresh the library whenever it comes into view
    useEffect(() => { if (s.view === 'library') c.loadLibrary(); }, [s.view]);

    // keyboard: space starts when ready; escape cancels countdown / leaves overlay edit
    useEffect(() => {
      function onKey(ev) {
        const st = sRef.current;
        if (ev.code === 'Space' && st.flow === 'ready' && st.view === 'recorder' && ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'SELECT') {
          ev.preventDefault(); c.startRecording();
        } else if (ev.code === 'Escape') {
          if (st.flow === 'overlayEdit') setFlow('ready');
          else if (st.flow === 'countdown') c.cancelCountdown();
        }
      }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);

    // --- derived transport content ---------------------------------------------
    const stateInfo = (() => {
      switch (s.flow) {
        case 'recording': return { led: 'rec', t: 'Recording', sub: (s.mode === 'screen' ? 'Full screen' : s.mode === 'window' ? (source ? source.app : 'Window') : 'Camera') + (s.micOn ? ' · mic on' : '') };
        case 'paused': return { led: 'busy', t: 'Paused', sub: 'Recording is paused' };
        case 'stopping': return { led: 'busy', t: 'Finishing up…', sub: 'Writing the final chunk' };
        case 'countdown': return { led: 'busy', t: 'Starting…', sub: 'Get ready' };
        default: {
          const where = s.mode === 'screen' ? (source ? source.title : 'screen') : s.mode === 'window' ? (source ? source.app : 'a window') : 'your camera';
          const bits = [where];
          if (s.camOn && s.mode !== 'camera') bits.push('camera');
          bits.push(s.micOn ? 'mic' : 'no mic');
          bits.push(s.format === 'mp4' ? 'MP4' : 'WebM');
          if (s.shareLink && s.dropbox.connected) bits.push('share link');
          return { led: 'ok', t: 'Ready to record', sub: 'Will capture ' + bits.join(' · ') };
        }
      }
    })();

    const recordingNow = s.flow === 'recording' || s.flow === 'paused';

    // --- render -----------------------------------------------------------------
    return e('div', { className: 'win' },
      e('div', { className: 'titlebar' },
        e('div', { className: 'brand' }, MarkSVG(), e('span', { className: 'name' }, 'MyScreen')),
        e('div', { className: 'tb-spacer' }),
        e('div', { className: 'tb-nav' },
          e('button', { className: 'tb-btn' + (s.view === 'recorder' ? ' active' : ''), onClick: () => set({ view: 'recorder' }) }, e(Icon, { name: 'webcam', size: 15, className: 'ic' }), 'Record'),
          e('button', { className: 'tb-btn' + (s.view === 'library' ? ' active' : ''), onClick: () => set({ view: 'library' }) }, e(Icon, { name: 'film', size: 15, className: 'ic' }), 'Recordings'),
        ),
      ),

      s.view === 'library'
        ? e('div', { className: 'body' }, e(window.Library, { recordings: s.recordings || [], actions }))
        : e(React.Fragment, null,
            e('div', { className: 'body' },
              e('div', { className: 'stage-col' },
                e(window.Stage, { s: { ...s, source }, set, actions }),
              ),
              e('div', { className: 'panel-col' },
                e(window.SetupPanel, { s: { ...s, source }, set, actions }),
              ),
            ),
            e(Transport, { s, stateInfo, recordingNow, pauseSupported, actions }),
          ),

      s.flow === 'picker' ? e(window.Picker, { s: { ...s, source }, actions }) : null,
      s.flow === 'permissions' ? e(window.Permissions, { s, actions }) : null,
      s.flow === 'recovery' ? e(window.Recovery, { actions, recoverable: s.recoverable }) : null,
      s.flow === 'saving' ? e(window.Saving, { s, actions }) : null,
      s.flow === 'saved' ? e(window.Saved, { s, actions }) : null,
      e(window.Toast, { msg: s.toastMsg }),
    );
  }

  function Transport({ s, stateInfo, recordingNow, pauseSupported, actions }) {
    return e('div', { className: 'transport' },
      e('div', { className: 'state-pill' },
        e('div', { className: 'state-led ' + stateInfo.led }),
        e('div', { className: 'state-tx' }, e('div', { className: 't' }, stateInfo.t), e('div', { className: 's' }, stateInfo.sub)),
      ),
      e('div', { className: 'spacer' }),
      e('div', { className: 'timer ' + (recordingNow ? 'rec' : s.flow === 'stopping' ? '' : 'dim') }, fmt(s.elapsed)),
      recordingNow
        ? e('div', { style: { display: 'flex', gap: 10 } },
            pauseSupported
              ? e('button', { className: 'btn-ghost', onClick: actions.togglePause, title: s.flow === 'paused' ? 'Resume' : 'Pause' }, e(Icon, { name: s.flow === 'paused' ? 'play' : 'pause', size: 18, fill: s.flow === 'paused' ? 'currentColor' : 'none' }))
              : null,
            e('button', { className: 'btn btn-stop', onClick: actions.stop }, e('span', { className: 'sq' }), 'Stop'),
          )
        : s.flow === 'stopping'
          ? e('button', { className: 'btn btn-stop', disabled: true }, 'Finishing…')
          : e('button', { className: 'btn btn-rec', disabled: s.flow === 'countdown', onClick: actions.startRecording }, e('span', { className: 'rec-dot' }), 'Start recording'),
    );
  }

  function MarkSVG() {
    return e('svg', { className: 'mark', viewBox: '0 0 32 32', fill: 'none' },
      e('rect', { x: 2, y: 5, width: 28, height: 22, rx: 6, fill: '#14aae2' }),
      e('circle', { cx: 16, cy: 16, r: 6, fill: '#fff' }),
      e('circle', { cx: 16, cy: 16, r: 2.6, fill: '#e8212d' }),
    );
  }

  window.MyScreenApp = App;
})();
