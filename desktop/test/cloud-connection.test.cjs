const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chooseConnection, cloudTargets, labelWithMode, isAccessResponse, mergeAccessCookies, normalizeConnectionMode, allowedSignInUrl, CLOUD_API, CLOUD_DESKTOP, PROBE_TIMEOUT_MS } = require('../src/intelio/cloud-connection.cjs');
const { createRemoteHermesClient } = require('../src/intelio/remote-hermes.cjs');

test('the Access cookie is read from the session and is not written into preferences', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '../src/intelio/remote-hermes-main.cjs'), 'utf8');
  const prefs = fs.readFileSync(path.join(__dirname, '../src/intelio/preferences.cjs'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, '../src/intelio-ui.js'), 'utf8');
  assert.equal(main.split('CF_Authorization').length - 1, 1);
  assert.match(main, /signInOpenedAt/);
  assert.equal(main.includes('loadURL(desktop)'), false);
  assert.match(main, /mergeAccessCookies/);
  assert.match(main, /onBeforeSendHeaders/);
  const shell = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  assert.match(shell, /activeMode === 'cloud'/);
  const client = fs.readFileSync(path.join(__dirname, '../src/intelio/remote-hermes.cjs'), 'utf8');
  assert.match(client, /'x-intelio-profile': profileName/);
  const probe = fs.readFileSync(path.join(__dirname, '../src/intelio/remote-main-data.cjs'), 'utf8');
  assert.match(probe, /'x-intelio-profile': profile/);
  assert.match(main, /cookies\.get\(\{ url: origin, name: 'CF_Authorization' \}\)/);
  assert.equal(prefs.includes('CF_Authorization'), false);
  assert.match(html, /Sign in again/);
  assert.equal(html.includes('Needs you'), false);
  assert.match(settings, /intelio cloud \(app\.intelio-ai\.com\)/);
  assert.match(settings, /intelio cloud/);
  assert.match(settings, /Tailscale/);
});

test('connection mode falls back to auto for anything else', () => {
  assert.equal(normalizeConnectionMode('auto'), 'auto');
  assert.equal(normalizeConnectionMode('Tailscale'), 'tailscale');
  assert.equal(normalizeConnectionMode('cloud'), 'cloud');
  assert.equal(normalizeConnectionMode('public'), 'auto');
  assert.equal(normalizeConnectionMode(''), 'auto');
});

test('cloud targets stay on the Intelio hostnames unless e2e loopback is set', () => {
  assert.equal(CLOUD_API, 'https://app.intelio-ai.com');
  assert.equal(CLOUD_DESKTOP, 'https://app.intelio-ai.com/browser/vnc.html?path=/browser/websockify');
  assert.ok(PROBE_TIMEOUT_MS >= 3000 && PROBE_TIMEOUT_MS <= 8000);
  assert.equal(allowedSignInUrl('https://app.intelio-ai.com/'), true);
  assert.equal(allowedSignInUrl('https://example.com/'), false);
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

test('access challenges are Cloudflare redirects or HTML, not a JSON profile error', () => {
  const headers = (map) => ({ get: (name) => map[String(name || '').toLowerCase()] || '' });
  assert.equal(isAccessResponse({ status: 302, headers: { get: () => '' } }), true);
  assert.equal(isAccessResponse({ status: 302, headers: headers({ location: 'https://intelio.cloudflareaccess.com/cdn-cgi/access/login' }) }), true);
  assert.equal(isAccessResponse({ status: 302, headers: headers({ location: '/cdn-cgi/access/login' }) }), true);
  assert.equal(isAccessResponse({ status: 302, headers: headers({ location: '/access/login' }) }), true);
  assert.equal(isAccessResponse({ status: 302, headers: headers({ location: 'https://example.com/elsewhere' }) }), false);
  assert.equal(isAccessResponse({ status: 401, headers: headers({ 'content-type': 'application/json' }) }, '{"error":"no"}'), false);
  assert.equal(isAccessResponse({ status: 403, headers: headers({ 'content-type': 'application/json' }) }, '{"error":"no"}'), false);
  assert.equal(isAccessResponse({ status: 200, type: 'opaqueredirect', headers: { get: () => '' } }), true);
  assert.equal(isAccessResponse({ status: 200, headers: { get: () => 'text/html' } }), true);
  assert.equal(isAccessResponse({ status: 401, headers: headers({ 'content-type': 'text/html' }) }, '<html>Sign in</html>'), true);
  assert.equal(isAccessResponse({ status: 200, headers: { get: () => 'application/json' } }, '<html>'), true);
  assert.equal(isAccessResponse({ status: 200, headers: { get: () => 'application/json' } }, '{"status":"ok"}'), false);
  assert.equal(mergeAccessCookies('', [{ name: 'CF_Authorization', value: 'jwt' }, { name: 'other', value: 'no' }]), 'CF_Authorization=jwt');
  assert.equal(mergeAccessCookies('CF_Authorization=jwt', [{ name: 'CF_Authorization', value: 'again' }]), 'CF_Authorization=jwt');
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
    await assert.rejects(client.health(), (error) => error.code === 'CLOUD_ACCESS' && error.message === 'Sign in to intelio');
  } finally {
    server.close();
  }
});
