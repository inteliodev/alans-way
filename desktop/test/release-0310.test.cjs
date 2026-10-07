const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createVaultStore, profileIdsFromList } = require('../src/intelio/vault.cjs');
const { fillExpression, resolveCdpUrl, pickTarget } = require('../src/intelio/cdp-fill.cjs');
const { usesRemoteVault, vaultOrigin, postProfileVault } = require('../src/intelio/remote-vault.cjs');

test('vault profiles come from directories and hermes profile list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-profiles-'));
  fs.mkdirSync(path.join(root, 'kid-a'));
  const listed = profileIdsFromList('* intelio\nprc\ndefault\nnot a profile name!!\n');
  const store = createVaultStore({ root, profiles: listed });
  assert.equal(store.knownProfiles().includes('kid-a'), true);
  assert.equal(store.knownProfiles().includes('prc'), true);
  assert.throws(() => store.saveLogin('stranger', { domain: 'a.example', username: 'a', password: 'x' }), /Unknown profile/);
  store.saveLogin('kid-a', { domain: 'desk.example', username: 'kid', password: 'kid-secret' });
  assert.equal(store.list('kid-a')[0].username, 'kid');
  assert.equal(JSON.stringify(store.list('kid-a')).includes('kid-secret'), false);
});

test('a systemd credential supplies the vault key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-cred-vault-'));
  const creds = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-cred-dir-'));
  fs.mkdirSync(path.join(root, 'hhp'));
  fs.writeFileSync(path.join(creds, 'vault.key.hhp'), Buffer.alloc(32, 7), { mode: 0o600 });
  const store = createVaultStore({ root, credentialsDir: creds });
  store.saveLogin('hhp', { domain: 'bank.example', username: 'hhp-user', password: 'cred-secret' });
  assert.equal(fs.existsSync(path.join(root, 'hhp', 'vault.key')), false);
  assert.equal(store.fillerPayload('hhp', 'bank.example').password, 'cred-secret');
  assert.equal(JSON.stringify(store.toolResult('hhp', 'bank.example')).includes('cred-secret'), false);
});

