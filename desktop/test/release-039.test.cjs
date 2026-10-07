const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVaultStore } = require('../src/intelio/vault.cjs');
const { startCall, tickCall, endCall, callPill } = require('../src/intelio/calls.cjs');
const { buildFill, publicFill } = require('../src/intelio/login-fill.cjs');
const { initialDesktopTab, loadPreferences } = require('../src/intelio/preferences.cjs');

test('the bops module has no approval card', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/intelio/bops.cjs'), 'utf8');
  assert.equal(source.includes('Needs you'), false);
  assert.equal(source.includes('Not now'), false);
  assert.equal(source.includes('Approve'), false);
  assert.equal(source.includes('actOnCard'), false);
});

test('threads caption does not repeat AGENTS and the theme control accepts a pointer', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/remote-main.css'), 'utf8');
  const style = fs.readFileSync(path.join(__dirname, '../src/style.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(css, /\.side-caption:not\(\.threads-caption\)::before/);
  assert.equal(css.includes('.side-caption::before { content: "AGENTS"; }'), false);
  assert.match(style, /\.theme-row\{[^}]*-webkit-app-region:no-drag/);
  assert.match(style, /\.theme-toggle\{[^}]*-webkit-app-region:no-drag/);
  assert.match(renderer, /pointerup/);
  assert.match(renderer, /applyTheme\(next\)/);
  assert.match(main, /initialDesktopTab\(remoteOn\)/);
  assert.equal(initialDesktopTab(true), 'vps');
  assert.equal(initialDesktopTab(false), 'home');
  const saved = loadPreferences({ text: JSON.stringify({ screenGrid: 3, activeScreen: 1, theme: 'dark' }) });
  assert.equal(saved.prefs.screenGrid, 3);
  assert.equal(saved.prefs.activeScreen, 1);
});

test('a call pill counts up and keeps the ending length', () => {
  const started = startCall(1_000);
  const mid = tickCall(started, 27_000);
  assert.equal(callPill(mid), 'in call 26s');
  const ended = endCall(mid, 27_400);
  assert.equal(ended.active, false);
  assert.equal(callPill(ended), '26s - Call ended');
});

test('saved logins are profile-isolated and the tool result hides the secret', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vault-'));
  const store = createVaultStore({ root });
  const secret = 'hhp-only-secret-value';
  store.saveLogin('hhp', { domain: 'bank.example', username: 'hhp-user', password: secret, otp: '998877' });
  const listed = store.list('hhp');
  assert.deepEqual(listed, [{ domain: 'bank.example', username: 'hhp-user' }]);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  const tool = store.toolResult('hhp', 'https://login.bank.example/session');
  assert.equal(tool.filled, true);
  assert.equal(tool.username, 'hhp-user');
  assert.equal(JSON.stringify(tool).includes(secret), false);
  assert.equal(JSON.stringify(tool).includes('998877'), false);
  const filler = store.fillerPayload('hhp', 'bank.example');
  assert.equal(filler.password, secret);
  fs.mkdirSync(path.join(root, 'prc'), { recursive: true });
  fs.copyFileSync(path.join(root, 'hhp', 'vault'), path.join(root, 'prc', 'vault'));
  assert.deepEqual(store.list('prc'), []);
  assert.equal(store.toolResult('prc', 'bank.example').filled, false);
  assert.equal(JSON.stringify(store.toolResult('prc', 'bank.example')).includes(secret), false);
  const instruction = buildFill({ domain: 'bank.example', username: 'hhp-user', password: secret, otp: '998877' });
  assert.equal(JSON.stringify(publicFill(instruction)).includes(secret), false);
});

test('the maximize script is harness-side and names the display', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../scripts/bot-desktop-maximize.sh'), 'utf8');
  assert.match(script, /wmctrl/);
  assert.match(script, /:20/);
  assert.match(script, /window-position=0,0/);
  assert.equal(script.includes('hermes/hermes'), false);
});
