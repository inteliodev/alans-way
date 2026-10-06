/** Main-window Remote Hermes: profile orbs, sessions, and streaming chat. */
(function intelioRemote(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.IntelioRemote = api;
})(typeof window !== 'undefined' ? window : globalThis, function intelioRemoteFactory() {
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
    hhp: '#d97706',
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
      return { id: agent.id, name: agent.name || agent.id, orb, subtitle: orb, selected: agent.id === selected };
    });
  }

  const SAMPLE = {
    label: 'SAMPLE DATA',
    agents: [
      { id: 'intelio', name: 'Intelio', orb: 'connecting' },
      { id: 'prc', name: 'PRC', orb: 'solving' },
      { id: 'alignment', name: 'Alignment', orb: 'searching' },
      { id: 'hhp', name: 'HHP', orb: 'weaving' },
    ],
    sessions: [
      { id: 'sample-photon', profileId: 'intelio', source: 'photon', sourceLabel: 'photon/iMessage', title: 'Friday notes', preview: 'SAMPLE DATA · Need your yes on the Friday all-hands deck.' },
      { id: 'sample-telegram', profileId: 'prc', source: 'telegram', sourceLabel: 'Telegram', title: 'Outreach', preview: 'SAMPLE DATA · 8 intros drafted — sitting in the CRM.' },
      { id: 'sample-api', profileId: 'alignment', source: 'api_server', sourceLabel: 'API', title: 'Website launch', preview: 'SAMPLE DATA · Checkout is clean on staging.' },
      { id: 'sample-once', profileId: 'hhp', source: 'oneshot', sourceLabel: 'One-shot', title: 'Acme check-in', preview: 'SAMPLE DATA · Drafted a Thursday check-in.' },
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
    sessions: [],
    messages: [],
    selected: '',
    sessionId: '',
    query: '',
    stamp: '',
    sample: false,
    label: '',
    busy: false,
    wired: false,
    streaming: null,
  };

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
  function setStatus(text) { const node = $('remote-status'); if (node) node.textContent = text || ''; }
  function selectedAgent() { return ui.agents.find((agent) => agent.id === ui.selected) || null; }

  function mountOrb(canvas, id, orb, px, paused) {
    canvas.width = px;
    canvas.height = px;
    canvas.className = 'orb';
    canvas.dataset.profile = id;
    if (root.ThinkingOrbs) {
      root.ThinkingOrbs.mount(canvas, { state: orb, display: px, size: 64, paused, speed: paused ? 1 : 0.42, accent: accentOf(id) });
    }
  }

  function paintHeader() {
    const agent = selectedAgent();
    const title = $('chat-title');
    if (title) title.textContent = agent ? agent.name : 'VPS Hermes';
    const avatar = $('chat-avatar');
    if (avatar && agent) {
      avatar.replaceChildren();
      const canvas = el('canvas');
      mountOrb(canvas, agent.id, agent.orb || signatureOf(agent.id), 28, false);
      avatar.append(canvas);
      avatar.title = agent.name;
    }
  }

  function paintAgents() {
    const list = $('bot-list');
    if (!list) return;
    const rows = switcherRows(ui.agents, { query: ui.query, selected: ui.selected });
    list.replaceChildren();
    for (const row of rows) {
      const node = el('div', `bot-row${row.selected ? ' selected' : ''}`);
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.dataset.botId = row.id;
      node.setAttribute('aria-label', `Open ${row.name}`);
      const avatar = el('span', 'avatar');
      const canvas = el('canvas');
      mountOrb(canvas, row.id, row.orb, 36, true);
      avatar.append(canvas);
      const copy = el('span', 'bot-copy');
      copy.append(el('div', 'bot-name', row.name), el('div', 'bot-preview', row.subtitle));
      node.append(avatar, copy);
      node.onclick = () => selectAgent(row.id);
      node.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectAgent(row.id); } };
      list.append(node);
    }
    const count = $('bot-count');
    if (count) count.textContent = String(rows.length);
    const empty = $('empty-bots');
    if (empty) {
      empty.classList.toggle('hidden', rows.length > 0);
      const heading = empty.querySelector('h3');
      const note = empty.querySelector('p');
      if (heading) heading.textContent = 'Agents on the VPS';
      if (note) note.textContent = ui.agents.length ? 'No agents match that search.' : 'Loading agents from Hermes…';
    }
    paintHeader();
  }

  function paintSessions() {
    const list = $('remote-sessions');
    if (!list) return;
    const mine = ui.sessions.filter((session) => !session.profileId || session.profileId === ui.selected);
    list.replaceChildren();
    for (const session of mine) {
      const item = el('li', `session-item${session.id === ui.sessionId ? ' active' : ''}`);
      const meta = el('div', 'session-meta');
      meta.append(el('span', 'source-pill', session.sourceLabel || session.source || 'session'));
      item.append(meta, el('div', 'session-title', session.title || session.id));
      if (session.preview) item.append(el('div', 'session-preview', session.preview));
      item.onclick = () => openSession(session.id);
      list.append(item);
    }
    if (!mine.length) list.append(el('li', 'session-empty', 'No sessions yet.'));
  }

  function paintMessages() {
    const pane = $('remote-messages');
    if (!pane) return;
    pane.replaceChildren();
    for (const message of ui.messages) {
      if (!['user', 'assistant', 'tool'].includes(message.role)) continue;
      const text = textOf(message.content);
      if (!text) continue;
      const box = el('div', `msg ${message.role === 'user' ? 'user' : 'assistant'}`, message.role === 'tool' ? text.slice(0, 400) : text);
      pane.append(box);
    }
    pane.scrollTop = pane.scrollHeight;
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

  async function openSession(id) {
    ui.sessionId = id;
    paintSessions();
    const input = $('remote-input');
    const send = $('remote-send');
    if (input) input.disabled = false;
    if (send) send.disabled = false;
    try { await loadMessages(id); } catch (error) { setStatus(error.message); }
  }

  async function selectAgent(id) {
    ui.selected = id;
    ui.sessionId = '';
    ui.messages = [];
    paintAgents();
    paintMessages();
    const keys = ui.keys || [];
    if (!ui.sample && keys.length && !keys.includes(id)) {
      ui.sessions = [];
      paintSessions();
      setStatus(`No key saved for ${id}.`);
      const input = $('remote-input');
      if (input) input.disabled = true;
      return;
    }
    setStatus('');
    if (ui.sample) {
      ui.sessions = SAMPLE.sessions.filter((session) => session.profileId === id);
      paintSessions();
      if (ui.sessions[0]) await openSession(ui.sessions[0].id);
      return;
    }
    try {
      const result = await root.remoteHermes.request('sessions', { profile: id, limit: 100 });
      ui.sessions = Array.isArray(result?.data) ? result.data : [];
      paintSessions();
      if (ui.sessions[0]) await openSession(ui.sessions[0].id);
      else setStatus('No sessions for this agent yet. Send a message to start one.');
    } catch (error) { setStatus(error.message); }
  }

  async function refresh() {
    if (ui.sample || !root.remoteHermes) return;
    try {
      const home = await root.remoteHermes.request('agents');
      ui.agents = home?.agents || [];
      ui.sample = Boolean(home?.sample);
      ui.label = home?.label || '';
      paintBanner();
      if (!ui.selected || !ui.agents.some((agent) => agent.id === ui.selected)) ui.selected = ui.agents[0]?.id || '';
      paintAgents();
      if (ui.selected) await selectAgent(ui.selected);
    } catch (error) { setStatus(error.message); }
  }

  function wire() {
    if (ui.wired || !root.document) return;
    ui.wired = true;
    const form = $('remote-composer');
    form?.addEventListener('submit', send);
    $('remote-input')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
    });
    root.remoteHermes?.onEvent?.(({ sessionId, event, data }) => {
      if (sessionId !== ui.sessionId || !ui.streaming) return;
      if (event === 'assistant.delta' && typeof data?.delta === 'string') ui.streaming.append(root.document.createTextNode(data.delta));
      else if (event === 'tool.started') setStatus(`Running ${data?.tool_name || data?.name || 'tool'}…`);
      const pane = $('remote-messages');
      if (pane) pane.scrollTop = pane.scrollHeight;
    });
  }

  async function send(event) {
    event?.preventDefault?.();
    const input = $('remote-input');
    const text = input?.value.trim();
    if (!text || ui.busy || ui.sample) return;
    if (!ui.sessionId) {
      try {
        const created = await root.remoteHermes.request('create-session', { profile: ui.selected, title: `App chat ${new Date().toLocaleString()}` });
        ui.sessionId = created?.session?.id || created?.id || '';
        if (!ui.sessionId) throw new Error('Hermes did not return a session id.');
      } catch (error) { setStatus(error.message); return; }
    }
    ui.busy = true;
    input.value = '';
    const pane = $('remote-messages');
    pane?.append(el('div', 'msg user', text));
    ui.streaming = el('div', 'msg assistant', '');
    pane?.append(ui.streaming);
    setStatus('Thinking…');
    try {
      await root.remoteHermes.request('send', { id: ui.sessionId, profile: ui.selected, input: text });
    } catch (error) {
      ui.streaming.append(root.document.createTextNode(`\n[${error.message}]`));
    } finally {
      ui.busy = false;
      ui.streaming = null;
      setStatus('');
      await loadMessages(ui.sessionId).catch(() => {});
    }
  }

  function sync(next) {
    if (!root.document) return;
    wire();
    const remote = next?.remoteHermes || {};
    ui.keys = remote.profilesWithKeys || [];
    const stamp = `${remote.host}|${remote.port}|${[...ui.keys].sort().join(',')}`;
    const search = $('bot-search');
    ui.query = search && !search.classList.contains('hidden') ? search.value : ui.query;
    if (!ui.agents.length) paintAgents();
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
    const host = $('intelio-profile');
    if (host) host.textContent = 'VPS Hermes · sample';
    const pin = $('hermes-pin');
    if (pin) pin.textContent = 'SAMPLE DATA · remote main window';
    return selectAgent(agent);
  }

  return { signatureOf, accentOf, switcherRows, SAMPLE, sync, filter, refresh, mountSample, selectedName: () => selectedAgent()?.name || '' };
});
