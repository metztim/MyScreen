'use strict';

// MyScreen MCP server: lets coding agents (Claude Code, Codex) read the
// user's screen recordings. Speaks the Model Context Protocol over stdio
// (newline-delimited JSON-RPC 2.0) with no dependencies beyond this repo.
//
// It runs without the app: the agent starts it on demand, and it reads the
// recordings folder directly. Started through the app's own binary:
//
//   ELECTRON_RUN_AS_NODE=1 /Applications/MyScreen.app/Contents/MacOS/MyScreen <this file>
//
// or with plain Node from a checkout. Options: --folder <dir> (recordings
// folder), --user-data-dir <dir> (where settings.json lives).
//
// It only reads video files inside the recordings folder and only writes
// under <folder>/.myscreen: the agent files, and the title and description
// an agent saves for a recording (see agent-files.js). stdout
// carries the protocol; anything else goes to stderr.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const readline = require('readline');

const AgentFiles = require('./agent-files');

const SERVER_VERSION = require('./package.json').version;
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_IMAGES_PER_CALL = 8;

// --- configuration ----------------------------------------------------------------

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  const userDataDir = argValue(argv, '--user-data-dir') || env.MYSCREEN_USER_DATA
    || path.join(os.homedir(), 'Library', 'Application Support', 'myscreen-v2');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8')); } catch { /* defaults */ }
  const folder = argValue(argv, '--folder') || env.MYSCREEN_FOLDER || settings.folder
    || path.join(os.homedir(), 'Movies', 'MyScreen');
  return { userDataDir, folder, settings };
}

// --- recordings ---------------------------------------------------------------------

class Recordings {
  constructor({ folder, agent }) {
    this.folder = folder;
    this.agent = agent;
  }

  async list() {
    let names;
    try { names = await fsp.readdir(this.folder); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (name.startsWith('.') || !AgentFiles.isVideo(name)) continue;
      const filePath = path.join(this.folder, name);
      let stat;
      try { stat = await fsp.stat(filePath); } catch { continue; }
      if (!stat.isFile() || stat.size === 0) continue;
      out.push({ name, path: filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  // 'latest', a file name (with or without extension), or a path inside the folder.
  async resolve(ref) {
    const all = await this.list();
    if (!all.length) throw new Error(`No recordings in ${this.folder}.`);
    if (!ref || ref === 'latest') return all[0];
    const wanted = path.basename(String(ref)); // never leaves the recordings folder
    const exact = all.find((r) => r.name === wanted || r.name.replace(/\.(mp4|webm)$/i, '') === wanted);
    if (exact) return exact;
    const partial = all.filter((r) => r.name.toLowerCase().includes(wanted.toLowerCase()));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`"${ref}" matches ${partial.length} recordings: ${partial.slice(0, 5).map((r) => r.name).join(', ')}. Use the full name.`);
    throw new Error(`No recording named "${ref}". Call list_recordings to see the names.`);
  }
}

// --- tools ----------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_recordings',
    description: 'List the user\'s MyScreen screen recordings, newest first, with date, duration, and whether a transcript is ready. Start here when the user mentions a recording.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many to return (default 20).' } },
    },
  },
  {
    name: 'get_recording',
    description: 'Read one recording: when it was made, what was recorded, the transcript of the narration with timestamps, and the list of key frames (one per screen change). Use "latest" for the most recent one. The first call for a recording prepares these files and can take a while for a long video.',
    inputSchema: {
      type: 'object',
      properties: { recording: { type: 'string', description: 'A name from list_recordings, or "latest" (default).' } },
    },
  },
  {
    name: 'get_frames',
    description: 'See what was on screen: returns images from a recording. Give a time range to get the key frames inside it, or exact moments in seconds to get a frame at each. Pair the timestamps with the transcript from get_recording.',
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: 'A name from list_recordings, or "latest" (default).' },
        start: { type: 'number', description: 'Range start in seconds (default 0).' },
        end: { type: 'number', description: 'Range end in seconds (default: end of recording).' },
        times: { type: 'array', items: { type: 'number' }, description: 'Exact moments in seconds. When given, start and end are ignored.' },
        max: { type: 'integer', minimum: 1, maximum: MAX_IMAGES_PER_CALL, description: `Most images to return (default 6, limit ${MAX_IMAGES_PER_CALL}).` },
      },
    },
  },
  {
    name: 'describe_recording',
    description: 'Save a title and a short description for a recording. MyScreen shows them in its recordings overview in place of the file name. Write them from the transcript and key frames: a specific title of a few words, and one or two sentences on what the recording shows. Calling it again replaces what was saved.',
    inputSchema: {
      type: 'object',
      properties: {
        recording: { type: 'string', description: 'A name from list_recordings, or "latest" (default).' },
        title: { type: 'string', description: 'A specific title, under 60 characters.' },
        description: { type: 'string', description: 'One or two sentences on what the recording shows.' },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'search_recordings',
    description: 'Find recordings by title, description, file name, or what was said in them. Searches the transcripts that have been prepared so far.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to look for.' } },
      required: ['query'],
    },
  },
];

