'use strict';
/**
 * intelio workspace — HTTPS server on the Tailscale IP only.
 * Every HTTP request and WebSocket upgrade must come from an allowed
 * Tailscale login (same allowlist as the intelio phone server).
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { WebSocketServer } = require('ws');
const { createIdentity, parseAllowlist } = require('./lib/identity.cjs');
const ws = require('./lib/workspace.cjs');

const BIND = process.env.WS_BIND || '100.111.128.12';
const PORT = Number(process.env.WS_PORT || 8670);
const HOST = process.env.WS_PUBLIC_HOST || 'intelio-vps.tail9c1007.ts.net';
const CERT = process.env.WS_CERT || '/home/hayden/.config/intelio/intelio-vps.tail9c1007.ts.net.crt';
const KEY = process.env.WS_KEY || '/home/hayden/.config/intelio/intelio-vps.tail9c1007.ts.net.key';
const ALLOWED = parseAllowlist(process.env.WS_ALLOWED_LOGINS || 'inteliodev@github');
const SELF_ORIGIN = `https://${HOST}:${PORT}`;
const STATIC = path.join(__dirname, 'static');
const LOGDIR = path.join(__dirname, 'logs');
const MAX_BODY = 256 * 1024;

if (!/^100\.\d+\.\d+\.\d+$/.test(BIND) && BIND !== '127.0.0.1') throw new Error('Refusing to listen: bind must be a Tailscale (100.x) address.');
fs.mkdirSync(LOGDIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOGDIR, 'server.log'), { flags: 'a' });
function log(...a) { const line = `${new Date().toISOString()} ${a.join(' ')}\n`; logStream.write(line); process.stdout.write(line); }
ws.setLogger(log);

const identity = createIdentity({ allowlist: ALLOWED });
let tlsCert = fs.readFileSync(CERT);
let tlsKey = fs.readFileSync(KEY);
ws.configurePreview({ cert: tlsCert, key: tlsKey, identify: (ip) => identity.identify(ip), bind: BIND, host: HOST });

// ------------------------------------------------------------ http helpers
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin === 'null' || origin === SELF_ORIGIN) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Intelio-Workspace',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
  }
  return { Vary: 'Origin' };
}
function send(req, res, status, body, extra = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(req), ...extra });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };
function serveStatic(req, res, rel) {
  const full = path.resolve(STATIC, rel);
  if (!full.startsWith(STATIC + path.sep)) return send(req, res, 404, 'not found');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(req, res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(req) });
    fs.createReadStream(full).pipe(res);
  });
}

// ------------------------------------------------------------ routes
async function route(req, res, url) {
  const p = url.pathname;
  const m = p.match(/^\/api\/tasks\/([0-9a-f]{8})(?:\/(.*))?$/);
  if (req.method === 'GET') {
    if (p === '/' || p === '/index.html') return serveStatic(req, res, 'index.html');
    if (p.startsWith('/static/')) return serveStatic(req, res, p.slice(8));
    if (p === '/api/summary') return send(req, res, 200, ws.summary());
    if (p === '/api/config') return send(req, res, 200, { ...ws.engineStatus(), host: HOST, login: req.login, maxRunning: 2 });
    if (p === '/api/repos') return send(req, res, 200, { repos: await ws.listRepos() });
    if (p === '/api/tasks') return send(req, res, 200, { tasks: ws.listTasks() });
    if (m) {
      const t = ws.getTask(m[1]);
      if (!t) return send(req, res, 404, { error: 'No such task.' });
      const sub = m[2] || '';
      if (sub === '') return send(req, res, 200, { task: ws.publicTask(t) });
      if (sub === 'conversation') {
        const conv = ws.conversation(t.id);
        if (url.searchParams.get('v') === String(conv.version)) return send(req, res, 200, { unchanged: true, version: conv.version, task: ws.publicTask(t) });
        return send(req, res, 200, { ...conv, task: ws.publicTask(t) });
      }
      if (sub === 'changes') return send(req, res, 200, await ws.changes(t));
      if (sub === 'files') return send(req, res, 200, await ws.fileList(t));
      if (sub === 'file') return send(req, res, 200, await ws.readFileSafe(t, url.searchParams.get('path')));
      if (sub === 'processes') return send(req, res, 200, { windows: await ws.windows(t) });
      if (sub === 'preview') return send(req, res, 200, await ws.previewStatus(t));
      if (sub === 'pr') return send(req, res, 200, await ws.prStatus(t));
    }
    return send(req, res, 404, { error: 'Not found' });
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    if (p === '/api/repos/validate') return send(req, res, 200, await ws.validateGithub(String(body.repo || '').trim()));
    if (p === '/api/tasks') return send(req, res, 200, { task: ws.createTask(body) });
    if (p === '/api/status/refresh') { await ws.refreshStatus(); return send(req, res, 200, ws.engineStatus()); }
    if (p === '/api/models/probe') return send(req, res, 200, await ws.probeModel(String(body.provider || ''), String(body.model || '')));
    if (m) {
      const t = ws.getTask(m[1]);
      if (!t) return send(req, res, 404, { error: 'No such task.' });
      const sub = m[2] || '';
      log(`action task=${t.id} ${sub} by=${req.login}`);
      if (sub === 'message') return send(req, res, 200, { task: ws.message(t, body) });
      if (sub === 'stop') { await ws.stop(t); return send(req, res, 200, { task: ws.publicTask(t) }); }
      if (sub === 'status') { ws.setStatus(t, body.status); return send(req, res, 200, { task: ws.publicTask(t) }); }
      if (sub === 'preview/start') return send(req, res, 200, await ws.previewStart(t));
      if (sub === 'preview/stop') { await ws.previewStop(t); return send(req, res, 200, { state: 'stopped' }); }
      if (sub === 'commit') return send(req, res, 200, await ws.commitAll(t, body.message));
      if (sub === 'helpers') return send(req, res, 200, { task: ws.setHelpers(t, body.helpers) });
      if (sub === 'push') return send(req, res, 200, await ws.push(t));
      if (sub === 'pr/open') return send(req, res, 200, await ws.openPr(t));
      if (sub === 'ready') return send(req, res, 200, await ws.prReady(t));
      if (sub === 'merge') {
        if (body.confirm !== 'merge-to-main') return send(req, res, 400, { error: 'Merge needs explicit confirmation.' });
        log(`MERGE TO MAIN approved task=${t.id} pr=${t.pr && t.pr.url} by=${req.login}`);
        return send(req, res, 200, await ws.mergeToMain(t, body.method));
      }
    }
    return send(req, res, 404, { error: 'Not found' });
  }
  return send(req, res, 405, { error: 'Method not allowed' });
}

async function handler(req, res) {
  let url;
  try { url = new URL(req.url, SELF_ORIGIN); } catch { return send(req, res, 400, 'bad url'); }
  const id = await identity.identify(req.socket.remoteAddress);
  if (!id.ok) {
    log(`denied ${req.method} ${url.pathname} from ${req.socket.remoteAddress} (${id.reason})`);
    return send(req, res, 403, { error: 'This Tailscale identity is not allowed.' });
  }
  req.login = id.login;
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders(req)); return res.end(); }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (req.headers['x-intelio-workspace'] !== '1') return send(req, res, 403, { error: 'Missing X-Intelio-Workspace header.' });
    if (origin && origin !== 'null' && origin !== SELF_ORIGIN) return send(req, res, 403, { error: 'Cross-origin request refused.' });
  }
  try { await route(req, res, url); }
  catch (err) {
    const status = err.status || 400;
    if (!res.headersSent) send(req, res, status, { error: String(err.message || err).slice(0, 1000) });
    log(`error ${req.method} ${url.pathname}: ${err.message}`);
  }
}

// ------------------------------------------------------------ terminal websocket
let pty = null;
try { pty = require('node-pty'); } catch { pty = null; }
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

wss.on('connection', async (sock, req, t, win) => {
  if (!pty) { sock.close(1011, 'node-pty unavailable'); return; }
  try { await ws.ensureSession(t); } catch (err) { sock.close(1011, 'session unavailable'); return; }
  const view = `view-${crypto.randomBytes(3).toString('hex')}`;
  const cols = Math.min(400, Math.max(20, Number(new URL(req.url, SELF_ORIGIN).searchParams.get('cols')) || 120));
  const rows = Math.min(200, Math.max(5, Number(new URL(req.url, SELF_ORIGIN).searchParams.get('rows')) || 30));
  // A grouped session per viewer: shares the task's windows but keeps its own current window.
  const args = ['-L', ws.TMUX_SOCK, '-f', ws.TMUX_CONF, 'new-session', '-t', `ws-${t.id}`, '-s', view, ';', 'set-option', 'destroy-unattached', 'on', ';', 'select-window', '-t', `${view}:${win}`];
  const term = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: t.worktree, env: { ...process.env, PATH: ws.ENGINE_PATH, TERM: 'xterm-256color', INTELIO_WORKSPACE_TASK: t.id } });
  log(`terminal open task=${t.id} window=${win} by=${req.login}`);
  term.onData((d) => { if (sock.readyState === 1) sock.send(d); });
  term.onExit(() => { try { sock.close(1000, 'exited'); } catch { /* closed */ } });
  sock.on('message', (msg) => {
    const s = msg.toString('utf8');
    if (s.startsWith('\u0000{')) {
      try { const j = JSON.parse(s.slice(1)); if (j.resize) term.resize(Math.min(400, Math.max(20, j.resize.cols | 0)), Math.min(200, Math.max(5, j.resize.rows | 0))); } catch { /* ignore */ }
      return;
    }
    term.write(s);
  });
  sock.on('close', () => { try { term.kill(); } catch { /* gone */ } });
});

