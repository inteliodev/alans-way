const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isTailnetOrLoopbackHost, normalizeRemoteConfig, baseUrl, redactKey, createSseParser, createRemoteHermesClient, remoteHermesDefaults, remoteVersionLabel, VPS_HOST, VNC_URL } = require('../src/intelio/remote-hermes.cjs');

const KEY = 'k'.repeat(64);
const ip = (...parts) => parts.join('.');
const vps = ip(100, 111, 128, 12);

test('only tailnet or loopback hosts are accepted', () => {
  for (const host of [vps, ip(100, 64, 0, 1), ip(100, 127, 255, 254), 'intelio-vps.tail9c1007.ts.net', 'fd7a:115c:a1e0::382c:800d', '[fd7a:115c:a1e0::1]', '127.0.0.1', 'localhost', '::1']) {
    assert.equal(isTailnetOrLoopbackHost(host), true, host);
  }
  for (const host of [ip(192, 0, 2, 1), ip(100, 63, 0, 1), ip(100, 128, 0, 1), ip(10, 0, 0, 5), ip(192, 168, 1, 2), 'example.com', 'intelio-vps', 'ts.net.evil.com', '2001:db8::1', '']) {
    assert.equal(isTailnetOrLoopbackHost(host), false, host);
  }
  assert.throws(() => normalizeRemoteConfig({ host: ip(192, 0, 2, 1) }), /Tailscale/);
  assert.throws(() => normalizeRemoteConfig({ host: 'os.intelio-ai.com' }), /Tailscale/);
});

test('config normalizes profile and builds the /p/<profile> prefix', () => {
  assert.deepEqual(normalizeRemoteConfig({ host: vps, profile: 'Intelio', enabled: true }), { enabled: true, host: vps, port: 8642, profile: 'intelio' });
  assert.equal(baseUrl({ host: vps, profile: 'intelio' }), `http://${vps}:8642/p/intelio`);
  assert.equal(baseUrl({ host: vps, profile: 'default' }), `http://${vps}:8642`);
  assert.equal(baseUrl({ host: 'fd7a:115c:a1e0::1', port: 9000 }), 'http://[fd7a:115c:a1e0::1]:9000');
  assert.throws(() => normalizeRemoteConfig({ host: vps, profile: '../etc' }), /profile/);
  assert.throws(() => normalizeRemoteConfig({ host: vps, port: 70000 }), /port/);
});

test('windows first launch defaults to the VPS; other platforms stay opt-in', () => {
  assert.deepEqual(remoteHermesDefaults('win32'), { enabled: true, host: VPS_HOST, port: 8642, profile: 'intelio', connection: 'auto' });
  assert.deepEqual(remoteHermesDefaults('darwin'), { enabled: false, host: '', port: 8642, profile: 'intelio', connection: 'auto' });
  assert.equal(VPS_HOST, 'intelio-vps.tail9c1007.ts.net');
  assert.equal(VNC_URL, 'http://intelio-vps.tail9c1007.ts.net:6080/vnc.html');
});

test('remote status uses the VPS version, or a pin when that is all the remote sends', () => {
  assert.equal(remoteVersionLabel({ status: 'ok', platform: 'hermes-agent', version: '0.21.5' }), 'hermes-agent 0.21.5');
  assert.equal(remoteVersionLabel({ platform: 'hermes-agent', version: 'hermes-agent 0.21.5' }), 'hermes-agent 0.21.5');
  assert.equal(remoteVersionLabel({ commit: '5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662' }), 'pin 5d3c05977bb3');
  assert.equal(remoteVersionLabel({ status: 'ok' }), '');
});

test('keys are redacted from errors', () => {
  assert.equal(redactKey(`bad ${KEY} here`, KEY), 'bad [redacted] here');
  assert.match(redactKey('Authorization: Bearer abcdefghijklmnop'), /Bearer \[redacted\]/);
});

test('SSE parser handles split chunks, CRLF and keepalives', () => {
  const events = [];
  const feed = createSseParser((evt) => events.push(evt));
  feed(': keepalive\n\nevent: assistant.delta\ndata: {"delta":"A');
  feed('B"}\n\nevent: done\r\ndata: {}\r\n\r\n');
  assert.deepEqual(events, [{ event: 'assistant.delta', data: { delta: 'AB' } }, { event: 'done', data: {} }]);
});

function stubServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.url === '/health') { res.end('{"status":"ok","platform":"hermes-agent","version":"0.21.5"}'); return; }
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; res.end(`{"error":"invalid key ${req.headers.authorization}"}`); return; }
    if (req.method === 'GET' && req.url.startsWith('/p/intelio/api/sessions?')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'tg1', source: 'telegram', title: 'Hi' }], has_more: false }));
      return;
    }
    if (req.method === 'POST' && req.url === '/p/intelio/api/sessions/tg1/chat/stream') {
      res.setHeader('content-type', 'text/event-stream');
      res.write('event: run.started\ndata: {"session_id":"tg1"}\n\n');
      res.write(': keepalive\n\n');
      res.write('event: assistant.delta\ndata: {"delta":"OK"}\n\n');
      res.end('event: assistant.completed\ndata: {"content":"OK","completed":true}\n\nevent: done\ndata: {}\n\n');
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

test('client lists shared sessions and streams a turn with the profile key', async () => {
  const { server, seen, port } = await stubServer();
  try {
    const client = createRemoteHermesClient({ getConfig: () => ({ host: '127.0.0.1', port, profile: 'intelio' }), getKey: async (profile) => (profile === 'intelio' ? KEY : '') });
    assert.deepEqual(await client.health(), { ok: true, status: 200, platform: 'hermes-agent', version: '0.21.5', label: 'hermes-agent 0.21.5' });
    const list = await client.listSessions({ limit: 5 });
    assert.equal(list.data[0].source, 'telegram');
    const events = [];
    const text = await client.chat('tg1', 'hello', { onEvent: (evt) => events.push(evt.event) });
    assert.equal(text, 'OK');
    assert.deepEqual(events, ['run.started', 'assistant.delta', 'assistant.completed', 'done']);
    assert.ok(seen.filter((r) => r.url !== '/health').every((r) => r.auth === `Bearer ${KEY}`));
  } finally { server.close(); }
});

test('a wrong key surfaces 401 without leaking the key', async () => {
  const { server, port } = await stubServer();
  try {
    const wrong = 'w'.repeat(64);
    const client = createRemoteHermesClient({ getConfig: () => ({ host: '127.0.0.1', port, profile: 'intelio' }), getKey: async () => wrong });
    await assert.rejects(client.listSessions(), (error) => error.status === 401 && /own API_SERVER_KEY/.test(error.message) && !error.message.includes(wrong));
  } finally { server.close(); }
});

test('missing key and public hosts never send a request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('should not fetch'); };
  const noKey = createRemoteHermesClient({ getConfig: () => ({ host: vps, profile: 'intelio' }), getKey: async () => '', fetchImpl });
  await assert.rejects(noKey.listSessions(), /No API key/);
  const publicHost = createRemoteHermesClient({ getConfig: () => ({ host: ip(192, 0, 2, 1), profile: 'intelio' }), getKey: async () => KEY, fetchImpl });
  await assert.rejects(publicHost.listSessions(), /Tailscale/);
  assert.equal(called, false);
});
