'use strict';
/**
 * Remote Hermes (VPS) client.
 *
 * "One Hermes": the VPS runs the single Hermes brain (multiplexed gateway,
 * Telegram + API server). This app is a client of it over Tailscale, using the
 * Hermes API server shipped at commit 5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662
 * (gateway/platforms/api_server.py):
 *
 *   GET  /p/<profile>/api/sessions                 list sessions (Telegram, API, CLI, cron ...)
 *   GET  /p/<profile>/api/sessions/<id>/messages   transcript
 *   POST /p/<profile>/api/sessions                 new empty session
 *   POST /p/<profile>/api/sessions/<id>/chat/stream  one agent turn, SSE
 *   GET  /p/<profile>/v1/capabilities, /v1/skills, /health
 *
 * Auth is the profile's own API_SERVER_KEY (bearer). The key lives in the main
 * process only (encrypted with Electron safeStorage); it never reaches a
 * renderer and is redacted from every error.
 *
 * Hosts are restricted to the tailnet (Tailscale CGNAT, fd7a:115c:a1e0::/48,
 * *.ts.net) or loopback (for an `ssh -L` tunnel). Public hosts are refused, so
 * a typo can never send the key or agent traffic over the internet.
 */

const VPS_HOST = 'intelio-vps.tail9c1007.ts.net';
/** Tailnet-only noVNC already running on the VPS. Not a public address. */
const VNC_URL = `http://${VPS_HOST}:6080/vnc.html`;

const DEFAULT_PORT = 8642;
const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isTailnetOrLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    if (a === 127) return true;
    return a === 100 && b >= 64 && b <= 127; // CGNAT range Tailscale assigns
  }
  if (h.includes(':')) return /^fd7a:115c:a1e0:/.test(h); // Tailscale ULA
  return /^([a-z0-9-]+\.)+ts\.net$/.test(h); // MagicDNS FQDN only; bare short names could resolve off-tailnet
}

