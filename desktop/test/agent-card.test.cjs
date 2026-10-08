const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { buildCard, applyReasoning, readProfileFiles, writePaused, writeReasoning, KNOWN_PHONES } = require('../src/intelio/agent-card.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const SECRET = 'sk-notarealkeyvalue';

function request(port, method, pathname, { body, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...headers,
        ...(origin ? { origin } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('a config phone wins, secrets stay out, and reasoning writes only with a model block', () => {
  const config = [
    'title: Chief of Staff',
    'email: agent@example.com',
    'phone: "+19995550199"',
    `api_key: ${SECRET}`,
    'model:',
    '  default: demo',
    'platform_toolsets:',
    '  - web',
    'imessage:',
    '  enabled: true',
    '',
  ].join('\n');
  const memory = `The key point is the launch.\ntoken: ${SECRET}\nLikes short notes.\n`;
  const card = buildCard({ id: 'intelio', configText: config, userText: memory, memoryText: '' });
  assert.equal(card.phone, '+19995550199');
  assert.notEqual(card.phone, KNOWN_PHONES.intelio);
  assert.equal(card.title, 'Chief of Staff');
  assert.equal(card.email, 'agent@example.com');
  assert.equal(card.thinkingWritable, true);
  assert.equal(card.worksOn, 'cloud');
  assert.equal(card.worksOnWritable, false);
  assert.equal(JSON.stringify(card).includes(SECRET), false);
  assert.match(card.memory, /The key point is the launch/);
  assert.match(card.memory, /Likes short notes/);
  assert.equal(card.memory.includes(SECRET), false);
  assert.equal(buildCard({ id: 'kid-a', configText: config }), null);
  const replaced = applyReasoning('reasoning_effort: auto\n', 'high');
  assert.match(replaced, /reasoning_effort: high/);
  const inserted = applyReasoning('model:\n  default: demo\n', 'low');
  assert.match(inserted, /reasoning_effort: low/);
  assert.equal(applyReasoning('name: demo\n', 'low'), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-card-'));
  fs.mkdirSync(path.join(root, 'prc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prc', 'config.yaml'), 'model:\n  default: demo\nphone: "+19995550100"\n', { mode: 0o600 });
  assert.equal(writePaused(root, 'prc', true), true);
  assert.equal(readProfileFiles(root, 'prc').paused, true);
  const wrote = writeReasoning(root, 'prc', 'medium');
  assert.equal(wrote.ok, true);
  assert.match(fs.readFileSync(path.join(root, 'prc', 'config.yaml'), 'utf8'), /reasoning_effort: medium/);
  writePaused(root, 'prc', false);
  assert.equal(readProfileFiles(root, 'prc').paused, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the phone card route reads the profile files and refuses a cross-origin write', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-card-http-'));
  const dir = path.join(root, 'intelio');
  fs.mkdirSync(path.join(dir, 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), [
    'title: Chief of Staff',
    'email: agent@example.com',
    'phone: "+19995550199"',
    `api_key: ${SECRET}`,
    'model:',
    '  default: demo',
    'platform_toolsets:',
    '  - web',
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'USER.md'), `The key point is the launch.\ntoken: ${SECRET}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'Likes short notes.\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9224\n', { mode: 0o600 });
  const app = createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    sample: true,
    upstream: 'http://127.0.0.1:9',
    vaultRoot: root,
    identify: async () => ({ ok: true, login: 'owner@example' }),
  });
  const address = await app.listen();
  try {
    const card = await request(address.port, 'GET', '/api/agent/card?profile=intelio');
    assert.equal(card.status, 200);
    const body = JSON.parse(card.body);
    assert.equal(body.id, 'intelio');
    assert.equal(body.name, 'intelio');
    assert.equal(body.phone, '+19995550199');
    assert.equal(body.computer.status, 'running');
    assert.equal(body.thinkingWritable, true);
    assert.equal(card.body.includes(SECRET), false);
    assert.match(body.memory, /Likes short notes/);
    const missing = await request(address.port, 'GET', '/api/agent/card?profile=kid-a');
    assert.equal(missing.status, 404);
    const blocked = await request(address.port, 'POST', '/api/agent/thinking', { body: JSON.stringify({ effort: 'high', profile: 'intelio' }) });
    assert.equal(blocked.status, 403);
    const origin = `http://127.0.0.1:${address.port}`;
    const saved = await request(address.port, 'POST', '/api/agent/thinking', {
      origin,
      body: JSON.stringify({ effort: 'high', profile: 'intelio' }),
    });
    assert.equal(saved.status, 200);
    assert.match(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'), /reasoning_effort: high/);
    assert.equal(saved.body.includes(SECRET), false);
    const paused = await request(address.port, 'POST', '/api/agent/pause', {
      headers: { authorization: 'Bearer profile-key' },
      body: JSON.stringify({ paused: true, profile: 'intelio' }),
    });
    assert.equal(paused.status, 200);
    assert.equal(fs.readFileSync(path.join(dir, 'intelio-paused'), 'utf8').trim(), '1');
    const sw = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/sw.js'), 'utf8');
    const page = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/app.js'), 'utf8');
    const edited = await request(address.port, 'POST', '/api/agent/profile', {
      origin,
      body: JSON.stringify({ profile: 'intelio', title: 'Chief of Staff', color: '#1d4ed8', soul: 'Be brief.\n' }),
    });
    assert.equal(edited.status, 200);
    const editedBody = JSON.parse(edited.body);
    assert.equal(editedBody.title, 'Chief of Staff');
    assert.equal(editedBody.color, '#1d4ed8');
    assert.match(editedBody.soul, /Be brief/);
    assert.match(fs.readFileSync(path.join(dir, 'SOUL.md'), 'utf8'), /Be brief/);
    assert.equal(edited.body.includes(SECRET), false);
    const yellow = await request(address.port, 'POST', '/api/agent/profile', {
      origin,
      body: JSON.stringify({ profile: 'intelio', color: '#ffff00' }),
    });
    assert.equal(yellow.status, 400);
    const phone = await request(address.port, 'POST', '/api/phone/call', {
      origin,
      body: JSON.stringify({ profile: 'intelio' }),
    });
    assert.equal(phone.status, 200);
    assert.equal(JSON.parse(phone.body).ready, false);
    const screens = await request(address.port, 'GET', '/api/screens');
    assert.equal(screens.status, 200);
    assert.equal(JSON.parse(screens.body).data[0].host, 'google.com');
    assert.match(sw, /intelio-pwa-32/);
    assert.match(sw, /skipWaiting/);
    assert.match(sw, /clients\.claim/);
    assert.match(sw, /cache\.put/);
    assert.match(page, /intelio-pwa-28/);
    assert.match(page, /New version\. Tap to reload\./);
    assert.match(page, /Manage in Vault/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
