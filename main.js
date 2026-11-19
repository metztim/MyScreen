const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, systemPreferences, shell, Menu, Tray, globalShortcut, nativeImage, screen } = require('electron');
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const fs = fsSync.promises;
const { spawn } = require('child_process');
// In a packaged app the binary is extracted next to the asar (asarUnpack);
// the module still reports the in-archive path, which cannot be executed.
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const RecordingWriter = require('./recording-writer');
const SettingsStore = require('./settings-store');
const LibraryStore = require('./library-store');
const DropboxShare = require('./dropbox-share');
const { RecordingControls } = require('./tray-controls');
const { CameraBubble } = require('./camera-bubble');
const AgentFiles = require('./agent-files');
const { SpeechModel } = require('./model-download');

let mainWindow;
let isQuitting = false;
let recordingWriter; // stream-to-disk writer, constructed once app paths are available
let recordingControls = null; // menu bar item + global shortcuts + window hiding
let agentFiles = null;        // transcript + key frames per recording, for coding agents
let speechModel = null;       // the downloadable model the transcripts need

const activeChildProcesses = new Set(); // Track FFmpeg processes for cleanup
const activePartFiles = new Set();      // Half-written outputs to remove if we quit mid-save

// Development runs keep their own profile, so they never touch the installed
// app's settings or unsaved recordings and can run beside it. An explicit
// --user-data-dir (test harness) still wins.
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'myscreen-v2-dev'));
}

