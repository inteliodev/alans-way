'use strict';
/**
 * Data layer for the main Intelio window when Remote Hermes is on.
 * Agents, sessions, history, and streaming use the same multiplexed routes
 * as the phone PWA: /api/home (or /api/profiles) and /p/<profile>/api/sessions.
 * Each profile is called with that profile's own API key.
 */
const { signatureOf } = require('../../../mobile/pwa/orbs.cjs');
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

function createRemoteMain({ getConfig, getKey, keyNames = () => [], fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const client = createRemoteHermesClient({ getConfig, getKey, fetchImpl });

  function storedNames() {
    const names = typeof keyNames === 'function' ? keyNames() : keyNames;
    return [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
  }

  async function listAgents() {
    const config = normalizeRemoteConfig(getConfig());
    const stored = storedNames();
    const order = [];
    if (stored.includes('intelio')) order.push('intelio');
    for (const name of stored) if (!order.includes(name)) order.push(name);
    if (!order.length && config.profile) order.push(config.profile);

    if (config.host) {
      const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
      const root = `http://${host}:${config.port}`;
      for (const name of order) {
        const key = await getKey(name);
        if (!key) continue;
        for (const path of ['/api/home', '/api/profiles']) {
          let response;
          try {
            response = await fetchImpl(`${root}${path}`, {
              headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
              redirect: 'error',
            });
          } catch { continue; }
          if (!response?.ok) continue;
          let json;
          try { json = await response.json(); } catch { continue; }
          const agents = parseProfiles(json);
          if (!agents) continue;
          return { agents, sample: Boolean(json?.sample), label: json?.sample ? (json.label || 'SAMPLE DATA') : '' };
        }
      }
    }

    const named = NAMED_AGENTS.filter((agent) => stored.includes(agent.id)).map(decorate);
    if (named.length) return { agents: named, sample: false, label: '' };
    const fallback = config.profile || 'intelio';
    const row = NAMED_AGENTS.find((agent) => agent.id === fallback) || { id: fallback, name: titleCase(fallback) };
    return { agents: [decorate(row)], sample: false, label: '' };
  }

  async function listSessions(profile, { source, limit = 100, offset = 0 } = {}) {
    const result = await client.listSessions({ source, limit, offset, ...(profile ? { profile } : {}) });
    const rows = Array.isArray(result?.data) ? result.data : [];
    const profileId = profile || normalizeRemoteConfig(getConfig()).profile || 'default';
    return rows.map((session) => ({ ...session, profileId, sourceLabel: sourceLabel(session.source) }));
  }

  return {
    listAgents,
    listSessions,
    messages: (id, profile) => client.messages(id, { profile }),
    createSession: (title, profile) => client.createSession(title, { profile }),
    chat: (id, input, options = {}) => client.chat(id, input, options),
    client,
  };
}

module.exports = { NAMED_AGENTS, sourceLabel, createRemoteMain };
