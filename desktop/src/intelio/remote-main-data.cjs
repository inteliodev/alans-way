'use strict';
/**
 * Data layer for the main Intelio window when Remote Hermes is on.
 * Agents, sessions, history, and streaming use the same multiplexed routes
 * as the phone PWA: /api/home (or /api/profiles) and /p/<profile>/api/sessions.
 * Each profile is called with that profile's own API key.
 */
const { signatureOf, ORB_IDS } = require('./orb-signature.cjs');
const { createRemoteHermesClient, normalizeRemoteConfig, selectFetch, PROFILE_RE } = require('./remote-hermes.cjs');

const NAMED_AGENTS = [
  { id: 'intelio', name: 'intelio' },
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
    preview: String(session.last_message || session.preview || '').slice(0, 180),
    last_message: String(session.last_message || session.preview || '').slice(0, 180),
    at,
    timeLabel: timeLabel(at),
  };
}

function byNewest(rows) {
  return rows.slice().sort((a, b) => sessionTime(b) - sessionTime(a) || String(a.id || '').localeCompare(String(b.id || '')));
}

/** The server's display name wins unless it is missing or just the slug. */
function canonicalName(id, provided) {
  const raw = String(provided || '').trim();
  if (raw.toLowerCase() === 'intelio') return 'intelio';
  if (raw && raw.toLowerCase() !== String(id || '').toLowerCase()) return raw;
  const known = NAMED_AGENTS.find((agent) => agent.id === id);
  if (known) return known.name;
  return raw || titleCase(id);
}

const ORBS = new Set(ORB_IDS);

function excludedAgent(id) {
  const slug = String(id || '').trim().toLowerCase();
  const compact = slug.replace(/[\s_]+/g, '-');
  if (!slug || slug === 'default') return true;
  if (slug === 'kid-a' || slug === 'kida' || slug === 'kid a' || compact === 'kid-a' || compact.startsWith('kid-a-')) return true;
  if (slug.includes('alignment-bot-vps') || compact.includes('alignment-bot-vps')) return true;
  return false;
}

function decorate(agent) {
  const id = String(agent.id || '').trim().toLowerCase();
  const orb = ORBS.has(agent.orb) ? agent.orb : signatureOf(id);
  return {
    id,
    name: canonicalName(id, agent.name),
    orb,
    color: agent.color || '',
    needsSignIn: agent.needsSignIn === true,
    gatewayNote: String(agent.gatewayNote || '').slice(0, 160),
    title: String(agent.title || agent.role || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80),
    description: String(agent.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240),
  };
}

function parseProfiles(json) {
  const list = Array.isArray(json) ? json : (Array.isArray(json?.profiles) ? json.profiles : (Array.isArray(json?.data) ? json.data : null));
  if (!list) return null;
  const agents = [];
  for (const item of list) {
    const id = String(typeof item === 'string' ? item : (item?.id || item?.name || '')).trim().toLowerCase();
    if (!id || !PROFILE_RE.test(id) || excludedAgent(id)) continue;
    const name = typeof item === 'string' ? titleCase(id) : (item.name || titleCase(id));
    agents.push(decorate({ id, name, color: item?.color, orb: item?.orb, needsSignIn: item?.needsSignIn, gatewayNote: item?.gatewayNote, title: item?.title || item?.role, description: item?.description }));
  }
  return agents.length ? agents : null;
}

function agentsFromKeys(names, profile = 'intelio') {
  const stored = [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter((name) => name && !excludedAgent(name)))];
  const named = NAMED_AGENTS.filter((agent) => stored.includes(agent.id)).map(decorate);
  if (named.length) return named;
  const fallback = String(profile || 'intelio').trim().toLowerCase() || 'intelio';
  if (excludedAgent(fallback)) return [decorate(NAMED_AGENTS[0])];
  const row = NAMED_AGENTS.find((agent) => agent.id === fallback) || { id: fallback, name: titleCase(fallback) };
  return [decorate(row)];
}

const HARNESS_IDS = new Set(NAMED_AGENTS.map((agent) => agent.id));

/**
 * The Agents list is the VPS profile catalog.
 * Kid A and Alignment-Bot-VPS stay off it. The four named agents lead when present.
 */
function selectHarnessAgents(parsed, stored, profile = 'intelio') {
  const fromServer = (parsed || []).filter((agent) => agent?.id && !excludedAgent(agent.id));
  if (fromServer.length) {
    const byId = new Map(fromServer.map((agent) => [agent.id, agent]));
    const named = NAMED_AGENTS.filter((agent) => byId.has(agent.id)).map((agent) => byId.get(agent.id));
    const rest = fromServer.filter((agent) => !HARNESS_IDS.has(agent.id)).slice().sort((a, b) => a.id.localeCompare(b.id));
    return [...named, ...rest];
  }
  return agentsFromKeys(stored, profile);
}

