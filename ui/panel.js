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

    const micLabel = (s.mics.find((m) => m.deviceId === s.micDeviceId) || {}).label || 'Default microphone';
    const camLabel = (s.cams.find((cm) => cm.deviceId === s.camDeviceId) || {}).label || (s.cams[0] ? s.cams[0].label : 'Default camera');
    const micSub = s.micOn ? micLabel : 'Muted';
    const camSub = s.mode === 'camera' ? 'Recording source in this mode' : (s.camOn ? camLabel : 'Off');
    const qualityLabel = s.quality === 'fast' ? 'Fast' : s.quality === 'small' ? 'Smaller file' : 'Balanced';

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
          on: s.micOn, onToggle: (v) => set({ micOn: v }),
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
          title: (s.format === 'mp4' ? 'MP4' : 'WebM') + ' · ' + qualityLabel,
          sub: s.folder,
          noToggle: true,
          open: pop === 'output', onOpen: () => toggle('output'), dir: 'up',
          popover: e(React.Fragment, null,
            e('div', { className: 'pop-title' }, 'Output'),
            e('div', null,
              e('div', { className: 'field-lbl' }, 'Format'),
              e(Seg, { value: s.format, onChange: (v) => set({ format: v }), options: [{ v: 'mp4', label: 'MP4' }, { v: 'webm', label: 'WebM' }] }),
            ),
            e('div', null,
              e('div', { className: 'field-lbl' }, 'Quality'),
              e(Seg, {
                value: s.quality, onChange: (v) => set({ quality: v }),
                options: [{ v: 'fast', label: 'Fast' }, { v: 'balanced', label: 'Balanced' }, { v: 'small', label: 'Smaller' }],
              }),
              e('div', { className: 'field-note', style: { marginTop: 6 } },
                s.quality === 'fast' ? 'Quickest to save · larger file.' :
                s.quality === 'small' ? 'Slower to save · smallest file.' :
                'Recommended — good quality, reasonable size.'),
            ),
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
            e(PopRow, { title: 'Hardware encoding', sub: 'Beta · faster H.264 on supported Macs', on: s.hwEncode, onChange: (v) => set({ hwEncode: v }) }),
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
            if (!s.dropbox.connected) return; // configure via the popover first
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
      ),
    );
  }

  window.SetupPanel = SetupPanel;
})();