// Two instances would share userData: the second one would see the first
// one's live recording as an orphan and could discard it. Allow only one.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// Safe IPC send wrapper to prevent sending to destroyed windows
function safeSend(window, channel, ...args) {
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send(channel, ...args);
      return true;
    } catch (error) {
      console.error(`Failed to send ${channel} to window:`, error);
      return false;
    }
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1140,
    minHeight: 740,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The camera-overlay draw loop must keep running while the window is
      // occluded or minimized, or composited recordings freeze.
      backgroundThrottling: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Started by macOS at login: stay in the menu bar until asked for.
    if (app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin) return;
    mainWindow.show();
  });

  // Closing the window keeps MyScreen in the menu bar, where a recording can
  // be started (or one in progress stopped). Quitting is Cmd+Q or the menu.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (!quitRequested) mainWindow.hide();
  });

  // A window nobody can see (closed to the menu bar, minimized, or on macOS
  // fully covered by other windows) must not keep the screen or camera open
  // for its preview; the renderer drops and restores them on these.
  for (const gone of ['hide', 'minimize']) mainWindow.on(gone, () => { safeSend(mainWindow, 'window:visibility', false); if (cameraBubble) cameraBubble.refresh(); });
  for (const back of ['show', 'restore']) mainWindow.on(back, () => { safeSend(mainWindow, 'window:visibility', true); if (cameraBubble) cameraBubble.refresh(); });

  // A reload or a renderer crash ends whatever recording that renderer was
  // feeding. Close those files so they show up as recoverable right away.
  mainWindow.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { releaseOpenRecordings(); if (cameraBubble) cameraBubble.sync(null); }
  });
  mainWindow.webContents.on('render-process-gone', async (event, details) => {
    console.error('Renderer process gone:', details && details.reason);
    await releaseOpenRecordings();
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });

  mainWindow.on('closed', () => {
    if (cameraBubble) cameraBubble.dispose();
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

const CLOSE_FALLBACK_MS = 6000; // the renderer allows itself 4s to finalize
let closeFallbackTimer = null;
let quitRequested = false;

// Quit with a recording still open: the renderer stops and finalizes it,
// then answers with 'confirm-quit'. If it cannot answer (crashed or hung),
// quit anyway instead of hanging.
function requestQuit() {
  if (isQuitting || quitRequested) return;
  quitRequested = true;
  const asked = safeSend(mainWindow, 'app-closing');
  clearTimeout(closeFallbackTimer);
  closeFallbackTimer = setTimeout(forceQuit, asked ? CLOSE_FALLBACK_MS : 0);
}

async function releaseOpenRecordings() {
  if (!recordingWriter) return;
  try {
    await recordingWriter.releaseAll();
  } catch (err) {
    console.error('Could not release open recordings:', err);
  }
}

async function forceQuit() {
  if (isQuitting) return;
  await releaseOpenRecordings();
  isQuitting = true;
  app.quit();
}

function buildAppMenu() {
  const isDev = !app.isPackaged;
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Recordings Folder',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const folder = settingsStore.get().folder;
            await fs.mkdir(folder, { recursive: true }).catch(() => {});
            shell.openPath(folder);
          },
        },
        { type: 'separator' },
        { label: 'Start or Stop Recording', click: () => safeSend(mainWindow, 'controls:command', 'toggle') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    // Reload would cut off a recording in progress, so it exists in
    // development only.
    ...(isDev ? [{ label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] }] : []),
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'MyScreen on GitHub', click: () => shell.openExternal('https://github.com/metztim/MyScreen') },
        { label: 'Report an Issue', click: () => shell.openExternal('https://github.com/metztim/MyScreen/issues') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// User settings (recording config + camera overlay layout), persisted in userData.
const SETTINGS_DEFAULTS = {
  folder: path.join(os.homedir(), 'Movies', 'MyScreen'),
  format: 'mp4',            // mp4 | webm
  quality: 'balanced',      // fast | balanced | small (small maps to ffmpeg 'slow')
  camOn: false,
  camDeviceId: '',
  camMirror: true,
  camShape: 'rounded',      // rounded | circle
  bubbleOn: true,           // show the camera on the real screen (camera-bubble.js)
  camX: 82, camY: 74, camW: 0.15, // top-left corner in % of the video, width as a fraction of its width
  micOn: true,
  micDeviceId: '',
  countdownOn: true,
  floatingOn: true,
  // Controls outside the window (tray-controls.js).
  hideOnRecord: true,                    // hide the window while the full screen is recorded
  globalShortcutsOn: true,
  shortcutToggle: 'Control+Shift+R',     // start, or stop and save
  shortcutPause: 'Control+Shift+P',      // only registered while recording
  // After each save, write a transcript, key frames, and a summary next to
  // the recording for coding agents (agent-files.js, mcp-server.js).
  agentFilesOn: true,
  // Dropbox link sharing. The app key is a public PKCE client identifier
  // (no secret) for the "MyScreen Recorder" Dropbox app; safe to ship.
  shareLink: false,
  dropboxAppKey: 'xyrkvu2ktrava1c',
  dropboxAuth: null,
  dropboxAccount: '',
};
let settingsStore = null;

function displayFolder(folder) {
  const home = os.homedir();
  return folder.startsWith(home) ? '~' + folder.slice(home.length) : folder;
}

// What the renderer sees: everything except the Dropbox tokens, which only
// the main process uses.
function rendererSettings(settings) {
  const { dropboxAuth, ...rest } = settings;
  return { ...rest, folderDisplay: displayFolder(settings.folder) };
}

const MAIN_ONLY_SETTINGS = ['dropboxAuth', 'dropboxAccount', 'dropboxAppKey'];

ipcMain.handle('settings:get', () => rendererSettings(settingsStore.get()));

ipcMain.handle('settings:set', (event, patch) => {
  const clean = { ...(patch || {}) };
  for (const key of MAIN_ONLY_SETTINGS) delete clean[key];
  const settings = settingsStore.set(clean);
  if (recordingControls) recordingControls.applySettings();
  return rendererSettings(settings);
});

// The renderer reports where the recording stands after every change; the
// menu bar item, shortcuts, and window visibility follow.
ipcMain.on('recording:status', (event, status) => {
  if (recordingControls && status && typeof status === 'object') recordingControls.update(status);
});

// Make sure the configured save folder exists; returns its absolute path.
ipcMain.handle('settings:ensure-folder', async () => {
  const folder = settingsStore.get().folder;
  await fs.mkdir(folder, { recursive: true });
  return folder;
});

ipcMain.handle('reveal-in-finder', (event, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
});

ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settingsStore.get().folder,
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = result.filePaths[0];
  settingsStore.set({ folder });
  return { folder, folderDisplay: displayFolder(folder) };
});

// --- camera on the real screen (camera-bubble.js) ---

