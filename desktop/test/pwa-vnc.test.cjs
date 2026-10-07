const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');
const { resolveVncUpstream, readVncPassword, wsSend, readWs } = require('../../mobile/pwa/vnc-proxy.cjs');
const { vncCipher } = require('../scripts/packaged-window-e2e.cjs');
const { agentsFromKeys } = require('../src/intelio/remote-main-data.cjs');

const TEAM = 'https://access.example.test';
const AUD = 'test-aud-not-the-live-tag';
const EMAIL = 'hayden@intelio.co';
const PASSWORD = 'e2e-vnc';

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

function token() {
  return sign({ iss: TEAM, aud: AUD, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 600 });
}

function serverInit() {
  const name = Buffer.from('desk');
  const buf = Buffer.alloc(24 + name.length);
  buf.writeUInt16BE(64, 0);
  buf.writeUInt16BE(64, 2);
  buf[4] = 32; buf[5] = 24; buf[6] = 0; buf[7] = 1;
  buf.writeUInt16BE(255, 8);
  buf.writeUInt16BE(255, 10);
  buf.writeUInt16BE(255, 12);
  buf[14] = 16; buf[15] = 8; buf[16] = 0;
  buf.writeUInt32BE(name.length, 20);
  name.copy(buf, 24);
  return buf;
}

function listenRfb(password) {
  const sessions = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const vnc = { ok: false, rejected: false, challenge: crypto.randomBytes(16) };
    sessions.push(vnc);
    let raw = Buffer.alloc(0);
    let stage = 'version';
    const consume = () => {
      if (stage === 'version' && raw.length >= 12) {
        raw = raw.subarray(12);
        stage = 'type';
        socket.write(Buffer.from([1, 2]));
      }
      if (stage === 'type' && raw.length >= 1) {
        const picked = raw[0];
        raw = raw.subarray(1);
        if (picked !== 2) { stage = 'fail'; socket.end(); return; }
        stage = 'response';
        socket.write(vnc.challenge);
      }
      if (stage === 'response' && raw.length >= 16) {
        const got = Buffer.from(raw.subarray(0, 16));
        raw = raw.subarray(16);
        stage = 'checking';
        vncCipher(password, vnc.challenge).then((expected) => {
          const match = got.length === expected.length && crypto.timingSafeEqual(got, expected);
          if (!match) { vnc.rejected = true; socket.write(Buffer.from([0, 0, 0, 1])); socket.end(); return; }
          vnc.ok = true;
          socket.write(Buffer.from([0, 0, 0, 0]));
          stage = 'client';
          consume();
        }).catch(() => { vnc.rejected = true; socket.end(); });
      }
      if (stage === 'client' && raw.length >= 1) {
        raw = raw.subarray(1);
        stage = 'done';
        socket.write(serverInit());
      }
    };
    socket.write(Buffer.from('RFB 003.008\n'));
    socket.on('data', (chunk) => { raw = Buffer.concat([raw, chunk]); consume(); });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, sessions }));
  });
}

