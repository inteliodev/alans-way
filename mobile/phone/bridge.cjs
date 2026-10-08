'use strict';
/**
 * Loopback Twilio bridge for the VPS Hermes.
 * Caddy terminates TLS at the public host and proxies /twilio/* here.
 * Profile API keys are read on the VPS the same way as the phone client.
 * This process does not log request bodies, signatures, or keys.
 */
const crypto = require('node:crypto');
const http = require('node:http');
const { profileKeyPath, readProfileKey } = require('../pwa/identity.cjs');
const { assertSlug } = require('../pwa/profiles.cjs');
const { isTailnetOrLoopbackHost } = require('../../desktop/src/intelio/remote-hermes.cjs');

const BODY_LIMIT = 64 * 1024;
const DEFAULT_PORT = 8650;
const DEFAULT_CALLER = '+19188991650';
const PUBLIC_BASE = 'https://2-24-110-12.sslip.io/twilio';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const SPOKEN_PREFIX = 'spoken reply, no markdown';
const FILLER = 'one sec';
const STILL_WORKING = 'Still working on it.';
const STILL_WORKING_MS = 12000;
const STILL_WORKING_MAX = 3;
const GREETING = "Hi, it's intelio. What do you need?";
const FAILED_SAY = 'Sorry, intelio could not stay on the line. Try again in a minute.';

