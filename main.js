const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, systemPreferences, screen, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { spawn, execFile } = require('child_process');
// In a packaged app the binary is extracted next to the asar (asarUnpack);
// the module still reports the in-archive path, which cannot be executed.
const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const RecordingWriter = require('./recording-writer');
const SettingsStore = require('./settings-store');
const LibraryStore = require('./library-store');
const DropboxShare = require('./dropbox-share');

let mainWindow;
let isQuitting = false;
let recordingWriter; // stream-to-disk writer, constructed once app paths are available

const activeChildProcesses = new Set(); // Track FFmpeg processes for cleanup

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
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      safeSend(mainWindow, 'app-closing');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
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
  camX: 70, camY: 64, camW: 0.2,
  micOn: true,
  micDeviceId: '',
  countdownOn: true,
  hwEncode: false,
  floatingOn: true,
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

ipcMain.handle('settings:get', () => {
  const settings = settingsStore.get();
  return { ...settings, folderDisplay: displayFolder(settings.folder) };
});

ipcMain.handle('settings:set', (event, patch) => {
  const settings = settingsStore.set(patch || {});
  return { ...settings, folderDisplay: displayFolder(settings.folder) };
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

// --- recordings library ---

let libraryStore = null;

ipcMain.handle('library:list', async () => {
  const folder = settingsStore.get().folder;
  return libraryStore.list(folder, (meta) => safeSend(mainWindow, 'library:meta', meta));
});

ipcMain.handle('library:open', (event, filePath) => {
  if (typeof filePath === 'string' && filePath) shell.openPath(filePath);
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
    try {
      const native = require(app.isPackaged
        ? path.join(process.resourcesPath, 'screen_prompt.node')
        : path.join(__dirname, 'build', 'Release', 'screen_prompt.node'));
      native.triggerScreenCapturePrompt();
    } catch { /* addon missing in dev until `npm run build:native` */ }
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

  dropboxShare = new DropboxShare({
    settings: settingsStore,
    openExternal: (url) => shell.openExternal(url),
  });

  if (process.platform === 'darwin') {
    const status = await systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      console.log('Screen recording permission not granted');
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
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

ipcMain.handle('show-save-dialog', async (event, options) => {
  try {
    const defaultPath = options.defaultPath || `recording_${Date.now()}.mp4`;
    
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Recording',
      defaultPath: path.join(app.getPath('videos'), defaultPath.replace('.webm', '.mp4')),
      filters: [
        { name: 'MP4 Video', extensions: ['mp4'] },
        { name: 'WebM Video', extensions: ['webm'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    return {
      canceled: result.canceled,
      filePath: result.filePath
    };
  } catch (error) {
    console.error('Error showing save dialog:', error);
    throw error;
  }
});

async function validateWebMFile(inputPath) {
  try {
    // Check if file exists
    await fs.access(inputPath);
    
    // Check file size
    const stats = await fs.stat(inputPath);
    if (stats.size < 100) {
      return { valid: false, error: 'File is too small to be a valid WebM' };
    }
    
    // Check WebM/EBML header (first 4 bytes should be 0x1A45DFA3)
    const buffer = Buffer.alloc(4);
    const fd = await fs.open(inputPath, 'r');
    await fd.read(buffer, 0, 4, 0);
    await fd.close();
    
    const header = buffer.toString('hex');
    if (header !== '1a45dfa3') {
      return { valid: false, error: 'Invalid WebM header. File may be corrupted.' };
    }
    
    // Quick probe with ffmpeg to validate format
    return new Promise((resolve) => {
      const probeProcess = spawn(ffmpeg, [
        '-v', 'error',
        '-i', inputPath,
        '-f', 'null', '-'
      ]);
      
      let errorOutput = '';
      probeProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      
      probeProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ valid: true });
        } else {
          resolve({ valid: false, error: 'FFmpeg validation failed: ' + errorOutput.substring(0, 200) });
        }
      });
      
      probeProcess.on('error', () => {
        resolve({ valid: false, error: 'Failed to run FFmpeg validation' });
      });
    });
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

async function convertWebMToMP4(inputPath, outputPath, quality = 'balanced', expectedDurationSeconds = 0) {
  return new Promise(async (resolve, reject) => {
    // Validate WebM file before conversion
    const validation = await validateWebMFile(inputPath);
    if (!validation.valid) {
      reject(new Error(`WebM validation failed: ${validation.error}`));
      return;
    }
    
    // Set FFmpeg parameters based on quality selection
    let preset, crf, audioBitrate;
    
    switch (quality) {
      case 'fast':
        preset = 'ultrafast';
        crf = '18'; // Lower CRF = better quality, larger file
        audioBitrate = '128k'; // Keep current for speed
        break;
      case 'slow':
        preset = 'slow';
        crf = '26'; // Higher CRF = more compression, smaller file
        audioBitrate = '256k'; // High quality audio
        break;
      case 'balanced':
      default:
        preset = 'fast';
        crf = '22'; // Balanced quality/size
        audioBitrate = '192k'; // Improved audio quality
        break;
    }
    
    // First, get video duration for progress calculation
    let videoDuration = Number(expectedDurationSeconds) || 0;
    try {
      const probeProcess = spawn(ffmpeg, [
        '-i', inputPath,
        '-f', 'null', '-'
      ]);
      
      await new Promise((resolve, reject) => {
        let probeStderr = '';
        probeProcess.stderr.on('data', (data) => {
          probeStderr += data.toString();
        });
        
        probeProcess.on('close', () => {
          // Extract duration from FFmpeg output
          const durationMatch = probeStderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
          if (durationMatch) {
            const hours = parseInt(durationMatch[1]);
            const minutes = parseInt(durationMatch[2]);
            const seconds = parseFloat(durationMatch[3]);
            videoDuration = hours * 3600 + minutes * 60 + seconds;
          }
          resolve();
        });
        
        probeProcess.on('error', reject);
      });
    } catch (probeError) {
      console.warn('Could not determine video duration:', probeError);
      // Continue without duration info
    }
    
    console.log('Starting FFmpeg conversion with:', {
      ffmpegPath: ffmpeg,
      inputPath,
      outputPath,
      preset,
      crf,
      audioBitrate
    });
    
    const ffmpegProcess = spawn(ffmpeg, [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-level', '3.0',
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
      '-y',
      outputPath
    ]);
    activeChildProcesses.add(ffmpegProcess);
    ffmpegProcess.on('exit', () => activeChildProcesses.delete(ffmpegProcess));

    let stderr = '';
    let stdoutProgress = '';
    let lastProgress = 0;
    let progressTimeout;
    let settled = false;

    const parseTimestampSeconds = (value) => {
      const match = String(value || '').match(/(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (!match) return null;
      return (parseInt(match[1]) * 3600) + (parseInt(match[2]) * 60) + parseFloat(match[3]);
    };

    const updateProgress = (currentTime) => {
      if (!videoDuration || !Number.isFinite(currentTime)) return;
      const progress = Math.min(Math.max((currentTime / videoDuration) * 100, 0), 100);
      if (progress < lastProgress && lastProgress < 99) return;
      lastProgress = progress;
      safeSend(mainWindow, 'conversion-progress', {
        progress: Math.round(progress),
        currentTime,
        totalTime: videoDuration
      });
    };

    const safeReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(conversionTimeout);
      if (progressTimeout) clearTimeout(progressTimeout);
      reject(error);
    };

    const safeResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(conversionTimeout);
      if (progressTimeout) clearTimeout(progressTimeout);
      resolve();
    };

    // Set a timeout for the conversion process (5 minutes)
    const conversionTimeout = setTimeout(() => {
      ffmpegProcess.kill('SIGKILL');
      safeReject(new Error('Video conversion is taking longer than expected. This might be due to a large file size or system resources. Try using the "Fast" conversion option or save as WebM format instead.'));
    }, 5 * 60 * 1000);
    
    // Handle progress output from stdout
    ffmpegProcess.stdout.on('data', (data) => {
      stdoutProgress += data.toString();

      const lines = stdoutProgress.split(/\r?\n/);
      stdoutProgress = lines.pop() || '';
      for (const line of lines) {
        const usMatch = line.match(/^out_time_(?:ms|us)=(\d+)/);
        if (usMatch) {
          updateProgress(parseInt(usMatch[1]) / 1000000);
          continue;
        }
        const timeMatch = line.match(/^out_time=(.+)$/);
        if (timeMatch) {
          updateProgress(parseTimestampSeconds(timeMatch[1]));
        }
      }
      
      // Reset progress timeout on any output
      if (progressTimeout) clearTimeout(progressTimeout);
      progressTimeout = setTimeout(() => {
        ffmpegProcess.kill('SIGKILL');
        safeReject(new Error('Video conversion has stopped responding. This may be due to system resources or file corruption. Try restarting the app or using a different quality setting.'));
      }, 60000); // 60 seconds without progress
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.log('FFmpeg stderr:', chunk);
      const timeMatch = chunk.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
      if (timeMatch) updateProgress(parseTimestampSeconds(timeMatch[1]));
      // Reset progress timeout on any output
      if (progressTimeout) clearTimeout(progressTimeout);
      progressTimeout = setTimeout(() => {
        ffmpegProcess.kill('SIGKILL');
        safeReject(new Error('Video conversion has stopped responding. This may be due to system resources or file corruption. Try restarting the app or using a different quality setting.'));
      }, 60000); // 60 seconds without progress
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        safeSend(mainWindow, 'conversion-progress', {
          progress: 100,
          currentTime: videoDuration || 0,
          totalTime: videoDuration || 0
        });
        safeResolve();
      } else if (code !== null) {
        const userError = stderr.includes('No such file')
          ? 'The video file could not be found. It may have been moved or deleted.'
          : stderr.includes('Permission denied')
          ? 'Unable to access the file location. Please check folder permissions and try saving to a different location.'
          : stderr.includes('No space left')
          ? 'Not enough disk space available. Please free up space and try again.'
          : 'Video conversion failed due to an unexpected error. Try using a different quality setting or save as WebM format instead.';

        safeReject(new Error(userError));
      }
    });

    ffmpegProcess.on('error', (error) => {
      let userError = '';
      if (error.code === 'ENOENT') {
        userError = 'Video conversion tool not found. Please restart the application or reinstall to fix this issue.';
      } else if (error.code === 'EACCES') {
        userError = 'Permission denied while converting video. Please check file permissions and try saving to a different location.';
      } else if (error.message.includes('spawn')) {
        userError = 'Unable to start video conversion. Try restarting the application or saving as WebM format instead.';
      } else {
        userError = 'Video conversion failed due to a system error. Try using a different quality setting or save as WebM format.';
      }

      safeReject(new Error(userError));
    });
  });
}

// --- Stream-to-disk recording IPC -------------------------------------------
// One MediaRecorder in the renderer streams its timeslice chunks here; they are
// appended in order to a single file. start -> chunk* -> finalize -> save.

ipcMain.handle('recording:start', async (event, { recordingId, mimeType, suggestedName }) => {
  const id = sanitizeRecordingId(recordingId);
  await recordingWriter.start({ recordingId: id, mimeType, suggestedName });
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

// Move the finalized recording to the user's chosen path. `convert` is set by
// the renderer when a WebM recording is being saved as MP4 (a direct-H.264
// recording saved as .mp4 needs no conversion). Falls back to raw WebM on
// conversion failure. Reuses convertWebMToMP4.
ipcMain.handle('recording:save', async (event, { recordingId, destPath, convert, quality, durationSeconds }) => {
  const id = sanitizeRecordingId(recordingId);
  const tempPath = recordingWriter.filePathFor(id);

  try {
    await fs.access(tempPath);
  } catch {
    throw new Error('Recording file not found. It may have already been saved or discarded.');
  }

  if (convert) {
    const qualityText = {
      fast: 'Fast conversion...',
      slow: 'High compression conversion (this may take a while)...',
      balanced: 'Converting to MP4...'
    }[quality || 'balanced'];
    safeSend(mainWindow, 'conversion-status', qualityText);
    safeSend(mainWindow, 'conversion-start');

    try {
      await convertWebMToMP4(tempPath, destPath, quality, durationSeconds);
      safeSend(mainWindow, 'conversion-complete');
      safeSend(mainWindow, 'conversion-status', 'Conversion complete!');
      await recordingWriter.discard(id);
      return { success: true, filePath: destPath };
    } catch (conversionError) {
      console.error('Conversion failed, saving as WebM:', conversionError);
      const webmPath = destPath.replace(/\.mp4$/, '.webm');
      await fs.copyFile(tempPath, webmPath);
      await recordingWriter.discard(id);
      safeSend(mainWindow, 'conversion-complete');
      safeSend(mainWindow, 'conversion-status', '');
      return { success: true, filePath: webmPath, conversionFailed: true, error: conversionError.message };
    }
  }

  // Direct WebM save: remux so the container carries duration/cues (MediaRecorder
  // streams lack them, which breaks seeking and duration display). Falls back to
  // a plain move if the remux fails.
  try {
    await remuxToWebM(tempPath, destPath);
  } catch (remuxError) {
    console.error('Save remux failed, moving raw file:', remuxError);
    try {
      await fs.rename(tempPath, destPath);
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fs.copyFile(tempPath, destPath); // cross-volume: copy then remove
      } else {
        throw err;
      }
    }
  }
  await recordingWriter.discard(id);
  return { success: true, filePath: destPath };
});

// --- Crash recovery ----------------------------------------------------------
// A recording interrupted by a crash leaves a valid-but-unfinalized WebM plus a
// sidecar. We repair the container with a remux pass (rewrites duration/cues so
// it seeks correctly) before saving it where the user wants.

function remuxToWebM(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-y', '-i', inputPath, '-c', 'copy', outputPath]);
    activeChildProcesses.add(proc);
    let stderr = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeChildProcesses.delete(proc);
      err ? reject(err) : resolve();
    };
    const timeout = setTimeout(() => { proc.kill('SIGKILL'); finish(new Error('Remux timed out')); }, 5 * 60 * 1000);
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
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

ipcMain.handle('recording:recover', async (event, { recordingId, destPath, convert, quality }) => {
  const id = sanitizeRecordingId(recordingId);
  const srcPath = recordingWriter.filePathFor(id);
  try {
    await fs.access(srcPath);
  } catch {
    throw new Error('Recovery file not found. It may have already been recovered or discarded.');
  }

  if (convert) {
    safeSend(mainWindow, 'conversion-status', 'Recovering and converting to MP4...');
    safeSend(mainWindow, 'conversion-start');
    try {
      await convertWebMToMP4(srcPath, destPath, quality);
      safeSend(mainWindow, 'conversion-complete');
      safeSend(mainWindow, 'conversion-status', 'Recovery complete!');
      await recordingWriter.discard(id);
      return { success: true, filePath: destPath };
    } catch (conversionError) {
      console.error('Recovery conversion failed, repairing as WebM:', conversionError);
      const webmPath = destPath.replace(/\.mp4$/, '.webm');
      try { await remuxToWebM(srcPath, webmPath); } catch { await fs.copyFile(srcPath, webmPath); }
      safeSend(mainWindow, 'conversion-complete');
      safeSend(mainWindow, 'conversion-status', '');
      await recordingWriter.discard(id);
      return { success: true, filePath: webmPath, conversionFailed: true };
    }
  }

  // WebM: repair the container so duration/seeking are correct after a crash.
  try {
    await remuxToWebM(srcPath, destPath);
  } catch (remuxError) {
    console.error('Remux failed, copying raw file:', remuxError);
    await fs.copyFile(srcPath, destPath);
  }
  await recordingWriter.discard(id);
  return { success: true, filePath: destPath };
});

ipcMain.on('confirm-quit', () => {
  isQuitting = true;
  app.quit();
});

// Sanitize recordingId to prevent path traversal
function sanitizeRecordingId(id) {
  if (!id || typeof id !== 'string') return 'unknown';
  return path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}