// The native addon: the screen-recording prompt and window positions. Missing
// in a checkout until `npm run build:native`.
let nativeModule;
function nativeAddon() {
  if (nativeModule === undefined) {
    try {
      nativeModule = require(app.isPackaged
        ? path.join(process.resourcesPath, 'screen_prompt.node')
        : path.join(__dirname, 'build', 'Release', 'screen_prompt.node'));
    } catch {
      nativeModule = null;
    }
  }
  return nativeModule;
}

let cameraBubble = null;
function getCameraBubble() {
  if (!cameraBubble) {
    cameraBubble = new CameraBubble({
      BrowserWindow, screen,
      htmlPath: path.join(__dirname, 'camera-bubble.html'),
      preloadPath: path.join(__dirname, 'camera-bubble-preload.js'),
      windowBounds: (id) => {
        const native = nativeAddon();
        return native && native.windowBounds ? native.windowBounds(id) : null;
      },
      mainWindowOpen: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
      onMoved: (position) => safeSend(mainWindow, 'camera-bubble:moved', position),
    });
  }
  return cameraBubble;
}

ipcMain.handle('camera-bubble:sync', (event, request) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return { shown: false, inPicture: false };
  return getCameraBubble().sync(request);
});

ipcMain.on('camera-bubble:drag', (event, report) => {
  if (!cameraBubble || !cameraBubble.win || cameraBubble.win.isDestroyed()) return;
  if (event.sender !== cameraBubble.win.webContents) return;
  cameraBubble.drag(report);
});

// --- recordings library ---

let libraryStore = null;

ipcMain.handle('library:list', async () => {
  const folder = settingsStore.get().folder;
  const entries = await libraryStore.list(folder, (meta) => safeSend(mainWindow, 'library:meta', meta));
  // Title and description a coding agent saved for the recording.
  return Promise.all(entries.map(async (entry) => {
    const notes = await agentFiles.readNotes(entry.path);
    return notes ? { ...entry, title: notes.title, description: notes.description } : entry;
  }));
});

ipcMain.handle('library:open', (event, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.openPath(filePath);
});

// Move a recording to the Trash, with the files made for agents. Only video
// files directly inside the recordings folder qualify.
ipcMain.handle('library:trash', async (event, filePath) => {
  const folder = path.resolve(settingsStore.get().folder);
  const target = typeof filePath === 'string' ? path.resolve(filePath) : '';
  if (!target || path.dirname(target) !== folder || !/\.(mp4|webm)$/i.test(target) || path.basename(target).startsWith('.')) {
    throw new Error('That file is not a recording in the recordings folder.');
  }
  await shell.trashItem(target);
  try { await shell.trashItem(agentFiles.dirFor(target)); } catch { /* no agent files for this one */ }
  try { await shell.trashItem(agentFiles.notesPathFor(target)); } catch { /* no title saved */ }
  return true;
});

// Thumbnail + duration for one file (the Saved sheet shows the new recording).
ipcMain.handle('library:meta-for', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  try {
    return await libraryStore.metaFor(filePath);
  } catch {
    return null;
  }
});

// --- agent files + MCP server ---

// Prepare the agent files for a saved recording in the background and tell
// the renderer how it went. Never blocks or fails the save.
function queueAgentFiles(filePath, context, { force = false } = {}) {
  if (!agentFiles || !(force || settingsStore.get().agentFilesOn)) return;
  safeSend(mainWindow, 'agent:status', { path: filePath, state: 'working' });
  agentFiles.ensure(filePath, context).then((manifest) => {
    safeSend(mainWindow, 'agent:status', {
      path: filePath, state: 'ready',
      summaryPath: agentFiles.summaryPathFor(filePath),
      transcript: manifest.transcript.status,
      frames: manifest.frames.length,
    });
  }).catch((err) => {
    console.error('Agent files failed:', err);
    safeSend(mainWindow, 'agent:status', { path: filePath, state: 'failed', detail: err.message });
  });
}

// What was being recorded, from the sidecar written at start.
async function readRecordingContext(recordingId) {
  try {
    const meta = JSON.parse(await fs.readFile(recordingWriter.sidecarPathFor(recordingId), 'utf-8'));
    return meta.context || null;
  } catch {
    return null;
  }
}

