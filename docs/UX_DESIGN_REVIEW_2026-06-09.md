# MyScreen UX Design Review

Date: 2026-06-09
Audience: UX designer redesigning the MyScreen interface
Scope: Current Electron app after the recording-core rewrite and live testing

## Summary

MyScreen now appears functionally viable: screen recording works, selected-window recording works, microphone audio works, camera-only recording works, camera overlay works for full-screen and selected-window recordings, MP4 conversion works, and crash recovery exists. The main UX issue is that the interface reflects an engineering validation flow rather than a polished recording workflow.

The redesign should preserve the reliability gains while making the app feel predictable, confidence-building, and hard to misconfigure. The highest-value change is to make the preview area the source of truth: what the user sees before recording should match what will appear in the final video.

## Product intent

MyScreen should help a solo operator quickly record a screen, a selected app window, or a camera-only video with microphone audio and an optional camera overlay. It should feel closer to a lightweight Loom-style recorder than a technical capture utility.

Primary jobs:

- Record a full screen with microphone and optional camera.
- Record a specific application window with microphone and optional camera.
- Record camera-only video.
- Save a playable file, usually MP4.
- Recover interrupted recordings without making the user understand temp files.

## Current strengths

- **Functional core:** The app can now create playable recordings with sound and camera overlay.
- **Clear primary action:** The Start Recording button is obvious and remains prominent.
- **Live preview:** Users can see the selected source before recording.
- **Simple source model:** Full Screen, Application Window, and Camera Only are easy to understand at a high level.
- **Crash recovery:** Recovery exists, which is valuable for trust.
- **Mac-native save flow:** The Save dialog is familiar.

## Highest-priority UX problems

### 1. Preview does not consistently represent the final output

The app recently exposed several preview/final-output mismatches:

- Window capture plus camera overlay needed a different implementation than full-screen capture.
- The camera preview appeared in one position before recording and another in the final recording.
- The floating camera overlay can be visible on the desktop while absent from selected-window recordings.

The redesign should treat the preview as a contract. If the user sees a camera overlay, position, crop, source, or aspect ratio in preview, the final recording should match it.

Recommended design direction:

- Use a single preview canvas that represents final output.
- Make overlay position and size editable inside the preview.
- Show clear mode-specific behavior: full-screen overlay and selected-window overlay should look the same to the user even if the implementation differs.
- Avoid any camera window behavior that is visible but not recorded.

### 2. Recording modes have hidden technical differences

Full Screen and Application Window look like sibling choices, but camera overlay behaves differently under the hood. System audio may work differently by platform. H.264 Direct is experimental. These differences are currently exposed as rough edges rather than guided expectations.

Recommended design direction:

- Present source mode as the first decision.
- Show only options that work for the selected mode.
- Rename or explain experimental options in plain language.
- Disable unsupported options with a short inline reason.
- Add a small final-output summary before recording: source, camera, microphone, format.

### 3. Permission state is not guided enough

Screen recording, camera, and microphone permissions are required, but the UI mainly reacts after failure. On macOS, users may see “Electron” in system settings rather than “MyScreen,” which adds friction.

Recommended design direction:

- Add a preflight permission state for Screen, Camera, and Microphone.
- When a permission is missing, show the exact next action.
- Avoid generic errors such as “Could not start recording.”
- After a permission change, prompt the user to restart the app when needed.

### 4. Source selection needs stronger wayfinding

The source picker is a modal grid. During testing, thumbnails were broken until CSP was fixed. Even with thumbnails working, the picker can become crowded and hard to scan.

Recommended design direction:

- Group sources into Screens and Apps.
- Add search or quick filtering for application windows.
- Show app icon, app name, window title, and last-active signal.
- Make the selected source persistent and visible after modal close.
- Add an empty/error state that distinguishes “no windows available” from “permission missing.”

### 5. Save and conversion feel disconnected from recording

After stopping, the user enters a save and conversion sequence. MP4 conversion can take one or two minutes for longer 4K recordings. The progress UI exists, but it is visually secondary and was easy to miss.

