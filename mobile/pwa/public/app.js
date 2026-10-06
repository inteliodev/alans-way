/** Intelio phone client. The Hermes API key is not in this file; the tailnet service holds the session. */
(function () {
  'use strict';

  const VAD_START = 0.045;
  const VAD_KEEP = 0.03;
  const SILENCE_MS = 700;
  const app = document.getElementById('app');
  const state = {
    view: 'login',
    sample: false,
    home: { profiles: [], conversations: [] },
    query: '',
    searching: false,
    chatId: '',
    bot: { id: 'intelio', name: 'Intelio', color: '#ff8a1f', status: 'online' },
    messages: [],
    captions: [],
    engines: { recommended: 'web', hermesAudio: false, vps: false, web: true },
    sheet: '',
    error: '',
    ptt: false,
    call: { active: false, paused: false, muted: false, speaker: true, sessionId: '', startedAt: 0, frozenSeconds: null },
  };
  let audioCtx = null;
  let mic = null;
  let vadHandle = 0;
  let ttsToken = 0;
  let unspoken = '';
  let speakQueue = [];
  let pumping = false;
  let sources = [];
  let timerHandle = 0;
  let webRec = null;

  function splitSentences(text) {
    const sentences = [];
    let rest = String(text || '');
    const re = /^(.*?[.!?])(?:\s+|$)/s;
    while (rest) {
      const match = re.exec(rest);
      if (!match || !match[1]) break;
      sentences.push(match[1].trim());
      rest = rest.slice(match[0].length);
    }
    return { sentences, rest };
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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const paths = {
      search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      back: '<path d="M15 5l-7 7 7 7"/>',
      phone: '<path d="M8 4h3l1 4-2 1a12 12 0 0 0 5 5l1-2 4 1v3c0 1-1 2-2 2A15 15 0 0 1 6 6c0-1 1-2 2-2z"/>',
      mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>',
      speaker: '<path d="M4 10h3l5-4v12l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
      gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
      send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
      signal: '<path d="M4 18v-3M9 18v-6M14 18V8M19 18V5"/>',
    };
    const wrap = el('span', 'ico');
    wrap.innerHTML = `<svg viewBox="0 0 24 24">${paths[name] || ''}</svg>`;
    return wrap;
  }

  function engine() {
    return localStorage.getItem('intelio-voice-engine') || 'auto';
  }

  function resolvedEngine() {
    const choice = engine();
    if (choice === 'hermes') return state.engines.hermesAudio ? 'hermes' : (state.engines.vps ? 'vps' : 'web');
    if (choice === 'vps') return state.engines.vps ? 'vps' : 'web';
    if (choice === 'web') return 'web';
    if (state.engines.hermesAudio) return 'hermes';
    if (state.engines.vps) return 'vps';
    return 'web';
  }

  function clock(seconds, style) {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, '0');
    if (style === 'pill') return `${String(minutes).padStart(2, '0')}:${rest}`;
    return `${minutes}:${rest}`;
  }

  function callElapsed() {
    if (!state.call.active) return 0;
    if (state.call.frozenSeconds != null) return state.call.frozenSeconds;
    return (Date.now() - state.call.startedAt) / 1000;
  }

  function profileById(id) {
    return state.home.profiles.find((item) => item.id === id) || state.home.profiles[0] || state.bot;
  }

  function statusTime() {
    return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '').replace('AM', '').replace('PM', '');
  }

  function statusBar() {
    const bar = el('div', 'statusbar');
    bar.append(el('span', '', statusTime()));
    const glyphs = el('div', 'glyphs');
    glyphs.append(icon('signal'), el('span', '', '5G'));
    bar.append(glyphs);
    return bar;
  }

  function sampleFlag() {
    return state.sample ? el('div', 'sample-flag', 'SAMPLE DATA') : el('span');
  }

  function blob(color) {
    const node = el('div', 'blob');
    node.style.setProperty('--c', color || '#ff8a1f');
    return node;
  }

  function face(profile, className) {
    if (!profile || profile.id === 'intelio') {
      const img = document.createElement('img');
      img.src = '/icon-192.png';
      img.alt = '';
      img.className = className || 'face';
      return img;
    }
    const node = el('div', className || 'face');
    node.style.background = profile.color || '#ff8a1f';
    return node;
  }

  async function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const buffer = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    try { src.start(); } catch { /* already started */ }
    return audioCtx;
  }

  document.addEventListener('pointerdown', () => { unlockAudio().catch(() => {}); });

  function paintCallbar() {
    let bar = document.getElementById('callbar');
    if (!state.call.active) {
      if (bar) bar.hidden = true;
      return;
    }
    if (!bar) {
      bar = el('div', 'callbar');
      bar.id = 'callbar';
      app.append(bar);
    }
    bar.hidden = false;
    bar.replaceChildren();
    const tap = el('button', 'tap');
    tap.type = 'button';
    tap.append(waveform(), face(state.bot, 'face'));
    tap.addEventListener('click', () => { state.view = 'call'; render(); });
    const speaker = roundButton('speaker', () => { state.call.speaker = !state.call.speaker; if (!state.call.speaker) bargeIn(); paintCallbar(); });
    if (state.call.speaker) speaker.classList.add('on');
    const mute = roundButton('mic', () => { state.call.muted = !state.call.muted; paintCallbar(); });
    if (state.call.muted) mute.classList.add('off');
    const end = el('button', 'end');
    end.type = 'button';
    end.setAttribute('aria-label', 'End call');
    end.append(el('span', 'x', '×'));
    end.addEventListener('click', () => endCall());
    bar.append(tap, speaker, mute, end);
  }

  function waveform() {
    const wave = el('div', state.call.paused || state.call.muted ? 'wave paused' : 'wave');
    for (let i = 0; i < 16; i++) {
      const bar = document.createElement('i');
      bar.style.animationDelay = `${(i % 7) * 0.07}s`;
      wave.append(bar);
    }
    return wave;
  }

  function roundButton(name, onClick) {
    const button = el('button', 'round');
    button.type = 'button';
    button.append(icon(name));
    button.addEventListener('click', onClick);
    return button;
  }

  function render() {
    const prior = document.getElementById('callbar');
    app.replaceChildren();
    if (state.view === 'login') {
      app.append(loginView());
      return;
    }
    const screen = el('div', `screen${state.call.active ? ' has-bar' : ''}`);
    screen.append(statusBar());
    if (state.sample) screen.append(sampleFlag());
    if (state.error) screen.append(el('div', 'toast', state.error));
    if (state.view === 'home') screen.append(homeView());
    else if (state.view === 'chat') screen.append(chatView());
    else if (state.view === 'call') screen.append(callView());
    app.append(screen);
    if (prior) app.append(prior);
    paintCallbar();
    ensureTimer();
    const thread = document.getElementById('thread') || document.getElementById('captions');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  function loginView() {
    const wrap = el('div', 'login');
    const mark = document.createElement('img');
    mark.src = '/icon-192.png';
    mark.alt = '';
    mark.className = 'mark';
    wrap.append(statusBar(), mark, el('h1', '', 'Intelio'), el('p', 'credit', 'Alan’s Way'), el('p', 'note', state.error || 'Checking Tailscale…'));
    return wrap;
  }

  function homeView() {
    const frag = document.createDocumentFragment();
    const top = el('div', 'home-top');
    const me = el('button', 'avatar-btn');
    me.type = 'button';
    me.setAttribute('aria-label', 'Account');
    const photo = document.createElement('img');
    photo.src = '/icon-192.png';
    photo.alt = '';
    me.append(photo);
    me.addEventListener('click', () => openSheet('settings'));
    const actions = el('div', 'home-actions');
    const search = el('button', 'iconbtn');
    search.type = 'button';
    search.setAttribute('aria-label', 'Search');
    search.append(icon('search'));
    search.addEventListener('click', () => { state.searching = !state.searching; render(); });
    const newer = el('button', 'iconbtn');
    newer.type = 'button';
    newer.setAttribute('aria-label', 'New chat');
    newer.append(icon('plus'));
    newer.addEventListener('click', () => openSheet('new'));
    actions.append(search, newer);
    top.append(me, actions);
    frag.append(top);
    if (state.searching) {
      const box = el('div', 'searchbox');
      const input = document.createElement('input');
      input.placeholder = 'Search';
      input.value = state.query;
      input.addEventListener('input', () => { state.query = input.value; paintList(); });
      box.append(input);
      frag.append(box);
    }
    const tiles = el('div', 'tiles');
    for (const profile of state.home.profiles) {
      const button = el('button', 'tile-wrap');
      button.type = 'button';
      const tile = el('div', 'tile');
      tile.style.setProperty('--c', profile.color);
      tile.append(blob(profile.color));
      const dot = el('i', `dot ${profile.status === 'online' ? '' : profile.status}`.trim());
      tile.append(dot);
      button.append(tile, el('em', '', profile.name));
      button.addEventListener('click', () => startChatWith(profile));
      tiles.append(button);
    }
    frag.append(tiles);
    const list = el('div');
    list.id = 'list';
    const q = state.query.trim().toLowerCase();
    const rows = state.home.conversations.filter((row) => !q || `${row.title} ${row.preview}`.toLowerCase().includes(q));
    list.append(rebuildList(rows));
    frag.append(list);
    return frag;
  }

  function paintList() {
    const list = document.getElementById('list');
    if (!list) return;
    const q = state.query.trim().toLowerCase();
    const rows = state.home.conversations.filter((row) => !q || `${row.title} ${row.preview}`.toLowerCase().includes(q));
    list.replaceChildren(rebuildList(rows));
  }

  function rebuildList(rows) {
    const root = document.createDocumentFragment();
    let group = '';
    let ul = null;
    for (const row of rows) {
      if (row.group !== group) {
        group = row.group || 'chat';
        root.append(el('h2', 'group', group));
        ul = el('ul', 'convos');
        root.append(ul);
      }
      const profile = profileById(row.profileId);
      const button = el('button', 'row');
      button.type = 'button';
      const mini = el('div', 'mini');
      mini.style.setProperty('--c', profile.color || '#ff8a1f');
      if (profile.id === 'intelio') {
        const img = document.createElement('img');
        img.src = '/icon-192.png';
        img.alt = '';
        img.style.width = '28px';
        img.style.height = '28px';
        img.style.borderRadius = '8px';
        mini.append(img);
      } else mini.append(blob(profile.color));
      const copy = el('div', 'copy');
      copy.append(el('strong', '', row.title), el('p', '', row.preview));
      button.append(mini, copy);
      const live = (state.call.active && state.call.sessionId === row.id) || row.inCall;
      if (live) {
        const pill = el('span', 'pill');
        if (state.call.active && state.call.sessionId === row.id) pill.id = 'call-pill';
        const seconds = state.call.active && state.call.sessionId === row.id ? callElapsed() : 33;
        pill.append(el('i'), document.createTextNode(`in call ${clock(seconds, 'pill')}`));
        button.append(pill);
      } else button.append(el('span', 'when', row.time || ''));
      button.addEventListener('click', () => openChat(row));
      const item = el('li');
      item.append(button);
      ul.append(item);
    }
    if (!rows.length) root.append(el('p', 'empty', state.sample ? 'No sample conversations.' : 'No conversations yet.'));
    return root;
  }

  function chatView() {
    const frag = document.createDocumentFragment();
    const top = el('header', 'chat-top');
    const back = el('button', 'iconbtn back');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back');
    back.append(icon('back'));
    back.addEventListener('click', () => { state.view = 'home'; render(); });
    const id = el('div', 'chat-id');
    const mini = el('div', 'mini');
    mini.style.setProperty('--c', state.bot.color || '#ff8a1f');
    if (state.bot.id === 'intelio') {
      const img = document.createElement('img');
      img.src = '/icon-192.png';
      img.alt = '';
      img.style.width = '22px';
      img.style.height = '22px';
      img.style.borderRadius = '6px';
      mini.append(img);
    } else mini.append(blob(state.bot.color));
    const names = el('div');
    names.append(el('strong', '', state.bot.name || 'Intelio'), el('span', '', state.call.active ? 'In a call' : 'Online'));
    id.append(mini, names);
    const call = el('button', 'iconbtn');
    call.type = 'button';
    call.setAttribute('aria-label', 'Call');
    call.append(icon('phone'));
    call.addEventListener('click', () => startCall(state.chatId));
    top.append(back, id, call);
    const thread = el('div', 'thread');
    thread.id = 'thread';
    fillThread(thread, state.messages);
    const form = el('form', 'composer');
    const plus = roundButton('plus', () => openSheet('new'));
    const input = document.createElement('input');
    input.id = 'ask';
    input.placeholder = `Ask ${state.bot.name || 'Intelio'}`;
    input.autocomplete = 'off';
    const ptt = roundButton('mic', () => {});
    ptt.id = 'ptt';
    ptt.setAttribute('aria-label', state.call.active ? 'Mute microphone' : 'Hold to talk');
    ptt.addEventListener('pointerdown', (event) => {
      if (state.call.active) { state.call.muted = !state.call.muted; paintCallbar(); return; }
      event.preventDefault();
      ptt.setPointerCapture(event.pointerId);
      beginPtt(ptt);
    });
    ptt.addEventListener('pointerup', () => endPtt());
    ptt.addEventListener('pointercancel', () => endPtt());
    const send = roundButton('send', () => {});
    send.classList.add('send');
    send.type = 'submit';
    form.append(plus, input, ptt, send);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      input.value = '';
      if (text) sendTurn(text);
    });
    frag.append(top, thread, form);
    return frag;
  }

  function fillThread(thread, messages) {
    thread.replaceChildren();
    for (const message of messages) {
      if (message.role === 'activity') thread.append(el('div', 'activity', message.text));
      else if (message.role === 'time') thread.append(el('div', 'stamp', message.text));
      else if (message.role === 'choice') thread.append(el('div', 'choice', message.text));
      else thread.append(el('div', `bubble ${message.role === 'user' ? 'user' : 'bot'}`, message.text));
    }
  }

  function callView() {
    const frag = document.createDocumentFragment();
    const top = el('header', 'call-top');
    const min = el('button', 'iconbtn');
    min.type = 'button';
    min.setAttribute('aria-label', 'Minimize');
    min.append(icon('back'));
    min.addEventListener('click', () => { state.view = state.chatId ? 'chat' : 'home'; render(); });
    top.append(min);
    const hero = el('div', 'call-hero');
    const avatar = el('div', 'call-avatar');
    avatar.style.setProperty('--c', state.bot.color || '#ff8a1f');
    if (state.bot.id === 'intelio') {
      const img = document.createElement('img');
      img.src = '/icon-192.png';
      img.alt = '';
      avatar.append(img);
    } else avatar.append(blob(state.bot.color));
    const timer = el('p', 'timer', clock(callElapsed(), 'screen'));
    timer.id = 'call-timer';
    hero.append(avatar, el('h1', '', state.bot.name || 'Intelio'), timer);
    const captions = el('div', 'captions');
    captions.id = 'captions';
    fillCaptions(captions, state.captions);
    const controls = el('div', 'controls');
    const gear = roundButton('gear', () => openSheet('settings'));
    const speaker = roundButton('speaker', () => { state.call.speaker = !state.call.speaker; if (!state.call.speaker) bargeIn(); render(); });
    if (state.call.speaker) speaker.classList.add('on');
    const mute = roundButton('mic', () => { state.call.muted = !state.call.muted; render(); });
    if (state.call.muted) mute.classList.add('off');
    const end = el('button', 'end');
    end.type = 'button';
    end.setAttribute('aria-label', 'End call');
    end.append(el('span', 'end-mark'));
    end.addEventListener('click', () => endCall());
    controls.append(gear, speaker, mute, end);
    frag.append(top, hero, captions, controls);
    if (state.call.paused && state.micError) {
      frag.append(el('p', 'empty', state.micError));
      const resume = el('button', 'block', 'Resume call');
      resume.type = 'button';
      resume.style.margin = '0 18px 18px';
      resume.addEventListener('click', () => startCall(state.call.sessionId));
      frag.append(resume);
    }
    return frag;
  }

  function fillCaptions(node, lines) {
    node.replaceChildren();
    for (const line of lines) {
      if (line.role === 'activity' || line.role === 'time') continue;
      node.append(el('p', `cap ${line.role === 'user' ? 'user' : 'bot'}`, line.text));
    }
  }

  function paintThread() {
    const thread = document.getElementById('thread');
    if (thread) fillThread(thread, state.messages);
    const captions = document.getElementById('captions');
    if (captions) fillCaptions(captions, state.captions);
    const scroller = captions || thread;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function buckets() {
    const out = [];
    if (state.call.active) out.push(state.captions);
    if (!state.call.active || state.chatId === state.call.sessionId) out.push(state.messages);
    return [...new Set(out)];
  }

  function pushLine(role, text) {
    const line = { role, text };
    for (const bucket of buckets()) bucket.push(line);
    paintThread();
    return line;
  }

  function ensureTimer() {
    if (timerHandle) return;
    timerHandle = setInterval(() => {
      if (!state.call.active || state.call.frozenSeconds != null) return;
      const label = clock(callElapsed(), 'screen');
      const timer = document.getElementById('call-timer');
      if (timer) timer.textContent = label;
      const pill = document.getElementById('call-pill');
      if (pill) pill.replaceChildren(el('i'), document.createTextNode(`in call ${clock(callElapsed(), 'pill')}`));
    }, 500);
  }

  async function boot() {
    const session = await fetch('/session');
    if (session.status === 401) {
      state.view = 'login';
      state.error = 'This Tailscale identity is not allowed.';
      render();
      return;
    }
    const who = await session.json().catch(() => ({}));
    state.login = who.login || '';
    const home = await fetch('/api/home');
    if (home.status === 401) { state.view = 'login'; state.error = 'This Tailscale identity is not allowed.'; render(); return; }
    state.home = await home.json();
    state.sample = Boolean(state.home.sample);
    state.bot = state.home.profiles[0] || state.bot;
    const voice = await fetch('/api/voice');
    if (voice.ok) state.engines = await voice.json();
    state.view = 'home';
    state.error = '';
    render();
    if ('serviceWorker' in navigator && location.protocol !== 'http:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  async function openChat(row) {
    state.chatId = row.id;
    state.bot = profileById(row.profileId);
    state.view = 'chat';
    state.messages = [];
    render();
    await loadMessages(row.id, state.messages);
    if (state.call.active && state.call.sessionId === row.id) state.captions = state.messages;
    render();
  }

  async function loadMessages(id, target) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`);
    const body = await response.json().catch(() => ({ data: [] }));
    const lines = (body.data || []).map((message) => ({
      role: message.role || 'assistant',
      text: typeof message.content === 'string' ? message.content : (message.text || ''),
    })).filter((message) => message.text);
    if (target) {
      target.splice(0, target.length, ...lines);
    }
    return lines;
  }

  async function startChatWith(profile) {
    state.bot = profile;
    const response = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: profile.name || 'Intelio' }) });
    const body = await response.json().catch(() => ({}));
    const id = body.id || (body.data && body.data.id);
    if (!id) { state.error = body.error || 'Could not start a chat.'; render(); return; }
    state.chatId = id;
    state.messages = [];
    state.view = 'chat';
    render();
  }

  function openSheet(name) {
    state.sheet = name;
    const existing = document.getElementById('sheet');
    if (existing) existing.remove();
    const sheet = el('div', 'sheet');
    sheet.id = 'sheet';
    const card = el('div', 'card');
    if (name === 'settings') card.append(settingsCard());
    else card.append(newCard());
    sheet.append(card);
    sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.remove(); });
    app.append(sheet);
  }

  function settingsCard() {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', 'Voice'));
    const choices = [
      ['auto', `Auto (${state.engines.recommended || 'web'})`],
      ['hermes', 'Hermes audio'],
      ['vps', 'On the VPS'],
      ['web', 'On this phone'],
    ];
    for (const [value, label] of choices) {
      const row = el('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'engine';
      input.value = value;
      input.checked = engine() === value;
      if (value === 'hermes' && !state.engines.hermesAudio) input.disabled = true;
      if (value === 'vps' && !state.engines.vps) input.disabled = true;
      input.addEventListener('change', () => localStorage.setItem('intelio-voice-engine', value));
      row.append(input, document.createTextNode(label));
      frag.append(row);
    }
    frag.append(el('p', '', 'Auto prefers Hermes when this profile advertises audio. Otherwise it uses faster-whisper and Piper on the VPS. On this phone, iOS may send microphone audio to Apple, and a locked screen pauses the mic. Calls need HTTPS from a tailscale certificate and a tap before audio can play.'));
    frag.append(el('p', '', state.login && state.login !== 'sample' ? `Signed in with Tailscale as ${state.login}.` : 'Signed in with Tailscale. The profile key stays on the VPS.'));
    return frag;
  }

  function newCard() {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', 'New'));
    const chat = el('button', 'block', `Message ${state.bot.name || 'Intelio'}`);
    chat.type = 'button';
    chat.addEventListener('click', () => { document.getElementById('sheet')?.remove(); startChatWith(state.bot); });
    const call = el('button', 'block', `Call ${state.bot.name || 'Intelio'}`);
    call.type = 'button';
    call.addEventListener('click', async () => {
      document.getElementById('sheet')?.remove();
      if (!state.chatId) await startChatWith(state.bot);
      startCall(state.chatId);
    });
    frag.append(chat, call);
    return frag;
  }

  async function beginPtt(button) {
    state.ptt = true;
    button.classList.add('hot');
    state.pttText = '';
    try {
      await unlockAudio();
      if (resolvedEngine() === 'web') { startWebRecognizer(false); return; }
      await openMic();
      startRecorder();
    } catch (error) {
      state.ptt = false;
      button.classList.remove('hot');
      state.error = micMessage(error);
      render();
    }
  }

  async function endPtt() {
    const button = document.getElementById('ptt');
    if (button) button.classList.remove('hot');
    if (!state.ptt) return;
    state.ptt = false;
    if (webRec && resolvedEngine() === 'web') {
      try { webRec.stop(); } catch { /* already stopped */ }
      return;
    }
    const blob = await stopRecorder();
    releaseMic();
    if (!blob) return;
    try {
      const text = await transcribeBlob(blob);
      if (text) await sendTurn(text);
    } catch (error) {
      state.error = error.fallback === 'web' ? `${error.message} Switch Voice to “On this phone”.` : error.message;
      render();
    }
  }

  function startWebRecognizer(continuous) {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) throw Object.assign(new Error('This browser has no speech recognition.'), { name: 'NotSupportedError' });
    if (webRec) try { webRec.stop(); } catch { /* ignore */ }
    const rec = new Rec();
    rec.lang = 'en-US';
    rec.continuous = continuous;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece;
        else interim += piece;
      }
      if (interim && state.call.active) bargeIn();
      if (finalText.trim()) sendTurn(finalText.trim());
    };
    rec.onerror = () => { state.error = 'On-phone speech recognition stopped.'; };
    rec.onend = () => {
      if (continuous && state.call.active && !state.call.paused && resolvedEngine() === 'web') {
        try { rec.start(); } catch { /* iOS may refuse a restart */ }
      }
    };
    rec.start();
    webRec = rec;
  }

  async function openMic() {
    if (mic) return mic;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('Microphone needs a secure page.'), { name: 'SecurityError' });
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }, video: false });
    const ctx = await unlockAudio();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    mic = { stream, analyser, chunks: [], recorder: null };
    return mic;
  }

  function releaseMic() {
    if (vadHandle) cancelAnimationFrame(vadHandle);
    vadHandle = 0;
    if (!mic) return;
    try { if (mic.recorder && mic.recorder.state !== 'inactive') mic.recorder.stop(); } catch { /* ignore */ }
    mic.stream.getTracks().forEach((track) => track.stop());
    mic = null;
  }

  function recorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type)) || '';
  }

  function startRecorder() {
    if (!mic || typeof MediaRecorder === 'undefined') return;
    const mime = recorderMime();
    mic.chunks = [];
    mic.recorder = mime ? new MediaRecorder(mic.stream, { mimeType: mime }) : new MediaRecorder(mic.stream);
    mic.recorder.ondataavailable = (event) => { if (event.data && event.data.size) mic.chunks.push(event.data); };
    mic.recorder.start();
  }

  function stopRecorder() {
    if (!mic || !mic.recorder || mic.recorder.state === 'inactive') return Promise.resolve(null);
    const recorder = mic.recorder;
    return new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(mic ? mic.chunks : [], { type: recorder.mimeType || 'audio/webm' }));
      try { recorder.stop(); } catch { resolve(null); }
    });
  }

  async function blobToWav(blob) {
    const ctx = audioCtx || await unlockAudio();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const ratio = decoded.sampleRate / rate;
    const channels = decoded.numberOfChannels;
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < channels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / channels;
    }
    const length = Math.floor(mono.length / ratio);
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.max(start + 1, Math.min(mono.length, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += mono[j];
      samples[i] = sum / (end - start);
    }
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    write(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function transcribeBlob(blob) {
    let body = blob;
    let type = blob.type || 'application/octet-stream';
    try {
      body = await blobToWav(blob);
      type = 'audio/wav';
    } catch { /* keep the recorder container */ }
    const response = await fetch('/api/voice/stt', { method: 'POST', headers: { 'content-type': type, 'x-intelio-engine': engine() }, body });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error || 'Could not transcribe.');
      error.fallback = json.fallback;
      throw error;
    }
    return json.text || '';
  }

  async function sendTurn(text) {
    const sessionId = (state.call.active && state.call.sessionId) || state.chatId;
    if (!sessionId || !text) return;
    pushLine('user', text);
    const pending = { role: 'assistant', text: '', pending: true };
    for (const bucket of buckets()) bucket.push(pending);
    paintThread();
    unspoken = '';
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    if (!response.ok || !response.body) {
      pending.text = 'The reply did not start.';
      pending.pending = false;
      paintThread();
      return;
    }
    await readSse(response, (event, data) => {
      let payload = {};
      try { payload = JSON.parse(data); } catch { payload = { text: data }; }
      if (event.includes('tool')) {
        const name = payload.name || payload.tool || 'a tool';
        if (event.includes('complete') || event.includes('result') || event.includes('finished')) {
          pending.pending = false;
          pushLine('activity', payload.summary || `Used ${name}`);
          const next = { role: 'assistant', text: '', pending: true };
          for (const bucket of buckets()) bucket.push(next);
          Object.assign(pending, next);
        }
        return;
      }
      const delta = payload.delta || payload.text || '';
      if (!delta) return;
      pending.text += delta;
      paintThread();
      if (state.call.active && state.call.speaker) feedSpeech(delta);
    });
    pending.pending = false;
    if (state.call.active && state.call.speaker && unspoken.trim()) {
      speakQueue.push(unspoken.trim());
      unspoken = '';
      pumpSpeech();
    }
    paintThread();
  }

  async function readSse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) onEvent(event, data);
      }
    }
  }

  function feedSpeech(delta) {
    unspoken += delta;
    const parts = splitSentences(unspoken);
    unspoken = parts.rest;
    for (const sentence of parts.sentences) speakQueue.push(sentence);
    pumpSpeech();
  }

  function bargeIn() {
    ttsToken += 1;
    speakQueue = [];
    unspoken = '';
    for (const source of sources) { try { source.stop(); } catch { /* already ended */ } }
    sources = [];
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  async function pumpSpeech() {
    if (pumping) return;
    pumping = true;
    const token = ttsToken;
    while (speakQueue.length && token === ttsToken && state.call.speaker && state.call.active) {
      const sentence = speakQueue.shift();
      try { await speakOne(sentence, token); } catch { /* keep the conversation going */ }
    }
    pumping = false;
  }

  async function speakOne(sentence, token) {
    if (resolvedEngine() === 'web') return speakWeb(sentence, token);
    const response = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intelio-engine': engine() },
      body: JSON.stringify({ text: sentence }),
    });
    if (token !== ttsToken) return;
    if (response.status === 503) return speakWeb(sentence, token);
    if (!response.ok) return;
    const bytes = await response.arrayBuffer();
    if (token !== ttsToken) return;
    await playBuffer(bytes, token);
  }

  function speakWeb(sentence, token) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve(); return; }
      const utter = new SpeechSynthesisUtterance(sentence);
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
      const watch = setInterval(() => {
        if (token !== ttsToken) {
          window.speechSynthesis.cancel();
          clearInterval(watch);
          resolve();
        }
      }, 80);
      utter.onend = () => { clearInterval(watch); resolve(); };
    });
  }

  function playBuffer(bytes, token) {
    return unlockAudio().then((ctx) => new Promise((resolve) => {
      if (!ctx || token !== ttsToken) { resolve(); return; }
      ctx.decodeAudioData(bytes.slice(0), (buffer) => {
        if (token !== ttsToken) { resolve(); return; }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        sources.push(source);
        source.onended = () => { sources = sources.filter((item) => item !== source); resolve(); };
        source.start();
      }, () => resolve());
    }));
  }

  function vadLoop() {
    if (!mic || !state.call.active || state.call.paused || state.call.muted) {
      vadHandle = requestAnimationFrame(vadLoop);
      return;
    }
    const data = new Uint8Array(mic.analyser.fftSize);
    mic.analyser.getByteTimeDomainData(data);
    const level = rms(data);
    const now = performance.now();
    if (level >= VAD_START) {
      if (!mic.speaking) {
        mic.speaking = true;
        bargeIn();
        startRecorder();
      }
      mic.quietSince = 0;
    } else if (mic.speaking && level < VAD_KEEP) {
      if (!mic.quietSince) mic.quietSince = now;
      if (now - mic.quietSince > SILENCE_MS) {
        mic.speaking = false;
        mic.quietSince = 0;
        const blobPromise = stopRecorder();
        blobPromise.then((blob) => blob && transcribeBlob(blob).then((text) => { if (text) sendTurn(text); })).catch((error) => {
          state.error = error.message;
        });
      }
    }
    vadHandle = requestAnimationFrame(vadLoop);
  }

  async function startCall(sessionId) {
    if (!sessionId) return;
    state.error = '';
    state.micError = '';
    state.call = { active: true, paused: false, muted: false, speaker: true, sessionId, startedAt: Date.now(), frozenSeconds: null };
    state.captions = state.chatId === sessionId ? state.messages : [];
    state.view = 'call';
    try {
      await unlockAudio();
      if (resolvedEngine() === 'web') startWebRecognizer(true);
      else {
        await openMic();
        vadLoop();
      }
    } catch (error) {
      state.call.paused = true;
      state.micError = micMessage(error);
    }
    render();
  }

  function micMessage(error) {
    if (!window.isSecureContext) return 'The microphone needs HTTPS. Open the tailscale cert address, then tap Call again.';
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return 'Allow the microphone, then tap Call again. iOS only asks after a tap on an HTTPS page.';
    if (error && error.name === 'NotFoundError') return 'This device has no microphone.';
    return error && error.message ? error.message : 'The microphone did not start.';
  }

  async function endCall() {
    state.call.active = false;
    state.call.paused = false;
    bargeIn();
    releaseMic();
    if (webRec) { try { webRec.stop(); } catch { /* ignore */ } webRec = null; }
    if (state.view === 'call') state.view = state.chatId ? 'chat' : 'home';
    render();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.call.active && state.call.frozenSeconds == null) {
      state.call.paused = true;
      state.micError = 'Call paused. iOS stops the microphone when the screen locks or you leave this app. Open the call and tap Call to resume.';
      bargeIn();
      releaseMic();
      if (webRec) { try { webRec.stop(); } catch { /* ignore */ } }
      if (state.view === 'call' || state.view === 'chat' || state.view === 'home') render();
    }
  });

  window.__intelioPreview = async function (name) {
    if (!state.sample) return false;
    state.bot = profileById('intelio');
    state.call.active = true;
    state.call.paused = false;
    state.call.muted = false;
    state.call.speaker = true;
    state.call.sessionId = 'sample-intelio';
    state.error = '';
    if (name === 'home') {
      state.view = 'home';
      state.call.frozenSeconds = 33;
    } else if (name === 'chat') {
      state.call.frozenSeconds = 19;
      state.chatId = 'sample-lamp';
      state.messages = await loadMessages('sample-lamp', []);
      state.view = 'chat';
    } else if (name === 'call') {
      state.call.frozenSeconds = 14;
      state.captions = await loadMessages('sample-intelio', []);
      state.view = 'call';
    }
    render();
    return true;
  };

  fetch('/session').then((response) => {
    if (response.status === 401) {
      state.view = 'login';
      state.error = 'This Tailscale identity is not allowed.';
      render();
      return null;
    }
    return response.json();
  }).then((body) => {
    if (!body) return null;
    state.login = body.login || '';
    return boot();
  }).catch(() => render());
}());
