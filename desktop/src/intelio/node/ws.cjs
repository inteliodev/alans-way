'use strict';
/**
 * Minimal RFC 6455 WebSocket (text + control frames) for the intelio node.
 * Stdlib only: the VPS relay (mobile/pwa) stays dependency-free and the
 * desktop node can send the Access cookie as a request header, which the
 * WHATWG WebSocket API cannot.
 *
 * Server side: acceptWebSocket(req, socket, head) after an HTTP 'upgrade'.
 * Client side: connectWebSocket(url, { headers }) over http(s).request.
 * Both return a WsConnection: send(text), ping(), close(code, reason),
 * events 'message' (string), 'close' (code, reason), 'error'.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/** One frame. Clients must mask; servers must not. */
function encodeFrame(payload, { opcode = 0x1, mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const body = Buffer.from(data);
  for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4];
  return Buffer.concat([header, key, body]);
}

/**
 * Incremental frame parser. push(chunk) returns complete frames:
 * { fin, opcode, payload }. Throws on protocol errors (oversize, bad masking).
 */
function createFrameParser({ maxFrame = DEFAULT_MAX_MESSAGE, requireMask = null } = {}) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      const frames = [];
      while (buf.length >= 2) {
        const fin = (buf[0] & 0x80) !== 0;
        if (buf[0] & 0x70) throw new Error('ws: reserved bits set');
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        if (requireMask === true && !masked) throw new Error('ws: client frames must be masked');
        if (requireMask === false && masked) throw new Error('ws: server frames must not be masked');
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          const wide = buf.readBigUInt64BE(2);
          if (wide > BigInt(maxFrame)) throw new Error('ws: frame too large');
          len = Number(wide);
          offset = 10;
        }
        if (len > maxFrame) throw new Error('ws: frame too large');
        if (opcode >= 0x8 && (len > 125 || !fin)) throw new Error('ws: bad control frame');
        const need = offset + (masked ? 4 : 0) + len;
        if (buf.length < need) break;
        const key = masked ? buf.subarray(offset, offset + 4) : null;
        const start = offset + (masked ? 4 : 0);
        const payload = Buffer.from(buf.subarray(start, start + len));
        if (key) for (let i = 0; i < payload.length; i += 1) payload[i] ^= key[i % 4];
        buf = buf.subarray(need);
        frames.push({ fin, opcode, payload });
      }
      return frames;
    },
  };
}

