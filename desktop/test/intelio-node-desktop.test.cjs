'use strict';
// intelio node desktop behaviour: first-run prompt, managed-computer hold (ARLP),
// the "agent is using this computer" pill, and the local activity log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setupIntelioNode, managedDevice, holdReason, relayUrls, readLocalAudit, nodePrefs } = require('../src/intelio/node/electron.cjs');
const { createIndicator, describeActivity } = require('../src/intelio/node/indicator.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-node-desk-')); }

function fakeElectron() {
  const windows = [];
  class FakeWindow {
    constructor(options) { this.options = options; this.visible = false; this.destroyed = false; this.sent = []; this.webContents = Object.assign(new EventEmitter(), { send: (ch, v) => this.sent.push([ch, v]), setWindowOpenHandler() {} }); windows.push(this); }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} loadFile(file) { this.file = file; } on() {}
    isDestroyed() { return this.destroyed; } isVisible() { return this.visible; } showInactive() { this.visible = true; } hide() { this.visible = false; } destroy() { this.destroyed = true; }
  }
  const ipcMain = new EventEmitter();
  return { BrowserWindow: FakeWindow, ipcMain, windows, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getAllDisplays: () => [] } };
}

test('managed work computers (ARLP: Alliance domain, SentinelOne, Umbrella) are detected and held until cleared', () => {
  const none = managedDevice({ platform: 'win32', env: { USERDOMAIN: 'LAPTOP-1' }, exists: () => false });
  assert.deepEqual(none, { managed: false, reasons: [] });
  const s1 = managedDevice({ platform: 'win32', env: {}, exists: (p) => p === 'C:\\Program Files\\SentinelOne' });
  assert.equal(s1.managed, true);
  assert.deepEqual(s1.reasons, ['SentinelOne is installed']);
  const umbrella = managedDevice({ platform: 'win32', env: {}, exists: (p) => /Umbrella Roaming Client/.test(p) });
  assert.deepEqual(umbrella.reasons, ['Cisco Umbrella is installed']);
  const domain = managedDevice({ platform: 'win32', env: { USERDNSDOMAIN: 'corp.alliance.local' }, exists: () => false });
  assert.deepEqual(domain.reasons, ['it is joined to the Alliance domain']);
  assert.equal(managedDevice({ platform: 'linux', env: {}, exists: () => true }).managed, false);

  assert.match(holdReason({ env: {}, prefs: {}, managed: s1 }), /managed work computer \(SentinelOne is installed\)/);
  assert.equal(holdReason({ env: {}, prefs: { intelioNode: { cleared: true } }, managed: s1 }), '');
  assert.match(holdReason({ env: { INTELIO_NODE_HOLD: '1' }, prefs: { intelioNode: { cleared: true } }, managed: none }), /INTELIO_NODE_HOLD/);
  assert.match(holdReason({ env: {}, prefs: { intelioNode: { hold: true } }, managed: none }), /Held in Settings/);
  assert.equal(holdReason({ env: {}, prefs: {}, managed: none }), '');
  assert.deepEqual(nodePrefs({}), { enabled: true, name: '', asked: false, cleared: false, hold: false });
});

test('a managed computer never dials Tailscale, only intelio cloud', () => {
  const tail = { mode: 'tailscale', host: [100, 101, 102, 103].join('.'), tlsName: 'vps.tail1234.ts.net' };
  assert.equal(relayUrls(tail, {}, { cloudOnly: true }), null);
  assert.ok(relayUrls(tail, {}).urls.length >= 2);
  const cloud = relayUrls({ mode: 'cloud', origin: 'https://app.intelio-ai.com', cookie: 'CF_Authorization=x' }, {}, { cloudOnly: true });
  assert.deepEqual(cloud.urls, ['wss://app.intelio-ai.com/node/connect']);
});