// The command an agent uses to start the MCP server: this app's own binary
// in Node mode running mcp-server.js, so nothing else needs installing.
function mcpServerCommands() {
  const quote = (value) => `"${value}"`;
  // The script is unpacked from the archive (asarUnpack) so it runs as a plain file.
  const script = path.join(app.getAppPath().replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'), 'mcp-server.js');
  const parts = [quote(process.execPath), quote(script)];
  if (!app.isPackaged) parts.push('--user-data-dir', quote(app.getPath('userData')));
  const command = parts.join(' ');
  return {
    claude: `claude mcp add -s user myscreen -e ELECTRON_RUN_AS_NODE=1 -- ${command}`,
    codex: `codex mcp add myscreen --env ELECTRON_RUN_AS_NODE=1 -- ${command}`,
  };
}

ipcMain.handle('agent:info', async () => {
  const engine = await agentFiles.transcriber();
  return {
    transcripts: engine.available,   // engine and a model are both present
    engine: !!engine.binary,
    engineLabel: engine.label,
    model: await speechModel.status(),
    commands: mcpServerCommands(),
  };
});

// One-time download of the speech model. Progress goes to the renderer as
// 'model:progress' events; the call itself returns at once.
ipcMain.handle('model:download', () => {
  speechModel.start((event) => safeSend(mainWindow, 'model:progress', event));
  return { started: true };
});

ipcMain.handle('model:cancel', () => { speechModel.cancel(); });

// (Re)build the agent files for one recording, e.g. to add the transcript
// once a model has been downloaded.
ipcMain.handle('agent:ensure', (event, filePath) => {
  if (typeof filePath === 'string' && filePath) queueAgentFiles(filePath, null, { force: true });
});

// --- Dropbox link sharing ---

let dropboxShare = null;

ipcMain.handle('dropbox:status', () => dropboxShare.status());

ipcMain.handle('dropbox:connect', async () => dropboxShare.connect());

ipcMain.handle('dropbox:disconnect', () => { dropboxShare.disconnect(); return dropboxShare.status(); });

ipcMain.handle('dropbox:share', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('No file to share.');
  return dropboxShare.uploadAndShare(filePath, (percent) => {
    safeSend(mainWindow, 'dropbox:progress', { filePath, percent });
  });
});

// --- permissions preflight ---

ipcMain.handle('permissions:check', () => {
  if (process.platform !== 'darwin') {
    return { screen: 'granted', camera: 'granted', microphone: 'granted' };
  }
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  };
});

ipcMain.handle('permissions:request', async (event, type) => {
  if (process.platform !== 'darwin') return true;
  if (type === 'camera' || type === 'microphone') {
    // macOS only prompts once. After a "Don't Allow", the switch in System
    // Settings is the only way back, so take the user there.
    const status = systemPreferences.getMediaAccessStatus(type);
    if (status === 'denied' || status === 'restricted') {
      const pane = type === 'camera' ? 'Privacy_Camera' : 'Privacy_Microphone';
      shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
      return false;
    }
    return systemPreferences.askForMediaAccess(type);
  }
  if (type === 'screen') {
    // Chromium preflights screen capture and never triggers the macOS
    // authorization flow itself, so the app would neither prompt nor appear
    // in System Settings on its own. On macOS 13/14 an in-process
    // ScreenCaptureKit enumeration fires the classic prompt (see
    // native/screen-prompt.mm); on macOS 15+ tccd refuses to prompt
    // ("Service kTCCServiceScreenCapture does not allow prompting") and the
    // user must add the app via "+" in System Settings themselves - the
    // sheet's copy walks them through it. So: trigger SCK for the older
    // systems AND open the Settings pane for the new ones.
    const native = nativeAddon();
    if (native) native.triggerScreenCapturePrompt();
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return false; // granted state is picked up by the renderer's poll
  }
  return false;
});