Recommended design direction:

- Treat “Stop” as the beginning of a post-recording flow.
- Show a dedicated “Saving recording” state with progress, elapsed time, and estimated time remaining.
- Keep the app in a locked, clear state while conversion is running.
- Let users choose default output format and quality before recording, or make post-recording choices feel deliberate.
- Use plain labels for quality options, for example “Fast,” “Balanced,” and “Smaller file.”

### 6. Status messages are too easy to miss

Status appears in a small queue near the bottom/right area. Important states such as conversion, recovery, unsupported system audio, and errors need stronger hierarchy.

Recommended design direction:

- Separate persistent app state from transient notifications.
- Use a dedicated status area for current operation: Ready, Recording, Stopping, Saving, Recovering.
- Use toasts only for secondary messages.
- For errors, provide the likely cause and next action.

### 7. The visual design lacks a coherent product hierarchy

The current UI uses a dark blue/purple palette, gradients, emoji-like icons, uppercase section labels, and nested panel styling. It works as a dev UI, but it does not yet feel like a focused recording tool.

Recommended design direction:

- Reduce decorative gradients and heavy shadows.
- Use a quieter operational palette with clear state colors.
- Use consistent iconography instead of emoji-style labels.
- Make the preview the dominant element.
- Use typography scale to separate app title, mode labels, settings, status, and action controls.

## Flow-by-flow review

### First launch and setup

Current issue:

- Permission requirements are discovered through failure.
- The app does not clearly tell the user whether it is ready to record.

Recommended redesign:

- Show a compact setup checklist when permissions are missing.
- Convert missing permissions into guided actions, not error states.
- Use “Ready to record” only when source and required permissions are valid.

### Source selection

Current issue:

- Source buttons are simple, but the window-selection modal does most of the work.
- The selected source is not summarized prominently after selection.
- Window thumbnails need to be reliable and large enough to identify.

Recommended redesign:

- Use a segmented mode selector or three clear mode cards.
- Keep the selected source visible near the preview.
- For app windows, show a searchable picker with thumbnails and app metadata.
- Consider a recent sources section.

### Recording options

Current issue:

- Options are visually equal even though they have different risk and support levels.
- System Audio and H.264 Direct are advanced or platform-sensitive but sit beside common options.
- Microphone device selection is hidden until Record Microphone is checked.

Recommended redesign:

- Split common options from advanced options.
- Keep microphone and camera prominent.
- Move System Audio and codec settings into Advanced.
- Make unsupported options self-explanatory.
- Show selected mic name directly in the setup summary.

### Camera overlay

Current issue:

- Include Camera means different technical behavior depending on source.
- The floating camera overlay can be confused with the recorded overlay.
- There is no obvious way to position, resize, hide, or mirror the camera.

Recommended redesign:

- Treat camera overlay as an editable layer inside the preview.
- Provide corner position controls and size presets.
- Show a mirror toggle if needed.
- Keep overlay behavior consistent across full-screen and app-window modes.
- Avoid showing any overlay window that will not be captured.

### Recording state

Current issue:

- The timer and button state work, but the overall app does not strongly signal active recording.
- Source and option controls remain visually close to active controls.

Recommended redesign:

- Use a clear recording state: red indicator, source summary, elapsed time, Stop button.
- Reduce visual weight of setup controls while recording.
- Consider a compact floating control if the app window is not meant to stay visible.
- Add a clear “Stopping” state so users know the final chunk is being written.

### Save and conversion

Current issue:

- Save happens after recording, then conversion happens after save location selection.
- The user can wait without a strong sense of progress.
- Quality labels mix speed, file size, and quality in ways that require interpretation.

Recommended redesign:

- Present save/conversion as a distinct post-recording step.
- Show file name, destination, format, progress, and estimated time.
- Allow default save settings to reduce repeated dialogs.
- Use clearer quality framing:
  - Fast: quickest, larger file.
  - Balanced: recommended.
  - Smaller file: slower, smaller output.

### Recovery

