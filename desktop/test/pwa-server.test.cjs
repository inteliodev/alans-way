const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const KEY = 'sample-demo-key-not-real-0001';

function mockHermes() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('{"status":"ok"}'); return; }
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; res.end('{"error":"no"}'); return; }
    if (req.url === '/p/intelio/v1/capabilities') { res.end('{"features":{"session_chat_streaming":true}}'); return; }
    if (req.url.startsWith('/p/intelio/api/sessions?')) {
      res.end(JSON.stringify({ data: [{ id: 'sample-tg', source: 'telegram', title: 'SAMPLE DATA · Telegram' }] }));
      return;
    }
    if (req.url.startsWith('/p/intelio/api/sessions/sample-tg/messages')) {
      res.end(JSON.stringify({ data: [{ role: 'assistant', content: 'SAMPLE DATA — phone fixture' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/p/intelio/api/sessions/sample-tg/chat/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: assistant.delta\ndata: {"delta":"SAMPLE DATA"}\n\n');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function allowLocal(ip) {
  return String(ip).endsWith('127.0.0.1') ? { ok: true, login: 'owner@example' } : { ok: false, reason: 'not a tailnet peer' };
}

function request(port, method, pathname, { cookie = '', body, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(origin ? { origin, host: `127.0.0.1:${port}` } : {}), ...(body && !headers['content-type'] ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the phone service refuses a public bind', () => {
  assert.throws(() => createPwaServer({ bind: 'example.invalid', upstream: 'http://127.0.0.1:9' }), /Refusing to listen/);
  assert.throws(() => createPwaServer({ bind: '127.0.0.1', upstream: 'http://example.invalid:8642' }), /tailnet or loopback/);
});

test('tailscale identity keeps the key out of the browser and proxies sample sessions', async () => {
  const upstream = await mockHermes();
  const logs = [];
  const denied = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, fetchImpl: globalThis.fetch,
    profileKey: KEY, identify: async () => ({ ok: false, reason: 'login not allowed', login: 'other@example' }), log: (line) => logs.push(line),
  });
  const deniedAddress = await denied.listen();
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, fetchImpl: globalThis.fetch,
    profileKey: KEY, identify: allowLocal,
  });
  const address = await app.listen();
  try {
    const blocked = await request(deniedAddress.port, 'GET', '/api/sessions');
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.includes(KEY), false);
    assert.equal(logs.some((line) => line.includes('other@example') && line.includes('denied')), true);
    assert.equal(logs.some((line) => line.includes(KEY)), false);
    const page = await request(address.port, 'GET', '/app.js');
    assert.equal(page.status, 200);
    assert.equal(page.body.includes(KEY), false);
    assert.equal(page.body.includes('API_SERVER_KEY'), false);
    assert.doesNotMatch(page.body, /Profile key/);
    const icon = await request(address.port, 'GET', '/icon-192.png');
    assert.equal(icon.status, 200);
    assert.equal(icon.body.slice(1, 4), 'PNG');
    const badOrigin = await request(address.port, 'POST', '/session', { body: JSON.stringify({ key: KEY }), origin: 'https://example.invalid' });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.body.includes(KEY), false);
    const posted = 'posted-secret-value-not-a-real-key';
    const rejected = await request(address.port, 'POST', '/session', { body: JSON.stringify({ key: posted }) });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.body.includes(posted), false);
    const login = await request(address.port, 'GET', '/session');
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /HttpOnly/);
    assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
    assert.equal(login.body.includes(KEY), false);
    assert.match(login.body, /owner@example/);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const sessions = await request(address.port, 'GET', '/api/sessions', { cookie });
    assert.match(sessions.body, /SAMPLE DATA/);
    assert.equal(sessions.body.includes(KEY), false);
    const messages = await request(address.port, 'GET', '/api/sessions/sample-tg/messages', { cookie });
    assert.match(messages.body, /phone fixture/);
    const stream = await request(address.port, 'POST', '/api/sessions/sample-tg/chat', { cookie, body: JSON.stringify({ input: 'hi' }) });
    assert.match(stream.body, /assistant.delta/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => denied.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('static client has no embedded bearer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/app.js'), 'utf8');
  assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9]/);
  assert.doesNotMatch(source, /API_SERVER_KEY\s*=/);
  assert.match(source, /Ask \$\{/);
  assert.match(source, /Tailscale identity is not allowed/);
});

test('sample phone data is loopback-only and labeled', async () => {
  assert.throws(() => createPwaServer({ bind: 'phone.tail9c1007.ts.net', sample: true, upstream: 'http://127.0.0.1:9' }), /loopback-only/);
  const app = createPwaServer({ bind: '127.0.0.1', port: 0, sample: true, upstream: 'http://127.0.0.1:9', fetchImpl: async () => { throw new Error('upstream'); } });
  const address = await app.listen();
  try {
    const homeDenied = await request(address.port, 'GET', '/api/home');
    assert.equal(homeDenied.status, 200);
    const home = JSON.parse(homeDenied.body);
    assert.equal(home.sample, true);
    assert.equal(home.label, 'SAMPLE DATA');
    assert.ok(home.profiles.length >= 3);
    const lamp = await request(address.port, 'GET', '/api/sessions/sample-lamp/messages');
    assert.match(lamp.body, /Searched 3 marketplaces/);
    assert.match(lamp.body, /SAMPLE DATA/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('voice routes use the server engine and never echo a posted secret', async () => {
  const upstream = await mockHermes();
  let transcribed = 0;
  const voice = {
    async status() { return { vps: true, whisper: true, piper: true }; },
    async transcribe(audio) { transcribed += 1; assert.ok(audio.length > 10); return { text: 'heard a sentence' }; },
    async synthesize(text) { assert.equal(text, 'Hello there.'); return { wav: Buffer.from('RIFFsample') }; },
  };
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, fetchImpl: globalThis.fetch,
    profileKey: KEY, identify: allowLocal, voice,
  });
  const address = await app.listen();
  try {
    const login = await request(address.port, 'GET', '/session');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const stt = await request(address.port, 'POST', '/api/voice/stt', { cookie, body: `RIFF${'a'.repeat(20)}` });
    assert.equal(stt.status, 200);
    assert.match(stt.body, /heard a sentence/);
    assert.equal(transcribed, 1);
    const tts = await request(address.port, 'POST', '/api/voice/tts', { cookie, body: JSON.stringify({ text: 'Hello there.' }) });
    assert.equal(tts.status, 200);
    assert.match(String(tts.headers['content-type']), /audio\/wav/);
    assert.equal(tts.body.includes(KEY), false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
