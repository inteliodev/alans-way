const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createVaultStore, profileIdsFromList } = require('../src/intelio/vault.cjs');
const { fillExpression, resolveCdpUrl, pickTarget, fillLogin } = require('../src/intelio/cdp-fill.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');
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
  fs.mkdirSync(path.join(root, 'hhp', 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prc', 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9333\n');
  fs.writeFileSync(path.join(root, 'hhp', 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9444\n');
  const previous = process.env.INTELIO_CDP_URL;
  process.env.INTELIO_CDP_URL = 'http://127.0.0.1:9223';
  try {
    assert.equal(resolveCdpUrl({ profile: 'prc', root, explicit: 'http://127.0.0.1:9223' }), 'http://127.0.0.1:9333');
    assert.equal(resolveCdpUrl({ profile: 'hhp', root }), 'http://127.0.0.1:9444');
    fs.rmSync(path.join(root, 'hhp', 'bot-desktop', 'cdp.url'));
    assert.throws(() => resolveCdpUrl({ profile: 'hhp', root, explicit: 'http://127.0.0.1:9223' }), /per-profile/);
    fs.writeFileSync(path.join(root, 'hhp', 'bot-desktop', 'allow-shared-browser'), '');
    assert.equal(resolveCdpUrl({ profile: 'hhp', root }), 'http://127.0.0.1:9223');
  } finally {
    if (previous === undefined) delete process.env.INTELIO_CDP_URL;
    else process.env.INTELIO_CDP_URL = previous;
  }
  assert.throws(() => resolveCdpUrl({ explicit: 'http://example.com:9223' }), /loopback/);
  const target = pickTarget([
    { type: 'page', targetId: 'other', url: 'https://other.example/' },
    { type: 'page', targetId: 'match', url: 'https://login.portal.example/session' },
  ], 'portal.example');
  assert.equal(target.targetId, 'match');
  assert.equal(pickTarget([
    { type: 'page', targetId: 'first', url: 'https://other.example/' },
    { type: 'page', targetId: 'second', url: 'https://also.example/' },
  ], 'portal.example'), null);
  assert.equal(pickTarget([
    { type: 'page', targetId: 'evil', url: 'https://evilportal.example/' },
  ], 'portal.example'), null);
  assert.equal(pickTarget([
    { type: 'page', targetId: 'exact', url: 'https://www.portal.example/login' },
  ], 'portal.example').targetId, 'exact');
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
import importlib.util, json, os, sys, threading
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
import contextvars, types
override = contextvars.ContextVar("hermes_home_override", default=None)
hc = types.ModuleType("hermes_constants")
hc.get_hermes_home_override = lambda: override.get()
sys.modules["hermes_constants"] = hc
override.set(${JSON.stringify(path.join(home, '.hermes', 'profiles', 'intelio'))})
os.environ["INTELIO_HERMES_PROFILE"] = "hhp"
os.environ["HERMES_PROFILE"] = "hhp"
print(mod.fill_saved_login({"site": "portal.example"}, profile="hhp"))
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
  fs.writeFileSync(path.join(profiles, 'prc', 'bot-desktop', 'display'), '20\n');
  fs.writeFileSync(path.join(profiles, 'prc', 'bot-desktop', 'Xauthority'), 'auth-bytes');
  const log = path.join(root, 'log');
  fs.writeFileSync(path.join(bin, 'xdotool'), `#!/bin/sh\necho "XAUTHORITY=\${XAUTHORITY-unset}" >> ${JSON.stringify(log)}\necho "DISPLAY=$DISPLAY" >> ${JSON.stringify(log)}\nexit 1\n`);
  fs.chmodSync(path.join(bin, 'xdotool'), 0o755);
  const py = spawnSync('python3', ['-c', `import socket,os; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(path.join(x11, 'X20'))}); s.listen(1)`], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const py21 = spawnSync('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(path.join(x11, 'X21'))}); s.listen(1)`], { encoding: 'utf8' });
  assert.equal(py21.status, 0, py21.stderr);
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
  const authText = fs.readFileSync(log, 'utf8');
  assert.match(authText, /XAUTHORITY=.*\/Xauthority\nDISPLAY=:20/);
  const after20 = authText.slice(authText.lastIndexOf('DISPLAY=:20') + 'DISPLAY=:20'.length);
  assert.match(after20, /XAUTHORITY=unset\nDISPLAY=:21/);
  assert.equal(after20.includes('Xauthority'), false);
  fs.writeFileSync(path.join(bin, 'wmctrl'), `#!/bin/sh\nif [ "$1" = "-l" ]; then echo "0x1 chromium.Chromium"; exit 0; fi\nexit 0\n`);
  fs.chmodSync(path.join(bin, 'wmctrl'), 0o755);
  const ok = spawnSync('sh', [script, ':20'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Maximized Chromium on :20/);
  const noWm = path.join(root, 'nowm');
  const noWmLog = path.join(root, 'nowm-log');
  fs.mkdirSync(noWm);
  fs.writeFileSync(path.join(noWm, 'wmctrl'), '#!/bin/sh\nif [ "$1" = "-m" ]; then echo "no window manager" >&2; exit 1; fi\necho "listed" >&2; exit 1\n');
  fs.writeFileSync(path.join(noWm, 'xdotool'), `#!/bin/sh\necho "xdotool DISPLAY=$DISPLAY" >> ${JSON.stringify(noWmLog)}\nexit 0\n`);
  fs.chmodSync(path.join(noWm, 'wmctrl'), 0o755);
  fs.chmodSync(path.join(noWm, 'xdotool'), 0o755);
  const bare = spawnSync('sh', [script, '20'], {
    env: { ...env, PATH: `${noWm}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /Maximized Chromium on :20/);
  assert.equal(bare.stderr.includes('No Chromium window'), false);
  assert.match(fs.readFileSync(noWmLog, 'utf8'), /DISPLAY=:20/);
  const unit = fs.readFileSync(path.join(__dirname, '../../scripts/intelio-bot-desktop-maximize.service'), 'utf8');
  assert.match(unit, /--watch/);
  assert.match(unit, /WantedBy=default.target/);
  assert.match(unit, /intelio\/alans-way-pwa/);
  const watchBin = path.join(root, 'watch-bin');
  fs.mkdirSync(watchBin);
  fs.writeFileSync(path.join(watchBin, 'wmctrl'), '#!/bin/sh\nif [ "$1" = "-l" ]; then exit 0; fi\nexit 0\n');
  fs.chmodSync(path.join(watchBin, 'wmctrl'), 0o755);
  const watched = spawnSync('timeout', ['1.2', 'sh', script, '--watch'], {
    env: { ...env, PATH: `${watchBin}:/usr/bin:/bin`, INTELIO_BOT_WATCH_SECONDS: '0.3' },
    encoding: 'utf8',
  });
  assert.equal(watched.status, 124);
  const missing = (watched.stderr.match(/No Chromium window/g) || []).length;
  assert.equal(missing, 2);
});

test('fill_saved_login uses the per-message profile override and not the intelio key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-plugin-profiles-'));
  const keys = {
    prc: 'prc-api-key-0001',
    hhp: 'hhp-api-key-0002',
    intelio: 'intelio-api-key-0003',
  };
  const vaults = {
    prc: 'prc-vault-secret',
    hhp: 'hhp-vault-secret',
    intelio: 'intelio-vault-secret',
  };
  for (const name of Object.keys(keys)) {
    const dir = path.join(home, '.hermes', 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), `API_SERVER_KEY=${keys[name]}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'vault'), vaults[name], { mode: 0o600 });
  }
  const script = `
import contextvars, importlib.util, json, os, sys, threading, types
from http.server import BaseHTTPRequestHandler, HTTPServer
seen = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(size).decode()
        seen.append({"auth": self.headers.get("Authorization"), "profile": self.headers.get("x-intelio-profile"), "body": raw})
        body = json.dumps({"ok": True, "filled": True, "domain": "portal.example", "username": "ada"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        return
server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["INTELIO_FILLER_URL"] = "http://127.0.0.1:%s" % server.server_address[1]
os.environ["INTELIO_HERMES_PROFILE"] = "intelio"
os.environ["HERMES_PROFILE"] = "intelio"
override = contextvars.ContextVar("hermes_home_override", default=None)
hc = types.ModuleType("hermes_constants")
def get_override():
    return override.get()
hc.get_hermes_home_override = get_override
sys.modules["hermes_constants"] = hc
named = {"value": None}
cli = types.ModuleType("hermes_cli")
cli.__path__ = []
profiles = types.ModuleType("hermes_cli.profiles")
def current_profile_name(fallback=None):
    if named["value"] == "raise":
        raise RuntimeError("leak-this-profile-path")
    return named["value"]
profiles.current_profile_name = current_profile_name
sys.modules["hermes_cli"] = cli
sys.modules["hermes_cli.profiles"] = profiles
spec = importlib.util.spec_from_file_location("intelio_fill_profiles", ${JSON.stringify(path.join(__dirname, '../../plugins/intelio-vault/fill.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
root = ${JSON.stringify(path.join(home, '.hermes', 'profiles'))}
def run(home_name):
    override.set(os.path.join(root, home_name) if home_name else None)
    return mod.fill_saved_login({"site": "portal.example"}, profile="intelio")
prc = json.loads(run("prc"))
hhp = json.loads(run("hhp"))
override.set(None)
named["value"] = "default"
refused_default = json.loads(mod.fill_saved_login({"site": "portal.example"}))
named["value"] = "custom"
refused_custom = json.loads(mod.fill_saved_login({"site": "portal.example"}))
named["value"] = "unknown"
refused_unknown = json.loads(mod.fill_saved_login({"site": "portal.example"}))
named["value"] = "raise"
refused_raise = json.loads(mod.fill_saved_login({"site": "portal.example"}))
named["value"] = "hhp"
by_name = json.loads(mod.fill_saved_login({"site": "portal.example"}, profile="intelio"))
print(json.dumps({
  "prc": prc, "hhp": hhp,
  "seen": seen,
  "refused": [refused_default, refused_custom, refused_unknown, refused_raise],
  "by_name": by_name,
}))
server.shutdown()
`;
  const result = spawnSync('python3', ['-c', script], { env: { ...process.env, HOME: home, INTELIO_HERMES_PROFILE: 'intelio', HERMES_PROFILE: 'intelio' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(vaults.prc), false);
  assert.equal(result.stdout.includes(vaults.hhp), false);
  assert.equal(result.stdout.includes(vaults.intelio), false);
  assert.equal(result.stdout.includes('leak-this-profile-path'), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.prc.filled, true);
  assert.equal(report.hhp.filled, true);
  assert.deepEqual(report.seen.map((row) => row.profile), ['prc', 'hhp', 'hhp']);
  assert.equal(report.seen[0].auth, `Bearer ${keys.prc}`);
  assert.equal(report.seen[1].auth, `Bearer ${keys.hhp}`);
  assert.equal(report.seen[2].auth, `Bearer ${keys.hhp}`);
  assert.equal(report.seen[0].body.includes(keys.intelio), false);
  assert.equal(JSON.stringify(report.seen).includes(keys.intelio), false);
  assert.equal(JSON.stringify(report.seen).includes(vaults.prc), false);
  for (const row of report.refused) {
    assert.deepEqual(row, { ok: false, filled: false, domain: '', username: '', error: 'Unknown profile.' });
  }
  const fill = fs.readFileSync(path.join(__dirname, '../../plugins/intelio-vault/fill.py'), 'utf8');
  assert.equal(fill.includes('or "intelio"'), false);
  assert.equal(fill.includes('INTELIO_HERMES_PROFILE'), true);
});

function scriptedCdp(scenarios, calls) {
  let index = 0;
  return {
    async connect() {
      const scenario = scenarios[index++] || scenarios[scenarios.length - 1];
      let read = 0;
      return {
        socket: { close() {} },
        async send(method) {
          if (method === 'Target.getTargets') return { targetInfos: scenario.targets };
          if (method === 'Target.getTargetInfo') {
            const url = scenario.urls[Math.min(read, scenario.urls.length - 1)];
            read += 1;
            return { targetInfo: { url, targetId: scenario.targets[0].targetId } };
          }
          throw new Error(method);
        },
        async page() {
          return {
            async executeJavaScript(expression) {
              const start = expression.lastIndexOf(')(');
              const spec = JSON.parse(expression.slice(start + 2, -1));
              const fields = ['username', 'password', 'otp'].filter((name) => spec[name] && spec[name].value);
              calls.push({ fields, expression });
              return { filled: fields.length > 0, fields };
            },
          };
        },
      };
    },
  };
}

test('the filler refuses a tab on another host and rechecks before each field', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-fill-host-'));
  fs.mkdirSync(path.join(root, 'prc', 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prc', 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9333\n');
  const secret = 'field-secret-value';
  const missed = [];
  const missedResult = await fillLogin({
    profile: 'prc',
    root,
    domain: 'portal.example',
    values: { username: 'ada', password: secret },
    CDPImpl: scriptedCdp([{
      targets: [
        { type: 'page', targetId: 'first', url: 'https://other.example/' },
        { type: 'page', targetId: 'second', url: 'https://also.example/' },
      ],
      urls: ['https://other.example/'],
    }], missed),
  });
  assert.equal(missedResult.filled, false);
  assert.equal(missedResult.error, 'No matching page.');
  assert.equal(missed.length, 0);
  assert.equal(JSON.stringify(missedResult).includes(secret), false);
  const moved = [];
  const movedResult = await fillLogin({
    profile: 'prc',
    root,
    domain: 'portal.example',
    values: { username: 'ada', password: secret },
    CDPImpl: scriptedCdp([{
      targets: [{ type: 'page', targetId: 'tab', url: 'https://portal.example/login' }],
      urls: ['https://portal.example/login', 'https://evil.example/gone'],
    }], moved),
  });
  assert.equal(movedResult.filled, false);
  assert.equal(movedResult.error, 'Page left the saved site.');
  assert.equal(moved.length, 1);
  assert.deepEqual(moved[0].fields, ['username']);
  assert.equal(moved[0].expression.includes(secret), false);
});

function pwaRequest(port, method, pathname, { cookie = '', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('vault login and fill refuse to type when the tab host does not match', async () => {
  const secret = 'route-secret-value';
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-route-cdp-'));
  fs.mkdirSync(path.join(vaultRoot, 'intelio', 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'intelio', 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9333\n');
  const calls = [];
  const app = createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    upstream: 'http://127.0.0.1:9',
    fetchImpl: globalThis.fetch,
    profileKey: 'sample-demo-key-not-real-0001',
    vaultRoot,
    cdpImpl: scriptedCdp([
      {
        targets: [{ type: 'page', targetId: 'tab', url: 'https://other.example/' }],
        urls: ['https://other.example/'],
      },
      {
        targets: [{ type: 'page', targetId: 'tab', url: 'https://portal.example/login' }],
        urls: ['https://portal.example/login', 'https://evil.example/away'],
      },
      {
        targets: [{ type: 'page', targetId: 'tab', url: 'https://news.example/' }],
        urls: ['https://news.example/'],
      },
    ], calls),
    accessVerify: async (token) => (token === 'good-assertion' ? { ok: true, login: 'hayden@intelio.co' } : { ok: false }),
  });
  const address = await app.listen();
  try {
    const allowed = await pwaRequest(address.port, 'GET', '/session', { headers: { 'cf-access-jwt-assertion': 'good-assertion' } });
    const cookie = allowed.headers['set-cookie'][0].split(';')[0];
    const access = { 'cf-access-jwt-assertion': 'good-assertion', 'x-intelio-profile': 'intelio' };
    const missed = await pwaRequest(address.port, 'POST', '/api/vault/login', {
      cookie,
      headers: access,
      body: JSON.stringify({ domain: 'portal.example', username: 'ada', password: secret, save: false, profile: 'intelio' }),
    });
    assert.equal(missed.status, 200);
    assert.match(missed.body, /"filled":false/);
    assert.equal(missed.body.includes(secret), false);
    assert.equal(calls.length, 0);
    const moved = await pwaRequest(address.port, 'POST', '/api/vault/login', {
      cookie,
      headers: access,
      body: JSON.stringify({ domain: 'portal.example', username: 'ada', password: secret, save: true, profile: 'intelio' }),
    });
    assert.equal(moved.status, 200);
    assert.match(moved.body, /"filled":false/);
    assert.equal(moved.body.includes(secret), false);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].fields, ['username']);
    assert.equal(calls[0].expression.includes(secret), false);
    const fill = await pwaRequest(address.port, 'POST', '/api/vault/fill', {
      cookie,
      headers: access,
      body: JSON.stringify({ site: 'portal.example', profile: 'intelio' }),
    });
    assert.equal(fill.status, 200);
    assert.match(fill.body, /"filled":false/);
    assert.equal(fill.body.includes(secret), false);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('the filler URL follows pwa.env TLS and does not default to loopback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-filler-url-'));
  const envDir = path.join(home, '.config', 'intelio');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(envDir, 'pwa.env');
  fs.writeFileSync(envFile, [
    'INTELIO_PWA_BIND=intelio-vps.tail9c1007.ts.net',
    'INTELIO_PWA_PORT=8643',
    'INTELIO_PWA_CERT=/tmp/intelio-host.crt',
    'INTELIO_PWA_KEY=/tmp/intelio-host.key',
    '',
  ].join('\n'));
  const profile = path.join(home, '.hermes', 'profiles', 'prc');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, '.env'), 'API_SERVER_KEY=prc-only-key\n', { mode: 0o600 });
  const script = `
import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location("intelio_fill_url", ${JSON.stringify(path.join(__dirname, '../../plugins/intelio-vault/fill.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.filler_origin())
os.environ["INTELIO_PWA_CERT"] = ""
os.environ["INTELIO_PWA_KEY"] = ""
# File still has the cert. Clear the file and use bind only.
open(${JSON.stringify(envFile)}, "w").write("INTELIO_PWA_BIND=intelio-vps.tail9c1007.ts.net\\nINTELIO_PWA_PORT=8643\\n")
print(mod.filler_origin())
open(${JSON.stringify(envFile)}, "w").write("")
hc = types.ModuleType("hermes_constants")
hc.get_hermes_home_override = lambda: ${JSON.stringify(profile)}
sys.modules["hermes_constants"] = hc
print(mod.fill_saved_login({"site": "portal.example"}))
`;
  const result = spawnSync('python3', ['-c', script], {
    env: { HOME: home, PATH: process.env.PATH, PYTHONPATH: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'https://intelio-vps.tail9c1007.ts.net:8643');
  assert.equal(lines[1], 'http://intelio-vps.tail9c1007.ts.net:8643');
  assert.deepEqual(JSON.parse(lines[2]), { ok: false, filled: false, domain: '', username: '', error: 'Filler URL is not configured.' });
  assert.equal(lines.join('\n').includes('127.0.0.1:8643'), false);
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/intelio-vault/fill.py'), 'utf8');
  assert.equal(source.includes('http://127.0.0.1:8643'), false);
  const dropIn = fs.readFileSync(path.join(__dirname, '../../scripts/intelio-filler.conf'), 'utf8');
  assert.match(dropIn, /INTELIO_FILLER_URL/);
  assert.match(dropIn, /hermes-gateway|pwa.env/);
});

test('the optional profile browsers write loopback cdp.url and are not enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-profile-browser-'));
  const profiles = path.join(root, 'profiles');
  const x11 = path.join(root, 'x11');
  const log = path.join(root, 'chromium-log');
  fs.mkdirSync(x11);
  const displays = { prc: '20', alignment: '21', hhp: '22' };
  for (const [name, num] of Object.entries(displays)) {
    const desktop = path.join(profiles, name, 'bot-desktop');
    fs.mkdirSync(desktop, { recursive: true });
    fs.writeFileSync(path.join(desktop, 'display'), `${num}\n`);
    fs.writeFileSync(path.join(desktop, 'Xauthority'), `auth-${name}`);
    const py = spawnSync('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(path.join(x11, `X${num}`))}); s.listen(1)`], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
  }
  const fake = path.join(root, 'chromium');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> "$INTELIO_TEST_LOG"\necho "DISPLAY=$DISPLAY" >> "$INTELIO_TEST_LOG"\necho "XAUTHORITY=$XAUTHORITY" >> "$INTELIO_TEST_LOG"\nexit 0\n`);
  fs.chmodSync(fake, 0o755);
  const script = path.join(__dirname, '../../scripts/bot-desktop-chromium.sh');
  const launched = spawnSync('sh', [script], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      HERMES_PROFILES: profiles,
      INTELIO_X11_DIR: x11,
      INTELIO_CHROMIUM: fake,
      INTELIO_TEST_LOG: log,
    },
    encoding: 'utf8',
  });
  assert.equal(launched.status, 0, launched.stderr);
  const record = fs.readFileSync(log, 'utf8');
  assert.match(record, /--remote-debugging-address=127\.0\.0\.1/);
  assert.equal(record.includes('0.0.0.0'), false);
  assert.match(record, /--remote-debugging-port=9224/);
  assert.match(record, /--remote-debugging-port=9225/);
  assert.match(record, /--remote-debugging-port=9226/);
  assert.match(record, /DISPLAY=:20/);
  assert.match(record, /Xauthority/);
  for (const [name, port] of [['prc', '9224'], ['alignment', '9225'], ['hhp', '9226']]) {
    const file = path.join(profiles, name, 'bot-desktop', 'cdp.url');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), `http://127.0.0.1:${port}`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const unit = fs.readFileSync(path.join(__dirname, '../../scripts/intelio-bot-desktop-chromium.service'), 'utf8');
  assert.match(unit, /bot-desktop-chromium\.sh/);
  const docs = fs.readFileSync(path.join(__dirname, '../../docs/intelio-windows-and-mobile.md'), 'utf8');
  assert.match(docs, /does not enable it/);
});
