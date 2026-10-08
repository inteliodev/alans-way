'use strict';
// The person's Terminal window backends (this computer + cloud), the cloud
// terminal routes on the relay, coding-tool detection, and cloud kill switch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');
const { createTerminalBackend, setupTerminalWindow } = require('../src/intelio/terminal/main.cjs');
const { findCodingTools } = require('../src/intelio/node/executors.cjs');
const { createCloudComputer } = require('../../mobile/pwa/nodes-local.cjs');

const GOOD_JWT = 'good-access-assertion';
const TOKEN = 'b'.repeat(64);
const WIN = process.platform === 'win32';
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-term-'));

async function readUntil(run, id, predicate, ms = 20000) {
  let cursor = 0;
  let text = '';
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await run('read', { session_id: id, since: cursor, wait_ms: 1000 });
    text += last.output;
    cursor = last.cursor;
    if (predicate(text, last)) break;
    if (last.exited) break;
  }
  return { text, last };
}

test('this computer: the person\'s terminal starts, takes raw keystrokes, streams raw output, resizes and stops', { timeout: 60000 }, async (t) => {
  const backend = createTerminalBackend({ remote: null });
  t.after(() => backend.close());
  const run = (op, v) => backend.run('local', op, v);
  const started = await run('start', { cols: 100, rows: 30 });
  assert.ok(started.session_id);
  await run('input', { session_id: started.session_id, data: WIN ? 'Write-Output ("term-" + (6*7))\r' : 'echo "term-$((6*7))"\r' });
  const out = await readUntil(run, started.session_id, (text) => /term-42/.test(text));
  assert.match(out.text, /term-42/);
  const resized = await run('resize', { session_id: started.session_id, cols: 120, rows: 40 });
  assert.equal(resized.ok, true);
  assert.equal((await run('list')).sessions.length, 1);
  const stopped = await run('stop', { session_id: started.session_id });
  assert.equal(stopped.ok, true);
  await assert.rejects(backend.run('nowhere', 'start', {}), /Unknown terminal/);
  await assert.rejects(backend.run('local', 'format-disk', {}), /Unknown terminal operation/);
  await assert.rejects(backend.run('cloud', 'start', {}), /Connect to the VPS/);
});

test('terminal window IPC only answers its own window', async () => {
  const ipcMain = new EventEmitter();
  const handlers = {};
  ipcMain.handle = (ch, fn) => { handlers[ch] = fn; };
  class FakeWindow { constructor(o) { this.o = o; this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, send() {} }); } removeMenu() {} loadFile(f, o) { this.file = f; this.query = o.query; } on() {} isDestroyed() { return false; } show() {} focus() {} destroy() {} }
  const calls = [];
  const term = setupTerminalWindow({ BrowserWindow: FakeWindow, ipcMain, backend: { run: async (...a) => { calls.push(a); return { ok: true }; }, close() {} } });
  await assert.rejects(handlers['intelio-terminal']({ sender: {} }, 'local', 'start', {}), /Not allowed/);
  term.open('cloud');
  assert.match(term.window.file, /terminal\.html$/);
  assert.deepEqual(term.window.query, { target: 'cloud' });
  assert.equal(term.window.o.webPreferences.contextIsolation, true);
  assert.equal(term.window.o.webPreferences.nodeIntegration, false);
  await assert.rejects(handlers['intelio-terminal']({ sender: {} }, 'local', 'start', {}), /Not allowed/);
  assert.deepEqual(await handlers['intelio-terminal']({ sender: term.window.webContents }, 'local', 'start', { cols: 80 }), { ok: true });
  assert.deepEqual(calls, [['local', 'start', { cols: 80 }]]);
});

function request(port, { method = 'GET', pathname, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

test('cloud terminal on the relay: person only (Access session), never a profile key or the VPS itself; works end to end', { timeout: 60000, skip: WIN && 'the VPS is Linux' }, async (t) => {
  const dir = tmpdir();
  let self = false;
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, localPort: 0, upstream: 'http://127.0.0.1:9', accessMode: true,
    accessVerify: async (a) => (a === GOOD_JWT ? { ok: true, login: 'hayden@intelio.co' } : { ok: false }),
    identify: async () => ({ ok: true, login: 'inteliodev@github' }),
    selfCheck: async () => self,
    vaultRoot: dir, profileOps: { keyFor: () => 'profile-key' }, voice: { status: async () => ({}) }, log: () => {},
    fetchImpl: async () => { throw new Error('no upstream'); },
    nodes: { registryFile: path.join(dir, 'nodes.json'), token: TOKEN, mcpPort: 0, cloud: false, auditFile: path.join(dir, 'audit.jsonl') },
  });
  await app.listen();
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const access = app.local.address().port;
  const tailnet = app.server.address().port;
  const person = { 'cf-access-jwt-assertion': GOOD_JWT, origin: `http://127.0.0.1:${access}` };
  const post = (op, body, headers = person, port = access) => request(port, { method: 'POST', pathname: `/api/computers/terminal/${op}`, body, headers });

  assert.ok([401, 403].includes((await post('start', {}, { authorization: 'Bearer profile-key', origin: `http://127.0.0.1:${access}` })).status), 'profile key refused');
  assert.equal((await post('start', {}, { 'cf-access-jwt-assertion': GOOD_JWT })).status, 403, 'cross-origin refused');
  self = true;
  assert.equal((await post('start', {}, { origin: `http://127.0.0.1:${tailnet}` }, tailnet)).status, 403, 'the VPS itself is refused');
  self = false;

  const started = await post('start', { cols: 90, rows: 25 });
  assert.equal(started.status, 200, started.text);
  const id = started.json.session_id;
  assert.equal((await post('input', { session_id: id, data: 'echo "cloud-$((6*7))"\r' })).status, 200);
  const run = async (op, v) => (await post(op, v)).json;
  const out = await readUntil(run, id, (text) => /cloud-42/.test(text));
  assert.match(out.text, /cloud-42/);
  const listed = await request(access, { pathname: '/api/computers/terminal/list', headers: person });
  assert.equal(listed.json.sessions.length, 1);
  assert.equal((await post('stop', { session_id: id })).json.ok, true);
  assert.equal((await post('read', { session_id: id })).status, 404);
});

test('coding tools are found on PATH or in the usual folders without running anything', () => {
  const home = '/home/user';
  const seen = new Set(['/home/user/.local/bin/claude', '/opt/tools/codex']);
  const found = findCodingTools({ platform: 'linux', home, env: { PATH: '/usr/bin:/opt/tools' }, exists: (p) => seen.has(p) });
  assert.deepEqual(found, { claude: '/home/user/.local/bin/claude', codex: '/opt/tools/codex' });
  const win = findCodingTools({ platform: 'win32', home: 'C:\\Users\\me', env: { PATH: 'C:\\x', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, exists: (p) => p === path.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'claude.cmd') });
  assert.equal(win.claude, path.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'claude.cmd'));
  assert.equal(win.codex, null);
});

test('turning cloud off for agents ends the agents\' cloud sessions', { timeout: 30000, skip: WIN && 'the VPS is Linux' }, async () => {
  const cloud = createCloudComputer({ env: { ...process.env } });
  try {
    const started = await cloud.run('start_session', { command: 'sleep 600' });
    assert.equal(started.ok, true, started.error);
    assert.equal(cloud.executors.sessions.size, 1);
    cloud.onPaused(true);
    assert.equal(cloud.executors.sessions.size, 0);
    const info = JSON.parse((await cloud.run('computer_info', {})).content[0].text);
    assert.ok('coding_tools' in info && 'sessions' in info);
  } finally { cloud.close(); }
});
