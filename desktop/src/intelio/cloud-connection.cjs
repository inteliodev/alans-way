'use strict';
/**
 * Intelio Cloud vs Tailscale. Cloud is an allowlisted origin, not a host the
 * user can type. Public hosts stay refused by normalizeRemoteConfig.
 */
const { remoteVersionLabel } = require('./remote-hermes.cjs');

const CLOUD_PARTITION = 'persist:intelio-cloud';
const CLOUD_API = 'https://app.intelio-ai.com';
const CLOUD_DESKTOP = 'https://app.intelio-ai.com/browser/vnc.html?path=/browser/websockify';
const ACCESS_TEAM_HOST = 'muddy-scene-4e1c.cloudflareaccess.com';
const PROBE_TIMEOUT_MS = 4000;

function normalizeConnectionMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'auto' || mode === 'tailscale' || mode === 'cloud') return mode;
  return 'auto';
}

function loopbackHttp(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/** Production hostnames, unless the packaged e2e points Cloud at loopback. */
function cloudTargets(env = process.env) {
  if (env && env.INTELIO_E2E === '1') {
    const api = String(env.INTELIO_CLOUD_API || '').trim();
    const desktop = String(env.INTELIO_CLOUD_DESKTOP || '').trim();
    if (loopbackHttp(api) && loopbackHttp(desktop)) {
      return { origin: new URL(api).origin, desktop };
    }
  }
  return { origin: CLOUD_API, desktop: CLOUD_DESKTOP };
}

function tailscaleChoice(host, port) {
  const raw = String(host || '').trim();
  const bracket = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
  const origin = raw ? `http://${bracket}:${port}` : '';
  return { mode: 'tailscale', origin, desktop: '', partition: '', at: Date.now() };
}

function cloudChoice(env) {
  const targets = cloudTargets(env);
  return { mode: 'cloud', origin: targets.origin, desktop: targets.desktop, partition: CLOUD_PARTITION, at: Date.now() };
}

function versionFromHealth(text) {
  let body = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  if (!remoteVersionLabel(body) && /^hermes-agent\s+\S+/.test(String(text || '').trim())) {
    const [platform, version] = String(text).trim().split(/\s+/);
    body = { platform, version };
  }
  return remoteVersionLabel(body);
}

async function probeTailscale(origin, fetchImpl, timeoutMs) {
  if (!origin || typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/health`, { redirect: 'error', signal: controller.signal });
    if (!response || response.status !== 200) return false;
    const text = await response.text();
    return Boolean(versionFromHealth(text));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Auto probes Tailscale /health for a few seconds. Reachable means HTTP 200
 * and a Hermes version. Anything else uses intelio cloud. Explicit Tailscale
 * does not fall back. Explicit Cloud does not probe.
 */
async function chooseConnection({ mode = 'auto', host = '', port = 8642, fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const selected = normalizeConnectionMode(mode);
  if (selected === 'cloud') return cloudChoice(env);
  const tail = tailscaleChoice(host, port);
  if (selected === 'tailscale') return tail;
  if (!tail.origin) return cloudChoice(env);
  const reachable = await probeTailscale(tail.origin, fetchImpl, timeoutMs);
  return reachable ? tail : cloudChoice(env);
}

function labelWithMode(label, mode) {
  const base = String(label || '').replace(/\s·\s(?:Cloud|Tailscale)$/, '').trim();
  if (!base) return '';
  if (mode === 'cloud') return `${base} · Cloud`;
  if (mode === 'tailscale') return `${base} · Tailscale`;
  return base;
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const raw = headers[name] ?? headers[String(name || '').toLowerCase()];
  return raw == null ? '' : String(raw);
}

/** Real Cloudflare Access login, including the packaged fake at /access/login. */
function isAccessLocation(location) {
  const value = String(location || '').trim();
  if (!value) return false;
  if (/cloudflareaccess\.com/i.test(value)) return true;
  if (/\/cdn-cgi\/access(?:\/|$|\?|#)/i.test(value)) return true;
  if (/(?:^|\/)access\/login(?:[/?#]|$)/i.test(value)) return true;
  return false;
}

/**
 * Sign-in is a Cloudflare Access challenge: a redirect to the Access host
 * or /cdn-cgi/access, an opaque redirect, or an HTML page. JSON 401/403 is
 * a profile error and must not reopen the sign-in window.
 */
function isAccessResponse(response, text) {
  if (!response) return false;
  if (response.type === 'opaqueredirect') return true;
  const status = Number(response.status || 0);
  const location = headerValue(response, 'location');
  const headerType = headerValue(response, 'content-type');
  if (/text\/html/i.test(headerType) || (typeof text === 'string' && /^\s*</.test(text))) return true;
  const redirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  if (redirect) return !location || isAccessLocation(location);
  return false;
}

function mergeAccessCookies(existing, cookies) {
  const parts = String(existing || '').split(';').map((part) => part.trim()).filter(Boolean);
  const seen = new Set(parts.map((part) => part.split('=')[0].trim()));
  for (const cookie of cookies || []) {
    const name = String(cookie?.name || '');
    if (name !== 'CF_Authorization' && name !== 'CF_AppSession') continue;
    if (cookie.value == null || cookie.value === '' || seen.has(name)) continue;
    parts.push(`${name}=${cookie.value}`);
    seen.add(name);
  }
  return parts.join('; ');
}

function accessError() {
  const error = new Error('Sign in to intelio');
  error.code = 'CLOUD_ACCESS';
  return error;
}

function allowedSignInUrl(raw, env = process.env) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'app.intelio-ai.com' || host === 'os.intelio-ai.com' || host === 'desktop.intelio-ai.com' || host === ACCESS_TEAM_HOST) return true;
  if (env && env.INTELIO_E2E === '1' && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
  return false;
}

module.exports = {
  CLOUD_PARTITION,
  CLOUD_API,
  CLOUD_DESKTOP,
  ACCESS_TEAM_HOST,
  PROBE_TIMEOUT_MS,
  normalizeConnectionMode,
  cloudTargets,
  chooseConnection,
  labelWithMode,
  isAccessResponse,
  mergeAccessCookies,
  accessError,
  allowedSignInUrl,
};
