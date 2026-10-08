/** Remote Hermes (VPS) chat window. All network traffic goes through the main process (window.remoteHermes). */
(function remoteHermesUi() {
  const api = window.remoteHermes;
  const $ = (id) => document.getElementById(id);
  const state = { sessions: [], activeId: '', busy: false, streaming: null, streamRaw: '', liveTools: null, liveSteps: [], toolEvents: false, timer: null };
  function visibleName(raw) {
    const value = String(raw || '').trim();
    const known = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
    return known[value.toLowerCase()] || value;
  }

  function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
  function status(text) { $('rh-status').textContent = text; }
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || (part?.type?.includes('image') ? '[image]' : ''))).filter(Boolean).join('\n');
    return content == null ? '' : JSON.stringify(content);
  }
  function when(ts) { const n = Number(ts); return n ? new Date(n * 1000).toLocaleString() : ''; }

  async function loadState() {
    const s = await api.request('state');
    if (!s.host) { status('Set the VPS host in Settings → Remote Hermes (VPS).'); return false; }
    if (!s.hasKey) { status(`No API key saved for profile "${visibleName(s.profile || 'default')}". Add it in Settings.`); return false; }
    status(`${visibleName(s.profile || 'default')} @ ${s.host}:${s.port} (Tailscale)`);
    return true;
  }

  async function loadSessions() {
    try {
      const result = await api.request('sessions', { source: $('rh-source').value, limit: 100 });
      state.sessions = Array.isArray(result?.data) ? result.data : [];
      renderSessions();
    } catch (error) { status(error.message); }
  }

  function renderSessions() {
    const list = $('rh-sessions');
    list.replaceChildren();
    for (const session of state.sessions) {
      const item = el('li', session.id === state.activeId ? 'active' : '');
      const whenText = when(session.started_at);
      item.append(el('div', '', session.title || session.id));
      if (whenText) item.append(el('div', 'muted', whenText));
      item.onclick = () => openSession(session.id);
      list.append(item);
    }
    if (!state.sessions.length) list.append(el('li', 'muted', 'No sessions yet.'));
  }

  /** Agent work is one typing bubble with a short status; tool steps are not listed. */
  function typingNode(status = '') {
    const wrap = el('div', 'msg assistant typing-bubble');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'The agent is working');
    const dots = el('span', 'think-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    const line = el('span', 'typing-status', status);
    line.hidden = !status;
    wrap.append(dots, line);
    wrap.statusLine = line;
    return wrap;
  }

  function paintLive() {
    const line = state.liveTools?.statusLine;
    if (!line || !window.IntelioTranscript?.typingStatus) return;
    const status = window.IntelioTranscript.typingStatus(state.liveSteps || []);
    line.textContent = status;
    line.hidden = !status;
  }

  function renderPresented(messages) {
    const pane = $('rh-messages');
    pane.replaceChildren();
    const items = window.IntelioTranscript?.conversation
      ? window.IntelioTranscript.conversation(messages)
      : messages.map((message) => ({ kind: 'bubble', role: message.role === 'user' ? 'user' : 'assistant', text: textOf(message.content) }));
    for (const item of items) {
      if (item.kind === 'typing') pane.append(typingNode(item.status || ''));
      else if (item.kind === 'bubble' && item.text) pane.append(el('div', `msg ${item.role === 'user' ? 'user' : 'assistant'}`, item.text));
    }
  }

  async function loadMessages({ keepScroll = false } = {}) {
    if (!state.activeId || state.busy) return;
    const pane = $('rh-messages');
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    const result = await api.request('messages', { id: state.activeId });
    renderPresented((result?.data || []).filter((message) => ['user', 'assistant', 'tool'].includes(message.role)));
    if (!keepScroll || atBottom) pane.scrollTop = pane.scrollHeight;
  }

  async function openSession(id) {
    state.activeId = id;
    const session = state.sessions.find((s) => s.id === id);
    $('rh-title').textContent = session ? (session.title || session.id) : id;
    $('rh-input').disabled = false; $('rh-send').disabled = false;
    renderSessions();
    try { await loadMessages(); } catch (error) { status(error.message); }
  }

  async function send(event) {
    event.preventDefault();
    const input = $('rh-input').value.trim();
    if (!input || !state.activeId || state.busy) return;
    state.busy = true; $('rh-send').disabled = true; $('rh-cancel').hidden = false; $('rh-input').value = '';
    state.streamRaw = '';
    state.toolEvents = false;
    state.liveSteps = [];
    const pane = $('rh-messages');
    pane.append(el('div', 'msg user', input));
    state.liveTools = typingNode();
    state.streaming = el('div', 'msg assistant', '');
    pane.append(state.streaming, state.liveTools);
    $('rh-activity').textContent = 'Thinking…';
    try {
      await api.request('send', { id: state.activeId, input });
    } catch (error) {
      state.streaming.append(document.createTextNode(`\n[${error.message}]`));
    } finally {
      state.busy = false; state.streaming = null; state.liveTools?.remove(); state.liveTools = null; $('rh-send').disabled = false; $('rh-cancel').hidden = true; $('rh-activity').textContent = '';
      await loadMessages().catch(() => {}); loadSessions();
    }
  }

  api.onEvent(({ sessionId, event, data }) => {
    if (sessionId !== state.activeId || !state.streaming) return;
    if (event === 'assistant.delta' && typeof data?.delta === 'string') {
      state.streamRaw = `${state.streamRaw || ''}${data.delta}`;
      const peeled = window.IntelioTranscript ? window.IntelioTranscript.peel(state.streamRaw) : { prose: state.streamRaw, chips: [] };
      state.streaming.textContent = peeled.prose;
      if (!state.toolEvents) {
        state.liveSteps = peeled.chips.map((part) => ({ name: part.name, detail: part.detail || '', running: false, failed: false }));
        paintLive();
      }
    } else if (String(event).includes('tool')) {
      if (!state.toolEvents) state.liveSteps = [];
      state.toolEvents = true;
      const name = data?.tool_name || data?.name || 'tool';
      const done = /complete|result|finished|fail/i.test(event);
      const failed = /fail/i.test(event);
      const detail = data?.summary || data?.error || '';
      if (done) {
        const open = [...state.liveSteps].reverse().find((step) => step.running && step.name === name);
        if (open) { open.running = false; open.failed = failed; if (detail) open.detail = detail; }
        else state.liveSteps.push({ name, detail, running: false, failed });
      } else state.liveSteps.push({ name, detail, running: true, failed: false });
      paintLive();
      $('rh-activity').textContent = done ? 'Thinking…' : 'Checking…';
    }
    $('rh-messages').scrollTop = $('rh-messages').scrollHeight;
  });

  async function newSession() {
    try {
      const result = await api.request('create-session', { title: `App chat ${new Date().toLocaleString()}` });
      const id = result?.session?.id || result?.id;
      await loadSessions();
      if (id) await openSession(id);
    } catch (error) { status(error.message); }
  }

  $('rh-composer').addEventListener('submit', send);
  $('rh-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event); });
  $('rh-cancel').onclick = () => api.request('cancel', { id: state.activeId });
  $('rh-new').onclick = newSession;
  $('rh-source').onchange = loadSessions;

  (async () => {
    if (!(await loadState().catch((error) => { status(error.message); return false; }))) return;
    await loadSessions();
    // Telegram (and other clients) write to the same VPS sessions; poll so their turns show up here.
    state.timer = setInterval(() => { loadSessions(); loadMessages({ keepScroll: true }).catch(() => {}); }, 8000);
  })();
}());