test('indicator: shows while an agent works, says what, hides after a linger; Stop only from its own window', () => {
  const e = fakeElectron();
  const timers = [];
  let stops = 0;
  const ind = createIndicator({ ...e, onStop: () => { stops += 1; }, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  assert.equal(describeActivity([]), '');
  assert.equal(describeActivity(['run_command', 'read_file', 'run_command']), 'running a command, reading a file');
  ind.update(['run_command']);
  const win = e.windows[0];
  assert.ok(win.visible);
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.match(win.file, /indicator\.html$/);
  assert.deepEqual(win.sent.at(-1), ['intelio-node-indicator:state', { text: 'running a command', stopped: false }]);
  e.ipcMain.emit('intelio-node-indicator:stop', { sender: {} });
  assert.equal(stops, 0, 'a stop from another window is ignored');
  e.ipcMain.emit('intelio-node-indicator:stop', { sender: win.webContents });
  assert.equal(stops, 1);
  ind.update([]);
  assert.ok(win.visible, 'lingers');
  timers.at(-1).fn();
  assert.equal(win.visible, false);
  assert.equal(e.windows.length, 1, 'one window, reused');
});

test('pill and indicator HTML: brand rules (lowercase intelio, no yellow or lime)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/intelio/node/indicator.html'), 'utf8');
  assert.ok(!/Intelio|INTELIO/.test(html.replace(/intelioIndicator/g, '')));
  for (const bad of [/#ff0\b/i, /#ffff00/i, /yellow/i, /lime/i, /#[a-f0-9]{0,2}ff00\b/i, /#c6ff/i, /#d4ff/i]) assert.ok(!bad.test(html), String(bad));
});

function setup(t, { prefs = {}, env = {}, answer = 0 } = {}) {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const e = fakeElectron();
  const prompts = [];
  let saved = 0;
  const node = setupIntelioNode({
    app: { getPath: () => dir, getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    dialog: { showMessageBox: async (options) => { prompts.push(options); return { response: answer }; } },
    desktopCapturer: {}, screen: e.screen, BrowserWindow: e.BrowserWindow, ipcMain: e.ipcMain,
    getPrefs: () => prefs, savePreferences: () => { saved += 1; },
    remoteHermes: { nodeTarget: async () => null, computersRequest: async (p, o) => ({ path: p, ...(o || {}) }) },
    env: { ...env },
  });
  t.after(() => node.stop());
  return { node, prompts, prefs, saved: () => saved, e, dir };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('first run asks once in the app; Allow (the default button) turns access on', async (t) => {
  const s = setup(t, { answer: 0 });
  assert.equal(s.node.publicState().status, 'ask');
  s.node.start();
  await wait(1700);
  assert.equal(s.prompts.length, 1);
  assert.equal(s.prompts[0].message, 'Let my agents use this computer?');
  assert.deepEqual(s.prompts[0].buttons, ['Allow', 'Not now']);
  assert.equal(s.prompts[0].defaultId, 0);
  assert.deepEqual({ enabled: s.prefs.intelioNode.enabled, asked: s.prefs.intelioNode.asked }, { enabled: true, asked: true });
  assert.notEqual(s.node.publicState().status, 'off');
  assert.equal(s.node.client.state().enabled, true);
});

test('first run: Not now leaves access off; a held computer is never asked and never connects', async (t) => {
  const s = setup(t, { answer: 1 });
  s.node.start();
  await wait(1700);
  assert.equal(s.prefs.intelioNode.enabled, false);
  assert.equal(s.node.publicState().status, 'off');
  assert.equal(s.node.client.state().enabled, false);

  const h = setup(t, { env: { INTELIO_NODE_HOLD: '1' } });
  h.node.start();
  await wait(1700);
  assert.equal(h.prompts.length, 0);
  const state = h.node.publicState();
  assert.equal(state.status, 'held');
  assert.equal(state.held, true);
  assert.equal(h.node.client.state().enabled, false);
  // Ticking the box cannot start a held computer.
  await h.node.command('intelio-node-config', { enabled: true });
  assert.equal(h.node.client.state().enabled, false);
});

test('settings commands: local activity log (newest last on disk), computers API passthrough without keys', async (t) => {
  const s = setup(t, { prefs: { intelioNode: { asked: true, enabled: false } } });
  const file = path.join(s.dir, 'intelio-node', 'audit.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `partial-line"}\n${JSON.stringify({ time: 't1', tool: 'list_dir', ok: true })}\n${JSON.stringify({ time: 't2', tool: 'run_command', ok: false })}\n`);
  const audit = await s.node.command('intelio-node-audit', { limit: 1 });
  assert.deepEqual(audit.entries.map((e) => e.tool), ['run_command']);
  assert.equal(readLocalAudit(file, 10).length, 2);
  assert.deepEqual(await s.node.command('intelio-computers', {}), { path: '/api/computers' });
  assert.deepEqual(await s.node.command('intelio-computers-pause', { computer: 'cloud', paused: true }), { path: '/api/computers/pause', method: 'POST', body: { computer: 'cloud', paused: true } });
  assert.deepEqual(await s.node.command('intelio-computers-audit', { limit: 9999 }), { path: '/api/computers/audit?limit=500' });
});

test('client reports activity start/end through a real relay so the pill, Settings and the relay list show it', { timeout: 30000 }, async (t) => {
  const http = require('node:http');
  const { createNodeClient } = require('../src/intelio/node/client.cjs');
  const { createNodeRegistry, createNodeHub } = require('../../mobile/pwa/nodes.cjs');
  const dir = tmp();
  const hub = createNodeHub({ registry: createNodeRegistry({ file: path.join(dir, 'nodes.json') }), log: () => {}, auditFile: path.join(dir, 'relay-audit.jsonl') });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => hub.accept(req, socket, head, { login: 'test' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let saved = null;
  let release;
  const events = [];
  const client = createNodeClient({
    getTarget: async () => ({ urls: [`ws://127.0.0.1:${server.address().port}/node/connect`], mode: 'test' }),
    getInfo: () => ({ name: 'Desk', os: 'Test OS', arch: 'x64', user: 'me', version: '1' }),
    identity: { available: () => true, load: () => saved, save: (v) => { saved = v; }, clear: () => { saved = null; } },
    executors: { run: () => new Promise((r) => { release = r; }) },
    onActivity: (e) => events.push(e),
    backoff: () => 50,
  });
  t.after(() => { client.stop(); hub.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  client.start();
  for (let i = 0; i < 200 && client.state().status !== 'online'; i++) await wait(25);
  assert.equal(client.state().status, 'online');
  const pending = hub.call('desk', 'run_command', { computer: 'desk', command: 'echo hi' });
  for (let i = 0; i < 200 && !release; i++) await wait(10);
  assert.deepEqual(events.map((e) => [e.phase, e.tool, e.active]), [['start', 'run_command', ['run_command']]]);
  assert.deepEqual(client.active().map((a) => a.tool), ['run_command']);
  const busy = hub.listComputers({ detail: true }).find((c) => c.name === 'Desk');
  assert.equal(busy.in_use, true);
  assert.equal(busy.current_tool, 'run_command');
  release({ ok: true, content: [{ type: 'text', text: '{}' }], meta: { exit_code: 0 } });
  const result = await pending;
  assert.equal(result.isError, false);
  assert.deepEqual(events.at(-1).active, []);
  assert.equal(hub.listComputers({ detail: true }).find((c) => c.name === 'Desk').in_use, false);
});
