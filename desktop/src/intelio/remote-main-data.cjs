'use strict';
/**
 * Data layer for the main Intelio window when Remote Hermes is on.
 * Agents, sessions, history, and streaming use the same multiplexed routes
 * as the phone PWA: /api/home (or /api/profiles) and /p/<profile>/api/sessions.
 * Each profile is called with that profile's own API key.
 */
const { signatureOf } = require('./orb-signature.cjs');
const { createRemoteHermesClient, normalizeRemoteConfig, PROFILE_RE } = require('./remote-hermes.cjs');

const NAMED_AGENTS = [
  { id: 'intelio', name: 'Intelio' },
  { id: 'prc', name: 'PRC' },
  { id: 'alignment', name: 'Alignment' },
  { id: 'hhp', name: 'HHP' },
];

function sourceLabel(source) {
  const value = String(source || '').trim().toLowerCase();
  if (value === 'photon' || value === 'imessage' || value === 'photon/imessage') return 'photon/iMessage';
  if (value === 'telegram') return 'Telegram';
  if (value === 'api' || value === 'api_server') return 'API';
  if (value === 'oneshot' || value === 'one-shot' || value === 'one_shot') return 'One-shot';
  if (value === 'cli') return 'CLI';
  if (value === 'cron') return 'Cron';
  return source ? String(source) : 'session';
}

function titleCase(name) {
  const raw = String(name || 'agent');
  return raw.slice(0, 1).toUpperCase() + raw.slice(1);
}

function sessionTime(session) {
  const raw = session?.updated_at || session?.updatedAt || session?.created_at || session?.createdAt || session?.started_at || session?.startedAt || '';
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : 0;
}

function timeLabel(at) {
  if (!at) return '';
  return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function decorateSession(session, profileId) {
  const at = sessionTime(session);
  return {
    ...session,
    profileId: session.profileId || profileId,
    sourceLabel: sourceLabel(session.source),
    preview: String(session.preview || session.last_message || '').slice(0, 180),
    at,
    timeLabel: timeLabel(at),
  };
}

function byNewest(rows) {
  return rows.slice().sort((a, b) => sessionTime(b) - sessionTime(a) || String(a.id || '').localeCompare(String(b.id || '')));
}

function decorate(agent) {
  const id = String(agent.id || '').trim().toLowerCase();
  return { id, name: agent.name || titleCase(id), orb: signatureOf(id), color: agent.color || '' };
}

function parseProfiles(json) {
  const list = Array.isArray(json) ? json : (Array.isArray(json?.profiles) ? json.profiles : (Array.isArray(json?.data) ? json.data : null));
  if (!list) return null;
  const agents = [];
  for (const item of list) {
    const id = String(typeof item === 'string' ? item : (item?.id || item?.name || '')).trim().toLowerCase();
    if (!id || !PROFILE_RE.test(id)) continue;
    const name = typeof item === 'string' ? titleCase(id) : (item.name || titleCase(id));
    agents.push(decorate({ id, name, color: item?.color }));
  }
  return agents.length ? agents : null;
}

function agentsFromKeys(names, profile = 'intelio') {
  const stored = [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
  const named = NAMED_AGENTS.filter((agent) => stored.includes(agent.id)).map(decorate);
  if (named.length) return named;
  const fallback = String(profile || 'intelio').trim().toLowerCase() || 'intelio';
  const row = NAMED_AGENTS.find((agent) => agent.id === fallback) || { id: fallback, name: titleCase(fallback) };
  return [decorate(row)];
}

function createRemoteMain({ getConfig, getKey, keyNames = () => [], fetchImpl = globalThis.fetch, probeTimeoutMs = 3000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const client = createRemoteHermesClient({ getConfig, getKey, fetchImpl });

  function storedNames() {
    const names = typeof keyNames === 'function' ? keyNames() : keyNames;
    return [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
  }

  async function probe(url, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response?.ok) return null;
      let json;
      try { json = await response.json(); } catch { return null; }
      const agents = parseProfiles(json);
      if (!agents) return null;
      return { agents, sample: Boolean(json?.sample), label: json?.sample ? (json.label || 'SAMPLE DATA') : '' };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listAgents() {
    const config = normalizeRemoteConfig(getConfig());
    const stored = storedNames();
    const order = [];
    if (stored.includes('intelio')) order.push('intelio');
    for (const name of stored) if (!order.includes(name)) order.push(name);
    if (!order.length && config.profile) order.push(config.profile);

    if (config.host) {
      let key = '';
      for (const name of order) {
        key = await getKey(name);
        if (key) break;
      }
      if (key) {
        const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
        const root = `http://${host}:${config.port}`;
        for (const path of ['/api/home', '/api/profiles']) {
          const found = await probe(`${root}${path}`, key);
          if (found) return found;
        }
      }
    }

    return { agents: agentsFromKeys(stored, config.profile || 'intelio'), sample: false, label: '' };
  }

  async function listSessions(profile, { source, limit = 100, offset = 0 } = {}) {
    const result = await client.listSessions({ source, limit, offset, ...(profile ? { profile } : {}) });
    const rows = Array.isArray(result?.data) ? result.data : [];
    const profileId = profile || normalizeRemoteConfig(getConfig()).profile || 'default';
    return rows.map((session) => decorateSession(session, profileId));
  }

  async function listAllSessions(profiles) {
    const stored = storedNames();
    const requested = Array.isArray(profiles) && profiles.length ? profiles : stored;
    const ids = [...new Set(requested.map((name) => String(name || '').trim().toLowerCase()).filter((name) => name && name !== 'vnc'))];
    const named = NAMED_AGENTS.map((agent) => agent.id).filter((id) => ids.includes(id));
    const targets = named.length ? named : ids;
    const groups = await Promise.all(targets.map(async (profile) => {
      try { return await listSessions(profile, { limit: 100 }); } catch { return []; }
    }));
    return byNewest(groups.flat());
  }

  return {
    listAgents,
    listSessions,
    listAllSessions,
    messages: (id, profile) => client.messages(id, { profile }),
    createSession: (title, profile) => client.createSession(title, { profile }),
    chat: (id, input, options = {}) => client.chat(id, input, options),
    client,
  };
}

module.exports = { NAMED_AGENTS, sourceLabel, agentsFromKeys, sessionTime, byNewest, createRemoteMain };
