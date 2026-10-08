/** Main-window Remote Hermes: profile orbs, sessions, and streaming chat. */
(function intelioRemote(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.IntelioRemote = api;
})(typeof window !== 'undefined' ? window : globalThis, function intelioRemoteFactory(root) {
  const SIGNATURES = {
    intelio: 'connecting',
    prc: 'solving',
    alignment: 'searching',
    hhp: 'weaving',
    'kid-a': 'composing',
    'kid a': 'composing',
    kida: 'composing',
  };
  const OPEN_TYPES = ['working', 'listening', 'breathing', 'shaping'];
  const ACCENTS = {
    intelio: '#7a5cff',
    prc: '#059669',
    alignment: '#1d4ed8',
    hhp: '#0f766e',
    'kid-a': '#e879f9',
    'kid a': '#e879f9',
    kida: '#e879f9',
  };

  function signatureOf(id) {
    const key = String(id || 'intelio').trim().toLowerCase();
    if (SIGNATURES[key]) return SIGNATURES[key];
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return OPEN_TYPES[(hash >>> 0) % OPEN_TYPES.length];
  }

  function accentOf(id) {
    const key = String(id || 'intelio').trim().toLowerCase();
    if (ACCENTS[key]) return ACCENTS[key];
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return `hsl(${(hash >>> 0) % 360} 78% 52%)`;
  }

  function switcherRows(agents, { query = '', selected = '' } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    return (agents || []).filter((agent) => {
      if (!needle) return true;
      return `${agent.name || ''} ${agent.id || ''} ${agent.orb || ''}`.toLowerCase().includes(needle);
    }).map((agent) => {
      const orb = agent.orb || signatureOf(agent.id);
      return { id: agent.id, name: shownAgent(agent.id, agent.name), orb, color: agent.color || '', title: roleOf(agent), needsSignIn: Boolean(agent.needsSignIn), gatewayNote: agent.gatewayNote || '', subtitle: orb, selected: agent.id === selected };
    });
  }

  const SAMPLE = {
    label: 'SAMPLE DATA',
    agents: [
      { id: 'intelio', name: 'intelio', orb: 'connecting' },
      { id: 'prc', name: 'PRC', orb: 'solving' },
      { id: 'alignment', name: 'Alignment', orb: 'searching' },
      { id: 'hhp', name: 'HHP', orb: 'weaving' },
    ],
    sessions: [
      { id: 'sample-photon', profileId: 'intelio', source: 'photon', sourceLabel: 'photon/iMessage', title: 'Friday notes', preview: 'SAMPLE DATA · Need your yes on the Friday all-hands deck.', updated_at: '2026-10-06T16:00:00Z' },
      { id: 'sample-telegram', profileId: 'prc', source: 'telegram', sourceLabel: 'Telegram', title: 'Outreach', preview: 'SAMPLE DATA · 8 intros drafted — sitting in the CRM.', updated_at: '2026-10-06T18:00:00Z' },
      { id: 'sample-api', profileId: 'alignment', source: 'api_server', sourceLabel: 'API', title: 'Website launch', preview: 'SAMPLE DATA · Checkout is clean on staging.', updated_at: '2026-10-06T17:00:00Z' },
      { id: 'sample-once', profileId: 'hhp', source: 'oneshot', sourceLabel: 'One-shot', title: 'Acme check-in', preview: 'SAMPLE DATA · Drafted a Thursday check-in.', updated_at: '2026-10-06T15:00:00Z' },
    ],
    messages: {
      'sample-photon': [
        { role: 'user', content: 'Pull the Friday notes from iMessage.' },
        { role: 'assistant', content: 'SAMPLE DATA · Three takeaways. The API migration is on track, Dana has the security review, and staging moved to Thursday.' },
      ],
      'sample-telegram': [
        { role: 'user', content: 'Where are the intros?' },
        { role: 'assistant', content: 'SAMPLE DATA · 8 intros drafted — sitting in the CRM till you review.' },
      ],
      'sample-api': [
        { role: 'user', content: 'Is checkout ready?' },
        { role: 'assistant', content: 'SAMPLE DATA · Checkout is clean on staging. Three bugs left.' },
      ],
      'sample-once': [
        { role: 'user', content: 'Draft the Acme check-in.' },
        { role: 'assistant', content: 'SAMPLE DATA · Thursday check-in is ready. Acme is wobbling; I kept the note short.' },
      ],
    },
  };

  const ui = {
    agents: [],
    screens: [],
    sessions: [],
    messages: [],
    selected: '',
    sessionId: '',
    query: '',
    sidebar: 'agents',
    tabChosen: false,
    allSessions: [],
    sessionQuery: '',
    sessionAgent: '',
    stamp: '',
    sample: false,
    label: '',
    busy: false,
    readFor: '',
    readAt: 0,
    wired: false,
    streaming: null,
    bops: null,
    bopsToken: 0,
    frames: [],
    lastEffect: null,
    call: null,
    callTimer: null,
    mic: null,
  };

  function bopsApi() {
    if (root.IntelioBops) return root.IntelioBops;
    if (typeof require === 'function') {
      root.IntelioBops = require('./intelio/bops.cjs');
      return root.IntelioBops;
    }
    return null;
  }
  function $(id) { return root.document ? root.document.getElementById(id) : null; }
  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n');
    return content == null ? '' : JSON.stringify(content);
  }
  function sessionAt(session) {
    const raw = session?.updated_at || session?.updatedAt || session?.created_at || session?.createdAt || session?.started_at || session?.startedAt || '';
    const time = Date.parse(raw);
    if (Number.isFinite(time)) return time;
    return Number(session?.at) || 0;
  }
  function sessionWhen(session) {
    if (session?.timeLabel) return session.timeLabel;
    const at = sessionAt(session);
    return at ? new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  }
  function setStatus(text) { const node = $('remote-status'); if (node) node.textContent = text || ''; }
  function showProfileError(text) {
    const host = $('intelio-profile');
    if (host && text) host.textContent = text;
  }
  const HARNESS = [
    { id: 'intelio', name: 'intelio' },
    { id: 'prc', name: 'PRC' },
    { id: 'alignment', name: 'Alignment' },
    { id: 'hhp', name: 'HHP' },
  ];

  function remoteConfigured(remote) {
    if (!remote || typeof remote !== 'object') return false;
    if (remote.enabled && remote.host) return true;
    if (Array.isArray(remote.profilesWithKeys) && remote.profilesWithKeys.length > 0) return true;
    if (remote.activeMode === 'cloud' || remote.activeMode === 'tailscale') return true;
    return false;
  }

  function excludedAgent(id) {
    const slug = String(id || '').trim().toLowerCase();
    const compact = slug.replace(/[\s_]+/g, '-');
    if (!slug || slug === 'default') return true;
    if (slug === 'kid-a' || slug === 'kida' || slug === 'kid a' || compact === 'kid-a' || compact.startsWith('kid-a-')) return true;
    if (slug.includes('alignment-bot-vps') || compact.includes('alignment-bot-vps')) return true;
    return false;
  }

  /** Remote mode owns the Agents list. Kid A and Alignment-Bot-VPS stay off it. */
  function chooseSidebar({ remote, localBots = [], remoteAgents = [] } = {}) {
    if (!remoteConfigured(remote)) return { source: 'local', agents: localBots.slice() };
    const live = (remoteAgents || []).filter((agent) => agent?.id && !excludedAgent(agent.id));
    if (!live.length) {
      return {
        source: 'remote',
        agents: HARNESS.map((agent) => ({ ...agent, orb: signatureOf(agent.id), name: shownAgent(agent.id, agent.name) })),
      };
    }
    const namedIds = new Set(HARNESS.map((agent) => agent.id));
    const named = HARNESS.filter((agent) => live.some((row) => row.id === agent.id)).map((agent) => {
      const row = live.find((item) => item.id === agent.id) || agent;
      return { ...row, id: agent.id, name: shownAgent(agent.id, row.name), orb: row.orb || signatureOf(agent.id) };
    });
    const rest = live.filter((agent) => !namedIds.has(agent.id)).map((agent) => ({
      ...agent,
      name: shownAgent(agent.id, agent.name),
      orb: agent.orb || signatureOf(agent.id),
    }));
    return { source: 'remote', agents: [...named, ...rest] };
  }

  function seedAgents(names, profile) {
    const stored = [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
    const named = [
      { id: 'intelio', name: 'intelio' },
      { id: 'prc', name: 'PRC' },
      { id: 'alignment', name: 'Alignment' },
      { id: 'hhp', name: 'HHP' },
    ].filter((agent) => stored.includes(agent.id)).map((agent) => ({ ...agent, orb: signatureOf(agent.id) }));
    if (named.length) return named;
    const fallback = String(profile || 'intelio').trim().toLowerCase() || 'intelio';
    const known = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
    return [{ id: fallback, name: known[fallback] || (fallback === 'intelio' ? 'intelio' : fallback.slice(0, 1).toUpperCase() + fallback.slice(1)), orb: signatureOf(fallback) }];
  }
  function selectedAgent() { return ui.agents.find((agent) => agent.id === ui.selected) || null; }

  function mountOrb(canvas, id, orb, px, paused, accent) {
    canvas.width = px;
    canvas.height = px;
    canvas.className = 'orb';
    canvas.dataset.profile = id;
    canvas.dataset.orb = orb || signatureOf(id);
    canvas.dataset.accent = accent || accentOf(id);
    if (root.ThinkingOrbs) {
      root.ThinkingOrbs.mount(canvas, { state: orb, display: px, size: 64, paused, speed: paused ? 1 : 0.42, accent: accent || accentOf(id) });
    }
  }

  /**
   * The server's display name wins. The built-in names only stand in when the
   * server sent no name or just echoed the profile slug (e.g. "prc").
   */
  function shownAgent(id, name) {
    const key = String(id || '').trim().toLowerCase();
    const raw = String(name || '').trim();
    if (raw.toLowerCase() === 'intelio') return 'intelio';
    if (raw && raw.toLowerCase() !== key) return raw;
    const known = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
    if (known[key]) return known[key];
    return raw || 'Agent';
  }

  function workCount() {
    const tasks = (ui.bops?.tasks || []).filter((task) => task.status === 'running').length;
    const steps = (ui.liveSteps || []).filter((step) => step.running).length;
    if (tasks > 1) return tasks;
    if (steps) return steps;
    if (ui.busy || tasks === 1) return Math.max(tasks, 1);
    return 0;
  }

  function paintHeader() {
    const agent = selectedAgent();
    const title = $('chat-title');
    if (title) title.textContent = agent ? shownAgent(agent.id, agent.name) : 'VPS Hermes';
    const role = $('chat-role');
    if (role) role.textContent = roleOf(agent);
    const status = $('chat-status');
    if (status) {
      const count = workCount();
      status.textContent = count ? `Working on ${count} ${count === 1 ? 'thing' : 'things'}` : '';
      status.classList.toggle('hidden', !count);
    }
    root.renderIntelioTabs?.();
    const avatar = $('chat-avatar');
    if (avatar && agent) {
      avatar.replaceChildren();
      const canvas = el('canvas');
      mountOrb(canvas, agent.id, agent.orb || signatureOf(agent.id), 28, false, agent.color);
      avatar.append(canvas);
      avatar.title = shownAgent(agent.id, agent.name);
      avatar.setAttribute('aria-label', `Open ${shownAgent(agent.id, agent.name)} details`);
      avatar.onclick = (event) => {
        event.stopPropagation();
        root.openAgentDetails?.(agent.id);
      };
    }
    const pill = $('chat-pill');
    if (pill && agent) {
      pill.onclick = (event) => {
        if (event.target.closest('#bots-toggle')) return;
        root.openAgentDetails?.(agent.id);
      };
      pill.setAttribute('role', 'button');
      pill.tabIndex = 0;
      pill.setAttribute('aria-label', `Open ${shownAgent(agent.id, agent.name)} details`);
    }
  }

  function cleanLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function personaLine(text) {
    const value = cleanLine(text);
    if (!value) return false;
    return /^in one short sentence\b/i.test(value) || /\bwho are you\b/i.test(value);
  }

  function roleOf(agent) {
    const title = cleanLine(agent?.title);
    if (title && !personaLine(title)) return title.slice(0, 48);
    const description = cleanLine(agent?.description);
    if (description && !personaLine(description) && description.length <= 40 && !description.includes('?')) return description.slice(0, 48);
    return '';
  }

  function statusLine(id) {
    const pool = ui.allSessions.length ? ui.allSessions : (ui.selected === id ? ui.sessions : []);
    const latest = pool.filter((session) => !session.profileId || session.profileId === id).slice().sort((a, b) => sessionAt(b) - sessionAt(a))[0];
    const raw = latest?.last_message || latest?.preview || '';
    const shown = root.IntelioTranscript ? root.IntelioTranscript.preview(raw) : raw;
    const value = cleanLine(shown || raw);
    if (!value || personaLine(value)) return '';
    return value.slice(0, 140);
  }

  function paintLead(rows) {
    const card = $('lead-card');
    if (!card) return;
    const lead = rows.find((row) => row.selected) || rows[0];
    if (!lead || ui.sidebar !== 'agents') {
      card.classList.add('hidden');
      card.replaceChildren();
      return;
    }
    card.classList.remove('hidden');
    card.replaceChildren();
    const orb = el('span', 'lead-orb');
    const canvas = el('canvas');
    mountOrb(canvas, lead.id, lead.orb, 72, true, lead.color);
    const badge = el('span', 'lead-badge');
    orb.append(canvas, badge);
    const count = workCount();
    card.append(orb, el('strong', 'lead-name', lead.name), el('span', 'lead-status', count ? `Working on ${count} ${count === 1 ? 'thing' : 'things'}` : 'Online'));
    card.onclick = () => root.openAgentDetails?.(lead.id);
  }

  function paintWatching() {
    const wrap = $('sidebar-watching-wrap');
    const host = $('sidebar-watching');
    if (!wrap || !host) return;
    const rows = (ui.screens || []).filter((row) => row && row.host);
    host.replaceChildren();
    wrap.classList.toggle('hidden', ui.sidebar !== 'agents' || !rows.length);
    for (const row of rows) {
      const button = el('button', 'watch-row');
      button.type = 'button';
      const same = rows.filter((item) => item.profileId === row.profileId).length;
      const extra = same > 1 ? ` ${row.screen}` : '';
      const name = shownAgent(row.profileId, row.name);
      button.append(el('span', 'watch-eye', '◉'), el('strong', '', row.host), el('span', '', ` · ${name}'s screen${extra}`));
      button.onclick = () => {
        ui.selected = row.profileId;
        root.openAgentComputer?.(row.profileId);
        if (!root.openAgentComputer) root.openAgentDetails?.(row.profileId);
      };
      host.append(button);
    }
  }

  function paintAgents() {
    const list = $('bot-list');
    if (!list) return;
    const rows = switcherRows(ui.agents, { query: ui.query, selected: ui.selected });
    paintLead(rows);
    paintWatching();
    list.replaceChildren();
    for (const row of rows.filter((item) => !item.selected)) {
      const node = el('div', `bot-row${row.selected ? ' selected' : ''}`);
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.dataset.botId = row.id;
      node.setAttribute('aria-label', `Open ${row.name}`);
      const avatar = el('span', 'avatar');
      const canvas = el('canvas');
      mountOrb(canvas, row.id, row.orb, 36, true, row.color);
      avatar.append(canvas);
      avatar.title = `Open ${row.name} details`;
      avatar.onclick = (event) => {
        event.stopPropagation();
        root.openAgentDetails?.(row.id);
      };
      const copy = el('span', 'bot-copy');
      const line = el('span', 'bot-line');
      line.append(el('span', 'bot-name', row.name));
      if (row.title) line.append(el('span', 'bot-role', row.title));
      copy.append(line);
      const preview = row.needsSignIn ? 'Needs sign-in' : statusLine(row.id);
      if (preview) copy.append(el('div', 'bot-preview', preview));
      node.append(avatar, copy);
      node.onclick = () => selectAgent(row.id);
      node.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAgent(row.id); } };
      list.append(node);
    }
    const count = $('bot-count');
    if (count) count.textContent = String(rows.length);
    const empty = $('empty-bots');
    if (empty) {
      empty.classList.toggle('hidden', ui.sidebar !== 'agents' || rows.length > 0);
      const heading = empty.querySelector('h3');
      const note = empty.querySelector('p');
      if (heading) heading.textContent = 'Agents on the VPS';
      if (note) note.textContent = rows.length ? 'No agents match that search.' : (ui.keyless ? 'No API keys saved for the VPS.' : 'Loading agents from Hermes…');
    }
    paintHeader();
  }

  function fillSessionList(list, mine) {
    if (!list) return;
    list.replaceChildren();
    for (const session of mine) {
      const item = el('li', `session-item${session.id === ui.sessionId ? ' active' : ''}`);
      item.append(el('div', 'session-title', session.title || session.id));
      if (session.preview) {
        const shown = root.IntelioTranscript ? root.IntelioTranscript.preview(session.preview) : session.preview;
        if (shown) item.append(el('div', 'session-preview', shown));
      }
      item.onclick = () => openSession(session.id);
      list.append(item);
    }
    if (!mine.length) list.append(el('li', 'session-empty', 'No sessions yet.'));
  }

  function paintSessions() {
    const mine = ui.sessions.filter((session) => !session.profileId || session.profileId === ui.selected);
    fillSessionList($('remote-sessions'), mine);
    fillSidebarThreads($('sidebar-threads'), mine);
  }

  function fillSidebarThreads(list, mine) {
    if (!list) return;
    list.replaceChildren();
    for (const session of mine) {
      const item = el('li', `thread-line${session.id === ui.sessionId ? ' active' : ''}`);
      item.append(el('span', 'thread-title', session.title || 'Untitled'));
      if ((ui.busy && session.id === ui.sessionId) || session.unread) item.append(el('span', 'thread-dot'));
      item.onclick = () => openSession(session.id);
      list.append(item);
    }
    if (!mine.length) list.append(el('li', 'session-empty', 'No sessions yet.'));
  }

  function paintLiveTools() {
    if (!ui.liveTools || !root.IntelioTranscript) return;
    const items = (ui.liveSteps || []).map((step) => ({
      kind: 'chip',
      label: root.IntelioTranscript.labelFor({
        name: step.name,
        detail: step.detail || '',
        running: step.running,
        failed: step.failed,
      }),
      detail: step.detail || '',
      running: Boolean(step.running),
      failed: Boolean(step.failed),
    }));
    ui.liveTools.replaceChildren(...items.map((item) => chipNode(item)));
    paintHeader();
  }

  function chipNode(item) {
    const wrap = el('div', 'tool-run');
    const button = el('button', `tool-chip${item.running ? ' running' : ''}${item.failed ? ' failed' : ''}`);
    button.type = 'button';
    button.append(el('span', 'mark', item.running ? '' : (item.failed ? '!' : '✓')));
    button.append(root.document.createTextNode(` ${item.label}`));
    if (item.detail) {
      button.setAttribute('aria-expanded', 'false');
      const detail = el('pre', 'tool-detail', item.detail);
      button.onclick = () => {
        const open = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', open ? 'false' : 'true');
      };
      wrap.append(button, detail);
    } else wrap.append(button);
    return wrap;
  }
  function readReceipt() {
    if (!ui.readAt) return null;
    const text = root.IntelioTranscript?.readText
      ? root.IntelioTranscript.readText(ui.readAt)
      : `Read ${new Date(ui.readAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return text ? el('div', 'read-receipt', text) : null;
  }

  function paintMessages() {
    const pane = $('remote-messages');
    if (!pane) return;
    pane.replaceChildren();
    const items = root.IntelioTranscript ? root.IntelioTranscript.present(ui.messages) : ui.messages.map((message) => ({ kind: 'bubble', role: message.role === 'user' ? 'user' : 'assistant', text: textOf(message.content) }));
    let pendingUser = '';
    const flushRead = () => {
      if (pendingUser && ui.readFor && pendingUser === ui.readFor) {
        const receipt = readReceipt();
        if (receipt) pane.append(receipt);
      }
      pendingUser = '';
    };
    for (const item of items) {
      if (item.kind === 'bubble' && item.role === 'user' && item.text) {
        flushRead();
        pane.append(el('div', 'msg user', item.text));
        pendingUser = item.text;
        continue;
      }
      flushRead();
      if (item.kind === 'read' && item.text) pane.append(el('div', 'read-receipt', item.text));
      else if (item.kind === 'chip') pane.append(chipNode(item));
      else if (item.kind === 'bubble' && item.text) pane.append(el('div', `msg ${item.role === 'user' ? 'user' : 'assistant'}`, item.text));
    }
    flushRead();
    pane.scrollTop = pane.scrollHeight;
    const raf = root.requestAnimationFrame;
    if (typeof raf === 'function') raf(() => { pane.scrollTop = pane.scrollHeight; });
    paintBops();
  }

  function focusedCaption() {
    const id = ui.bops?.focusedId || '';
    const rows = ui.frames.filter((frame) => frame.taskId === id);
    return rows.length ? rows[rows.length - 1].caption : '';
  }

  function paintBops() {
    const api = bopsApi();
    const bar = $('bops-bar');
    if (!api || !bar) return;
    const view = ui.bops ? api.viewModel(ui.bops, focusedCaption()) : null;
    const show = Boolean(view && (view.handoff || view.signIn || (view.statusLines || []).length));
    bar.classList.toggle('hidden', !show);
    const header = $('bops-header');
    if (header) header.textContent = '';
    const stop = $('bops-stop');
    if (stop) {
      stop.classList.add('hidden');
      stop.onclick = () => stopBops();
    }
    const pills = $('bops-pills');
    if (pills) pills.replaceChildren();
    paintHeader();
    const handoff = $('bops-handoff');
    if (handoff) {
      handoff.classList.toggle('hidden', !view?.handoff);
      handoff.textContent = view?.handoff?.label || '';
    }
    const lines = $('bops-status');
    if (lines) {
      lines.replaceChildren();
      for (const line of view?.statusLines || []) lines.append(el('p', 'bops-status-line', line.text));
    }
    const card = $('bops-signin');
    if (card) {
      card.replaceChildren();
      card.classList.toggle('hidden', !view?.signIn);
      if (view?.signIn) paintSignIn(card, view.signIn);
    }
    const preview = view?.preview;
    const badge = $('preview-badge');
    if (badge) {
      badge.classList.toggle('hidden', !view);
      badge.textContent = view ? preview.badge : '';
    }
    const chrome = $('preview-chrome');
    if (chrome && preview && view) {
      chrome.dataset.highlight = preview.highlight;
      chrome.style.boxShadow = `inset 0 0 0 2px ${preview.highlight}`;
    }
    const screen = $('preview-screen');
    if (screen) screen.dataset.taskId = view ? (preview.taskId || '') : '';
    const live = $('preview-live');
    if (live) live.textContent = view ? (preview.caption || '') : '';
  }

  function focusBops(id) {
    const api = bopsApi();
    if (!api || !ui.bops) return;
    ui.bops = api.focusTask(ui.bops, id);
    paintBops();
  }

  function stopBops() {
    const api = bopsApi();
    if (!api || !ui.bops) return;
    ui.bopsToken += 1;
    ui.bops = api.stopAll(ui.bops);
    paintBops();
  }

  function fieldValues(node, into = {}) {
    if (node?.dataset?.field) {
      if (node.dataset.field === 'save') into.save = node.checked === true;
      else into[node.dataset.field] = node.value || '';
      if (node.type === 'password') node.value = '';
    }
    for (const child of node?.children || []) fieldValues(child, into);
    return into;
  }

  function paintSignIn(card, signIn) {
    const head = el('div', 'signin-head');
    head.append(el('span', 'signin-mark', (signIn.domain || 'S').slice(0, 1).toUpperCase()));
    head.append(el('strong', 'signin-domain', signIn.title));
    card.append(head);
    const form = el('form', 'signin-form');
    for (const field of signIn.fields) {
      const label = el('label', 'signin-label', field.label);
      const input = el('input');
      input.type = field.type;
      input.autocomplete = field.autocomplete || 'off';
      input.dataset.field = field.id;
      input.setAttribute('aria-label', field.label);
      label.append(input);
      form.append(label);
    }
    const save = el('label', 'signin-save', signIn.saveLabel);
    const box = el('input');
    box.type = 'checkbox';
    box.dataset.field = 'save';
    save.append(box);
    form.append(save);
    const actions = el('div', 'bops-actions');
    for (const action of signIn.actions) {
      const button = el('button', 'bops-action', action.label);
      button.type = action.id === 'submit' ? 'submit' : 'button';
      button.dataset.action = action.id;
      if (action.id === 'on-screen') button.onclick = (event) => { event?.preventDefault?.(); onScreen(signIn.taskId); };
      actions.append(button);
    }
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event?.preventDefault?.();
      const values = fieldValues(form);
      submitSignIn(signIn.taskId, values);
    });
    card.append(form);
  }

  function deliverFill(effect) {
    const payload = {
      profile: ui.bops?.profile || '',
      domain: effect.domain || '',
      username: effect.username || '',
      password: effect.password || '',
      otp: effect.otp || '',
      save: effect.save === true,
      selectors: effect.selectors || null,
      taskId: effect.taskId || '',
    };
    const send = root.workspace?.command
      ? root.workspace.command('fill-login', payload)
      : root.remoteHermes?.request?.('fill-login', payload);
    return Promise.resolve(send).catch(() => {});
  }

  function submitSignIn(taskId, values) {
    const api = bopsApi();
    if (!api || !ui.bops) return null;
    const result = api.submitSignIn(ui.bops, taskId, values);
    ui.bops = result.run;
    ui.lastEffect = api.publicEffect(result.effect);
    if (result.effect?.type === 'secure-signin') deliverFill(result.effect);
    paintBops();
    return ui.lastEffect;
  }

  function onScreen(taskId) {
    const api = bopsApi();
    if (!api || !ui.bops) return null;
    const result = api.doOnScreen(ui.bops, taskId);
    ui.bops = result.run;
    ui.lastEffect = api.publicEffect(result.effect);
    paintBops();
    return ui.lastEffect;
  }

  function actBops(action, taskId, values) {
    if (action === 'submit') return submitSignIn(taskId, values || {});
    if (action === 'on-screen') return onScreen(taskId);
    return null;
  }

  function callsApi() {
    if (root.IntelioCalls) return root.IntelioCalls;
    if (typeof require === 'function') {
      root.IntelioCalls = require('./intelio/calls.cjs');
      return root.IntelioCalls;
    }
    return null;
  }

  function paintCall() {
    const api = callsApi();
    const pill = $('call-pill');
    const button = $('remote-voice');
    if (!api || !pill) return;
    const text = api.callPill(ui.call);
    pill.classList.toggle('hidden', !text);
    pill.textContent = text;
    if (button) {
      button.setAttribute('aria-pressed', String(Boolean(ui.call?.active)));
      button.title = ui.call?.active ? 'End voice conversation' : 'Voice conversation';
      button.setAttribute('aria-label', button.title);
    }
  }

  function showInline(id, text) {
    const note = $(id);
    if (!note) return;
    note.textContent = text || '';
    note.classList.toggle('hidden', !text);
  }

  function voiceApi() {
    if (root.IntelioDesktopVoice) return root.IntelioDesktopVoice;
    if (typeof require === 'function') {
      try { root.IntelioDesktopVoice = require('./intelio/desktop-voice.cjs'); return root.IntelioDesktopVoice; } catch { /* the page script already published it */ }
    }
    return { NOT_READY: "Voice isn't set up on the server yet", LISTENING: 'Listening…', voiceReady: () => false, appendDictation: (current, text) => text || current, splitSentences: () => ({ sentences: [], rest: '' }) };
  }

  function paintMic() {
    const button = $('remote-mic');
    if (!button) return;
    const on = Boolean(ui.dictating);
    button.classList.toggle('recording', on);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Stop dictation' : 'Dictate';
    button.setAttribute('aria-label', button.title);
  }

  function micMessage(error) {
    const name = error?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow the microphone for intelio, then try again.';
    if (name === 'NotFoundError') return 'This computer has no microphone.';
    return error?.message || 'The microphone did not start.';
  }

  async function voiceStatus() {
    const status = await root.remoteHermes?.request?.('voice-status', { profile: ui.selected || 'intelio' });
    ui.voiceStatus = status || null;
    return status;
  }

  async function ensureVoice() {
    try {
      const status = await voiceStatus();
      if (voiceApi().voiceReady(status)) return true;
    } catch { /* the note below covers a missing worker and a missing route */ }
    showInline('composer-note', voiceApi().NOT_READY);
    return false;
  }

  function audioContext() {
    if (ui.audio) return Promise.resolve(ui.audio);
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return Promise.reject(Object.assign(new Error('This window cannot play audio.'), { name: 'NotSupportedError' }));
    ui.audio = new Ctx();
    const ready = ui.audio.state === 'suspended' && ui.audio.resume ? ui.audio.resume() : Promise.resolve();
    return Promise.resolve(ready).then(() => ui.audio);
  }

  async function openMic() {
    if (ui.mic?.stream) return ui.mic;
    const media = root.navigator?.mediaDevices;
    if (!media?.getUserMedia) throw Object.assign(new Error('The microphone is not available in this window.'), { name: 'NotSupportedError' });
    const stream = await media.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
    const ctx = await audioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    ui.mic = { stream, analyser, chunks: [], recorder: null, speaking: false, quietSince: 0 };
    return ui.mic;
  }

  function releaseMic() {
    if (ui.vad) root.cancelAnimationFrame?.(ui.vad);
    ui.vad = 0;
    const mic = ui.mic;
    ui.mic = null;
    if (!mic) return;
    try { if (mic.recorder && mic.recorder.state !== 'inactive') mic.recorder.stop(); } catch { /* already stopped */ }
    for (const track of mic.stream?.getTracks?.() || []) track.stop();
  }

  function recorderMime() {
    const Rec = root.MediaRecorder;
    if (!Rec) return '';
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => Rec.isTypeSupported?.(type)) || '';
  }

  function startRecorder() {
    const Rec = root.MediaRecorder;
    if (!ui.mic || !Rec) throw Object.assign(new Error('The microphone is not available in this window.'), { name: 'NotSupportedError' });
    const mime = recorderMime();
    ui.mic.chunks = [];
    ui.mic.recorder = mime ? new Rec(ui.mic.stream, { mimeType: mime }) : new Rec(ui.mic.stream);
    ui.mic.recorder.ondataavailable = (event) => { if (event.data && event.data.size) ui.mic.chunks.push(event.data); };
    ui.mic.recorder.start();
  }

  function stopRecorder() {
    const mic = ui.mic;
    if (!mic?.recorder || mic.recorder.state === 'inactive') return Promise.resolve(null);
    const recorder = mic.recorder;
    return new Promise((resolve) => {
      recorder.onstop = () => resolve(new root.Blob(mic.chunks || [], { type: recorder.mimeType || 'audio/webm' }));
      try { recorder.stop(); } catch { resolve(null); }
    });
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return root.btoa(binary);
  }

  async function transcribeBlob(blob) {
    const audio = await blobToBase64(blob);
    const result = await root.remoteHermes.request('voice-transcribe', {
      profile: ui.selected || 'intelio',
      audio,
      type: blob.type || 'audio/webm',
    });
    return String(result?.text || '').trim();
  }

  function bargeIn() {
    ui.ttsToken = (ui.ttsToken || 0) + 1;
    ui.speakQueue = [];
    ui.unspoken = '';
    for (const source of ui.sources || []) { try { source.stop(); } catch { /* already ended */ } }
    ui.sources = [];
  }

  function feedSpeech(delta) {
    const api = voiceApi();
    ui.unspoken = `${ui.unspoken || ''}${delta}`;
    const parts = api.splitSentences(ui.unspoken);
    ui.unspoken = parts.rest;
    ui.speakQueue = ui.speakQueue || [];
    for (const sentence of parts.sentences) ui.speakQueue.push(sentence);
    pumpSpeech();
  }

  async function playSpoken(payload, token) {
    if (!payload?.audio || token !== ui.ttsToken) return;
    const binary = root.atob(payload.audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ctx = await audioContext();
    if (token !== ui.ttsToken) return;
    const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    if (token !== ui.ttsToken) return;
    await new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      ui.sources = ui.sources || [];
      ui.sources.push(source);
      source.onended = () => { ui.sources = (ui.sources || []).filter((item) => item !== source); resolve(); };
      source.start();
    });
  }

  async function pumpSpeech() {
    if (ui.pumping) return;
    ui.pumping = true;
    const token = ui.ttsToken || 0;
    try {
      while ((ui.speakQueue || []).length && token === ui.ttsToken && ui.call?.active && ui.call.speaker !== false) {
        const sentence = ui.speakQueue.shift();
        try {
          const spoken = await root.remoteHermes.request('voice-speak', { profile: ui.selected || 'intelio', text: sentence });
          await playSpoken(spoken, token);
        } catch (error) {
          if (error?.code === 'VOICE_OFF') showInline('composer-note', voiceApi().NOT_READY);
        }
      }
    } finally {
      ui.pumping = false;
    }
  }

  function rms(bytes) {
    if (!bytes || !bytes.length) return 0;
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = (bytes[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / bytes.length);
  }

  function vadLoop() {
    const mic = ui.mic;
    if (!mic || !ui.call?.active) return;
    const data = new Uint8Array(mic.analyser.fftSize);
    mic.analyser.getByteTimeDomainData(data);
    const level = rms(data);
    const now = root.performance?.now?.() || Date.now();
    if (level >= 0.045) {
      if (!mic.speaking) {
        mic.speaking = true;
        bargeIn();
        try { startRecorder(); } catch { /* the next quiet stretch retries */ }
        showInline('composer-note', voiceApi().LISTENING);
      }
      mic.quietSince = 0;
    } else if (mic.speaking && level < 0.03) {
      if (!mic.quietSince) mic.quietSince = now;
      if (now - mic.quietSince > 700) {
        mic.speaking = false;
        mic.quietSince = 0;
        showInline('composer-note', '');
        const pending = stopRecorder();
        pending.then((blob) => blob && transcribeBlob(blob).then((text) => {
          if (text && ui.call?.active) {
            const input = $('remote-input');
            if (input) input.value = text;
            send({ preventDefault() {} });
          }
        })).catch((error) => {
          showInline('composer-note', error?.code === 'VOICE_OFF' ? voiceApi().NOT_READY : (error?.message || voiceApi().NOT_READY));
        });
      }
    }
    ui.vad = root.requestAnimationFrame?.(() => vadLoop()) || 0;
  }

  async function dictate() {
    const input = $('remote-input');
    if (!input || ui.call?.active) return;
    if (ui.dictating) {
      ui.dictating = false;
      paintMic();
      const blob = await stopRecorder();
      releaseMic();
      showInline('composer-note', '');
      if (!blob) return;
      try {
        const text = await transcribeBlob(blob);
        if (text) {
          input.value = voiceApi().appendDictation(input.value, text);
          input.focus();
        }
      } catch (error) {
        showInline('composer-note', error?.code === 'VOICE_OFF' ? voiceApi().NOT_READY : (error?.message || voiceApi().NOT_READY));
      }
      return;
    }
    if (!(await ensureVoice())) return;
    try {
      await openMic();
      startRecorder();
      ui.dictating = true;
      paintMic();
      showInline('composer-note', voiceApi().LISTENING);
    } catch (error) {
      ui.dictating = false;
      paintMic();
      releaseMic();
      showInline('composer-note', micMessage(error));
    }
  }

  async function callPhone() {
    const api = root.remoteHermes;
    let ready = false;
    try {
      const result = await api?.request?.('phone-call', { profile: ui.selected || 'intelio' });
      ready = result?.ready === true;
    } catch { ready = false; }
    if (!ready) showInline('phone-note', 'Phone line not set up yet');
    else showInline('phone-note', '');
  }

  function applyLook(patch = {}) {
    const id = String(patch.id || '').trim().toLowerCase();
    if (!id) return;
    ui.agents = ui.agents.map((agent) => (agent.id === id ? {
      ...agent,
      color: patch.color != null ? patch.color : agent.color,
      orb: patch.orb || agent.orb,
      title: patch.title != null ? patch.title : agent.title,
      name: patch.name || agent.name,
    } : agent));
    paintAgents();
  }

  function stopMic() {
    ui.dictating = false;
    paintMic();
    bargeIn();
    releaseMic();
    if (ui.callTimer) clearInterval(ui.callTimer);
    ui.callTimer = null;
  }

  async function toggleCall() {
    const api = callsApi();
    if (!api) return;
    if (ui.call?.active) {
      ui.call = api.endCall(ui.call, Date.now());
      stopMic();
      showInline('composer-note', '');
      paintCall();
      return;
    }
    if (ui.dictating) {
      ui.dictating = false;
      paintMic();
      releaseMic();
    }
    if (!(await ensureVoice())) return;
    ui.call = api.startCall(Date.now());
    ui.spokenProse = '';
    ui.callTimer = setInterval(() => {
      if (!ui.call?.active) return;
      ui.call = api.tickCall(ui.call, Date.now());
      paintCall();
    }, 500);
    paintCall();
    try {
      await openMic();
      vadLoop();
    } catch (error) {
      ui.call = api.endCall(ui.call, Date.now());
      stopMic();
      paintCall();
      showInline('composer-note', micMessage(error));
    }
  }

  function pushFrame(frame) {
    ui.frames.push({ taskId: String(frame?.taskId || ui.bops?.focusedId || ''), caption: String(frame?.caption || '').slice(0, 160) });
    paintBops();
  }

  function presentBops(run) {
    ui.bops = run;
    paintBops();
  }

  function paintBanner() {
    const banner = $('remote-banner');
    if (!banner) return;
    const show = Boolean(ui.sample && ui.label);
    banner.classList.toggle('hidden', !show);
    banner.textContent = ui.label || '';
  }

  async function loadMessages(id) {
    if (ui.sample) {
      ui.messages = SAMPLE.messages[id] || [];
      paintMessages();
      return;
    }
    const api = root.remoteHermes;
    const result = await api.request('messages', { id, profile: ui.selected });
    ui.messages = result?.data || [];
    paintMessages();
  }

  function stopControl() {
    const button = el('button', 'stop-all', 'Stop all');
    button.type = 'button';
    button.onclick = () => stopBops();
    return button;
  }

  async function openSession(id) {
    ui.readFor = '';
    ui.readAt = 0;
    ui.sessionId = id;
    paintSessions();
    const input = $('remote-input');
    const send = $('remote-send');
    if (input) input.disabled = false;
    if (send) send.disabled = false;
    try { await loadMessages(id); } catch (error) { setStatus(error.message); showProfileError(error.message); }
    loadModelOptions().catch(() => {});
  }

  function sessionRows() {
    const needle = String(ui.sessionQuery || '').trim().toLowerCase();
    return ui.allSessions.filter((session) => {
      if (ui.sessionAgent && session.profileId !== ui.sessionAgent) return false;
      if (!needle) return true;
      const name = ui.agents.find((agent) => agent.id === session.profileId)?.name || session.profileId || '';
      return `${name} ${session.title || ''} ${session.preview || ''} ${session.sourceLabel || ''} ${session.source || ''}`.toLowerCase().includes(needle);
    }).slice().sort((a, b) => sessionAt(b) - sessionAt(a));
  }

  function paintAgentFilter() {
    const select = $('session-agent');
    if (!select) return;
    const current = ui.sessionAgent;
    select.replaceChildren();
    const all = el('option', '', 'All agents');
    all.value = '';
    select.append(all);
    for (const agent of ui.agents) {
      const option = el('option', '', shownAgent(agent.id, agent.name));
      option.value = agent.id;
      select.append(option);
    }
    const known = ui.agents.some((agent) => agent.id === current);
    select.value = known ? current : '';
    ui.sessionAgent = select.value || '';
  }

  function paintAllSessions() {
    const list = $('all-sessions');
    if (!list) return;
    paintAgentFilter();
    const rows = sessionRows();
    list.replaceChildren();
    for (const session of rows) {
      const agent = ui.agents.find((item) => item.id === session.profileId);
      const name = shownAgent(session.profileId, agent?.name);
      const item = el('li', `all-session${session.id === ui.sessionId && session.profileId === ui.selected ? ' active' : ''}`);
      item.dataset.profile = session.profileId || '';
      item.dataset.sessionId = session.id || '';
      const avatar = el('span', 'avatar');
      const canvas = el('canvas');
      mountOrb(canvas, session.profileId || name, agent?.orb || signatureOf(session.profileId), 28, true);
      avatar.append(canvas);
      const copy = el('span', 'all-session-copy');
      const top = el('span', 'all-session-top');
      top.append(el('span', 'agent-name', name));
      const when = sessionWhen(session);
      if (when) top.append(el('span', 'session-time', when));
      copy.append(top, el('div', 'session-title', session.title || session.id));
      if (session.preview) copy.append(el('div', 'session-preview', session.preview));
      item.append(avatar, copy);
      item.onclick = () => openListed(session);
      list.append(item);
    }
    if (!rows.length) list.append(el('li', 'session-empty', ui.allSessions.length ? 'No sessions match.' : 'No sessions yet.'));
  }

  function setSidebar(tab, { persist = true, remember = true } = {}) {
    ui.sidebar = tab === 'sessions' ? 'sessions' : 'agents';
    if (remember) ui.tabChosen = true;
    const agentsOn = ui.sidebar === 'agents';
    $('tab-agents')?.setAttribute('aria-selected', String(agentsOn));
    $('tab-sessions')?.setAttribute('aria-selected', String(!agentsOn));
    $('bot-list')?.classList.toggle('hidden', !agentsOn);
    $('agent-caption-actions')?.classList.toggle('hidden', !agentsOn);
    $('session-tools')?.classList.toggle('hidden', agentsOn);
    $('all-sessions')?.classList.toggle('hidden', agentsOn);
    if (!agentsOn) $('bot-search')?.classList.toggle('hidden', true);
    paintAgents();
    if (!agentsOn) paintAllSessions();
    if (persist && root.workspace?.command) root.workspace.command('settings', { sidebarTab: ui.sidebar }).catch(() => {});
  }

  async function loadAllSessions() {
    if (ui.sample) {
      ui.allSessions = SAMPLE.sessions.slice().sort((a, b) => sessionAt(b) - sessionAt(a));
      paintAllSessions();
      return;
    }
    if (!root.remoteHermes) return;
    try {
      const result = await root.remoteHermes.request('all-sessions', {});
      ui.allSessions = Array.isArray(result?.data) ? result.data.slice().sort((a, b) => sessionAt(b) - sessionAt(a)) : [];
      paintAllSessions();
      paintAgents();
    } catch (error) {
      if (ui.sidebar === 'sessions') setStatus(error.message);
    }
  }

  async function openListed(session) {
    if (!session?.id || !session.profileId) return;
    await selectAgent(session.profileId, { sessionId: session.id });
    paintAllSessions();
  }

  async function selectAgent(id, { sessionId = '' } = {}) {
    ui.selected = id;
    if (typeof root.onIntelioAgent === 'function') root.onIntelioAgent(id);
    ui.sessionId = '';
    ui.messages = [];
    paintAgents();
    paintMessages();
    const keys = ui.keys || [];
    if (!ui.sample && keys.length && !keys.includes(id)) {
      ui.sessions = [];
      paintSessions();
      setStatus(`No key saved for ${id}.`);
      showProfileError(`No key saved for ${id}.`);
      const input = $('remote-input');
      if (input) input.disabled = true;
      return;
    }
    setStatus('');
    if (ui.sample) {
      ui.sessions = SAMPLE.sessions.filter((session) => session.profileId === id);
      paintAgents();
      paintSessions();
      const sampleTarget = sessionId && ui.sessions.some((session) => session.id === sessionId) ? sessionId : ui.sessions[0]?.id;
      if (sampleTarget) await openSession(sampleTarget);
      return;
    }
    try {
      const result = await root.remoteHermes.request('sessions', { profile: id, limit: 100 });
      ui.sessions = Array.isArray(result?.data) ? result.data : [];
      paintAgents();
      paintSessions();
      const target = sessionId && ui.sessions.some((session) => session.id === sessionId) ? sessionId : ui.sessions[0]?.id;
      if (target) await openSession(target);
      else {
        setStatus('No sessions for this agent yet. Send a message to start one.');
        loadModelOptions().catch(() => {});
      }
    } catch (error) { setStatus(error.message); showProfileError(error.message); }
  }

  async function refresh() {
    if (ui.sample || !root.remoteHermes) return;
    try {
      const home = await root.remoteHermes.request('agents');
      const listed = home?.agents || [];
      ui.agents = chooseSidebar({ remote: { enabled: true, host: 'vps', profilesWithKeys: ui.keys }, remoteAgents: listed }).agents;
      ui.sample = Boolean(home?.sample);
      ui.label = home?.label || '';
      paintBanner();
      if (!ui.selected || !ui.agents.some((agent) => agent.id === ui.selected)) ui.selected = ui.agents[0]?.id || '';
      paintAgents();
      try {
        const screens = await root.remoteHermes.request('screens');
        ui.screens = Array.isArray(screens?.data) ? screens.data : [];
      } catch { ui.screens = []; }
      paintWatching();
      await Promise.all([
        ui.selected ? selectAgent(ui.selected) : null,
        loadAllSessions(),
      ]);
    } catch (error) { setStatus(error.message); showProfileError(error.message); }
  }

  function wire() {
    if (ui.wired || !root.document) return;
    ui.wired = true;
    const form = $('remote-composer');
    form?.addEventListener('submit', send);
    const voice = $('remote-voice');
    if (voice) voice.onclick = () => toggleCall();
    const mic = $('remote-mic');
    if (mic) mic.onclick = () => dictate();
    const model = $('remote-model');
    if (model) model.onclick = (event) => { event.preventDefault(); event.stopPropagation(); toggleModelMenu(); };
    root.document.addEventListener?.('pointerdown', (event) => {
      if (event.target.closest?.('#remote-model, #model-menu')) return;
      const menu = $('model-menu');
      if (menu && !menu.classList.contains('hidden')) closeModelMenu();
    });
    const headerCall = $('chat-call');
    if (headerCall) headerCall.onclick = () => callPhone();
    $('tab-agents')?.addEventListener('click', () => setSidebar('agents'));
    $('tab-sessions')?.addEventListener('click', () => setSidebar('sessions'));
    $('session-search')?.addEventListener('input', (event) => { ui.sessionQuery = event.target.value || ''; paintAllSessions(); });
    $('session-agent')?.addEventListener('change', (event) => { ui.sessionAgent = event.target.value || ''; paintAllSessions(); });
    $('remote-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
    });
    root.remoteHermes?.onEvent?.(({ sessionId, event, data }) => {
      const api = bopsApi();
      const signal = api?.signalFromEvent(event, data);
      if (signal && ui.bops && (sessionId === ui.sessionId || ui.bops.tasks.some((task) => task.sessionId === sessionId))) {
        const task = ui.bops.tasks.find((item) => item.sessionId === sessionId) || ui.bops.tasks.find((item) => item.id === ui.bops.focusedId);
        if (task) {
          ui.bops = api.applyTaskResult(ui.bops, task.id, signal);
          paintBops();
        }
      }
      if (sessionId !== ui.sessionId || !ui.streaming) return;
      if (event === 'assistant.delta' && typeof data?.delta === 'string') {
        ui.streamRaw = `${ui.streamRaw || ''}${data.delta}`;
        const peeled = root.IntelioTranscript ? root.IntelioTranscript.peel(ui.streamRaw) : { prose: ui.streamRaw, chips: [] };
        ui.streaming.textContent = peeled.prose;
        if (ui.call?.active) {
          const prose = peeled.prose || '';
          const spoken = prose.startsWith(ui.spokenProse || '') ? prose.slice((ui.spokenProse || '').length) : '';
          ui.spokenProse = prose;
          if (spoken) feedSpeech(spoken);
        }
        if (!ui.toolEvents) {
          ui.liveSteps = peeled.chips.map((part) => ({ name: part.name, detail: part.detail || '', running: false, failed: false }));
          paintLiveTools();
        }
      } else if (String(event).includes('tool')) {
        if (!ui.toolEvents) ui.liveSteps = [];
        ui.toolEvents = true;
        const name = data?.tool_name || data?.name || 'tool';
        const done = /complete|result|finished|fail/i.test(event);
        const failed = /fail/i.test(event);
        const detail = data?.summary || data?.error || '';
        if (done) {
          const open = [...ui.liveSteps].reverse().find((step) => step.running && step.name === name);
          if (open) { open.running = false; open.failed = failed; if (detail) open.detail = detail; }
          else ui.liveSteps.push({ name, detail, running: false, failed });
        } else ui.liveSteps.push({ name, detail, running: true, failed: false });
        paintLiveTools();
        setStatus(done ? '' : 'Checking…');
      }
      const pane = $('remote-messages');
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  async function runHandoff(handoff, token) {
    try {
      const created = await root.remoteHermes.request('create-session', { profile: handoff.profile, title: handoff.title });
      const id = created?.session?.id || created?.id || '';
      if (id) await root.remoteHermes.request('send', { id, profile: handoff.profile, input: handoff.input });
      if (ui.bops && ui.bopsToken === token && ui.bops.handoff) ui.bops.handoff.sessionId = id;
    } catch (error) {
      if (ui.bops?.handoff) ui.bops.handoff.error = String(error.message || 'Handoff was not opened.').slice(0, 160);
    }
    paintBops();
  }

  async function runPlan(plan, token) {
    const api = bopsApi();
    async function one(task) {
      if (ui.bopsToken !== token || ui.bops?.stopped) return;
      let sessionId = task.createSession ? '' : ui.sessionId;
      try {
        if (task.createSession) {
          const created = await root.remoteHermes.request('create-session', { profile: task.profile, title: task.input.slice(0, 80) });
          sessionId = created?.session?.id || created?.id || '';
          if (!sessionId) throw new Error('Hermes did not return a session id.');
          ui.bops = api.rememberSession(ui.bops, task.taskId, sessionId);
        }
        if (!sessionId) throw new Error('No session for this task.');
        await root.remoteHermes.request('send', { id: sessionId, profile: task.profile, input: task.input });
        if (ui.bopsToken !== token || ui.bops?.stopped) return;
        ui.bops = api.applyTaskResult(ui.bops, task.taskId, { ok: true });
      } catch (error) {
        if (ui.bops?.stopped || ui.bopsToken !== token) return;
        ui.bops = api.applyTaskResult(ui.bops, task.taskId, { ok: false, error: error.message, code: error.code || '' });
      }
      paintBops();
    }
    const jobs = plan.tasks.map(one);
    if (plan.handoff) jobs.push(runHandoff(plan.handoff, token));
    await Promise.all(jobs);
  }

  function pickerApi() {
    return root.IntelioModelPicker || null;
  }

  function paintModel() {
    const api = pickerApi();
    const label = $('model-pill-label');
    const button = $('remote-model');
    const text = api ? api.pillLabel(ui.modelId) : (ui.modelId || 'Model');
    if (label) label.textContent = text;
    if (button) button.setAttribute('aria-label', text);
  }

  function closeModelMenu() {
    ui.modelOpen = false;
    $('model-menu')?.classList.add('hidden');
    $('remote-model')?.setAttribute('aria-expanded', 'false');
  }

  function menuButton(label, selected, onClick) {
    const button = el('button', '', label);
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.onclick = (event) => { event.preventDefault(); event.stopPropagation(); onClick(); };
    return button;
  }

  async function loadModelOptions() {
    paintModel();
    if (!root.remoteHermes) return;
    try {
      const result = await root.remoteHermes.request('model-options', { profile: ui.selected, id: ui.sessionId });
      ui.modelProvider = result?.provider || '';
      ui.modelId = result?.model || '';
      ui.modelEffort = result?.effort || 'auto';
      ui.modelGroups = Array.isArray(result?.groups) ? result.groups : [];
      ui.profileModel = result?.profileModel || '';
      if (!ui.modelApplied) ui.modelApplied = '';
      paintModel();
      if (ui.modelOpen) paintModelMenu();
    } catch { paintModel(); }
  }

  function paintModelMenu() {
    const menu = $('model-menu');
    const api = pickerApi();
    if (!menu || !api) return;
    menu.replaceChildren();
    const groups = ui.modelGroups || [];
    if (!groups.length && ui.modelId) {
      menu.append(el('div', 'model-label', api.providerLabel(ui.modelProvider)));
      menu.append(menuButton(ui.modelId, true, () => {}));
    }
    for (const group of groups) {
      menu.append(el('div', 'model-label', group.label || api.providerLabel(group.provider)));
      for (const id of group.models || []) menu.append(menuButton(id, id === ui.modelId, () => chooseModel(group.provider, id)));
    }
    menu.append(el('div', 'model-label', 'Thinking'));
    for (const effort of api.EFFORTS) {
      menu.append(menuButton(api.EFFORT_LABELS[effort], effort === (ui.modelEffort || 'auto'), () => chooseEffort(effort)));
    }
    const agent = selectedAgent();
    const name = agent ? shownAgent(agent.id, agent.name) : (ui.selected || 'this agent');
    menu.append(menuButton(`Make default for ${name}`, false, () => makeModelDefault(name)));
  }

  async function toggleModelMenu() {
    if (ui.modelOpen) { closeModelMenu(); return; }
    await loadModelOptions();
    ui.modelOpen = true;
    paintModelMenu();
    $('model-menu')?.classList.remove('hidden');
    $('remote-model')?.setAttribute('aria-expanded', 'true');
  }

  async function applyThreadModel(provider, model, effort) {
    const api = pickerApi();
    ui.modelProvider = api ? api.canonicalProvider(provider) : provider;
    ui.modelId = model;
    ui.modelEffort = effort || ui.modelEffort || 'auto';
    paintModel();
    closeModelMenu();
    if (!ui.sessionId || ui.sample) { ui.modelApplied = 'request'; return; }
    try {
      const result = await root.remoteHermes.request('session-model', {
        id: ui.sessionId,
        profile: ui.selected,
        model: ui.modelId,
        provider: ui.modelProvider,
        effort: ui.modelEffort,
      });
      ui.modelApplied = result?.applied || 'request';
    } catch (error) {
      ui.modelApplied = 'request';
      showInline('composer-note', error?.message || 'Could not switch the model for this thread.');
    }
  }

  function chooseModel(provider, model) { return applyThreadModel(provider, model, ui.modelEffort || 'auto'); }
  function chooseEffort(effort) {
    const model = ui.modelId || ui.profileModel;
    if (!model) return;
    return applyThreadModel(ui.modelProvider, model, effort);
  }

  async function makeModelDefault(name) {
    const model = ui.modelId || ui.profileModel;
    if (!model) return;
    closeModelMenu();
    try {
      const result = await root.remoteHermes.request('agent-model', {
        profile: ui.selected,
        model,
        provider: ui.modelProvider,
      });
      ui.profileModel = model;
      showInline('composer-note', result?.note || (pickerApi()?.defaultNote(name) || ''));
    } catch (error) {
      showInline('composer-note', error?.message || 'Could not save that model.');
    }
  }

  function modelSendFields() {
    if (ui.modelApplied !== 'request' || !ui.modelId || !ui.modelProvider) return {};
    return { model: ui.modelId, provider: ui.modelProvider, effort: ui.modelEffort || 'auto' };
  }

  async function send(event) {
    event?.preventDefault?.();
    const input = $('remote-input');
    const text = input?.value.trim();
    if (!text || ui.busy || ui.sample) return;
    const api = bopsApi();
    const run = api.startRun({ text, profile: ui.selected, agentName: selectedAgent()?.name || ui.selected });
    ui.bops = run;
    ui.bopsToken += 1;
    const token = ui.bopsToken;
    paintBops();
    const plan = api.executionPlan(run);
    if (!ui.sessionId && plan.orchestration !== 'app-fan-out') {
      try {
        const created = await root.remoteHermes.request('create-session', { profile: ui.selected, title: `App chat ${new Date().toLocaleString()}` });
        ui.sessionId = created?.session?.id || created?.id || '';
        if (!ui.sessionId) throw new Error('Hermes did not return a session id.');
      } catch (error) { setStatus(error.message); return; }
    }
    ui.busy = true;
    ui.readFor = text;
    ui.readAt = Date.now();
    input.value = '';
    const pane = $('remote-messages');
    pane?.append(el('div', 'msg user', text));
    const receipt = readReceipt();
    if (receipt) pane?.append(receipt);
    paintHeader();
    if (plan.orchestration === 'app-fan-out') {
      const stop = stopControl();
      pane?.append(stop);
      setStatus('');
      try {
        await runPlan(plan, token);
      } finally {
        stop.remove?.();
        ui.busy = false;
        setStatus('');
        paintHeader();
      }
      return;
    }
    ui.streamRaw = '';
    ui.toolEvents = false;
    ui.liveSteps = [];
    ui.liveTools = el('div', 'tool-live');
    ui.streaming = el('div', 'msg assistant', '');
    const stop = stopControl();
    pane?.append(ui.streaming, ui.liveTools, stop);
    setStatus('');
    try {
      const jobs = [root.remoteHermes.request('send', { id: ui.sessionId, profile: ui.selected, input: text, ...modelSendFields() })];
      if (plan.handoff) jobs.push(runHandoff(plan.handoff, token));
      await Promise.all(jobs);
      if (!ui.bops?.tasks?.some((task) => task.status === 'blocked')) {
        ui.bops = api.applyTaskResult(ui.bops, ui.bops.focusedId, { ok: true });
      }
    } catch (error) {
      ui.streaming.append(root.document.createTextNode(`\n[${error.message}]`));
      ui.bops = api.applyTaskResult(ui.bops, ui.bops.focusedId, { ok: false, error: error.message, code: error.code || '' });
      paintBops();
    } finally {
      if (ui.call?.active && String(ui.unspoken || '').trim()) {
        ui.speakQueue = ui.speakQueue || [];
        ui.speakQueue.push(String(ui.unspoken).trim());
        ui.unspoken = '';
        pumpSpeech();
      }
      ui.spokenProse = '';
      ui.busy = false;
      ui.streaming = null;
      ui.liveSteps = [];
      setStatus('');
      paintHeader();
      await loadMessages(ui.sessionId).catch(() => {});
    }
  }

  function sync(next) {
    if (!root.document) return;
    wire();
    if (!ui.tabChosen) setSidebar('agents', { persist: false });
    $('sidebar-threads-wrap')?.classList.remove('hidden');
    const remote = next?.remoteHermes || {};
    ui.keys = remote.profilesWithKeys || [];
    ui.keyless = ui.keys.length === 0;
    const stamp = `${remote.host}|${remote.port}|${remote.activeMode || ''}|${remote.needsSignIn ? 1 : 0}|${[...ui.keys].sort().join(',')}`;
    const search = $('bot-search');
    ui.query = search && !search.classList.contains('hidden') ? search.value : ui.query;
    if (!ui.agents.length) {
      if (remoteConfigured(remote)) ui.agents = chooseSidebar({ remote, remoteAgents: [] }).agents;
      else if (!remote.needsSignIn) {
        setStatus('No API keys saved for the VPS.');
        showProfileError('No API keys saved for the VPS.');
      }
      paintAgents();
    }
    if (stamp !== ui.stamp) {
      ui.stamp = stamp;
      refresh();
    }
  }

  function filter(query) {
    ui.query = query || '';
    paintAgents();
  }

  function mountSample({ agent = 'intelio' } = {}) {
    ui.sample = true;
    ui.label = SAMPLE.label;
    ui.agents = SAMPLE.agents.map((item) => ({ ...item, orb: item.orb || signatureOf(item.id) }));
    ui.stamp = 'sample';
    wire();
    paintBanner();
    ui.allSessions = SAMPLE.sessions.slice().sort((a, b) => sessionAt(b) - sessionAt(a));
    ui.screens = [{ profileId: 'intelio', name: 'intelio', host: 'google.com', screen: 1 }];
    const host = $('intelio-profile');
    if (host) host.textContent = 'VPS Hermes · sample';
    const pin = $('hermes-pin');
    if (pin) pin.textContent = 'SAMPLE DATA · remote main window';
    return selectAgent(agent);
  }

  return {
    signatureOf, accentOf, switcherRows, seedAgents, remoteConfigured, chooseSidebar, sessionAt, sessionRows, SAMPLE,
    sync, filter, setSidebar, sidebar: () => ui.sidebar, refresh, mountSample, selectedName: () => { const agent = selectedAgent(); return agent ? shownAgent(agent.id, agent.name) : ''; }, selectedId: () => ui.selected || '',
    presentBops, focusBops, stopBops, actBops, pushFrame, toggleCall, applyLook, bopsEffect: () => ui.lastEffect,
  };
});
