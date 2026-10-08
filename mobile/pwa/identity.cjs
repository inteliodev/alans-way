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

function isLoopbackAddress(raw) {
  const address = normalizeIp(raw);
  return address === '::1' || address.startsWith('127.');
}

function selfFromStatus(data) {
  const self = data?.Self || {};
  const id = self.ID == null ? '' : String(self.ID);
  const ips = [];
  for (const value of [].concat(self.TailscaleIPs || [], self.Addrs || [])) {
    const address = normalizeIp(String(value).split('/')[0]);
    if (address && !ips.includes(address)) ips.push(address);
  }
  return { id, ips };
}

function whoisNodeId(data) {
  const id = data?.Node?.ID;
  return id == null ? '' : String(id);
}

function whoisAddresses(data) {
  const ips = [];
  for (const value of [].concat(data?.Node?.Addresses || [], data?.Node?.AllowedIPs || [])) {
    const address = normalizeIp(String(value).split('/')[0]);
    if (address && !ips.includes(address)) ips.push(address);
  }
  return ips;
}

function peerIsLocal({ address, whois = null, self = null, hostIps = [] } = {}) {
  const ip = normalizeIp(address);
  if (!ip || isLoopbackAddress(ip)) return true;
  const own = self || { id: '', ips: [] };
  const hosts = [...(hostIps || []), ...(own.ips || [])];
  if (hosts.includes(ip)) return true;
  const node = whoisNodeId(whois);
  if (node && own.id && node === own.id) return true;
  const nodeIps = whois ? whoisAddresses(whois) : [];
  if (nodeIps.includes(ip) && nodeIps.some((item) => hosts.includes(item))) return true;
  return false;
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

  async function selfInfo() {
    const cached = cache.get('__self__');
    if (cached && cached.exp > now()) return cached.value;
    let value = { id: '', ips: [] };
    const status = await run(['status', '--json']);
    if (status && status.code === 0 && status.stdout) {
      try { value = selfFromStatus(JSON.parse(status.stdout)); } catch { value = { id: '', ips: [] }; }
    }
    cache.set('__self__', { value, exp: now() + ttlMs });
    return value;
  }

  async function describe(ip) {
    const address = normalizeIp(ip);
    const cached = cache.get(address);
    if (cached && cached.exp > now()) return cached.value;
    const self = await selfInfo();
    let whois = null;
    let login = '';
    const cli = await run(['whois', '--json', address]);
    if (cli && cli.code === 0 && cli.stdout) {
      try {
        whois = JSON.parse(cli.stdout);
        login = loginFromWhois(whois);
      } catch {
        whois = null;
        login = '';
      }
    }
    if (!login) login = await localWhois(address);
    const value = { login: login || '', whois, self };
    cache.set(address, { value, exp: now() + (login ? ttlMs : denyTtlMs) });
    return value;
  }

  async function lookup(ip) {
    const described = await describe(ip);
    return described.login || '';
  }

  async function identify(ip, allowlist) {
    const address = normalizeIp(ip);
    if (!address) return { ok: false, reason: 'missing address' };
    const allowed = (allowlist || []).map((item) => String(item).toLowerCase());
    if (!allowed.length) return { ok: false, reason: 'allowlist is empty' };
    let described = { login: '', whois: null, self: { id: '', ips: [] } };
    try { described = await describe(address); } catch { described = { login: '', whois: null, self: { id: '', ips: [] } }; }
    const login = described.login || '';
    const self = peerIsLocal({ address, whois: described.whois, self: described.self, hostIps: described.self?.ips });
    if (!login) return { ok: false, reason: 'not a tailnet peer', self };
    if (!allowed.includes(login.toLowerCase())) return { ok: false, reason: 'login not allowed', login, self };
    return { ok: true, login, self };
  }

  return { identify, lookup, describe };
}

module.exports = {
  normalizeIp,
  isLoopbackAddress,
  selfFromStatus,
  peerIsLocal,
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
