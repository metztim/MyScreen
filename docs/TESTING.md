# Testing MyScreen

How to verify the recorder end to end. The recording core (chunk ordering, finalization, crash-survivor detection, abort, discard) is covered by automated tests; capture, save, conversion, and recovery need a real run.

## Automated tests

```
npm test
```

Runs the `node:test` suite in `test/`. Covers `recording-writer.js` (in-order append to disk, ArrayBuffer/IPC shape, backpressure, orphan detection, abort, discard, zero-byte cleanup) and `recording-engine.js` (chunk ordering under inverted write latency, state machine, cancel, error handling).

## Prerequisites for a live run

1. Install dependencies: `npm ci`
2. Grant Screen Recording permission to Electron: System Settings, Privacy and Security, Screen Recording, enable the Electron entry. Restart the app after granting.
3. Launch: `npm start`

## Manual checklist

### 1. Basic recording (the core hypothesis)

1. Click Full Screen, confirm the preview appears.
2. Keep Record Microphone on. Click Start Recording, wait about 20 seconds, click Stop.
3. In the save dialog, save as `.mp4`, pick Balanced.
4. Open the saved file in QuickTime and VLC. Confirm: it plays start to finish, the duration is correct (about 20 seconds), the timeline scrubs/seeks correctly, and audio is present.
5. Record again and save as `.webm`. Confirm the same in VLC.

Pass criterion: both files play fully with correct duration and working seek. This is the property the old segment system failed.

### 2. Long recording (bounded memory)

1. Start a recording and let it run 30 or more minutes (a screen with motion is fine).
2. During the recording, open Activity Monitor and watch the Electron helper memory.

Pass criterion: memory stays roughly flat (no climb into the gigabytes). Stop and confirm the file plays.

### 3. Crash recovery

1. Start a recording, let it run about 15 seconds.
2. Force-kill the app while recording: find the pid with `pgrep -f "Electron.app/Contents/MacOS/Electron"`, then `kill -9 <pid>`. (Do not use Stop.)
3. Relaunch with `npm start`.

Pass criterion: a recovery dialog lists the interrupted recording. Click Recover, choose a destination, and confirm the recovered file plays with a correct duration. Then start another recording, force-kill again, relaunch, and this time click Discard. Confirm the entry disappears and is gone on the next launch.

### 4. Sources and options

- Application Window: pick a window from the picker, record, confirm only that window is captured.
- Camera Only: record the webcam directly, confirm it saves and plays.
- Include Camera: enable it with a screen source, confirm the floating camera window appears and shows up inside the screen recording.
- Microphone Input: select a non-default mic from the dropdown and confirm its audio is in the recording.
- System Audio: enable it. On macOS this is commonly unsupported; confirm the app shows a clear "system audio not available" message and still records (it does not silently fail or crash).

### 5. Save edge cases

- Cancel the save dialog after a recording: confirm the temp file is discarded (no recovery prompt on next launch).
- Save as `.mp4` and cancel the quality dialog: confirm it falls back to saving a `.webm`.

## Where recordings live before saving

In-progress and crash-survivor recordings are written to `<userData>/in-progress/` (on macOS: `~/Library/Application Support/myscreen-v2/in-progress/`), each as a `<id>.webm` plus a `<id>.json` sidecar. A successful save removes both.
