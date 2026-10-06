const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chooseConnection, cloudTargets, labelWithMode, isAccessResponse, normalizeConnectionMode, CLOUD_API, CLOUD_DESKTOP } = require('../src/intelio/cloud-connection.cjs');
const { createRemoteHermesClient } = require('../src/intelio/remote-hermes.cjs');

test('connection mode falls back to auto for anything else', () => {
  assert.equal(normalizeConnectionMode('auto'), 'auto');
  assert.equal(normalizeConnectionMode('Tailscale'), 'tailscale');
  assert.equal(normalizeConnectionMode('cloud'), 'cloud');
  assert.equal(normalizeConnectionMode('public'), 'auto');
  assert.equal(normalizeConnectionMode(''), 'auto');
});

test('cloud targets stay on the Intelio hostnames unless e2e loopback is set', () => {
  assert.deepEqual(cloudTargets({}), { origin: CLOUD_API, desktop: CLOUD_DESKTOP });
  assert.deepEqual(cloudTargets({ INTELIO_E2E: '1', INTELIO_CLOUD_API: 'https://example.com', INTELIO_CLOUD_DESKTOP: 'https://example.com/vnc.html' }), { origin: CLOUD_API, desktop: CLOUD_DESKTOP });
  assert.deepEqual(cloudTargets({ INTELIO_E2E: '1', INTELIO_CLOUD_API: 'http://127.0.0.1:9', INTELIO_CLOUD_DESKTOP: 'http://127.0.0.1:9/vnc.html' }), {
    origin: 'http://127.0.0.1:9',
    desktop: 'http://127.0.0.1:9/vnc.html',
  });
});

test('auto uses Tailscale only when /health is Hermes, otherwise Cloud', async () => {
  let calls = 0;
  const unreachable = () => { calls += 1; return Promise.reject(new Error('refused')); };
  const cloud = await chooseConnection({ mode: 'auto', host: '127.0.0.1', port: 9, fetchImpl: unreachable, env: {} });
  assert.equal(cloud.mode, 'cloud');
  assert.equal(cloud.origin, CLOUD_API);
  assert.equal(cloud.partition, 'persist:intelio-cloud');
  assert.equal(calls, 1);

  const explicit = await chooseConnection({ mode: 'tailscale', host: '127.0.0.1', port: 9, fetchImpl: () => { throw new Error('should not probe'); }, env: {} });
  assert.equal(explicit.mode, 'tailscale');
  assert.equal(explicit.origin, 'http://127.0.0.1:9');

  let probed = 0;
  const forced = await chooseConnection({ mode: 'cloud', host: '127.0.0.1', port: 9, fetchImpl: () => { probed += 1; return Promise.reject(new Error('no')); }, env: {} });
  assert.equal(forced.mode, 'cloud');
  assert.equal(probed, 0);

  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const timed = await chooseConnection({ mode: 'auto', host: '127.0.0.1', port: 9, fetchImpl: hanging, timeoutMs: 200, env: {} });
  assert.equal(timed.mode, 'cloud');
  assert.ok(Date.now() - started < 2000);

  const healthy = async () => ({ status: 200, text: async () => '{"platform":"hermes-agent","version":"0.21.5"}' });
  const tail = await chooseConnection({ mode: 'auto', host: '127.0.0.1', port: 8642, fetchImpl: healthy, env: {} });
  assert.equal(tail.mode, 'tailscale');
  assert.equal(tail.desktop, '');
});

test('status label names the active mode once', () => {
  assert.equal(labelWithMode('hermes-agent 0.21.5', 'cloud'), 'hermes-agent 0.21.5 · Cloud');
  assert.equal(labelWithMode('hermes-agent 0.21.5 · Cloud', 'cloud'), 'hermes-agent 0.21.5 · Cloud');
  assert.equal(labelWithMode('hermes-agent 0.21.5', 'tailscale'), 'hermes-agent 0.21.5 · Tailscale');
  assert.equal(labelWithMode('', 'cloud'), '');
});

test('access challenges are redirects, denials, and HTML', () => {
  assert.equal(isAccessResponse({ status: 302, headers: { get: () => '' } }), true);
  assert.equal(isAccessResponse({ status: 401, headers: { get: () => 'application/json' } }), true);
  assert.equal(isAccessResponse({ status: 200, type: 'opaqueredirect', headers: { get: () => '' } }), true);
  assert.equal(isAccessResponse({ status: 200, headers: { get: () => 'text/html' } }), true);
  assert.equal(isAccessResponse({ status: 200, headers: { get: () => 'application/json' } }, '<html>'), true);
  assert.equal(isAccessResponse({ status: 200, headers: { get: () => 'application/json' } }, '{"status":"ok"}'), false);
});

test('cloud health uses the origin and treats an Access redirect as sign-in', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = 302;
      res.setHeader('location', '/access/login');
      res.end('');
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const client = createRemoteHermesClient({
      getConfig: async () => ({ enabled: true, host: '127.0.0.1', port: 1, profile: 'intelio', origin: `http://127.0.0.1:${port}`, activeMode: 'cloud' }),
      getKey: async () => 'k'.repeat(32),
    });
    await assert.rejects(client.health(), (error) => error.code === 'CLOUD_ACCESS' && error.message === 'Sign in to Intelio');
  } finally {
    server.close();
  }
});
