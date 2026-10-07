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
    { id: 'intelio', name: 'Intelio' },
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

  /** Remote mode owns the Agents list. Local Telegram / Alignment bots stay off it. */
  function chooseSidebar({ remote, localBots = [], remoteAgents = [] } = {}) {
    if (!remoteConfigured(remote)) return { source: 'local', agents: localBots.slice() };
    const live = new Map((remoteAgents || []).filter((agent) => HARNESS.some((row) => row.id === agent.id)).map((agent) => [agent.id, agent]));
    const agents = HARNESS.map((agent) => live.get(agent.id) || { id: agent.id, name: agent.name, orb: signatureOf(agent.id) });
    return { source: 'remote', agents };
  }

  function seedAgents(names, profile) {
    const stored = [...new Set((names || []).map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))];
    const named = [
      { id: 'intelio', name: 'Intelio' },
      { id: 'prc', name: 'PRC' },
      { id: 'alignment', name: 'Alignment' },
      { id: 'hhp', name: 'HHP' },
    ].filter((agent) => stored.includes(agent.id)).map((agent) => ({ ...agent, orb: signatureOf(agent.id) }));
    if (named.length) return named;
    const fallback = String(profile || 'intelio').trim().toLowerCase() || 'intelio';
    const known = { intelio: 'Intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
    return [{ id: fallback, name: known[fallback] || fallback.slice(0, 1).toUpperCase() + fallback.slice(1), orb: signatureOf(fallback) }];
  }
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

  function statusLine(id) {
    const pool = ui.allSessions.length ? ui.allSessions : (ui.selected === id ? ui.sessions : []);
    const latest = pool.filter((session) => !session.profileId || session.profileId === id).slice().sort((a, b) => sessionAt(b) - sessionAt(a))[0];
    return latest?.preview || latest?.title || '';
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
      copy.append(el('div', 'bot-name', row.name), el('div', 'bot-preview', statusLine(row.id)));
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
      const meta = el('div', 'session-meta');
      meta.append(el('span', 'source-pill', session.sourceLabel || session.source || 'session'));
      item.append(meta, el('div', 'session-title', session.title || session.id));
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
    fillSessionList($('sidebar-threads'), mine);
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
  function paintMessages() {
    const pane = $('remote-messages');
    if (!pane) return;
    pane.replaceChildren();
    const items = root.IntelioTranscript ? root.IntelioTranscript.present(ui.messages) : ui.messages.map((message) => ({ kind: 'bubble', role: message.role === 'user' ? 'user' : 'assistant', text: textOf(message.content) }));
    for (const item of items) {
      if (item.kind === 'chip') pane.append(chipNode(item));
      else if (item.kind === 'bubble' && item.text) pane.append(el('div', `msg ${item.role === 'user' ? 'user' : 'assistant'}`, item.text));
    }
    pane.scrollTop = pane.scrollHeight;
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
    const show = Boolean(view && (view.header || view.handoff || view.signIn || (view.statusLines || []).length || view.pills.length > 1));
    bar.classList.toggle('hidden', !show);
    const header = $('bops-header');
    if (header) header.textContent = view?.header || '';
    const stop = $('bops-stop');
    if (stop) {
      stop.classList.toggle('hidden', !view?.stopAll);
      stop.onclick = () => stopBops();
    }
    const pills = $('bops-pills');
    if (pills) {
      pills.replaceChildren();
      for (const pill of view?.pills || []) {
        const button = el('button', `bops-pill${pill.focused ? ' focused' : ''}`, pill.title);
        button.type = 'button';
        button.dataset.taskId = pill.id;
        button.dataset.status = pill.status;
        button.onclick = () => focusBops(pill.id);
        pills.append(button);
      }
    }
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
      badge.classList.toggle('hidden', !show);
      badge.textContent = show ? preview.badge : '';
    }
    const chrome = $('preview-chrome');
    if (chrome && preview && show) {
      chrome.dataset.highlight = preview.highlight;
      chrome.style.boxShadow = `inset 0 0 0 2px ${preview.highlight}`;
    }
    const screen = $('preview-screen');
    if (screen && preview) screen.dataset.taskId = show ? preview.taskId : '';
    const live = $('preview-live');
    if (live) live.textContent = show ? (preview.caption || '') : '';
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
    const button = $('remote-call');
    if (!api || !pill) return;
    const text = api.callPill(ui.call);
    pill.classList.toggle('hidden', !text);
    pill.textContent = text;
    if (button) button.textContent = ui.call?.active ? 'End' : 'Call';
  }

  function stopMic() {
    for (const track of ui.mic?.getTracks?.() || []) track.stop();
    ui.mic = null;
    if (ui.callTimer) clearInterval(ui.callTimer);
    ui.callTimer = null;
  }

  function toggleCall() {
    const api = callsApi();
    if (!api) return;
    if (ui.call?.active) {
      ui.call = api.endCall(ui.call, Date.now());
      stopMic();
    } else {
      ui.call = api.startCall(Date.now());
      const media = root.navigator?.mediaDevices;
      if (media?.getUserMedia) media.getUserMedia({ audio: true }).then((stream) => { ui.mic = stream; }).catch(() => {});
      ui.callTimer = setInterval(() => {
        if (!ui.call?.active) return;
        ui.call = api.tickCall(ui.call, Date.now());
        paintCall();
      }, 500);
    }
    paintCall();
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

  async function openSession(id) {
    ui.sessionId = id;
    paintSessions();
    const input = $('remote-input');
    const send = $('remote-send');
    if (input) input.disabled = false;
    if (send) send.disabled = false;
    try { await loadMessages(id); } catch (error) { setStatus(error.message); showProfileError(error.message); }
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
      const option = el('option', '', agent.name || agent.id);
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
      const name = agent?.name || session.profileId || 'Agent';
      const item = el('li', `all-session${session.id === ui.sessionId && session.profileId === ui.selected ? ' active' : ''}`);
      item.dataset.profile = session.profileId || '';
      item.dataset.sessionId = session.id || '';
      const avatar = el('span', 'avatar');
      const canvas = el('canvas');
      mountOrb(canvas, session.profileId || name, agent?.orb || signatureOf(session.profileId), 28, true);
      avatar.append(canvas);
      const copy = el('span', 'all-session-copy');
      const top = el('span', 'all-session-top');
      top.append(el('span', 'agent-name', name), el('span', 'source-pill', session.sourceLabel || session.source || 'session'));
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
      else setStatus('No sessions for this agent yet. Send a message to start one.');
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
    const call = $('remote-call');
    if (call) call.onclick = () => toggleCall();
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
        if (!ui.toolEvents && ui.liveTools && root.IntelioTranscript) {
          ui.liveTools.replaceChildren(...peeled.chips.map((part) => chipNode(root.IntelioTranscript.present([{ role: 'tool', tool_name: part.name, content: part.detail || '' }])[0])).filter(Boolean));
        }
      } else if (String(event).includes('tool')) {
        ui.toolEvents = true;
        const name = data?.tool_name || data?.name || 'tool';
        const done = /complete|result|finished|fail/i.test(event);
        const failed = /fail/i.test(event);
        if (ui.liveTools && root.IntelioTranscript) {
          if (done) ui.liveTools.querySelector('.tool-chip.running')?.closest('.tool-run')?.remove();
          const item = root.IntelioTranscript.present([{ role: 'tool', tool_name: name, content: data?.summary || data?.error || '', status: failed ? 'Failed' : (done ? 'Done' : 'Running') }])[0];
          if (item) ui.liveTools.append(chipNode(item));
        }
        setStatus(done ? '' : `Checking ${name}…`);
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
    input.value = '';
    const pane = $('remote-messages');
    pane?.append(el('div', 'msg user', text));
    if (plan.orchestration === 'app-fan-out') {
      pane?.append(el('div', 'msg assistant', plan.header || `Working on ${run.tasks.length} things`));
      setStatus(plan.header);
      try {
        await runPlan(plan, token);
      } finally {
        ui.busy = false;
        setStatus('');
      }
      return;
    }
    ui.streamRaw = '';
    ui.toolEvents = false;
    ui.liveTools = el('div', 'tool-live');
    ui.streaming = el('div', 'msg assistant', '');
    pane?.append(ui.liveTools, ui.streaming);
    setStatus('Thinking…');
    try {
      const jobs = [root.remoteHermes.request('send', { id: ui.sessionId, profile: ui.selected, input: text })];
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
      ui.busy = false;
      ui.streaming = null;
      setStatus('');
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
    const host = $('intelio-profile');
    if (host) host.textContent = 'VPS Hermes · sample';
    const pin = $('hermes-pin');
    if (pin) pin.textContent = 'SAMPLE DATA · remote main window';
    return selectAgent(agent);
  }

  return {
    signatureOf, accentOf, switcherRows, seedAgents, remoteConfigured, chooseSidebar, sessionAt, sessionRows, SAMPLE,
    sync, filter, setSidebar, sidebar: () => ui.sidebar, refresh, mountSample, selectedName: () => selectedAgent()?.name || '', selectedId: () => ui.selected || '',
    presentBops, focusBops, stopBops, actBops, pushFrame, toggleCall, bopsEffect: () => ui.lastEffect,
  };
});
