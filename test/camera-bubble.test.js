'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CameraBubble, bubbleRect, positionFromRect, windowIdOf } = require('../camera-bubble');

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.visible = false;
    this.destroyed = false;
    this.ignoreMouse = false;
    this.scripts = [];
    this.handlers = {};
    this.webContents = {
      once: (name, fn) => { this.loaded = fn; },
      executeJavaScript: (code) => { this.scripts.push(code); return Promise.resolve(); },
    };
    FakeWindow.created.push(this);
  }
  on(name, fn) { this.handlers[name] = fn; }
  loadFile(file) { this.file = file; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setBounds(b) { this.bounds = { ...b }; }
  getBounds() { return { ...this.bounds }; }
  setIgnoreMouseEvents(v) { this.ignoreMouse = v; }
  showInactive() { this.visible = true; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.visible = false; }
}
FakeWindow.created = [];

const DISPLAY = { id: 7, bounds: { x: 0, y: 0, width: 1600, height: 900 } };
const SECOND = { id: 9, bounds: { x: 1600, y: 0, width: 1000, height: 800 } };
const LAYOUT = { x: 80, y: 70, w: 0.15, shape: 'rounded', mirror: true };

function make(overrides = {}) {
  FakeWindow.created = [];
  const moved = [];
  const state = { mainOpen: true, windowRect: { x: 100, y: 50, width: 800, height: 600 }, timers: 0 };
  const bubble = new CameraBubble({
    BrowserWindow: FakeWindow,
    screen: { getAllDisplays: () => [DISPLAY, SECOND], getPrimaryDisplay: () => DISPLAY },
    htmlPath: '/app/camera-bubble.html', preloadPath: '/app/camera-bubble-preload.js',
    windowBounds: (id) => (id === 4321 ? state.windowRect : null),
    mainWindowOpen: () => state.mainOpen,
    onMoved: (p) => moved.push(p),
    setInterval: () => { state.timers++; return { id: state.timers }; },
    clearInterval: () => { state.timers--; },
    ...overrides,
  });
  return { bubble, moved, state };
}
const screenRequest = (extra = {}) => ({ visible: true, active: false, mode: 'screen', displayId: '7', sourceId: 'screen:7:0', layout: LAYOUT, deviceId: 'cam1', ...extra });
const windowRequest = (extra = {}) => ({ visible: true, active: false, mode: 'window', sourceId: 'window:4321:0', layout: LAYOUT, deviceId: 'cam1', ...extra });

test('the camera rectangle follows the layout inside the frame', () => {
  assert.deepStrictEqual(bubbleRect(DISPLAY.bounds, LAYOUT), { x: 1280, y: 630, width: 240, height: 180 });
  assert.deepStrictEqual(bubbleRect(DISPLAY.bounds, { ...LAYOUT, shape: 'circle' }), { x: 1280, y: 630, width: 240, height: 240 });
  assert.deepStrictEqual(bubbleRect(SECOND.bounds, { ...LAYOUT, x: 10, y: 10 }), { x: 1700, y: 80, width: 150, height: 113 });
});

test('a dragged position maps back to the layout and stays inside the frame', () => {
  const rect = bubbleRect(DISPLAY.bounds, LAYOUT);
  const back = positionFromRect(DISPLAY.bounds, rect);
  assert.strictEqual(back.x, 80);
  assert.strictEqual(back.y, 70);
  const outside = positionFromRect(DISPLAY.bounds, { x: 3000, y: -500, width: 240, height: 180 });
  assert.strictEqual(outside.x, 100 - 2 - 15);
  assert.strictEqual(outside.y, 2);
});

test('window source ids give the window number', () => {
  assert.strictEqual(windowIdOf('window:4321:0'), 4321);
  assert.strictEqual(windowIdOf('screen:1:0'), 0);
  assert.strictEqual(windowIdOf(null), 0);
});

