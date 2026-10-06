'use strict';
/**
 * Tailscale identity for the phone client.
 * The profile API key never enters this module. Callers pass an address;
 * this returns a login name or a denial reason.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  return ip;
}

function cleanLogin(value) {
  const login = String(value || '').trim();
  if (!login || login.length > 200 || /[\s]/.test(login)) return '';
  return login;
}

function loginFromWhois(data) {
  return cleanLogin(data?.UserProfile?.LoginName || data?.User?.LoginName || '');
}

function loginFromStatus(data) {
  const id = data?.Self?.UserID;
  const users = data?.User || {};
  const user = users[id] || users[String(id)] || {};
  return cleanLogin(user.LoginName || '');
}

function parseAllowlist(raw) {
  return String(raw || '').split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function profileKeyPath({ profile = '', env = process.env, home = os.homedir() } = {}) {
  const primary = String(env.INTELIO_HERMES_PROFILE || 'intelio');
  if (env.INTELIO_PWA_KEY_FILE && (!profile || profile === primary)) return env.INTELIO_PWA_KEY_FILE;
  if (profile) return path.join(home, '.hermes', 'profiles', profile, '.env');
  return path.join(home, '.hermes', '.env');
}

function readProfileKey(file, fsImpl = fs) {
  const st = fsImpl.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('Profile key file must be a regular file.');
  if ((st.mode & 0o777) !== 0o600) throw new Error('Profile key file must be mode 600.');
  const text = fsImpl.readFileSync(file, 'utf8');
  let key = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    if (name !== 'API_SERVER_KEY') continue;
    key = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  if (key.length < 16) throw new Error('Profile key file has no usable key.');
  return key;
}

function runCommand(bin, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 127, stdout: '', stderr: '' });
      return;
    }
    const out = [];
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', () => resolve({ code: 127, stdout: '', stderr: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

function localApiWhois(ip, { socketPath = '/var/run/tailscale/tailscaled.sock', requestImpl = http.request } = {}) {
  return new Promise((resolve) => {
    let req;
    try {
      req = requestImpl({
        socketPath,
        path: `/localapi/v0/whois?addr=${encodeURIComponent(`${ip}:0`)}`,
        method: 'GET',
        timeout: 4000,
        headers: { Accept: 'application/json' },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try { resolve(loginFromWhois(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
          catch { resolve(''); }
        });
      });
    } catch {
      resolve('');
      return;
    }
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function createIdentity({
  run = (args) => runCommand('tailscale', args),
  localWhois = (ip) => localApiWhois(ip),
  now = () => Date.now(),
  ttlMs = 30000,
  denyTtlMs = 5000,
} = {}) {
  const cache = new Map();

  async function lookup(ip) {
    const cached = cache.get(ip);
    if (cached && cached.exp > now()) return cached.login;
    let login = '';
    const cli = await run(['whois', '--json', ip]);
    if (cli && cli.code === 0 && cli.stdout) {
      try { login = loginFromWhois(JSON.parse(cli.stdout)); } catch { login = ''; }
    }
    if (!login) login = await localWhois(ip);
    cache.set(ip, { login: login || '', exp: now() + (login ? ttlMs : denyTtlMs) });
    return login || '';
  }

  async function identify(ip, allowlist) {
    const address = normalizeIp(ip);
    if (!address) return { ok: false, reason: 'missing address' };
    const allowed = (allowlist || []).map((item) => String(item).toLowerCase());
    if (!allowed.length) return { ok: false, reason: 'allowlist is empty' };
    let login = '';
    try { login = await lookup(address); } catch { login = ''; }
    if (!login) return { ok: false, reason: 'not a tailnet peer' };
    if (!allowed.includes(login.toLowerCase())) return { ok: false, reason: 'login not allowed', login };
    return { ok: true, login };
  }

  return { identify, lookup };
}

module.exports = {
  normalizeIp,
  cleanLogin,
  loginFromWhois,
  loginFromStatus,
  parseAllowlist,
  profileKeyPath,
  readProfileKey,
  localApiWhois,
  createIdentity,
};

if (require.main === module && process.argv[2] === '--login-from-status') {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    try {
      const login = loginFromStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!login) process.exit(1);
      process.stdout.write(login);
    } catch {
      process.exit(1);
    }
  });
}