class WsConnection extends EventEmitter {
  constructor(socket, { client = false, maxMessage = DEFAULT_MAX_MESSAGE, head = null } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.maxMessage = maxMessage;
    this.closed = false;
    this.lastActivity = Date.now();
    this._parser = createFrameParser({ maxFrame: maxMessage, requireMask: client ? false : true });
    this._fragments = [];
    this._fragmentSize = 0;
    this._fragmentOpcode = 0;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish(1006, ''));
    socket.on('end', () => this._finish(1006, ''));
    socket.on('error', (error) => { this.emit('error', error); this._finish(1006, ''); });
    if (head && head.length) setImmediate(() => this._onData(head));
  }

  _onData(chunk) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    let frames;
    try { frames = this._parser.push(chunk); } catch (error) {
      this.emit('error', error);
      this.close(1002, 'protocol error');
      return;
    }
    for (const frame of frames) {
      if (this.closed) return;
      this._onFrame(frame);
    }
  }

  _onFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this._write(encodeFrame(payload.subarray(0, 2), { opcode: 0x8, mask: this.client }));
      this._finish(code, reason);
      try { this.socket.end(); } catch { /* closed */ }
      return;
    }
    if (opcode === 0x9) { this._write(encodeFrame(payload, { opcode: 0xA, mask: this.client })); this.emit('ping'); return; }
    if (opcode === 0xA) { this.emit('pong'); return; }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this._fragments.length) { this.close(1002, 'protocol error'); return; }
      if (fin) { this._deliver(opcode, payload); return; }
      this._fragmentOpcode = opcode;
      this._fragments = [payload];
      this._fragmentSize = payload.length;
      return;
    }
    if (opcode === 0x0) {
      if (!this._fragments.length) { this.close(1002, 'protocol error'); return; }
      this._fragmentSize += payload.length;
      if (this._fragmentSize > this.maxMessage) { this.close(1009, 'message too big'); return; }
      this._fragments.push(payload);
      if (fin) {
        const whole = Buffer.concat(this._fragments);
        const op = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentSize = 0;
        this._deliver(op, whole);
      }
      return;
    }
    this.close(1002, 'protocol error');
  }

  _deliver(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _write(bytes) {
    if (this.socket.destroyed) return false;
    try { return this.socket.write(bytes); } catch { return false; }
  }

  send(text) {
    if (this.closed) throw new Error('WebSocket is closed.');
    return this._write(encodeFrame(Buffer.from(String(text), 'utf8'), { opcode: 0x1, mask: this.client }));
  }

  ping(data = '') {
    if (this.closed) return false;
    return this._write(encodeFrame(Buffer.from(String(data)), { opcode: 0x9, mask: this.client }));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const why = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
    const body = Buffer.alloc(2 + why.length);
    body.writeUInt16BE(code, 0);
    why.copy(body, 2);
    this._write(encodeFrame(body, { opcode: 0x8, mask: this.client }));
    this._finish(code, String(reason || ''));
    const sock = this.socket;
    setTimeout(() => { try { sock.destroy(); } catch { /* closed */ } }, 500).unref?.();
    try { sock.end(); } catch { /* closed */ }
  }

  terminate() {
    this._finish(1006, '');
    try { this.socket.destroy(); } catch { /* closed */ }
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

/** Server handshake. Returns null (and answers 400) when the request is not a WebSocket upgrade. */
function acceptWebSocket(req, socket, head, { maxMessage = DEFAULT_MAX_MESSAGE } = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] || '');
  if (upgrade !== 'websocket' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || version !== '13') {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* closed */ }
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  return new WsConnection(socket, { client: false, maxMessage, head });
}

/** Refuse an upgrade with a plain HTTP status. */
function refuseUpgrade(socket, status = 401) {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }[status] || 'Error';
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* closed */ }
}

/**
 * Client handshake over http(s). url is ws:, wss:, http: or https:.
 * Resolves a WsConnection; rejects with error.status set when the server answers HTTP instead.
 */
function connectWebSocket(rawUrl, { headers = {}, timeoutMs = 15000, maxMessage = DEFAULT_MAX_MESSAGE, agent } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { reject(new Error('Bad WebSocket URL.')); return; }
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') { reject(new Error('WebSocket URL must be ws(s) or http(s).')); return; }
    const key = crypto.randomBytes(16).toString('base64');
    const lib = secure ? https : http;
    const req = lib.request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: 'GET',
      agent,
      headers: {
        ...headers,
        Host: url.host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    let settled = false;
    const fail = (error) => { if (settled) return; settled = true; clearTimeout(timer); try { req.destroy(); } catch { /* gone */ } reject(error); };
    const timer = setTimeout(() => fail(new Error('WebSocket connect timed out.')), timeoutMs);
    req.on('error', (error) => fail(error));
    req.on('response', (res) => {
      const error = new Error(`WebSocket refused: HTTP ${res.statusCode}`);
      error.status = res.statusCode;
      error.location = String(res.headers.location || '');
      res.resume();
      fail(error);
    });
    req.on('upgrade', (res, socket, head) => {
      if (settled) { socket.destroy(); return; }
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); fail(new Error('WebSocket handshake failed.')); return; }
      settled = true;
      clearTimeout(timer);
      resolve(new WsConnection(socket, { client: true, maxMessage, head }));
    });
    req.end();
  });
}

module.exports = {
  WS_GUID,
  DEFAULT_MAX_MESSAGE,
  acceptKey,
  encodeFrame,
  createFrameParser,
  WsConnection,
  acceptWebSocket,
  refuseUpgrade,
  connectWebSocket,
};
