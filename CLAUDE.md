# MyScreen

Mac-only Electron screen recorder (a free, open-source alternative to Loom). Vanilla JS, **no build step** — files load via `<script>` tags. Don't introduce bundlers, JSX, or npm UI frameworks.

## Positioning

Canonical description: **"a free, open-source alternative to Loom"**. Use this phrasing in ALL user-facing copy: README, GitHub repo description, release notes, app store listings, social posts. Never "Loom clone" (implies copying, weaker positioning) and never "in the spirit of Loom" (superseded). "Alternative to Loom" is established nominative-fair-use convention (cf. Cap, 17k+ stars, same framing). Never use Loom's logo or put "Loom" in the app name.

## Architecture

- `main.js` — window, IPC, ffmpeg conversion, settings/library/permissions/Dropbox glue
- `recording-engine.js` — renderer, DOM-free except canvas compositing. **Source of truth for recording state** (idle/acquiring/recording/paused/stopping/error). Streams MediaRecorder chunks to disk via IPC. Injectable deps; tested with fakes.
- `recording-writer.js` — main process, stream-to-disk + crash-recovery sidecars. A stream error (disk full) is recorded on the entry so later writes reject instead of waiting for a drain; `releaseAll()` closes open recordings as recoverable orphans when the renderer reloads/crashes or the app is forced to quit.
- `settings-store.js`, `library-store.js`, `dropbox-share.js` — main-process modules (settings JSON, folder scan + ffmpeg thumbnails, OAuth PKCE + upload + shared link)
- `tray-controls.js` — menu bar item, global shortcuts, window hiding. The renderer reports `recording:status` (`phase`, `elapsed`, `mode`); the module answers with `controls:command` (`toggle`, `pause`, `record-screen`, `record-window`, `record-camera`). Electron pieces are injected; tested with fakes.
- `agent-files.js` — pure Node. After a save, writes `<folder>/.myscreen/<name>/recording.md` + `recording.json` + `frames/` (transcript via whisper.cpp, one frame per screen change). Engine lookup order: `Resources/whisper-cli` (shipped), `vendor-bin/whisper-cli` (checkout), Homebrew. A manifest built without a model (`transcript.status: 'no-engine'`) is rebuilt on the next `ensure()` once a model exists. Used by main.js and by:
- `model-download.js` — the speech model (`ggml-large-v3-turbo-q5_0.bin`, 574 MB, size and SHA-256 pinned) downloaded on request into `<userData>/models`: resumable `.part` file, verified before rename. Models in MacWhisper's folder are also picked up.
- `mcp-server.js` — stdio MCP server (hand-written JSON-RPC, no SDK) exposing `list_recordings`, `get_recording`, `get_frames`, `search_recordings`. Runs without the app: `ELECTRON_RUN_AS_NODE=1 <app binary> <app.asar.unpacked>/mcp-server.js`. It and `agent-files.js` are in `asarUnpack`.
- `ui/` — React 18 UMD (vendored in `vendor/`, production build), all components plain `React.createElement`, IIFEs exporting to `window.*`. Load order in `index.html` matters.
  - `ui/controller.js` — the keystone: bridges React state ⇄ engine ⇄ electronAPI. React owns view/config state; controller owns streams, engine events → flow strings (`ready|picker|overlayEdit|countdown|recording|paused|stopping|saving|saved|permissions|recovery`).
- Camera overlay: canvas compositing in the engine for BOTH window and full-screen capture; the preview bubble maps to the video content box so preview == output. No floating camera window (deleted).

## Conventions

