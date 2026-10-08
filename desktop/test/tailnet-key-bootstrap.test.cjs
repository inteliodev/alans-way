const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');
const { setupRemoteHermes } = require('../src/intelio/remote-hermes-main.cjs');

const KEY = 'sample-intelio-key-not-real-0001';
const ARLP_KEY = 'sample-arlp-key-not-real-0000003';
const VNC = 'desk-secret-not-logged';

function tailnetServer({ selfPeer = false, allowed = true, logs = [] } = {}) {
  return createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch,
    profileKey: KEY,
    vncPassword: VNC,
    selfCheck: async () => selfPeer,
    identify: async () => (allowed ? { ok: true, login: 'hayden@intelio.co' } : { ok: false, reason: 'login not allowed', login: 'other@example' }),
    log: (line) => logs.push(line),
    profileOps: {
      async list() { return [{ id: 'intelio', name: 'intelio' }, { id: 'arlp', name: 'ARLP' }]; },
      keyFor(id) { return id === 'arlp' ? ARLP_KEY : id === 'intelio' ? KEY : ''; },
    },
  });
}

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the tailnet listener hands keys only to an allowed login holding a key, never to the VPS itself', async () => {
  const logs = [];
  const app = tailnetServer({ logs });
  const self = tailnetServer({ selfPeer: true, logs });
  const stranger = tailnetServer({ allowed: false, logs });
  const { port } = await app.listen();
  const selfPort = (await self.listen()).port;
  const strangerPort = (await stranger.listen()).port;
  try {
    const ok = await get(port, '/intelio/bootstrap?profile=intelio', { authorization: `Bearer ${KEY}` });
    assert.equal(ok.status, 200);
    const parsed = JSON.parse(ok.body);
    assert.equal(parsed.arlp, ARLP_KEY);
    assert.equal(parsed.intelio, KEY);
    assert.equal(parsed.vnc, VNC);
    assert.equal((await get(port, '/intelio/bootstrap')).status, 401);
    assert.equal((await get(port, '/intelio/bootstrap?profile=intelio', { authorization: 'Bearer wrong-key-wrong-key-0000' })).status, 401);
    assert.equal((await get(port, '/intelio/bootstrap?profile=arlp', { authorization: `Bearer ${KEY}` })).status, 401);
    assert.equal((await get(selfPort, '/intelio/bootstrap?profile=intelio', { authorization: `Bearer ${KEY}` })).status, 403);
    assert.equal((await get(strangerPort, '/intelio/bootstrap?profile=intelio', { authorization: `Bearer ${KEY}` })).status, 401);
    const text = logs.join('\n');
    for (const secret of [KEY, ARLP_KEY, VNC]) assert.equal(text.includes(secret), false);
    assert.match(text, /key bootstrap over tailnet login=hayden@intelio\.co profiles=/);
  } finally {
    await Promise.all([app, self, stranger].map((item) => new Promise((resolve) => item.close(resolve))));
  }
});

test('on the Tailscale route the app fetches a missing agent key by itself and stores it encrypted', async () => {
  const server = tailnetServer();
  const { port } = await server.listen();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-keys-'));
  const keyFile = path.join(userData, 'remote-hermes-keys.json');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('hex')}`),
    decryptString: (buf) => Buffer.from(buf.toString().slice(4), 'hex').toString(),
  };
  fs.writeFileSync(keyFile, JSON.stringify({ intelio: safeStorage.encryptString(KEY).toString('base64') }));
  const saved = { INTELIO_PWA_ORIGIN: process.env.INTELIO_PWA_ORIGIN, INTELIO_E2E: process.env.INTELIO_E2E };
  process.env.INTELIO_PWA_ORIGIN = `http://127.0.0.1:${port}`;
  delete process.env.INTELIO_E2E;
  let handler = null;
  const sender = { getURL: () => 'file:///app/index.html', mainFrame: {} };
  const mainWindow = { isDestroyed: () => false, webContents: sender };
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return write.call(process.stderr, chunk, ...rest); };
  try {
    const remote = setupRemoteHermes({
      app: { getPath: () => userData },
      BrowserWindow: function BrowserWindow() {},
      ipcMain: { handle: (name, fn) => { if (name === 'remote-hermes') handler = fn; } },
      safeStorage,
      shell: {},
      getPrefs: () => ({ remoteHermes: { enabled: true, host: '127.0.0.1', port: 8642, profile: 'intelio', connection: 'tailscale' } }),
      savePreferences: () => {},
      getMainWindow: () => mainWindow,
      session: null,
      net: null,
    });
    remote.register();
    assert.ok(handler);
    const result = await handler({ sender, senderFrame: sender.mainFrame }, 'refresh-keys', { profile: 'arlp' });
    assert.equal(result.refreshed, true);
    assert.equal(result.keyNote, undefined);
    const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    assert.ok(stored.arlp);
    assert.equal(fs.readFileSync(keyFile, 'utf8').includes(ARLP_KEY), false, 'keys are stored encrypted');
    assert.equal(safeStorage.decryptString(Buffer.from(stored.arlp, 'base64')), ARLP_KEY);
    assert.equal(stderr.join('').includes(ARLP_KEY), false);
  } finally {
    process.stderr.write = write;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('connecting over Tailscale refreshes keys, not only the cloud sign-in', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/intelio/remote-hermes-main.cjs'), 'utf8');
  const refresh = main.slice(main.indexOf('async function refreshConnection('), main.indexOf('async function publishVersion('));
  const tailnetBranch = refresh.slice(refresh.indexOf('} else {'));
  assert.match(tailnetBranch, /refreshKeys\(\)/);
  assert.match(main, /bootstrapOverTailnet\(\)/);
});
