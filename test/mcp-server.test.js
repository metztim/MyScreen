'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const AgentFiles = require('../agent-files');
const { createServer, Recordings, resolveConfig, TOOLS } = require('../mcp-server');
const ffmpegPath = require('ffmpeg-static');

function makeClip(filePath) {
  const result = spawnSync(ffmpegPath, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x1b2a3a:s=640x400:d=3', '-f', 'lavfi', '-i', 'testsrc2=s=640x400:d=3',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', '-r', '10', filePath,
  ]);
  assert.strictEqual(result.status, 0, String(result.stderr));
}

async function setup() {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-mcp-'));
  makeClip(path.join(folder, 'First take.mp4'));
  await new Promise((r) => setTimeout(r, 20));
  makeClip(path.join(folder, 'Bug walkthrough.mp4'));
  await fsp.writeFile(path.join(folder, '.Bug walkthrough.part.mp4'), 'x');
  const agent = new AgentFiles({ ffmpegPath, modelDirs: [], whisperPath: '/nonexistent' });
  const handle = createServer({ recordings: new Recordings({ folder, agent }), agent });
  let id = 0;
  const call = async (name, args) => (await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })).result;
  return { folder, agent, handle, call };
}

test('handshake: initialize, tool list, ping, and silence for notifications', async () => {
  const { folder, handle } = await setup();

  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.strictEqual(init.result.protocolVersion, '2025-03-26', 'answers in the version the client asked for');
  assert.strictEqual(init.result.serverInfo.name, 'myscreen');
  assert.deepStrictEqual(init.result.capabilities, { tools: {} });

  const future = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.strictEqual(future.result.protocolVersion, '2025-06-18', 'offers its newest version to a client it does not know');

  assert.strictEqual(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepStrictEqual((await handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});

  const tools = (await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).result.tools;
  assert.deepStrictEqual(tools.map((t) => t.name), ['list_recordings', 'get_recording', 'get_frames', 'search_recordings']);
  assert.strictEqual(tools, TOOLS);

  assert.strictEqual((await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
  await fsp.rm(folder, { recursive: true, force: true });
});

test('tools: list, read the latest recording, fetch frames, search', async () => {
  const { folder, call } = await setup();

  const list = await call('list_recordings', {});
  const listed = list.content[0].text;
  assert.match(listed, /Bug walkthrough\.mp4.*not prepared yet/);
  assert.ok(listed.indexOf('Bug walkthrough') < listed.indexOf('First take'), 'newest first');
  assert.ok(!listed.includes('.part'), 'saves in progress are not recordings');

  const latest = await call('get_recording', { recording: 'latest' });
  assert.match(latest.content[0].text, /^# Bug walkthrough/);
  assert.match(latest.content[0].text, /No transcript: The recording has no audio track/);
  assert.match(latest.content[0].text, /\[0:03\] .*frames\/002-0m03s\.jpg/);

  // Key frames in a range come back as images with their timestamps.
  const frames = await call('get_frames', { recording: 'Bug walkthrough', start: 0, end: 10 });
  const images = frames.content.filter((c) => c.type === 'image');
  assert.strictEqual(images.length, 2);
  assert.strictEqual(images[0].mimeType, 'image/jpeg');
  assert.strictEqual(Buffer.from(images[0].data, 'base64')[0], 0xff);
  assert.match(frames.content[0].text, /at 0:00/);

  // Exact moments are extracted on request.
  const exact = await call('get_frames', { recording: 'latest', times: [1.5] });
  assert.match(exact.content[0].text, /at 0:01/);
  assert.strictEqual(exact.content[1].type, 'image');

  const search = await call('search_recordings', { query: 'first' });
  assert.match(search.content[0].text, /First take\.mp4/);
  assert.match(search.content[0].text, /1 recordings have no transcript prepared yet/);

  const listAgain = await call('list_recordings', {});
  assert.match(listAgain.content[0].text, /Bug walkthrough\.mp4 · .* · 0:06 · no transcript \(no-audio\)/);

  await fsp.rm(folder, { recursive: true, force: true });
});

test('tool errors come back as readable results, and names cannot leave the folder', async () => {
  const { folder, call } = await setup();

  const missing = await call('get_recording', { recording: 'nope' });
  assert.strictEqual(missing.isError, true);
  assert.match(missing.content[0].text, /No recording named "nope"/);

  const traversal = await call('get_recording', { recording: '../../etc/passwd' });
  assert.strictEqual(traversal.isError, true);

  const ambiguous = await call('get_recording', { recording: '.mp4' });
  assert.match(ambiguous.content[0].text, /matches 2 recordings/);

  await fsp.rm(folder, { recursive: true, force: true });
});

test('finds the recordings folder from arguments, environment, or settings', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'myscreen-mcp-cfg-'));
  await fsp.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ folder: '/from/settings' }));
  assert.strictEqual(resolveConfig(['--user-data-dir', dir], {}).folder, '/from/settings');
  assert.strictEqual(resolveConfig(['--user-data-dir', dir], { MYSCREEN_FOLDER: '/from/env' }).folder, '/from/env');
  assert.strictEqual(resolveConfig(['--folder', '/from/arg', '--user-data-dir', dir], { MYSCREEN_FOLDER: '/from/env' }).folder, '/from/arg');
  assert.strictEqual(resolveConfig(['--user-data-dir', path.join(dir, 'missing')], {}).folder, path.join(os.homedir(), 'Movies', 'MyScreen'));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('speaks newline-delimited JSON-RPC over stdio as a real process', async () => {
  const { folder } = await setup();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'), '--folder', folder], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_recordings', arguments: { limit: 1 } } },
  ];
  for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.strictEqual(code, 0);
  const replies = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(replies.map((r) => r.id), [1, 2], 'one reply per request, none for the notification');
  assert.match(replies[1].result.content[0].text, /Bug walkthrough\.mp4/);
  assert.match(replies[1].result.content[0].text, /1 older recordings not shown/);

  await fsp.rm(folder, { recursive: true, force: true });
});