- Recordings auto-save to the settings folder (`~/Movies/MyScreen` default), generated filename, no save dialog. WebM saves are remuxed (duration/cues).
- MP4 format records H.264 inside WebM (`video/webm;codecs=avc1.640033,opus`); saving copies the video into an MP4 and converts only the audio (`copyVideo`), so it takes moments. "Smaller file" (`quality: 'small'`) re-encodes with x264 instead. WebM format records VP9. `exportPlan()` in `ui/controller.js` decides; bitrate scales with capture size (`bitrateFor` in the engine).
- Closing the window hides it (the app lives in the menu bar); only Cmd+Q or the menu quits. Quit with a recording open goes through `requestQuit()` so the renderer finalizes first. The renderer drops its previews while the window is not visible (`window:visibility`).
- Every export goes through `exportRecording` (main.js): MP4 encode → remuxed WebM → raw copy, each written to a hidden `.<name>.part.<ext>` sibling and renamed into place (`writeAtomically`). The library skips dotfiles. No cap on total conversion time, only a 60s no-output stall kill.
- The engine watches capture tracks for `ended`: a source that goes away stops and saves the recording; a lost mic or camera raises a warning. `_fail` closes the partial file so recovery can offer it in the same session.
- Toasts take a kind (`info` | `warn` | `error`); `error` stays until dismissed. Use it for anything that changes what ends up in the recording.
- Dropbox tokens stay in the main process: `settings:get` strips `dropboxAuth`, `settings:set` ignores the Dropbox keys.
- Settings persist via `settings:get/set` IPC; UI persists the `PERSISTED` subset in `ui/app.js` (debounced). Keys must exist in `SETTINGS_DEFAULTS` (main.js).
- System audio: shown as unavailable on macOS; never send `systemAudio: true`.
- Quality `small` maps to ffmpeg preset `slow`.

## Testing

- `npm test` — node:test with fake MediaRecorder/streams (engine + writer). Keep green; engine changes need fake-driven tests.
- `MYSCREEN_TEST_MODEL_DIR=<dir with a ggml model>` enables the real whisper.cpp transcription tests (skipped otherwise); they need `npm run build:whisper` or a Homebrew `whisper-cli`. The downloader tests run against a local HTTP server and never fetch the real model. The library, agent-files, and MCP suites run the bundled ffmpeg.
- **Headless UI/E2E harness** (no TCC permissions needed): `npx electron . --remote-debugging-port=9223 --user-data-dir=<temp dir>`, connect via CDP (node has global WebSocket), then:
  - Development runs use their own profile (`~/Library/Application Support/myscreen-v2-dev`), separate from the installed app (`myscreen-v2`); `--user-data-dir` gives a test run a throwaway one. One instance per profile. Point `folder` at a temp dir too (`electronAPI.setSettings({ folder })`), or test recordings land in `~/Movies/MyScreen`.
  - Drive menu bar commands with `window.__ms.controller._onCommand('record-screen')` and window visibility with `_onWindowVisibility(false)`. Never call `window.close()` from the page: the close is cancelled in main but the page stops answering CDP.
  - `window.__ms` = `{ set, get, controller }` state hook in `ui/app.js`
  - Override `navigator.mediaDevices.getUserMedia` with canvas `captureStream()` (+ AudioContext oscillator for mic) to fake capture
  - Drives the real UI through record → save → recovery; verifies everything except TCC-gated capture. Examples in session log 2026-06-10/11.
- **Marketing screenshots**: `test/marketing-screenshots.js` — same CDP harness, captures 2x PNGs of ready/recording/saved states with fake content streams. Usage header in the script.

## Git & distribution