test('the filler expression types into the card selectors and does not return the secret', () => {
  const secret = 'typed-secret-value';
  const selectors = { username: '#user', password: '#pass', otp: '#otp' };
  const password = { value: '', events: 0, focus() {}, dispatchEvent() { this.events += 1; } };
  const username = { value: '', events: 0, focus() {}, dispatchEvent() { this.events += 1; } };
  class HTMLInputElement {}
  const document = {
    querySelector(selector) {
      if (selector === '#pass') return password;
      if (selector === '#user') return username;
      return null;
    },
  };
  const result = vm.runInNewContext(fillExpression(selectors, { username: 'ada', password: secret, otp: '' }), {
    document,
    HTMLInputElement,
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    Event: class Event {},
  });
  assert.equal(password.value, secret);
  assert.equal(username.value, 'ada');
  assert.equal(result.filled, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-cdp-'));
  fs.mkdirSync(path.join(root, 'prc', 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prc', 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9333\n');
  assert.equal(resolveCdpUrl({ profile: 'prc', root }), 'http://127.0.0.1:9333');
  assert.throws(() => resolveCdpUrl({ explicit: 'http://example.com:9223' }), /loopback/);
  const target = pickTarget([
    { type: 'page', targetId: 'other', url: 'https://other.example/' },
    { type: 'page', targetId: 'match', url: 'https://login.portal.example/session' },
  ], 'portal.example');
  assert.equal(target.targetId, 'match');
});

test('remote mode posts the sign-in to the VPS and drops secrets from the result', async () => {
  assert.equal(usesRemoteVault({ remoteHermes: { enabled: true, host: 'intelio-vps.tail9c1007.ts.net' } }), true);
  assert.equal(usesRemoteVault({ remoteHermes: { enabled: false, host: '127.0.0.1' } }), false);
  assert.equal(vaultOrigin({ host: '127.0.0.1' }, {}), 'http://127.0.0.1:8643');
  assert.throws(() => vaultOrigin({ vaultOrigin: 'https://example.com' }, {}), /tailnet/);
  const secret = 'remote-only-secret';
  const key = 'profile-key-value-0001';
  let seen = '';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('utf8');
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      res.end(JSON.stringify({ ok: true, filled: true, domain: 'portal.example', username: 'ada', password: secret, otp: '123123' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const result = await postProfileVault({
      origin: `http://127.0.0.1:${port}`,
      profile: 'hhp',
      key,
      path: '/api/vault/login',
      body: { profile: 'hhp', domain: 'portal.example', username: 'ada', password: secret, otp: '123123', save: false },
      fetchImpl: globalThis.fetch,
    });
    assert.match(seen, new RegExp(secret));
    assert.equal(result.filled, true);
    assert.equal(result.username, 'ada');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(result).includes('123123'), false);
    assert.equal(JSON.stringify(result).includes(key), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fill_saved_login returns no secret', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-plugin-home-'));
  const secret = 'plugin-should-not-return';
  const key = 'plugin-profile-key-0001';
  fs.mkdirSync(path.join(home, '.hermes', 'profiles', 'intelio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.hermes', 'profiles', 'intelio', '.env'), `API_SERVER_KEY=${key}\n`, { mode: 0o600 });
  const script = `
import importlib.util, json, os, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
secret = ${JSON.stringify(secret)}
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(size)
        body = json.dumps({"ok": True, "filled": True, "domain": "portal.example", "username": "ada", "password": secret}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        return
server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["INTELIO_FILLER_URL"] = "http://127.0.0.1:%s" % server.server_address[1]
spec = importlib.util.spec_from_file_location("intelio_fill", ${JSON.stringify(path.join(__dirname, '../../plugins/intelio-vault/fill.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.fill_saved_login({"site": "portal.example"}, profile="intelio", home=${JSON.stringify(home)}))
server.shutdown()
`;
  const result = spawnSync('python3', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes(key), false);
  assert.match(result.stdout, /"filled": true/);
  const plugin = fs.readFileSync(path.join(__dirname, '../../plugins/intelio-vault/__init__.py'), 'utf8');
  assert.match(plugin, /register_tool/);
  assert.match(plugin, /fill_saved_login/);
  assert.match(plugin, /hermes-gateway/);
});

test('maximize sets XAUTHORITY, skips missing displays, and hides a failed xdotool', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-max-'));
  const x11 = path.join(root, 'x11');
  const bin = path.join(root, 'bin');
  const profiles = path.join(root, 'profiles');
  fs.mkdirSync(x11);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(profiles, 'prc', 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(profiles, 'prc', 'bot-desktop', 'display'), ':20\n');
  fs.writeFileSync(path.join(profiles, 'prc', 'bot-desktop', 'Xauthority'), 'auth-bytes');
  const log = path.join(root, 'log');
  fs.writeFileSync(path.join(bin, 'xdotool'), `#!/bin/sh\necho "XAUTHORITY=$XAUTHORITY" >> ${JSON.stringify(log)}\necho "DISPLAY=$DISPLAY" >> ${JSON.stringify(log)}\nexit 1\n`);
  fs.chmodSync(path.join(bin, 'xdotool'), 0o755);
  const py = spawnSync('python3', ['-c', `import socket,os; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(path.join(x11, 'X20'))}); s.listen(1)`], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const script = path.join(__dirname, '../../scripts/bot-desktop-maximize.sh');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    HERMES_PROFILES: profiles,
    INTELIO_X11_DIR: x11,
    INTELIO_BOT_DISPLAYS: ':20 :21',
  };
  const failed = spawnSync('sh', [script, '--all'], { env, encoding: 'utf8' });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout.includes('Maximized'), false);
  assert.match(failed.stderr, /xdotool failed/);
  assert.match(fs.readFileSync(log, 'utf8'), /Xauthority/);
  assert.match(fs.readFileSync(log, 'utf8'), /DISPLAY=:20/);
  fs.writeFileSync(path.join(bin, 'wmctrl'), `#!/bin/sh\nif [ "$1" = "-l" ]; then echo "0x1 chromium.Chromium"; exit 0; fi\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'wmctrl'), 0o755);
  const ok = spawnSync('sh', [script, ':20'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Maximized Chromium on :20/);
  const unit = fs.readFileSync(path.join(__dirname, '../../scripts/intelio-bot-desktop-maximize.service'), 'utf8');
  assert.match(unit, /--watch/);
  assert.match(unit, /WantedBy=default.target/);
});