function normalizeRemoteConfig(input = {}) {
  const host = String(input.host || '').trim();
  const port = input.port === undefined || input.port === '' || input.port === null ? DEFAULT_PORT : Number(input.port);
  const profileRaw = String(input.profile ?? '').trim().toLowerCase();
  const profile = profileRaw === 'default' ? '' : profileRaw;
  const enabled = input.enabled === true;
  if (host && !isTailnetOrLoopbackHost(host)) {
    throw new Error('Remote Hermes host must be a Tailscale address (100.x, fd7a:115c:a1e0::, *.ts.net) or loopback for an SSH tunnel.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Remote Hermes port must be 1-65535.');
  if (profile && !PROFILE_RE.test(profile)) throw new Error('Hermes profile names are lowercase letters, digits, "-" and "_".');
  return { enabled, host, port, profile };
}

/** Windows and macOS first launch have no preferences file and start as a VPS client. Linux stays opt-in. */
function remoteHermesDefaults(platform = process.platform) {
  const connection = 'auto';
  if (platform === 'win32' || platform === 'darwin') return { enabled: true, host: VPS_HOST, port: DEFAULT_PORT, profile: 'intelio', connection };
  return { enabled: false, host: '', port: DEFAULT_PORT, profile: 'intelio', connection };
}

function baseUrl(config) {
  const cfg = normalizeRemoteConfig(config);
  if (!cfg.host) throw new Error('Set the Remote Hermes host first.');
  return profileBase(cfg, cfg.profile || 'default');
}

/** `default` is the unprefixed gateway. Any other name is `/p/<profile>`. */
function resolveProfile(config, override) {
  if (override === undefined || override === null) return config.profile || 'default';
  const raw = String(override).trim().toLowerCase();
  if (!raw || raw === 'default') return 'default';
  if (!PROFILE_RE.test(raw)) throw new Error('Hermes profile names are lowercase letters, digits, "-" and "_".');
  return raw;
}

function profileBase(config, profileName) {
  const prefix = profileName && profileName !== 'default' ? `/p/${profileName}` : '';
  const origin = String(config.origin || '').replace(/\/$/, '');
  if (origin) return `${origin}${prefix}`;
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}${prefix}`;
}

function selectFetch(config, { fetchImpl, sessionFor } = {}) {
  if (config && config.partition && typeof sessionFor === 'function') {
    const ses = sessionFor(config.partition);
    // net.fetch always uses the default session. The partition cookie is only
    // sent by session.fetch.
    if (ses && typeof ses.fetch === 'function') return (url, init = {}) => ses.fetch(url, init);
  }
  return fetchImpl;
}

async function readConfig(getConfig) {
  const raw = await Promise.resolve(typeof getConfig === 'function' ? getConfig() : {});
  const normalized = normalizeRemoteConfig(raw || {});
  return {
    ...normalized,
    origin: String(raw?.origin || '').replace(/\/$/, ''),
    partition: String(raw?.partition || ''),
    activeMode: raw?.activeMode || '',
  };
}

function cloudMode(config) {
  return Boolean(config.origin || config.partition || config.activeMode === 'cloud');
}

/** Status line for remote mode: `hermes-agent 0.21.5`, plus a short pin when the remote sends one. */
function remoteVersionLabel(body) {
  if (!body || typeof body !== 'object') return '';
  const platform = String(body.platform || '').trim();
  const version = String(body.version || '').trim();
  const pin = String(body.commit || body.hermes_commit || body.pin || '').trim();
  const shortPin = /^[0-9a-f]{7,64}$/i.test(pin) ? pin.slice(0, 12) : '';
  let label = '';
  if (platform && version && !version.toLowerCase().startsWith(platform.toLowerCase())) label = `${platform} ${version}`;
  else if (version) label = version;
  else if (platform) label = platform;
  if (shortPin) label = label ? `${label} · pin ${shortPin}` : `pin ${shortPin}`;
  return label.slice(0, 160);
}

function redactKey(text, key) {
  let out = String(text ?? '');
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]').slice(0, 500);
}

/** Incremental SSE parser: feed text chunks, get {event, data} objects. */
function createSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue; // keepalive comments
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) continue;
      let parsed = data.join('\n');
      try { parsed = JSON.parse(parsed); } catch {}
      onEvent({ event, data: parsed });
    }
  };
}

function createRemoteHermesClient({ getConfig, getKey, fetchImpl = globalThis.fetch, timeoutMs = 15000, sessionFor, net } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  function throwIfAccess(response, text) {
    const { isAccessResponse, accessError } = require('./cloud-connection.cjs');
    if (isAccessResponse(response, text)) throw accessError();
  }

  async function request(method, path, { body, query, stream = false, signal, profile } = {}) {
    const config = await readConfig(getConfig);
    const profileName = resolveProfile(config, profile);
    const key = await getKey(profileName);
    if (!key) throw new Error(`No API key saved for Hermes profile "${profileName}".`);
    const url = new URL(profileBase(config, profileName) + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = stream ? null : setTimeout(() => controller.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const cloud = cloudMode(config);
    const doFetch = selectFetch(config, { fetchImpl, sessionFor, net });
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: stream ? 'text/event-stream' : 'application/json', 'x-intelio-profile': profileName, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: cloud ? 'manual' : 'error',
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (error?.code === 'CLOUD_ACCESS') throw error;
      throw new Error(`Remote Hermes unreachable at ${url.host}: ${redactKey(error?.cause?.code || error?.message, key)}`);
    }
    if (timer && !stream) clearTimeout(timer);
    if (cloud && throwIfAccess(response)) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (cloud) throwIfAccess(response, text);
      const hint = response.status === 401 ? ' (wrong key for this profile — each profile has its own API_SERVER_KEY)' : '';
      throw Object.assign(new Error(`Remote Hermes ${method} ${path} → HTTP ${response.status}${hint}: ${redactKey(text, key)}`), { status: response.status });
    }
    if (stream) return response;
    const text = await response.text();
    if (cloud) throwIfAccess(response, text);
    try { return JSON.parse(text); } catch { return text; }
  }

  return {
    health: async () => {
      const config = await readConfig(getConfig);
      const host = config.host.includes(':') ? `[${config.host}]` : config.host;
      const endpoint = config.origin ? `${config.origin}/health` : `http://${host}:${config.port}/health`;
      const cloud = cloudMode(config);
      const doFetch = selectFetch(config, { fetchImpl, sessionFor, net });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let response;
      try {
        response = await doFetch(endpoint, { redirect: cloud ? 'manual' : 'error', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (cloud) throwIfAccess(response);
      const text = await response.text();
      if (cloud) throwIfAccess(response, text);
      let body = {};
      try { body = JSON.parse(text); } catch { body = {}; }
      if (!remoteVersionLabel(body) && /^hermes-agent\s+\S+/.test(String(text).trim())) {
        const [platform, version] = String(text).trim().split(/\s+/);
        body = { platform, version };
      }
      const label = remoteVersionLabel(body);
      return {
        ok: response.ok,
        status: response.status,
        platform: typeof body.platform === 'string' ? body.platform : '',
        version: typeof body.version === 'string' ? body.version : '',
        label,
      };
    },
    capabilities: () => request('GET', '/v1/capabilities'),
    skills: () => request('GET', '/v1/skills'),
    listSessions: ({ source, limit = 50, offset = 0, profile } = {}) => request('GET', '/api/sessions', { query: { source, limit, offset }, profile }),
    getSession: (id, { profile } = {}) => request('GET', `/api/sessions/${encodeURIComponent(id)}`, { profile }),
    messages: (id, { profile } = {}) => request('GET', `/api/sessions/${encodeURIComponent(id)}/messages`, { query: { inline_images: 'false' }, profile }),
    createSession: (title, { profile } = {}) => request('POST', '/api/sessions', { body: title ? { title: String(title).slice(0, 200) } : {}, profile }),
    updateSession: (id, fields, { profile } = {}) => request('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { body: fields, profile }),
    deleteSession: (id, { profile } = {}) => request('DELETE', `/api/sessions/${encodeURIComponent(id)}`, { profile }),
    optional(method, path, options) {
      return request(method, path, options).catch(() => null);
    },
    /** Run one turn in an existing session; calls onEvent for each SSE event. Resolves with the final assistant text. */
    async chat(id, input, { onEvent = () => {}, signal, profile, model } = {}) {
      const body = { input: String(input) };
      if (model && model.model && model.provider) {
        body.model = model.model;
        body.provider = model.provider;
        if (model.model_options) body.model_options = model.model_options;
      }
      const response = await request('POST', `/api/sessions/${encodeURIComponent(id)}/chat/stream`, { body, stream: true, signal, profile });
      let finalText = '';
      let failed = null;
      const feed = createSseParser((evt) => {
        if (evt.event === 'assistant.completed' && typeof evt.data?.content === 'string') finalText = evt.data.content;
        if (evt.event === 'run.failed') failed = evt.data;
        onEvent(evt);
      });
      const decoder = new TextDecoder();
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) feed(decoder.decode(value, { stream: true }));
        }
      } else if (response.body) {
        for await (const chunk of response.body) feed(decoder.decode(chunk, { stream: true }));
      }
      feed(decoder.decode());
      if (failed) throw new Error(`Hermes run failed: ${String(failed.error || failed.message || 'unknown error').slice(0, 300)}`);
      return finalText;
    },
  };
}

module.exports = { DEFAULT_PORT, PROFILE_RE, VPS_HOST, VNC_URL, remoteHermesDefaults, remoteVersionLabel, isTailnetOrLoopbackHost, normalizeRemoteConfig, baseUrl, redactKey, createSseParser, createRemoteHermesClient, selectFetch, profileBase };
