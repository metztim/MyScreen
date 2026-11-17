'use strict';

// Recording controls that live outside the app window: a menu bar item to
// start a recording from anywhere, global shortcuts, and hiding the window
// while the full screen is recorded (so MyScreen stays out of its own
// recording and Stop is reachable without bringing it back into the shot).
//
// The renderer owns recording state. It reports a status after every change:
//   { phase: 'ready'|'countdown'|'recording'|'paused'|'busy', elapsed, countdownN, mode }
// and this module answers user actions with a command for the renderer:
//   'toggle'         start with the current mode when ready, stop when recording
//   'pause'          pause or resume
//   'record-screen'  start a full-screen recording
//   'record-window'  choose a window, then record it
//   'record-camera'  start a camera recording
//
// Electron pieces are injected so the logic can be tested with fakes.

const SHORTCUT_SYMBOLS = {
  Control: '⌃', Ctrl: '⌃', Shift: '⇧', Alt: '⌥', Option: '⌥',
  Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘',
};

// 'Control+Shift+R' -> '⌃⇧R'
function shortcutLabel(accelerator) {
  if (!accelerator) return '';
  return String(accelerator).split('+').map((part) => SHORTCUT_SYMBOLS[part] || part).join('');
}

function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

class RecordingControls {
  // deps: { Tray, Menu, globalShortcut, icons: { idle, recording },
  //         getWindow, getSettings, sendCommand, quit, focusApp?,
  //         openRecordingsFolder?, loginItem?: { available, get(), set(bool) } }
  constructor(deps) {
    this.deps = deps;
    this.tray = null;
    this.status = { phase: 'busy', elapsed: 0, countdownN: 0, mode: 'screen' };
    this.registered = new Map(); // accelerator -> role ('toggle' | 'pause')
    this.hiddenByRecording = false;
    this._menuKey = '';
  }

  start() {
    const { Tray, icons } = this.deps;
    this.tray = new Tray(icons.idle);
    this.tray.setToolTip('MyScreen');
    this._render();
    this._syncShortcuts();
  }

  get isRecording() {
    return this.status.phase === 'recording' || this.status.phase === 'paused';
  }

  // Called for every status report from the renderer.
  update(next) {
    const wasRecording = this.isRecording;
    this.status = { ...this.status, ...next };
    this._render();
    this._syncShortcuts();
    this._syncWindow(wasRecording);
  }

  // Called after settings change (shortcuts on/off, hide on/off).
  applySettings() {
    this._menuKey = '';
    this._render();
    this._syncShortcuts();
  }

  dispose() {
    for (const accelerator of this.registered.keys()) {
      try { this.deps.globalShortcut.unregister(accelerator); } catch { /* quitting */ }
    }
    this.registered.clear();
    if (this.tray) { try { this.tray.destroy(); } catch { /* quitting */ } this.tray = null; }
  }

  // --- menu bar item -----------------------------------------------------------

  _render() {
    if (!this.tray) return;
    const { phase, elapsed, countdownN } = this.status;
    const { icons } = this.deps;

    this.tray.setImage(this.isRecording ? icons.recording : icons.idle);
    const title = phase === 'recording' ? ` ${formatElapsed(elapsed)}`
      : phase === 'paused' ? ' Paused'
        : phase === 'countdown' && countdownN > 0 ? ` ${countdownN}`
          : '';
    this.tray.setTitle(title);

    // Rebuild the menu only when its content changes (the timer ticks every
    // second; an open menu must not be replaced under the pointer).
    const settings = this.deps.getSettings();
    const login = this.deps.loginItem;
    const key = [phase, this.status.mode, settings.globalShortcutsOn, settings.shortcutToggle, settings.shortcutPause,
      [...this.registered.keys()].join(','), login && login.available ? login.get() : 'n/a'].join('|');
    if (key === this._menuKey) return;
    this._menuKey = key;
    this.tray.setContextMenu(this.deps.Menu.buildFromTemplate(this._menuTemplate(settings)));
  }

