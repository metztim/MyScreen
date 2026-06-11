const { contextBridge, ipcRenderer } = require('electron');

// Store previous listeners so we can replace them instead of accumulating.
const listeners = {};

function replaceListener(channel, callback) {
  if (listeners[channel]) {
    ipcRenderer.removeListener(channel, listeners[channel]);
  }
  listeners[channel] = callback;
  ipcRenderer.on(channel, callback);
}

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),

  // Settings.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  ensureSaveFolder: () => ipcRenderer.invoke('settings:ensure-folder'),
  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),

  // Recordings library.
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryOpen: (filePath) => ipcRenderer.invoke('library:open', filePath),
  onLibraryMeta: (callback) => replaceListener('library:meta', (event, meta) => callback(meta)),

  // Permissions preflight.
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: (type) => ipcRenderer.invoke('permissions:request', type),
  appRelaunch: () => ipcRenderer.invoke('app:relaunch'),

  // Dropbox link sharing.
  dropboxStatus: () => ipcRenderer.invoke('dropbox:status'),
  dropboxConnect: () => ipcRenderer.invoke('dropbox:connect'),
  dropboxDisconnect: () => ipcRenderer.invoke('dropbox:disconnect'),
  dropboxShare: (filePath) => ipcRenderer.invoke('dropbox:share', filePath),
  onDropboxProgress: (callback) => replaceListener('dropbox:progress', (event, p) => callback(p)),

  // Stream-to-disk recording: start -> chunk* -> finalize -> save (or abort).
  recordingStart: (meta) => ipcRenderer.invoke('recording:start', meta),
  recordingChunk: (recordingId, chunk) => ipcRenderer.invoke('recording:chunk', { recordingId, chunk }),
  recordingFinalize: (recordingId) => ipcRenderer.invoke('recording:finalize', recordingId),
  recordingAbort: (recordingId) => ipcRenderer.invoke('recording:abort', recordingId),
  recordingSave: (data) => ipcRenderer.invoke('recording:save', data),

  // Crash recovery.
  listRecoverable: () => ipcRenderer.invoke('recording:list-recoverable'),
  recoverRecording: (data) => ipcRenderer.invoke('recording:recover', data),
  discardRecording: (recordingId) => ipcRenderer.invoke('recording:discard', recordingId),

  // App lifecycle.
  onAppClosing: (callback) => replaceListener('app-closing', callback),
  confirmQuit: () => ipcRenderer.send('confirm-quit'),

  // MP4 conversion progress.
  onConversionStatus: (callback) => replaceListener('conversion-status', (event, status) => callback(status)),
  onConversionStart: (callback) => replaceListener('conversion-start', callback),
  onConversionProgress: (callback) => replaceListener('conversion-progress', (event, progress) => callback(progress)),
  onConversionComplete: (callback) => replaceListener('conversion-complete', callback),

  platform: process.platform
});