function startWebsockify(tcpPort) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => {
        const child = spawn('python3', ['-m', 'websockify', `127.0.0.1:${port}`, `127.0.0.1:${tcpPort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('websockify did not listen')); }, 8000);
        const onData = (chunk) => {
          text += chunk.toString();
          if (!text.includes('Listen on')) return;
          clearTimeout(timer);
          child.stdout.removeListener('data', onData);
          child.stderr.removeListener('data', onData);
          child.unref();
          resolve({ child, port });
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', () => {});
      });
    });
  });
}

function wsSendMasked(socket, data) {
  const payload = Buffer.from(data);
  const mask = crypto.randomBytes(4);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x82;
  if (payload.length < 126) header[1] = 0x80 | payload.length;
  else { header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  socket.write(Buffer.concat([header, mask, masked]));
}

function openSocket(port, headers) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/browser/websockify',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket, head) => { socket.pause(); resolve({ status: res.statusCode, socket, head }); });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        res.socket.destroy();
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function frameQueue(socket, head) {
  const queue = [];
  const received = [];
  let waiter = null;
  readWs(socket, (payload) => {
    received.push(payload);
    if (waiter) { const next = waiter; waiter = null; next(payload); }
    else queue.push(payload);
  }, () => {}, head);
  socket.resume();
  return {
    received,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
}

async function phoneHandshake(socket, head) {
  const frames = frameQueue(socket, head);
  const version = await frames.next();
  assert.equal(version.toString(), 'RFB 003.008\n');
  wsSendMasked(socket, Buffer.from('RFB 003.008\n'));
  const types = await frames.next();
  assert.deepEqual([...types], [1, 1]);
  wsSendMasked(socket, Buffer.from([1]));
  const result = await frames.next();
  assert.deepEqual([...result], [0, 0, 0, 0]);
  wsSendMasked(socket, Buffer.from([1]));
  const init = await frames.next();
  return { frames, init };
}

test('the VNC target follows the phone bind and refuses a public host', () => {
  const derived = resolveVncUpstream('intelio-vps.tail9c1007.ts.net', '');
  assert.equal(derived.hostname, 'intelio-vps.tail9c1007.ts.net');
  assert.equal(derived.port, '6080');
  const loop = resolveVncUpstream('127.0.0.1', '');
  assert.equal(loop.hostname, '127.0.0.1');
  assert.equal(loop.port, '6080');
  const explicit = resolveVncUpstream('127.0.0.1', 'http://127.0.0.1:6090/websockify');
  assert.equal(explicit.port, '6090');
  assert.throws(() => resolveVncUpstream('127.0.0.1', 'http://example.com:6080'), /tailnet or loopback/);
  assert.throws(() => resolveVncUpstream('127.0.0.1', 'http://user:secret@127.0.0.1:6080'), /credentials/);
  assert.throws(() => createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    upstream: 'http://127.0.0.1:9',
    vncUpstream: 'http://example.com:6080',
    vncPassword: '',
  }), /tailnet or loopback/);
  const named = agentsFromKeys(['prc', 'hhp', 'alignment', 'intelio']);
  assert.deepEqual(named.map((agent) => agent.name), ['intelio', 'PRC', 'Alignment', 'HHP']);
});

test('a mode-600 vnc= file is read and a world-readable file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vnc-file-'));
  const file = path.join(dir, 'vnc.import');
  fs.writeFileSync(file, 'vnc=e2e-vnc\nintelio=abcdefghijklmnop\n', { mode: 0o600 });
  assert.equal(readVncPassword({ env: { INTELIO_VNC_PASSWORD_FILE: file } }), PASSWORD);
  fs.chmodSync(file, 0o644);
  assert.equal(readVncPassword({ env: { INTELIO_VNC_PASSWORD_FILE: file } }), '');
  assert.equal(readVncPassword({ env: { INTELIO_VNC_PASSWORD: PASSWORD, INTELIO_VNC_PASSWORD_FILE: file } }), PASSWORD);
  assert.equal(readVncPassword({ env: {} }), '');
});

test('the Access listener proxies websockify and keeps the VNC password on the server', { timeout: 20000 }, async () => {
  const rfb = await listenRfb(PASSWORD);
  const websockify = await startWebsockify(rfb.server.address().port);
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vnc-vault-'));
  fs.mkdirSync(path.join(vaultRoot, 'intelio', 'bot-desktop'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'intelio', 'bot-desktop', 'cdp.url'), 'http://127.0.0.1:9223\n', { mode: 0o600 });
  const logs = [];
  const jwt = token();
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
    vncUpstream: `http://127.0.0.1:${websockify.port}`,
    vncPassword: PASSWORD,
    log: (line) => logs.push(line),
    fetchImpl: async (url) => {
      const href = String(url);
      if (href === `${TEAM}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [jwk] }) };
      if (href.endsWith('/json/list')) {
        return { ok: true, json: async () => [{ type: 'page', url: 'https://www.accounts.example.com/login?token=secret-query' }] };
      }
      throw new Error('upstream');
    },
  });
  await app.listen();
  const port = app.local.address().port;
  let socket;
  let headerSocket;
  try {
    const missing = await openSocket(port, {});
    assert.equal(missing.status, 401);
    const headered = await openSocket(port, { 'cf-access-jwt-assertion': jwt });
    assert.equal(headered.status, 101);
    headerSocket = headered.socket;
    const headerSession = await phoneHandshake(headered.socket, headered.head);
    assert.match(headerSession.init.toString('latin1'), /desk/);
    headered.socket.destroy();
    const cooked = await openSocket(port, { cookie: `CF_Authorization=${jwt}` });
    assert.equal(cooked.status, 101);
    socket = cooked.socket;
    const cookieSession = await phoneHandshake(socket, cooked.head);
    assert.match(cookieSession.init.toString('latin1'), /desk/);
    const seen = Buffer.concat([...headerSession.frames.received, ...cookieSession.frames.received]);
    assert.equal(seen.includes(Buffer.from(PASSWORD)), false);
    assert.equal(rfb.sessions.filter((row) => row.ok).length >= 2, true);
    for (const row of rfb.sessions) {
      if (row.challenge) assert.equal(seen.includes(row.challenge), false);
    }
    const wrong = createPwaServer({
      bind: '127.0.0.1',
      port: 0,
      localPort: 0,
      upstream: 'http://127.0.0.1:9',
      accessMode: true,
      accessAud: AUD,
      accessEmails: [EMAIL],
      accessTeam: TEAM,
      vncUpstream: `http://127.0.0.1:${websockify.port}`,
      vncPassword: 'other-pw',
      log: (line) => logs.push(line),
      fetchImpl: async (url) => {
        if (String(url) === `${TEAM}/cdn-cgi/access/certs`) return { ok: true, json: async () => ({ keys: [jwk] }) };
        throw new Error('upstream');
      },
    });
    await wrong.listen();
    try {
      const rejected = await openSocket(wrong.local.address().port, { cookie: `CF_Authorization=${jwt}` });
      assert.equal(rejected.status, 502);
      assert.equal(rfb.sessions.some((row) => row.rejected), true);
    } finally {
      await new Promise((resolve) => wrong.close(resolve));
    }
    const site = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/browser/site',
        headers: {
          cookie: `CF_Authorization=${jwt}`,
          'x-intelio-profile': 'intelio',
          connection: 'close',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          res.socket?.destroy();
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(site.status, 200);
    assert.equal(JSON.parse(site.body).domain, 'accounts.example.com');
    assert.equal(site.body.includes('secret-query'), false);
    const text = [missing.body || '', site.body, logs.join('\n')].join('\n');
    assert.equal(text.includes(PASSWORD), false);
    assert.equal(text.includes('other-pw'), false);
    assert.equal(text.includes(jwt), false);
    assert.match(logs.join('\n'), /vnc upstream failed/);
  } finally {
    try { headerSocket?.destroy(); } catch { /* already closed */ }
    try { socket?.destroy(); } catch { /* already closed */ }
    await new Promise((resolve) => app.close(resolve));
    websockify.child.kill();
    rfb.server.close();
  }
});

test('the phone page names the agents and does not leave the browser placeholder stuck', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/server.cjs'), 'utf8');
  const docs = fs.readFileSync(path.join(__dirname, '../../docs/intelio-windows-and-mobile.md'), 'utf8');
  assert.match(appJs, /Saved logins/);
  assert.match(appJs, /call-choice/);
  assert.match(appJs, /The shared browser is not connected/);
  assert.match(appJs, /securityfailure/);
  assert.match(appJs, /aria-label', 'Saved login for this site'/);
  assert.equal(appJs.includes('row.password'), false);
  assert.match(docs, /INTELIO_PWA_VNC_URL/);
  assert.match(docs, /CF_Authorization/);
  assert.match(docs, /INTELIO_VNC_PASSWORD_FILE/);
  assert.match(server, /CF_Authorization/);
  assert.match(server, /INTELIO_PWA_VNC_URL/);
});