const text = (value) => ({ type: 'text', text: value });

function createToolHandlers({ recordings, agent }) {
  const clock = AgentFiles.clock;

  return {
    async list_recordings({ limit = 20 } = {}) {
      const all = await recordings.list();
      if (!all.length) return [text(`No recordings in ${recordings.folder}.`)];
      const lines = [];
      for (const rec of all.slice(0, Math.min(100, Math.max(1, limit)))) {
        const manifest = await agent.read(rec.path);
        const bits = [AgentFiles.localStamp(rec.mtimeMs)];
        if (manifest && manifest.durationSeconds != null) bits.push(clock(manifest.durationSeconds));
        bits.push(manifest
          ? (manifest.transcript.status === 'ok' ? `transcript ready (${manifest.transcript.segments.length} lines)` : `no transcript (${manifest.transcript.status})`)
          : 'not prepared yet');
        const notes = await agent.readNotes(rec.path);
        lines.push(`- ${rec.name} · ${bits.join(' · ')}${notes && notes.title ? ` · "${notes.title}"` : ''}`);
      }
      const more = all.length > lines.length ? `\n(${all.length - lines.length} older recordings not shown.)` : '';
      return [text(`Recordings in ${recordings.folder}, newest first:\n${lines.join('\n')}${more}`)];
    },

    async get_recording({ recording = 'latest' } = {}) {
      const rec = await recordings.resolve(recording);
      await agent.ensure(rec.path);
      const notes = await agent.readNotes(rec.path);
      const header = notes
        ? `Title: ${notes.title || '(none)'}\nDescription: ${notes.description || '(none)'}\n\n`
        : 'This recording has no title or description yet. Save them with describe_recording once you have read it.\n\n';
      return [text(header + await fsp.readFile(agent.summaryPathFor(rec.path), 'utf-8'))];
    },

    async describe_recording({ recording = 'latest', title = '', description = '' } = {}) {
      const rec = await recordings.resolve(recording);
      const notes = await agent.writeNotes(rec.path, { title, description });
      return [text(`Saved for ${rec.name}.\nTitle: ${notes.title || '(none)'}\nDescription: ${notes.description || '(none)'}`)];
    },

    async get_frames({ recording = 'latest', start = 0, end = null, times = null, max = 6 } = {}) {
      const rec = await recordings.resolve(recording);
      const manifest = await agent.ensure(rec.path);
      const limit = Math.min(MAX_IMAGES_PER_CALL, Math.max(1, max));
      const content = [];

      if (Array.isArray(times) && times.length) {
        for (const t of times.slice(0, limit)) {
          const jpeg = await agent.frameAt(rec.path, Number(t) || 0);
          content.push(text(`${rec.name} at ${clock(Number(t) || 0)}:`));
          content.push({ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
        }
        return content;
      }

      const upper = end == null ? Infinity : end;
      let inRange = manifest.frames.filter((f) => f.t != null && f.t >= start && f.t <= upper);
      if (!inRange.length) {
        // No screen change inside the range: show the moment it starts.
        const jpeg = await agent.frameAt(rec.path, start);
        return [text(`${rec.name} at ${clock(start)} (the screen does not change in this range):`), { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }];
      }
      const total = inRange.length;
      if (total > limit) {
        const step = total / limit;
        inRange = Array.from({ length: limit }, (_, i) => inRange[Math.floor(i * step)]);
      }
      if (total > inRange.length) content.push(text(`${total} key frames in this range; showing ${inRange.length}. Narrow the range to see the others.`));
      for (const frame of inRange) {
        const jpeg = await fsp.readFile(path.join(agent.dirFor(rec.path), frame.file));
        content.push(text(`${rec.name} at ${clock(frame.t)}:`));
        content.push({ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' });
      }
      return content;
    },

    async search_recordings({ query } = {}) {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) throw new Error('search_recordings needs a query.');
      const all = await recordings.list();
      const hits = [];
      let unprepared = 0;
      for (const rec of all) {
        const manifest = await agent.read(rec.path);
        if (!manifest) unprepared++;
        const lines = [];
        if (rec.name.toLowerCase().includes(needle)) lines.push('  name matches');
        const notes = await agent.readNotes(rec.path);
        if (notes && notes.title.toLowerCase().includes(needle)) lines.push(`  title: ${notes.title}`);
        if (notes && notes.description.toLowerCase().includes(needle)) lines.push(`  description: ${notes.description}`);
        if (manifest && manifest.transcript.status === 'ok') {
          for (const seg of manifest.transcript.segments) {
            if (seg.text.toLowerCase().includes(needle)) lines.push(`  [${clock(seg.start)}] ${seg.text}`);
          }
        }
        if (lines.length) hits.push(`- ${rec.name}\n${lines.slice(0, 8).join('\n')}`);
      }
      const note = unprepared ? `\n(${unprepared} recordings have no transcript prepared yet; get_recording prepares one.)` : '';
      return [text(hits.length ? `Matches for "${query}":\n${hits.join('\n')}${note}` : `Nothing matches "${query}".${note}`)];
    },
  };
}

// --- protocol -------------------------------------------------------------------------

function createServer({ recordings, agent }) {
  const handlers = createToolHandlers({ recordings, agent });

  // Returns the JSON-RPC response for one message, or null for notifications.
  return async function handle(message) {
    const { id, method, params } = message || {};
    const isRequest = id !== undefined && id !== null;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'myscreen', title: 'MyScreen', version: SERVER_VERSION },
          instructions: 'Screen recordings the user made with MyScreen, each with a narration transcript and key frames. When the user refers to a recording ("my last recording", "the video I just made"), call get_recording with "latest", read the transcript, then call get_frames for the moments that matter. When a recording you have read has no title yet, save a title and a short description with describe_recording; MyScreen shows them to the user.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = params && params.name;
        if (!Object.prototype.hasOwnProperty.call(handlers, name)) return fail(-32602, `Unknown tool: ${name}`);
        try {
          return ok({ content: await handlers[name]((params && params.arguments) || {}) });
        } catch (err) {
          // Tool failures go back as results the model can read and act on.
          return ok({ content: [text(`Error: ${err.message}`)], isError: true });
        }
      }
      default:
        if (!isRequest) return null; // notifications/initialized and friends
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}

function main() {
  const config = resolveConfig();
  // Inside the packaged app the binary lives next to the archive, not in it.
  const ffmpegPath = require('ffmpeg-static').replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  const agent = new AgentFiles({
    ffmpegPath,
    modelDirs: AgentFiles.defaultModelDirs(config.userDataDir),
    whisperPath: config.settings.whisperPath || null,
    whisperModel: config.settings.whisperModel || null,
  });
  const recordings = new Recordings({ folder: config.folder, agent });
  const handle = createServer({ recordings, agent });

  const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    // One at a time, in order: builds are heavy and replies stay sequenced.
    pending = pending.then(async () => {
      const response = await handle(message);
      if (response) send(response);
    }).catch((err) => { process.stderr.write(`myscreen-mcp: ${err.stack || err}\n`); });
  });
  rl.on('close', () => { pending.then(() => process.exit(0)); });
  process.stderr.write(`myscreen-mcp: serving ${config.folder}\n`);
}

if (require.main === module) main();

module.exports = { createServer, Recordings, resolveConfig, TOOLS };