function createRemoteMain({ getConfig, getKey, keyNames = () => [], fetchImpl = globalThis.fetch, probeTimeoutMs = 12000, sessionFor, net } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const client = createRemoteHermesClient({ getConfig, getKey, fetchImpl, sessionFor, net });

  function storedNames() {
    const names = typeof keyNames === 'function' ? keyNames() : keyNames;
    return [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
  }

  async function probe(url, key, raw, profile) {
    const cloud = Boolean(raw?.origin || raw?.partition || raw?.activeMode === 'cloud');
    const doFetch = selectFetch(raw, { fetchImpl, sessionFor, net });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await doFetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(profile ? { 'x-intelio-profile': profile } : {}) },
        redirect: cloud ? 'manual' : 'error',
        signal: controller.signal,
      });
      const { isAccessResponse, accessError } = require('./cloud-connection.cjs');
      if (cloud && isAccessResponse(response)) throw accessError();
      if (!response?.ok) return null;
      const text = await response.text();
      if (cloud && isAccessResponse(response, text)) throw accessError();
      let json;
      try { json = JSON.parse(text); } catch { return null; }
      const agents = parseProfiles(json);
      if (!agents) return null;
      return { agents, sample: Boolean(json?.sample), label: json?.sample ? (json.label || 'SAMPLE DATA') : '' };
    } catch (error) {
      if (error?.code === 'CLOUD_ACCESS') throw error;
      // A timeout means the server is slow, not that the route is missing: don't try the next one.
      if (controller.signal.aborted) return { timedOut: true };
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rawConfig() {
    return Promise.resolve(typeof getConfig === 'function' ? getConfig() : {});
  }

  // The last agent list the server returned, per connection. A refresh answers from it at once
  // and asks the server in the background, so a slow /api/home never holds up chat.
  let cachedAgents = null;
  let cachedFor = '';
  let pendingAgents = null;

  async function listAgents() {
    const raw = await rawConfig();
    const stamp = `${raw?.origin || ''}|${raw?.host || ''}|${raw?.port || ''}|${storedNames().join(',')}`;
    if (cachedAgents && cachedFor === stamp) {
      if (!pendingAgents) {
        pendingAgents = fetchAgents(raw)
          // An expired cloud sign-in must surface on the next refresh, not hide behind the cache.
          .catch((error) => { if (error?.code === 'CLOUD_ACCESS') cachedAgents = null; })
          .finally(() => { pendingAgents = null; });
      }
      return cachedAgents;
    }
    return fetchAgents(raw);
  }

  async function fetchAgents(raw) {
    const stamp = `${raw?.origin || ''}|${raw?.host || ''}|${raw?.port || ''}|${storedNames().join(',')}`;
    const config = normalizeRemoteConfig(raw || {});
    const stored = storedNames();
    const order = [];
    if (stored.includes('intelio')) order.push('intelio');
    for (const name of stored) if (!order.includes(name)) order.push(name);
    if (!order.length && config.profile) order.push(config.profile);

    const origin = String(raw?.origin || '').replace(/\/$/, '');
    if (origin || config.host) {
      let key = '';
      let keyName = '';
      for (const name of order) {
        key = await getKey(name);
        if (key) { keyName = name; break; }
      }
      if (key) {
        const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
        const root = origin || `http://${host}:${config.port}`;
        for (const path of ['/api/home', '/api/profiles']) {
          const found = await probe(`${root}${path}`, key, raw, keyName);
          if (found?.timedOut) break;
          if (found) {
            const result = { ...found, agents: selectHarnessAgents(found.agents, stored, config.profile || 'intelio') };
            cachedAgents = result;
            cachedFor = stamp;
            return result;
          }
        }
      }
    }

    return { agents: selectHarnessAgents(null, stored, config.profile || 'intelio'), sample: false, label: '' };
  }

  async function listSessions(profile, { source, limit = 100, offset = 0 } = {}) {
    const result = await client.listSessions({ source, limit, offset, ...(profile ? { profile } : {}) });
    const rows = Array.isArray(result?.data) ? result.data : [];
    const raw = await rawConfig();
    const profileId = profile || normalizeRemoteConfig(raw || {}).profile || 'default';
    return rows.map((session) => decorateSession(session, profileId));
  }

  async function listAllSessions(profiles) {
    const stored = storedNames();
    const requested = Array.isArray(profiles) && profiles.length ? profiles : stored;
    const ids = [...new Set(requested.map((name) => String(name || '').trim().toLowerCase()).filter((name) => name && name !== 'vnc'))];
    const named = NAMED_AGENTS.map((agent) => agent.id).filter((id) => ids.includes(id));
    const rest = ids.filter((id) => !named.includes(id) && !excludedAgent(id)).sort();
    const targets = [...named, ...rest];
    const groups = await Promise.all(targets.map(async (profile) => {
      try { return await listSessions(profile, { limit: 100 }); } catch (error) {
        if (error?.code === 'CLOUD_ACCESS') throw error;
        return [];
      }
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

module.exports = { NAMED_AGENTS, sourceLabel, agentsFromKeys, selectHarnessAgents, sessionTime, byNewest, canonicalName, createRemoteMain };
