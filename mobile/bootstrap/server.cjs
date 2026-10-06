'use strict';
/**
 * Loopback key bootstrap for a machine that has signed in through Cloudflare
 * Access and does not have the profile keys yet. Bind is 127.0.0.1 only.
 * Values are read and returned. They are never logged.
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { CERTS_URL, verifyAccessJwt } = require('./jwt.cjs');

const PROFILES = ['intelio', 'prc', 'alignment', 'hhp'];
const HOST = '127.0.0.1';
const PORT = 8660;

function readAssignment(file, key) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    if (body.slice(0, eq).trim() !== key) continue;
    return body.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function readVnc(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

function fetchCerts(url = CERTS_URL) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('certs timeout')); });
  });
}

function createBootstrapServer({ fetchCerts: loadCerts = fetchCerts, home, now = () => Date.now() } = {}) {
  let certs = null;
  let certsAt = 0;
  async function certsNow() {
    if (certs && now() - certsAt < 60 * 60 * 1000) return certs;
    certs = await loadCerts();
    certsAt = now();
    return certs;
  }
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}`);
      if (req.method !== 'GET' || url.pathname !== '/intelio/bootstrap') {
        res.statusCode = 404;
        res.setHeader('cache-control', 'no-store');
        res.end('denied');
        return;
      }
      const token = req.headers['cf-access-jwt-assertion'];
      if (!token || Array.isArray(token)) {
        res.statusCode = 401;
        res.setHeader('cache-control', 'no-store');
        res.end('denied');
        return;
      }
      try {
        verifyAccessJwt(String(token), await certsNow(), { now: now() });
      } catch {
        res.statusCode = 401;
        res.setHeader('cache-control', 'no-store');
        res.end('denied');
        return;
      }
      const root = home || process.env.INTELIO_BOOTSTRAP_HOME || os.homedir();
      const body = {};
      for (const name of PROFILES) {
        body[name] = readAssignment(path.join(root, '.hermes', 'profiles', name, '.env'), 'API_SERVER_KEY');
      }
      body.vnc = readVnc(path.join(root, '.config', 'intelio', 'vnc-password.txt'));
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    } catch {
      res.statusCode = 401;
      res.setHeader('cache-control', 'no-store');
      res.end('denied');
    }
  });
}

function listen(server, port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

if (require.main === module) {
  const host = process.env.INTELIO_BOOTSTRAP_HOST || HOST;
  if (host !== HOST) {
    process.stderr.write('bootstrap listens on 127.0.0.1 only\n');
    process.exit(1);
  }
  const port = Number(process.env.INTELIO_BOOTSTRAP_PORT || PORT);
  const server = createBootstrapServer();
  listen(server, port).then(() => {
    process.stdout.write(`intelio bootstrap listening on ${HOST}:${port}\n`);
  }).catch(() => {
    process.stderr.write('bootstrap failed to listen\n');
    process.exit(1);
  });
}

module.exports = { createBootstrapServer, readAssignment, PROFILES, HOST, PORT };
