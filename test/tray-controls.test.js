'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { RecordingControls, shortcutLabel, formatElapsed } = require('../tray-controls');

// --- fakes for the Electron pieces ---------------------------------------------

function makeHarness(settingsOverride = {}) {
  const settings = {
    hideOnRecord: true, globalShortcutsOn: true,
    shortcutToggle: 'Control+Shift+R', shortcutPause: 'Control+Shift+P',
    ...settingsOverride,
  };
  const trays = [];
  class FakeTray {
    constructor(image) { this.image = image; this.title = ''; this.menu = null; trays.push(this); }
    setToolTip() {}
    setImage(image) { this.image = image; }
    setTitle(title) { this.title = title; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: (template) => template };
  const shortcuts = new Map();
  const taken = new Set(); // accelerators held by "another app"
  const globalShortcut = {
    register: (accelerator, handler) => { if (taken.has(accelerator)) return false; shortcuts.set(accelerator, handler); return true; },
    unregister: (accelerator) => { shortcuts.delete(accelerator); },
  };
  const win = {
    visible: true, minimized: false,
    isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized() { return this.minimized; },
    hide() { this.visible = false; }, show() { this.visible = true; }, focus() {}, restore() { this.minimized = false; },
  };
  const commands = [];
  const login = { available: true, on: false, get() { return this.on; }, set(v) { this.on = v; } };
  const controls = new RecordingControls({
    Tray: FakeTray, Menu, globalShortcut,
    icons: { idle: 'idle-icon', recording: 'recording-icon' },
    getWindow: () => win,
    getSettings: () => settings,
    sendCommand: (c) => commands.push(c),
    quit: () => commands.push('quit'),
    focusApp: () => { win.focused = (win.focused || 0) + 1; },
    openRecordingsFolder: () => commands.push('open-folder'),
    loginItem: login,
  });
  controls.start();
  return { controls, tray: trays[0], shortcuts, taken, win, commands, settings, login };
}

const labels = (tray) => tray.menu.filter((i) => i.label).map((i) => i.label);

// --- tests -----------------------------------------------------------------------

test('formats shortcuts and elapsed time for the menu bar', () => {
  assert.strictEqual(shortcutLabel('Control+Shift+R'), '⌃⇧R');
  assert.strictEqual(shortcutLabel('CommandOrControl+Alt+P'), '⌘⌥P');
  assert.strictEqual(formatElapsed(42), '0:42');
  assert.strictEqual(formatElapsed(3725), '1:02:05');
});

test('menu bar item follows the recording: icon, timer, and menu', () => {
  const { controls, tray, commands } = makeHarness();

  controls.update({ phase: 'ready', mode: 'screen' });
  assert.strictEqual(tray.image, 'idle-icon');
  assert.strictEqual(tray.title, '');
  assert.deepStrictEqual(labels(tray), ['Record Full Screen', 'Record a Window…', 'Record Camera', 'Open MyScreen', 'Open Recordings Folder', 'Start at Login', 'Quit MyScreen']);

  controls.update({ phase: 'countdown', countdownN: 2 });
  assert.strictEqual(tray.title, ' 2');

  controls.update({ phase: 'recording', elapsed: 65 });
  assert.strictEqual(tray.image, 'recording-icon');
  assert.strictEqual(tray.title, ' 1:05');
  assert.deepStrictEqual(labels(tray).slice(0, 3), ['Stop and Save', 'Pause', 'Open MyScreen']);

  // The timer ticking must not swap the menu out from under an open menu.
  const menuBefore = tray.menu;
  controls.update({ phase: 'recording', elapsed: 66 });
  assert.strictEqual(tray.menu, menuBefore);

  controls.update({ phase: 'paused' });
  assert.strictEqual(tray.title, ' Paused');
  assert.ok(labels(tray).includes('Resume'));

  tray.menu.find((i) => i.label === 'Stop and Save').click();
  assert.deepStrictEqual(commands, ['toggle']);

  // A sheet is open (saving, permissions): starting is not possible.
  controls.update({ phase: 'busy' });
  assert.strictEqual(tray.menu.find((i) => i.label === 'Record Full Screen').enabled, false);
});

test('a recording can be started from the menu bar: full screen, a window, or the camera', () => {
  const { controls, tray, commands, win } = makeHarness();
  controls.update({ phase: 'ready', mode: 'screen' });
  win.visible = false; // closed to the menu bar

  tray.menu.find((i) => i.label === 'Record Full Screen').click();
  tray.menu.find((i) => i.label === 'Record Camera').click();
  assert.deepStrictEqual(commands, ['record-screen', 'record-camera']);
  assert.strictEqual(win.visible, false, 'no need to open the window for these');

  // Choosing a window needs the picker, so the window comes forward.
  tray.menu.find((i) => i.label === 'Record a Window…').click();
  assert.strictEqual(win.visible, true);
  assert.strictEqual(commands.at(-1), 'record-window');

  // The shortcut hint sits on the kind it would start.
  assert.strictEqual(tray.menu.find((i) => i.label === 'Record Full Screen').accelerator, 'Control+Shift+R');
  controls.update({ mode: 'camera' });
  assert.strictEqual(tray.menu.find((i) => i.label === 'Record Full Screen').accelerator, undefined);
  assert.strictEqual(tray.menu.find((i) => i.label === 'Record Camera').accelerator, 'Control+Shift+R');

  tray.menu.find((i) => i.label === 'Open Recordings Folder').click();
  assert.strictEqual(commands.at(-1), 'open-folder');
});

test('Start at Login reflects and changes the login item', () => {
  const { controls, tray, login } = makeHarness();
  controls.update({ phase: 'ready', mode: 'screen' });
  const item = () => tray.menu.find((i) => i.label === 'Start at Login');
  assert.strictEqual(item().checked, false);
  item().click({ checked: true });
  assert.strictEqual(login.on, true);
  assert.strictEqual(item().checked, true);

  // Not offered where it cannot work (a development run).
  login.available = false;
  controls.applySettings();
  assert.strictEqual(item(), undefined);
});

test('start/stop shortcut is always registered; pause only while recording', () => {
  const { controls, shortcuts, commands } = makeHarness();
  controls.update({ phase: 'ready', mode: 'window' });
  assert.deepStrictEqual([...shortcuts.keys()], ['Control+Shift+R']);

  controls.update({ phase: 'recording' });
  assert.deepStrictEqual([...shortcuts.keys()].sort(), ['Control+Shift+P', 'Control+Shift+R']);
  shortcuts.get('Control+Shift+P')();
  shortcuts.get('Control+Shift+R')();
  assert.deepStrictEqual(commands, ['pause', 'toggle']);

  controls.update({ phase: 'busy' });
  assert.deepStrictEqual([...shortcuts.keys()], ['Control+Shift+R']);
});

test('shortcuts can be switched off, and one held by another app is left out of the menu', () => {
  const { controls, tray, shortcuts, taken, settings } = makeHarness();
  controls.update({ phase: 'ready', mode: 'screen' });
  assert.strictEqual(tray.menu[0].accelerator, 'Control+Shift+R');

  settings.globalShortcutsOn = false;
  controls.applySettings();
  assert.strictEqual(shortcuts.size, 0);
  assert.strictEqual(tray.menu[0].accelerator, undefined);

  settings.globalShortcutsOn = true;
  taken.add('Control+Shift+R');
  controls.applySettings();
  assert.strictEqual(shortcuts.size, 0, 'registration failed, nothing is claimed');
  assert.strictEqual(tray.menu[0].accelerator, undefined, 'no hint for a shortcut that does not work');
});

test('window hides for a full-screen recording and comes back when it ends', () => {
  const { controls, win } = makeHarness();
  controls.update({ phase: 'ready', mode: 'screen' });
  controls.update({ phase: 'countdown', countdownN: 3 });
  assert.strictEqual(win.visible, true, 'the countdown stays visible');

  controls.update({ phase: 'recording' });
  assert.strictEqual(win.visible, false);
  controls.update({ phase: 'paused' });
  assert.strictEqual(win.visible, false);

  controls.update({ phase: 'busy' }); // stopping -> saving
  assert.strictEqual(win.visible, true, 'back for the Saved sheet');
});

test('a recording started with the window closed opens it when the recording ends', () => {
  const { controls, win } = makeHarness();
  controls.update({ phase: 'ready', mode: 'camera' });
  win.visible = false; // closed to the menu bar before recording
  controls.update({ phase: 'recording' });
  assert.strictEqual(win.visible, false);
  controls.update({ phase: 'busy' });
  assert.strictEqual(win.visible, true, 'the Saved sheet needs somewhere to appear');
});

test('window stays put for window and camera recordings, or when hiding is off', () => {
  const windowMode = makeHarness();
  windowMode.controls.update({ phase: 'ready', mode: 'window' });
  windowMode.controls.update({ phase: 'recording' });
  assert.strictEqual(windowMode.win.visible, true);

  const off = makeHarness({ hideOnRecord: false });
  off.controls.update({ phase: 'ready', mode: 'screen' });
  off.controls.update({ phase: 'recording' });
  assert.strictEqual(off.win.visible, true);

  // A window the user brought back mid-recording is not hidden again.
  const shown = makeHarness();
  shown.controls.update({ phase: 'ready', mode: 'screen' });
  shown.controls.update({ phase: 'recording' });
  shown.controls.showWindow();
  shown.controls.update({ phase: 'paused' });
  assert.strictEqual(shown.win.visible, true);

  // When a recording ends, MyScreen comes to the front even if its window
  // was open all along (it may sit behind the app that was recorded).
  const before = windowMode.win.focused || 0;
  windowMode.controls.update({ phase: 'busy' });
  assert.strictEqual(windowMode.win.focused, before + 1);
});
