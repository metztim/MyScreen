/* MyScreen — setup panel: compact rows + left-opening popovers, no scrolling */
(function () {
  const e = React.createElement;
  const { useState, useEffect } = React;
  const Icon = window.Icon;
  const { Toggle, LevelMeter } = window;

  function Sec({ title, children }) {
    return e('div', { className: 'sec' },
      e('div', { className: 'sec-head' }, e('div', { className: 'sec-title' }, title)),
      children,
    );
  }

  function Seg({ value, options, onChange }) {
    return e('div', { className: 'seg' },
      options.map((o) => e('button', {
        key: o.v, className: value === o.v ? 'sel' : '', onClick: () => onChange(o.v),
      }, o.label)),
    );
  }

  function ModeCard({ icon, label, active, onClick }) {
    return e('button', { className: 'mode' + (active ? ' active' : ''), onClick },
      e(Icon, { name: icon, size: 21, strokeWidth: 1.7, className: 'ic' }),
      e('div', { className: 'lbl' }, label),
    );
  }

  /* a compact device row: icon · title/sub · (extra) · toggle · chevron.
     Clicking the row (not the toggle) opens its popover. */
  function DevRow({ icon, title, sub, on, onToggle, disabled, noToggle, extra, open, onOpen, popover, dir }) {
    return e('div', { className: 'rowwrap' },
      e('div', {
        className: 'devrow' + (on ? ' on' : '') + (disabled ? ' disabled' : '') + (open ? ' open' : ''),
        role: 'button', tabIndex: disabled ? -1 : 0,
        onClick: disabled ? undefined : onOpen,
        onKeyDown: disabled ? undefined : (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen(); } },
      },
        e('div', { className: 'ic-wrap' }, e(Icon, { name: icon, size: 18 })),
        e('div', { className: 'tx' },
          e('div', { className: 't' }, title),
          sub ? e('div', { className: 's' }, sub) : null,
        ),
        extra || null,
        noToggle ? null : e(Toggle, { on, onChange: disabled ? () => {} : onToggle }),
        e(Icon, { name: 'chevright', size: 14, className: 'chev' }),
      ),
      open ? e(Popover, { dir }, popover) : null,
    );
  }

  function Popover({ dir = 'down', children }) {
    return e('div', { className: 'pop ' + dir, onClick: (ev) => ev.stopPropagation() }, children);
  }

  function PopRow({ title, sub, on, onChange }) {
    return e('div', { className: 'trow', style: { padding: 0 } },
      e('div', { className: 'tx' },
        e('div', { className: 't', style: { fontSize: 13 } }, title),
        sub ? e('div', { className: 's' }, sub) : null,
      ),
      e(Toggle, { on, onChange }),
    );
  }

  // "Copy" button that confirms in place.
  function CopyAction({ icon, label, onCopy }) {
    const [copied, setCopied] = useState(false);
    return e('button', {
      className: 'pop-action',
      onClick: async () => { if (await onCopy()) { setCopied(true); setTimeout(() => setCopied(false), 1800); } },
    }, e(Icon, { name: copied ? 'check' : icon, size: 14 }), copied ? 'Copied. Paste it in a terminal' : label);
  }

  // The one-time speech model download, wherever it is offered.
  function ModelDownload({ s, actions }) {
    const model = s.agentInfo && s.agentInfo.model;
    if (!model) return null;
    const mb = Math.round(model.sizeBytes / 1e6);
    const dl = s.modelDl;
    if (dl.state === 'downloading' || dl.state === 'verifying') {
      return e('div', { className: 'model-dl' },
        e('div', { className: 'prog' }, e('div', { className: 'fill', style: { width: dl.percent + '%' } })),
        e('div', { className: 'prog-meta', style: { marginTop: 6 } },
          e('span', null, dl.state === 'verifying' ? 'Checking the download…' : 'Downloading… ' + dl.percent + '% of ' + mb + ' MB'),
          dl.state === 'downloading' ? e('button', { className: 'link-btn', onClick: actions.cancelModelDownload }, 'Cancel') : null,
        ),
      );
    }
    return e('div', { className: 'model-dl' },
      dl.state === 'failed' ? e('div', { className: 'field-note', style: { color: 'var(--red)' } }, dl.detail) : null,
      e('button', { className: 'pop-action', onClick: actions.downloadModel },
        e(Icon, { name: 'download', size: 14 }),
        (dl.state === 'failed' || dl.percent > 0 ? 'Resume download' : 'Download speech model') + ' (' + mb + ' MB)'),
    );
  }

  function SetupPanel({ s, set, actions }) {
    const camActive = s.camOn && s.mode !== 'camera';
    const [pop, setPop] = useState(null); // camera | mic | sys | output
    const toggle = (k) => setPop(pop === k ? null : k);

    // close popovers on Escape or when flow changes away from ready
    useEffect(() => {
      function onKey(ev) { if (ev.key === 'Escape') setPop(null); }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);
    useEffect(() => { if (s.flow !== 'ready') setPop(null); }, [s.flow]);
    // whisper.cpp may have been installed since launch
    useEffect(() => { if (pop === 'agent') actions.refreshAgentInfo(); }, [pop]);
    const agent = s.agentInfo;

    const micLabel = (s.mics.find((m) => m.deviceId === s.micDeviceId) || {}).label || 'Default microphone';
    const camLabel = (s.cams.find((cm) => cm.deviceId === s.camDeviceId) || {}).label || (s.cams[0] ? s.cams[0].label : 'Default camera');
    const micSub = s.micOn ? micLabel : 'Muted';
    const camSub = s.mode === 'camera' ? 'Recording source in this mode' : (s.camOn ? camLabel : 'Off');
    const qualityLabel = s.quality === 'small' ? 'Smaller file' : 'Instant save';

    return e('div', { className: 'panel-fit' + (s.flow === 'recording' || s.flow === 'paused' ? ' dim-setup' : '') },
      pop ? e('div', { className: 'pop-scrim', onClick: () => setPop(null) }) : null,

      // ── Record ──
      e(Sec, { title: 'Record' },
        e('div', { className: 'modes' },
          e(ModeCard, { icon: 'monitor', label: 'Full screen', active: s.mode === 'screen', onClick: () => actions.setMode('screen') }),
          e(ModeCard, { icon: 'appwindow', label: 'App window', active: s.mode === 'window', onClick: () => actions.setMode('window') }),
          e(ModeCard, { icon: 'webcam', label: 'Camera only', active: s.mode === 'camera', onClick: () => actions.setMode('camera') }),
        ),
        s.mode !== 'camera' && s.source
          ? e('div', { className: 'src-row', onClick: actions.openPicker, role: 'button', tabIndex: 0,
              onKeyDown: (ev) => { if (ev.key === 'Enter') actions.openPicker(); } },
              e('div', { className: 'src-thumb' },
                s.source.thumbnail
                  ? e('img', { src: s.source.thumbnail, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } })
                  : e('div', { style: { position: 'absolute', inset: 0, background: s.source.wall || 'linear-gradient(135deg,#2b6f8e,#16303f)' } }),
              ),
              e('div', { className: 'src-meta' },
                e('div', { className: 't' }, s.mode === 'window' ? s.source.app : s.source.title),
                e('div', { className: 's' }, s.mode === 'window' ? s.source.title : s.source.sub),
              ),
              e(Icon, { name: 'chevright', size: 16, className: 'chev' }),
            )
          : null,
      ),

      // ── Input ──
      e(Sec, { title: 'Input' },
        e(DevRow, {
          icon: 'webcam', title: 'Camera', sub: camSub,
          on: s.mode === 'camera' ? true : s.camOn,
          onToggle: (v) => set({ camOn: v }),
          disabled: s.mode === 'camera',
          open: pop === 'camera', onOpen: () => toggle('camera'), dir: 'down',
          popover: e(React.Fragment, null,
            e('div', { className: 'pop-title' }, 'Camera'),
            e('select', { className: 'select', value: s.camDeviceId, onChange: (ev) => set({ camDeviceId: ev.target.value }) },
              e('option', { value: '' }, 'Default camera'),
              s.cams.map((c) => e('option', { key: c.deviceId, value: c.deviceId }, c.label))),
            e('div', null,
              e('div', { className: 'field-lbl' }, 'Shape'),
              e(Seg, { value: s.camShape, onChange: (v) => set({ camShape: v }), options: [{ v: 'rounded', label: 'Rounded' }, { v: 'circle', label: 'Circle' }] }),
            ),
            e(PopRow, { title: 'Mirror camera', sub: 'Flip horizontally', on: s.camMirror, onChange: (v) => set({ camMirror: v }) }),
            camActive && s.overlayEditable ? e('button', { className: 'pop-action', onClick: () => { setPop(null); actions.editOverlay(); } },
              e(Icon, { name: 'maximize', size: 14 }), 'Adjust position in preview') : null,
          ),
        }),
        e(DevRow, {
          icon: s.micOn ? 'mic' : 'micoff', title: 'Microphone', sub: micSub,
          on: s.micOn, onToggle: (v) => { set({ micOn: v }); if (v) actions.probeMic(); },
          open: pop === 'mic', onOpen: () => toggle('mic'), dir: 'down',
          popover: e(React.Fragment, null,
            e('div', { className: 'pop-title' }, 'Microphone'),
            e('select', { className: 'select', value: s.micDeviceId, onChange: (ev) => set({ micDeviceId: ev.target.value }) },
              e('option', { value: '' }, 'Default microphone'),
              s.mics.map((m) => e('option', { key: m.deviceId, value: m.deviceId }, m.label))),
            e('div', null,
              e('div', { className: 'field-lbl' }, 'Input level'),
              e(LevelMeter, { active: s.micOn, deviceId: s.micDeviceId }),
            ),
          ),
        }),
        e(DevRow, {
          icon: 'volume', title: 'System audio', sub: 'Not available on this Mac',
          on: false, noToggle: true,
          open: pop === 'sys', onOpen: () => toggle('sys'), dir: 'down',
          extra: e('span', { className: 'row-badge' }, 'Info'),
          popover: e(React.Fragment, null,
            e('div', { className: 'pop-title' }, 'System audio'),
            e('div', { className: 'field-note' },
              'Capturing your Mac’s own sound needs an extra macOS audio helper. Your recording will continue without it.'),
          ),
        }),
      ),

      // ── Output ──
      e(Sec, { title: 'Output' },
        e(DevRow, {
          icon: 'film',
          title: s.format === 'mp4' ? 'MP4 · ' + qualityLabel : 'WebM',
          sub: s.folder,
          noToggle: true,
          open: pop === 'output', onOpen: () => toggle('output'), dir: 'up',
          popover: e(React.Fragment, null,
            e('div', { className: 'pop-title' }, 'Output'),
            e('div', null,
              e('div', { className: 'field-lbl' }, 'Format'),
              e(Seg, { value: s.format, onChange: (v) => set({ format: v }), options: [{ v: 'mp4', label: 'MP4' }, { v: 'webm', label: 'WebM' }] }),
            ),
            s.format === 'mp4' ? e('div', null,
              e('div', { className: 'field-lbl' }, 'After recording'),
              e(Seg, {
                value: s.quality === 'small' ? 'small' : 'balanced', onChange: (v) => set({ quality: v }),
                options: [{ v: 'balanced', label: 'Instant save' }, { v: 'small', label: 'Smaller file' }],
              }),
              e('div', { className: 'field-note', style: { marginTop: 6 } },
                s.quality === 'small'
                  ? 'Compresses the video after you stop. Slower to save, smallest file.'
                  : 'Recommended. The recording is ready the moment you stop.'),
            ) : null,
            e('div', null,
              e('div', { className: 'field-lbl' }, 'Save to'),
              e('div', { className: 'folder' },
                e(Icon, { name: 'folder', size: 16, className: 'ic' }),
                e('span', { className: 'path' }, s.folder),
                e('button', { className: 'link-btn', onClick: actions.chooseFolder || (() => actions.toast()) }, 'Change'),
              ),
            ),
            e(PopRow, { title: '3-2-1 countdown', sub: 'Before recording starts', on: s.countdownOn, onChange: (v) => set({ countdownOn: v }) }),
            e('div', { className: 'pop-div' }),
            e('div', { className: 'pop-title', style: { color: 'var(--muted)' } }, 'Advanced'),
            e(PopRow, { title: 'Hide while recording', sub: 'Full screen only. Stop from the menu bar', on: s.hideOnRecord, onChange: (v) => set({ hideOnRecord: v }) }),
            e(PopRow, { title: 'Global shortcuts', sub: (s.toggleKeys || '') + ' start or stop · ' + (s.pauseKeys || '') + ' pause', on: s.globalShortcutsOn, onChange: (v) => set({ globalShortcutsOn: v }) }),
            e(PopRow, { title: 'Floating controls', sub: 'Mini control bar while recording', on: s.floatingOn, onChange: (v) => set({ floatingOn: v }) }),
          ),
        }),
        e(DevRow, {
          icon: 'link', title: 'Share link',
          sub: s.dropbox.connected
            ? (s.shareLink ? 'Dropbox link, copied when saved' : 'Off')
            : 'Connect Dropbox to enable',
          on: s.shareLink && s.dropbox.connected,
          onToggle: (v) => {
            if (!s.dropbox.connected) { toggle('share'); return; } // open the Connect popover
            set({ shareLink: v });
          },
          open: pop === 'share', onOpen: () => toggle('share'), dir: 'up',
          popover: s.dropbox.connected
            ? e(React.Fragment, null,
                e('div', { className: 'pop-title' }, 'Share link'),
                e('div', { className: 'field-note' },
                  'After saving, the recording is uploaded to Apps/MyScreen Recorder in your Dropbox and a view link is copied to your clipboard.'),
                e('div', { className: 'field-note' }, 'Connected as ', e('strong', null, s.dropbox.account || 'Dropbox'), '.'),
                e('button', { className: 'pop-action', onClick: actions.disconnectDropbox },
                  e(Icon, { name: 'x', size: 14 }), 'Disconnect Dropbox'),
              )
            : e(React.Fragment, null,
                e('div', { className: 'pop-title' }, 'Share via Dropbox'),
                e('div', { className: 'field-note' },
                  'Recordings upload to Apps/MyScreen Recorder in your own Dropbox and the link lands on your clipboard.'),
                e('button', { className: 'pop-action', onClick: actions.connectDropbox },
                  e(Icon, { name: 'link', size: 14 }), 'Connect Dropbox'),
                e('div', { className: 'pop-div' }),
                e('div', { className: 'field-note' },
                  'Using iCloud Drive or Google Drive instead? Set "Save to" (above) to a synced folder; the file syncs automatically and you copy its link from Finder.'),
              ),
        }),
        e(DevRow, {
          icon: 'sparkle', title: 'Agent access',
          sub: s.agentFilesOn ? 'Transcript and key frames' : 'Off',
          on: s.agentFilesOn,
          onToggle: (v) => {
            set({ agentFilesOn: v });
            // Switching it on without a speech model: show the offer.
            if (v && agent && agent.engine && !agent.transcripts) setPop('agent');
          },
          open: pop === 'agent', onOpen: () => toggle('agent'), dir: 'up',
          popover: e(React.Fragment, null,
            e('div', { className: 'pop-title' }, 'Agent access'),
            e('div', { className: 'field-note' },
              'After each save, MyScreen writes a transcript of your narration and an image of every screen change next to the recording, so Claude Code and Codex can follow what you showed and said.'),
            agent && agent.transcripts ? e('div', { className: 'field-note' },
              'Transcripts are made on this Mac with ', e('strong', null, agent.engineLabel), '.') : null,
            agent && !agent.transcripts && agent.engine ? e(React.Fragment, null,
              e('div', { className: 'field-note' },
                e('strong', null, 'Transcripts need a speech model. '),
                'It is a one-time download and runs on this Mac, so your recordings are never uploaded. Key frames work without it.'),
              e(ModelDownload, { s, actions }),
            ) : null,
            agent && !agent.engine ? e('div', { className: 'field-note' },
              e('strong', null, 'No transcripts: '), agent.engineLabel, ' from this copy of MyScreen. Key frames still work.') : null,
            e('div', { className: 'pop-div' }),
            e('div', { className: 'field-lbl' }, 'Connect an agent'),
            e('div', { className: 'field-note' }, 'Run one command once. The agent can then list, read, and search your recordings.'),
            e(CopyAction, { icon: 'copy', label: 'Copy command for Claude Code', onCopy: () => actions.copyAgentCommand('claude') }),
            e(CopyAction, { icon: 'copy', label: 'Copy command for Codex', onCopy: () => actions.copyAgentCommand('codex') }),
          ),
        }),
      ),
    );
  }

  window.SetupPanel = SetupPanel;
  window.ModelDownload = ModelDownload;
})();
