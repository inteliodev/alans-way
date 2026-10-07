'use strict';
/**
 * Websocket proxy from the phone to the shared-browser websockify.
 * The desktop password (`vnc=` in the import file, or INTELIO_VNC_PASSWORD)
 * is applied on this side of the RFB handshake. It is never written to the
 * browser socket and never logged.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isTailnetOrLoopbackHost } = require('../../desktop/src/intelio/remote-hermes.cjs');
const { keysFromImport, VNC_KEY } = require('../../desktop/src/intelio/remote-hermes-main.cjs');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let desModule;

function loadDes() {
  if (!desModule) {
    const file = pathToFileURL(path.join(__dirname, '../../desktop/node_modules/@novnc/novnc/core/crypto/des.js'));
    desModule = import(file.href);
  }
  return desModule;
}

function assertVnc(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('VNC URL must be http(s).');
  if (url.username || url.password) throw new Error('VNC URL must not carry credentials.');
  if (!isTailnetOrLoopbackHost(url.hostname)) throw new Error('VNC URL must stay on the tailnet or loopback.');
  return url;
}

function resolveVncUpstream(bind, raw) {
  const value = String(raw || '').trim();
  if (value) return assertVnc(value);
  const host = String(bind || '127.0.0.1').trim() || '127.0.0.1';
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return assertVnc(`http://${literal}:6080`);
}

function readVncPassword({ env = process.env, fsImpl = fs } = {}) {
  const fromEnv = String(env.INTELIO_VNC_PASSWORD || '');
  if (fromEnv) return fromEnv.length <= 256 ? fromEnv : '';
  const file = String(env.INTELIO_VNC_PASSWORD_FILE || '');
  if (!file) return '';
  try {
    const st = fsImpl.statSync(file);
    if ((st.mode & 0o077) !== 0) return '';
    const parsed = keysFromImport(fsImpl.readFileSync(file, 'utf8'));
    const value = String(parsed[VNC_KEY] || '');
    return value.length >= 1 && value.length <= 256 ? value : '';
  } catch {
    return '';
  }
}

async function vncResponse(password, challenge) {
  try {
    const { DESECBCipher } = await loadDes();
    const chars = [...String(password)].map((ch) => ch.charCodeAt(0));
    const out = DESECBCipher.importKey(chars).encrypt({ name: 'DES-ECB' }, challenge);
    if (!out) throw new Error('vnc');
    return Buffer.from(out);
  } catch {
    throw new Error('vnc');
  }
}

function toBuf(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

function byteQueue() {
  let buf = Buffer.alloc(0);
  let waiter = null;
  let ended = false;
  return {
    push(chunk) {
      if (!chunk || !chunk.length || ended) return;
      buf = Buffer.concat([buf, chunk]);
      if (waiter) { const wake = waiter; waiter = null; wake(); }
    },
    end() {
      ended = true;
      if (waiter) { const wake = waiter; waiter = null; wake(); }
    },
    async take(n) {
      while (buf.length < n) {
        if (ended) throw new Error('vnc');
        await new Promise((resolve) => { waiter = resolve; });
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return Buffer.from(out);
    },
    rest() {
      const out = buf;
      buf = Buffer.alloc(0);
      return out;
    },
  };
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function wsSend(socket, data, opcode = 0x2) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readWs(socket, onData, onClose, initial) {
  let buf = initial && initial.length ? Buffer.from(initial) : Buffer.alloc(0);
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    if (onClose) onClose();
  };
  const consume = () => {
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const wide = buf.readBigUInt64BE(2);
        if (wide > 8n * 1024n * 1024n) { socket.destroy(); done(); return; }
        len = Number(wide);
        offset = 10;
      }
      if (len > 8 * 1024 * 1024) { socket.destroy(); done(); return; }
      const masked = (buf[1] & 0x80) !== 0;
      if (buf.length < offset + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) { done(); try { socket.end(); } catch { /* already closed */ } return; }
      if (opcode === 0x9) { wsSend(socket, payload, 0xA); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) onData(payload);
    }
  };
  if (buf.length) consume();
  socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); consume(); });
  socket.on('close', done);
  socket.on('error', done);
}

