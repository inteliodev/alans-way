/**
 * intelio home: the "Good morning" page. Pure data shaping, no DOM: the
 * greeting, the quick-action prompts, Active missions, Recent work across all
 * agents, and Continue cards.
 *
 * Continue cards come only from real evidence. Each card points at a session id
 * (or, later, a file or repo the computer connector reported); there is no
 * model call and nothing is made up. Herald OS uses a model to group evidence
 * into threads and drops anything it cites that was not in the evidence; intelio
 * skips the model and builds the cards directly.
 *
 * Greeting and the "Plan my day" prompt are adapted from Herald OS
 * apps/desktop/src/features/overview/OverviewPage.tsx and src/lib/format.ts
 * (https://github.com/iamlukethedev/Herald-OS, MIT, Copyright (c) 2026 Luke The Dev).
 * See THIRD_PARTY.md.
 */
(function intelioHomeFeed(root, factory) {
  const missions = (typeof module !== 'undefined' && module.exports) ? require('./missions.cjs') : root.IntelioMissions;
  const api = factory(missions);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioHomeFeed = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioHomeFeedFactory(missions) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const PLAN_MY_DAY_PROMPT = "Plan my day. Look at today's calendar, my open tasks and anything you are in the middle of, then propose a realistic schedule with priorities and time blocks, and what I should prepare. Keep it short.";
  const AGENT_ORDER = ['intelio', 'prc', 'alignment', 'hhp', 'arlp'];

  function greetingFor(date) {
    const hour = date.getHours();
    if (hour < 5) return 'Good evening';
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function firstName(name) {
    const word = String(name || '').trim().split(/[\s._@-]+/)[0] || '';
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
  }

  /** "Good morning, Hayden." */
  function greeting(now = new Date(), name = '') {
    const who = firstName(name);
    return `${greetingFor(now)}${who ? `, ${who}` : ''}.`;
  }

  /** "Thursday, October 8" */
  function dateLine(now = new Date()) {
    return now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  /** "just now", "12m ago", "3h ago", "yesterday", "Oct 3" */
  function relative(ms, now = Date.now()) {
    if (!ms) return '';
    const delta = Math.max(0, now - ms);
    const minutes = Math.round(delta / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    if (hours < 48) return 'yesterday';
    return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function agentName(agents, id) {
    const key = String(id || '').toLowerCase();
    const found = (agents || []).find((agent) => String(agent.id || '').toLowerCase() === key);
    const raw = String(found?.name || '').trim();
    // A real display name wins; a name that is just the profile id gets house casing (like shownAgent).
    if (raw && raw.toLowerCase() !== key) return raw;
    if (key === 'intelio') return 'intelio';
    if (!key) return 'Agent';
    return key.length <= 4 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  }

  function uniqueSessions(sessions) {
    const seen = new Set();
    const out = [];
    for (const row of Array.isArray(sessions) ? sessions : []) {
      const id = String(row?.id || '');
      if (!id || seen.has(id) || row.archived === true || row.hidden === true) continue;
      seen.add(id);
      out.push(row);
    }
    return out.sort((a, b) => missions.sessionTime(b) - missions.sessionTime(a));
  }

  /** Recent sessions across every agent, newest first. */
  function recentWork(sessions, { agents = [], limit = 6, now = Date.now() } = {}) {
    return uniqueSessions(sessions).slice(0, limit).map((row) => {
      const at = missions.sessionTime(row);
      return {
        id: String(row.id),
        profileId: String(row.profileId || '').toLowerCase(),
        agent: agentName(agents, row.profileId),
        title: String(row.title || '').trim() || 'Untitled',
        preview: String(row.preview || row.last_message || '').replace(/\s+/g, ' ').trim().slice(0, 140),
        when: relative(at, now),
        at,
        source: row.sourceLabel || row.source || '',
      };
    });
  }

  /**
   * Missions worth showing on the home page: anything working or left open,
   * plus what moved in the last day. `byId` maps session id -> mission derived
   * from the transcript, when one was loaded.
   */
  function activeMissions(sessions, { byId = {}, live = '', now = Date.now(), limit = 3 } = {}) {
    const list = uniqueSessions(sessions)
      .map((row) => byId[row.id] || missions.deriveMission(row, null, { now, live: row.id === live }))
      .map((mission) => (mission.id === live && mission.status !== 'working' ? { ...mission, status: 'working', statusLabel: missions.STATUS.working.label, tone: missions.STATUS.working.tone } : mission))
      .filter((mission) => mission.status === 'working' || mission.status === 'open' || now - mission.updatedAt < DAY_MS);
    return missions.sortMissions(list).slice(0, limit);
  }

  /**
   * Where you left off. Session cards need transcript evidence (open to-dos, a
   * stopped turn, or files written); without it, the newest session of the last
   * three days is offered as a plain "pick up" card. Connector items (files, git
   * repos) are passed in already collected; any item missing what it needs is
   * dropped, never filled in.
   */
  function continueCards({ sessions = [], byId = {}, agents = [], connector = {}, now = Date.now(), limit = 3 } = {}) {
    const cards = [];
    for (const row of uniqueSessions(sessions)) {
      const mission = byId[row.id];
      const at = mission?.updatedAt || missions.sessionTime(row);
      if (!at || now - at > 3 * DAY_MS) continue;
      let reason = '';
      if (mission?.status === 'open') reason = `${mission.todoDone} of ${mission.todoTotal} to-dos done${mission.step ? ` · next: ${mission.step}` : ''}`;
      else if (mission?.status === 'stopped') reason = 'Stopped before it finished';
      else if (mission?.status === 'ready' && mission.outputs.length) reason = `Wrote ${mission.outputs.length === 1 ? mission.outputs[0].name : `${mission.outputs.length} files`}`;
      else if (mission?.status === 'working') reason = 'Still working';
      if (!reason) continue;
      cards.push({
        key: `session:${row.id}`,
        kind: 'session',
        id: String(row.id),
        profileId: String(row.profileId || '').toLowerCase(),
        agent: agentName(agents, row.profileId),
        title: mission?.title || String(row.title || '').trim() || 'Untitled',
        reason,
        when: relative(at, now),
        at,
      });
    }
    if (!cards.length) {
      const fallback = uniqueSessions(sessions).find((row) => { const at = missions.sessionTime(row); return at && now - at <= 3 * DAY_MS; });
      if (fallback) {
        const at = missions.sessionTime(fallback);
        cards.push({ key: `session:${fallback.id}`, kind: 'session', id: String(fallback.id), profileId: String(fallback.profileId || '').toLowerCase(), agent: agentName(agents, fallback.profileId), title: String(fallback.title || '').trim() || 'Untitled', reason: 'Your last conversation', when: relative(at, now), at });
      }
    }
    for (const file of Array.isArray(connector.files) ? connector.files : []) {
      if (!file || typeof file.path !== 'string' || !file.path || typeof file.machine !== 'string' || !file.machine) continue;
      const at = missions.toMs(file.modifiedAt);
      cards.push({ key: `file:${file.machine}:${file.path}`, kind: 'file', machine: file.machine, path: file.path, title: file.name || file.path.split(/[\\/]/).pop(), reason: `Edited on ${file.machine}`, when: relative(at, now), at });
    }
    for (const repo of Array.isArray(connector.repos) ? connector.repos : []) {
      if (!repo || typeof repo.path !== 'string' || !repo.path || typeof repo.machine !== 'string' || !repo.machine) continue;
      const changed = Number(repo.changed) || 0;
      if (!changed && !repo.ahead) continue;
      const at = missions.toMs(repo.modifiedAt);
      const bits = [changed ? `${changed} uncommitted change${changed === 1 ? '' : 's'}` : '', repo.ahead ? `${repo.ahead} commit${repo.ahead === 1 ? '' : 's'} not pushed` : ''].filter(Boolean);
      cards.push({ key: `repo:${repo.machine}:${repo.path}`, kind: 'repo', machine: repo.machine, path: repo.path, branch: String(repo.branch || ''), title: repo.name || repo.path.split(/[\\/]/).pop(), reason: `${bits.join(', ')} on ${repo.machine}`, when: relative(at, now), at });
    }
    return cards.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /**
   * Where Continue gets computer evidence. The computer connector (PRs #7/#9)
   * registers a provider here once it lands:
   *   register('computer', { recentFiles: async () => [{ machine, path, name, modifiedAt }],
   *                          gitStatus:  async () => [{ machine, path, name, branch, changed, ahead, modifiedAt }] })
   * Until then the stub answers with nothing, so no file or repo card appears.
   */
  function createContinueSources() {
    const providers = new Map();
    providers.set('computer', { stub: true, recentFiles: async () => [], gitStatus: async () => [] });
    return {
      register(name, provider) {
        if (!name || !provider) return;
        providers.set(String(name), provider);
      },
      has(name) { const provider = providers.get(String(name)); return Boolean(provider && !provider.stub); },
      async collect({ timeoutMs = 2500 } = {}) {
        const files = [];
        const repos = [];
        const late = (fallback) => new Promise((resolve) => { const timer = setTimeout(() => resolve(fallback), timeoutMs); timer?.unref?.(); });
        await Promise.all([...providers.values()].map(async (provider) => {
          const [f, r] = await Promise.all([
            Promise.race([Promise.resolve().then(() => provider.recentFiles?.() || []).catch(() => []), late([])]),
            Promise.race([Promise.resolve().then(() => provider.gitStatus?.() || []).catch(() => []), late([])]),
          ]);
          if (Array.isArray(f)) files.push(...f.slice(0, 20));
          if (Array.isArray(r)) repos.push(...r.slice(0, 20));
        }));
        return { files, repos };
      },
    };
  }

  /** Agents in the house order (intelio, PRC, Alignment, HHP, ARLP, then the rest). */
  function orderAgents(agents) {
    return (Array.isArray(agents) ? agents : []).slice().sort((a, b) => {
      const left = AGENT_ORDER.indexOf(String(a.id || '').toLowerCase());
      const right = AGENT_ORDER.indexOf(String(b.id || '').toLowerCase());
      return (left < 0 ? 99 : left) - (right < 0 ? 99 : right) || String(a.id).localeCompare(String(b.id));
    });
  }

  return {
    PLAN_MY_DAY_PROMPT, greetingFor, greeting, dateLine, relative, firstName, agentName,
    recentWork, activeMissions, continueCards, createContinueSources, orderAgents, missionPrompt: missions.missionPrompt,
  };
});