function normalizeNumber(value) {
  const compact = String(value || '').trim().replace(/[\s().-]/g, '');
  if (!compact) return '';
  const digits = (compact.startsWith('+') ? compact.slice(1) : compact).replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

function maskNumber(value) {
  return String(value ?? '').replace(/\+\d{6,}/g, (match) => `+*****${match.slice(-4)}`);
}

function parseNumberMap(raw) {
  const map = new Map();
  for (const part of String(raw || '').split(/[,\n]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const number = normalizeNumber(trimmed.slice(0, eq));
    let profile = '';
    try { profile = assertSlug(trimmed.slice(eq + 1)); } catch { profile = ''; }
    if (number && profile) map.set(number, profile);
  }
  return map;
}

function parseCallers(raw, fallback = DEFAULT_CALLER) {
  const source = String(raw ?? '').trim() ? raw : fallback;
  const list = [];
  for (const part of String(source || '').split(/[,\n]/)) {
    const number = normalizeNumber(part);
    if (number && !list.includes(number)) list.push(number);
  }
  return list;
}

function callerAllowed(callers, from) {
  const number = normalizeNumber(from);
  return Boolean(number && (callers || []).includes(number));
}

function publicUrl(base, suffix) {
  const root = String(base || '').replace(/\/+$/, '');
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${root}${path}`;
}

function relayUrl(base) {
  const httpUrl = publicUrl(base, '/relay');
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  throw new Error('PHONE_PUBLIC_BASE');
}

function parseForm(raw) {
  const params = new URLSearchParams(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || ''));
  const map = new Map();
  for (const [key, value] of params) {
    if (!map.has(key)) map.set(key, [value]);
    else map.get(key).push(value);
  }
  return map;
}

function formValue(map, key) {
  const values = map.get(key);
  return values && values.length ? values[values.length - 1] : '';
}

function computeSignature(authToken, url, params) {
  let data = String(url);
  const keys = [...(params instanceof Map ? params.keys() : Object.keys(params || {}))].sort();
  for (const key of keys) {
    const raw = params instanceof Map ? params.get(key) : params[key];
    const values = Array.isArray(raw) ? [...new Set(raw)].sort() : [raw];
    for (const value of values) data += key + value;
  }
  return crypto.createHmac('sha1', String(authToken)).update(data).digest('base64');
}

function signaturesMatch(expected, provided) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(provided || ''));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}

function rejectTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';
}

function relayTwiml({ url, greeting, nonce, action }) {
  const connect = action ? `<Connect action="${xmlEscape(action)}" method="POST">` : '<Connect>';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${connect}<ConversationRelay url="${xmlEscape(url)}" welcomeGreeting="${xmlEscape(greeting)}"><Parameter name="nonce" value="${xmlEscape(nonce)}"/></ConversationRelay></Connect></Response>`;
}

// Twilio requests the <Connect action> URL when the relay session ends. A failed
// session gets one spoken apology instead of dead air; anything else just hangs up.
function statusTwiml(failed) {
  const say = failed ? `<Say>${xmlEscape(FAILED_SAY)}</Say>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Hangup/></Response>`;
}

function shortSid(value) {
  const sid = String(value || '').replace(/[^A-Za-z0-9]/g, '');
  return sid ? `…${sid.slice(-6)}` : 'unknown';
}

function cleanLabel(value, max = 40) {
  return String(value || '')
    .replace(/[^A-Za-z0-9 _.:,'()/+-]/g, ' ')
    .replace(/\+?\d{7,}/g, (digits) => `+*****${digits.slice(-4)}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function takeSentences(buffer) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\n') continue;
    let end = i + 1;
    while (end < buffer.length && /["')\]]/.test(buffer[end])) end += 1;
    if (ch !== '\n' && end < buffer.length && !/\s/.test(buffer[end])) continue;
    while (end < buffer.length && /[ \t]/.test(buffer[end])) end += 1;
    const piece = buffer.slice(start, end);
    if (piece.trim()) sentences.push(piece);
    start = end;
    i = end - 1;
  }
  return { sentences, rest: buffer.slice(start) };
}

function loadConfig(env = process.env) {
  const missing = [];
  const token = String(env.TWILIO_AUTH_TOKEN || '');
  const account = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const base = String(env.PHONE_PUBLIC_BASE || '').trim().replace(/\/+$/, '');
  const hermes = String(env.INTELIO_HERMES_URL || '').trim();
  const port = Number(env.PHONE_BRIDGE_PORT === undefined || env.PHONE_BRIDGE_PORT === '' ? DEFAULT_PORT : env.PHONE_BRIDGE_PORT);
  if (token.length < 8 || /\s/.test(token)) missing.push('TWILIO_AUTH_TOKEN');
  if (!account || account.length > 64 || /\s/.test(account)) missing.push('TWILIO_ACCOUNT_SID');
  let baseUrl;
  try { baseUrl = new URL(base); } catch { baseUrl = null; }
  if (!baseUrl || (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') || baseUrl.username || baseUrl.password) missing.push('PHONE_PUBLIC_BASE');
  let hermesUrl;
  try { hermesUrl = new URL(hermes); } catch { hermesUrl = null; }
  if (!hermesUrl || !isTailnetOrLoopbackHost(hermesUrl.hostname) || hermesUrl.username || hermesUrl.password) missing.push('INTELIO_HERMES_URL');
  if (!Number.isInteger(port) || port < 0 || port > 65535) missing.push('PHONE_BRIDGE_PORT');
  const profiles = parseNumberMap(env.PHONE_NUMBER_PROFILES || '');
  if (!profiles.size) missing.push('PHONE_NUMBER_PROFILES');
  if (missing.length) throw new Error(`Missing or invalid phone bridge config: ${missing.join(', ')}`);
  return {
    token,
    account,
    base,
    hermes,
    port,
    profiles,
    callers: parseCallers(env.PHONE_ALLOWED_CALLERS, DEFAULT_CALLER),
    home: env.INTELIO_PHONE_HOME || undefined,
  };
}

function hermesUrl(base, profile, pathname) {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}/p/${profile}${pathname}`;
  url.search = '';
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
}

function createLimiter({ windowMs, max, now }) {
  const hits = new Map();
  return (key) => {
    const stamp = now();
    const bucket = (hits.get(key) || []).filter((at) => stamp - at < windowMs);
    if (bucket.length >= max) {
      hits.set(key, bucket);
      return false;
    }
    bucket.push(stamp);
    hits.set(key, bucket);
    return true;
  };
}

function writeHttp(res, status, body, type = 'text/plain; charset=utf-8') {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  res.writeHead(status, { 'content-type': type, 'content-length': payload.length, 'cache-control': 'no-store' });
  res.end(payload);
}

function header(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : (value || '');
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = (status) => {
      if (failed) return;
      failed = true;
      const error = new Error(status === 413 ? 'too-large' : 'bad-body');
      error.status = status;
      reject(error);
    };
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > limit) return fail(413);
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) return fail(413);
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', () => fail(400));
  });
}

// Hermes answers POST /api/sessions with {"object":"hermes.session","session":{"id":...}}.
// Older shapes put the id at the top level or under data; all three are accepted.
// Hermes refuses a second session with the same title (HTTP 400 invalid_title), so every
// call gets its own: "Phone call Oct 8, 10:41 AM · 1a2b3c" (Central time, last 6 of the CallSid).
function callTitle(callSid, at = Date.now(), attempt = 0) {
  let stamp = '';
  try {
    stamp = new Date(at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { stamp = new Date(at).toISOString().slice(0, 16).replace('T', ' '); }
  const tail = String(callSid || '').replace(/[^A-Za-z0-9]/g, '').slice(-6) || crypto.randomBytes(3).toString('hex');
  const extra = attempt ? `-${crypto.randomBytes(2).toString('hex')}` : '';
  return `Phone call ${stamp} · ${tail}${extra}`.slice(0, 120);
}

function sessionIdFrom(body) {
  if (!body || typeof body !== 'object') return '';
  const nested = body.data && typeof body.data === 'object' ? body.data : {};
  const session = body.session && typeof body.session === 'object' ? body.session : {};
  return String(session.id || body.id || body.session_id || body.sessionId || nested.id || nested.session_id || '');
}

function sendFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  if (!socket.destroyed) socket.write(Buffer.concat([header, data]));
}

function sendText(socket, text) {
  sendFrame(socket, 0x1, text);
}

function rejectUpgrade(socket, status) {
  const reason = status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Not Found';
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
}

function acceptUpgrade(socket, key) {
  const accept = crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
}

function attachFrames(socket, { onText, onClose, max = BODY_LIMIT }) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  socket.on('error', () => {});
  socket.on('end', () => {
    onClose('ended');
    if (!socket.destroyed) socket.destroy();
  });
  socket.on('close', () => onClose('closed'));
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const fin = (buf[0] & 0x80) !== 0;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const wide = buf.readBigUInt64BE(2);
        if (wide > BigInt(max)) return socket.destroy();
        length = Number(wide);
        offset = 10;
      }
      if (length > max) return socket.destroy();
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + length) return;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const copy = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) copy[i] = payload[i] ^ mask[i & 3];
        payload = copy;
      }
      buf = buf.subarray(offset + maskLen + length);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0;
        onClose(code ? `close frame ${code}` : 'close frame');
        sendFrame(socket, 0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        socket.end();
        return;
      }
      if (opcode === 0x9) { sendFrame(socket, 0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          onText(Buffer.concat(fragments).toString('utf8'));
          fragments = [];
        }
        continue;
      }
      if (opcode === 0x1) {
        if (!fin) { fragments = [payload]; continue; }
        onText(payload.toString('utf8'));
      }
    }
  });
}