function upstreamSocketUrl(upstream, reqUrl) {
  const target = new URL(upstream.href);
  const incoming = new URL(reqUrl || '/', 'http://127.0.0.1');
  const pathname = String(incoming.pathname || '/').replace(/^\/browser/, '') || '/';
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  target.search = incoming.search;
  target.username = '';
  target.password = '';
  target.hash = '';
  return target;
}

async function authenticateUpstream(q, ws, password) {
  const version = await q.take(12);
  if (!version.toString('latin1').startsWith('RFB ')) throw new Error('vnc');
  ws.send(Buffer.from('RFB 003.008\n'));
  const count = (await q.take(1))[0];
  if (!count || count > 32) throw new Error('vnc');
  const types = [...await q.take(count)];
  let scheme = 0;
  if (password && types.includes(2)) scheme = 2;
  else if (types.includes(1)) scheme = 1;
  if (!scheme) throw new Error('vnc');
  ws.send(Buffer.from([scheme]));
  if (scheme === 2) {
    const challenge = await q.take(16);
    ws.send(await vncResponse(password, challenge));
  }
  const result = await q.take(4);
  if (result.readUInt32BE(0) !== 0) throw new Error('vnc');
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vnc')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function bridgeVnc({ req, socket, head, upstream, password }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') throw new Error('vnc');
  const target = upstreamSocketUrl(upstream, req.url);
  const ws = new WebSocket(target.href);
  ws.binaryType = 'arraybuffer';
  const q = byteQueue();
  let mode = 'auth';
  const held = [];
  let finished = false;
  let accepted = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    q.end();
    if (accepted) { try { socket.destroy(); } catch { /* already closed */ } }
    try { ws.close(); } catch { /* already closed */ }
  };
  ws.addEventListener('message', (event) => {
    const buf = toBuf(event.data);
    if (mode === 'auth') q.push(buf);
    else if (mode === 'hold') held.push(buf);
    else { try { wsSend(socket, buf); } catch { finish(); } }
  });
  ws.addEventListener('close', finish);
  ws.addEventListener('error', () => q.end());
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vnc')), 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('vnc')); });
  });
  try {
    await opened;
    await withTimeout(authenticateUpstream(q, ws, password), 8000);
  } catch (error) {
    finish();
    throw error;
  }
  mode = 'hold';
  const leftover = q.rest();
  if (leftover.length) held.unshift(leftover);
  const protocol = String(req.headers['sec-websocket-protocol'] || '').split(',')[0].trim();
  accepted = true;
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
  socket.on('error', finish);
  socket.on('close', finish);
  socket.on('end', finish);
  const clientQ = byteQueue();
  let clientLive = false;
  readWs(socket, (payload) => {
    if (!clientLive) clientQ.push(payload);
    else { try { ws.send(payload); } catch { finish(); } }
  }, finish, head);
  try {
    wsSend(socket, Buffer.from('RFB 003.008\n'));
    await withTimeout(clientQ.take(12), 8000);
    wsSend(socket, Buffer.from([1, 1]));
    await withTimeout(clientQ.take(1), 8000);
    wsSend(socket, Buffer.from([0, 0, 0, 0]));
  } catch {
    finish();
    return;
  }
  const extra = clientQ.rest();
  mode = 'live';
  clientLive = true;
  if (extra.length) { try { ws.send(extra); } catch { finish(); } }
  const early = held.splice(0);
  for (const buf of early) { try { wsSend(socket, buf); } catch { finish(); } }
}

module.exports = {
  assertVnc,
  resolveVncUpstream,
  readVncPassword,
  bridgeVnc,
  wsSend,
  readWs,
};