Current issue:

- Recovery is technically sound, but the UX likely feels like a file-system event.
- Users need confidence that interrupted recordings are safe.

Recommended redesign:

- Use friendly copy: “We found an unsaved recording.”
- Show date, approximate duration, and size.
- Offer Recover and Discard with clear consequences.
- Avoid exposing implementation details such as sidecars or temp paths.

## Recommended information architecture

Suggested primary screen layout:

- **Preview area:** Large central preview of final output.
- **Setup panel:** Source, microphone, camera, output format, advanced settings.
- **Transport bar:** Start/Stop, timer, current state, conversion progress.
- **Status area:** Persistent readiness and error messages.

Suggested hierarchy:

1. Source selection
2. Preview and overlay configuration
3. Audio and camera settings
4. Output settings
5. Start recording
6. Save/conversion

## Component recommendations

- **Source selector:** Segmented control or cards for Full Screen, Application Window, Camera Only.
- **Window picker:** Searchable grid with thumbnails, app icon, title, and last-used marker.
- **Camera overlay editor:** Drag handles, corner presets, size slider, mirror toggle.
- **Microphone selector:** Toggle plus device dropdown and input-level meter.
- **Output settings:** Format selector, quality preset, default folder.
- **Recording transport:** Prominent Start/Stop, timer, status.
- **Conversion progress:** Dedicated progress state with percent, ETA, and file destination.
- **Recovery dialog:** Friendly unsaved-recording recovery flow.
- **Permission prompts:** Inline checklist with action buttons.

## Copy recommendations

Current labels that need review:

- **Include Camera:** Good label. Keep it.
- **H.264 Direct (Beta):** Too technical for the main UI. Move to Advanced or rename around outcome.
- **System Audio:** Needs platform-specific support copy.
- **Fast & Large / Slow & Small:** Clarify tradeoff and avoid making quality sound worse without context.
- **Could not start recording:** Add likely cause and next step.

Example tone:

- “Ready to record Codex with microphone and camera.”
- “Screen Recording permission is missing. Enable Electron in System Settings, then restart MyScreen.”
- “Saving MP4. About 1 minute remaining.”
- “System audio is not available on this Mac. Recording will continue without it.”

## Accessibility and polish

Review items for the redesign:

- Keyboard navigation for source picker, modals, and recording controls.
- Visible focus states.
- Contrast for disabled states and secondary text.
- Button target sizes.
- Reduced-motion support for pulsing and shimmer effects.
- Screen-reader labels for icon controls.
- Avoid status conveyed only by color.

## Technical constraints for design

The designer should know these constraints:

- The app uses Electron and browser MediaRecorder.
- Recordings stream to disk, then may convert from WebM to MP4.
- MP4 conversion can take minutes for long 4K recordings.
- Full-screen camera overlay can use a floating always-on-top window.
- Application-window camera overlay must be composited into the recorded video.
- macOS screen, camera, and microphone permissions can block capture.
- System audio capture is not reliable on macOS without extra support.
- Crash recovery is available through in-progress files.

## Redesign brief

Design a calm, reliable screen recorder interface that makes the final output predictable before recording starts. The app should make source selection, camera overlay, microphone, and output format obvious without exposing implementation details. It should guide permission setup, give strong feedback during recording and conversion, and make recovery feel reassuring.

Priority screens:

1. First launch with missing permissions
2. Ready state with full-screen source selected
3. Ready state with application-window source selected
4. Source picker modal
5. Camera overlay editing state
6. Active recording state
7. Stopping and saving state
8. Conversion progress state
9. Recovery dialog
10. Error state for unsupported system audio

## Open product decisions

- Should users choose save location before recording or after recording?
- Should MP4 be the default output format?
- Should camera overlay be enabled by default?
- Should overlay position and size persist between sessions?
- Should system audio remain visible on macOS if unsupported?
- Should advanced codec settings exist in the main app?
- Should there be a recording countdown?
- Should long conversions be cancellable?
- Should MyScreen offer a recent recordings list?

