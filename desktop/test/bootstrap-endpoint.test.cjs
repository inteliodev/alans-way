const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { verifyAccessJwt, AUD, EMAIL, TEAM } = require('../../mobile/bootstrap/jwt.cjs');
const { createBootstrapServer } = require('../../mobile/bootstrap/server.cjs');

const SECRET = `k${'abc'.repeat(12)}`;
const VNC = 'desk-secret';

function sign(privateKey, payload, header = { alg: 'RS256', kid: 'test', typ: 'JWT' }) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function fixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const keys = [{ kid: 'test', kty: 'RSA', n: jwk.n, e: jwk.e }];
  const now = 1_700_000_000_000;
  const claims = {
    iss: TEAM,
    aud: AUD,
    email: EMAIL,
    exp: Math.floor(now / 1000) + 3600,
  };
  return { privateKey, keys, pem, now, token: sign(privateKey, claims) };
}

test('access JWT accepts a matching RS256 token and denies the rest', () => {
  const { privateKey, keys, pem, now, token } = fixture();
  assert.deepEqual(verifyAccessJwt(token, { keys }, { now }), { ok: true, email: EMAIL });
  assert.deepEqual(verifyAccessJwt(token, [{ kid: 'test', pem }], { now }), { ok: true, email: EMAIL });
  const audList = sign(privateKey, { iss: `${TEAM}/`, aud: ['other', AUD], email: EMAIL.toUpperCase(), exp: Math.floor(now / 1000) + 10 });
  assert.equal(verifyAccessJwt(audList, { keys }, { now }).ok, true);
  assert.throws(() => verifyAccessJwt(token, { keys }, { now, email: 'other@intelio.co' }), /denied/);
  assert.throws(() => verifyAccessJwt(sign(privateKey, { iss: TEAM, aud: 'nope', email: EMAIL, exp: Math.floor(now / 1000) + 10 }), { keys }, { now }), /denied/);
  assert.throws(() => verifyAccessJwt(sign(privateKey, { iss: TEAM, aud: AUD, email: EMAIL, exp: Math.floor(now / 1000) - 10 }), { keys }, { now }), /denied/);
  assert.throws(() => verifyAccessJwt(sign(privateKey, { iss: 'https://example.com', aud: AUD, email: EMAIL, exp: Math.floor(now / 1000) + 10 }), { keys }, { now }), /denied/);
  assert.throws(() => verifyAccessJwt('', { keys }, { now }), /denied/);
});

test('bootstrap returns profile keys only after a valid assertion and does not log them', async () => {
  const { keys, now, token } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-bootstrap-'));
  for (const name of ['intelio', 'prc', 'alignment', 'hhp']) {
    const dir = path.join(home, '.hermes', 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), `API_SERVER_KEY=${SECRET}-${name}\n`);
  }
  fs.mkdirSync(path.join(home, '.config', 'intelio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'intelio', 'vnc-password.txt'), `${VNC}\n`);
  const server = createBootstrapServer({ fetchCerts: async () => ({ keys }), home, now: () => now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const logs = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { logs.push(String(chunk)); return original.call(process.stderr, chunk, ...rest); };
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/intelio/bootstrap`);
    assert.equal(denied.status, 401);
    assert.equal(await denied.text(), 'denied');
    const ok = await fetch(`http://127.0.0.1:${port}/intelio/bootstrap`, { headers: { 'cf-access-jwt-assertion': token } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control') || '', /no-store/);
    const body = await ok.json();
    assert.equal(body.intelio, `${SECRET}-intelio`);
    assert.equal(body.prc, `${SECRET}-prc`);
    assert.equal(body.alignment, `${SECRET}-alignment`);
    assert.equal(body.hhp, `${SECRET}-hhp`);
    assert.equal(body.vnc, VNC);
    const wrong = signWrong(token);
    const rejected = await fetch(`http://127.0.0.1:${port}/intelio/bootstrap`, { headers: { 'cf-access-jwt-assertion': wrong } });
    assert.equal(rejected.status, 401);
    const logged = logs.join('');
    assert.equal(logged.includes(SECRET), false);
    assert.equal(logged.includes(VNC), false);
    assert.equal(logged.includes(token), false);
  } finally {
    process.stderr.write = original;
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function signWrong(token) {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  payload.email = 'someone@example.com';
  return `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
}

test('the bootstrap installer only documents the loopback ingress', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../mobile/deploy/install-bootstrap-endpoint.sh'), 'utf8');
  const doc = fs.readFileSync(path.join(__dirname, '../../mobile/deploy/bootstrap-ingress.md'), 'utf8');
  for (const text of [script, doc]) {
    assert.match(text, /127\.0\.0\.1:8660/);
    assert.match(text, /path: \^\/intelio\/bootstrap\$/);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(VNC), false);
  }
  assert.match(script, /intelio-bootstrap\.service/);
  assert.doesNotMatch(script, /\/home\/hayden/);
});
