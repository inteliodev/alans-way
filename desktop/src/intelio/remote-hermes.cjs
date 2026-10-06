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
 * Hosts are restricted to the tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48,
 * *.ts.net) or loopback (for an `ssh -L` tunnel). Public hosts are refused, so
 * a typo can never send the key or agent traffic over the internet.
 */

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

function baseUrl(config) {
  const cfg = normalizeRemoteConfig(config);
  if (!cfg.host) throw new Error('Set the Remote Hermes host first.');
  const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
  return `http://${host}:${cfg.port}${cfg.profile ? `/p/${cfg.profile}` : ''}`;
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

function createRemoteHermesClient({ getConfig, getKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  async function request(method, path, { body, query, stream = false, signal } = {}) {
    const config = normalizeRemoteConfig(getConfig());
    const key = await getKey(config.profile || 'default');
    if (!key) throw new Error(`No API key saved for Hermes profile "${config.profile || 'default'}".`);
    const url = new URL(baseUrl(config) + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = stream ? null : setTimeout(() => controller.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: stream ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      throw new Error(`Remote Hermes unreachable at ${url.host}: ${redactKey(error?.cause?.code || error?.message, key)}`);
    }
    if (timer && !stream) clearTimeout(timer);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const hint = response.status === 401 ? ' (wrong key for this profile — each profile has its own API_SERVER_KEY)' : '';
      throw Object.assign(new Error(`Remote Hermes ${method} ${path} → HTTP ${response.status}${hint}: ${redactKey(text, key)}`), { status: response.status });
    }
    if (stream) return response;
    const text = await response.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  return {
    health: async () => {
      const config = normalizeRemoteConfig(getConfig());
      const host = config.host.includes(':') ? `[${config.host}]` : config.host;
      const response = await fetchImpl(`http://${host}:${config.port}/health`, { redirect: 'error' });
      return { ok: response.ok, status: response.status };
    },
    capabilities: () => request('GET', '/v1/capabilities'),
    skills: () => request('GET', '/v1/skills'),
    listSessions: ({ source, limit = 50, offset = 0 } = {}) => request('GET', '/api/sessions', { query: { source, limit, offset } }),
    getSession: (id) => request('GET', `/api/sessions/${encodeURIComponent(id)}`),
    messages: (id) => request('GET', `/api/sessions/${encodeURIComponent(id)}/messages`, { query: { inline_images: 'false' } }),
    createSession: (title) => request('POST', '/api/sessions', { body: title ? { title: String(title).slice(0, 200) } : {} }),
    /** Run one turn in an existing session; calls onEvent for each SSE event. Resolves with the final assistant text. */
    async chat(id, input, { onEvent = () => {}, signal } = {}) {
      const response = await request('POST', `/api/sessions/${encodeURIComponent(id)}/chat/stream`, { body: { input: String(input) }, stream: true, signal });
      let finalText = '';
      let failed = null;
      const feed = createSseParser((evt) => {
        if (evt.event === 'assistant.completed' && typeof evt.data?.content === 'string') finalText = evt.data.content;
        if (evt.event === 'run.failed') failed = evt.data;
        onEvent(evt);
      });
      const decoder = new TextDecoder();
      for await (const chunk of response.body) feed(decoder.decode(chunk, { stream: true }));
      feed(decoder.decode());
      if (failed) throw new Error(`Hermes run failed: ${String(failed.error || failed.message || 'unknown error').slice(0, 300)}`);
      return finalText;
    },
  };
}

module.exports = { DEFAULT_PORT, isTailnetOrLoopbackHost, normalizeRemoteConfig, baseUrl, redactKey, createSseParser, createRemoteHermesClient };