async function onUpgrade(req, socket, head) {
  try {
    const id = await identity.identify(req.socket.remoteAddress);
    const origin = req.headers.origin;
    const url = new URL(req.url, SELF_ORIGIN);
    const m = url.pathname.match(/^\/ws\/terminal\/([0-9a-f]{8})$/);
    const win = url.searchParams.get('window') || 'shell';
    if (!id.ok || (origin && origin !== 'null' && origin !== SELF_ORIGIN) || !m || !/^[A-Za-z0-9_.-]{1,40}$/.test(win)) {
      log(`denied upgrade ${url.pathname} from ${req.socket.remoteAddress} (${id.reason || 'bad origin/path'})`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const t = ws.getTask(m[1]);
    if (!t || t.setup !== 'ready') { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    req.login = id.login;
    wss.handleUpgrade(req, socket, head, (sock) => wss.emit('connection', sock, req, t, win));
  } catch { socket.destroy(); }
}

// ------------------------------------------------------------ start
const server = https.createServer({ cert: tlsCert, key: tlsKey, requestTimeout: 120000, headersTimeout: 30000 }, handler);
server.on('upgrade', onUpgrade);
server.on('tlsClientError', () => {});
server.listen(PORT, BIND, () => {
  log(`intelio-workspace listening on https://${HOST}:${PORT} (bind ${BIND}) allow=${ALLOWED.join(',')} pty=${pty ? 'yes' : 'no'}`);
  ws.reconcile().catch((e) => log('reconcile', e.message));
});

// Tailscale certs renew in place; reload them every 12h.
setInterval(() => {
  try { tlsCert = fs.readFileSync(CERT); tlsKey = fs.readFileSync(KEY); server.setSecureContext({ cert: tlsCert, key: tlsKey }); } catch (e) { log('cert reload failed', e.message); }
}, 12 * 3600 * 1000).unref();

process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', e && (e.stack || e.message)));
