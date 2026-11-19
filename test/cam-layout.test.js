'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CamLayout = require('../ui/cam-layout.js');

const WIDE = 16 / 9;
const width = (name) => CamLayout.SIZES.find((size) => size.v === name).w;

test('a width counts as the nearest named size', () => {
  assert.strictEqual(CamLayout.sizeOf(width('small')), 'small');
  assert.strictEqual(CamLayout.sizeOf(width('medium')), 'medium');
  assert.strictEqual(CamLayout.sizeOf(width('large')), 'large');
  assert.strictEqual(CamLayout.sizeOf(0.2), 'large'); // the default before named sizes
  assert.strictEqual(CamLayout.sizeOf(0.4), 'large');
  assert.strictEqual(CamLayout.sizeOf(0.06), 'small');
});

test('a bubble in the bottom right keeps that corner when its size changes', () => {
  const s = { camX: 82, camY: 74, camW: 0.15, camShape: 'rounded' };
  const right = s.camX + s.camW * 100;
  const bottom = s.camY + CamLayout.heightPct(s.camW, s.camShape, WIDE);

  const small = CamLayout.patch(s, { w: width('small') }, WIDE);
  assert.strictEqual(small.camW, width('small'));
  assert.ok(Math.abs(small.camX + small.camW * 100 - right) < 1e-9);
  assert.ok(Math.abs(small.camY + CamLayout.heightPct(small.camW, 'rounded', WIDE) - bottom) < 1e-9);
});

test('a bubble in the top left keeps that corner when its size changes', () => {
  const s = { camX: 4, camY: 4, camW: 0.1, camShape: 'rounded' };
  const large = CamLayout.patch(s, { w: width('large') }, WIDE);
  assert.strictEqual(large.camX, 4);
  assert.strictEqual(large.camY, 4);
});

test('a larger or taller bubble stays inside the video', () => {
  const s = { camX: 88, camY: 80, camW: 0.1, camShape: 'rounded' };
  for (const change of [{ w: width('large') }, { shape: 'circle' }, { w: 0.4, shape: 'circle' }]) {
    const next = CamLayout.patch(s, change, WIDE);
    const h = CamLayout.heightPct(next.camW, next.camShape, WIDE);
    assert.ok(next.camX >= CamLayout.MARGIN && next.camX + next.camW * 100 <= 100 - CamLayout.MARGIN + 1e-9, JSON.stringify(next));
    assert.ok(next.camY >= CamLayout.MARGIN && next.camY + h <= 100 - CamLayout.MARGIN + 1e-9, JSON.stringify(next));
  }
});

test('a circle is as tall as it is wide in pixels', () => {
  // 10% of a 1600 px wide video is 160 px; on a 900 px tall video that is 17.8%.
  assert.ok(Math.abs(CamLayout.heightPct(0.1, 'circle', WIDE) - (160 / 900) * 100) < 1e-9);
  assert.ok(Math.abs(CamLayout.heightPct(0.1, 'rounded', WIDE) - (120 / 900) * 100) < 1e-9);
});

test('the width is limited to the supported range', () => {
  const s = { camX: 50, camY: 50, camW: 0.15, camShape: 'rounded' };
  assert.strictEqual(CamLayout.patch(s, { w: 5 }, WIDE).camW, CamLayout.MAX_W);
  assert.strictEqual(CamLayout.patch(s, { w: 0 }, WIDE).camW, CamLayout.MIN_W);
});
