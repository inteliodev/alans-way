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

function request(port, method, pathname, { cookie = '', body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin, host: `127.0.0.1:${port}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
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

test('login keeps the key out of the browser and proxies sample sessions', async () => {
  const upstream = await mockHermes();
  const app = createPwaServer({ bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, fetchImpl: globalThis.fetch });
  const address = await app.listen();
  try {
    const page = await request(address.port, 'GET', '/app.js');
    assert.equal(page.status, 200);
    assert.equal(page.body.includes(KEY), false);
    assert.equal(page.body.includes('API_SERVER_KEY'), false);
    const icon = await request(address.port, 'GET', '/icon-192.png');
    assert.equal(icon.status, 200);
    assert.equal(icon.body.slice(1, 4), 'PNG');
    const denied = await request(address.port, 'GET', '/api/sessions');
    assert.equal(denied.status, 401);
    const badOrigin = await request(address.port, 'POST', '/session', { body: JSON.stringify({ key: KEY }), origin: 'https://example.invalid' });
    assert.equal(badOrigin.status, 403);
    const login = await request(address.port, 'POST', '/session', { body: JSON.stringify({ key: KEY }) });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /HttpOnly/);
    assert.equal(login.body.includes(KEY), false);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const sessions = await request(address.port, 'GET', '/api/sessions', { cookie });
    assert.match(sessions.body, /SAMPLE DATA/);
    const messages = await request(address.port, 'GET', '/api/sessions/sample-tg/messages', { cookie });
    assert.match(messages.body, /phone fixture/);
    const stream = await request(address.port, 'POST', '/api/sessions/sample-tg/chat', { cookie, body: JSON.stringify({ input: 'hi' }) });
    assert.match(stream.body, /assistant.delta/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('static client has no embedded bearer', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/app.js'), 'utf8');
  assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9]/);
  assert.doesNotMatch(source, /API_SERVER_KEY\s*=/);
});
