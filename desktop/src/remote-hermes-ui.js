/** Remote Hermes (VPS) chat window. All network traffic goes through the main process (window.remoteHermes). */
(function remoteHermesUi() {
  const api = window.remoteHermes;
  const $ = (id) => document.getElementById(id);
  const state = { sessions: [], activeId: '', busy: false, streaming: null, streamRaw: '', liveTools: null, toolEvents: false, timer: null };
  const SOURCE_LABEL = { telegram: 'Telegram', api_server: 'App / API', cli: 'CLI', cron: 'Cron', oneshot: 'One-shot' };

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
    if (!s.hasKey) { status(`No API key saved for profile "${s.profile || 'default'}". Add it in Settings.`); return false; }
    status(`${s.profile || 'default'} @ ${s.host}:${s.port} (Tailscale)`);
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
      item.append(el('div', 'source', `${SOURCE_LABEL[session.source] || session.source || 'session'} · ${when(session.started_at)}`), el('div', '', session.title || session.id));
      item.onclick = () => openSession(session.id);
      list.append(item);
    }
    if (!state.sessions.length) list.append(el('li', 'muted', 'No sessions yet.'));
  }

  function chipNode(item) {
    const wrap = el('div', 'tool-run');
    const button = el('button', `tool-chip${item.running ? ' running' : ''}${item.failed ? ' failed' : ''}`);
    button.type = 'button';
    button.append(el('span', 'mark', item.running ? '' : (item.failed ? '!' : '✓')));
    button.append(document.createTextNode(` ${item.label}`));
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

  function renderPresented(messages) {
    const pane = $('rh-messages');
    pane.replaceChildren();
    const items = window.IntelioTranscript
      ? window.IntelioTranscript.present(messages)
      : messages.map((message) => ({ kind: 'bubble', role: message.role === 'user' ? 'user' : 'assistant', text: textOf(message.content) }));
    for (const item of items) {
      if (item.kind === 'chip') pane.append(chipNode(item));
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
    $('rh-title').textContent = session ? `${session.title || session.id} · ${SOURCE_LABEL[session.source] || session.source}` : id;
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
    const pane = $('rh-messages');
    pane.append(el('div', 'msg user', input));
    state.liveTools = el('div', 'tool-live');
    state.streaming = el('div', 'msg assistant', '');
    pane.append(state.liveTools, state.streaming);
    $('rh-activity').textContent = 'Thinking…';
    try {
      await api.request('send', { id: state.activeId, input });
    } catch (error) {
      state.streaming.append(document.createTextNode(`\n[${error.message}]`));
    } finally {
      state.busy = false; state.streaming = null; $('rh-send').disabled = false; $('rh-cancel').hidden = true; $('rh-activity').textContent = '';
      await loadMessages().catch(() => {}); loadSessions();
    }
  }

  api.onEvent(({ sessionId, event, data }) => {
    if (sessionId !== state.activeId || !state.streaming) return;
    if (event === 'assistant.delta' && typeof data?.delta === 'string') {
      state.streamRaw = `${state.streamRaw || ''}${data.delta}`;
      const peeled = window.IntelioTranscript ? window.IntelioTranscript.peel(state.streamRaw) : { prose: state.streamRaw, chips: [] };
      state.streaming.textContent = peeled.prose;
      if (!state.toolEvents && state.liveTools && window.IntelioTranscript) {
        state.liveTools.replaceChildren(...peeled.chips.map((part) => chipNode(window.IntelioTranscript.present([{ role: 'tool', tool_name: part.name, content: part.detail || '' }])[0])).filter(Boolean));
      }
    } else if (String(event).includes('tool')) {
      state.toolEvents = true;
      const name = data?.tool_name || data?.name || 'tool';
      const done = /complete|result|finished|fail/i.test(event);
      const failed = /fail/i.test(event);
      if (state.liveTools && window.IntelioTranscript) {
        if (done) state.liveTools.querySelector('.tool-chip.running')?.closest('.tool-run')?.remove();
        const item = window.IntelioTranscript.present([{ role: 'tool', tool_name: name, content: data?.summary || data?.error || '', status: failed ? 'Failed' : (done ? 'Done' : 'Running') }])[0];
        if (item) state.liveTools.append(chipNode(item));
      }
      $('rh-activity').textContent = done ? 'Thinking…' : `Checking ${name}…`;
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
