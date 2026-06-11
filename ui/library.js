/* MyScreen — recordings library view */
(function () {
  const e = React.createElement;
  const Icon = window.Icon;

  function LibThumb({ rec }) {
    if (rec.thumbnail) {
      return e('img', { src: rec.thumbnail, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } });
    }
    return e('div', { style: { position: 'absolute', inset: 0, background: rec.wall || 'var(--stage-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
      e(Icon, { name: 'film', size: 30, style: { color: 'rgba(255,255,255,.25)' } }));
  }

  function Library({ recordings, actions }) {
    const recs = recordings || [];
    return e('div', { className: 'lib' },
      e('div', { className: 'lib-head' },
        e('h2', null, 'Your recordings'),
        e('span', { className: 'count' }, recs.length + (recs.length === 1 ? ' clip' : ' clips')),
        e('div', { style: { flex: 1 } }),
        e('button', { className: 'btn btn-blue', style: { height: 40 }, onClick: actions.newRecording }, e(Icon, { name: 'plus', size: 17 }), 'New recording'),
      ),
      recs.length
        ? e('div', { className: 'lib-grid' },
            recs.map((r) => e('div', { key: r.id, className: 'lib-card', onClick: () => (actions.openRecording ? actions.openRecording(r) : actions.toast()) },
              e('div', { className: 'lib-thumb' },
                e(LibThumb, { rec: r }),
                e('span', { className: 'dur' }, r.dur),
                e('div', { className: 'pl' }, e('div', { className: 'pc' }, e(Icon, { name: 'play', size: 18, fill: 'currentColor' }))),
              ),
              e('div', { className: 'lib-info' },
                e('div', { className: 't' }, r.title),
                e('div', { className: 's' }, r.when, e('span', { style: { color: 'var(--faint)' } }, '·'), r.size, r.src ? e('span', { style: { color: 'var(--faint)' } }, '·') : null, r.src || null),
              ),
            )),
          )
        : e('div', { className: 'lib-empty' },
            e(Icon, { name: 'film', size: 40, style: { color: 'var(--faint)' } }),
            e('div', null, 'No recordings yet. Your saved clips will show up here.'),
          ),
    );
  }

  window.Library = Library;
})();
