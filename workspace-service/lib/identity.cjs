'use strict';
/**
 * Tailscale identity check, same approach as the intelio phone server
 * (alans-way-pwa/mobile/pwa/identity.cjs): `tailscale whois --json <ip>`,
 * falling back to the tailscaled local API, cached briefly. A caller is
 * allowed only when its Tailscale login is on the allowlist.
 */
const http = require('node:http');
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
  if (!login || login.length > 200 || /\s/.test(login)) return '';
  return login;
}

function loginFromWhois(data) {
  return cleanLogin(data?.UserProfile?.LoginName || data?.User?.LoginName || '');
}

function parseAllowlist(raw) {
  return String(raw || '').split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function run(bin, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { resolve({ code: 127, stdout: '' }); return; }
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', () => resolve({ code: 127, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8') }));
  });
}

function localApiWhois(ip, socketPath = '/var/run/tailscale/tailscaled.sock') {
  return new Promise((resolve) => {
    const req = http.request({
      socketPath, method: 'GET', timeout: 4000,
      path: `/localapi/v0/whois?addr=${encodeURIComponent(`${ip}:0`)}`,
      headers: { Accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(loginFromWhois(JSON.parse(Buffer.concat(chunks).toString('utf8')))); } catch { resolve(''); } });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function createIdentity({ allowlist, ttlMs = 30000, denyTtlMs = 5000 } = {}) {
  const allowed = (allowlist || []).map((s) => String(s).toLowerCase());
  const cache = new Map();
  async function lookup(address) {
    const hit = cache.get(address);
    if (hit && hit.exp > Date.now()) return hit.login;
    let login = '';
    const cli = await run('tailscale', ['whois', '--json', address]);
    if (cli.code === 0 && cli.stdout) { try { login = loginFromWhois(JSON.parse(cli.stdout)); } catch { login = ''; } }
    if (!login) login = await localApiWhois(address);
    cache.set(address, { login, exp: Date.now() + (login ? ttlMs : denyTtlMs) });
    if (cache.size > 500) cache.clear();
    return login;
  }
  let selfIps = { at: 0, ips: [] };
  async function ownIps() {
    if (selfIps.at > Date.now() - 300000 && selfIps.ips.length) return selfIps.ips;
    const r = await run('tailscale', ['status', '--json']);
    try { const j = JSON.parse(r.stdout); selfIps = { at: Date.now(), ips: (j.Self?.TailscaleIPs || []).map(normalizeIp) }; } catch { /* keep */ }
    return selfIps.ips;
  }
  async function identify(rawIp, { allowSelf = false } = {}) {
    const address = normalizeIp(rawIp);
    if (!address) return { ok: false, reason: 'missing address' };
    // Agents run on this VPS, whose tailnet node is also Hayden's: refuse the VPS itself so
    // an agent cannot drive the API (e.g. the Merge-to-main action) over the tailnet.
    if (!allowSelf && (address.startsWith('127.') || address === '::1' || (await ownIps()).includes(address))) return { ok: false, reason: 'requests from the VPS itself are refused' };
    if (!allowed.length) return { ok: false, reason: 'allowlist is empty' };
    let login = '';
    try { login = await lookup(address); } catch { login = ''; }
    if (!login) return { ok: false, reason: 'not a tailnet peer' };
    if (!allowed.includes(login.toLowerCase())) return { ok: false, reason: 'login not allowed', login };
    return { ok: true, login };
  }
  return { identify };
}

module.exports = { normalizeIp, parseAllowlist, createIdentity };
