/* MyScreen — modals: source picker, permissions, recovery, saving, saved, toast */
(function () {
  const e = React.createElement;
  const { useState } = React;
  const Icon = window.Icon;
  const { AppIcon } = window;

  // thumbnail: real image when the source provides one, drawn placeholder otherwise
  function Thumb({ item }) {
    if (item && item.thumbnail) {
      return e('img', { src: item.thumbnail, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } });
    }
    return e('div', { style: { position: 'absolute', inset: 0 } },
      e('div', { style: { position: 'absolute', inset: 0, background: (item && item.wall) || 'linear-gradient(135deg,#2b6f8e,#16303f)' } }),
      item && (item.kind === 'window' || item.app)
        ? e('div', { style: { position: 'absolute', inset: '16% 12%', borderRadius: 4, background: '#fbfbfb', boxShadow: '0 6px 16px rgba(0,0,0,.4)', overflow: 'hidden' } },
            e('div', { style: { height: '22%', background: '#e7e7ea' } }),
            e('div', { style: { padding: 7 } },
              e('div', { style: { width: '50%', height: 5, borderRadius: 2, background: '#14aae2', marginBottom: 5 } }),
              e('div', { style: { width: '90%', height: 4, borderRadius: 2, background: '#dcdadc' } }),
            ),
          )
        : null,
    );
  }

  function Picker({ s, actions }) {
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(s.source ? s.source.id : null);
    React.useEffect(() => {
      function onKey(ev) { if (ev.key === 'Escape') actions.closePicker(); }
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);
    const screens = s.pickScreens || [];
    const apps = (s.pickWindows || []).filter((a) => ((a.app || '') + ' ' + (a.title || '')).toLowerCase().includes(q.toLowerCase()));
    const all = [...screens, ...apps];
    const chosen = all.find((x) => x.id === sel);

    return e('div', { className: 'scrim', onMouseDown: actions.closePicker },
      e('div', { className: 'sheet', onMouseDown: (ev) => ev.stopPropagation() },
        e('div', { className: 'sheet-head' },
          e('div', null,
            e('div', { className: 'h' }, 'Choose what to record'),
            e('div', { className: 'sub' }, 'Pick a screen or an open app window.'),
          ),
          e('button', { className: 'sheet-x', onClick: actions.closePicker }, e(Icon, { name: 'x', size: 18 })),
        ),
        e('div', { className: 'sheet-body' },
          e('div', { className: 'picker-search' },
            e(Icon, { name: 'search', size: 16, className: 'ic' }),
            e('input', { placeholder: 'Search windows…', value: q, onChange: (ev) => setQ(ev.target.value), autoFocus: true }),
          ),
          e('div', { className: 'pick-group-title' }, 'Screens'),
          e('div', { className: 'screen-list' },
            screens.map((sc) => e('button', { key: sc.id, className: 'screen-card' + (sel === sc.id ? ' sel' : ''), onClick: () => setSel(sc.id), onDoubleClick: () => actions.confirmPicker(sc) },
              e('div', { className: 'sc-thumb' }, e(Thumb, { item: sc })),
              e('div', { className: 'nm' }, e('div', { className: 't' }, sc.title), e('div', { className: 's' }, sc.sub)),
            )),
          ),
          e('div', { className: 'pick-group-title' }, 'App windows'),
          apps.length ? e('div', { className: 'pick-grid compact' },
            apps.map((a) => e('button', { key: a.id, className: 'pick-card' + (sel === a.id ? ' sel' : ''), onClick: () => setSel(a.id), onDoubleClick: () => actions.confirmPicker(a) },
              e('div', { className: 'pick-thumb' }, e(Thumb, { item: a })),
              e('div', { className: 'pick-foot' },
                a.appIcon
                  ? e('img', {
                      src: a.appIcon,
                      style: { width: 18, height: 18, borderRadius: 4, flex: '0 0 auto' },
                      onError: (ev) => { ev.target.style.display = 'none'; },
                    })
                  : e(AppIcon, { bg: a.icon || '#5a6b7d', label: a.glyph || (a.app || '?')[0], size: 18 }),
                e('div', { className: 'nm' }, e('div', { className: 't' }, a.app), e('div', { className: 's' }, a.title)),
                a.active ? e('span', { className: 'pick-badge' }, 'Active') : null,
              ),
            )),
          ) : e('div', { className: 'pick-empty' }, 'No windows match “' + q + '”.'),
        ),
        e('div', { className: 'sheet-foot' },
          e('div', { style: { fontSize: 12.5, color: 'var(--muted)' } }, chosen ? ('Selected: ' + (chosen.app || chosen.title)) : 'Nothing selected'),
          e('div', { className: 'spacer' }),
          e('button', { className: 'btn btn-soft', style: { height: 38 }, onClick: actions.closePicker }, 'Cancel'),
          e('button', { className: 'btn btn-blue', style: { height: 38 }, disabled: !chosen, onClick: () => actions.confirmPicker(chosen) }, 'Select'),
        ),
      ),
    );
  }

  // Stylized miniature of the System Settings "Screen & System Audio
  // Recording" pane, so users recognize exactly what to do there.
  function SettingsMock() {
    const row = (label, on, dim) => e('div', {
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', opacity: dim ? .45 : 1 },
    },
      e('div', { style: { width: 16, height: 16, borderRadius: 4, background: dim ? 'var(--line)' : 'var(--blue)', flex: '0 0 auto' } }),
      e('div', { style: { fontSize: 12, fontWeight: dim ? 400 : 600, color: 'var(--ink)', flex: 1 } }, label),
      e('div', { style: { width: 26, height: 15, borderRadius: 8, background: on ? 'var(--blue)' : 'var(--line)', position: 'relative', flex: '0 0 auto' } },
        e('div', { style: { width: 11, height: 11, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: on ? 13 : 2 } })),
    );
    return e('div', { style: { border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg)', margin: '10px 0 2px' } },
      e('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--muted)', padding: '7px 10px 3px' } }, 'Screen & System Audio Recording'),
      row('Other apps', true, true),
      row('MyScreen', true, false),
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: '1px solid var(--line)' } },
        e('div', { style: { width: 18, height: 18, borderRadius: 5, border: '1.5px solid var(--blue)', color: 'var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, lineHeight: 1 } }, '+'),
        e('div', { style: { fontSize: 11.5, color: 'var(--muted)' } }, 'Click + to add MyScreen if it isn’t listed'),
      ),
    );
  }

  function Permissions({ s, actions }) {
    const P = s.permState;
    // Camera and mic first: those are one-click native prompts. Screen
    // recording last, since it ends in the manual Settings step + restart.
    const rows = [
      { key: 'cam', icon: 'webcam', t: 'Camera', s: 'For the optional camera overlay.', act: 'Enable' },
      { key: 'mic', icon: 'mic', t: 'Microphone', s: 'To record your voice.', act: 'Enable' },
      { key: 'screen', icon: 'monitor', t: 'Screen Recording', s: 'So MyScreen can capture your display.', act: 'Open Settings' },
    ];
    const allOk = Object.values(P).every((v) => v === 'ok');
    // Only screen recording is a hard requirement; camera and mic prompt at
    // first use. The sheet only ever shows when screen started out missing,
    // so once it flips to ok a relaunch is required for capture to work.
    const screenOk = P.screen === 'ok';
    const step = (n, body) => e('div', { style: { display: 'flex', gap: 9 } },
      e('div', { style: { width: 17, height: 17, borderRadius: '50%', background: 'var(--blue)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', marginTop: 1 } }, String(n)),
      e('div', { style: { fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.45 } }, body),
    );
    // The screen row carries its setup guide inside the card so the manual
    // macOS steps are unambiguously about Screen Recording.
    const screenRow = (r, ok) => e('div', { key: r.key, className: 'perm ' + (ok ? 'ok' : 'todo'), style: ok ? null : { flexDirection: 'column', alignItems: 'stretch', gap: 12 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 13 } },
        e('div', { className: 'pic' }, e(Icon, { name: ok ? 'check' : r.icon, size: 20 })),
        e('div', { className: 'ptx' }, e('div', { className: 't' }, r.t), e('div', { className: 's' }, ok ? 'Granted' : r.s)),
        ok
          ? e('span', { className: 'status' }, e(Icon, { name: 'check', size: 14 }), 'Ready')
          : e('button', { className: 'perm-act', onClick: () => actions.grant(r.key) }, r.act),
      ),
      ok ? null : e('div', { style: { display: 'flex', gap: 16, borderTop: '1px solid var(--border-soft)', paddingTop: 12 } },
        e('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0 } },
          e('div', { style: { fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' } }, 'One-time setup'),
          step(1, e(React.Fragment, null, 'Click ', e('strong', null, 'Open Settings'), '.')),
          step(2, e(React.Fragment, null, 'Switch ', e('strong', null, 'MyScreen'), ' on. Not listed? Click ', e('strong', null, '+'), ' and pick it from Applications.')),
          step(3, e(React.Fragment, null, 'Come back and click ', e('strong', null, 'Restart MyScreen'), '.')),
        ),
        e('div', { style: { width: 250, flex: '0 0 auto' } }, e(SettingsMock)),
      ),
    );
    return e('div', { className: 'scrim' },
      e('div', { className: 'sheet sm', style: screenOk ? null : { maxWidth: 620 } },
        e('div', { className: 'sheet-head' },
          e('div', { style: { width: 40, height: 40, borderRadius: 10, background: 'var(--blue-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--blue)', flex: '0 0 auto' } },
            e(Icon, { name: 'shield', size: 20 })),
          e('div', null,
            e('div', { className: 'h' }, 'Let’s get you set up'),
            e('div', { className: 'sub' }, 'MyScreen needs a few permissions before the first recording.'),
          ),
        ),
        e('div', { className: 'sheet-body' },
          e('div', { className: 'perm-list' },
            rows.map((r) => {
              const ok = P[r.key] === 'ok';
              if (r.key === 'screen') return screenRow(r, ok);
              return e('div', { key: r.key, className: 'perm ' + (ok ? 'ok' : 'todo') },
                e('div', { className: 'pic' }, e(Icon, { name: ok ? 'check' : r.icon, size: 20 })),
                e('div', { className: 'ptx' }, e('div', { className: 't' }, r.t), e('div', { className: 's' }, ok ? 'Granted' : r.s)),
                ok
                  ? e('span', { className: 'status' }, e(Icon, { name: 'check', size: 14 }), 'Ready')
                  : e('button', { className: 'perm-act', onClick: () => actions.grant(r.key) }, r.act),
              );
            }),
          ),
          screenOk ? e('div', { className: 'banner warn', style: { marginTop: 14 } },
            e(Icon, { name: 'info', size: 16, className: 'ic' }),
            e('div', null, 'Screen Recording is granted. Restart MyScreen so macOS applies it.'),
          ) : null,
        ),
        e('div', { className: 'sheet-foot' },
          e('div', { className: 'spacer' }),
          screenOk
            ? e('button', { className: 'btn btn-blue', style: { height: 40 }, onClick: actions.relaunch }, 'Restart MyScreen')
            : e('button', { className: 'btn btn-soft', style: { height: 40 }, disabled: true }, 'Waiting for Screen Recording…'),
        ),
      ),
    );
  }

  function Recovery({ actions, recoverable }) {
    const item = (recoverable && recoverable[0]) || {};
    return e('div', { className: 'scrim' },
      e('div', { className: 'sheet sm' },
        e('div', { className: 'sheet-head' },
          e('div', { style: { width: 40, height: 40, borderRadius: 10, background: 'var(--green-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--green)', flex: '0 0 auto' } },
            e(Icon, { name: 'refresh', size: 20 })),
          e('div', null,
            e('div', { className: 'h' }, 'We found an unsaved recording'),
            e('div', { className: 'sub' }, 'MyScreen closed before this one finished saving. It’s safe.'),
          ),
        ),
        e('div', { className: 'sheet-body' },
          e('div', { style: { display: 'flex', gap: 14, alignItems: 'center', padding: 12, border: '1px solid var(--border)', borderRadius: 10 } },
            e('div', { style: { width: 92, aspectRatio: '16/10', borderRadius: 8, overflow: 'hidden', position: 'relative', flex: '0 0 auto' } }, e(Thumb, { item: {} })),
            e('div', null,
              e('div', { style: { fontSize: 14, fontWeight: 700, color: 'var(--ink)' } }, item.title || 'Screen recording'),
              e('div', { style: { fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 } }, item.when || '', item.when ? e('br') : null, item.detail || ''),
            ),
          ),
        ),
        e('div', { className: 'sheet-foot' },
          e('button', { className: 'btn btn-soft', style: { height: 40, color: 'var(--red)' }, onClick: actions.discardRecovery }, 'Discard'),
          e('div', { className: 'spacer' }),
          e('button', { className: 'btn btn-blue', style: { height: 40 }, onClick: actions.recover }, e(Icon, { name: 'download', size: 16 }), 'Recover & save'),
        ),
      ),
    );
  }

  function Saving({ s, actions }) {
    return e('div', { className: 'scrim' },
      e('div', { className: 'sheet sm' },
        e('div', { className: 'sheet-head' },
          e('div', null,
            e('div', { className: 'h' }, 'Saving your recording'),
            e('div', { className: 'sub' }, s.format === 'mp4' ? 'Converting to MP4 — you can keep this open.' : 'Finishing up — you can keep this open.'),
          ),
        ),
        e('div', { className: 'sheet-body' },
          e('div', { className: 'save-stage' },
            e('div', { className: 'save-thumb' }, e(Thumb, { item: {} }),
              e('div', { className: 'play' }, e('div', { className: 'pc' }, e(Icon, { name: 'film', size: 20 }))),
            ),
            e('div', { className: 'prog' }, e('div', { className: 'fill', style: { width: s.saveProgress + '%' } })),
            e('div', { className: 'prog-meta' },
              e('span', null, Math.round(s.saveProgress) + '%'),
              e('span', null, s.saveEta || (s.saveProgress > 96 ? 'Almost done…' : 'Working…')),
            ),
          ),
        ),
        e('div', { className: 'sheet-foot' },
          e('div', { style: { fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 7 } }, e(Icon, { name: 'folder', size: 14 }), s.folder),
          e('div', { className: 'spacer' }),
          actions.cancelSave ? e('button', { className: 'btn btn-soft', style: { height: 38 }, onClick: actions.cancelSave }, 'Cancel') : null,
        ),
      ),
    );
  }

  function SavedShareBox({ s, actions }) {
    const [copied, setCopied] = useState(false);
    if (s.shareState === 'none') return null;
    if (s.shareState === 'uploading') {
      return e('div', { className: 'share-box' },
        e(Icon, { name: 'link', size: 15, style: { color: 'var(--muted)', flex: '0 0 auto' } }),
        e('span', { className: 'url' }, 'Uploading to Dropbox… ' + Math.round(s.shareProgress) + '%'),
      );
    }
    if (s.shareState === 'error') {
      return e('div', { className: 'share-box' },
        e(Icon, { name: 'alert', size: 15, style: { color: 'var(--orange)', flex: '0 0 auto' } }),
        e('span', { className: 'url' }, 'Upload failed — the file is saved locally.'),
        e('button', { className: 'share-copy', onClick: actions.retryShare }, 'Retry'),
      );
    }
    return e('div', { className: 'share-box' },
      e(Icon, { name: 'link', size: 15, style: { color: 'var(--muted)', flex: '0 0 auto' } }),
      e('span', { className: 'url' }, s.shareUrl),
      e('button', {
        className: 'share-copy' + (copied ? ' done' : ''),
        onClick: async () => { if (await actions.copyShareUrl()) { setCopied(true); setTimeout(() => setCopied(false), 1800); } },
      }, copied ? 'Copied!' : 'Copy link'),
    );
  }

  function Saved({ s, actions }) {
    return e('div', { className: 'scrim' },
      e('div', { className: 'sheet sm', style: { maxWidth: 520 } },
        e('div', { className: 'sheet-head' },
          e('div', { style: { width: 40, height: 40, borderRadius: 10, background: 'var(--green-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--green)', flex: '0 0 auto' } },
            e(Icon, { name: 'check', size: 22, strokeWidth: 2.4 })),
          e('div', null,
            e('div', { className: 'h' }, 'Saved! Nice recording.'),
            e('div', { className: 'sub' }, (s.format === 'mp4' ? 'MP4' : 'WebM') + ' · ' + actions.fmt(s.lastDuration || 0) + ' · saved to ' + s.folder),
          ),
        ),
        e('div', { className: 'sheet-body' },
          e('div', { className: 'save-stage' },
            e('div', { className: 'save-thumb' }, e(Thumb, { item: { thumbnail: s.lastThumbnail } }),
              e('div', { className: 'play' }, e('div', { className: 'pc' }, e(Icon, { name: 'play', size: 20, fill: 'currentColor' }))),
            ),
            e('div', { className: 'saved-name' }, s.lastFileName || ''),
            e(SavedShareBox, { s, actions }),
          ),
        ),
        e('div', { className: 'sheet-foot' },
          e('button', { className: 'btn btn-soft', style: { height: 40 }, onClick: actions.reveal }, e(Icon, { name: 'folder', size: 16 }), 'Reveal in Finder'),
          e('div', { className: 'spacer' }),
          e('button', { className: 'btn btn-soft', style: { height: 40 }, onClick: actions.recordAgain }, 'Record again'),
          e('button', { className: 'btn btn-blue', style: { height: 40 }, onClick: actions.doneSaved }, 'Done'),
        ),
      ),
    );
  }

  function Toast({ msg }) {
    if (!msg) return null;
    return e('div', { style: { position: 'absolute', left: '50%', bottom: 96, transform: 'translateX(-50%)', zIndex: 60, background: 'rgba(22,24,30,.95)', color: '#fff', padding: '11px 16px', borderRadius: 10, fontSize: 13, fontWeight: 500, boxShadow: 'var(--sh-pop)', display: 'flex', alignItems: 'center', gap: 9, animation: 'pop .2s ease' } },
      e(Icon, { name: 'info', size: 16, style: { color: 'var(--blue)' } }), msg);
  }

  Object.assign(window, { Picker, Permissions, Recovery, Saving, Saved, Toast });
})();
