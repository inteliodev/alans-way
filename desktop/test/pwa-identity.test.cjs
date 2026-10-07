const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loginFromWhois, loginFromStatus, parseAllowlist, readProfileKey, createIdentity, peerIsLocal, selfFromStatus } = require('../../mobile/pwa/identity.cjs');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

test('whois and status expose a login and nothing else is required', () => {
  assert.equal(loginFromWhois({ UserProfile: { LoginName: 'owner@example' } }), 'owner@example');
  assert.equal(loginFromStatus({ Self: { UserID: 7 }, User: { 7: { LoginName: 'owner@example' } } }), 'owner@example');
  assert.equal(loginFromWhois({ UserProfile: { LoginName: 'has a space' } }), '');
  assert.deepEqual(parseAllowlist('Owner@Example, other@example\n'), ['owner@example', 'other@example']);
});

test('profile key file must be mode 600 and is not logged', () => {
  const secret = 's'.repeat(32);
  const file = path.join(os.tmpdir(), `intelio-key-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(file, `API_SERVER_KEY=${secret}\n`, { mode: 0o600 });
  try {
    assert.equal(digest(readProfileKey(file)), digest(secret));
    fs.chmodSync(file, 0o644);
    assert.throws(() => readProfileKey(file), /mode 600/);
  } finally {
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, Buffer.alloc(secret.length));
    fs.unlinkSync(file);
  }
});

test('this node is local and a different tailnet node is not', () => {
  const self = selfFromStatus({ Self: { ID: '9', TailscaleIPs: ['192.0.2.10'] } });
  assert.equal(peerIsLocal({ address: '127.0.0.1', self, hostIps: [] }), true);
  assert.equal(peerIsLocal({ address: '192.0.2.10', self, hostIps: [] }), true);
  assert.equal(peerIsLocal({
    address: '192.0.2.10',
    self: { id: '', ips: [] },
    whois: { Node: { ID: '9', Addresses: ['192.0.2.10/32'] } },
    hostIps: ['192.0.2.10'],
  }), true);
  assert.equal(peerIsLocal({
    address: '192.0.2.20',
    self,
    whois: { Node: { ID: '44', Addresses: ['192.0.2.20/32'] }, UserProfile: { LoginName: 'owner@example' } },
    hostIps: ['192.0.2.10'],
  }), false);
});

test('identity allowlist denies unknown logins without calling them a key', async () => {
  const ident = createIdentity({
    run: async () => ({ code: 0, stdout: JSON.stringify({ UserProfile: { LoginName: 'other@example' } }), stderr: '' }),
    localWhois: async () => '',
  });
  const allowed = await ident.identify('127.0.0.1', ['owner@example']);
  assert.equal(allowed.ok, false);
  assert.equal(allowed.reason, 'login not allowed');
  const identOk = createIdentity({
    run: async () => ({ code: 0, stdout: JSON.stringify({ UserProfile: { LoginName: 'owner@example' } }), stderr: '' }),
    localWhois: async () => '',
  });
  const yes = await identOk.identify('127.0.0.1', ['owner@example']);
  assert.equal(yes.ok, true);
  assert.equal(yes.login, 'owner@example');
  const empty = await identOk.identify('127.0.0.1', []);
  assert.equal(empty.reason, 'allowlist is empty');
});

test('phone installer dry-run stays tailnet-only and pins voice', () => {
  const script = path.join(__dirname, '../../mobile/deploy/install-on-vps.sh');
  const env = { ...process.env, INTELIO_PWA_BIND: '127.0.0.1', INTELIO_HERMES_URL: 'http://intelio-vps.tail9c1007.ts.net:8642', INTELIO_PWA_ALLOWED_LOGINS: 'owner@example', HOME: '/tmp', XDG_CONFIG_HOME: '/tmp/intelio-dry-missing' };
  assert.throws(() => execFileSync('bash', [script, '--dry-run'], { env: { ...env, INTELIO_PWA_BIND: 'example.invalid' }, encoding: 'utf8' }));
  const out = execFileSync('bash', [script, '--dry-run', '--with-voice'], { env, encoding: 'utf8' });
  assert.match(out, /faster-whisper==1\.2\.1/);
  assert.match(out, /piper-tts==1\.3\.0/);
  assert.match(out, /av==18\.1\.0/);
  assert.match(out, /tailscale0/);
  assert.match(out, /owner@example/);
  assert.equal(out.includes('s'.repeat(32)), false);
  assert.equal(fs.existsSync('/tmp/intelio-dry-missing/intelio/pwa.env'), false);
});
