'use strict';
/**
 * Launch the packaged Windows app against a fake Hermes and assert the main
 * window actually renders agents. Run from desktop/ on windows-latest.
 */
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const KEYS = {
  intelio: 'i'.repeat(32),
  prc: 'p'.repeat(32),
  alignment: 'a'.repeat(32),
  hhp: 'h'.repeat(32),
};
const VNC_PASSWORD = 'e2e-vnc';

function wsSend(socket, data, opcode = 0x2) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  socket.write(Buffer.concat([header, payload]));
}

function readWs(socket, onData) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) return;
      const masked = (buf[1] & 0x80) !== 0;
      if (buf.length < offset + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) { socket.end(); return; }
      if (opcode === 0x9) { wsSend(socket, payload, 0xA); continue; }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) onData(payload);
    }
  });
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

let desModule;
function vncCipher(password, challenge) {
  // The package exports map blocks the crypto subpath. Load the file directly.
  if (!desModule) {
    const file = pathToFileURL(path.join(__dirname, '../node_modules/@novnc/novnc/core/crypto/des.js'));
    desModule = import(file.href);
  }
  return desModule.then(({ DESECBCipher }) => {
    const chars = [...String(password)].map((ch) => ch.charCodeAt(0));
    const out = DESECBCipher.importKey(chars).encrypt({ name: 'DES-ECB' }, challenge);
    if (!out) throw new Error('desktop cipher check failed');
    return Buffer.from(out);
  });
}

function acceptDesktop(server, password, vnc) {
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    const url = String(req.url || '');
    if (url.includes(password) || /[?&]password=/.test(url)) vnc.leaked = true;
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const protocol = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
    let raw = Buffer.alloc(0);
    let stage = 'version';
    const challenge = crypto.randomBytes(16);
    const consume = () => {
      if (stage === 'version' && raw.length >= 12) {
        raw = raw.subarray(12);
        stage = 'type';
        wsSend(socket, Buffer.from([1, 2]));
      }
      if (stage === 'type' && raw.length >= 1) {
        raw = raw.subarray(1);
        stage = 'response';
        wsSend(socket, challenge);
      }
      if (stage === 'response' && raw.length >= 16) {
        const got = Buffer.from(raw.subarray(0, 16));
        raw = raw.subarray(16);
        stage = 'checking';
        vncCipher(password, challenge).then((expected) => {
          const match = got.length === expected.length && crypto.timingSafeEqual(got, expected);
          if (!match) { vnc.rejected = true; wsSend(socket, Buffer.from([0, 0, 0, 1])); return; }
          vnc.ok = true;
          wsSend(socket, Buffer.from([0, 0, 0, 0]));
          stage = 'client';
          consume();
        }).catch(() => { vnc.cipherError = true; });
      }
      if (stage === 'client' && raw.length >= 1) {
        raw = raw.subarray(1);
        stage = 'done';
        wsSend(socket, serverInit());
      }
    };
    wsSend(socket, Buffer.from('RFB 003.008\n'));
    readWs(socket, (payload) => { raw = Buffer.concat([raw, payload]); consume(); });
  });
}

function openCdp(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`CDP socket failed for ${url}`)));
  });
  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString();
    const msg = JSON.parse(raw);
    if (!msg.id || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP error'));
    else waiter.resolve(msg.result);
  });
  return {
    async send(method, params, ms = 10000) {
      await opened;
      const id = ++seq;
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`${method} timed out after ${ms}ms`));
        }, ms);
      });
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

function listen(vncPassword) {
  const vnc = { ok: false, rejected: false, leaked: false, cipherError: false };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    const json = (body) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') {
      json({ status: 'ok', platform: 'hermes-agent', version: '0.21.5' });
      return;
    }
    if (url.pathname === '/api/home' || url.pathname === '/api/profiles') {
      if (auth !== `Bearer ${KEYS.intelio}`) { res.statusCode = 401; json({}); return; }
      json({ profiles: [
        { id: 'intelio', name: 'Intelio' },
        { id: 'prc', name: 'PRC' },
        { id: 'alignment', name: 'Alignment' },
        { id: 'hhp', name: 'HHP' },
      ] });
      return;
    }
    const sessions = url.pathname.match(/^\/p\/([a-z0-9_-]+)\/api\/sessions$/);
    if (req.method === 'GET' && sessions) {
      const profile = sessions[1];
      if (auth !== `Bearer ${KEYS[profile] || ''}`) { res.statusCode = 401; json({}); return; }
      json({ data: [{ id: 's1', source: 'telegram', title: 'Friday notes', preview: 'Need your yes.' }] });
      return;
    }
    const messages = url.pathname.match(/^\/p\/([a-z0-9_-]+)\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === 'GET' && messages) {
      const profile = messages[1];
      if (auth !== `Bearer ${KEYS[profile] || ''}`) { res.statusCode = 401; json({}); return; }
      json({ data: [{ role: 'user', content: 'Pull the Friday notes.' }, { role: 'assistant', content: 'Three takeaways.' }] });
      return;
    }
    if (url.pathname === '/vnc.html') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>fake noVNC</title><p>fake desktop</p>');
      return;
    }
    res.statusCode = 404;
    json({});
  });
  acceptDesktop(server, vncPassword, vnc);
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('error', () => {});
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, vnc })));
}

