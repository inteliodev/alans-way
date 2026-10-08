const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const TEAM = 'https://access.example.test';
const AUD = 'test-aud-not-the-live-tag';
const EMAIL = 'hayden@intelio.co';
const PROFILE_KEY = 'access-profile-key-0001';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'access-test';
jwk.alg = 'RS256';
jwk.use = 'sig';

function sign(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'access-test' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

function token(extra = {}, expSeconds = 600) {
  return sign({
    iss: TEAM,
    aud: AUD,
    email: EMAIL,
    exp: Math.floor(Date.now() / 1000) + expSeconds,
    ...extra,
  });
}

function request(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Access mode checks the JWT on the loopback listener and keeps the profile key rule', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-access-'));
  const logs = [];
  let identified = 0;
  const app = createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    localPort: 0,
    upstream: 'http://127.0.0.1:9',
    accessMode: true,
    accessAud: AUD,
    accessEmails: [EMAIL],
    accessTeam: TEAM,
    vaultRoot,
    profileOps: { keyFor: () => PROFILE_KEY },
    identify: async () => { identified += 1; return { ok: true, login: 'inteliodev@github' }; },
    log: (line) => logs.push(line),
    fetchImpl: async (url) => {
      if (String(url) === `${TEAM}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [jwk] }) };
      throw new Error('upstream');
    },
  });
  await app.listen();
  const port = app.local.address().port;
  const good = token();
  try {
    const page = await request(port, 'GET', '/manifest.webmanifest');
    assert.equal(page.status, 200);
    assert.match(page.body, /standalone/);
    const missing = await request(port, 'GET', '/session');
    assert.equal(missing.status, 401);
    const allowed = await request(port, 'GET', '/session', { 'cf-access-jwt-assertion': good });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /hayden@intelio\.co/);
    const badSig = await request(port, 'GET', '/session', { 'cf-access-jwt-assertion': `${good.slice(0, -4)}aaaa` });
    assert.equal(badSig.status, 401);
    const badAud = await request(port, 'GET', '/session', { 'cf-access-jwt-assertion': token({ aud: 'other-aud' }) });
    assert.equal(badAud.status, 401);
    const badExp = await request(port, 'GET', '/session', { 'cf-access-jwt-assertion': token({}, -60) });
    assert.equal(badExp.status, 401);
    const wrongEmail = token({ email: 'other@intelio.co' });
    const forbidden = await request(port, 'GET', '/session', { 'cf-access-jwt-assertion': wrongEmail });
    assert.equal(forbidden.status, 403);
    const vault = await request(port, 'GET', '/api/vault/logins', {
      'cf-access-jwt-assertion': good,
      'x-intelio-profile': 'intelio',
    });
    assert.equal(vault.status, 200);
    assert.match(vault.body, /"logins":\[\]/);
    const wrongKey = await request(port, 'GET', '/api/vault/logins', {
      'cf-access-jwt-assertion': good,
      authorization: 'Bearer wrong-profile-key-000099',
      'x-intelio-profile': 'intelio',
    });
    assert.equal(wrongKey.status, 401);
    assert.equal(identified, 0);
    const text = [page.body, missing.body, allowed.body, badSig.body, badAud.body, badExp.body, forbidden.body, vault.body, wrongKey.body, logs.join('\n')].join('\n');
    assert.equal(text.includes(good), false);
    assert.equal(text.includes(PROFILE_KEY), false);
    assert.equal(text.includes('wrong-profile-key-000099'), false);
    assert.equal(text.includes(wrongEmail), false);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('the phone server does not hardcode the Access app', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/server.cjs'), 'utf8');
  assert.equal(source.includes('muddy-scene-4e1c'), false);
  assert.equal(source.includes('9244bb370c6284088828a165bb1f0b08f52f49e57f7df871c4b5b92c9ec32108'), false);
  assert.equal(source.includes('hayden@intelio.co'), false);
  const docs = fs.readFileSync(path.join(__dirname, '../../docs/intelio-windows-and-mobile.md'), 'utf8');
  assert.match(docs, /hostname: app\.intelio-ai\.com/);
  assert.match(docs, /service: http:\/\/127\.0\.0\.1:8644/);
  assert.match(docs, /INTELIO_PWA_ACCESS_TEAM=https:\/\/muddy-scene-4e1c\.cloudflareaccess\.com/);
  assert.match(docs, /INTELIO_PWA_ACCESS_AUD=9244bb370c6284088828a165bb1f0b08f52f49e57f7df871c4b5b92c9ec32108/);
  assert.match(docs, /INTELIO_PWA_ACCESS_EMAILS=hayden@intelio\.co/);
  assert.match(docs, /systemctl --user restart intelio-pwa\.service/);
});