// Screen Recording grants only apply to a fresh process; the permissions
// sheet offers this once the toggle flips.
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  // Stream-to-disk writer lives under userData so partial recordings survive crashes.
  recordingWriter = new RecordingWriter({
    baseDir: path.join(app.getPath('userData'), 'in-progress')
  });

  settingsStore = new SettingsStore(
    path.join(app.getPath('userData'), 'settings.json'),
    SETTINGS_DEFAULTS
  );
  // Settings files from the paste-in era persisted an empty app key, which
  // would shadow the built-in default. Let the default win.
  if (!settingsStore.get().dropboxAppKey) {
    settingsStore.set({ dropboxAppKey: SETTINGS_DEFAULTS.dropboxAppKey });
  }

  libraryStore = new LibraryStore({
    ffmpegPath: ffmpeg,
    cacheDir: path.join(app.getPath('userData'), 'thumbnails'),
  });

  agentFiles = new AgentFiles({
    ffmpegPath: ffmpeg,
    modelDirs: AgentFiles.defaultModelDirs(app.getPath('userData')),
  });
  speechModel = new SpeechModel({ dir: path.join(app.getPath('userData'), 'models') });

  dropboxShare = new DropboxShare({
    settings: settingsStore,
    openExternal: (url) => shell.openExternal(url),
  });

  buildAppMenu();
  createWindow();

  const trayIcon = (name) => nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`));
  recordingControls = new RecordingControls({
    Tray, Menu, globalShortcut,
    icons: { idle: trayIcon('trayTemplate'), recording: trayIcon('trayRecording') },
    getWindow: () => mainWindow,
    getSettings: () => settingsStore.get(),
    sendCommand: (command) => safeSend(mainWindow, 'controls:command', command),
    quit: () => app.quit(),
    focusApp: () => app.focus({ steal: true }),
    openRecordingsFolder: async () => {
      const folder = settingsStore.get().folder;
      await fs.mkdir(folder, { recursive: true }).catch(() => {});
      shell.openPath(folder);
    },
    // Registering a login item only makes sense for the installed app.
    loginItem: {
      available: app.isPackaged,
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }),
    },
  });
  recordingControls.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (recordingControls) {
      recordingControls.showWindow(); // Dock click brings a hidden window back
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  // Quit with a recording still open: let the renderer stop and finalize it first.
  if (!isQuitting && recordingWriter && recordingWriter.active.size > 0 && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    requestQuit();
    return;
  }
  isQuitting = true;
  // Kill any active FFmpeg processes to prevent orphans
  for (const proc of activeChildProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch (e) {
      // Process may have already exited
    }
  }
  activeChildProcesses.clear();
  for (const partPath of activePartFiles) {
    try { fsSync.rmSync(partPath, { force: true }); } catch { /* best effort */ }
  }
  activePartFiles.clear();
  if (recordingControls) recordingControls.dispose();
  if (speechModel) speechModel.cancel(); // the part file stays; the next attempt resumes
});

ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true
    });

    return sources.map(source => {
      // Generate a proper data URL with error handling
      let thumbnailDataUrl = '';
      try {
        if (source.thumbnail && !source.thumbnail.isEmpty()) {
          thumbnailDataUrl = source.thumbnail.toDataURL();
        }
      } catch (err) {
        console.warn(`Failed to generate thumbnail for ${source.name}:`, err);
      }
      
      // appIcon can be an EMPTY NativeImage; toDataURL() on it produces a
      // truthy-but-invalid data URL that renders as a broken image.
      let appIconDataUrl = null;
      try {
        if (source.appIcon && !source.appIcon.isEmpty()) {
          appIconDataUrl = source.appIcon.toDataURL();
        }
      } catch { /* fall back to the letter tile */ }

      return {
        id: source.id,
        name: source.name,
        thumbnail: thumbnailDataUrl,
        display_id: source.display_id,
        appIcon: appIconDataUrl
      };
    });
  } catch (error) {
    console.error('Error getting sources:', error);
    throw error;
  }
});

// Cheap sanity check before handing a recording to ffmpeg: the file exists,
// is not trivially small, and starts with the EBML magic every WebM has.
async function looksLikeWebM(inputPath) {
  const stats = await fs.stat(inputPath);
  if (stats.size < 100) return false;
  const fd = await fs.open(inputPath, 'r');
  try {
    const buffer = Buffer.alloc(4);
    await fd.read(buffer, 0, 4, 0);
    return buffer.toString('hex') === '1a45dfa3';
  } finally {
    await fd.close();
  }
}

// Outputs are written to a hidden sibling of the destination and renamed
// into place only when complete, so the save folder (and anything syncing
// it) never sees a half-written video.
function partPathFor(destPath) {
  const ext = path.extname(destPath);
  return path.join(path.dirname(destPath), `.${path.basename(destPath, ext)}.part${ext}`);
}

async function writeAtomically(destPath, produce) {
  const partPath = partPathFor(destPath);
  activePartFiles.add(partPath);
  try {
    await produce(partPath);
    await fs.rename(partPath, destPath);
  } catch (err) {
    await fs.rm(partPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    activePartFiles.delete(partPath);
  }
}

async function moveFile(fromPath, toPath) {
  try {
    await fs.rename(fromPath, toPath);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fs.copyFile(fromPath, toPath); // cross-volume: copy, the caller discards the source
  }
}

const QUALITY_PRESETS = {
  fast: { preset: 'ultrafast', crf: '18', audioBitrate: '128k' },     // quickest, larger file
  balanced: { preset: 'fast', crf: '22', audioBitrate: '192k' },
  slow: { preset: 'slow', crf: '26', audioBitrate: '256k' },          // slowest, smallest file
};

const FFMPEG_STALL_MS = 60 * 1000;

// Re-encode a WebM recording to H.264/AAC MP4. `durationSeconds` (when known)
// drives the progress events; the encode itself does not need it.
function convertWebMToMP4(inputPath, outputPath, quality = 'balanced', durationSeconds = 0) {
  return new Promise((resolve, reject) => {
    const { preset, crf, audioBitrate } = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;
    const videoDuration = Number(durationSeconds) || 0;

    const ffmpegProcess = spawn(ffmpeg, [
      '-i', inputPath,
      // High profile with the level left to the encoder: it picks the one
      // that matches the frame size (Retina captures need 5.x).
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-preset', preset,
      '-crf', crf,
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-profile:a', 'aac_low',
      '-ar', '44100',
      '-ac', '2',
      '-movflags', '+faststart',
      // Chrome MediaRecorder WebM often reports a 1k tbr. Without VFR mode,
      // FFmpeg duplicates frames into a 1000 fps MP4, which QuickTime plays
      // with broken timing.
      '-fps_mode:v', 'vfr',
      '-progress', 'pipe:1',
      '-f', 'mp4',
      '-y',
      outputPath
    ]);
    activeChildProcesses.add(ffmpegProcess);

    let stderr = '';
    let stdoutProgress = '';
    let lastProgress = 0;
    let stallTimer = null;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      activeChildProcesses.delete(ffmpegProcess);
      error ? reject(error) : resolve();
    };

    // No cap on total time (an hour-long recording legitimately takes a
    // while); only a process that stops producing output is killed.
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        ffmpegProcess.kill('SIGKILL');
        finish(new Error('Video conversion stopped responding.'));
      }, FFMPEG_STALL_MS);
    };
    armStallTimer();

    const updateProgress = (currentTime) => {
      if (!videoDuration || !Number.isFinite(currentTime)) return;
      const progress = Math.min(Math.max((currentTime / videoDuration) * 100, 0), 99);
      if (progress < lastProgress) return;
      lastProgress = progress;
      safeSend(mainWindow, 'conversion-progress', {
        progress: Math.round(progress),
        currentTime,
        totalTime: videoDuration
      });
    };

    ffmpegProcess.stdout.on('data', (data) => {
      armStallTimer();
      stdoutProgress += data.toString();
      const lines = stdoutProgress.split(/\r?\n/);
      stdoutProgress = lines.pop() || '';
      for (const line of lines) {
        const usMatch = line.match(/^out_time_(?:ms|us)=(\d+)/);
        if (usMatch) updateProgress(parseInt(usMatch[1], 10) / 1000000);
      }
    });

    ffmpegProcess.stderr.on('data', (data) => {
      armStallTimer();
      stderr = (stderr + data.toString()).slice(-4000); // keep the tail only
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        safeSend(mainWindow, 'conversion-progress', {
          progress: 100,
          currentTime: videoDuration,
          totalTime: videoDuration
        });
        finish();
        return;
      }
      const reason = stderr.includes('No space left')
        ? 'Not enough disk space to convert the recording.'
        : stderr.includes('Permission denied')
          ? 'MyScreen is not allowed to write to the save folder.'
          : `Video conversion failed (${code === null ? 'interrupted' : 'exit ' + code}).`;
      console.error('FFmpeg conversion failed:', stderr.slice(-600));
      finish(new Error(reason));
    });

    ffmpegProcess.on('error', (error) => {
      finish(new Error(error.code === 'ENOENT'
        ? 'The bundled video converter is missing. Reinstalling MyScreen fixes this.'
        : `Could not start video conversion: ${error.message}`));
    });
  });
}

// Shared by a normal save and by crash recovery: turn the raw recording at
// `srcPath` into the file the user asked for at `destPath`. Each step falls
// back to a simpler one, so a recording is never lost to a failed
// conversion: video copy -> MP4 encode -> repaired WebM -> the raw file as
// recorded. `copyVideo` is for H.264 recordings: the picture is copied into
// the MP4 untouched and only the audio is converted, which takes moments.
async function exportRecording({ srcPath, destPath, convert, copyVideo, quality, durationSeconds, statusText }) {
  if (copyVideo) {
    try {
      await writeAtomically(destPath, (partPath) => remuxContainer(srcPath, partPath, { audioCodec: 'aac' }));
      return { filePath: destPath };
    } catch (err) {
      console.error('Video copy failed, re-encoding instead:', err);
      convert = true;
    }
  }

  if (convert) {
    safeSend(mainWindow, 'conversion-status', statusText || 'Converting to MP4...');
    safeSend(mainWindow, 'conversion-start');
    let conversionError = null;
    try {
      if (!(await looksLikeWebM(srcPath))) throw new Error('The recording is not a valid WebM file.');
      await writeAtomically(destPath, (partPath) => convertWebMToMP4(srcPath, partPath, quality, durationSeconds));
    } catch (err) {
      conversionError = err;
      console.error('Conversion failed, keeping the recording as WebM:', err);
    }
    safeSend(mainWindow, 'conversion-complete');
    safeSend(mainWindow, 'conversion-status', '');
    if (!conversionError) return { filePath: destPath };

    const webmPath = destPath.replace(/\.mp4$/, '.webm');
    await exportContainerCopy(srcPath, webmPath);
    return { filePath: webmPath, conversionFailed: true, error: conversionError.message };
  }

  await exportContainerCopy(srcPath, destPath);
  return { filePath: destPath };
}

// Stream-copy into a fresh container so it carries duration and cues
// (MediaRecorder output has neither, which breaks seeking). If even that
// fails, keep the raw file: an unseekable recording beats no recording.
async function exportContainerCopy(srcPath, destPath) {
  try {
    await writeAtomically(destPath, (partPath) => remuxContainer(srcPath, partPath));
  } catch (remuxError) {
    console.error('Remux failed, keeping the raw file:', remuxError);
    await writeAtomically(destPath, (partPath) => fs.copyFile(srcPath, partPath));
  }
}

// --- Stream-to-disk recording IPC -------------------------------------------
// One MediaRecorder in the renderer streams its timeslice chunks here; they are
// appended in order to a single file. start -> chunk* -> finalize -> save.

ipcMain.handle('recording:start', async (event, { recordingId, mimeType, suggestedName, context }) => {
  const id = sanitizeRecordingId(recordingId);
  await recordingWriter.start({ recordingId: id, mimeType, suggestedName, context });
  return { success: true, recordingId: id };
});

ipcMain.handle('recording:chunk', async (event, { recordingId, chunk }) => {
  const id = sanitizeRecordingId(recordingId);
  const bytesWritten = await recordingWriter.write(id, Buffer.from(chunk));
  return { success: true, bytesWritten };
});

ipcMain.handle('recording:finalize', async (event, recordingId) => {
  const id = sanitizeRecordingId(recordingId);
  const result = await recordingWriter.finalize(id);
  return { success: true, ...result };
});

ipcMain.handle('recording:abort', async (event, recordingId) => {
  const id = sanitizeRecordingId(recordingId);
  await recordingWriter.abort(id);
  return { success: true };
});

// Export the finalized recording to the user's save folder. `convert` is set
// by the renderer when a WebM recording is being saved as MP4 (a direct-H.264
// recording saved as .mp4 only needs a container copy).
ipcMain.handle('recording:save', async (event, { recordingId, destPath, convert, copyVideo, quality, durationSeconds }) => {
  const id = sanitizeRecordingId(recordingId);
  const srcPath = recordingWriter.filePathFor(id);

  try {
    await fs.access(srcPath);
  } catch {
    throw new Error('Recording file not found. It may have already been saved or discarded.');
  }

  const context = await readRecordingContext(id);
  const result = await exportRecording({ srcPath, destPath, convert, copyVideo, quality, durationSeconds });
  await recordingWriter.discard(id);
  queueAgentFiles(result.filePath, context);
  return { success: true, ...result };
});

// --- Crash recovery ----------------------------------------------------------
// A recording interrupted by a crash leaves a valid-but-unfinalized WebM plus a
// sidecar. We repair the container with a remux pass (rewrites duration/cues so
// it seeks correctly) before saving it where the user wants.

// Stream-copy into a fresh container. `audioCodec` converts just the audio
// (Opus from the recorder becomes AAC, which every MP4 player handles).
function remuxContainer(inputPath, outputPath, { audioCodec } = {}) {
  return new Promise((resolve, reject) => {
    const format = path.extname(outputPath).toLowerCase() === '.mp4' ? 'mp4' : 'webm';
    const args = ['-y', '-i', inputPath, '-c', 'copy'];
    if (audioCodec) args.push('-c:a', audioCodec, '-b:a', '192k');
    if (format === 'mp4') args.push('-movflags', '+faststart');
    args.push('-f', format, outputPath);
    const proc = spawn(ffmpeg, args);
    activeChildProcesses.add(proc);
    let stderr = '';
    let settled = false;
    let stallTimer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      activeChildProcesses.delete(proc);
      err ? reject(err) : resolve();
    };
    const armStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { proc.kill('SIGKILL'); finish(new Error('Remux stopped responding')); }, FFMPEG_STALL_MS);
    };
    armStallTimer();
    proc.stderr.on('data', (d) => { armStallTimer(); stderr = (stderr + d.toString()).slice(-2000); });
    proc.on('close', (code) => finish(code === 0 ? null : new Error(`Remux failed: ${stderr.slice(-200)}`)));
    proc.on('error', (e) => finish(e));
  });
}

ipcMain.handle('recording:list-recoverable', async () => {
  return await recordingWriter.listOrphans();
});

ipcMain.handle('recording:discard', async (event, recordingId) => {
  await recordingWriter.discard(sanitizeRecordingId(recordingId));
  return { success: true };
});

ipcMain.handle('recording:recover', async (event, { recordingId, destPath, convert, copyVideo, quality }) => {
  const id = sanitizeRecordingId(recordingId);
  const srcPath = recordingWriter.filePathFor(id);
  let stat;
  try {
    stat = await fs.stat(srcPath);
  } catch {
    throw new Error('Recovery file not found. It may have already been recovered or discarded.');
  }

  // No recorded duration survives a crash. The span between the start time
  // in the sidecar and the last write is close enough for a progress bar.
  let durationSeconds = 0;
  try {
    const meta = JSON.parse(await fs.readFile(recordingWriter.sidecarPathFor(id), 'utf-8'));
    if (meta.startedAt) durationSeconds = Math.max(0, (stat.mtimeMs - meta.startedAt) / 1000);
  } catch { /* progress stays indeterminate */ }

  const result = await exportRecording({
    srcPath, destPath, convert, copyVideo, quality, durationSeconds,
    statusText: 'Recovering and converting to MP4...',
  });
  const context = await readRecordingContext(id);
  await recordingWriter.discard(id);
  queueAgentFiles(result.filePath, context);
  return { success: true, ...result };
});

ipcMain.on('confirm-quit', () => {
  clearTimeout(closeFallbackTimer);
  isQuitting = true;
  app.quit();
});

// Sanitize recordingId to prevent path traversal
function sanitizeRecordingId(id) {
  if (!id || typeof id !== 'string') return 'unknown';
  return path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
