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

test('Cloudflare Access signs the phone in without Tailscale whois', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const secret = 'access-vault-secret';
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-pwa-vault-'));
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch,
    profileKey: KEY, vaultRoot,
    filler: async ({ values }) => {
      assert.equal(values.password, secret);
      return { ok: true, filled: true, domain: 'portal.example', password: values.password };
    },
    identify: async () => { throw new Error('whois should not run'); },
    accessVerify: async (token) => (token === 'good-assertion' ? { ok: true, login: 'hayden@intelio.co' } : { ok: false }),
  });
  const address = await app.listen();
  try {
    const denied = await request(address.port, 'GET', '/session', { headers: { 'cf-access-jwt-assertion': 'bad-assertion' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.includes('bad-assertion'), false);
    const allowed = await request(address.port, 'GET', '/session', { headers: { 'cf-access-jwt-assertion': 'good-assertion' } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /hayden@intelio\.co/);
    const cookie = allowed.headers['set-cookie'][0].split(';')[0];
    const access = { 'cf-access-jwt-assertion': 'good-assertion', 'x-intelio-profile': 'intelio' };
    const localVault = await request(address.port, 'POST', '/api/vault/login', {
      cookie,
      headers: access,
      body: JSON.stringify({ domain: 'portal.example', username: 'ada', password: secret, save: true, profile: 'intelio' }),
    });
    assert.equal(localVault.status, 401);
    assert.equal(localVault.body.includes(secret), false);
    assert.equal(localVault.body.includes(KEY), false);
    const keyed = { ...access, authorization: `Bearer ${KEY}` };
    const saved = await request(address.port, 'POST', '/api/vault/login', {
      cookie,
      headers: keyed,
      body: JSON.stringify({ domain: 'portal.example', username: 'ada', password: secret, save: true, profile: 'intelio' }),
    });
    assert.equal(saved.status, 200);
    assert.match(saved.body, /"filled":true/);
    assert.equal(saved.body.includes(secret), false);
    const list = await request(address.port, 'GET', '/api/vault/logins', { cookie, headers: keyed });
    assert.match(list.body, /portal\.example/);
    assert.match(list.body, /ada/);
    assert.equal(list.body.includes(secret), false);
    const fill = await request(address.port, 'POST', '/api/vault/fill', {
      cookie,
      headers: keyed,
      body: JSON.stringify({ site: 'https://portal.example/login', profile: 'intelio' }),
    });
    assert.match(fill.body, /"filled":true/);
    assert.equal(fill.body.includes(secret), false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('vault routes require the profile key from this node and do not accept another profile key', async () => {
  const os = require('node:os');
  const intelioKey = 'intelio-profile-key-0001';
  const prcKey = 'prc-profile-key-0000001';
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vault-auth-'));
  fs.mkdirSync(path.join(vaultRoot, 'prc'));
  const logs = [];
  let identified = 0;
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch,
    vaultRoot,
    profileOps: { keyFor: (id) => (id === 'prc' ? prcKey : intelioKey) },
    identify: async () => { identified += 1; return { ok: true, login: 'inteliodev@github' }; },
    log: (line) => logs.push(line),
  });
  const address = await app.listen();
  const remoteLogs = [];
  let remoteIdentified = 0;
  const remote = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch,
    vaultRoot,
    profileOps: { keyFor: (id) => (id === 'prc' ? prcKey : intelioKey) },
    selfCheck: async () => false,
    identify: async () => { remoteIdentified += 1; return { ok: true, login: 'hayden@intelio.co' }; },
    log: (line) => remoteLogs.push(line),
  });
  const remoteAddress = await remote.listen();
  try {
    const wrong = await request(address.port, 'GET', '/api/vault/logins', {
      headers: { authorization: `Bearer ${intelioKey}`, 'x-intelio-profile': 'prc' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(identified, 0);
    const missing = await request(address.port, 'GET', '/api/vault/logins', {
      headers: { 'x-intelio-profile': 'prc' },
    });
    assert.equal(missing.status, 401);
    assert.equal(identified, 0);
    const ok = await request(address.port, 'GET', '/api/vault/logins', {
      headers: { authorization: `Bearer ${prcKey}`, 'x-intelio-profile': 'prc' },
    });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /"logins":\[\]/);
    const human = await request(remoteAddress.port, 'GET', '/api/vault/logins', {
      headers: { 'x-intelio-profile': 'prc' },
    });
    assert.equal(human.status, 200);
    assert.equal(remoteIdentified, 1);
    const stillWrong = await request(remoteAddress.port, 'GET', '/api/vault/logins', {
      headers: { authorization: `Bearer ${intelioKey}`, 'x-intelio-profile': 'prc' },
    });
    assert.equal(stillWrong.status, 401);
    assert.equal(remoteIdentified, 1);
    const spilled = [...logs, ...remoteLogs, wrong.body, missing.body, ok.body, human.body, stillWrong.body].join('\n');
    assert.equal(spilled.includes(intelioKey), false);
    assert.equal(spilled.includes(prcKey), false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => remote.server.close(resolve));
  }
});

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
    assert.equal(home.skillsOk, true);
    assert.equal(home.jobsOk, true);
    assert.match(JSON.stringify(home.skills), /SAMPLE DATA/);
    const avatar = await request(address.port, 'GET', '/avatars/intelio.png');
    assert.equal(avatar.status, 200);
    assert.equal(avatar.body.slice(1, 4), 'PNG');
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

test('an Access listener bearer is checked against the profile in /p/<profile>/', async () => {
  const intelioKey = 'intelio-key-not-real-0001';
  const prcKey = 'prc-key-not-real-0002';
  const hits = [];
  const upstream = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url.startsWith('/p/prc/api/sessions') && req.headers.authorization === `Bearer ${prcKey}`) {
      res.end(JSON.stringify({ data: [{ id: 'prc-session', title: 'PRC thread' }] }));
      return;
    }
    res.statusCode = 401;
    res.end('{"error":"no"}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    localPort: 0,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    fetchImpl: globalThis.fetch,
    profileKey: intelioKey,
    accessMode: true,
    profileOps: { keyFor: (id) => (id === 'prc' ? prcKey : intelioKey) },
    accessVerify: async () => ({ ok: false }),
  });
  await app.listen();
  const port = app.local.address().port;
  try {
    const ok = await request(port, 'GET', '/p/prc/api/sessions?limit=1', { headers: { authorization: `Bearer ${prcKey}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /prc-session/);
    assert.equal(hits.some((row) => row.url.startsWith('/p/prc/api/sessions') && row.auth === `Bearer ${prcKey}`), true);
    const wrong = await request(port, 'GET', '/p/prc/api/sessions?limit=1', { headers: { authorization: `Bearer ${intelioKey}` } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.includes(intelioKey), false);
    assert.equal(wrong.body.includes(prcKey), false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('the Access listener proxies Hermes, the desktop, and bootstrap without logging secrets', async () => {
  const upstream = await mockHermes();
  const logs = [];
  const app = createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    localPort: 0,
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    fetchImpl: globalThis.fetch,
    profileKey: KEY,
    vncPassword: 'desk-secret-not-logged',
    accessMode: true,
    accessVerify: async (token) => (token === 'good-assertion' ? { ok: true, login: 'hayden@intelio.co' } : { ok: false }),
    log: (line) => logs.push(line),
  });
  await app.listen();
  const port = app.local.address().port;
  try {
    const denied = await request(port, 'GET', '/health');
    assert.equal(denied.status, 401);
    const health = await request(port, 'GET', '/health', { cookie: 'CF_Authorization=good-assertion' });
    assert.equal(health.status, 200);
    assert.match(health.body, /"status":"ok"/);
    const sessions = await request(port, 'GET', '/p/intelio/api/sessions?limit=1', { cookie: 'CF_Authorization=good-assertion' });
    assert.equal(sessions.status, 200);
    assert.match(sessions.body, /sample-tg/);
    const boot = await request(port, 'GET', '/intelio/bootstrap', { cookie: 'CF_Authorization=good-assertion' });
    assert.equal(boot.status, 200);
    const parsed = JSON.parse(boot.body);
    assert.equal(parsed.intelio, KEY);
    assert.equal(parsed.vnc, 'desk-secret-not-logged');
    const keyed = await request(port, 'GET', '/intelio/bootstrap', { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(keyed.status, 401);
    assert.equal(logs.join('\n').includes(KEY), false);
    assert.equal(logs.join('\n').includes('desk-secret-not-logged'), false);
    assert.equal(logs.join('\n').includes('good-assertion'), false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
