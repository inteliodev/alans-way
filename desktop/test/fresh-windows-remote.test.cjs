const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signatureOf } = require('../../mobile/pwa/orbs.cjs');
const { VPS_HOST, VNC_URL } = require('../src/intelio/remote-hermes.cjs');
const { freshWindowPlan, loadPreferences } = require('../src/intelio/preferences.cjs');
const { createRemoteMain } = require('../src/intelio/remote-main-data.cjs');
const { seedAgents } = require('../src/remote-main.js');
const { runPackagedSmoke } = require('../src/intelio/smoke.cjs');

const KEYS = ['intelio', 'prc', 'alignment', 'hhp'];

test('a fresh Windows profile with a keystore is remote and lists the four agents', () => {
  const plan = freshWindowPlan({ platform: 'win32', preferencesText: null, keyNames: KEYS });
  assert.equal(plan.remote, true);
  assert.equal(plan.telegramSignIn, false);
  assert.equal(plan.host, VPS_HOST);
  assert.equal(plan.port, 8642);
  assert.equal(plan.profile, 'intelio');
  assert.equal(plan.desktop, VNC_URL);
  assert.deepEqual(plan.agents.map((agent) => [agent.id, agent.orb]), [
    ['intelio', 'connecting'],
    ['prc', 'solving'],
    ['alignment', 'searching'],
    ['hhp', 'weaving'],
  ]);
  for (const agent of plan.agents) assert.equal(agent.orb, signatureOf(agent.id));
  assert.deepEqual(seedAgents(KEYS, 'intelio').map((agent) => agent.id), KEYS);
  assert.equal(runPackagedSmoke(), 0);
});

test('macOS without a settings file stays on local Telegram', () => {
  const plan = freshWindowPlan({ platform: 'darwin', preferencesText: null, keyNames: KEYS });
  assert.equal(plan.remote, false);
  assert.equal(plan.telegramSignIn, true);
  assert.equal(plan.host, '');
  assert.equal(plan.desktop, '');
  assert.deepEqual(plan.agents, []);
});

test('an incomplete remoteHermes object does not wipe the Windows host, and enabled false stays off', () => {
  const empty = freshWindowPlan({ platform: 'win32', preferencesText: JSON.stringify({ remoteHermes: {} }), keyNames: KEYS });
  assert.equal(empty.remote, true);
  assert.equal(empty.host, VPS_HOST);
  assert.equal(empty.telegramSignIn, false);
  assert.equal(empty.agents.length, 4);

  const blankHost = freshWindowPlan({
    platform: 'win32',
    preferencesText: JSON.stringify({ remoteHermes: { enabled: true, host: '' } }),
    keyNames: ['intelio'],
  });
  assert.equal(blankHost.host, VPS_HOST);
  assert.equal(blankHost.remote, true);

  const off = freshWindowPlan({
    platform: 'win32',
    preferencesText: JSON.stringify({ remoteHermes: { enabled: false, host: VPS_HOST } }),
    keyNames: KEYS,
  });
  assert.equal(off.remote, false);
  assert.equal(off.telegramSignIn, true);
  assert.deepEqual(off.agents, []);

  const missingField = loadPreferences({ text: JSON.stringify({ chatWidth: 400 }), platform: 'win32' });
  assert.equal(missingField.prefs.remoteHermes.host, VPS_HOST);
  assert.equal(missingField.prefs.remoteHermes.enabled, true);
  assert.equal(missingField.prefs.chatWidth, 400);
  assert.equal(missingField.prefs.remoteUrl, VNC_URL);

  const custom = loadPreferences({
    text: JSON.stringify({ remoteUrl: 'http://127.0.0.1:6080/vnc.html', remoteHermes: { enabled: true } }),
    platform: 'win32',
  });
  assert.equal(custom.prefs.remoteUrl, 'http://127.0.0.1:6080/vnc.html');
  const disabled = loadPreferences({
    text: JSON.stringify({ remoteHermes: { enabled: false, host: VPS_HOST } }),
    platform: 'win32',
  });
  assert.equal(disabled.prefs.remoteUrl, '');
});

test('a hung /api/home probe falls back to key names instead of waiting', async () => {
  const started = Date.now();
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const main = createRemoteMain({
    getConfig: () => ({ enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio' }),
    getKey: async () => 'k'.repeat(32),
    keyNames: () => KEYS,
    fetchImpl,
    probeTimeoutMs: 40,
  });
  const home = await main.listAgents();
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(home.agents.map((agent) => agent.id), KEYS);
});
