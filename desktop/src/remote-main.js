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
    // Bumped whenever the visible agent or thread changes; a response that
    // started under an older value belongs to a view that is gone.
    viewSeq: 0,
    refreshing: null,
    refreshAgain: false,
    refreshTimer: null,
    lastRefreshAt: 0,
    needsSignIn: false,
    pendingVoice: '',
    phoneReady: {},
  };
  const REFRESH_MS = 45000;
  const FOCUS_REFRESH_GAP_MS = 5000;

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
    // The orb is decoration next to the agent's name. The orb library labels the canvas with
    // its animation name ("Connecting"), which screen readers announced as a status; hide it.
    canvas.setAttribute('aria-hidden', 'true');
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
    const known = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP', arlp: 'ARLP' };
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
    mountOrb(canvas, lead.id, lead.orb, 56, true, lead.color);
    const badge = el('span', 'lead-badge');
    orb.append(canvas, badge);
    const count = workCount();
    // Report the real link to the VPS Hermes API instead of a fixed "Online".
    const link = ui.link === 'offline' ? 'Offline · reconnecting' : ui.link === 'online' ? 'Online' : 'Connecting…';
    const status = el('span', `lead-status${ui.link === 'offline' && !count ? ' offline' : ''}`, count ? `Working on ${count} ${count === 1 ? 'thing' : 'things'}` : link);
    card.append(orb, el('strong', 'lead-name', lead.name), status);
    card.onclick = () => root.openAgentDetails?.(lead.id);
  }

  function paintAgents() {
    const list = $('bot-list');
    if (!list) return;
    const rows = switcherRows(ui.agents, { query: ui.query, selected: ui.selected });
    paintLead(rows);
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

  /** While a reply streams, the typing bubble's one-line status is the latest running step. */
  function paintLiveTools() {
    if (!ui.liveTools) return;
    const status = root.IntelioTranscript?.typingStatus
      ? root.IntelioTranscript.typingStatus(ui.liveSteps || [])
      : '';
    const line = ui.liveTools.statusLine;
    if (line) {
      line.textContent = status;
      line.classList.toggle('hidden', !status);
    }
    paintHeader();
  }

  /**
   * Agent work shows as one typing bubble on the agent's side (dots, an optional
   * short status, and a small stop button while this app is running the reply).
   * Tool steps are not listed in the chat.
   */
  function typingNode(status = '', onStop = null, stopLabel = 'Stop') {
    const wrap = el('div', 'msg assistant typing-bubble');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'The agent is working');
    const dots = el('span', 'think-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    const line = el('span', 'typing-status', status);
    line.classList.toggle('hidden', !status);
    wrap.append(dots, line);
    wrap.statusLine = line;
    if (typeof onStop === 'function') {
      const stop = el('button', 'typing-stop');
      stop.type = 'button';
      stop.title = stopLabel;
      stop.setAttribute('aria-label', stopLabel);
      stop.onclick = () => onStop();
      wrap.append(stop);
    }
    return wrap;
  }
  /** A new thread: the agent's name in the intelio wordmark type, and one line on how to start. */
  function emptyThread() {
    const agent = selectedAgent();
    const wrap = el('div', 'chat-empty');
    wrap.append(el('div', 'chat-wordmark', agent ? shownAgent(agent.id, agent.name) : 'intelio'));
    wrap.append(el('p', 'chat-empty-hint', 'Describe the task in your own words. I’ll pick the right tools, explain my plan, and check in before risky steps.'));
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
    const items = root.IntelioTranscript?.conversation ? root.IntelioTranscript.conversation(ui.messages) : ui.messages.map((message) => ({ kind: 'bubble', role: message.role === 'user' ? 'user' : 'assistant', text: textOf(message.content) }));
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
      else if (item.kind === 'typing') pane.append(typingNode(item.status || ''));
      else if (item.kind === 'bubble' && item.text) pane.append(el('div', `msg ${item.role === 'user' ? 'user' : 'assistant'}`, item.text));
    }
    flushRead();
    if (!pane.children?.length && !ui.sessionId && !ui.busy && ui.selected && ui.freshThread) pane.append(emptyThread());
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
          if (text && ui.call?.active) voiceTranscript(text);
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

  function paintPhoneButton() {
    const button = $('chat-call');
    if (!button) return;
    const ready = !ui.sample && ui.phoneReady[ui.selected] === true;
    button.classList.toggle('hidden', !ready);
    if (!ready) showInline('phone-note', '');
  }

  /** The call button shows only when the agent card says its phone line is live. */
  async function loadPhoneReady(id) {
    if (ui.sample || !id || !root.remoteHermes) { paintPhoneButton(); return; }
    let ready = false;
    try {
      const card = await root.remoteHermes.request('agent-card', { profile: id });
      ready = card?.phoneSoon === false;
    } catch { ready = false; }
    ui.phoneReady[id] = ready;
    if (ui.selected === id) paintPhoneButton();
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
      ui.pendingVoice = '';
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

  function currentView(seq, sessionId) {
    return seq === ui.viewSeq && (sessionId === undefined || sessionId === ui.sessionId);
  }

  /** Paints the thread only if it is still the one on screen when the reply lands. */
  async function loadMessages(id, seq = ui.viewSeq) {
    if (ui.sample) {
      ui.messages = SAMPLE.messages[id] || [];
      paintMessages();
      return true;
    }
    const api = root.remoteHermes;
    const result = await api.request('messages', { id, profile: ui.selected });
    if (!currentView(seq, id)) return false;
    ui.messages = result?.data || [];
    paintMessages();
    return true;
  }

  function stopControl(stopLabel = 'Stop') {
    return typingNode('', () => stopBops(), stopLabel);
  }

  async function openSession(id) {
    const seq = ++ui.viewSeq;
    ui.readFor = '';
    ui.readAt = 0;
    ui.sessionId = id;
    paintSessions();
    const input = $('remote-input');
    const send = $('remote-send');
    if (input) input.disabled = false;
    if (send) send.disabled = false;
    try { await loadMessages(id, seq); } catch (error) {
      if (currentView(seq, id)) { setStatus(error.message); showProfileError(error.message); }
    }
    if (currentView(seq, id)) loadModelOptions().catch(() => {});
  }

  /** Sessions tab rows: archived ones only on the Archived view, pinned first, then newest. */
  function sessionRows() {
    const needle = String(ui.sessionQuery || '').trim().toLowerCase();
    return ui.allSessions.filter((session) => {
      if (Boolean(session.archived) !== Boolean(ui.showArchived)) return false;
      if (ui.sessionAgent && session.profileId !== ui.sessionAgent) return false;
      if (!needle) return true;
      const name = ui.agents.find((agent) => agent.id === session.profileId)?.name || session.profileId || '';
      return `${name} ${session.title || ''} ${session.preview || ''} ${session.sourceLabel || ''} ${session.source || ''}`.toLowerCase().includes(needle);
    }).slice().sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || (sessionAt(b) - sessionAt(a)));
  }

  const DAY_MS = 86400000;
  function startOfToday(now) {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  }

  /**
   * Date buckets like the Hermes desktop sidebar. The newest bucket has no heading:
   * rows sit straight under SESSIONS.
   */
  function sessionGroup(session, now) {
    const at = sessionAt(session);
    if (!at) return 'Older';
    const today = startOfToday(now);
    if (at >= today) return '';
    if (at >= today - DAY_MS) return 'Yesterday';
    if (at >= today - 6 * DAY_MS) return 'Earlier this week';
    if (at >= today - 13 * DAY_MS) return 'Last week';
    if (at >= today - 29 * DAY_MS) return 'Earlier this month';
    return 'Older';
  }

  /** Short relative time: now, 28m, 2h, 3d, 2w, then a date. */
  function sessionStamp(session, now) {
    const at = sessionAt(session);
    if (!at) return sessionWhen(session);
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days}d`;
    if (days < 28) return `${Math.round(days / 7)}w`;
    return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function agentDot(agent, id) {
    const dot = el('span', 'session-dot');
    dot.style.background = agent?.color || accentOf(agent?.id || id);
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  /** The client catalog (intelio/client-apps.cjs); empty where it is not loaded. */
  function clientCatalog() {
    return root.IntelioClientApps || null;
  }

  /** Clients for the chip row: the catalog's work clients, plus any other agent on the VPS. */
  function clientRows() {
    const catalog = clientCatalog();
    const rows = (catalog?.CLIENTS || []).map((client) => {
      const agent = ui.agents.find((item) => item.id === client.id);
      return { id: client.id, name: client.short || client.name, agent: agent || { id: client.id } };
    });
    for (const agent of ui.agents) {
      if (!rows.some((row) => row.id === agent.id)) rows.push({ id: agent.id, name: shownAgent(agent.id, agent.name), agent });
    }
    return rows;
  }

  const SESSION_AGENT_KEY = 'intelio-session-agent';
  /** The saved Sessions filter ('' is All agents). Kept in this window's localStorage. */
  function storedSessionAgent() {
    try { return String(root.localStorage?.getItem(SESSION_AGENT_KEY) || '').trim().toLowerCase(); } catch { return ''; }
  }
  function storeSessionAgent(id) {
    try {
      if (id) root.localStorage?.setItem(SESSION_AGENT_KEY, id);
      else root.localStorage?.removeItem(SESSION_AGENT_KEY);
    } catch { /* the filter still applies for this window */ }
  }
  /** Pick the Sessions filter: '' for All agents, or one agent id. Remembered across launches. */
  function setSessionAgent(id) {
    ui.sessionAgent = String(id || '').trim().toLowerCase();
    ui.sessionAgentPref = ui.sessionAgent;
    storeSessionAgent(ui.sessionAgent);
    paintAllSessions();
  }

  /** Sessions filter: one compact dropdown, All agents plus one entry per client/agent. No dots. */
  function paintAgentChips() {
    const host = $('session-agents');
    const rows = clientRows();
    if (ui.sessionAgentPref === undefined) ui.sessionAgentPref = storedSessionAgent();
    // A saved choice waits for the agent list instead of being dropped while it loads.
    const wanted = ui.sessionAgentPref || '';
    ui.sessionAgent = wanted && rows.some((row) => row.id === wanted) ? wanted : '';
    if (!host) return;
    let select = host.children ? [...host.children].find((node) => node.tag === 'select' || node.tagName === 'SELECT') : null;
    if (!select) {
      host.replaceChildren();
      select = el('select', 'session-agent-select');
      select.id = 'session-agent-select';
      select.setAttribute('aria-label', 'Show sessions for');
      select.title = 'Show sessions for';
      select.addEventListener('change', () => setSessionAgent(select.value));
      select.addEventListener('click', (event) => event?.stopPropagation?.());
      host.append(select);
    }
    const options = [{ id: '', name: 'All agents' }, ...rows.map((row) => ({ id: row.id, name: row.name }))];
    const key = options.map((row) => `${row.id}:${row.name}`).join('|');
    // Rebuild only when the list changes, so a background refresh does not close an open menu.
    if (select.dataset.options !== key) {
      select.dataset.options = key;
      select.replaceChildren(...options.map((row) => {
        const option = el('option', '', row.name);
        option.value = row.id;
        return option;
      }));
    }
    for (const option of select.children || []) option.selected = option.value === ui.sessionAgent;
    select.value = ui.sessionAgent;
    select.dataset.agent = ui.sessionAgent;
    paintClientApps();
  }

  const APP_ICONS = {
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    chat: '<path d="M4 5.5h12v8H8.5L5 16.5v-3H4z"/><path d="M16 9h4v8h-1v3l-3.5-3H10v-3"/>',
    drive: '<path d="M7 18h11a4 4 0 0 0 .6-7.95A6 6 0 0 0 7.2 9.1 4.5 4.5 0 0 0 7 18z"/>',
    folder: '<path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5H11L9 5H4.5A1.5 1.5 0 0 0 3 6.5z"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    sheet: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 9.5h16M4 15h16M10 9.5v11"/>',
    slides: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M12 16.5V20M8.5 20h7"/>',
    video: '<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m15.5 10.5 5-3v9l-5-3"/>',
    box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
    dashboard: '<rect x="3.5" y="3.5" width="7" height="9" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.5"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.5"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.5"/>',
    more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  };

  function appIcon(name) {
    const span = el('span', 'client-app-icon');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24">${APP_ICONS[name] || APP_ICONS.dashboard}</svg>`;
    return span;
  }

  /** The client the app row is for: the picked chip, else the agent in the chat. */
  function appsClient() {
    const catalog = clientCatalog();
    if (!catalog) return null;
    return catalog.clientById(ui.sessionAgent) || catalog.clientById(ui.selected) || catalog.CLIENTS[0];
  }

  async function openClientApp(client, app) {
    const catalog = clientCatalog();
    ui.appsMenuOpen = false;
    if (root.workspace?.command) {
      try {
        await root.workspace.command('open-client-app', { client: client.id, app: app.id });
      } catch (error) {
        notify(`Couldn't open ${app.label}: ${String(error?.message || error).slice(0, 120)}`);
      }
      paintClientApps();
      return;
    }
    // The web desktop has no per-client browser jars; it opens the app in a new browser tab.
    const account = ui.clientStatus?.[client.id]?.account;
    root.open?.(catalog.urlFor(client.id, app.id, account), '_blank', 'noopener');
  }

  function appButton(client, app, signedIn, { inMenu = false } = {}) {
    const button = el('button', inMenu ? 'client-app-row' : 'client-app');
    button.type = 'button';
    button.dataset.app = app.id;
    button.append(appIcon(app.icon));
    if (inMenu) button.append(el('span', 'client-app-label', app.label));
    const status = signedIn === true ? 'signed in' : signedIn === false ? 'not signed in' : 'checking';
    const suite = clientCatalog().SUITE_LABEL[app.suite] || '';
    const label = `${app.label} · ${client.short || client.name}`;
    button.title = `${label}\nBrowser: ${status}${suite ? ` (${suite})` : ''}\nAgent access: set up in the agent's Hermes connections`;
    button.setAttribute('aria-label', `${label}, browser ${status}`);
    if (!inMenu) {
      const dot = el('span', `client-app-dot${signedIn ? ' on' : ''}`);
      dot.setAttribute('aria-hidden', 'true');
      button.append(dot);
    }
    button.onclick = (event) => { event?.stopPropagation?.(); openClientApp(client, app); };
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault?.();
      const input = $('remote-input');
      if (input) { input.value = `Using ${client.short || client.name}'s ${app.label}, `; input.focus?.(); }
    });
    return button;
  }

  /** The app row: the client's suite apps with a browser sign-in dot, and More for the rest. */
  function paintClientApps() {
    const host = $('client-apps');
    const catalog = clientCatalog();
    if (!host) return;
    host.replaceChildren();
    const client = appsClient();
    if (!catalog || !client) { host.classList.toggle('hidden', true); return; }
    host.classList.toggle('hidden', false);
    const state = ui.clientStatus?.[client.id];
    const signedIn = state ? Boolean(state.signedIn) : undefined;
    const apps = catalog.appsFor(client.id);
    const head = el('div', 'client-apps-head');
    head.append(el('span', 'client-apps-name', client.short || client.name));
    head.append(el('span', 'client-apps-suite', catalog.SUITE_LABEL[client.suite]));
    const account = el('span', `client-apps-account${signedIn ? ' on' : ''}`, signedIn ? (state.account || 'Signed in') : (state?.account ? `Sign in · ${state.account}` : 'Not signed in'));
    head.append(account);
    host.append(head);
    const row = el('div', 'client-apps-row');
    for (const app of apps.filter((item) => item.primary)) row.append(appButton(client, app, signedIn));
    const more = el('button', 'client-app more');
    more.type = 'button';
    more.title = `More ${client.short || client.name} apps`;
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(Boolean(ui.appsMenuOpen)));
    more.append(appIcon('more'));
    more.onclick = (event) => { event?.stopPropagation?.(); ui.appsMenuOpen = !ui.appsMenuOpen; paintClientApps(); };
    row.append(more);
    host.append(row);
    if (ui.appsMenuOpen) {
      const menu = el('div', 'client-apps-menu');
      menu.setAttribute('role', 'menu');
      menu.append(el('div', 'client-apps-menu-title', `${client.short || client.name} · ${catalog.SUITE_LABEL[client.suite]}`));
      for (const app of apps) menu.append(appButton(client, app, signedIn, { inMenu: true }));
      if (root.workspace?.command) {
        const accountRow = el('button', 'client-app-row quiet', state?.account ? `Account: ${state.account}` : 'Set account email');
        accountRow.type = 'button';
        accountRow.onclick = (event) => { event?.stopPropagation?.(); editClientAccount(client); };
        menu.append(accountRow);
        if (signedIn) {
          const out = el('button', 'client-app-row quiet danger', 'Sign out of this client');
          out.type = 'button';
          out.onclick = async (event) => {
            event?.stopPropagation?.();
            if (!out.dataset.armed) { out.dataset.armed = '1'; out.textContent = 'Click again to sign out'; return; }
            ui.appsMenuOpen = false;
            try { ui.clientStatus = (await root.workspace.command('client-sign-out', { client: client.id }))?.clients || ui.clientStatus; } catch (error) { notify(String(error?.message || error)); }
            paintClientApps();
          };
          menu.append(out);
        }
      }
      host.append(menu);
    }
  }

  function editClientAccount(client) {
    const host = $('client-apps');
    const menu = host?.querySelector?.('.client-apps-menu');
    if (!menu) return;
    const input = el('input', 'client-account-input');
    input.type = 'email';
    input.placeholder = 'name@company.com';
    input.value = ui.clientStatus?.[client.id]?.account || '';
    input.setAttribute('aria-label', `${client.short || client.name} account email`);
    menu.append(input);
    input.focus?.();
    const save = async () => {
      try {
        ui.clientStatus = (await root.workspace.command('client-account', { client: client.id, account: input.value }))?.clients || ui.clientStatus;
        ui.appsMenuOpen = false;
        paintClientApps();
      } catch (error) { notify(String(error?.message || error)); }
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation?.();
      if (event.key === 'Enter') save();
      if (event.key === 'Escape') { ui.appsMenuOpen = false; paintClientApps(); }
    });
    input.addEventListener('click', (event) => event.stopPropagation?.());
  }

  /** Which clients' browser jars are signed in. Desktop app only. */
  async function loadClientStatus() {
    if (!root.workspace?.command || !clientCatalog()) return;
    try {
      const result = await root.workspace.command('client-apps-status', {});
      ui.clientStatus = result?.clients || {};
    } catch { ui.clientStatus = ui.clientStatus || {}; }
    paintClientApps();
  }

  function sectionHead(label) {
    const head = el('li', 'session-section');
    head.append(el('span', 'session-section-mark'));
    head.append(el('span', 'session-section-label', label));
    return head;
  }

  function sessionItem(session, now) {
    const agent = ui.agents.find((item) => item.id === session.profileId);
    const name = shownAgent(session.profileId, agent?.name);
    const active = session.id === ui.sessionId && session.profileId === ui.selected;
    const item = el('li', `all-session${active ? ' active' : ''}${session.pinned ? ' pinned' : ''}`);
    item.dataset.profile = session.profileId || '';
    item.dataset.sessionId = session.id || '';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-current', String(active));
    const title = session.title || 'Untitled session';
    item.title = `${title} · ${name}${session.preview ? `\n${session.preview}` : ''}`;
    item.setAttribute('aria-label', `${title}, ${name}`);
    item.append(agentDot(agent, session.profileId));
    item.append(el('span', 'session-title', title));
    if (!ui.sessionAgent) item.append(el('span', 'session-agent', name));
    const when = sessionStamp(session, now);
    if (when) item.append(el('span', 'session-time', when));
    const more = el('button', 'session-more', '⋯');
    more.type = 'button';
    more.title = 'Session actions';
    more.setAttribute('aria-label', `Actions for ${title}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (event) => {
      event?.stopPropagation?.();
      if (ui.sessionMenuFor === session.id) { closeSessionMenu(); return; }
      openSessionMenu(item, session);
    };
    item.append(more);
    // Shift-click pins or unpins, as in the Hermes desktop sidebar.
    item.onclick = (event) => {
      if (event?.shiftKey) { updateSession(session, { pinned: !session.pinned }); return; }
      openListed(session);
    };
    item.addEventListener('keydown', (event) => {
      if (event.target !== item) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault?.(); openListed(session); }
    });
    return item;
  }

  function paintAllSessions() {
    const list = $('all-sessions');
    if (!list) return;
    closeSessionMenu();
    paintAgentChips();
    const rows = sessionRows();
    const now = Date.now();
    list.replaceChildren();
    if (!ui.showArchived) {
      const pinned = rows.filter((session) => session.pinned);
      list.append(sectionHead('Pinned'));
      if (pinned.length) for (const session of pinned) list.append(sessionItem(session, now));
      else list.append(el('li', 'session-hint', 'Shift-click a chat to pin'));
    }
    list.append(sectionHead(ui.showArchived ? 'Archived' : 'Sessions'));
    let group = '';
    const rest = ui.showArchived ? rows : rows.filter((session) => !session.pinned);
    for (const session of rest) {
      const next = sessionGroup(session, now);
      if (next !== group) {
        group = next;
        if (group) list.append(el('li', 'session-group', group));
      }
      list.append(sessionItem(session, now));
    }
    if (!rest.length) {
      const empty = ui.showArchived ? 'No archived sessions.' : (ui.allSessions.length ? 'No sessions match.' : 'No sessions yet. Start one with New session.');
      list.append(el('li', 'session-empty', empty));
    }
    const archived = ui.allSessions.filter((session) => session.archived).length;
    const toggle = $('session-archived');
    if (toggle) {
      toggle.textContent = ui.showArchived ? '← Back to sessions' : `Archived (${archived})`;
      toggle.classList.toggle('hidden', ui.sidebar !== 'sessions' || (!ui.showArchived && !archived));
    }
  }

  function closeSessionMenu() {
    if (ui.sessionMenu) ui.sessionMenu.remove?.();
    ui.sessionMenu = null;
    ui.sessionMenuFor = '';
    if (ui.sessionMenuOff) { ui.sessionMenuOff(); ui.sessionMenuOff = null; }
  }

  function openSessionMenu(anchor, session) {
    closeSessionMenu();
    const menu = el('div', 'session-menu');
    menu.setAttribute('role', 'menu');
    const action = (label, run, extra = '') => {
      const button = el('button', `session-menu-item${extra ? ` ${extra}` : ''}`, label);
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.onclick = (event) => { event?.stopPropagation?.(); run(button); };
      menu.append(button);
      return button;
    };
    action('Rename', () => { closeSessionMenu(); startRename(anchor, session); });
    action(session.pinned ? 'Unpin' : 'Pin to top', () => { closeSessionMenu(); updateSession(session, { pinned: !session.pinned }); });
    action(session.archived ? 'Unarchive' : 'Archive', () => { closeSessionMenu(); updateSession(session, { archived: !session.archived }); });
    action('Delete', (button) => {
      if (button.dataset.armed) { closeSessionMenu(); deleteSession(session); return; }
      button.dataset.armed = '1';
      button.textContent = 'Click again to delete';
    }, 'danger');
    menu.addEventListener('click', (event) => event?.stopPropagation?.());
    anchor.append(menu);
    ui.sessionMenu = menu;
    ui.sessionMenuFor = session.id;
    const doc = root.document;
    const outside = (event) => {
      if (menu.contains?.(event.target) || event.target?.closest?.('.session-more')) return;
      closeSessionMenu();
    };
    const escape = (event) => { if (event.key === 'Escape') closeSessionMenu(); };
    doc.addEventListener?.('pointerdown', outside, true);
    doc.addEventListener?.('keydown', escape, true);
    ui.sessionMenuOff = () => {
      doc.removeEventListener?.('pointerdown', outside, true);
      doc.removeEventListener?.('keydown', escape, true);
    };
    menu.querySelector?.('button')?.focus?.();
  }

  function startRename(item, session) {
    const title = item.querySelector?.('.session-title');
    if (!title) return;
    const input = el('input', 'session-rename');
    input.value = session.title || '';
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Session name');
    title.replaceWith(input);
    input.focus?.();
    input.select?.();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const next = String(input.value || '').trim();
      input.replaceWith(title);
      if (save && next && next !== session.title) updateSession(session, { title: next });
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation?.();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('click', (event) => event.stopPropagation?.());
    input.addEventListener('blur', () => finish(true));
  }

  function notify(text) {
    const toast = $('toast');
    if (!toast) { setStatus(text); return; }
    toast.textContent = text;
    toast.classList.toggle('hidden', false);
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => toast.classList.toggle('hidden', true), 5000);
  }

  function sessionError(error, verb) {
    const status = Number(error?.status) || Number(String(error?.message || '').match(/HTTP (\d{3})/)?.[1]) || 0;
    if (status === 405) return `Can't ${verb} from cloud mode yet: update the intelio server on the VPS.`;
    if (/unsupported_session_field|Unsupported session fields/i.test(String(error?.message || ''))) return `This Hermes version on the VPS can't ${verb} sessions yet.`;
    return `Couldn't ${verb} the session: ${String(error?.message || error).slice(0, 160)}`;
  }

  /** Apply the same change to every cached copy of a session (Sessions tab and agent threads). */
  function patchCached(id, fields) {
    for (const list of [ui.allSessions, ui.sessions]) {
      for (const row of list || []) if (row.id === id) Object.assign(row, fields);
    }
  }

  async function updateSession(session, fields) {
    const before = {};
    for (const key of Object.keys(fields)) before[key] = session[key];
    patchCached(session.id, fields);
    paintAllSessions();
    paintSessions();
    const verb = 'title' in fields ? 'rename' : 'pinned' in fields ? 'pin' : 'archive';
    try {
      await root.remoteHermes.request('session-update', { profile: session.profileId || ui.selected, id: session.id, fields });
    } catch (error) {
      patchCached(session.id, before);
      paintAllSessions();
      paintSessions();
      notify(sessionError(error, verb));
    }
  }

  async function deleteSession(session) {
    try {
      await root.remoteHermes.request('session-delete', { profile: session.profileId || ui.selected, id: session.id });
    } catch (error) {
      notify(sessionError(error, 'delete'));
      return;
    }
    ui.allSessions = ui.allSessions.filter((row) => row.id !== session.id);
    ui.sessions = ui.sessions.filter((row) => row.id !== session.id);
    if (ui.sessionId === session.id) {
      ui.sessionId = '';
      ui.messages = [];
      paintMessages();
    }
    paintAllSessions();
    paintSessions();
  }

  /** New chat: the filtered agent, else the selected one. The thread is created on first send. */
  async function newChat(agentId) {
    const id = agentId || ui.sessionAgent || ui.selected || ui.agents[0]?.id;
    if (!id) return;
    await selectAgent(id, { fresh: true });
    paintAllSessions();
    $('remote-input')?.focus?.();
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
    // The agent's own threads belong to the Agents view; the Sessions tab lists every agent's.
    $('sidebar-threads-wrap')?.classList.toggle('hidden', !agentsOn);
    if (agentsOn && ui.showArchived) ui.showArchived = false;
    $('session-archived')?.classList.toggle('hidden', true);
    if (!agentsOn) $('bot-search')?.classList.toggle('hidden', true);
    if (!agentsOn) loadClientStatus();
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

  async function selectAgent(id, { sessionId = '', fresh = false } = {}) {
    const seq = ++ui.viewSeq;
    ui.selected = id;
    if (typeof root.onIntelioAgent === 'function') root.onIntelioAgent(id);
    ui.freshThread = fresh;
    ui.sessionId = '';
    ui.messages = [];
    paintAgents();
    paintMessages();
    paintPhoneButton();
    if (!ui.sample) loadPhoneReady(id);
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
      // A newer selection (fast switching) owns the screen now.
      if (!currentView(seq)) return;
      ui.sessions = Array.isArray(result?.data) ? result.data : [];
      paintAgents();
      paintSessions();
      // fresh: New session keeps the composer on an empty thread; the session is created on first send.
      const target = sessionId && ui.sessions.some((session) => session.id === sessionId) ? sessionId : (fresh ? '' : ui.sessions[0]?.id);
      if (target) await openSession(target);
      else if (fresh) loadModelOptions().catch(() => {});
      else {
        ui.freshThread = true;
        paintMessages();
        setStatus('No sessions for this agent yet. Send a message to start one.');
        loadModelOptions().catch(() => {});
      }
    } catch (error) {
      if (currentView(seq)) { setStatus(error.message); showProfileError(error.message); }
    }
  }

  async function loadHome() {
    const home = await root.remoteHermes.request('agents');
    const listed = home?.agents || [];
    ui.agents = chooseSidebar({ remote: { enabled: true, host: 'vps', profilesWithKeys: ui.keys }, remoteAgents: listed }).agents;
    ui.sample = Boolean(home?.sample);
    ui.label = home?.label || '';
    paintBanner();
    const gone = !ui.selected || !ui.agents.some((agent) => agent.id === ui.selected);
    if (gone) ui.selected = ui.agents[0]?.id || '';
    paintAgents();
    paintHeader();
    // Screens load on their own; chat and sessions never wait for them.
    loadScreens();
    return gone;
  }

  function loadScreens() {
    if (ui.loadingScreens) return ui.loadingScreens;
    ui.loadingScreens = Promise.resolve()
      .then(() => root.remoteHermes.request('screens'))
      .then((screens) => { ui.screens = Array.isArray(screens?.data) ? screens.data : []; })
      .catch(() => { ui.screens = ui.screens || []; })
      .finally(() => { ui.loadingScreens = null; });
    return ui.loadingScreens;
  }

  /** Reloads the selected agent's thread list in place; the open thread stays open. */
  async function refreshThreads(id) {
    const seq = ui.viewSeq;
    const open = ui.sessionId;
    const before = ui.sessions.find((session) => session.id === open);
    const result = await root.remoteHermes.request('sessions', { profile: id, limit: 100 });
    if (!currentView(seq) || ui.selected !== id) return;
    ui.sessions = Array.isArray(result?.data) ? result.data : [];
    paintSessions();
    paintAgents();
    const after = ui.sessions.find((session) => session.id === open);
    if (open && after && !ui.busy && sessionAt(after) !== sessionAt(before)) await loadMessages(open, seq);
  }

  function setLink(next) {
    if (ui.link === next) return;
    ui.link = next;
    paintAgents();
  }

  async function runRefresh(quiet) {
    try {
      let gone;
      // Only the home load decides the link state; a failing thread load is not "offline".
      try { gone = await loadHome(); setLink('online'); } catch (error) { setLink('offline'); throw error; }
      if (!quiet || gone) {
        await Promise.all([ui.selected ? selectAgent(ui.selected) : null, loadAllSessions()]);
        return;
      }
      await Promise.all([
        ui.selected && !ui.busy ? refreshThreads(ui.selected).catch(() => {}) : null,
        loadAllSessions(),
      ]);
    } catch (error) {
      if (!quiet) { setStatus(error.message); showProfileError(error.message); }
    }
  }

  /**
   * Full refresh (connection changed) reselects the agent. A quiet refresh
   * (timer, window focus) only updates agents, threads and screens. Never two
   * at once: a full refresh asked for mid-flight runs right after.
   */
  function refresh({ quiet = false } = {}) {
    if (ui.sample || !root.remoteHermes) return Promise.resolve();
    if (ui.refreshing) {
      if (!quiet) ui.refreshAgain = true;
      return ui.refreshing;
    }
    ui.lastRefreshAt = Date.now();
    ui.refreshing = runRefresh(quiet).finally(() => {
      ui.refreshing = null;
      if (ui.refreshAgain) {
        ui.refreshAgain = false;
        refresh();
      }
    });
    return ui.refreshing;
  }

  function autoRefresh({ focus = false } = {}) {
    if (ui.sample || !ui.stamp || ui.needsSignIn || !root.remoteHermes) return null;
    if (root.document?.visibilityState === 'hidden') return null;
    if (focus && Date.now() - ui.lastRefreshAt < FOCUS_REFRESH_GAP_MS) return null;
    return refresh({ quiet: true });
  }

  function startAutoRefresh() {
    if (ui.refreshTimer || typeof root.setInterval !== 'function') return;
    ui.refreshTimer = root.setInterval(() => { autoRefresh(); }, REFRESH_MS);
    ui.refreshTimer?.unref?.();
  }

  function stopAutoRefresh() {
    if (ui.refreshTimer && typeof root.clearInterval === 'function') root.clearInterval(ui.refreshTimer);
    ui.refreshTimer = null;
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
    root.addEventListener?.('focus', () => { autoRefresh({ focus: true }); });
    startAutoRefresh();
    const headerCall = $('chat-call');
    if (headerCall) headerCall.onclick = () => callPhone();
    $('tab-agents')?.addEventListener('click', () => setSidebar('agents'));
    $('tab-sessions')?.addEventListener('click', () => setSidebar('sessions'));
    $('session-search')?.addEventListener('input', (event) => { ui.sessionQuery = event.target.value || ''; paintAllSessions(); });
    $('session-new')?.addEventListener('click', () => { newChat(); });
    for (const button of root.document.querySelectorAll?.('[data-session-open]') || []) {
      button.addEventListener('click', () => {
        const id = ui.selected || ui.agents[0]?.id || 'intelio';
        const target = button.dataset.sessionOpen;
        if (target === 'computer') root.openAgentComputer?.(id);
        else root.openAgentDetails?.(id, target);
      });
    }
    root.document.addEventListener?.('keydown', (event) => {
      const key = String(event.key || '').toLowerCase();
      if (key === 'n' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && root.document.body?.classList?.contains('remote-main')) {
        event.preventDefault?.();
        newChat();
      }
    });
    root.document.addEventListener?.('pointerdown', (event) => {
      if (!ui.appsMenuOpen || event.target?.closest?.('.client-apps')) return;
      ui.appsMenuOpen = false;
      paintClientApps();
    }, true);
    root.addEventListener?.('focus', () => { loadClientStatus(); });
    $('threads-new')?.addEventListener('click', () => { newChat(ui.selected); });
    $('session-archived')?.addEventListener('click', () => { ui.showArchived = !ui.showArchived; paintAllSessions(); });
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

  /** Drops a run that never started (no session), so no task bar is left "working". */
  function clearRun(token) {
    if (ui.bopsToken !== token) return;
    ui.bops = null;
    ui.bopsToken += 1;
    paintBops();
    paintHeader();
  }

  /** A call transcript waits for the current reply instead of being dropped. */
  function voiceTranscript(text) {
    const said = String(text || '').trim();
    if (!said) return 'empty';
    if (ui.busy) {
      ui.pendingVoice = ui.pendingVoice ? `${ui.pendingVoice} ${said}` : said;
      showInline('composer-note', 'Queued · sends when this reply finishes');
      return 'queued';
    }
    send(null, said);
    return 'sent';
  }

  function flushVoice() {
    if (!ui.pendingVoice || ui.busy) return;
    const text = ui.pendingVoice;
    ui.pendingVoice = '';
    showInline('composer-note', '');
    voiceTranscript(text);
  }

  async function send(event, spoken) {
    event?.preventDefault?.();
    const input = $('remote-input');
    const fromInput = spoken === undefined;
    const text = fromInput ? input?.value.trim() : String(spoken || '').trim();
    if (!text || ui.busy || ui.sample) return;
    const seq = ui.viewSeq;
    const profile = ui.selected;
    let sessionId = ui.sessionId;
    const api = bopsApi();
    const run = api.startRun({ text, profile, agentName: selectedAgent()?.name || profile });
    ui.bops = run;
    ui.bopsToken += 1;
    const token = ui.bopsToken;
    paintBops();
    const plan = api.executionPlan(run);
    if (!sessionId && plan.orchestration !== 'app-fan-out') {
      try {
        const created = await root.remoteHermes.request('create-session', { profile, title: `App chat ${new Date().toLocaleString()}` });
        sessionId = created?.session?.id || created?.id || '';
        if (!sessionId) throw new Error('Hermes did not return a session id.');
      } catch (error) {
        setStatus(error.message);
        clearRun(token);
        return;
      }
      // The user moved to another agent or thread meanwhile: keep the text in
      // the composer and do not write into that other thread.
      if (!currentView(seq)) { clearRun(token); return; }
      ui.sessionId = sessionId;
    }
    ui.busy = true;
    ui.readFor = text;
    ui.readAt = Date.now();
    if (fromInput && input) input.value = '';
    const pane = $('remote-messages');
    ui.freshThread = false;
    pane?.querySelector?.('.chat-empty')?.remove?.();
    pane?.append(el('div', 'msg user', text));
    const receipt = readReceipt();
    if (receipt) pane?.append(receipt);
    paintHeader();
    if (plan.orchestration === 'app-fan-out') {
      const stop = stopControl('Stop all');
      pane?.append(stop);
      setStatus('');
      try {
        await runPlan(plan, token);
      } finally {
        stop.remove?.();
        ui.busy = false;
        setStatus('');
        paintHeader();
        flushVoice();
      }
      return;
    }
    ui.streamRaw = '';
    ui.toolEvents = false;
    ui.liveSteps = [];
    ui.liveTools = stopControl();
    ui.streaming = el('div', 'msg assistant', '');
    pane?.append(ui.streaming, ui.liveTools);
    setStatus('');
    try {
      const jobs = [root.remoteHermes.request('send', { id: sessionId, profile, input: text, ...modelSendFields() })];
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
      ui.liveTools?.remove?.();
      ui.liveTools = null;
      ui.liveSteps = [];
      setStatus('');
      paintHeader();
      // Reload only if that thread is (again) the one on screen.
      if (ui.sessionId === sessionId) await loadMessages(sessionId, ui.viewSeq).catch(() => {});
      flushVoice();
    }
  }

  function sync(next) {
    if (!root.document) return;
    wire();
    // A client tab that just finished loading may have signed in: recheck that client's jar.
    const clientTabs = (next?.tabs || []).filter((tab) => tab.client).map((tab) => `${tab.client}:${tab.loading ? 1 : 0}:${tab.url || ''}`).join('|');
    if (clientTabs !== ui.clientTabs) { ui.clientTabs = clientTabs; if (ui.sidebar === 'sessions') loadClientStatus(); }
    if (!ui.tabChosen) setSidebar('agents', { persist: false });
    $('sidebar-threads-wrap')?.classList.toggle('hidden', ui.sidebar !== 'agents');
    const remote = next?.remoteHermes || {};
    ui.keys = remote.profilesWithKeys || [];
    ui.keyless = ui.keys.length === 0;
    ui.needsSignIn = Boolean(remote.needsSignIn);
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
    ui.link = 'online';
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
    autoRefresh, startAutoRefresh, stopAutoRefresh, voiceTranscript, selectAgent, shownAgent, REFRESH_MS,
  };
});
