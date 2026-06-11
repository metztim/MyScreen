/* MyScreen — shared UI primitives. */
(function () {
  const e = React.createElement;
  const { useState, useEffect } = React;

  function Toggle({ on, onChange }) {
    return e('button', {
      className: 'toggle' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on,
      onClick: (ev) => { ev.stopPropagation(); onChange(!on); },
    });
  }

  // Live mic input meter: opens the selected device while mounted and reads
  // RMS levels through an AnalyserNode. Stays at zero if the mic is unavailable.
  function LevelMeter({ active, deviceId, bars = 14 }) {
    const [level, setLevel] = useState(0);
    useEffect(() => {
      if (!active) { setLevel(0); return; }
      let audioCtx = null, stream = null, raf = null, dead = false;
      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
          });
          if (dead) { stream.getTracks().forEach((t) => t.stop()); return; }
          audioCtx = new AudioContext();
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          audioCtx.createMediaStreamSource(stream).connect(analyser);
          const data = new Uint8Array(analyser.fftSize);
          const tick = () => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
            setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch { /* no permission or device gone: meter stays empty */ }
      })();
      return () => {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        if (audioCtx) audioCtx.close();
        setLevel(0);
      };
    }, [active, deviceId]);
    const lit = Math.round(level * bars);
    return e('div', { className: 'meter', 'aria-hidden': true },
      Array.from({ length: bars }).map((_, i) =>
        e('i', {
          key: i,
          className: i < lit ? (i > bars - 4 ? 'hot' : 'lit') : '',
          style: { height: `${4 + (i / bars) * 14}px` },
        })),
    );
  }

  // colorful rounded app-icon tile with a letter (fallback when no real icon)
  function AppIcon({ bg, label, size = 18, radius = 4 }) {
    return e('div', {
      style: {
        width: size, height: size, borderRadius: radius, background: bg, flex: '0 0 auto',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', fontSize: size * 0.5, fontWeight: 700,
        boxShadow: 'inset 0 0 0 .5px rgba(255,255,255,.25)',
      },
    }, label);
  }

  // person placeholder shown in the camera bubble until the live feed arrives
  function CamFace({ mirrored }) {
    return e('div', {
      style: {
        width: '100%', height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        background: 'radial-gradient(70% 80% at 50% 30%, #5a6b7d, #2a323d 75%)',
        transform: mirrored ? 'scaleX(-1)' : 'none',
      },
    },
      e('svg', { width: '64%', height: '74%', viewBox: '0 0 100 100', style: { display: 'block' } },
        e('circle', { cx: 50, cy: 34, r: 19, fill: 'rgba(255,255,255,.5)' }),
        e('path', { d: 'M14 100 C14 72 30 60 50 60 C70 60 86 72 86 100 Z', fill: 'rgba(255,255,255,.5)' }),
      ),
    );
  }

  window.Toggle = Toggle;
  window.LevelMeter = LevelMeter;
  window.AppIcon = AppIcon;
  window.CamFace = CamFace;
})();
