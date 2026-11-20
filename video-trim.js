'use strict';

// Cutting time off the start and the end of a saved recording.
//
// Pure: builds the ffmpeg arguments, main.js runs them. A cut at the end only
// copies the streams (exact, takes moments). A cut at the start re-encodes,
// because a copied video can only begin on a keyframe and a screen recording
// has one every few seconds.

const MIN_LENGTH_SECONDS = 0.5;

// The part to keep, limited to the recording. Throws when nothing would change
// or too little would be left.
function trimRange({ start, end, durationSeconds }) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The length of the recording is unknown.');
  const from = Math.max(0, Math.min(duration, Number(start) || 0));
  const to = Math.max(0, Math.min(duration, end == null ? duration : Number(end)));
  if (!(to - from >= MIN_LENGTH_SECONDS)) throw new Error('The part to keep is too short.');
  const cutsStart = from > 0.05;
  const cutsEnd = duration - to > 0.05;
  if (!cutsStart && !cutsEnd) throw new Error('Nothing to trim.');
  return { start: cutsStart ? from : 0, end: cutsEnd ? to : duration, length: (cutsEnd ? to : duration) - (cutsStart ? from : 0), cutsStart, cutsEnd };
}

const seconds = (value) => value.toFixed(3);

// ffmpeg arguments that write the kept part of `inputPath` to `outputPath`.
// The container follows the output's extension (mp4 or webm).
function trimArgs({ inputPath, outputPath, start, end, durationSeconds }) {
  const range = trimRange({ start, end, durationSeconds });
  const webm = /\.webm$/i.test(outputPath);
  const args = [];
  if (range.cutsStart) args.push('-ss', seconds(range.start));
  args.push('-i', inputPath, '-t', seconds(range.length));
  if (!range.cutsStart) {
    args.push('-c', 'copy');
  } else if (webm) {
    args.push(
      '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
      '-c:a', 'libopus', '-b:a', '128k',
    );
  } else {
    args.push(
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-fps_mode:v', 'vfr',
    );
  }
  if (!webm) args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-f', webm ? 'webm' : 'mp4', '-y', outputPath);
  return { args, range, reencodes: range.cutsStart };
}

module.exports = { trimArgs, trimRange, MIN_LENGTH_SECONDS };