- **Branches:** `main` = public lineage, pushed to github.com/metztim/MyScreen (GPL-3.0). `master` + `archive/pre-public` = full private pre-release history, local only, NEVER push. Work on `main`.
- **Release flow:** `npm run dist` compiles the native addon (node-gyp), builds the transcription engine (`scripts/build-whisper.sh`: static whisper.cpp at a pinned tag into gitignored `vendor-bin/`, needs cmake), builds, signs (Developer ID: Mengtian, team 4UKU37ST4J), and notarizes via keychain profile `myscreen-notarize` (`APPLE_KEYCHAIN_PROFILE`). Then `gh release upload v<X> dist/MyScreen-<X>-arm64.dmg --clobber`. Verify: `spctl -a -vv -t install dist/mac-arm64/MyScreen.app` → "Notarized Developer ID", and `codesign -dv dist/mac-arm64/MyScreen.app/Contents/Resources/whisper-cli` shows the Developer ID with the hardened runtime (it ships via `extraResources`).
- **node-gyp owns `build/`** (gitignored, wiped on rebuild); electron-builder resources live in `build-res/` (entitlements). The addon ships via `extraResources` as `Resources/screen_prompt.node`.
- New root JS files must be added to the electron-builder `files` list manually - it does not glob the root.
- Packaging check without signing (leaves `dist/` alone): `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir -c.mac.identity=null -c.mac.notarize=false -c.directories.output=<temp dir>`.

## macOS 26 screen-recording permission model

There is NO system prompt for screen recording on macOS 15+ (tccd: "Service kTCCServiceScreenCapture does not allow prompting"). `getMediaAccessStatus('screen')` never returns not-determined; `CGRequestScreenCaptureAccess()` is a no-op; Chromium preflights capture and never reaches TCC. The flow that works:
1. Enable in the permissions sheet calls `native/screen-prompt.mm` (in-process SCShareableContent - prompts on macOS 13/14, registers intent on 15+) AND opens the Settings pane.
2. The user manually toggles/+ MyScreen in Screen & System Audio Recording (the sheet's guided steps + Settings mock cover this), then restarts (sheet has a Restart button; macOS also offers Quit & Reopen).
3. First real capture then shows a separate "bypass the system private window picker" Allow dialog.

Testing TCC: launch via `open` or a real install - terminal-spawned apps inherit the terminal's TCC identity. `tccutil reset All com.timmetz.myscreen` + wiping `~/Library/Application Support/myscreen-v2` simulates a new user. Re-signing with a different cert wipes grants; same-cert rebuilds keep them. Debug via `/usr/bin/log show --predicate 'process == "tccd"'` (full path - zsh shadows `log`).

## Gotchas

- **TCC**: dev runs use the Electron binary's identity (shows as "Electron" in System Settings); the packaged app has its own ("MyScreen") and needs permissions granted separately. Screen Recording requires app restart after granting.
- **`backgroundThrottling: false`** on the main window is load-bearing: macOS suspends rAF in occluded windows, which froze composited recordings (1-frame outputs).
- **Never record straight to `video/mp4`**: Chromium's MP4 muxer holds the data until stop (1.2 KB on disk after 4s), so an interrupted recording recovers as an empty file. H.264 in WebM streams chunk by chunk.
- **macOS `show`/`hide` window events follow occlusion**, not just `show()`/`hide()` calls: a window fully covered by other apps emits `hide`, and `show()` on a still-covered window emits nothing. `app.focus({ steal: true })` is best effort when MyScreen is not the active app.
- Electron 45: macOS 13+; sandboxed preloads can `require` only `electron`; `electron` downloads its binary on first run, not at install.
- `desktopCapturer` appIcons can be empty NativeImages — `toDataURL()` then yields a truthy-but-broken data URL; guard with `isEmpty()`.
- Packaging: `npm run dist`. ffmpeg must stay in `asarUnpack` and its path `.replace('app.asar', 'app.asar.unpacked')`. No Developer ID cert yet — DMGs need "Open Anyway" on other Macs until notarized.
- Dropbox: one developer app key (PKCE, public, "MyScreen Recorder" app under Tim's account) serves all users; built into `SETTINGS_DEFAULTS`, each user OAuths their own account via the Share popover's Connect button.

## Session continuity

`docs/SESSION_LOG.md` (newest at bottom, `<!-- END_OF_SESSION_LOG -->` anchor). Notion anchor: "MyScreen" project (Personal Projects, `24cedc77-7df2-8028-9ed0-e867a96a6f5e`, personal workspace).
