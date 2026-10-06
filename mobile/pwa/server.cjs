'use strict';
/**
 * Tailnet-only phone client for the VPS Hermes.
 * The profile API key is accepted once at POST /session, kept in memory, and
 * never written into the static JavaScript or onto disk.
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const { isTailnetOrLoopbackHost, normalizeRemoteConfig, DEFAULT_PORT } = require('../../desktop/src/intelio/remote-hermes.cjs');
const { resolveRepoRoot } = require('../../desktop/src/intelio/paths.cjs');
const { readBrandPng, scalePng } = require('../../desktop/src/intelio/png-icon.cjs');

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SESSION_MS = 12 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function icons() {
  const png = readBrandPng(resolveRepoRoot());
  return {
    '/icon-192.png': scalePng(png, 192, 192),
    '/icon-512.png': scalePng(png, 512, 512),
    '/apple-touch-icon.png': scalePng(png, 180, 180),
  };
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return '';
}

function assertUpstream(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Hermes URL must be http(s).');
  if (url.username || url.password) throw new Error('Hermes URL must not carry credentials.');
  if (!isTailnetOrLoopbackHost(url.hostname)) throw new Error('Hermes URL must stay on the tailnet or loopback.');
  return url;
}

function createPwaServer({
  bind = process.env.INTELIO_PWA_BIND,
  port = Number(process.env.INTELIO_PWA_PORT || 8643),
  upstream = process.env.INTELIO_HERMES_URL || `http://127.0.0.1:${DEFAULT_PORT}`,
  profile = process.env.INTELIO_HERMES_PROFILE || 'intelio',
  certPath = process.env.INTELIO_PWA_CERT || '',
  keyPath = process.env.INTELIO_PWA_KEY || '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!isTailnetOrLoopbackHost(bind)) throw new Error('Refusing to listen: bind address must be a Tailscale address or loopback.');
  const upstreamUrl = assertUpstream(upstream);
  const normalized = normalizeRemoteConfig({ host: '127.0.0.1', port: 8642, profile });
  const profileName = normalized.profile;
  const prefix = profileName ? `/p/${profileName}` : '';
  const sessions = new Map();
  const failures = new Map();
  const iconBytes = icons();

  function prune() {
    for (const [token, session] of sessions) if (session.exp <= now()) sessions.delete(token);
  }
  function sessionFrom(req) {
    prune();
    const token = readCookie(req.headers.cookie, 'intelio_session');
    const session = token ? sessions.get(token) : null;
    if (!session || session.exp <= now()) return null;
    return session;
  }
  function originOk(req) {
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  function send(res, code, body, headers = {}) {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': payload.length, ...headers });
    res.end(payload);
  }
  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('Request body is too large.');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function hermesUrl(pathname, query) {
    const url = new URL(upstreamUrl.toString());
    url.pathname = prefix + pathname;
    url.search = '';
    for (const [key, value] of Object.entries(query || {})) if (value) url.searchParams.set(key, value);
    return url;
  }
  async function forward(req, res, pathname, { method = 'GET', body, query, stream = false } = {}) {
    const session = sessionFrom(req);
    if (!session) return send(res, 401, { error: 'Sign in again.' });
    const response = await fetchImpl(hermesUrl(pathname, query), {
      method,
      headers: { Authorization: `Bearer ${session.key}`, Accept: stream ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
    });
    if (stream) {
      res.writeHead(response.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      if (!response.body) return res.end();
      const reader = response.body.getReader();
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        res.write(Buffer.from(step.value));
      }
      return res.end();
    }
    const text = await response.text();
    res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  async function handle(req, res) {
    if (!originOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/session' || url.pathname === '/session/')) {
        return send(res, 200, { ok: Boolean(sessionFrom(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/session') {
        const ip = req.socket.remoteAddress || '';
        const recent = (failures.get(ip) || []).filter((at) => now() - at < 10 * 60 * 1000);
        if (recent.length >= 8) return send(res, 429, { error: 'Too many sign-in attempts.' });
        const body = await readBody(req, 4096);
        const key = String(body.key || '').trim();
        if (key.length < 16) return send(res, 400, { error: 'That key is too short.' });
        const probe = await fetchImpl(hermesUrl('/v1/capabilities'), { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, redirect: 'error' });
        if (!probe.ok) {
          recent.push(now());
          failures.set(ip, recent);
          await probe.text().catch(() => '');
          return send(res, 401, { error: 'That key was refused for this profile.' });
        }
        await probe.text().catch(() => '');
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { key, exp: now() + SESSION_MS });
        const secure = req.socket.encrypted ? '; Secure' : '';
        return send(res, 200, { ok: true }, { 'set-cookie': `intelio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
      }
      if (req.method === 'DELETE' && url.pathname === '/session') {
        const token = readCookie(req.headers.cookie, 'intelio_session');
        if (token) sessions.delete(token);
        return send(res, 200, { ok: true }, { 'set-cookie': 'intelio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return await forward(req, res, '/api/sessions', { query: { source: url.searchParams.get('source') || '', limit: '100', offset: '0' } });
      }
      const messages = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'GET' && messages && ID_RE.test(messages[1])) {
        return await forward(req, res, `/api/sessions/${messages[1]}/messages`, { query: { inline_images: 'false' } });
      }
      const chat = url.pathname.match(/^\/api\/sessions\/([^/]+)\/chat$/);
      if (req.method === 'POST' && chat && ID_RE.test(chat[1])) {
        const body = await readBody(req, 200000);
        return await forward(req, res, `/api/sessions/${chat[1]}/chat/stream`, { method: 'POST', body: { input: String(body.input || '').slice(0, 100000) }, stream: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readBody(req, 4096);
        return await forward(req, res, '/api/sessions', { method: 'POST', body: { title: String(body.title || '').slice(0, 200) } });
      }
      if (req.method === 'GET' && iconBytes[url.pathname]) {
        const payload = iconBytes[url.pathname];
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': payload.length, 'cache-control': 'public, max-age=86400' });
        return res.end(payload);
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const name = STATIC[url.pathname];
        const file = path.join(PUBLIC, name);
        const payload = fs.readFileSync(file);
        const ext = path.extname(name);
        res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': payload.length, 'cache-control': name === 'sw.js' ? 'no-cache' : 'public, max-age=300' });
        return res.end(payload);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      return send(res, 400, { error: String(error?.message || 'Bad request').slice(0, 200) });
    }
  }

  let server;
  if (certPath || keyPath) {
    if (!certPath || !keyPath) throw new Error('Set both INTELIO_PWA_CERT and INTELIO_PWA_KEY, or neither.');
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handle);
  } else server = http.createServer(handle);

  return {
    server,
    sessions,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => resolve(server.address()));
      });
    },
  };
}

module.exports = { createPwaServer };

if (require.main === module) {
  const app = createPwaServer();
  app.listen().then((address) => {
    process.stdout.write(`Intelio phone client listening on ${address.address}:${address.port}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