test('full screen: the camera sits on the recorded display and counts as part of the picture', () => {
  const { bubble } = make();
  const result = bubble.sync(screenRequest());
  assert.deepStrictEqual(result, { shown: true, inPicture: true });
  const win = FakeWindow.created[0];
  assert.deepStrictEqual(win.getBounds(), { x: 1280, y: 630, width: 240, height: 180 });
  assert.strictEqual(win.visible, true);
  assert.strictEqual(win.ignoreMouse, false);
  assert.strictEqual(win.options.focusable, false);

  // The page gets its settings once it has loaded, and again only when they change.
  assert.strictEqual(win.scripts.length, 0);
  win.loaded();
  assert.strictEqual(win.scripts.length, 1);
  assert.match(win.scripts[0], /"shape":"rounded"/);
  assert.match(win.scripts[0], /"deviceId":"cam1"/);
  bubble.sync(screenRequest());
  assert.strictEqual(win.scripts.length, 1);
  bubble.sync(screenRequest({ layout: { ...LAYOUT, shape: 'circle' } }));
  assert.strictEqual(win.scripts.length, 2);
  assert.strictEqual(win.getBounds().height, 240);

  // Another display.
  bubble.sync(screenRequest({ displayId: '9' }));
  assert.strictEqual(win.getBounds().x, 1600 + 800);
});

test('one window: the camera sits over the window, follows it, and the engine still draws it', () => {
  const { bubble, state } = make();
  const result = bubble.sync(windowRequest());
  assert.deepStrictEqual(result, { shown: true, inPicture: false });
  const win = FakeWindow.created[0];
  assert.deepStrictEqual(win.getBounds(), { x: 100 + 640, y: 50 + 420, width: 120, height: 90 });
  assert.strictEqual(state.timers, 1);

  state.windowRect = { x: 300, y: 200, width: 800, height: 600 };
  bubble.refresh();
  assert.deepStrictEqual(win.getBounds(), { x: 300 + 640, y: 200 + 420, width: 120, height: 90 });

  // While recording, clicks go through to the recorded window.
  bubble.sync(windowRequest({ active: true }));
  assert.strictEqual(win.ignoreMouse, true);
  assert.match(win.scripts.length ? win.scripts.at(-1) : JSON.stringify(bubble.config), /"draggable":false/);

  // The window was closed: nothing to show, and the camera is released.
  state.windowRect = null;
  assert.deepStrictEqual(bubble.refresh(), { shown: false, inPicture: false });
  assert.strictEqual(win.destroyed, true);
  assert.strictEqual(state.timers, 0);
});

test('hidden when not wanted, and when MyScreen is closed to the menu bar while idle', () => {
  const { bubble, state } = make();
  assert.deepStrictEqual(bubble.sync(screenRequest({ visible: false })), { shown: false, inPicture: false });
  assert.strictEqual(FakeWindow.created.length, 0);

  bubble.sync(screenRequest());
  const win = FakeWindow.created[0];
  state.mainOpen = false;
  assert.strictEqual(bubble.refresh().shown, false);
  assert.strictEqual(win.destroyed, true);

  // A recording started from the menu bar shows it again.
  assert.strictEqual(bubble.sync(screenRequest({ active: true })).shown, true);
  assert.strictEqual(FakeWindow.created.length, 2);
});

test('dragging moves the window and reports the new position', () => {
  const { bubble, moved } = make();
  bubble.sync(screenRequest());
  const win = FakeWindow.created[0];
  bubble.drag({ phase: 'start' });
  bubble.drag({ phase: 'move', dx: -480, dy: -180 });
  assert.deepStrictEqual(win.getBounds(), { x: 800, y: 450, width: 240, height: 180 });
  // A refresh during the drag leaves the window under the pointer.
  bubble.refresh();
  assert.strictEqual(win.getBounds().x, 800);
  bubble.drag({ phase: 'end' });
  assert.deepStrictEqual(moved, [{ x: 50, y: 50 }]);

  // Dropped outside the display: it comes back inside.
  bubble.drag({ phase: 'start' });
  bubble.drag({ phase: 'move', dx: 5000, dy: 5000 });
  bubble.drag({ phase: 'end' });
  assert.strictEqual(moved[1].x, 83);
  assert.deepStrictEqual(win.getBounds(), bubbleRect(DISPLAY.bounds, { ...LAYOUT, ...moved[1] }));
});

test('a recorded window cannot be covered by a drag while recording', () => {
  const { bubble, moved } = make();
  bubble.sync(windowRequest({ active: true }));
  const before = FakeWindow.created[0].getBounds();
  bubble.drag({ phase: 'start' });
  bubble.drag({ phase: 'move', dx: 50, dy: 50 });
  bubble.drag({ phase: 'end' });
  assert.deepStrictEqual(FakeWindow.created[0].getBounds(), before);
  assert.strictEqual(moved.length, 0);
});
