'use strict';

// The camera, shown on the real screen where it lands in the recording.
//
// A small frameless window that floats above everything. The renderer sends
// the camera layout (the same camX / camY / camW the preview uses) and what
// is being recorded:
//
//   full screen  The window sits on the recorded display and is part of the
//                picture: the screen capture records it, so the engine does
//                not draw the camera a second time. It can be dragged, also
//                while recording.
//   one window   The window sits over the recorded window and follows it. A
//                window capture does not include other windows, so the engine
//                still draws the camera into the video; this window shows
//                where. It can be dragged until the recording starts, and
//                lets clicks through while it runs.
//
// Electron pieces are injected so the placement logic can be tested with fakes.

const FOLLOW_INTERVAL_MS = 400;
const MARGIN_PCT = 2;

// 'window:1234:0' -> 1234 (the CGWindowID desktopCapturer puts in the id)
function windowIdOf(sourceId) {
  const m = /^window:(\d+)/.exec(String(sourceId || ''));
  return m ? Number(m[1]) : 0;
}

// Where the camera goes inside `frame` ({ x, y, width, height } in screen points).
function bubbleRect(frame, layout) {
  const width = Math.max(24, Math.round(frame.width * layout.w));
  const height = layout.shape === 'circle' ? width : Math.round(width * 3 / 4);
  return {
    x: Math.round(frame.x + frame.width * layout.x / 100),
    y: Math.round(frame.y + frame.height * layout.y / 100),
    width,
    height,
  };
}

// The layout position for a camera window the user dragged to `rect`, kept
// inside the frame.
function positionFromRect(frame, rect) {
  const clamp = (v, sizePct) => Math.max(MARGIN_PCT, Math.min(100 - MARGIN_PCT - sizePct, v));
  const wPct = rect.width / frame.width * 100;
  const hPct = rect.height / frame.height * 100;
  return {
    x: clamp((rect.x - frame.x) / frame.width * 100, wPct),
    y: clamp((rect.y - frame.y) / frame.height * 100, hPct),
  };
}

const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

class CameraBubble {
  // deps: { BrowserWindow, screen, htmlPath, preloadPath, windowBounds(cgWindowId) -> rect | null,
  //         onMoved({ x, y }), mainWindowOpen() -> bool, setInterval?, clearInterval? }
  constructor(deps) {
    this.deps = deps;
    this.win = null;
    this.ready = false;
    this.request = null;   // the last request from the renderer
    this.frame = null;     // what the camera is placed in, in screen points
    this.placed = null;    // the bounds this module last gave the window
    this.config = null;    // what the page was last told to show
    this.timer = null;
    this.dragFrom = null;  // window bounds when a drag began
  }

