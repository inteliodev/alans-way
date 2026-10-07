/**
 * Web transport for the desktop window served at /desktop/.
 * Profile keys stay on the server. A JSON 401 or 403 is a profile error.
 * Only an HTML challenge or a redirect opens the sign-in state.
 */
(function intelioDesktopTransport() {
  const stateListeners = [];
  const eventListeners = [];
  const inflight = new Map();
  let homeCache = null;
  let rfb = null;
  let vncStarting = false;
  let vncTried = false;

  function readTheme() {
    try { return localStorage.getItem('intelio-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  }
  function readGrid() {
    try {
      const n = Number(localStorage.getItem('intelio-screen-grid'));
      return [1, 2, 3, 4].includes(n) ? n : 1;
    } catch { return 1; }
  }
  function readScreen() {
    try {
      const n = Number(localStorage.getItem('intelio-active-screen'));
      return Number.isInteger(n) && n >= 0 && n < 4 ? n : 0;
    } catch { return 0; }
  }
  function hostLabels() {
    const platform = /Windows/i.test(navigator.userAgent) ? 'win32' : (/Mac/i.test(navigator.userAgent) ? 'darwin' : 'linux');
    if (window.IntelioHost && typeof window.IntelioHost.hostLabels === 'function') return window.IntelioHost.hostLabels(platform);
    return { pane: 'This computer', browse: 'Browse on this computer.', controlLocal: 'this computer', statusLocal: 'Computer' };
  }
  function baseState() {
    return {
      name: 'intelio',
      version: '0.3.19',
      intelio: { ok: true, profileName: 'intelio', brand: { mark: '/icon-192.png' }, hermes: {} },
      bots: [],
      order: [],
      hidden: [],
      selectedBotId: '',
      chatWidth: 490,
      preview: false,
      previewPos: null,
      showBots: true,
      showBrowser: true,
      remoteUrl: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/browser/websockify`,
      remoteStatus: 'connecting',
      remoteControl: false,
      telegramStatus: 'offline',
      tabs: [],
      vpsBrowser: {},
      vpsBrowserStatus: '',
      handoffs: [],
      macSshHost: '',
      primaryBotId: '',
      primaryBotPref: '',
      overseerBots: [],
      botSort: 'manual',
      autoOpenLinks: false,
      activeTabId: 'vps',
      browserContentsId: null,
      browserTabId: 'home',
      avatarLibrary: [],
      avatarPreferences: {},
      locationDefault: 'ask',
      sitePermissions: {},
      extensions: [],
      fullscreen: false,
      api: { url: location.origin, ready: true, error: '' },
      remoteHermesNotice: '',
      remoteHermes: {
        enabled: true,
        host: location.hostname,
        port: location.protocol === 'https:' ? 443 : (Number(location.port) || 80),
        activeMode: 'cloud',
        connection: 'cloud',
        profile: 'intelio',
        profilesWithKeys: [],
        needsSignIn: false,
        versionLabel: 'VPS Hermes',
      },
      hermesStatus: { done: true, label: 'VPS Hermes' },
      sidebarTab: 'agents',
      screenGrid: readGrid(),
      activeScreen: readScreen(),
      platform: 'linux',
      host: hostLabels(),
      theme: readTheme(),
    };
  }
  const state = baseState();

  function publish() {
    for (const fn of stateListeners) {
      try { fn(state); } catch { /* the renderer reports its own errors */ }
    }
    return state;
  }
  function markSignIn() {
    state.remoteHermes.needsSignIn = true;
    publish();
  }
  function sourceLabel(source) {
    const value = String(source || '').trim().toLowerCase();
    if (value === 'photon' || value === 'imessage' || value === 'photon/imessage') return 'photon/iMessage';
    if (value === 'telegram') return 'Telegram';
    if (value === 'api' || value === 'api_server') return 'API';
    if (value === 'oneshot' || value === 'one-shot' || value === 'one_shot') return 'One-shot';
    return source ? String(source) : 'session';
  }
  function decorateSession(session, profileId) {
    const raw = session?.updated_at || session?.updatedAt || session?.created_at || session?.createdAt || '';
    const at = Date.parse(raw);
    return {
      ...session,
      profileId: session.profileId || profileId || '',
      sourceLabel: session.sourceLabel || sourceLabel(session.source || session.group),
      preview: String(session.preview || session.last_message || '').slice(0, 180),
      last_message: String(session.last_message || session.preview || '').slice(0, 180),
      at: Number.isFinite(at) ? at : (Number(session.at) || 0),
      updated_at: raw,
    };
  }
  async function readBody(response) {
    const type = response.headers.get('content-type') || '';
    const text = await response.text();
    const redirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    if (redirect || type.includes('text/html') || text.trim().startsWith('<')) {
      markSignIn();
      const error = new Error('Sign in to intelio');
      error.code = 'CLOUD_ACCESS';
      throw error;
    }
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!response.ok) {
      const error = new Error(String(json.error || 'This profile is not available.').slice(0, 200));
      error.status = response.status;
      throw error;
    }
    return json;
  }
  async function fetchJson(pathname, { method = 'GET', body, profile } = {}) {
    const headers = { Accept: 'application/json' };
    if (profile) headers['x-intelio-profile'] = profile;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      redirect: 'manual',
    });
    return readBody(response);
  }
  function feedSse(chunk, onEvent) {
    feedSse.buffer = `${feedSse.buffer || ''}${chunk}`;
    let match;
    while ((match = /\r?\n\r?\n/.exec(feedSse.buffer))) {
      const raw = feedSse.buffer.slice(0, match.index);
      feedSse.buffer = feedSse.buffer.slice(match.index + match[0].length);
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (!data.length) continue;
      let parsed = data.join('\n');
      try { parsed = JSON.parse(parsed); } catch { /* keep the raw line */ }
      onEvent({ event, data: parsed });
    }
  }
  async function sendChat(value) {
    const id = String(value.id || '');
    const profile = value.profile || 'intelio';
    const controller = new AbortController();
    inflight.set(id, controller);
    feedSse.buffer = '';
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/chat`, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'content-type': 'application/json', 'x-intelio-profile': profile },
        body: JSON.stringify({
          input: String(value.input || '').slice(0, 100000),
          profile,
          ...(value.model && value.provider ? { model: value.model, provider: value.provider, effort: value.effort || 'auto' } : {}),
        }),
        credentials: 'same-origin',
        redirect: 'manual',
        signal: controller.signal,
      });
      const type = response.headers.get('content-type') || '';
      if (response.type === 'opaqueredirect' || type.includes('text/html')) {
        markSignIn();
        throw new Error('Sign in to intelio');
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let message = 'The message was not sent.';
        try { message = JSON.parse(text).error || message; } catch { /* keep the fallback */ }
        const error = new Error(String(message).slice(0, 200));
        error.status = response.status;
        throw error;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        const text = decoder.decode(step.value, { stream: true });
        feedSse(text, (evt) => {
          for (const cb of eventListeners) cb({ sessionId: id, event: evt.event, data: evt.data });
        });
      }
      return true;
    } finally {
      inflight.delete(id);
    }
  }
  function voiceOff() {
    const error = new Error("Voice isn't set up on the server yet");
    error.code = 'VOICE_OFF';
    return error;
  }
  function bytesFromBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  async function voiceFetch(pathname, { method = 'GET', profile, body, contentType, accept } = {}) {
    const id = profile || 'intelio';
    const headers = { Accept: accept || 'application/json', 'x-intelio-profile': id, 'x-intelio-engine': 'auto' };
    if (contentType) headers['content-type'] = contentType;
    const join = pathname.includes('?') ? '&' : '?';
    const response = await fetch(`${pathname}${join}profile=${encodeURIComponent(id)}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      redirect: 'manual',
    });
    const type = response.headers.get('content-type') || '';
    const redirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    if (redirect || type.includes('text/html')) {
      markSignIn();
      const error = new Error('Sign in to intelio');
      error.code = 'CLOUD_ACCESS';
      throw error;
    }
    const binary = response.ok && type.includes('audio');
    if (binary) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { audio: bytesToBase64(bytes), type: type || 'audio/wav' };
    }
    const text = await response.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!response.ok) {
      if (json.fallback === 'web' || response.status === 503) throw voiceOff();
      const error = new Error(String(json.error || 'Could not use voice.').slice(0, 200));
      error.status = response.status;
      throw error;
    }
    if (text.includes('API_SERVER_KEY')) throw new Error('Could not use voice.');
    return json;
  }
  async function hermesRequest(name, value) {
    const profile = value.profile || '';
    if (name === 'agents') {
      const home = await fetchJson('/api/home');
      homeCache = home;
      return { agents: home.profiles || [], sample: Boolean(home.sample), label: home.label || '' };
    }
    if (name === 'sessions') {
      const json = await fetchJson('/api/sessions?limit=100', { profile });
      const rows = json.data || json.sessions || [];
      return { data: (Array.isArray(rows) ? rows : []).map((row) => decorateSession(row, profile)) };
    }
    if (name === 'all-sessions') {
      const home = homeCache || await fetchJson('/api/home');
      homeCache = home;
      return { data: (home.conversations || []).map((row) => decorateSession(row, row.profileId)) };
    }
    if (name === 'messages') {
      const json = await fetchJson(`/api/sessions/${encodeURIComponent(value.id)}/messages`, { profile });
      return { data: json.data || [] };
    }
    if (name === 'create-session') {
      const json = await fetchJson('/api/sessions', { method: 'POST', profile, body: { title: value.title || '', profile } });
      const id = json.session?.id || json.id || '';
      return { ...json, id, session: json.session || { id } };
    }
    if (name === 'send') return sendChat(value);
    if (name === 'model-options') {
      const session = value.id ? `&session=${encodeURIComponent(value.id)}` : '';
      return fetchJson(`/api/models?profile=${encodeURIComponent(profile || 'intelio')}${session}`, { profile });
    }
    if (name === 'session-model') {
      return fetchJson(`/api/sessions/${encodeURIComponent(value.id || '')}/model`, {
        method: 'POST',
        profile,
        body: { profile, model: value.model, provider: value.provider, effort: value.effort },
      });
    }
    if (name === 'agent-model') {
      return fetchJson('/api/agent/model', { method: 'POST', profile, body: { profile, model: value.model, provider: value.provider } });
    }
    if (name === 'cancel') {
      inflight.get(String(value.id || ''))?.abort();
      return true;
    }
    if (name === 'screens') return fetchJson('/api/screens');
    if (name === 'skills') return fetchJson('/api/skills', { profile });
    if (name === 'phone-call') return fetchJson('/api/phone/call', { method: 'POST', profile: profile || 'intelio', body: { profile: profile || 'intelio' } });
    if (name === 'voice-status') return voiceFetch('/api/voice', { profile: profile || 'intelio' });
    if (name === 'voice-transcribe') {
      const bytes = bytesFromBase64(value.audio);
      if (bytes.length < 16) throw new Error('That recording was empty.');
      const json = await voiceFetch('/api/voice/stt', {
        method: 'POST',
        profile: profile || 'intelio',
        body: bytes,
        contentType: String(value.type || 'audio/webm').slice(0, 80),
      });
      return { text: String(json.text || '').trim() };
    }
    if (name === 'voice-speak') {
      const text = String(value.text || '').trim().slice(0, 2000);
      if (!text) return { audio: '', type: 'audio/wav' };
      return voiceFetch('/api/voice/tts', {
        method: 'POST',
        profile: profile || 'intelio',
        body: JSON.stringify({ text, profile: profile || 'intelio' }),
        contentType: 'application/json',
        accept: 'audio/wav, audio/mpeg, application/octet-stream',
      });
    }
    if (name === 'agent-card') return fetchJson(`/api/agent/card?profile=${encodeURIComponent(profile)}`, { profile });
    if (name === 'agent-thinking') return fetchJson('/api/agent/thinking', { method: 'POST', profile, body: { profile, effort: value.effort } });
    if (name === 'agent-pause') return fetchJson('/api/agent/pause', { method: 'POST', profile, body: { profile, paused: value.paused !== false } });
    if (name === 'agent-profile') return fetchJson('/api/agent/profile', { method: 'POST', profile, body: { ...value, profile } });
    if (name === 'create-agent') return fetchJson('/api/profiles', { method: 'POST', body: value });
    if (name === 'fill-login') return fetchJson('/api/vault/fill', { method: 'POST', profile, body: { profile, site: value.site || value.domain || '' } });
    if (name === 'state') return state.remoteHermes;
    throw new Error(`Unknown Remote Hermes request: ${name}`);
  }

  function containRemote(cw, ch, fw, fh) {
    if (!(cw > 0 && ch > 0 && fw > 0 && fh > 0)) return 0;
    return Math.min(cw / fw, ch / fh);
  }
  function fitRemote(client, screen) {
    if (!client || !screen) return;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.clipViewport = false;
    const fw = client._fbWidth || client._display?.width || 0;
    const fh = client._fbHeight || client._display?.height || 0;
    const scale = containRemote(screen.clientWidth, screen.clientHeight, fw, fh);
    if (scale > 0 && client._display) client._display.scale = scale;
  }
  function vncHost() {
    let host = document.getElementById('intelio-vnc');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'intelio-vnc';
    const note = document.createElement('p');
    note.className = 'intelio-vnc-note';
    note.textContent = "Connecting to the agent's computer";
    host.append(note);
    document.body.append(host);
    return host;
  }
  function placeVnc(rect) {
    const host = vncHost();
    if (!rect) {
      host.style.display = 'none';
      return host;
    }
    host.style.display = 'block';
    host.style.left = `${rect.x}px`;
    host.style.top = `${rect.y}px`;
    host.style.width = `${rect.width}px`;
    host.style.height = `${rect.height}px`;
    return host;
  }
  async function ensureVnc(host) {
    if (rfb || vncStarting || vncTried) return;
    vncTried = true;
    vncStarting = true;
    try {
      const mod = await import('/novnc/core/rfb.js');
      const RFB = mod.default;
      if (!host.isConnected) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const client = new RFB(host, `${proto}//${location.host}/browser/websockify`);
      client.scaleViewport = true;
      client.resizeSession = false;
      client.clipViewport = false;
      client.background = document.documentElement.dataset.theme === 'light' ? '#f6f6f8' : '#101012';
      const fit = () => fitRemote(client, host);
      client.addEventListener('connect', () => {
        const note = host.querySelector('.intelio-vnc-note');
        if (note) note.hidden = true;
        state.remoteStatus = 'connected';
        fit();
        publish();
      });
      client.addEventListener('disconnect', () => {
        if (rfb !== client) return;
        rfb = null;
        state.remoteStatus = 'disconnected';
        const note = host.querySelector('.intelio-vnc-note');
        if (note) {
          note.hidden = false;
          note.textContent = 'The shared browser is not connected.';
        }
        const status = document.getElementById('workspace-status');
        if (status) status.textContent = 'VPS · disconnected';
      });
      rfb = client;
    } catch {
      const note = host.querySelector('.intelio-vnc-note');
      if (note) note.textContent = 'The shared browser is not connected.';
      state.remoteStatus = 'disconnected';
    } finally {
      if (!rfb) vncStarting = false;
    }
  }
  function layout(rects) {
    const show = state.activeTabId === 'vps' && state.showBrowser !== false && !rects?.obscured && rects?.browser;
    const host = placeVnc(show ? rects.browser : null);
    if (show) ensureVnc(host);
    if (rfb && show) fitRemote(rfb, host);
  }
  function applySettings(value) {
    if (value.theme === 'light' || value.theme === 'dark') {
      state.theme = value.theme;
      try { localStorage.setItem('intelio-theme', value.theme); } catch { /* the page still paints this choice */ }
    }
    if (typeof value.showBots === 'boolean') state.showBots = value.showBots;
    if (typeof value.showBrowser === 'boolean') state.showBrowser = value.showBrowser;
    if (typeof value.preview === 'boolean') state.preview = value.preview;
    if (value.sidebarTab === 'agents' || value.sidebarTab === 'sessions') state.sidebarTab = value.sidebarTab;
    if ([1, 2, 3, 4].includes(Number(value.screenGrid))) {
      state.screenGrid = Number(value.screenGrid);
      try { localStorage.setItem('intelio-screen-grid', String(state.screenGrid)); } catch { /* pills still update */ }
    }
    if (Number.isInteger(Number(value.activeScreen)) && Number(value.activeScreen) >= 0 && Number(value.activeScreen) < 4) {
      state.activeScreen = Number(value.activeScreen);
      try { localStorage.setItem('intelio-active-screen', String(state.activeScreen)); } catch { /* the active cell still updates */ }
    }
    if (Number.isFinite(value.chatWidth)) state.chatWidth = Math.max(320, Math.min(680, value.chatWidth));
    if (value.previewPos && Number.isFinite(value.previewPos.x) && Number.isFinite(value.previewPos.y)) state.previewPos = value.previewPos;
  }
  async function command(name, value = {}) {
    if (name === 'settings') {
      applySettings(value || {});
      return publish();
    }
    if (name === 'preview-move' && value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
      state.previewPos = { x: Math.round(value.x), y: Math.round(value.y) };
      return publish();
    }
    if (name === 'toggle-vps-view') {
      state.activeTabId = state.activeTabId === 'vps' ? 'home' : 'vps';
      return publish();
    }
    if (name === 'activate' && (value.id === 'vps' || value.id === 'home')) {
      state.activeTabId = value.id;
      return publish();
    }
    if (name === 'remote-hermes-sign-in') {
      state.remoteHermes.needsSignIn = false;
      location.assign('/');
      return state;
    }
    if (name === 'vault-list') {
      try {
        const profile = value.profile || 'intelio';
        const json = await fetchJson(`/api/vault/logins?profile=${encodeURIComponent(profile)}`, { profile });
        return { logins: json.logins || [] };
      } catch { return { logins: [] }; }
    }
    if (name === 'vault-delete') {
      const profile = value.profile || 'intelio';
      const json = await fetchJson('/api/vault/logins', { method: 'DELETE', profile, body: { profile, domain: value.domain || '' } });
      return { logins: json.logins || [] };
    }
    throw new Error('That control stays on the intelio app.');
  }

  const style = document.createElement('style');
  style.textContent = '#intelio-vnc{position:fixed;z-index:4;overflow:hidden;background:#101012;display:none}html[data-theme="light"] #intelio-vnc{background:#f6f6f8}#intelio-vnc .intelio-vnc-note{margin:0;position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:#5e5e68;font:13px -apple-system,BlinkMacSystemFont,sans-serif;pointer-events:none}';
  document.head.appendChild(style);

  window.remoteHermes = {
    request: (name, value) => hermesRequest(name, value || {}),
    onEvent: (callback) => { if (typeof callback === 'function') eventListeners.push(callback); },
  };
  window.workspace = {
    getState: () => Promise.resolve(state),
    command: (name, value) => command(name, value || {}),
    layout,
    onState: (callback) => { if (typeof callback === 'function') stateListeners.push(callback); },
    onFocusAddress: () => {},
    onSettings: () => {},
    onFocusWorkspace: () => {},
    onPointer: () => {},
    onRemoteShortcut: () => {},
    onPreviewNudge: () => {},
    onPreviewDrop: () => {},
  };

  if ('serviceWorker' in navigator && location.protocol !== 'http:') {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (!hadController || event.data?.type !== 'intelio-pwa-update') return;
      location.reload();
    });
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
