/* MyScreen: camera bubble layout, shared by the Camera settings and the
   preview editor. Pure math, so it runs under node:test too.

   The bubble is stored as camX / camY (top-left corner, percent of the video)
   and camW (width as a fraction of the video's width). */
(function (root) {
  'use strict';

  const SIZES = [
    { v: 'small', label: 'Small', short: 'S', w: 0.1 },
    { v: 'medium', label: 'Medium', short: 'M', w: 0.15 },
    { v: 'large', label: 'Large', short: 'L', w: 0.22 },
  ];
  const MIN_W = 0.06;
  const MAX_W = 0.4;
  const MARGIN = 2; // percent kept free at the edges of the video

  // The named size a width counts as (the nearest one).
  function sizeOf(w) {
    let best = SIZES[0];
    for (const size of SIZES) {
      if (Math.abs(size.w - w) < Math.abs(best.w - w)) best = size;
    }
    return best.v;
  }

  // Bubble height in percent of the video's height. frameAspect = width / height.
  function heightPct(w, shape, frameAspect) {
    return (w * 100 * frameAspect) / (shape === 'circle' ? 1 : 4 / 3);
  }

  // State patch for a new width and/or shape. The bubble keeps the corner it
  // sits nearest to and stays inside the video.
  function patch(s, change, frameAspect) {
    const w = Math.max(MIN_W, Math.min(MAX_W, change.w != null ? change.w : s.camW));
    const shape = change.shape || s.camShape;
    const oldW = s.camW * 100;
    const newW = w * 100;
    const oldH = heightPct(s.camW, s.camShape, frameAspect);
    const newH = heightPct(w, shape, frameAspect);
    const hugsRight = s.camX + oldW / 2 > 50;
    const hugsBottom = s.camY + oldH / 2 > 50;
    const clamp = (v, size) => Math.max(MARGIN, Math.min(100 - MARGIN - size, v));
    return {
      camW: w,
      camShape: shape,
      camX: clamp(hugsRight ? s.camX + oldW - newW : s.camX, newW),
      camY: clamp(hugsBottom ? s.camY + oldH - newH : s.camY, newH),
    };
  }

  // Width / height of the video in the preview (16:9 until a preview exists).
  function frameAspect() {
    const layer = typeof document !== 'undefined' ? document.querySelector('.cam-layer') : null;
    const r = layer && layer.getBoundingClientRect();
    return r && r.width && r.height ? r.width / r.height : 16 / 9;
  }

  const api = { SIZES, MIN_W, MAX_W, MARGIN, sizeOf, heightPct, patch, frameAspect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
