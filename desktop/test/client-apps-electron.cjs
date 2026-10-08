// Run: npx electron test/client-apps-electron.cjs
// Isolated profile. Outbound requests are cancelled, so nothing reaches Google or Microsoft.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, webContents, session } = require('electron');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-workspace-client-apps-'));
process.env.HERMES_WORKSPACE_DATA = profile;
process.env.HERMES_WORKSPACE_PORT = String(19000 + Math.floor(Math.random() * 10000));
require('../src/main.cjs');
const waitFor = async (read, predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out.');
};
app.whenReady().then(async () => {
  const seen = [];
  for (const id of ['prc', 'hhp', 'intelio', 'alignment', 'arlp']) {
    session.fromPartition(`persist:client-${id}`).webRequest.onBeforeRequest((details, callback) => {
      if (/^https?:/.test(details.url)) { seen.push({ id, url: details.url }); return callback({ cancel: true }); }
      callback({});
    });
  }
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], (w) => !!w);
  const wc = win.webContents;
  const telegram = webContents.getAllWebContents().find((item) => item.session === session.fromPartition('persist:telegram'));
  if (telegram) { telegram.stop(); await telegram.loadURL('about:blank'); }
  const evaluate = (code) => wc.executeJavaScript(code);
  await waitFor(() => evaluate('typeof window.workspace === "object"').catch(() => false), Boolean);
  const invoke = (name, value) => evaluate(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value || {})})`);

  await assert.rejects(() => invoke('open-client-app', { client: 'prc', app: 'https://evil.example/' }));
  await assert.rejects(() => invoke('open-client-app', { client: 'nobody', app: 'mail' }));

  const hhp = await invoke('open-client-app', { client: 'hhp', app: 'teams' });
  const prc = await invoke('open-client-app', { client: 'prc', app: 'mail' });
  assert.equal(hhp.client, 'hhp');
  assert.equal(prc.client, 'prc');
  await waitFor(() => seen, (list) => list.some((item) => item.id === 'hhp') && list.some((item) => item.id === 'prc'));
  assert.ok(seen.find((item) => item.id === 'hhp').url.startsWith('https://teams.microsoft.com/?login_hint=hayden%40hhpasset.com'), seen[0]?.url);
  assert.ok(seen.find((item) => item.id === 'prc').url.startsWith('https://mail.google.com/mail/'));
  const views = webContents.getAllWebContents();
  const hhpView = views.find((item) => item.session === session.fromPartition('persist:client-hhp'));
  const prcView = views.find((item) => item.session === session.fromPartition('persist:client-prc'));
  assert.ok(hhpView && prcView && hhpView.session !== prcView.session, 'each client has its own session');
  assert.notEqual(hhpView.session, session.fromPartition('persist:browser'));

  let status = await invoke('client-apps-status');
  assert.equal(status.clients.hhp.signedIn, false);
  await session.fromPartition('persist:client-hhp').cookies.set({ url: 'https://login.microsoftonline.com', name: 'ESTSAUTHPERSISTENT', value: 'test', secure: true, expirationDate: Date.now() / 1000 + 3600 });
  status = await invoke('client-apps-status');
  assert.equal(status.clients.hhp.signedIn, true, 'HHP jar signed in');
  assert.equal(status.clients.prc.signedIn, false, 'PRC jar untouched');
  assert.equal(status.clients.arlp.signedIn, false, 'ARLP jar untouched');

  status = await invoke('client-account', { client: 'arlp', account: 'me@arlp.com' });
  assert.equal(status.clients.arlp.account, 'me@arlp.com');
  await assert.rejects(() => invoke('client-account', { client: 'arlp', account: 'not an email' }));
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json'), 'utf8'));
  assert.equal(saved.clientAccounts.arlp, 'me@arlp.com');

  status = await invoke('client-sign-out', { client: 'hhp' });
  assert.equal(status.clients.hhp.signedIn, false);
  const state = await evaluate('window.workspace.getState()');
  assert.ok(!state.tabs.some((tab) => tab.client === 'hhp'), 'HHP tabs closed on sign-out');
  assert.ok(state.tabs.some((tab) => tab.client === 'prc'), 'PRC tab stays');
  console.log('client-apps electron: ok');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