function createSseParser(onEvent) {
  let buffer = '';
  return (chunk, end = false) => {
    buffer += chunk;
    if (end && buffer.trim()) buffer += '\n\n';
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) continue;
      let parsed = data.join('\n');
      try { parsed = JSON.parse(parsed); } catch { /* keep the string */ }
      onEvent({ event, data: parsed });
    }
  };
}

function createBridge({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readKey,
  log = () => {},
  now = () => Date.now(),
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
  limits = { windowMs: 10000, max: 40, fromWindowMs: 60000, fromMax: 12 },
} = {}) {
  const config = loadConfig(env);
  const nonces = new Map();
  const allowIp = createLimiter({ windowMs: limits.windowMs, max: limits.max, now });
  const allowFrom = createLimiter({ windowMs: limits.fromWindowMs, max: limits.fromMax, now });
  const note = (line) => log(maskNumber(line).slice(0, 300));
  const keyFor = readKey || ((profile) => readProfileKey(profileKeyPath({
    profile,
    env,
    home: config.home,
  })));

  function pruneNonces() {
    const stamp = now();
    for (const [key, row] of nonces) if (row.exp <= stamp) nonces.delete(key);
  }

  function issueNonce(record) {
    pruneNonces();
    const nonce = crypto.randomBytes(18).toString('base64url');
    nonces.set(nonce, { ...record, exp: now() + 120000 });
    return nonce;
  }

  function takeNonce(nonce, callSid, from) {
    pruneNonces();
    const row = nonces.get(String(nonce || ''));
    if (!row) return null;
    nonces.delete(String(nonce));
    if (row.callSid !== callSid || normalizeNumber(row.from) !== normalizeNumber(from)) return null;
    return row;
  }

  function signed(kind, params, provided) {
    const url = kind === 'relay' ? relayUrl(config.base) : publicUrl(config.base, `/${kind}`);
    const expected = computeSignature(config.token, url, params || new Map());
    return signaturesMatch(expected, provided);
  }

  async function forwardSms(profile, raw, signature, contentType) {
    const key = await keyFor(profile);
    const response = await fetchImpl(hermesUrl(config.hermes, profile, '/webhooks/twilio'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': contentType || 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature,
      },
      body: raw,
      redirect: 'error',
    });
    const text = typeof response.text === 'function' ? await response.text() : '';
    const type = response.headers?.get?.('content-type') || 'text/xml; charset=utf-8';
    return { status: response.status || 200, body: text.slice(0, BODY_LIMIT), type };
  }

  async function createSession(profile, callSid, attempts = 2) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await createSessionOnce(profile, callTitle(callSid, now(), attempt));
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    throw lastError || new Error('session');
  }

  async function createSessionOnce(profile, title) {
    const key = await keyFor(profile);
    const response = await fetchImpl(hermesUrl(config.hermes, profile, '/api/sessions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title }),
      redirect: 'error',
    });
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (!response.ok) {
      let code = '';
      try { code = String(JSON.parse(text)?.error?.code || ''); } catch { code = ''; }
      throw Object.assign(new Error('session'), { detail: `HTTP ${response.status}${code ? ` ${code}` : ''}` });
    }
    let body = {};
    try { body = JSON.parse(text); } catch { body = {}; }
    const id = sessionIdFrom(body);
    if (!id) throw Object.assign(new Error('session'), { detail: 'no session id in the Hermes reply' });
    return id;
  }

  async function speak(socket, state, profile, sessionId, prompt) {
    const turn = state.begin();
    const input = `${SPOKEN_PREFIX}\n\n${String(prompt || '').slice(0, 4000)}`;
    let pending = '';
    let fillerSent = false;
    let spoke = false;
    let sawDelta = false;
    const say = (token, last) => {
      if (!state.alive(turn) || socket.destroyed) return;
      if (String(token || '').trim()) spoke = true;
      sendText(socket, JSON.stringify({ type: 'text', token: String(token), last: Boolean(last), interruptible: true }));
    };
    let reminders = 0;
    let reminder = null;
    // A long agent turn (tools, browsing) must not leave the caller in dead air:
    // "one sec" after 1.5s, then a short reminder every 12s until the reply starts.
    const remind = () => {
      reminder = null;
      if (spoke || !state.alive(turn) || socket.destroyed || reminders >= STILL_WORKING_MAX) return;
      reminders += 1;
      sendText(socket, JSON.stringify({ type: 'text', token: STILL_WORKING, last: false, interruptible: true }));
      reminder = timers.set(() => remind(), STILL_WORKING_MS);
    };
    const filler = () => {
      if (fillerSent || spoke || !state.alive(turn)) return;
      fillerSent = true;
      sendText(socket, JSON.stringify({ type: 'text', token: FILLER, last: false, interruptible: true }));
      reminder = timers.set(() => remind(), STILL_WORKING_MS);
    };
    const timer = timers.set(() => filler(), 1500);
    const pump = (final) => {
      const taken = takeSentences(pending);
      pending = taken.rest;
      for (const sentence of taken.sentences) say(sentence, false);
      if (!final) return;
      if (taken.rest.trim()) say(taken.rest, true);
      else say('', true);
    };
    try {
      const key = await keyFor(profile);
      if (!state.alive(turn)) return;
      const response = await fetchImpl(hermesUrl(config.hermes, profile, `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ input }),
        redirect: 'error',
        signal: turn.abort.signal,
      });
      if (!response.ok || !response.body) throw new Error('stream');
      const feed = createSseParser((evt) => {
        if (!state.alive(turn)) return;
        if (evt.event === 'tool.started' || evt.event === 'tool.start') filler();
        if (evt.event === 'assistant.delta' && typeof evt.data?.delta === 'string') {
          sawDelta = true;
          pending += evt.data.delta;
          pump(false);
        } else if (evt.event === 'assistant.completed' && !sawDelta && typeof evt.data?.content === 'string') {
          pending += evt.data.content;
          pump(false);
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (state.alive(turn)) {
        const step = await reader.read();
        if (!state.alive(turn) || step.done) break;
        feed(decoder.decode(step.value, { stream: true }));
      }
      try { await reader.cancel(); } catch { /* already closed */ }
      if (!state.alive(turn)) return;
      feed(decoder.decode(), true);
      pump(true);
      note(`hermes reply spoken for ${profile}${spoke ? '' : ' (empty)'}`);
    } catch (error) {
      if (error?.name === 'AbortError' || !state.alive(turn)) return;
      note(`hermes stream failed for ${profile}`);
      if (state.alive(turn)) say('Sorry, try again in a minute.', true);
    } finally {
      timers.clear(timer);
      if (reminder) timers.clear(reminder);
    }
  }

  function connectionState() {
    let generation = 0;
    let current = null;
    return {
      begin() {
        if (current) current.abort.abort();
        generation += 1;
        const id = generation;
        const abort = new AbortController();
        current = { id, abort };
        return current;
      },
      stop() {
        if (current) current.abort.abort();
        generation += 1;
        current = null;
      },
      alive(turn) { return turn && turn.id === generation; },
    };
  }

  async function handleRelay(req, socket) {
    const remote = req.socket.remoteAddress || '';
    if (!allowIp(remote)) return rejectUpgrade(socket, 429);
    if (!signed('relay', new Map(), header(req, 'x-twilio-signature'))) {
      note('relay signature rejected');
      return rejectUpgrade(socket, 403);
    }
    const wsKey = header(req, 'sec-websocket-key');
    if (!wsKey) return rejectUpgrade(socket, 404);
    acceptUpgrade(socket, wsKey);
    const state = connectionState();
    const allowSocket = createLimiter({ windowMs: 10000, max: 60, now });
    const socketKey = crypto.randomBytes(4).toString('hex');
    let profile = '';
    let sessionId = '';
    let ready = false;
    let queuedPrompt = null;
    let callLabel = 'unknown';
    let closed = false;
    const openedAt = now();
    note('relay connected');
    const startQueued = () => {
      if (!sessionId || queuedPrompt === null || socket.destroyed) return;
      const prompt = queuedPrompt;
      queuedPrompt = null;
      speak(socket, state, profile, sessionId, prompt).catch(() => {});
    };
    attachFrames(socket, {
      onClose: (how) => {
        state.stop();
        if (closed) return;
        closed = true;
        const seconds = ((now() - openedAt) / 1000).toFixed(1);
        note(`relay closed call ${callLabel} profile ${profile || 'none'} after ${seconds}s (${how || 'closed'}${ready ? '' : ', before setup'})`);
      },
      onText: (text) => {
        if (!allowSocket(socketKey)) return socket.destroy();
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (!ready) {
          if (message.type !== 'setup') {
            note(`relay first message was ${cleanLabel(message.type, 20) || 'unknown'}, not setup`);
            return socket.end();
          }
          callLabel = shortSid(message.callSid);
          const nonce = message.customParameters?.nonce || message.customParameters?.Nonce;
          const row = takeNonce(nonce, String(message.callSid || ''), String(message.from || ''));
          if (!row) {
            note('relay setup rejected');
            sendFrame(socket, 0x8, Buffer.from([0x03, 0xEA]));
            return socket.end();
          }
          ready = true;
          profile = row.profile;
          note(`relay open call ${callLabel} profile ${profile} from ${normalizeNumber(message.from)}`);
          createSession(profile, String(message.callSid || '')).then((id) => {
            sessionId = id;
            note(`relay session ready call ${callLabel} profile ${profile}`);
            startQueued();
          }).catch((error) => {
            note(`session create failed for ${profile}${error?.detail ? ` (${cleanLabel(error.detail, 60)})` : ''}`);
            sendText(socket, JSON.stringify({ type: 'text', token: 'Sorry, try again in a minute.', last: true, interruptible: true }));
            socket.end();
          });
          return;
        }
        if (message.type === 'interrupt') {
          queuedPrompt = null;
          state.stop();
          note(`relay interrupt profile ${profile}`);
          return;
        }
        if (message.type === 'error') {
          note(`relay error from Twilio call ${callLabel}: ${cleanLabel(message.description || message.message, 120) || 'no description'}`);
          return;
        }
        if (message.type === 'prompt' && message.last === true) {
          queuedPrompt = String(message.voicePrompt || '');
          note(`relay prompt call ${callLabel} (${queuedPrompt.length} chars)`);
          startQueued();
        }
      },
    });
  }

  async function handle(req, res) {
    const remote = req.socket.remoteAddress || '';
    if (!allowIp(remote)) return writeHttp(res, 429, '');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/twilio/status') {
        const raw = await readRaw(req, BODY_LIMIT);
        const form = parseForm(raw);
        if (!signed('status', form, header(req, 'x-twilio-signature'))) {
          note('status signature rejected');
          return writeHttp(res, 403, '');
        }
        const session = cleanLabel(formValue(form, 'SessionStatus'), 20) || 'unknown';
        const callStatus = cleanLabel(formValue(form, 'CallStatus'), 20) || 'unknown';
        const duration = cleanLabel(formValue(form, 'SessionDuration'), 10) || '?';
        const code = cleanLabel(formValue(form, 'ErrorCode'), 10);
        const message = cleanLabel(formValue(form, 'ErrorMessage'), 160);
        note(`relay status call ${shortSid(formValue(form, 'CallSid'))} session ${session} call ${callStatus} duration ${duration}s${code ? ` error ${code}` : ''}${message ? ` ${message}` : ''}`);
        return writeHttp(res, 200, statusTwiml(session === 'failed'), 'text/xml; charset=utf-8');
      }
      if (req.method === 'POST' && (url.pathname === '/twilio/sms' || url.pathname === '/twilio/voice')) {
        const raw = await readRaw(req, BODY_LIMIT);
        const form = parseForm(raw);
        const from = formValue(form, 'From');
        const kind = url.pathname.endsWith('/sms') ? 'sms' : 'voice';
        if (!signed(kind, form, header(req, 'x-twilio-signature'))) {
          note(`${kind} signature rejected`);
          return writeHttp(res, 403, '');
        }
        if (from && !allowFrom(normalizeNumber(from))) return writeHttp(res, 429, '');
        const profile = config.profiles.get(normalizeNumber(formValue(form, 'To')));
        if (!profile) {
          note(`${kind} unknown destination`);
          return writeHttp(res, 404, '');
        }
        if (kind === 'sms') {
          note(`sms to profile ${profile}`);
          const upstream = await forwardSms(profile, raw, header(req, 'x-twilio-signature'), header(req, 'content-type'));
          return writeHttp(res, upstream.status, upstream.body, upstream.type);
        }
        if (!callerAllowed(config.callers, from)) {
          note(`voice rejected from ${normalizeNumber(from)}`);
          return writeHttp(res, 200, rejectTwiml(), 'text/xml; charset=utf-8');
        }
        const callSid = formValue(form, 'CallSid');
        if (!callSid) return writeHttp(res, 400, '');
        const nonce = issueNonce({ callSid, from: normalizeNumber(from), profile });
        note(`voice accepted profile ${profile} from ${normalizeNumber(from)}`);
        return writeHttp(res, 200, relayTwiml({
          url: relayUrl(config.base),
          greeting: GREETING,
          nonce,
          action: publicUrl(config.base, '/status'),
        }), 'text/xml; charset=utf-8');
      }
      writeHttp(res, 404, '');
    } catch (error) {
      if (error.status === 413) {
        writeHttp(res, 413, '');
        req.destroy();
        return;
      }
      note(`${req.method || 'request'} failed`);
      if (!res.headersSent) writeHttp(res, 502, '');
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) writeHttp(res, 502, ''); }); });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/twilio/relay' || String(header(req, 'upgrade')).toLowerCase() !== 'websocket') {
      return rejectUpgrade(socket, 404);
    }
    if (head && head.length) socket.unshift(head);
    socket.resume();
    handleRelay(req, socket).catch(() => rejectUpgrade(socket, 403));
  });

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    });
  }

  return { server, config, listen, nonces, handle };
}

async function main() {
  let bridge;
  try { bridge = createBridge({ log: (line) => process.stderr.write(`phone-bridge ${line}\n`) }); }
  catch (error) {
    process.stderr.write(`phone-bridge config: ${maskNumber(error.message)}\n`);
    process.exit(1);
  }
  try {
    const address = await bridge.listen();
    process.stderr.write(`phone-bridge listening 127.0.0.1:${address.port}\n`);
  } catch {
    process.stderr.write('phone-bridge failed to listen on 127.0.0.1\n');
    process.exit(1);
  }
}

module.exports = {
  BODY_LIMIT,
  DEFAULT_CALLER,
  PUBLIC_BASE,
  SPOKEN_PREFIX,
  FILLER,
  STILL_WORKING,
  GREETING,
  sessionIdFrom,
  callTitle,
  normalizeNumber,
  maskNumber,
  parseNumberMap,
  parseCallers,
  callerAllowed,
  publicUrl,
  relayUrl,
  parseForm,
  computeSignature,
  signaturesMatch,
  rejectTwiml,
  relayTwiml,
  statusTwiml,
  takeSentences,
  loadConfig,
  createBridge,
};

if (require.main === module) main();
