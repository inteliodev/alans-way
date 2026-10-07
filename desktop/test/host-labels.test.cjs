const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hostLabels, remoteModeOn, vpsHermesLine, hermesChecklist } = require('../src/intelio/host-labels.cjs');

test('Windows labels say this PC and Mac labels stay Mac', () => {
  const win = hostLabels('win32');
  const mac = hostLabels('darwin');
  assert.equal(win.pane, 'This PC');
  assert.equal(mac.pane, 'Your Mac');
  assert.match(win.sshField, /This PC’s SSH address/);
  assert.match(win.sshSaved, /This PC’s SSH address saved/);
  assert.match(win.connector, /this PC’s browser connector/);
  assert.match(win.setupWires, /this PC’s browser connector/);
  assert.equal(win.promptSsh.includes('Mac'), false);
  assert.match(mac.sshField, /This Mac’s SSH address/);
  assert.match(mac.connector, /this Mac’s browser connector/);
  assert.equal(hostLabels('linux').pane, 'This computer');
});

test('remote settings hide the local Hermes pin and show the VPS version', () => {
  const remote = { enabled: true, host: 'intelio-vps.tail9c1007.ts.net', port: 8642, versionLabel: 'hermes-agent 0.21.5 · Cloud' };
  const broken = { ok: false, error: 'Python was not found.', hermes: { match: 'unavailable', pinCommit: '', summary: 'profile not loaded' } };
  assert.equal(remoteModeOn(remote), true);
  assert.equal(remoteModeOn({ enabled: false, host: remote.host }), false);
  const line = hermesChecklist({ remoteHermes: remote, intelio: broken });
  assert.equal(line.done, true);
  assert.equal(line.label, 'VPS Hermes hermes-agent 0.21.5 · Cloud');
  assert.equal(/pin missing|Python was not|Hermes command/i.test(line.label), false);
  const waiting = hermesChecklist({ remoteHermes: { enabled: true, host: remote.host, versionLabel: '' }, intelio: broken });
  assert.equal(waiting.done, false);
  assert.equal(waiting.label, 'VPS Hermes version is still loading.');
  assert.equal(vpsHermesLine(remote), line.label);
  const local = hermesChecklist({ remoteHermes: { enabled: false }, intelio: broken });
  assert.match(local.label, /Hermes pin missing/);
});

test('light theme paints the screen grid with theme borders', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/theme-light.css'), 'utf8');
  assert.match(css, /html\[data-theme="light"\] \.screen-grid \{[^}]*background: #f6f6f8/);
  assert.match(css, /html\[data-theme="light"\] \.screen-cell \{[^}]*border: 1px solid #d5d5dc/);
  const ui = fs.readFileSync(path.join(__dirname, '../src/intelio-ui.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  assert.match(ui, /remoteModeOn/);
  assert.match(ui, /vpsHermesLine/);
  assert.match(renderer, /state\?\.host\?\.pane/);
  assert.match(renderer, /hermesChecklist/);
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  assert.equal(html.includes('host-labels.cjs'), false);
});
