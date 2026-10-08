const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installUrl, assertInstallUrl, parseStatus, firstRunMessage, checkTailscale } = require('../src/intelio/tailscale.cjs');

test('install links stay on tailscale.com', () => {
  assert.equal(installUrl('win32'), 'https://tailscale.com/download/windows');
  assert.equal(assertInstallUrl(installUrl('darwin')), 'https://tailscale.com/download/mac');
  assert.throws(() => assertInstallUrl('https://example.invalid/tailscale'), /Unexpected/);
});

test('status JSON decides connected vs signed out', () => {
  assert.equal(parseStatus('{"BackendState":"Running","Self":{"DNSName":"intelio-vps.tail9c1007.ts.net."}}').connected, true);
  assert.match(parseStatus('{"BackendState":"NeedsLogin"}').detail, /not connected/);
  assert.equal(parseStatus('not-json').connected, false);
});

test('first-run copy asks to install or to connect', () => {
  assert.equal(firstRunMessage({ installed: false }).install, true);
  assert.equal(firstRunMessage({ installed: true, connected: false, detail: 'Tailscale is installed but not connected.' }).install, false);
  assert.equal(firstRunMessage({ installed: true, connected: true }), null);
});

test('a missing binary is not installed and does not throw', async () => {
  const status = await checkTailscale({
    platform: 'linux',
    bins: ['/usr/bin/tailscale'],
    exists: () => false,
    run: async () => { throw new Error('should not run'); },
  });
  assert.equal(status.installed, false);
  assert.match(status.installUrl, /^https:\/\/tailscale\.com\/download/);
});

test('version plus running status is connected', async () => {
  const status = await checkTailscale({
    platform: 'win32',
    bins: ['tailscale'],
    exists: () => true,
    run: async (_bin, args) => args[0] === 'version'
      ? { code: 0, stdout: '1.0.0', stderr: '' }
      : { code: 0, stdout: '{"BackendState":"Running"}', stderr: '' },
  });
  assert.equal(status.connected, true);
  assert.equal(status.installUrl, 'https://tailscale.com/download/windows');
});
