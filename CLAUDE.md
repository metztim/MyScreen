# MyScreen

Mac-only Electron screen recorder (Loom-style). Vanilla JS, **no build step** — files load via `<script>` tags. Don't introduce bundlers, JSX, or npm UI frameworks.

## Architecture

- `main.js` — window, IPC, ffmpeg conversion, settings/library/permissions/Dropbox glue
- `recording-engine.js` — renderer, DOM-free except canvas compositing. **Source of truth for recording state** (idle/acquiring/recording/paused/stopping/error). Streams MediaRecorder chunks to disk via IPC. Injectable deps; tested with fakes.
- `recording-writer.js` — main process, stream-to-disk + crash-recovery sidecars
- `settings-store.js`, `library-store.js`, `dropbox-share.js` — main-process modules (settings JSON, folder scan + ffmpeg thumbnails, OAuth PKCE + upload + shared link)
- `ui/` — React 18 UMD (vendored in `vendor/`, production build), all components plain `React.createElement`, IIFEs exporting to `window.*`. Load order in `index.html` matters.
  - `ui/controller.js` — the keystone: bridges React state ⇄ engine ⇄ electronAPI. React owns view/config state; controller owns streams, engine events → flow strings (`ready|picker|overlayEdit|countdown|recording|paused|stopping|saving|saved|permissions|recovery`).
- Camera overlay: canvas compositing in the engine for BOTH window and full-screen capture; the preview bubble maps to the video content box so preview == output. No floating camera window (deleted).

## Conventions

- Recordings auto-save to the settings folder (`~/Movies/MyScreen` default), generated filename, no save dialog. WebM saves are remuxed (duration/cues).
- Settings persist via `settings:get/set` IPC; UI persists the `PERSISTED` subset in `ui/app.js` (debounced). Keys must exist in `SETTINGS_DEFAULTS` (main.js).
- System audio: shown as unavailable on macOS; never send `systemAudio: true`.
- Quality `small` maps to ffmpeg preset `slow`.

## Testing

- `npm test` — node:test with fake MediaRecorder/streams (engine + writer). Keep green; engine changes need fake-driven tests.
- **Headless UI/E2E harness** (no TCC permissions needed): `npx electron . --remote-debugging-port=9223`, connect via CDP (node has global WebSocket), then:
  - `window.__ms` = `{ set, get, controller }` state hook in `ui/app.js`
  - Override `navigator.mediaDevices.getUserMedia` with canvas `captureStream()` (+ AudioContext oscillator for mic) to fake capture
  - Drives the real UI through record → save → recovery; verifies everything except TCC-gated capture. Examples in session log 2026-06-10/11.

## Gotchas

- **TCC**: dev runs use the Electron binary's identity (shows as "Electron" in System Settings); the packaged app has its own ("MyScreen") and needs permissions granted separately. Screen Recording requires app restart after granting.
- **`backgroundThrottling: false`** on the main window is load-bearing: macOS suspends rAF in occluded windows, which froze composited recordings (1-frame outputs).
- `desktopCapturer` appIcons can be empty NativeImages — `toDataURL()` then yields a truthy-but-broken data URL; guard with `isEmpty()`.
- Packaging: `npm run dist`. ffmpeg must stay in `asarUnpack` and its path `.replace('app.asar', 'app.asar.unpacked')`. No Developer ID cert yet — DMGs need "Open Anyway" on other Macs until notarized.
- Dropbox: one developer app key (PKCE, public, "MyScreen Recorder" app under Tim's account) serves all users; built into `SETTINGS_DEFAULTS`, each user OAuths their own account via the Share popover's Connect button.

## Session continuity

`docs/SESSION_LOG.md` (newest at bottom, `<!-- END_OF_SESSION_LOG -->` anchor). Notion anchor: "MyScreen" project (Personal Projects, `24cedc77-7df2-8028-9ed0-e867a96a6f5e`, personal workspace).
