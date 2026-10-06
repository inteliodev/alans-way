/** Remote Hermes (VPS) chat window. All network traffic goes through the main process (window.remoteHermes). */
(function remoteHermesUi() {
  const api = window.remoteHermes;
  const $ = (id) => document.getElementById(id);
  const state = { sessions: [], activeId: '', busy: false, streaming: null, timer: null };
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

  function renderMessage(role, text, meta) {
    const box = el('div', `msg ${role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'assistant'}`);
    if (meta) box.append(el('span', 'meta', meta));
    box.append(document.createTextNode(text));
    $('rh-messages').append(box);
    return box;
  }

  async function loadMessages({ keepScroll = false } = {}) {
    if (!state.activeId || state.busy) return;
    const pane = $('rh-messages');
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    const result = await api.request('messages', { id: state.activeId });
    pane.replaceChildren();
    for (const message of result?.data || []) {
      if (!['user', 'assistant', 'tool'].includes(message.role)) continue;
      const text = textOf(message.content);
      if (!text && message.role !== 'tool') continue;
      renderMessage(message.role, message.role === 'tool' ? `${message.tool_name || 'tool'}: ${text.slice(0, 400)}` : text, message.role === 'tool' ? '' : when(message.timestamp));
    }
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
    renderMessage('user', input, 'you · app');
    state.streaming = renderMessage('assistant', '', 'Hermes (VPS)');
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
    if (event === 'assistant.delta' && typeof data?.delta === 'string') state.streaming.append(document.createTextNode(data.delta));
    else if (event === 'tool.started') $('rh-activity').textContent = `Running ${data?.tool_name || data?.name || 'tool'}…`;
    else if (event === 'tool.completed' || event === 'tool.failed') $('rh-activity').textContent = 'Thinking…';
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
