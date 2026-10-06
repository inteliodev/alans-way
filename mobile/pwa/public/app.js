/** Intelio phone client. The Hermes API key is not in this file; the tailnet service holds the session. */
(function intelioPhone() {
  const app = document.getElementById('app');
  const back = document.getElementById('back');
  const SOURCE = { '': 'All', telegram: 'Telegram', api_server: 'App', cli: 'CLI', cron: 'Cron' };
  const state = { source: '', sessionId: '', sessions: [], busy: false };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    if (response.status === 401) { showLogin(); throw new Error('Sign in again.'); }
    if (!response.ok) throw new Error((await response.text()).slice(0, 240) || `HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    return type.includes('json') ? response.json() : response;
  }
  function textOf(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).filter(Boolean).join('\n');
    return content == null ? '' : JSON.stringify(content);
  }

  function showLogin(message) {
    back.hidden = true;
    app.replaceChildren();
    const panel = el('section', 'panel');
    panel.append(el('h1', '', 'Remote Hermes'));
    panel.append(el('p', 'muted', 'Same sessions as Telegram, the desktop app, and the CLI. This page talks only to the tailnet.'));
    const label = el('label', '', 'Profile API key');
    label.htmlFor = 'key';
    const input = el('input');
    input.id = 'key';
    input.type = 'password';
    input.autocomplete = 'current-password';
    input.spellcheck = false;
    const button = el('button', 'primary', 'Continue');
    button.type = 'button';
    const error = el('p', 'error', message || '');
    button.onclick = async () => {
      error.textContent = '';
      button.disabled = true;
      try {
        await api('/session', { method: 'POST', body: JSON.stringify({ key: input.value }) });
        input.value = '';
        await showSessions();
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
      }
    };
    const hint = el('div', 'hint');
    hint.append(el('p', '', 'Add to Home Screen'));
    hint.append(el('p', 'muted', 'iPhone: Share, then Add to Home Screen. Android: browser menu, then Install app or Add to Home screen. Use the tailnet HTTPS address when you want the installed icon; the key still stays in the server session, not in this page.'));
    panel.append(label, input, button, error, hint);
    app.append(panel);
    input.focus();
  }

  async function showSessions() {
    state.sessionId = '';
    back.hidden = true;
    app.replaceChildren();
    const filters = el('div', 'filters');
    for (const [value, label] of Object.entries(SOURCE)) {
      const button = el('button', value === state.source ? 'on' : '', label);
      button.type = 'button';
      button.onclick = () => { state.source = value; showSessions(); };
      filters.append(button);
    }
    const list = el('ul');
    const error = el('p', 'error panel', '');
    app.append(filters, list, error);
    try {
      const query = state.source ? `?source=${encodeURIComponent(state.source)}` : '';
      const result = await api(`/api/sessions${query}`);
      state.sessions = Array.isArray(result?.data) ? result.data : [];
      if (!state.sessions.length) list.append(el('li', 'muted', 'No sessions yet.'));
      for (const session of state.sessions) {
        const item = el('li');
        item.append(el('div', 'source', SOURCE[session.source] || session.source || 'session'), el('div', '', session.title || session.id));
        item.onclick = () => showChat(session);
        list.append(item);
      }
    } catch (err) { error.textContent = err.message; }
  }

  async function showChat(session) {
    state.sessionId = session.id;
    back.hidden = false;
    app.replaceChildren();
    const chat = el('section', 'chat');
    const title = el('p', 'panel muted', `${session.title || session.id} · ${SOURCE[session.source] || session.source || 'session'}`);
    title.style.margin = '0';
    const messages = el('div', 'messages');
    const error = el('p', 'error', '');
    error.style.padding = '0 12px';
    const form = el('form', 'composer');
    const input = el('textarea');
    input.rows = 2;
    input.placeholder = 'Message Hermes…';
    const send = el('button', 'primary', 'Send');
    send.type = 'submit';
    send.style.width = 'auto';
    form.append(input, send);
    chat.append(title, messages, error, form);
    app.append(chat);

    function bubble(role, text) {
      const node = el('div', `msg ${role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'assistant'}`, text);
      messages.append(node);
      messages.scrollTop = messages.scrollHeight;
      return node;
    }
    try {
      const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`);
      for (const message of result?.data || []) {
        if (!['user', 'assistant', 'tool'].includes(message.role)) continue;
        const text = textOf(message.content);
        if (!text) continue;
        bubble(message.role, message.role === 'tool' ? `${message.tool_name || 'tool'}: ${text.slice(0, 400)}` : text);
      }
    } catch (err) { error.textContent = err.message; }

    form.onsubmit = async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || state.busy) return;
      state.busy = true;
      input.value = '';
      send.disabled = true;
      bubble('user', text);
      const live = bubble('assistant', '');
      error.textContent = '';
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/chat`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ input: text }),
        });
        if (response.status === 401) { showLogin(); return; }
        if (!response.ok || !response.body) throw new Error((await response.text()).slice(0, 240) || `HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          buffer += decoder.decode(step.value, { stream: true });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const raw = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            let name = 'message';
            const data = [];
            for (const line of raw.split(/\r?\n/)) {
              if (!line || line.startsWith(':')) continue;
              const colon = line.indexOf(':');
              const field = colon === -1 ? line : line.slice(0, colon);
              const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
              if (field === 'event') name = value;
              else if (field === 'data') data.push(value);
            }
            if (!data.length) continue;
            let parsed = data.join('\n');
            try { parsed = JSON.parse(parsed); } catch { /* keep text */ }
            if (name === 'assistant.delta' && typeof parsed?.delta === 'string') live.append(document.createTextNode(parsed.delta));
            else if (name === 'run.failed') throw new Error(String(parsed?.error || parsed?.message || 'Hermes run failed').slice(0, 240));
            messages.scrollTop = messages.scrollHeight;
          }
        }
      } catch (err) { error.textContent = err.message; }
      finally { state.busy = false; send.disabled = false; }
    };
  }

  back.onclick = () => showSessions();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  api('/session').then((me) => { if (me?.ok) return showSessions(); return showLogin(); }).catch(() => showLogin());
}());