  get shown() { return !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); }

  // request: { visible, active, mode: 'screen' | 'window', displayId, sourceId,
  //            layout: { x, y, w, shape, mirror }, deviceId }
  // `active` is true from the countdown until the recording stops.
  // Returns { shown, inPicture }: inPicture means the screen capture records
  // this window, so the camera must not be drawn into the video again.
  sync(request) {
    this.request = request || null;
    return this.refresh();
  }

  // Re-evaluate the last request (the main window was closed or reopened, or
  // the recorded window moved).
  refresh() {
    const req = this.request;
    const wanted = !!req && req.visible && (req.active || this.deps.mainWindowOpen());
    const frame = wanted ? this._frameFor(req) : null;
    if (!frame) {
      this._hide();
      return { shown: false, inPicture: false };
    }
    this.frame = frame;
    const win = this._ensureWindow();
    const rect = bubbleRect(frame, req.layout);
    if (!this.dragFrom && !sameRect(rect, this.placed)) {
      this.placed = rect;
      win.setBounds(rect);
    }
    // A recorded window keeps its own clicks while the recording runs.
    const passive = req.mode === 'window' && !!req.active;
    win.setIgnoreMouseEvents(passive);
    this._configure({ shape: req.layout.shape, mirror: !!req.layout.mirror, deviceId: req.deviceId || '', draggable: !passive });
    if (!win.isVisible()) win.showInactive();
    this._follow(req.mode === 'window');
    return { shown: true, inPicture: req.mode === 'screen' };
  }

  dispose() {
    this._follow(false);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = false;
  }

  // --- internals -------------------------------------------------------------------

  _frameFor(req) {
    if (req.mode === 'screen') {
      const displays = this.deps.screen.getAllDisplays();
      const display = displays.find((d) => String(d.id) === String(req.displayId)) || this.deps.screen.getPrimaryDisplay();
      return display ? display.bounds : null;
    }
    if (req.mode === 'window') {
      const id = windowIdOf(req.sourceId);
      const bounds = id ? this.deps.windowBounds(id) : null;
      return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : null;
    }
    return null;
  }

  _ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new this.deps.BrowserWindow({
      width: 200, height: 150, show: false,
      frame: false, transparent: true, hasShadow: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, acceptFirstMouse: true,
      webPreferences: { preload: this.deps.preloadPath, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.ready = false;
    this.config = null;
    this.placed = null;
    win.webContents.once('did-finish-load', () => {
      if (this.win !== win) return;
      this.ready = true;
      const config = this.config;
      this.config = null;
      if (config) this._configure(config);
    });
    win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; } });
    win.loadFile(this.deps.htmlPath);
    this.win = win;
    return win;
  }

  _configure(config) {
    const same = this.config && JSON.stringify(this.config) === JSON.stringify(config);
    this.config = config;
    if (same || !this.ready || !this.win || this.win.isDestroyed()) return;
    this.win.webContents.executeJavaScript(`window.applyConfig(${JSON.stringify(config)})`).catch(() => { /* page gone */ });
  }

  // The page reports a drag: 'start', then 'move' with the pointer's travel
  // in screen points, then 'end'.
  drag({ phase, dx = 0, dy = 0 } = {}) {
    if (!this.win || this.win.isDestroyed() || !this.frame || !this.request) return;
    if (this.request.mode === 'window' && this.request.active) return;
    if (phase === 'start') {
      this.dragFrom = this.win.getBounds();
    } else if (phase === 'move' && this.dragFrom) {
      const next = { ...this.dragFrom, x: Math.round(this.dragFrom.x + dx), y: Math.round(this.dragFrom.y + dy) };
      this.placed = next;
      this.win.setBounds(next);
    } else if (phase === 'end' && this.dragFrom) {
      this.dragFrom = null;
      this._onMoved();
    }
  }

  _onMoved() {
    const bounds = this.win.getBounds();
    const position = positionFromRect(this.frame, bounds);
    this.request = { ...this.request, layout: { ...this.request.layout, ...position } };
    // Snap back inside the frame if it was dropped outside.
    const rect = bubbleRect(this.frame, this.request.layout);
    this.placed = rect;
    if (!sameRect(rect, bounds)) this.win.setBounds(rect);
    this.deps.onMoved(position);
  }

  _hide() {
    this._follow(false);
    this.frame = null;
    this.dragFrom = null;
    if (!this.win || this.win.isDestroyed()) return;
    // Destroying the window is what releases the camera.
    this.win.destroy();
    this.win = null;
    this.ready = false;
    this.placed = null;
    this.config = null;
  }

  // A recorded window can move or resize; keep the camera over it.
  _follow(on) {
    const set = this.deps.setInterval || setInterval;
    const clear = this.deps.clearInterval || clearInterval;
    if (!on) {
      if (this.timer) { clear(this.timer); this.timer = null; }
      return;
    }
    if (this.timer) return;
    this.timer = set(() => this.refresh(), FOLLOW_INTERVAL_MS);
    if (this.timer && this.timer.unref) this.timer.unref();
  }
}

module.exports = { CameraBubble, bubbleRect, positionFromRect, windowIdOf };
