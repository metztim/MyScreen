'use strict';

// Tiny JSON settings persistence for the main process. Synchronous reads at
// startup are fine (one small file); writes are atomic via rename.

const fs = require('fs');
const path = require('path');

class SettingsStore {
  constructor(filePath, defaults = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this._cache = null;
  }

  get() {
    if (!this._cache) {
      let onDisk = {};
      try {
        onDisk = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch { /* first run or corrupt file: fall back to defaults */ }
      this._cache = { ...this.defaults, ...onDisk };
    }
    return { ...this._cache };
  }

  set(patch) {
    this._cache = { ...this.get(), ...patch };
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2));
    fs.renameSync(tmp, this.filePath);
    return { ...this._cache };
  }
}

module.exports = SettingsStore;
