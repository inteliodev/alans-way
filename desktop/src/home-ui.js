/**
 * intelio home, missions, the Cmd+K command bar, and "install a skill from a link".
 *
 * Layout ideas (a greeting with quick actions, "pick up where you left off",
 * mission cards with to-dos and helpers, one command registry for the bar,
 * voice and agents) are adapted from Herald OS
 * (https://github.com/iamlukethedev/Herald-OS, MIT, Copyright (c) 2026 Luke The Dev).
 * See THIRD_PARTY.md. intelio reads only what it already has: the sessions and
 * transcripts IntelioRemote loads through the gateway. Nothing here is made up.
 */
(function intelioHomeUi(root) {
  'use strict';
  const doc = root.document;
  const Feed = root.IntelioHomeFeed;
  const Missions = root.IntelioMissions;
  const Commands = root.IntelioCommands;
  const SkillLink = root.IntelioSkillLink;
  if (!doc || !Feed || !Missions || !Commands) return;

  const PREFS_KEY = 'intelio-home';
  const DEFAULT_PREFS = { enabled: true, showOnStart: true, name: 'Hayden' };
  const MAC = /Mac|iPhone|iPad/.test(String(root.navigator?.platform || root.navigator?.userAgent || ''));
  const KEY_LABEL = MAC ? '⌘K' : 'Ctrl K';
  const FILTERS = [['all', 'All'], ['working', 'Working'], ['open', 'Open to-dos'], ['ready', 'Done']];
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chat: '<path d="M4 5h16v11H8l-4 4z"/>',
    file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>',
    screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    skill: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    theme: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    agent: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  };

  let prefs = loadPrefs();
  let view = null;
  let surface = null;
  let homeButton = null;
  let autoShown = false;
  let quickAgent = '';
  let missionFilter = 'all';
  let selectedMission = '';
  let missionDetail = false;
  let connector = { files: [], repos: [] };
  let refreshTimer = null;
  const transcripts = new Map();
  const inflight = new Map();
  const sources = Feed.createContinueSources();
  const registry = Commands.createRegistry();

  function loadPrefs() {
    try {
      const saved = JSON.parse(root.localStorage?.getItem(PREFS_KEY) || '{}');
      return {
        enabled: saved.enabled !== false,
        showOnStart: saved.showOnStart !== false,
        name: typeof saved.name === 'string' ? saved.name.slice(0, 40) : DEFAULT_PREFS.name,
      };
    } catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs(next) {
    prefs = { ...prefs, ...next };
    try { root.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private windows keep defaults */ }
  }

  function h(tag, attrs, ...children) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(3)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      node.append(child.nodeType ? child : doc.createTextNode(String(child)));
    }
    return node;
  }
  function icon(name, cls = 'ih-icon') {
    const span = h('span', { class: cls, 'aria-hidden': 'true' });
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return span;
  }
  function notify(message) {
    const toast = doc.getElementById('toast');
    if (!toast || !message) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.add('hidden'), 4000);
  }
  function relayout() { try { root.intelioLayout?.(); } catch { /* the layout catches up on the next resize */ } }

  // ---- data -------------------------------------------------------------

  const remote = () => root.IntelioRemote;
  function snapshot() {
    return remote()?.homeState?.() || { agents: [], sessions: [], selected: '', sessionId: '', busy: false, sample: false, screens: [] };
  }
  function agentsOf(snap) { return Feed.orderAgents((snap.agents || []).filter((agent) => agent && agent.id)); }
  function accent(id) { return remote()?.accentOf?.(id) || 'currentColor'; }
  function nameOf(snap, id) { return Feed.agentName(snap.agents || [], id); }
  function liveId(snap) { return snap.busy ? snap.sessionId : ''; }
  function recentRows(snap, limit) {
    const seen = new Set();
    return (snap.sessions || [])
      .filter((row) => row && row.id && row.profileId && !seen.has(row.id) && seen.add(row.id))
      .sort((a, b) => Missions.sessionTime(b) - Missions.sessionTime(a))
      .slice(0, limit);
  }

  async function loadTranscript(row) {
    const stamp = Missions.sessionTime(row);
    const hit = transcripts.get(row.id);
    if (hit && hit.stamp === stamp) return hit.messages;
    if (inflight.has(row.id)) return inflight.get(row.id);
    const job = (async () => {
      let messages = null;
      if (snapshot().sample) messages = remote()?.SAMPLE?.messages?.[row.id] || [];
      else if (root.remoteHermes?.request) {
        try {
          const result = await root.remoteHermes.request('messages', { id: row.id, profile: row.profileId });
          messages = Array.isArray(result?.data) ? result.data : null;
        } catch { messages = null; }
      }
      if (messages) transcripts.set(row.id, { stamp, messages });
      return messages;
    })().finally(() => inflight.delete(row.id));
    inflight.set(row.id, job);
    return job;
  }

  /** Read the newest transcripts (three at a time) so cards can show to-dos and files. */
  async function hydrate(limit) {
    const rows = recentRows(snapshot(), limit).filter((row) => Date.now() - Missions.sessionTime(row) < 7 * 86400000 || !Missions.sessionTime(row));
    let index = 0;
    let changed = false;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        const before = transcripts.get(row.id);
        const messages = await loadTranscript(row);
        if (messages && before?.messages !== messages) changed = true;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (changed && view) paint();
  }

  function missionMap(snap, now) {
    const map = {};
    for (const row of snap.sessions || []) {
      const hit = transcripts.get(row.id);
      if (hit) map[row.id] = Missions.deriveMission(row, hit.messages, { now, live: row.id === liveId(snap) });
    }
    return map;
  }

  async function refreshConnector() {
    try { connector = await sources.collect({ timeoutMs: 2500 }); } catch { connector = { files: [], repos: [] }; }
  }

  // ---- actions ----------------------------------------------------------

  function rowFor(id, profileId) {
    const snap = snapshot();
    return (snap.sessions || []).find((row) => row.id === id && (!profileId || row.profileId === profileId)) || (id && profileId ? { id, profileId } : null);
  }

  async function openSession(id, profileId) {
    const row = rowFor(id, profileId);
    if (!row) return Commands.fail('That session is not loaded.');
    hide();
    await remote()?.openListed?.(row);
    return Commands.ok(`Opened ${row.title || 'the session'}.`);
  }

  /** Open a mission: its chat on the left, that agent's computer focused in the screen grid. */
  async function openMission(id, profileId) {
    const row = rowFor(id, profileId);
    if (!row) return Commands.fail('That mission is not loaded.');
    hide();
    try { root.openAgentComputer?.(row.profileId); } catch { /* the chat still opens */ }
    await remote()?.selectAgent?.(row.profileId, { sessionId: row.id });
    try {
      const state = await root.workspace?.getState?.();
      if (state && Number(state.screenGrid) > 1 && Number(state.activeScreen) !== 0) await root.workspace.command('settings', { activeScreen: 0 });
    } catch { /* single-screen layouts have nothing to focus */ }
    return Commands.ok(`Opened ${row.title || 'the mission'} and ${nameOf(snapshot(), row.profileId)}'s screen.`);
  }

  async function startChat(agentId, prompt = '') {
    const snap = snapshot();
    const id = agentId || quickAgent || snap.selected || agentsOf(snap)[0]?.id;
    if (!id) return Commands.fail('No agents are loaded yet.');
    hide();
    await remote()?.newChat?.(id);
    const input = doc.getElementById('remote-input');
    if (input && prompt) {
      input.value = prompt;
      input.dispatchEvent(new root.Event('input', { bubbles: true }));
      input.focus();
      try { input.setSelectionRange(prompt.length, prompt.length); } catch { /* not a text input */ }
    }
    return Commands.ok(prompt ? `New chat with ${nameOf(snap, id)}. The prompt is ready to send.` : `New chat with ${nameOf(snap, id)}.`);
  }

  async function openScreen(n) {
    if (!root.workspace?.command) return Commands.fail('Screens need the intelio app.');
    const state = await Promise.resolve(root.workspace.getState?.()).catch(() => null);
    const grid = Math.max(Number(state?.screenGrid) || 1, n);
    await root.workspace.command('activate', { id: 'vps' });
    await root.workspace.command('settings', { screenGrid: Math.min(4, grid), activeScreen: n - 1 });
    return Commands.ok(`Screen ${n}.`);
  }

  function themeNow() { return doc.documentElement.dataset.theme || 'dark'; }
  async function setTheme(target) {
    const button = doc.getElementById('theme-toggle');
    if (!button) return Commands.fail('The theme switch is not on this page.');
    for (let step = 0; step < 3 && themeNow() !== target; step += 1) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return themeNow() === target ? Commands.ok(`${target[0].toUpperCase()}${target.slice(1)} theme.`) : Commands.fail(`The ${target} theme isn't in this build.`);
  }

  function searchSessions(query = '') {
    hide();
    remote()?.setSidebar?.('sessions');
    const box = doc.getElementById('session-search');
    if (!box) return Commands.fail('Session search is not on this page.');
    box.classList.remove('hidden');
    box.value = query;
    box.dispatchEvent(new root.Event('input', { bubbles: true }));
    box.focus();
    return Commands.ok(query ? `Searching sessions for “${query}”.` : 'Search sessions.');
  }

  // ---- commands ---------------------------------------------------------

  const agentArg = { name: 'agent', type: 'string', maxLength: 64 };
  function agentIdFrom(text) {
    const wanted = Commands.normalize(text);
    if (!wanted) return '';
    const snap = snapshot();
    const hit = agentsOf(snap).find((agent) => Commands.normalize(agent.id) === wanted || Commands.normalize(agent.name) === wanted || Commands.normalize(nameOf(snap, agent.id)) === wanted);
    return hit ? hit.id : '';
  }
  function agentEntries(make) {
    const snap = snapshot();
    return agentsOf(snap).map((agent, index) => make(agent, nameOf(snap, agent.id), index));
  }

  registry.define([
    { id: 'home.open', title: 'Go home', description: 'Greeting, missions and recent work', group: 'Go to', tier: 'read', order: 10, keywords: ['good morning', 'overview', 'start'], phrases: ['go home', 'open home', 'good morning'], run: () => { show('home'); return Commands.ok('Home.'); } },
    { id: 'missions.open', title: 'Open missions', description: 'Every session as a mission: goal, to-dos, files, helpers', group: 'Go to', tier: 'read', order: 11, keywords: ['tasks', 'todo', 'progress'], phrases: ['open missions', 'show missions', 'missions'], run: () => { show('missions'); return Commands.ok('Missions.'); } },
    {
      id: 'chat.new', title: 'New chat', description: 'Start a fresh chat with the selected agent', group: 'Chat', order: 12, keywords: ['conversation', 'thread'],
      args: [agentArg, { name: 'prompt', type: 'string', maxLength: 2000 }],
      phrases: ['new chat', 'new chat with {agent}', 'start a chat with {agent}'],
      entries: () => agentEntries((agent, name, index) => ({ key: agent.id, title: `New chat with ${name}`, args: { agent: agent.id }, group: 'Chat', order: 15 + index * 0.01 })),
      run: ({ agent, prompt }) => startChat(agentIdFrom(agent) || agent, prompt || ''),
    },
    { id: 'day.plan', title: 'Plan my day', description: 'Ask the selected agent to plan today', group: 'Chat', order: 13, args: [agentArg], phrases: ['plan my day', 'plan today'], run: ({ agent }) => startChat(agentIdFrom(agent) || agent, Feed.PLAN_MY_DAY_PROMPT) },
    { id: 'mission.start', title: 'Start a mission', description: 'A chat that plans with a to-do list first', group: 'Chat', order: 14, args: [agentArg, { name: 'goal', type: 'string', maxLength: 1000 }], phrases: ['start a mission', 'start a mission to {goal}', 'new mission {goal}'], run: ({ agent, goal }) => startChat(agentIdFrom(agent) || agent, goal ? Feed.missionPrompt(goal) : 'Mission: ') },
    {
      id: 'agent.switch', title: 'Switch agent', group: 'Agents', order: 20, keywords: ['talk to', 'open agent'],
      args: [{ ...agentArg, required: true }],
      phrases: ['switch to {agent}', 'talk to {agent}', 'open {agent}'],
      entries: () => agentEntries((agent, name, index) => ({ key: agent.id, title: `Switch to ${name}`, subtitle: agent.id === snapshot().selected ? 'Selected now' : '', args: { agent: agent.id }, keywords: [agent.id, name], order: 20 + index * 0.01 })),
      run: async ({ agent }) => {
        const id = agentIdFrom(agent);
        if (!id) return Commands.fail(`No agent called “${agent}”.`);
        hide();
        await remote()?.selectAgent?.(id);
        return Commands.ok(`Switched to ${nameOf(snapshot(), id)}.`);
      },
    },
    {
      id: 'session.open', title: 'Open session', group: 'Sessions', order: 40,
      args: [{ name: 'id', type: 'string', required: true, maxLength: 200 }, { name: 'profile', type: 'string', maxLength: 64 }],
      entries: (context) => {
        const snap = snapshot();
        const now = Date.now();
        return recentRows(snap, context.query ? 60 : 4).map((row, index) => ({
          key: `${row.profileId}:${row.id}`,
          title: String(row.title || '').trim() || 'Untitled',
          subtitle: [nameOf(snap, row.profileId), Feed.relative(Missions.sessionTime(row), now)].filter(Boolean).join(' · '),
          args: { id: row.id, profile: row.profileId },
          keywords: [String(row.preview || '').slice(0, 120), row.profileId],
          order: 40 + index * 0.01,
        }));
      },
      run: ({ id, profile }) => openSession(id, profile),
    },
    { id: 'session.search', title: 'Search sessions', description: 'Find a conversation across every agent', group: 'Sessions', order: 45, args: [{ name: 'query', type: 'string', maxLength: 200 }], phrases: ['search sessions for {query}', 'search sessions', 'find session {query}'], run: ({ query }) => searchSessions(query || '') },
    {
      id: 'screen.open', title: 'Open screen', group: 'Screens', order: 30,
      args: [{ name: 'n', type: 'number', required: true, min: 1, max: 4 }],
      phrases: ['open screen {n}', 'screen {n}', 'show screen {n}'],
      entries: () => ["Agent's computer", 'Your Mac', 'Screen 3', 'Screen 4'].map((label, index) => ({ key: String(index + 1), title: `Open screen ${index + 1}`, subtitle: label, args: { n: index + 1 }, keywords: [label], hint: `${index + 1}`, order: 30 + index * 0.01 })),
      run: ({ n }) => openScreen(n),
    },
    { id: 'theme.toggle', title: 'Toggle theme', description: 'Next theme', group: 'App', order: 60, keywords: ['light', 'blue', 'dark', 'appearance'], phrases: ['toggle theme', 'switch theme', 'change theme'], run: () => { const button = doc.getElementById('theme-toggle'); if (!button) return Commands.fail('The theme switch is not on this page.'); button.click(); return Commands.ok(`${themeNow()} theme.`); } },
    {
      id: 'theme.set', title: 'Set theme', group: 'App', order: 61,
      args: [{ name: 'theme', type: 'string', required: true, enum: ['light', 'blue', 'dark'] }],
      phrases: ['{theme} theme', 'use the {theme} theme'],
      entries: () => ['light', 'blue', 'dark'].map((theme, index) => ({ key: theme, title: `${theme[0].toUpperCase()}${theme.slice(1)} theme`, args: { theme }, subtitle: themeNow() === theme ? 'On now' : '', keywords: ['appearance'], order: 61 + index * 0.01 })),
      run: ({ theme }) => setTheme(theme),
    },
    { id: 'settings.open', title: 'Open settings', group: 'App', order: 62, keywords: ['preferences', 'options'], phrases: ['open settings', 'settings'], run: () => { const button = doc.getElementById('settings-fallback') || doc.getElementById('settings-button'); if (!button) return Commands.fail('Settings are not on this page.'); hide(); button.click(); return Commands.ok('Settings.'); } },
    { id: 'skill.install', title: 'Install a skill from a link', description: 'Paste a GitHub link to a skill folder', group: 'App', order: 63, keywords: ['github', 'add skill', 'skill.md'], args: [{ name: 'url', type: 'string', maxLength: 600 }], phrases: ['install a skill', 'install skill', 'add a skill'], run: ({ url }) => { openSkill(url || ''); return Commands.ok('Paste a skill link.'); } },
    { id: 'voice.start', title: 'Start voice', description: 'Talk with the selected agent', group: 'App', order: 64, keywords: ['call', 'talk', 'speak', 'microphone'], phrases: ['start voice', 'start a call', 'talk out loud'], run: () => { if (!remote()?.toggleCall) return Commands.fail('Voice is not on this page.'); hide(); remote().toggleCall(); return Commands.ok('Voice.'); } },
  ]);

  function run(id, args = {}, source = 'ui') {
    return registry.run(id, args, { source }).then((result) => {
      if (result && !result.ok) notify(result.error || result.summary);
      return result;
    });
  }

  // ---- home surface -----------------------------------------------------

  function ensureSurface() {
    if (surface) return surface;
    const pane = doc.querySelector('.chat-pane');
    if (!pane) return null;
    surface = h('section', { id: 'intelio-home', class: 'ih-surface', 'aria-label': 'intelio home', hidden: true });
    const header = pane.querySelector('.chat-header');
    if (header) header.after(surface); else pane.prepend(surface);
    surface.addEventListener('click', onSurfaceClick);
    return surface;
  }

  function ensureHomeButton() {
    if (homeButton || !prefs.enabled) return;
    const header = doc.querySelector('.chat-pane .chat-header');
    if (!header) return;
    homeButton = h('button', { id: 'ih-home-toggle', class: 'icon-button no-drag ih-home-toggle', type: 'button', title: 'intelio home', 'aria-label': 'intelio home', 'aria-pressed': 'false', onclick: () => toggle() }, icon('home'));
    header.append(homeButton);
  }

  function show(next = 'home') {
    if (!prefs.enabled && next === 'home') { notify('Turn on intelio home in Settings.'); return; }
    if (!ensureSurface()) return;
    view = next === 'missions' ? 'missions' : 'home';
    surface.hidden = false;
    doc.querySelector('.chat-pane')?.classList.add('ih-open');
    homeButton?.setAttribute('aria-pressed', 'true');
    paint();
    relayout();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (view && !doc.hidden) paint(); }, 30000);
    hydrate(view === 'missions' ? 24 : 12);
    refreshConnector().then(() => { if (view === 'home' && (connector.files.length || connector.repos.length)) paint(); });
  }

  function hide() {
    if (!view) return;
    view = null;
    clearInterval(refreshTimer);
    if (surface) surface.hidden = true;
    doc.querySelector('.chat-pane')?.classList.remove('ih-open');
    homeButton?.setAttribute('aria-pressed', 'false');
    relayout();
  }

  function toggle(next) { if (view && (!next || next === view)) hide(); else show(next || 'home'); }

  function paint() {
    if (!surface || !view) return;
    const snap = snapshot();
    const now = Date.now();
    const scroller = surface.querySelector('.ih-scroll');
    const top = scroller ? scroller.scrollTop : 0;
    surface.replaceChildren(
      h('div', { class: 'ih-top' },
        h('div', { class: 'ih-tabs', role: 'tablist', 'aria-label': 'Home views' },
          h('button', { type: 'button', role: 'tab', 'aria-selected': String(view === 'home'), 'data-ih': 'tab-home' }, 'Home'),
          h('button', { type: 'button', role: 'tab', 'aria-selected': String(view === 'missions'), 'data-ih': 'tab-missions' }, 'Missions')),
        h('span', { class: 'ih-spacer' }),
        h('button', { type: 'button', class: 'ih-ghost', 'data-ih': 'bar', title: 'Command bar' }, icon('search'), h('kbd', {}, KEY_LABEL)),
        h('button', { type: 'button', class: 'ih-ghost ih-icon-only', 'data-ih': 'close', title: 'Back to chat', 'aria-label': 'Back to chat' }, icon('close'))),
      h('div', { class: 'ih-scroll' }, view === 'missions' ? renderMissions(snap, now) : renderHome(snap, now)));
    const next = surface.querySelector('.ih-scroll');
    if (next) next.scrollTop = top;
  }

  function onSurfaceClick(event) {
    const target = event.target.closest('[data-ih]');
    if (!target || !surface.contains(target)) return;
    const action = target.dataset.ih;
    const id = target.dataset.id || '';
    const profile = target.dataset.profile || '';
    if (action === 'tab-home') { view = 'home'; paint(); hydrate(12); }
    else if (action === 'tab-missions' || action === 'see-missions') { view = 'missions'; missionDetail = false; paint(); hydrate(24); }
    else if (action === 'bar') openBar();
    else if (action === 'close') hide();
    else if (action === 'agent') { quickAgent = target.dataset.agent || ''; paint(); }
    else if (action === 'plan') run('day.plan', { agent: quickAgent });
    else if (action === 'mission') run('mission.start', { agent: quickAgent });
    else if (action === 'session') run('session.open', { id, profile });
    else if (action === 'open-mission') openMission(id, profile);
    else if (action === 'see-sessions') run('session.search', {});
    else if (action === 'filter') { missionFilter = target.dataset.filter || 'all'; paint(); }
    else if (action === 'pick') {
      selectedMission = id;
      missionDetail = true;
      paint();
      const row = rowFor(id, profile);
      if (row && !transcripts.has(row.id)) loadTranscript(row).then(() => { if (view === 'missions') paint(); });
    } else if (action === 'detail-back') { missionDetail = false; paint(); }
  }

  function quickAgentId(snap, agents) {
    if (quickAgent && agents.some((agent) => agent.id === quickAgent)) return quickAgent;
    return snap.selected && agents.some((agent) => agent.id === snap.selected) ? snap.selected : (agents[0]?.id || '');
  }

  function section(title, { action, actionLabel = 'See all', sub } = {}, ...body) {
    return h('section', { class: 'ih-section' },
      h('div', { class: 'ih-section-head' },
        h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'ih-section-sub' }, sub) : null),
        action ? h('button', { type: 'button', class: 'ih-link', 'data-ih': action }, actionLabel, icon('arrow', 'ih-icon ih-icon--sm')) : null),
      ...body);
  }
  function empty(title, text) {
    return h('div', { class: 'ih-empty' }, h('p', { class: 'ih-empty-title' }, title), text ? h('p', {}, text) : null);
  }
  function dot(id) { return h('span', { class: 'ih-agent-dot', style: `--agent:${accent(id)}`, 'aria-hidden': 'true' }); }
  function pill(mission) {
    return h('span', { class: `ih-pill ih-pill--${mission.tone}` }, mission.tone === 'live' ? h('span', { class: 'ih-pulse', 'aria-hidden': 'true' }) : null, mission.statusLabel);
  }

  function renderHome(snap, now) {
    const agents = agentsOf(snap);
    const qa = quickAgentId(snap, agents);
    const byId = missionMap(snap, now);
    const active = Feed.activeMissions(snap.sessions, { byId, live: liveId(snap), now, limit: 3 });
    const recent = Feed.recentWork(snap.sessions, { agents: snap.agents, limit: 6, now });
    const cards = Feed.continueCards({ sessions: snap.sessions, byId, agents: snap.agents, connector, now, limit: 3 });
    const working = active.filter((mission) => mission.status === 'working').length;
    const open = active.filter((mission) => mission.status === 'open').length;
    const sub = working || open
      ? `${[working ? `${working} mission${working === 1 ? '' : 's'} working` : '', open ? `${open} with open to-dos` : ''].filter(Boolean).join(', ')}.`
      : 'Pick up where you left off, or start something new.';
    return h('div', { class: 'ih-page' },
      h('header', { class: 'ih-hero' },
        h('p', { class: 'ih-eyebrow' }, h('span', { class: 'ih-live-dot', 'aria-hidden': 'true' }), [Feed.dateLine(new Date(now)), agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')),
        h('h1', { class: 'ih-greeting' }, Feed.greeting(new Date(now), prefs.name)),
        h('p', { class: 'ih-sub' }, sub),
        agents.length ? h('div', { class: 'ih-agents', role: 'radiogroup', 'aria-label': 'Agent for quick actions' },
          agents.map((agent) => h('button', { type: 'button', role: 'radio', class: 'ih-agent', 'aria-checked': String(agent.id === qa), 'data-ih': 'agent', 'data-agent': agent.id }, dot(agent.id), nameOf(snap, agent.id)))) : null,
        h('div', { class: 'ih-actions' },
          h('button', { type: 'button', class: 'ih-action ih-action--primary', 'data-ih': 'plan', disabled: !qa }, icon('sun'), 'Plan my day'),
          h('button', { type: 'button', class: 'ih-action', 'data-ih': 'mission', disabled: !qa }, icon('target'), 'Start a mission'),
          h('button', { type: 'button', class: 'ih-action ih-action--quiet', 'data-ih': 'bar' }, icon('command'), 'Commands', h('kbd', {}, KEY_LABEL)))),
      section('Continue', { sub: 'Pick up where you left off' },
        cards.length ? h('div', { class: 'ih-grid' }, cards.map((card) => continueCard(card))) : empty('Nothing to pick up yet.', 'Conversations with open to-dos, stopped work or new files show up here.')),
      section('Active missions', { action: 'see-missions' },
        active.length ? h('div', { class: 'ih-stack' }, active.map((mission) => missionCard(snap, mission, now))) : empty('No missions running.', 'Start a mission and its to-dos, files and helpers show up here.')),
      section('Recent work', { action: 'see-sessions', sub: 'Across every agent' },
        recent.length ? h('ul', { class: 'ih-list' }, recent.map((item) => h('li', {},
          h('button', { type: 'button', class: 'ih-row', 'data-ih': 'session', 'data-id': item.id, 'data-profile': item.profileId },
            dot(item.profileId),
            h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, item.title), item.preview ? h('span', { class: 'ih-row-sub' }, item.preview) : null),
            h('span', { class: 'ih-row-meta' }, [item.agent, item.when].filter(Boolean).join(' · ')))))) : empty('No conversations yet.', 'Chats with any of your agents land here.')));
  }

  function continueCard(card) {
    const kind = card.kind === 'file' ? 'file' : card.kind === 'repo' ? 'branch' : 'chat';
    const attrs = card.kind === 'session'
      ? { type: 'button', class: 'ih-card ih-continue', 'data-ih': 'session', 'data-id': card.id, 'data-profile': card.profileId }
      : { type: 'button', class: 'ih-card ih-continue', disabled: true, title: `${card.machine}: ${card.path}` };
    return h('button', attrs,
      h('span', { class: 'ih-continue-kind' }, icon(kind, 'ih-icon ih-icon--sm'), card.kind === 'session' ? card.agent : card.machine),
      h('span', { class: 'ih-card-title' }, card.title),
      h('span', { class: 'ih-card-sub' }, card.reason),
      card.when ? h('span', { class: 'ih-card-meta' }, card.when) : null);
  }

  function steps(mission, max = 5) {
    if (!mission.todoTotal) return null;
    const pct = Math.round((mission.todoDone / mission.todoTotal) * 100);
    const more = mission.todos.length - max;
    return h('div', { class: 'ih-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(mission.todoTotal), 'aria-valuenow': String(mission.todoDone), 'aria-label': `${mission.todoDone} of ${mission.todoTotal} to-dos done` },
      h('span', { class: 'ih-progress-bar' }, h('span', { style: `width:${pct}%` })),
      h('ol', { class: 'ih-steps' }, mission.todos.slice(0, max).map((todo) => h('li', { class: `ih-step ih-step--${todo.status}` }, h('span', { class: 'ih-step-mark', 'aria-hidden': 'true' }), h('span', {}, todo.content))),
        more > 0 ? h('li', { class: 'ih-step ih-step--more' }, `+${more} more`) : null));
  }

  function missionMeta(snap, mission, now) {
    return [
      nameOf(snap, mission.profileId),
      mission.todoTotal ? `${mission.todoDone} of ${mission.todoTotal} to-dos` : '',
      mission.outputs.length ? `${mission.outputs.length} file${mission.outputs.length === 1 ? '' : 's'}` : '',
      mission.helpers.length ? `${mission.helpers.length} helper${mission.helpers.length === 1 ? '' : 's'}` : '',
      Feed.relative(mission.updatedAt, now),
    ].filter(Boolean).join(' · ');
  }

  function missionCard(snap, mission, now) {
    return h('article', { class: 'ih-card ih-mission' },
      h('div', { class: 'ih-mission-head' }, dot(mission.profileId), h('span', { class: 'ih-card-title' }, mission.title), pill(mission)),
      mission.goal && mission.goal !== mission.title ? h('p', { class: 'ih-mission-goal' }, mission.goal) : null,
      steps(mission, 3),
      h('div', { class: 'ih-mission-foot' },
        h('span', { class: 'ih-card-meta' }, missionMeta(snap, mission, now)),
        h('button', { type: 'button', class: 'ih-chip', 'data-ih': 'open-mission', 'data-id': mission.id, 'data-profile': mission.profileId }, 'Open', icon('arrow', 'ih-icon ih-icon--sm'))));
  }

  function renderMissions(snap, now) {
    const byId = missionMap(snap, now);
    const all = Missions.sortMissions(recentRows(snap, 40).map((row) => byId[row.id] || Missions.deriveMission(row, null, { now, live: row.id === liveId(snap) })));
    const shown = all.filter((mission) => missionFilter === 'all' || mission.status === missionFilter);
    const current = shown.find((mission) => mission.id === selectedMission) || shown[0] || null;
    const count = (key) => (key === 'all' ? all.length : all.filter((mission) => mission.status === key).length);
    return h('div', { class: `ih-page ih-missions${missionDetail ? ' has-detail' : ''}` },
      h('header', { class: 'ih-missions-head' },
        h('h1', { class: 'ih-title' }, 'Missions'),
        h('p', { class: 'ih-sub' }, 'Every session as a mission: the goal, its to-dos, the files it wrote and the helpers it sent out.'),
        h('div', { class: 'ih-filter', role: 'tablist', 'aria-label': 'Filter missions' },
          FILTERS.map(([key, label]) => h('button', { type: 'button', role: 'tab', class: 'ih-chip', 'aria-selected': String(missionFilter === key), 'data-ih': 'filter', 'data-filter': key }, label, h('span', { class: 'ih-count' }, String(count(key))))))),
      shown.length ? h('div', { class: 'ih-mgrid' },
        h('ul', { class: 'ih-mlist', 'aria-label': 'Missions' }, shown.map((mission) => h('li', {},
          h('button', { type: 'button', class: `ih-mrow${current && mission.id === current.id ? ' is-current' : ''}`, 'data-ih': 'pick', 'data-id': mission.id, 'data-profile': mission.profileId },
            dot(mission.profileId),
            h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, mission.title), h('span', { class: 'ih-row-sub' }, missionMeta(snap, mission, now))),
            pill(mission))))),
        current ? missionDetailView(snap, current, now) : null)
        : empty(missionFilter === 'all' ? 'No missions yet.' : 'Nothing here right now.', missionFilter === 'all' ? 'Start a mission from home, or chat with an agent. Sessions show up here.' : 'Try another filter.'));
  }

  function missionDetailView(snap, mission, now) {
    const block = (title, body) => h('section', { class: 'ih-detail-block' }, h('h3', {}, title), body);
    const helperTone = (status) => (status === 'running' ? 'live' : status === 'failed' ? 'quiet' : 'done');
    const helperLabel = (status) => (status === 'running' ? 'Working' : status === 'failed' ? 'Failed' : 'Done');
    return h('article', { class: 'ih-card ih-mdetail', 'aria-label': `Mission ${mission.title}` },
      h('button', { type: 'button', class: 'ih-link ih-detail-back', 'data-ih': 'detail-back' }, icon('back', 'ih-icon ih-icon--sm'), 'All missions'),
      h('div', { class: 'ih-mission-head' }, dot(mission.profileId), h('span', { class: 'ih-card-meta' }, [nameOf(snap, mission.profileId), Feed.relative(mission.updatedAt, now)].filter(Boolean).join(' · ')), pill(mission)),
      h('h2', { class: 'ih-detail-title' }, mission.title),
      block('Goal', h('p', { class: 'ih-detail-goal' }, mission.goal || 'No goal was written down.')),
      mission.todoTotal ? block(`To-dos · ${mission.todoDone} of ${mission.todoTotal}`, steps(mission, 20)) : null,
      mission.outputs.length ? block('Files it wrote', h('ul', { class: 'ih-files' }, mission.outputs.map((output) => h('li', { title: output.path }, icon('file', 'ih-icon ih-icon--sm'), h('span', { class: 'ih-file-name' }, output.name), h('span', { class: 'ih-file-path' }, output.path))))) : null,
      mission.helpers.length ? block('Helpers', h('ul', { class: 'ih-helpers' }, mission.helpers.map((helper) => h('li', {}, icon('agent', 'ih-icon ih-icon--sm'), h('span', { class: 'ih-row-main' }, helper.goal), h('span', { class: `ih-pill ih-pill--${helperTone(helper.status)}` }, helperLabel(helper.status)))))) : null,
      mission.last ? block('Latest reply', h('blockquote', { class: 'ih-quote' }, mission.last)) : null,
      !mission.loaded ? h('p', { class: 'ih-note' }, 'Reading the transcript…') : null,
      h('div', { class: 'ih-detail-actions' },
        h('button', { type: 'button', class: 'ih-action ih-action--primary', 'data-ih': 'open-mission', 'data-id': mission.id, 'data-profile': mission.profileId }, icon('screen'), 'Open chat and screen')));
  }

  // ---- command bar ------------------------------------------------------

  let bar = null;
  let barRows = [];
  let barIndex = 0;
  let lastToggle = 0;
  let restoreFocus = null;

  function ensureBar() {
    if (bar) return bar;
    const input = h('input', { class: 'ih-bar-input', type: 'text', placeholder: 'Type a command, an agent or a session…', 'aria-label': 'Command', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'ih-bar-list' });
    bar = h('div', { id: 'ih-bar', class: 'ih-overlay', hidden: true },
      h('div', { class: 'ih-bar', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command bar' },
        h('div', { class: 'ih-bar-field' }, icon('search'), input, h('kbd', {}, 'esc')),
        h('ul', { id: 'ih-bar-list', class: 'ih-bar-list', role: 'listbox' }),
        h('footer', { class: 'ih-bar-foot' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), ' move'), h('span', {}, h('kbd', {}, '↵'), ' run'), h('span', { class: 'ih-spacer' }), h('span', {}, 'intelio commands'))));
    bar.addEventListener('mousedown', (event) => { if (event.target === bar) { event.preventDefault(); closeBar(); } });
    input.addEventListener('input', () => { barIndex = 0; paintBar(); });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'Enter') { event.preventDefault(); choose(barRows[barIndex]); }
      else if (event.key === 'Escape') { event.preventDefault(); closeBar(); }
    });
    doc.body.append(bar);
    return bar;
  }

  function barQuery() { return bar?.querySelector('.ih-bar-input')?.value.trim() || ''; }

  function computeRows(query) {
    const snap = snapshot();
    const rows = registry.search(query, { query }, { limit: query ? 30 : 40 });
    if (query.length >= 2) {
      const agent = quickAgentId(snap, agentsOf(snap));
      if (agent) rows.push({ key: 'ask', id: 'chat.new', args: { agent, prompt: query }, title: `Ask ${nameOf(snap, agent)}: “${query}”`, subtitle: 'New chat with this as the first message', group: 'Chat' });
      rows.push({ key: 'find', id: 'session.search', args: { query }, title: `Search sessions for “${query}”`, subtitle: 'Every agent', group: 'Sessions' });
    }
    return rows;
  }

  function paintBar() {
    if (!bar) return;
    const query = barQuery();
    barRows = computeRows(query);
    if (barIndex >= barRows.length) barIndex = Math.max(0, barRows.length - 1);
    const list = bar.querySelector('.ih-bar-list');
    const items = [];
    let group = '';
    barRows.forEach((row, index) => {
      if (!query && row.group !== group) { group = row.group; items.push(h('li', { class: 'ih-bar-group', role: 'presentation' }, group)); }
      const item = h('li', { id: `ih-bar-row-${index}`, class: `ih-bar-row${index === barIndex ? ' is-active' : ''}`, role: 'option', 'aria-selected': String(index === barIndex) },
        h('span', { class: 'ih-bar-row-icon' }, icon(iconFor(row.id))),
        h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, row.title), row.subtitle ? h('span', { class: 'ih-row-sub' }, row.subtitle) : null),
        query && row.group ? h('span', { class: 'ih-bar-tag' }, row.group) : null,
        row.hint ? h('kbd', {}, row.hint) : null);
      item.addEventListener('mousemove', () => { if (barIndex !== index) { barIndex = index; highlight(); } });
      item.addEventListener('click', () => choose(row));
      items.push(item);
    });
    if (!barRows.length) items.push(h('li', { class: 'ih-bar-empty' }, 'No commands match.'));
    list.replaceChildren(...items);
    bar.querySelector('.ih-bar-input')?.setAttribute('aria-activedescendant', barRows.length ? `ih-bar-row-${barIndex}` : '');
  }
  function highlight() {
    bar.querySelectorAll('.ih-bar-row').forEach((node) => {
      const on = node.id === `ih-bar-row-${barIndex}`;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-selected', String(on));
      if (on) node.scrollIntoView?.({ block: 'nearest' });
    });
    bar.querySelector('.ih-bar-input')?.setAttribute('aria-activedescendant', `ih-bar-row-${barIndex}`);
  }
  function move(step) {
    if (!barRows.length) return;
    barIndex = (barIndex + step + barRows.length) % barRows.length;
    highlight();
  }
  function iconFor(id) {
    const area = String(id).split('.')[0];
    return { home: 'home', missions: 'target', chat: 'plus', day: 'sun', mission: 'target', agent: 'agent', session: 'chat', screen: 'screen', theme: 'theme', settings: 'gear', skill: 'skill', voice: 'mic' }[area] || 'command';
  }
  async function choose(row) {
    if (!row) return;
    closeBar({ keepFocus: true });
    await run(row.id, row.args, 'palette');
  }

  function openBar(query = '') {
    ensureBar();
    if (!bar.hidden) return;
    restoreFocus = doc.activeElement;
    bar.hidden = false;
    const input = bar.querySelector('.ih-bar-input');
    input.value = query;
    barIndex = 0;
    paintBar();
    relayout();
    input.focus();
  }
  function closeBar({ keepFocus = false } = {}) {
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    relayout();
    if (!keepFocus && restoreFocus?.focus) { try { restoreFocus.focus(); } catch { /* gone */ } }
    restoreFocus = null;
  }
  function toggleBar() {
    const now = Date.now();
    if (now - lastToggle < 250) return;
    lastToggle = now;
    if (bar && !bar.hidden) closeBar(); else openBar();
  }

  // ---- install a skill from a link --------------------------------------

  let skillBox = null;
  let skill = null;
  const cleanError = (error) => String(error?.message || error || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const linkHint = (url) => {
    const check = url && SkillLink ? SkillLink.parseSkillUrl(url) : null;
    if (!check) return 'Only github.com links. Nothing is run when it installs.';
    return check.ok ? `github.com/${check.owner}/${check.repo}${check.ref ? `@${check.ref}` : ''}${check.dir ? `/${check.dir}` : ''}` : check.error;
  };

  function openSkill(url = '') {
    const snap = snapshot();
    const first = quickAgentId(snap, agentsOf(snap));
    skill = { step: 'link', url, profiles: new Set(first ? [first] : []), category: '', busy: false, error: '', preview: null, results: [], overwrite: false };
    if (!skillBox) {
      skillBox = h('div', { id: 'ih-skill', class: 'ih-overlay', hidden: true });
      skillBox.addEventListener('mousedown', (event) => { if (event.target === skillBox && !skill?.busy) { event.preventDefault(); closeSkill(); } });
      skillBox.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !skill?.busy) { event.preventDefault(); closeSkill(); } });
      doc.body.append(skillBox);
    }
    skillBox.hidden = false;
    paintSkill();
    relayout();
    skillBox.querySelector('input')?.focus();
  }
  function closeSkill() {
    if (!skillBox) return;
    skillBox.hidden = true;
    skill = null;
    relayout();
  }

  async function previewSkill() {
    const parsed = SkillLink ? SkillLink.parseSkillUrl(skill.url) : { ok: true };
    if (!parsed.ok) { skill.error = parsed.error; paintSkill(); return; }
    if (!skill.profiles.size) { skill.error = 'Choose at least one agent.'; paintSkill(); return; }
    if (skill.category && SkillLink && !SkillLink.validCategory(skill.category)) { skill.error = 'Use lowercase letters, numbers and dashes for the folder.'; paintSkill(); return; }
    skill.busy = true; skill.error = ''; paintSkill();
    try {
      if (!root.remoteHermes?.request) throw new Error('Skill install needs the VPS connection.');
      const preview = await root.remoteHermes.request('skill-preview', { url: skill.url, profiles: [...skill.profiles], category: skill.category });
      if (!preview?.token) throw new Error(preview?.error || 'The VPS did not send a preview.');
      skill.preview = preview;
      skill.step = 'preview';
    } catch (error) {
      skill.error = cleanError(error);
    }
    skill.busy = false;
    paintSkill();
  }

  async function installSkill() {
    const targets = (skill.preview?.targets || []).filter((target) => target.ok !== false);
    if (!targets.length) return;
    skill.busy = true; skill.error = ''; skill.results = []; paintSkill();
    for (const target of targets) {
      try {
        const result = await root.remoteHermes.request('skill-install', { token: skill.preview.token, profile: target.profile, overwrite: skill.overwrite });
        skill.results.push({ profile: target.profile, ok: Boolean(result?.ok), dir: result?.dir || target.dir, replaced: Boolean(result?.replaced), error: result?.ok ? '' : (result?.error || 'Not installed.') });
      } catch (error) {
        skill.results.push({ profile: target.profile, ok: false, error: cleanError(error) });
      }
      paintSkill();
    }
    skill.busy = false;
    skill.step = 'done';
    paintSkill();
  }

  function size(bytes) { const n = Number(bytes) || 0; return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

  function skillLinkStep(snap) {
    const agents = agentsOf(snap);
    return h('div', { class: 'ih-dialog-body' },
      h('label', { class: 'ih-field' }, h('span', {}, 'GitHub link to a skill folder (with SKILL.md)'),
        h('input', { type: 'url', value: skill.url, placeholder: 'https://github.com/owner/repo/tree/main/skills/my-skill', spellcheck: 'false',
          oninput: (event) => { skill.url = event.target.value.trim(); skill.error = ''; const hint = skillBox.querySelector('.ih-field-hint'); if (hint) hint.textContent = linkHint(skill.url); },
          onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); previewSkill(); } } }),
        h('span', { class: 'ih-field-hint' }, linkHint(skill.url))),
      h('fieldset', { class: 'ih-field' }, h('legend', {}, 'Install for'),
        h('div', { class: 'ih-agents' }, agents.map((agent) => h('label', { class: 'ih-agent ih-agent--check' },
          h('input', { type: 'checkbox', checked: skill.profiles.has(agent.id), onchange: (event) => { if (event.target.checked) skill.profiles.add(agent.id); else skill.profiles.delete(agent.id); } }),
          dot(agent.id), nameOf(snap, agent.id))))),
      h('label', { class: 'ih-field' }, h('span', {}, 'Skills folder (optional)'),
        h('input', { type: 'text', value: skill.category, placeholder: `From the skill, or “${SkillLink?.DEFAULT_CATEGORY || 'installed'}”`, spellcheck: 'false', oninput: (event) => { skill.category = event.target.value.trim().toLowerCase(); } })),
      skill.error ? h('p', { class: 'ih-error', role: 'alert' }, skill.error) : null,
      h('div', { class: 'ih-dialog-actions' },
        h('button', { type: 'button', class: 'ih-action', onclick: closeSkill, disabled: skill.busy }, 'Cancel'),
        h('button', { type: 'button', class: 'ih-action ih-action--primary', onclick: previewSkill, disabled: skill.busy }, skill.busy ? 'Reading…' : 'Preview')));
  }

  function skillPreviewStep(snap) {
    const preview = skill.preview || {};
    const meta = preview.skill || {};
    const targets = preview.targets || [];
    const exists = targets.some((target) => target.exists);
    const resultFor = (profile) => skill.results.find((result) => result.profile === profile);
    const done = skill.step === 'done';
    return h('div', { class: 'ih-dialog-body' },
      h('div', { class: 'ih-skill-meta' },
        h('p', { class: 'ih-card-title' }, meta.name || meta.slug),
        meta.description ? h('p', { class: 'ih-card-sub' }, meta.description) : null,
        h('p', { class: 'ih-card-meta' }, [preview.source?.display, meta.version ? `v${meta.version}` : '', `${(preview.files || []).length} files`, size(preview.totalBytes)].filter(Boolean).join(' · '))),
      h('details', { class: 'ih-skill-md', open: true }, h('summary', {}, 'SKILL.md'), h('pre', {}, preview.skillMd || '')),
      h('section', { class: 'ih-detail-block' }, h('h3', {}, 'Files'),
        h('ul', { class: 'ih-files' }, (preview.files || []).map((file) => h('li', {}, h('span', { class: `ih-kind ih-kind--${file.kind}` }, file.kind), h('span', { class: 'ih-file-path' }, file.path), h('span', { class: 'ih-card-meta' }, size(file.size)))))),
      (preview.warnings || []).length ? h('ul', { class: 'ih-warnings' }, preview.warnings.map((warning) => h('li', {}, warning))) : null,
      h('section', { class: 'ih-detail-block' }, h('h3', {}, 'Where it lands'),
        h('ul', { class: 'ih-targets' }, targets.map((target) => {
          const result = resultFor(target.profile);
          const label = result ? (result.ok ? (result.replaced ? 'Replaced' : 'Installed') : 'Failed') : target.ok === false ? 'Not possible' : target.exists ? 'Already there' : 'New';
          const problem = result?.error || target.error;
          return h('li', {}, dot(target.profile),
            h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, nameOf(snap, target.profile)), h('span', { class: 'ih-file-path' }, result?.dir || target.dir || ''), problem ? h('span', { class: 'ih-error' }, problem) : null),
            h('span', { class: `ih-pill ih-pill--${result?.ok ? 'done' : 'quiet'}` }, label));
        }))),
      exists && !done ? h('label', { class: 'ih-check' }, h('input', { type: 'checkbox', checked: skill.overwrite, onchange: (event) => { skill.overwrite = event.target.checked; } }), 'Replace the copy that is already there (the old one is backed up first)') : null,
      h('p', { class: 'ih-note' }, done
        ? (skill.results.some((result) => result.ok) ? 'Installed. Each agent picks it up in its next new session. Nothing was run.' : 'Nothing was installed.')
        : 'Files are copied as text. Scripts are not run, and Hermes settings are not changed.'),
      skill.error ? h('p', { class: 'ih-error', role: 'alert' }, skill.error) : null,
      h('div', { class: 'ih-dialog-actions' },
        done
          ? h('button', { type: 'button', class: 'ih-action ih-action--primary', onclick: closeSkill }, 'Done')
          : [h('button', { type: 'button', class: 'ih-action', disabled: skill.busy, onclick: () => { skill.step = 'link'; skill.preview = null; paintSkill(); } }, 'Back'),
            h('button', { type: 'button', class: 'ih-action ih-action--primary', disabled: skill.busy || !targets.some((target) => target.ok !== false), onclick: installSkill }, skill.busy ? 'Installing…' : 'Install')]));
  }

  function paintSkill() {
    if (!skillBox || !skill) return;
    const snap = snapshot();
    const head = h('header', { class: 'ih-dialog-head' }, icon('skill'), h('h2', {}, 'Install a skill from a link'), h('span', { class: 'ih-spacer' }),
      h('button', { type: 'button', class: 'ih-ghost ih-icon-only', 'aria-label': 'Close', disabled: skill.busy, onclick: closeSkill }, icon('close')));
    const body = skill.step === 'link' ? skillLinkStep(snap) : skillPreviewStep(snap);
    skillBox.replaceChildren(h('div', { class: 'ih-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Install a skill from a link' }, head, body));
  }

  // ---- settings ---------------------------------------------------------

  function appendSettings(body) {
    if (!body || body.querySelector('[data-ih-settings]')) return;
    const toggleRow = (label, key, help) => h('label', { class: 'ih-setting' },
      h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, label), help ? h('span', { class: 'ih-row-sub' }, help) : null),
      h('input', { type: 'checkbox', checked: Boolean(prefs[key]), onchange: (event) => {
        savePrefs({ [key]: event.target.checked });
        if (key !== 'enabled') return;
        if (!prefs.enabled) { hide(); homeButton?.remove(); homeButton = null; } else ensureHomeButton();
      } }));
    body.append(h('section', { class: 'ih-settings', 'data-ih-settings': '' },
      h('h3', {}, 'intelio home'),
      toggleRow('Show intelio home', 'enabled', 'Greeting, missions and recent work above the chat'),
      toggleRow('Open home when intelio starts', 'showOnStart', ''),
      h('label', { class: 'ih-setting' }, h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, 'Name in the greeting')),
        h('input', { type: 'text', value: prefs.name, maxlength: '40', class: 'ih-setting-input', onchange: (event) => { savePrefs({ name: event.target.value.trim().slice(0, 40) }); if (view) paint(); } })),
      h('div', { class: 'ih-setting' }, h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, 'Command bar'), h('span', { class: 'ih-row-sub' }, `${KEY_LABEL} anywhere in intelio`))),
      h('div', { class: 'ih-setting' }, h('span', { class: 'ih-row-main' }, h('span', { class: 'ih-row-title' }, 'Skills'), h('span', { class: 'ih-row-sub' }, 'Paste a GitHub link to a skill folder')),
        h('button', { type: 'button', class: 'ih-chip', onclick: () => { doc.getElementById('modal-close')?.click(); openSkill(''); } }, 'Install from a link'))));
  }

  // ---- wiring -----------------------------------------------------------

  function onSessions() {
    ensureHomeButton();
    if (!autoShown && prefs.enabled && prefs.showOnStart && doc.body.classList.contains('remote-main') && (snapshot().agents || []).length) {
      autoShown = true;
      show('home');
      return;
    }
    if (view) { paint(); hydrate(view === 'missions' ? 24 : 12); }
  }

  // Ctrl/Cmd+K opens the bar only when focus is in intelio's own UI. A web page in an
  // agent browser tab (its own WebContentsView, an iframe/webview, or the noVNC screen
  // of a remote browser) keeps the shortcut for itself.
  const EMBEDDED_BROWSER = 'webview, iframe, object, embed, canvas, #screen, .vnc-screen, #vnc-screen, .remote-preview-slot, .browser-slot, [data-embedded-browser]';
  function inEmbeddedBrowser(event) {
    const targets = [event.target, doc.activeElement];
    return targets.some((node) => node && node.nodeType === 1 && typeof node.closest === 'function' && Boolean(node.closest(EMBEDDED_BROWSER)));
  }
  function commandBarKey(event) {
    return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'k';
  }
  doc.addEventListener('keydown', (event) => {
    if (!commandBarKey(event) || inEmbeddedBrowser(event)) return;
    event.preventDefault();
    toggleBar();
  }, true);
  // Leaving home: picking a session or agent in the sidebar, or starting a new chat.
  doc.addEventListener('click', (event) => {
    if (!view) return;
    if (event.target.closest?.('#bot-list, #all-sessions, #sidebar-threads, #lead-card, #session-new, #threads-new, #remote-sessions')) hide();
  }, true);
  try { root.workspace?.onCommandBar?.(() => toggleBar()); } catch { /* the web build has no menu */ }

  root.onIntelioSessions = onSessions;
  root.IntelioCommandRegistry = registry;
  root.IntelioHome = {
    commandBarKey, inEmbeddedBrowser,
    show, hide, toggle, paint, openBar, closeBar, toggleBar, openSkill, appendSettings, registry, sources,
    run: (id, args, source = 'ui') => run(id, args, source),
    covers: () => Boolean((bar && !bar.hidden) || (skillBox && !skillBox.hidden)),
    view: () => view,
    prefs: () => ({ ...prefs }),
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ensureHomeButton, { once: true }); else ensureHomeButton();
})(typeof window !== 'undefined' ? window : globalThis);
