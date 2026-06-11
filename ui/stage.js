/* MyScreen — preview stage + camera overlay + overlay editor + countdown.
   Renders s.previewStream / s.camStream when present (wired in Phase 2);
   falls back to placeholders until then. */
(function () {
  const e = React.createElement;
  const { useRef, useState, useEffect } = React;
  const Icon = window.Icon;

  // <video> bound to a MediaStream
  function StreamVideo({ stream, className, mirrored }) {
    const ref = useRef(null);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      if (el.srcObject !== stream) el.srcObject = stream;
      if (stream) el.play().catch(() => {});
    }, [stream]);
    return e('video', {
      ref, className, muted: true, playsInline: true, autoPlay: true,
      style: mirrored ? { transform: 'scaleX(-1)' } : undefined,
    });
  }

  function CameraOverlay({ s, set, editing, stageRef, actions, flow }) {
    const drag = useRef(null);
    const moved = useRef(false);
    const aspect = s.camShape === 'circle' ? 1 : 4 / 3;

    function onPointerDown(ev) {
      if (!stageRef.current) return;
      ev.preventDefault();
      moved.current = false;
      const r = stageRef.current.getBoundingClientRect();
      drag.current = { r, offX: ev.clientX, offY: ev.clientY, startX: s.camX, startY: s.camY };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    }
    function onMove(ev) {
      const d = drag.current; if (!d) return;
      if (Math.abs(ev.clientX - d.offX) + Math.abs(ev.clientY - d.offY) > 4) moved.current = true;
      const dx = ((ev.clientX - d.offX) / d.r.width) * 100;
      const dy = ((ev.clientY - d.offY) / d.r.height) * 100;
      const wPct = s.camW * 100;
      // aspect is width/height, so bubble height = width / aspect
      const hPct = (s.camW * d.r.width / aspect) / d.r.height * 100;
      set({
        camX: Math.max(2, Math.min(98 - wPct, d.startX + dx)),
        camY: Math.max(2, Math.min(98 - hPct, d.startY + dy)),
      });
    }
    function onUp() {
      drag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // a plain click (no drag) opens the overlay editor
      if (!moved.current && !editing && flow === 'ready' && actions) actions.editOverlay();
    }

    const resz = useRef(null);
    function onResizeDown(ev) {
      ev.preventDefault(); ev.stopPropagation();
      const r = stageRef.current.getBoundingClientRect();
      resz.current = { r, startX: ev.clientX, startW: s.camW };
      window.addEventListener('pointermove', onResizeMove);
      window.addEventListener('pointerup', onResizeUp);
    }
    function onResizeMove(ev) {
      const d = resz.current; if (!d) return;
      const dw = ((ev.clientX - d.startX) / d.r.width);
      set({ camW: Math.max(0.12, Math.min(0.4, d.startW + dw)) });
    }
    function onResizeUp() {
      resz.current = null;
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', onResizeUp);
    }

    const [dragging, setDragging] = useState(false);
    return e('div', {
      className: 'cam ' + (s.camShape === 'circle' ? 'circle' : '') + (editing ? ' cam-editing' : '') + (dragging ? ' dragging' : ''),
      style: { left: s.camX + '%', top: s.camY + '%', width: (s.camW * 100) + '%', aspectRatio: String(aspect) },
      title: editing ? 'Drag to move' : 'Click to adjust · drag to move',
      onPointerDown: (ev) => { setDragging(true); onPointerDown(ev); },
      onPointerUp: () => setDragging(false),
    },
      s.camStream
        ? e(StreamVideo, { stream: s.camStream, className: 'camfeed', mirrored: s.camMirror })
        : e(window.CamFace, { mirrored: s.camMirror }),
      editing ? e('div', { className: 'cam-handle br', onPointerDown: onResizeDown }) : null,
    );
  }

  function CornerBtn({ pos, sel, onClick }) {
    return e('button', { className: 'ob-corner' + (sel ? ' sel' : ''), onClick, title: pos },
      e('i', { className: pos }),
    );
  }

  function OverlayToolbar({ s, set, onDone, stageRef }) {
    // place overlay into a corner with a margin
    function corner(pos) {
      const r = stageRef.current.getBoundingClientRect();
      const m = 4; // percent margin
      const wPct = s.camW * 100;
      const hPct = (s.camW * r.width / (s.camShape === 'circle' ? 1 : 4 / 3)) / r.height * 100;
      const map = {
        tl: { camX: m, camY: m }, tr: { camX: 100 - wPct - m, camY: m },
        bl: { camX: m, camY: 100 - hPct - m }, br: { camX: 100 - wPct - m, camY: 100 - hPct - m },
      };
      set(map[pos]);
    }
    // which corner is currently closest
    const near = (() => {
      const right = s.camX > 50, bottom = s.camY > 40;
      return (bottom ? 'b' : 't') + (right ? 'r' : 'l');
    })();
    return e('div', { className: 'overlay-bar' },
      e('div', { className: 'ob-group' },
        e('span', { className: 'ob-label' }, 'Corner'),
        ['tl', 'tr', 'bl', 'br'].map((p) => e(CornerBtn, { key: p, pos: p, sel: near === p, onClick: () => corner(p) })),
      ),
      e('div', { className: 'ob-sep' }),
      e('div', { className: 'ob-group' },
        e('span', { className: 'ob-label' }, 'Size'),
        e('button', { className: 'ob-btn' + (s.camW < 0.18 ? ' on' : ''), onClick: () => set({ camW: 0.15 }), title: 'Small', style: { fontSize: 11, fontWeight: 700 } }, 'S'),
        e('button', { className: 'ob-btn' + (s.camW >= 0.18 && s.camW < 0.28 ? ' on' : ''), onClick: () => set({ camW: 0.22 }), title: 'Medium', style: { fontSize: 12, fontWeight: 700 } }, 'M'),
        e('button', { className: 'ob-btn' + (s.camW >= 0.28 ? ' on' : ''), onClick: () => set({ camW: 0.32 }), title: 'Large', style: { fontSize: 13, fontWeight: 700 } }, 'L'),
      ),
      e('div', { className: 'ob-sep' }),
      e('div', { className: 'ob-group' },
        e('button', { className: 'ob-btn' + (s.camShape === 'circle' ? ' on' : ''), onClick: () => set({ camShape: s.camShape === 'circle' ? 'rounded' : 'circle' }), title: 'Circle' },
          e('div', { style: { width: 18, height: 18, borderRadius: '50%', border: '2px solid currentColor' } })),
        e('button', { className: 'ob-btn' + (s.camMirror ? ' on' : ''), onClick: () => set({ camMirror: !s.camMirror }), title: 'Mirror' },
          e(Icon, { name: 'flip', size: 18 })),
      ),
      e('div', { className: 'ob-sep' }),
      e('button', { className: 'ob-done', onClick: onDone }, 'Done'),
    );
  }

  function Countdown({ n }) {
    return e('div', { className: 'countdown' },
      e('div', { className: 'cd-num', key: n }, n),
      e('div', { className: 'cd-hint' }, 'Get ready… (Esc to cancel)'),
    );
  }

  // The bubble's % coordinates are relative to the VIDEO CONTENT BOX (the
  // letterboxed area the capture occupies inside the stage), which is the same
  // coordinate system the engine composites in — that is what makes the
  // preview equal the output.
  function useContentRect(stageRef, stream) {
    const [rect, setRect] = useState(null);
    useEffect(() => {
      function compute() {
        const el = stageRef.current;
        if (!el) { setRect(null); return; }
        const sw = el.clientWidth, sh = el.clientHeight;
        let va = null;
        if (stream) {
          const track = stream.getVideoTracks()[0];
          const st = track && track.getSettings ? track.getSettings() : null;
          if (st && st.width && st.height) va = st.width / st.height;
        }
        if (!va) { setRect({ left: 0, top: 0, width: sw, height: sh }); return; }
        const sa = sw / sh;
        if (va > sa) {
          const h = sw / va;
          setRect({ left: 0, top: (sh - h) / 2, width: sw, height: h });
        } else {
          const w = sh * va;
          setRect({ left: (sw - w) / 2, top: 0, width: w, height: sh });
        }
      }
      compute();
      const ro = new ResizeObserver(compute);
      if (stageRef.current) ro.observe(stageRef.current);
      return () => ro.disconnect();
    }, [stream]);
    return rect;
  }

  function StageEmpty({ mode }) {
    const msg = mode === 'camera' ? 'Waiting for the camera…' : 'Pick a source to see the preview.';
    return e('div', { className: 'stage-empty' },
      e('div', { className: 'ring' }, e(Icon, { name: mode === 'camera' ? 'webcam' : 'monitor', size: 26 })),
      e('p', null, msg),
    );
  }

  function Stage({ s, set, actions }) {
    const stageRef = useRef(null);
    const layerRef = useRef(null);
    const editing = s.flow === 'overlayEdit';
    const recording = s.flow === 'recording' || s.flow === 'paused' || s.flow === 'stopping';
    // While recording, the engine's composited stream already contains the
    // camera, so the bubble only overlays the pre-recording preview.
    const camActive = s.camOn && s.mode !== 'camera' && !recording;
    const contentRect = useContentRect(stageRef, s.mode === 'camera' ? null : s.previewStream);

    const scene = s.mode === 'camera'
      ? (s.camStream
          ? e(StreamVideo, { stream: s.camStream, className: 'preview', mirrored: s.camMirror })
          : e(StageEmpty, { mode: 'camera' }))
      : (s.previewStream
          ? e(StreamVideo, { stream: s.previewStream, className: 'preview' })
          : e(StageEmpty, { mode: s.mode }));

    return e('div', { className: 'stage', ref: stageRef },
      scene,
      // recording / source tag
      recording
        ? e('div', { className: 'stage-tag' },
            e('div', { className: 'dot', style: { background: s.flow === 'paused' ? '#ef7f21' : '#e8212d', animation: s.flow === 'paused' ? 'none' : 'blink 1.4s infinite' } }),
            s.flow === 'paused' ? 'Paused' : s.flow === 'stopping' ? 'Finishing…' : 'Recording',
            e('span', { style: { fontFamily: 'var(--mono)', opacity: .85, marginLeft: 4 } }, actions.fmt(s.elapsed)),
          )
        : null,
      // camera overlay, positioned inside the video content box
      camActive && contentRect
        ? e('div', {
            ref: layerRef, className: 'cam-layer',
            style: { position: 'absolute', left: contentRect.left, top: contentRect.top, width: contentRect.width, height: contentRect.height, pointerEvents: 'none', zIndex: 8 },
          },
            s.overlayEditable
              ? e(CameraOverlay, { s, set, editing, stageRef: layerRef, actions, flow: s.flow })
              : null,
          )
        : null,
      // overlay editor toolbar
      editing && camActive && s.overlayEditable ? e(OverlayToolbar, { s, set, stageRef: layerRef, onDone: () => actions.setFlow('ready') }) : null,
      // dim background behind editing
      editing ? e('div', { style: { position: 'absolute', inset: 0, background: 'rgba(10,12,16,.35)', zIndex: 7, pointerEvents: 'none' } }) : null,
      // countdown
      s.flow === 'countdown' && s.countdownN > 0 ? e(Countdown, { n: s.countdownN }) : null,
      // floating control (loom-style)
      (s.flow === 'recording' || s.flow === 'paused') && s.floatingOn
        ? e('div', { className: 'floatbar' },
            e('span', { className: 'fled', style: s.flow === 'paused' ? { background: '#ef7f21', animation: 'none' } : {} }),
            e('span', { className: 'ftimer' }, actions.fmt(s.elapsed)),
            e('div', { className: 'fsep' }),
            e('button', { className: 'fbtn', onClick: actions.togglePause, title: s.flow === 'paused' ? 'Resume' : 'Pause' },
              e(Icon, { name: s.flow === 'paused' ? 'play' : 'pause', size: 18, fill: s.flow === 'paused' ? 'currentColor' : 'none' })),
            e('button', { className: 'fbtn stop', onClick: actions.stop, title: 'Stop & save' }, e('div', { style: { width: 13, height: 13, borderRadius: 3, background: '#fff' } })),
            e('button', { className: 'fbtn danger', onClick: actions.discardRecording, title: 'Discard' }, e(Icon, { name: 'trash', size: 17 })),
          )
        : null,
    );
  }

  window.Stage = Stage;
})();