  _menuTemplate(settings) {
    const { phase } = this.status;
    const command = (name) => () => this.deps.sendCommand(name);
    // Show a shortcut next to an item only if it is really registered.
    const hint = (accelerator) => (this.registered.has(accelerator) ? { accelerator } : {});
    const items = [];

    if (this.isRecording) {
      items.push({ label: 'Stop and Save', click: command('toggle'), ...hint(settings.shortcutToggle) });
      items.push({ label: phase === 'paused' ? 'Resume' : 'Pause', click: command('pause'), ...hint(settings.shortcutPause) });
    } else if (phase === 'countdown') {
      items.push({ label: 'Starting…', enabled: false });
    } else {
      // The shortcut starts whichever kind was used last; show it there.
      const ready = phase === 'ready';
      const kinds = [
        { mode: 'screen', label: 'Record Full Screen', name: 'record-screen' },
        // Choosing a window needs the picker, so the window comes forward first.
        { mode: 'window', label: 'Record a Window…', name: 'record-window', click: () => { this.showWindow(); this.deps.sendCommand('record-window'); } },
        { mode: 'camera', label: 'Record Camera', name: 'record-camera' },
      ];
      for (const kind of kinds) {
        items.push({
          label: kind.label,
          enabled: ready,
          click: kind.click || command(kind.name),
          ...(kind.mode === this.status.mode ? hint(settings.shortcutToggle) : {}),
        });
      }
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Open MyScreen', click: () => this.showWindow() });
    if (this.deps.openRecordingsFolder) items.push({ label: 'Open Recordings Folder', click: () => this.deps.openRecordingsFolder() });
    items.push({ type: 'separator' });
    const login = this.deps.loginItem;
    if (login && login.available) {
      items.push({
        label: 'Start at Login', type: 'checkbox', checked: !!login.get(),
        click: (item) => { login.set(!!item.checked); this._menuKey = ''; this._render(); },
      });
    }
    items.push({ label: 'Quit MyScreen', click: () => this.deps.quit() });
    return items;
  }

  // --- global shortcuts ----------------------------------------------------------

  // The start/stop shortcut is always on (start from any app). The pause
  // shortcut exists only while a recording runs, so it is not taken from
  // other apps the rest of the time.
  _syncShortcuts() {
    const settings = this.deps.getSettings();
    const wanted = new Map();
    if (settings.globalShortcutsOn) {
      if (settings.shortcutToggle) wanted.set(settings.shortcutToggle, 'toggle');
      if (settings.shortcutPause && this.isRecording) wanted.set(settings.shortcutPause, 'pause');
    }

    let changed = false;
    for (const accelerator of [...this.registered.keys()]) {
      if (wanted.has(accelerator)) continue;
      try { this.deps.globalShortcut.unregister(accelerator); } catch { /* already gone */ }
      this.registered.delete(accelerator);
      changed = true;
    }
    for (const [accelerator, role] of wanted) {
      if (this.registered.has(accelerator)) continue;
      let ok = false;
      try {
        ok = this.deps.globalShortcut.register(accelerator, () => this.deps.sendCommand(role));
      } catch { ok = false; }
      // false: another app holds it. The menu bar item still works.
      if (ok) { this.registered.set(accelerator, role); changed = true; }
    }
    if (changed) { this._menuKey = ''; this._render(); }
  }

  // --- window --------------------------------------------------------------------

  _syncWindow(wasRecording) {
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return;
    const settings = this.deps.getSettings();

    if (!wasRecording && this.isRecording) {
      // Only a full-screen recording would have the window in the picture.
      if (settings.hideOnRecord && this.status.mode === 'screen' && win.isVisible()) {
        win.hide();
        this.hiddenByRecording = true;
      }
    } else if (wasRecording && !this.isRecording) {
      // The recording is over: bring MyScreen to the front for the Saved
      // sheet, whether its window was hidden for the recording, was closed
      // to the menu bar, or sits behind the app that was being recorded.
      this.showWindow();
    }
  }

  showWindow() {
    this.hiddenByRecording = false;
    const win = this.deps.getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // show() alone leaves the window behind other apps when MyScreen is not
    // the active app (a recording stopped from the menu bar or a shortcut).
    if (this.deps.focusApp) this.deps.focusApp();
  }
}

module.exports = { RecordingControls, shortcutLabel, formatElapsed };