async function main() {
  const exe = path.resolve('dist/win-unpacked/Intelio.exe');
  if (!fs.existsSync(exe)) throw new Error(`packaged exe missing: ${exe}`);
  const shot = path.resolve('dist/e2e-main-window.png');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-e2e-'));
  const { server, vnc } = await listen(VNC_PASSWORD);
  const port = server.address().port;
  fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({
    preview: false,
    savedTabs: [],
    remoteUrl: `http://127.0.0.1:${port}/vnc.html`,
    remoteHermes: { enabled: true, host: '127.0.0.1', port, profile: 'intelio' },
  }));
  fs.writeFileSync(path.join(userData, 'remote-hermes-key.import'), `${Object.entries(KEYS).map(([name, key]) => `${name}=${key}`).join('\n')}\nvnc=${VNC_PASSWORD}\n`);

  const child = spawn(exe, ['--remote-debugging-port=0', '--disable-gpu'], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      HERMES_WORKSPACE_DATA: userData,
      INTELIO_E2E: '1',
      INTELIO_PYTHON: 'intelio-no-python',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let cdp;
  let errBuf = '';
  const waitForDevtools = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DevTools port did not open\n${errBuf.slice(-2000)}`)), 60000);
    const take = (chunk) => {
      const text = chunk.toString();
      errBuf += text;
      process.stderr.write(text);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/.exec(errBuf);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stderr.on('data', take);
    child.on('exit', (code) => reject(new Error(`Intelio exited ${code} before DevTools opened\n${errBuf.slice(-2000)}`)));
  });
  child.on('error', () => {});
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  try {
    const ws = await waitForDevtools;
    const port = new URL(ws).port;
    const deadline = Date.now() + 30000;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && /index\.html/.test(item.url || '') && item.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* port is up before the window */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!target) throw new Error('main window did not open');
    cdp = openCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const read = async () => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => ({
          agents: document.querySelectorAll('#bot-list .bot-row').length,
          sessions: document.querySelectorAll('#remote-sessions .session-item').length,
          status: (document.getElementById('remote-status') || {}).textContent || '',
          pin: (document.getElementById('hermes-pin') || {}).textContent || '',
          profile: (document.getElementById('intelio-profile') || {}).textContent || '',
        }))()`,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description
          || result.exceptionDetails.text
          || 'page evaluate failed';
        throw new Error(detail);
      }
      return result.result.value;
    };
    let view = { agents: 0, sessions: 0, status: '', pin: '', profile: '' };
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      view = await read();
      const pin = String(view.pin || '');
      if (view.agents === 4 && view.sessions >= 1 && /hermes-agent 0\.21\.5/.test(pin) && !/unavailable/i.test(pin) && (vnc.ok || vnc.rejected || vnc.leaked || vnc.cipherError)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    const status = String(view.status || '').trim();
    const pin = String(view.pin || '').trim();
    const profile = String(view.profile || '').trim();
    const bad = /unavailable|not defined|unreachable|HTTP |No key|No API|failed|error/i;
    process.stdout.write(`e2e agents=${view.agents} sessions=${view.sessions} status=${JSON.stringify(status)} pin=${JSON.stringify(pin)} profile=${JSON.stringify(profile)}\n`);
    if (view.agents !== 4) throw new Error(`expected 4 agents, saw ${view.agents}`);
    if (view.sessions < 1) throw new Error(`expected a session, saw ${view.sessions}`);
    if (bad.test(status)) throw new Error(`status line: ${status}`);
    if (bad.test(pin) || !/hermes-agent 0\.21\.5/.test(pin)) throw new Error(`status line: ${pin}`);
    if (/not defined|Loading/i.test(profile)) throw new Error(`profile line: ${profile}`);
    if (vnc.cipherError) throw new Error('desktop cipher check failed');
    if (vnc.leaked) throw new Error('desktop password was placed in the viewer URL');
    if (vnc.rejected) throw new Error('desktop password did not match');
    if (!vnc.ok) throw new Error('desktop did not send the stored password');
    let pane = null;
    const deskUntil = Date.now() + 10000;
    let deskCdp;
    try {
      while (Date.now() < deskUntil) {
        const pages = await (await fetch(`http://127.0.0.1:${new URL(ws).port}/json/list`)).json();
        const deskTarget = pages.find((item) => item.type === 'page' && /remote\.html/.test(item.url || '') && item.webSocketDebuggerUrl);
        if (!deskTarget) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        if (!deskCdp) {
          deskCdp = openCdp(deskTarget.webSocketDebuggerUrl);
          await deskCdp.send('Runtime.enable');
        }
        try {
          const desk = await deskCdp.send('Runtime.evaluate', {
            expression: `(() => ({
              prompt: !document.getElementById('credentials').classList.contains('hidden'),
              connected: document.getElementById('connection-dot').classList.contains('connected'),
              filled: Boolean((document.getElementById('vnc-password') || {}).value),
            }))()`,
            returnByValue: true,
          });
          if (!desk.exceptionDetails) pane = desk.result && desk.result.value;
        } catch { /* page is still loading */ }
        if (pane && pane.connected && !pane.prompt && !pane.filled) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      if (deskCdp) deskCdp.close();
    }
    if (!pane || pane.prompt || pane.filled || !pane.connected) throw new Error('desktop password prompt was shown');
    process.stdout.write('e2e desktop=authenticated\n');
    process.stdout.write(`screenshot ${shot}\n`);
  } catch (error) {
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill();
    server.close();
  }
}

module.exports = { listen, vncCipher };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exit(1);
  });
}
