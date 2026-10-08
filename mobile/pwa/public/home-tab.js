/**
 * intelio phone home tab: greeting, quick actions, active missions, recent work
 * and "continue" cards, read from the conversations the phone already loads.
 * Layout adapted from Herald OS's overview page
 * (https://github.com/iamlukethedev/Herald-OS, MIT, Copyright (c) 2026 Luke The Dev). See THIRD_PARTY.md.
 * Uses the same pure helpers as the desktop (desktop/src/intelio/home-feed.cjs, missions.cjs).
 */
(function intelioPhoneHome(root) {
  'use strict';
  const Feed = root.IntelioHomeFeed;
  const Missions = root.IntelioMissions;
  const PREFS_KEY = 'intelio-home';
  const transcripts = new Map();
  let loading = false;

  function prefs() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(PREFS_KEY) || '{}');
      return { enabled: saved.enabled !== false, showOnStart: saved.showOnStart !== false, name: typeof saved.name === 'string' ? saved.name.slice(0, 40) : 'Hayden' };
    } catch { return { enabled: true, showOnStart: true, name: 'Hayden' }; }
  }
  function setPref(key, value) {
    const next = { ...prefs(), [key]: value };
    try { root.localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* private mode keeps defaults */ }
  }
  function node(tag, cls, text) {
    const item = document.createElement(tag);
    if (cls) item.className = cls;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  }
  function button(cls, text, onClick) {
    const item = node('button', cls, text);
    item.type = 'button';
    item.addEventListener('click', onClick);
    return item;
  }
  function section(title, sub) {
    const wrap = node('section', 'ph-section');
    const head = node('div', 'ph-section-head');
    head.append(node('h2', '', title));
    if (sub) head.append(node('p', '', sub));
    wrap.append(head);
    return wrap;
  }
  function empty(title, text) {
    const box = node('div', 'ph-empty');
    box.append(node('p', 'ph-empty-title', title));
    if (text) box.append(node('p', '', text));
    return box;
  }

  /** Read the newest few transcripts so cards can show to-dos and files. */
  async function hydrate(ctx) {
    if (loading || ctx.sample) return;
    loading = true;
    const rows = ctx.conversations.slice().sort((a, b) => Missions.sessionTime(b) - Missions.sessionTime(a)).slice(0, 5);
    let changed = false;
    for (const row of rows) {
      const stamp = Missions.sessionTime(row);
      const hit = transcripts.get(row.id);
      if (hit && hit.stamp === stamp) continue;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(row.id)}/messages`, { headers: ctx.headers(row.profileId) });
        if (!response.ok) continue;
        const body = await response.json();
        if (Array.isArray(body?.data)) { transcripts.set(row.id, { stamp, messages: body.data }); changed = true; }
      } catch { /* the card falls back to the session row */ }
    }
    loading = false;
    if (changed) ctx.rerender();
  }

  function view(ctx) {
    const now = Date.now();
    const settings = prefs();
    const agents = ctx.profiles;
    const rows = ctx.conversations.filter((row) => row && row.id && row.profileId);
    const byId = {};
    for (const row of rows) {
      const hit = transcripts.get(row.id);
      if (hit) byId[row.id] = Missions.deriveMission(row, hit.messages, { now });
    }
    const page = node('div', 'ph-home');
    page.id = 'list';

    const hero = node('header', 'ph-hero');
    hero.append(node('p', 'ph-eyebrow', [Feed.dateLine(new Date(now)), agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')));
    hero.append(node('h1', 'ph-greeting', Feed.greeting(new Date(now), settings.name)));
    const chosen = agents.find((agent) => agent.id === ctx.selected) || agents[0];
    if (agents.length) {
      const chips = node('div', 'ph-agents');
      chips.setAttribute('role', 'radiogroup');
      chips.setAttribute('aria-label', 'Agent for quick actions');
      for (const agent of agents) {
        const chip = button(`ph-agent${chosen && agent.id === chosen.id ? ' on' : ''}`, '', () => { ctx.select(agent); });
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(Boolean(chosen && agent.id === chosen.id)));
        chip.append(ctx.face(agent, 'avatar xs'), node('span', '', agent.name));
        chips.append(chip);
      }
      hero.append(chips);
    }
    const actions = node('div', 'ph-actions');
    const plan = button('ph-action primary', 'Plan my day', () => chosen && ctx.startChat(chosen, Feed.PLAN_MY_DAY_PROMPT));
    const mission = button('ph-action', 'Start a mission', () => chosen && ctx.startChat(chosen, 'Mission: '));
    plan.disabled = !chosen;
    mission.disabled = !chosen;
    actions.append(plan, mission);
    hero.append(actions);
    page.append(hero);

    const cont = section('Continue', 'Pick up where you left off');
    const cards = Feed.continueCards({ sessions: rows, byId, agents, now, limit: 3 });
    if (cards.length) {
      const grid = node('div', 'ph-cards');
      for (const card of cards) {
        const item = button('ph-card', '', () => { const row = rows.find((r) => r.id === card.id); if (row) ctx.openChat(row); });
        item.append(node('span', 'ph-kind', card.agent), node('strong', '', card.title), node('span', 'ph-sub', card.reason), node('span', 'ph-meta', card.when));
        grid.append(item);
      }
      cont.append(grid);
    } else cont.append(empty('Nothing to pick up yet.', 'Conversations with open to-dos, stopped work or new files show up here.'));
    page.append(cont);

    const active = section('Active missions');
    const missions = Feed.activeMissions(rows, { byId, now, limit: 3 });
    if (missions.length) {
      for (const item of missions) {
        const row = rows.find((r) => r.id === item.id);
        const card = button('ph-card ph-mission', '', () => row && ctx.openChat(row));
        const head = node('span', 'ph-mission-head');
        head.append(node('strong', '', item.title), node('span', `ph-pill ${item.tone}`, item.statusLabel));
        card.append(head);
        if (item.goal && item.goal !== item.title) card.append(node('span', 'ph-sub', item.goal));
        const meta = [Feed.agentName(agents, item.profileId), item.todoTotal ? `${item.todoDone} of ${item.todoTotal} to-dos` : '', item.outputs.length ? `${item.outputs.length} file${item.outputs.length === 1 ? '' : 's'}` : '', item.helpers.length ? `${item.helpers.length} helper${item.helpers.length === 1 ? '' : 's'}` : '', Feed.relative(item.updatedAt, now)].filter(Boolean).join(' · ');
        card.append(node('span', 'ph-meta', meta));
        active.append(card);
      }
    } else active.append(empty('No missions running.', 'Start a mission and its to-dos show up here.'));
    page.append(active);

    const recent = section('Recent work', 'Across every agent');
    const work = Feed.recentWork(rows, { agents, limit: 6, now });
    if (work.length) {
      const list = node('div', 'ph-list');
      for (const item of work) {
        const row = rows.find((r) => r.id === item.id);
        const line = button('ph-row', '', () => row && ctx.openChat(row));
        const copy = node('span', 'ph-row-copy');
        copy.append(node('strong', '', item.title), node('span', 'ph-sub', item.preview || item.agent));
        line.append(ctx.face(ctx.profileById(item.profileId), 'avatar xs'), copy, node('span', 'ph-meta', [item.agent, item.when].filter(Boolean).join(' · ')));
        list.append(line);
      }
      recent.append(list);
    } else recent.append(empty(ctx.sample ? 'No sample conversations.' : 'No conversations yet.', ''));
    page.append(recent);

    hydrate(ctx);
    return page;
  }

  /** One row for the phone's Settings screen. */
  function settingsRow(rerender) {
    const wrap = document.createDocumentFragment();
    const label = node('label', 'ph-setting');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = prefs().enabled;
    box.addEventListener('change', () => { setPref('enabled', box.checked); rerender(); });
    label.append(box, node('span', '', 'Show the Home tab (greeting, missions, recent work)'));
    wrap.append(node('h2', '', 'Home'), label);
    return wrap;
  }

  root.IntelioPhoneHome = Feed && Missions ? { view, settingsRow, enabled: () => prefs().enabled, prefs } : null;
})(window);
