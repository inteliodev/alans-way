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
    tab: 'sessions',
    drawer: false,
    skills: [],
    jobs: [],
    skillsOk: false,
    jobsOk: false,
    thinking: false,
    bops: null,
    frames: [],
    speaking: false,
    listening: false,
    searching: false,
    connecting: false,
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
      menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
      chat: '<path d="M5 16.5V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9z"/>',
      feed: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/>',
      library: '<circle cx="7" cy="12" r="2"/><circle cx="17" cy="8" r="2"/><circle cx="17" cy="16" r="2"/><path d="M9 12h6M15 8l-6 3M15 16l-6-3"/>',
      goals: '<path d="M5 12.5l4 4 10-10"/>',
      down: '<path d="M6 10l6 6 6-6"/>',
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

  const AVATARS = {
    intelio: ['#7a5cff', '#3de1ff'],
    prc: ['#059669', '#2dd4bf'],
    alignment: ['#1d4ed8', '#7dd3fc'],
    hhp: ['#d97706', '#fbbf24'],
    'kid-a': ['#e879f9', '#fb7185'],
    'kid a': ['#e879f9', '#fb7185'],
    kida: ['#e879f9', '#fb7185'],
  };
  function hashHue(id) {
    let hash = 2166136261;
    const text = String(id || 'intelio');
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0) % 360;
  }

  function orbColors(profile) {
    const key = String(profile?.id || profile?.name || 'intelio').trim().toLowerCase();
    if (AVATARS[key]) return AVATARS[key];
    const hue = hashHue(key);
    return [`hsl(${hue} 78% 52%)`, `hsl(${(hue + 36) % 360} 85% 68%)`];
  }

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

  function signatureOf(profile) {
    const key = String(profile?.id || profile?.name || profile || 'intelio').trim().toLowerCase();
    if (SIGNATURES[key]) return SIGNATURES[key];
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return OPEN_TYPES[(hash >>> 0) % OPEN_TYPES.length];
  }

  const FACE_PX = { avatar: 72, 'avatar sm': 36, 'avatar lg': 148, face: 32, tile: 96, pip: 28, mark: 96 };
  const CLIENT_VERSION = 'intelio-pwa-7';

  function activityFor(id, still) {
    const signature = signatureOf(id);
    if (still || id !== state.bot.id) return { state: signature, paused: true, speed: 1 };
    if (state.connecting) return { state: 'connecting', paused: false, speed: 1 };
    if (state.call.active && !state.call.paused) {
      if (state.speaking) return { state: 'composing', paused: false, speed: 1 };
      if (state.listening || state.ptt) return { state: 'listening', paused: false, speed: 1 };
    }
    if (state.searching) return { state: 'searching', paused: false, speed: 1 };
    if (state.thinking) return { state: 'working', paused: false, speed: 1 };
    return { state: signature, paused: false, speed: 0.42 };
  }

  function face(profile, className, options) {
    const opts = options || {};
    const name = className || 'avatar';
    const px = FACE_PX[name] || 72;
    const id = String(profile?.id || profile?.name || 'intelio');
    const [core] = orbColors(profile);
    const still = opts.still != null ? opts.still : (name === 'avatar sm' || name === 'pip');
    const canvas = document.createElement('canvas');
    canvas.className = `orb ${name}`;
    canvas.dataset.profile = id;
    canvas.dataset.still = still ? '1' : '0';
    if (opts.pinned) canvas.dataset.pinned = '1';
    canvas.dataset.accent = core;
    canvas.style.setProperty('--orb', core);
    canvas.width = px;
    canvas.height = px;
    const act = opts.state
      ? { state: opts.state, paused: opts.paused != null ? opts.paused : still }
      : activityFor(id, still);
    if (window.ThinkingOrbs) {
      window.ThinkingOrbs.mount(canvas, {
        state: act.state,
        display: px,
        size: 64,
        paused: act.paused,
        speed: act.speed,
        accent: core,
      });
    }
    return canvas;
  }

  function storedTheme() {
    const saved = localStorage.getItem('intelio-theme');
    return saved === 'light' || saved === 'dark' ? saved : '';
  }

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function currentTheme() {
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  function setTheme(mode, persist) {
    const next = mode === 'light' ? 'light' : 'dark';
    if (persist) localStorage.setItem('intelio-theme', next);
    document.documentElement.dataset.theme = next;
    const color = next === 'light' ? '#f4f4f6' : '#070708';
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute('content', color);
      meta.removeAttribute('media');
    });
    const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (apple) apple.setAttribute('content', next === 'light' ? 'default' : 'black-translucent');
  }

  function paintLive() {
    if (!window.ThinkingOrbs) return;
    document.querySelectorAll('canvas.orb').forEach((node) => {
      if (node.dataset.pinned === '1') return;
      const px = node.clientWidth || Number(node.getAttribute('width')) || 64;
      const act = activityFor(node.dataset.profile, node.dataset.still === '1');
      window.ThinkingOrbs.sync(node, {
        state: act.state,
        paused: act.paused,
        speed: act.speed,
        display: px,
        size: 64,
        accent: node.dataset.accent || '',
      });
    });
  }

  function profileHeaders(profileId, extra) {
    const id = profileId || state.bot?.id || '';
    return { ...(extra || {}), ...(id ? { 'x-intelio-profile': id } : {}) };
  }

  function haptic() {
    try { navigator.vibrate?.(10); } catch { /* this browser has no vibration */ }
  }

  function tabs() {
    const items = [['chat', 'Chat', 'chat'], ['sessions', 'Sessions', 'feed']];
    if (state.skillsOk) items.push(['library', 'Library', 'library']);
    if (state.jobsOk) items.push(['goals', 'Goals', 'goals']);
    return items;
  }

  function visibleChats() {
    const q = state.query.trim().toLowerCase();
    return state.home.conversations.filter((row) => !q || `${row.title} ${row.preview}`.toLowerCase().includes(q));
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

  function callbarVisible() {
    return state.call.active && state.view !== 'call' && state.view !== 'login' && state.view !== 'icons' && state.view !== 'settings';
  }

  function paintCallbar() {
    const bar = document.getElementById('callbar');
    if (!callbarVisible()) {
      if (bar) bar.remove();
      return;
    }
    let host = bar;
    if (!host) {
      host = el('div', 'callbar');
      host.id = 'callbar';
      const tab = document.querySelector('.tabbar');
      if (tab) tab.before(host);
      else return;
    }
    host.hidden = false;
    host.replaceChildren();
    const tap = el('button', 'tap');
    tap.type = 'button';
    tap.append(face(state.bot, 'face'), waveform());
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
    host.append(tap, speaker, mute, end);
  }

  function waveform() {
    const wave = el('div', state.call.paused || state.call.muted ? 'wave paused' : 'wave');
    for (let i = 0; i < 8; i++) {
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
    app.replaceChildren();
    if (state.view === 'login') {
      app.append(loginView());
      return;
    }
    const screen = el('div', 'screen');
    screen.append(statusBar());
    if (state.sample) screen.append(sampleFlag());
    if (state.error) screen.append(el('div', 'toast', state.error));
    if (state.view === 'call') screen.append(callView());
    else if (state.view === 'icons') screen.append(iconsView());
    else if (state.view === 'settings') screen.append(settingsView());
    else {
      screen.append(topBar());
      const stage = el('div', 'stage');
      if (state.view === 'chat') stage.append(chatBody());
      else if (state.tab === 'library') stage.append(libraryView());
      else if (state.tab === 'goals') stage.append(goalsView());
      else stage.append(sessionsView());
      screen.append(stage);
      if (state.view === 'chat') screen.append(composer());
      screen.append(tabBar());
      if (state.drawer) screen.append(drawer());
    }
    app.append(screen);
    paintCallbar();
    ensureTimer();
    const thread = document.getElementById('thread') || document.getElementById('captions');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  function loginView() {
    const wrap = el('div', 'login');
    const orb = face({ id: 'intelio', name: 'Intelio' }, 'mark');
    wrap.append(statusBar(), orb, el('h1', '', 'Intelio'), el('p', 'credit', 'Alan’s Way'), el('p', 'note', state.error || 'Checking Tailscale…'));
    return wrap;
  }

  function selectTab(id) {
    haptic();
    state.drawer = false;
    state.tab = id;
    if (id === 'chat') {
      state.view = 'chat';
      if (!state.chatId) {
        const first = state.home.conversations[0];
        if (first) { openChat(first); return; }
      }
    } else state.view = 'home';
    render();
  }

  function topBar() {
    const bar = el('div', 'topbar');
    const menu = el('button', 'iconbtn');
    menu.type = 'button';
    menu.setAttribute('aria-label', 'Menu');
    menu.append(icon('menu'));
    menu.addEventListener('click', () => { haptic(); state.drawer = true; render(); });
    const gear = el('button', 'iconbtn');
    gear.type = 'button';
    gear.setAttribute('aria-label', 'Settings');
    gear.append(icon('gear'));
    gear.addEventListener('click', () => openSettings());
    bar.append(menu);
    if (state.view === 'chat' || state.tab === 'sessions') {
      const hero = el('div', 'hero');
      hero.append(face(state.bot, 'avatar'));
      const pill = el('button', 'name-pill', state.bot.name || 'Intelio');
      pill.type = 'button';
      pill.addEventListener('click', () => { if (state.view !== 'chat') selectTab('chat'); });
      hero.append(pill);
      bar.append(hero);
    }
    bar.append(gear);
    return bar;
  }

  function sessionsView() {
    const list = el('div', 'feed');
    list.id = 'list';
    list.append(agentStrip());
    const rows = visibleChats();
    if (!rows.length) list.append(el('p', 'empty', state.sample ? 'No sample conversations.' : 'No conversations yet.'));
    for (const row of rows) list.append(sessionCard(row));
    return list;
  }

  function sessionCard(row) {
    const profile = profileById(row.profileId);
    const button = el('button', 'feed-card');
    button.type = 'button';
    button.append(face(profile, 'avatar sm'));
    const copy = el('div', 'copy');
    copy.append(el('strong', '', row.title), el('p', '', row.preview || ''));
    button.append(copy);
    const live = (state.call.active && state.call.sessionId === row.id) || row.inCall;
    if (live) {
      const pill = el('span', 'pill');
      if (state.call.active && state.call.sessionId === row.id) pill.id = 'call-pill';
      const seconds = state.call.active && state.call.sessionId === row.id ? callElapsed() : (row.inCall ? 33 : 0);
      pill.append(el('i'), document.createTextNode(`in call ${clock(seconds, 'pill')}`));
      button.append(pill);
    } else if (state.call.endedLabel && state.call.sessionId === row.id) button.append(el('span', 'pill', state.call.endedLabel));
    else button.append(el('span', 'when', row.time || ''));
    button.addEventListener('click', () => openChat(row));
    return button;
  }

  function libraryView() {
    const list = el('div', 'feed');
    if (!state.skills.length) list.append(el('p', 'empty', 'No skills on this profile.'));
    for (const skill of state.skills) {
      const card = el('article', 'lib-card');
      const head = el('div', 'lib-head');
      head.append(face(state.bot, 'avatar sm'), el('strong', '', skill.name));
      card.append(head, el('p', '', skill.description || skill.category || ''));
      list.append(card);
    }
    return list;
  }

  function goalsView() {
    const list = el('div', 'feed');
    if (!state.jobs.length) list.append(el('p', 'empty', 'No scheduled jobs.'));
    for (const job of state.jobs) {
      const card = el('article', 'lib-card');
      card.append(el('strong', '', job.name || 'Scheduled job'));
      card.append(el('p', '', [job.schedule, job.status, job.detail].filter(Boolean).join(' · ')));
      list.append(card);
    }
    return list;
  }

  function chatBody() {
    const thread = el('div', 'thread');
    thread.id = 'thread';
    fillThread(thread, state.messages);
    return thread;
  }

  function composer() {
    const wrap = el('div', 'composer-wrap');
    const jump = el('button', 'jump');
    jump.id = 'jump';
    jump.type = 'button';
    jump.hidden = true;
    jump.setAttribute('aria-label', 'Latest messages');
    jump.append(icon('down'));
    jump.addEventListener('click', () => {
      const thread = document.getElementById('thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
      jump.hidden = true;
    });
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
      if (text) { haptic(); sendTurn(text); }
    });
    wrap.append(jump, form);
    return wrap;
  }

  function tabBar() {
    const bar = el('nav', 'tabbar');
    for (const [id, label, glyph] of tabs()) {
      const button = el('button', `tab${(id === 'chat' ? state.view === 'chat' : state.view !== 'chat' && state.tab === id) ? ' on' : ''}`);
      button.type = 'button';
      button.append(icon(glyph), el('span', '', label));
      button.addEventListener('click', () => selectTab(id));
      bar.append(button);
    }
    return bar;
  }

  function drawer() {
    const root = document.createDocumentFragment();
    const backdrop = el('button', 'backdrop');
    backdrop.type = 'button';
    backdrop.setAttribute('aria-label', 'Close menu');
    backdrop.addEventListener('click', () => { state.drawer = false; render(); });
    const panel = el('aside', 'drawer');
    const head = el('div', 'drawer-head');
    head.append(el('h1', '', state.bot.name || 'Intelio'));
    const gear = el('button', 'iconbtn');
    gear.type = 'button';
    gear.setAttribute('aria-label', 'Settings');
    gear.append(icon('gear'));
    gear.addEventListener('click', () => openSettings());
    head.append(gear);
    panel.append(head);
    const settingsRow = el('button', 'navbtn');
    settingsRow.type = 'button';
    settingsRow.append(icon('gear'), el('span', '', 'Settings'));
    settingsRow.addEventListener('click', () => openSettings());
    panel.append(settingsRow);
    panel.append(el('div', 'kicker', 'AGENTS'));
    for (const profile of state.home.profiles) {
      const button = el('button', `navbtn${profile.id === state.bot.id ? ' on' : ''}`);
      button.type = 'button';
      button.append(face(profile, 'pip'), el('span', '', profile.name || profile.id));
      button.addEventListener('click', () => selectProfile(profile));
      panel.append(button);
    }
    const create = el('button', 'navbtn');
    create.type = 'button';
    create.append(icon('plus'), el('span', '', 'New agent'));
    create.addEventListener('click', () => { state.drawer = false; openSheet('agent'); });
    panel.append(create, el('div', 'kicker', 'TABS'));
    for (const [id, label, glyph] of tabs()) {
      const button = el('button', `navbtn${(id === 'chat' ? state.view === 'chat' : state.tab === id && state.view !== 'chat') ? ' on' : ''}`);
      button.type = 'button';
      button.append(icon(glyph), el('span', '', label));
      button.addEventListener('click', () => selectTab(id));
      panel.append(button);
    }
    panel.append(el('div', 'kicker', 'SIDE CHATS'));
    const sides = el('div', 'sides');
    for (const row of visibleChats()) {
      const button = el('button', 'sidechat', row.title);
      button.type = 'button';
      button.addEventListener('click', () => openChat(row));
      sides.append(button);
    }
    const search = el('div', 'searchline');
    const input = document.createElement('input');
    input.placeholder = 'Search';
    input.value = state.query;
    input.addEventListener('input', () => {
      state.query = input.value;
      sides.replaceChildren();
      for (const row of visibleChats()) {
        const button = el('button', 'sidechat', row.title);
        button.type = 'button';
        button.addEventListener('click', () => openChat(row));
        sides.append(button);
      }
    });
    const newer = el('button', 'iconbtn');
    newer.type = 'button';
    newer.setAttribute('aria-label', 'New chat');
    newer.append(icon('plus'));
    newer.addEventListener('click', () => { state.drawer = false; openSheet('new'); });
    search.append(input, newer);
    panel.append(sides, search);
    root.append(backdrop, panel);
    return root;
  }

  function iconsView() {
    const wrap = el('div', 'icons');
    const names = [['Intelio', 'intelio'], ['PRC', 'prc'], ['Alignment', 'alignment'], ['HHP', 'hhp'], ['Kid A', 'kid-a'], ['Lumen', 'lumen'], ['Nimbus', 'nimbus']];
    names.forEach(([label, id]) => {
      const figure = document.createElement('figure');
      figure.append(face({ id }, 'tile', { paused: true, still: true, pinned: true }), el('figcaption', '', label));
      wrap.append(figure);
    });
    return wrap;
  }

  function fillThread(thread, messages) {
    thread.replaceChildren();
    for (const message of messages) {
      if (message.role === 'activity' || message.role === 'tool') thread.append(toolCard(message));
      else if (message.role === 'time') thread.append(el('div', 'stamp', message.text));
      else if (message.role === 'choice') {
        const choice = el('button', 'choice', message.text);
        choice.type = 'button';
        choice.addEventListener('click', () => sendTurn(message.text));
        thread.append(choice);
      } else thread.append(el('div', `bubble ${message.role === 'user' ? 'user' : 'bot'}`, message.text));
    }
    const block = bopsBlock();
    if (block) thread.prepend(block);
    if (state.call?.active) thread.prepend(el('div', 'call-pill', `in call ${clock(callElapsed(), 'pill')}`));
    else if (state.call?.endedLabel) thread.prepend(el('div', 'call-pill', state.call.endedLabel));
    queueMicrotask(() => {
      const jump = document.getElementById('jump');
      if (!jump) return;
      thread.addEventListener('scroll', () => {
        const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
        jump.hidden = gap < 72;
      });
    });
  }

  function toolCard(message) {
    let title = message.title || 'Tool';
    let text = message.text || '';
    if (!message.title && text.includes(' · ')) {
      const parts = text.split(' · ');
      title = parts.shift();
      text = parts.join(' · ');
    }
    const card = el('article', 'toolcard');
    const head = el('div', 'toolhead');
    head.append(face(state.bot, 'avatar sm'), el('strong', '', title));
    const status = el('button', 'status', message.status || 'Done');
    status.type = 'button';
    status.addEventListener('click', () => openSheet('tool', { title, text, status: message.status || 'Done' }));
    head.append(status);
    card.append(head, el('p', '', text));
    return card;
  }

  function callView() {
    const frag = document.createDocumentFragment();
    const top = el('header', 'topbar');
    const min = el('button', 'iconbtn');
    min.type = 'button';
    min.setAttribute('aria-label', 'Minimize');
    min.append(icon('back'));
    min.addEventListener('click', () => { state.view = state.chatId ? 'chat' : 'home'; state.tab = state.chatId ? 'chat' : 'sessions'; render(); });
    top.append(min);
    const hero = el('div', 'call-hero');
    const timer = el('p', 'timer', clock(callElapsed(), 'screen'));
    timer.id = 'call-timer';
    hero.append(face(state.bot, 'avatar lg'), el('h1', '', state.bot.name || 'Intelio'), timer);
    const captions = el('div', 'captions');
    captions.id = 'captions';
    fillCaptions(captions, state.captions);
    const controls = el('div', 'controls');
    const gear = roundButton('gear', () => openSettings());
    const speaker = roundButton('speaker', () => { state.call.speaker = !state.call.speaker; if (!state.call.speaker) bargeIn(); render(); });
    if (state.call.speaker) speaker.classList.add('on');
    const mute = roundButton('mic', () => { state.call.muted = !state.call.muted; render(); });
    if (state.call.muted) mute.classList.add('off');
    const end = el('button', 'end');
    end.type = 'button';
    end.setAttribute('aria-label', 'End call');
    end.textContent = '×';
    end.addEventListener('click', () => { haptic(); endCall(); });
    controls.append(gear, speaker, mute, end);
    frag.append(top, hero, captions, controls);
    if (state.call.paused && state.micError) {
      frag.append(el('p', 'empty', state.micError));
      const resume = el('button', 'block', 'Resume call');
      resume.type = 'button';
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
    state.skills = Array.isArray(state.home.skills) ? state.home.skills : [];
    state.jobs = Array.isArray(state.home.jobs) ? state.home.jobs : [];
    state.skillsOk = Boolean(state.home.skillsOk);
    state.jobsOk = Boolean(state.home.jobsOk);
    state.tab = 'sessions';
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
    state.tab = 'chat';
    state.drawer = false;
    state.messages = [];
    render();
    await loadMessages(row.id, state.messages);
    if (state.call.active && state.call.sessionId === row.id) state.captions = state.messages;
    render();
  }

  async function loadMessages(id, target) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, { headers: profileHeaders(state.bot?.id) });
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
    const response = await fetch('/api/sessions', { method: 'POST', headers: profileHeaders(profile.id, { 'content-type': 'application/json' }), body: JSON.stringify({ title: profile.name || 'Intelio', profile: profile.id }) });
    const body = await response.json().catch(() => ({}));
    const id = body.id || (body.data && body.data.id);
    if (!id) { state.error = body.error || 'Could not start a chat.'; render(); return; }
    state.chatId = id;
    state.messages = [];
    state.view = 'chat';
    state.tab = 'chat';
    state.drawer = false;
    render();
  }

  function agentStrip() {
    const strip = el('div', 'agents');
    for (const profile of state.home.profiles) {
      const button = el('button', `agent${profile.id === state.bot.id ? ' on' : ''}`);
      button.type = 'button';
      button.append(face(profile, 'avatar sm'), el('span', '', profile.name || profile.id));
      button.addEventListener('click', () => selectProfile(profile));
      strip.append(button);
    }
    return strip;
  }

  function selectProfile(profile) {
    haptic();
    state.bot = profile;
    state.drawer = false;
    state.view = 'home';
    state.tab = 'sessions';
    render();
  }

  function openSettings() {
    haptic();
    if (state.view !== 'settings') {
      state.returnView = state.view;
      state.returnTab = state.tab;
    }
    state.drawer = false;
    state.view = 'settings';
    render();
  }

  function closeSettings() {
    state.view = state.returnView && state.returnView !== 'settings' ? state.returnView : 'home';
    state.tab = state.returnTab || (state.view === 'chat' ? 'chat' : 'sessions');
    render();
  }

  function signInLine() {
    if (state.sample) return 'SAMPLE DATA. Signed in with Tailscale. The profile key stays on the VPS.';
    if (state.login && state.login !== 'sample') return `Signed in with Tailscale as ${state.login}. The profile key stays on the VPS.`;
    return 'Signed in with Tailscale. The profile key stays on the VPS.';
  }

  function voiceFields() {
    const frag = document.createDocumentFragment();
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
    return frag;
  }

  function settingsView() {
    const wrap = el('div', 'settings');
    const top = el('header', 'topbar');
    const back = el('button', 'iconbtn');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back');
    back.append(icon('back'));
    back.addEventListener('click', () => closeSettings());
    const title = el('h1', 'settings-title', 'Settings');
    top.append(back, title);
    wrap.append(top);
    wrap.append(el('h2', '', 'Voice'));
    wrap.append(voiceFields());
    wrap.append(el('h2', '', 'Sign-in'));
    wrap.append(el('p', '', signInLine()));
    wrap.append(el('h2', '', 'Appearance'));
    const toggle = el('button', 'theme-toggle');
    toggle.id = 'theme-toggle';
    toggle.type = 'button';
    const paintToggle = () => {
      const light = currentTheme() === 'light';
      toggle.textContent = light ? 'Light' : 'Dark';
      toggle.setAttribute('aria-pressed', light ? 'true' : 'false');
    };
    paintToggle();
    toggle.addEventListener('click', () => {
      setTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
      paintToggle();
    });
    wrap.append(toggle, el('p', '', 'Follows this phone until you tap. The choice is saved on this device.'));
    wrap.append(el('h2', '', 'About'));
    wrap.append(el('p', '', 'Intelio · Alan’s Way'));
    wrap.append(el('p', 'version', `Version ${CLIENT_VERSION}`));
    return wrap;
  }

  function openSheet(name, extra) {
    state.sheet = name;
    const existing = document.getElementById('sheet');
    if (existing) existing.remove();
    const sheet = el('div', 'sheet');
    sheet.id = 'sheet';
    const card = el('div', 'card');
    if (name === 'settings') card.append(settingsCard());
    else if (name === 'tool') card.append(toolSheet(extra || {}));
    else if (name === 'agent') card.append(agentCard());
    else if (name === 'restart') card.append(restartCard());
    else card.append(newCard());
    sheet.append(card);
    sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.remove(); });
    app.append(sheet);
  }

  function toolSheet(extra) {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', extra.title || 'Tool'));
    frag.append(el('p', '', extra.text || ''));
    frag.append(el('p', '', extra.status || 'Done'));
    return frag;
  }

  function settingsCard() {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', 'Voice'));
    frag.append(voiceFields());
    frag.append(el('p', '', signInLine()));
    return frag;
  }

  function agentCard() {
    const frag = document.createDocumentFragment();
    const head = el('div', 'agent-head');
    const preview = face({ id: 'new-agent', name: 'New' }, 'avatar sm', { still: true, pinned: true });
    preview.id = 'agent-preview';
    head.append(preview, el('h2', '', 'New agent'));
    frag.append(head);
    const name = document.createElement('input');
    name.id = 'agent-name';
    name.placeholder = 'Name';
    name.autocomplete = 'off';
    name.maxLength = 32;
    const description = document.createElement('input');
    description.id = 'agent-description';
    description.placeholder = 'One-line description';
    description.maxLength = 240;
    const select = document.createElement('select');
    select.id = 'agent-from';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Start blank';
    select.append(blank);
    for (const profile of state.home.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = `Start from ${profile.name || profile.id}`;
      select.append(option);
    }
    const save = el('button', 'block', 'Create agent');
    save.type = 'button';
    save.addEventListener('click', () => createAgent(name.value, description.value, select.value));
    name.addEventListener('input', () => {
      const slug = name.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'new-agent';
      const [core] = orbColors({ id: slug });
      preview.dataset.profile = slug;
      preview.dataset.accent = core;
      preview.style.setProperty('--orb', core);
      if (window.ThinkingOrbs) window.ThinkingOrbs.sync(preview, { accent: core, state: signatureOf(slug), paused: true, display: 36, size: 64 });
    });
    frag.append(name, description, select, save);
    frag.append(el('p', '', 'A new agent uses the shared Codex sign-in. Its route appears after the gateway restarts.'));
    return frag;
  }

  async function createAgent(name, description, cloneFrom) {
    const response = await fetch('/api/profiles', {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name, description, cloneFrom }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      state.error = body.error || 'Could not create that agent.';
      render();
      return;
    }
    const created = { id: body.id, name: body.name || body.id, description: body.description || '', status: 'online' };
    if (!state.home.profiles.some((item) => item.id === created.id)) state.home.profiles.push(created);
    state.bot = created;
    document.getElementById('sheet')?.remove();
    render();
    if (body.needsGatewayRestart) openSheet('restart');
  }

  function restartCard() {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', 'Restart the gateway?'));
    frag.append(el('p', '', 'The new agent is saved. Restarting the gateway makes its route available. Telegram reconnects briefly.'));
    const yes = el('button', 'block', 'Restart gateway');
    yes.type = 'button';
    yes.addEventListener('click', () => confirmRestart());
    const no = el('button', 'block quiet', 'Not now');
    no.type = 'button';
    no.addEventListener('click', () => { document.getElementById('sheet')?.remove(); render(); });
    frag.append(yes, no);
    return frag;
  }

  async function confirmRestart() {
    const response = await fetch('/api/gateway/restart', {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: '{}',
    });
    const body = await response.json().catch(() => ({}));
    document.getElementById('sheet')?.remove();
    state.error = response.ok ? '' : (body.error || 'The gateway did not restart.');
    render();
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
    state.listening = true;
    paintLive();
    button.classList.add('hot');
    state.pttText = '';
    try {
      await unlockAudio();
      if (resolvedEngine() === 'web') { startWebRecognizer(false); return; }
      await openMic();
      startRecorder();
    } catch (error) {
    state.ptt = false;
    state.listening = false;
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
    state.listening = false;
    paintLive();
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
      if (interim && state.call.active) {
        if (!state.listening) { state.listening = true; paintLive(); }
        bargeIn();
      }
      if (finalText.trim()) {
        state.listening = false;
        sendTurn(finalText.trim());
      }
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
    const response = await fetch('/api/voice/stt', { method: 'POST', headers: profileHeaders(state.bot?.id, { 'content-type': type, 'x-intelio-engine': engine() }), body });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(json.error || 'Could not transcribe.');
      error.fallback = json.fallback;
      throw error;
    }
    return json.text || '';
  }

  function phoneSignIn(api, signIn) {
    const card = el('form', 'bops-signin');
    const head = el('div', 'signin-head');
    head.append(el('span', 'signin-mark', (signIn.domain || 'S').slice(0, 1).toUpperCase()), el('strong', '', signIn.title));
    card.append(head);
    for (const field of signIn.fields) {
      const label = el('label', 'signin-label', field.label);
      const input = el('input');
      input.type = field.type;
      input.autocomplete = field.autocomplete || 'off';
      input.dataset.field = field.id;
      label.append(input);
      card.append(label);
    }
    const save = el('label', 'signin-save', 'Save login');
    const box = el('input');
    box.type = 'checkbox';
    box.dataset.field = 'save';
    save.append(box);
    card.append(save);
    const actions = el('div', 'bops-actions');
    const submit = el('button', 'bops-action', 'Submit');
    submit.type = 'submit';
    const screen = el('button', 'bops-action', 'Do it on screen');
    screen.type = 'button';
    screen.addEventListener('click', () => {
      const result = api.doOnScreen(state.bops, signIn.taskId);
      state.bops = result.run;
      paintThread();
    });
    actions.append(submit, screen);
    card.append(actions);
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = {};
      card.querySelectorAll('input').forEach((input) => {
        if (input.dataset.field === 'save') values.save = input.checked;
        else values[input.dataset.field] = input.value;
        if (input.type === 'password') input.value = '';
      });
      const result = api.submitSignIn(state.bops, signIn.taskId, values);
      state.bops = result.run;
      const effect = result.effect;
      if (effect?.type === 'secure-signin') {
        await fetch('/api/vault/login', {
          method: 'POST',
          headers: profileHeaders(state.bops?.profile, { 'content-type': 'application/json' }),
          body: JSON.stringify({
            profile: state.bops?.profile,
            domain: effect.domain,
            username: effect.username,
            password: effect.password,
            otp: effect.otp,
            save: effect.save === true,
            selectors: effect.selectors || null,
          }),
        }).catch(() => {});
      }
      paintThread();
    });
    return card;
  }

  function bopsBlock() {
    const api = window.IntelioBops;
    if (!api || !state.bops) return null;
    const caption = state.frames.filter((frame) => frame.taskId === state.bops.focusedId).slice(-1)[0]?.caption || '';
    const view = api.viewModel(state.bops, caption);
    if (!view.header && !view.handoff && !view.signIn && !(view.statusLines || []).length && view.pills.length < 2) return null;
    const bar = el('div', 'bops-bar');
    const head = el('div', 'bops-head');
    head.append(el('span', '', view.header || view.preview.badge));
    if (view.stopAll) {
      const stop = el('button', 'bops-stop', 'Stop all');
      stop.type = 'button';
      stop.addEventListener('click', () => {
        state.bops = api.stopAll(state.bops);
        paintThread();
      });
      head.append(stop);
    }
    bar.append(head);
    const pills = el('div', 'bops-pills');
    for (const pill of view.pills) {
      const button = el('button', `bops-pill${pill.focused ? ' focused' : ''}`, pill.title);
      button.type = 'button';
      button.dataset.status = pill.status;
      button.addEventListener('click', () => {
        state.bops = api.focusTask(state.bops, pill.id);
        paintThread();
      });
      pills.append(button);
    }
    bar.append(pills);
    if (view.handoff) bar.append(el('p', 'bops-handoff', view.handoff.label));
    for (const line of view.statusLines || []) bar.append(el('p', 'bops-status-line', line.text));
    if (view.signIn) bar.append(phoneSignIn(api, view.signIn));
    const preview = el('div', 'bops-preview');
    preview.style.setProperty('--bops-highlight', view.preview.highlight);
    preview.append(el('div', '', view.preview.badge));
    if (view.preview.caption) preview.append(el('div', '', view.preview.caption));
    bar.append(preview);
    return bar;
  }

  async function runPhonePlan(plan) {
    const api = window.IntelioBops;
    async function one(task) {
      if (state.bops?.stopped) return;
      let sessionId = task.createSession ? '' : ((state.call.active && state.call.sessionId) || state.chatId);
      try {
        if (task.createSession) {
          const created = await fetch('/api/sessions', {
            method: 'POST',
            headers: profileHeaders(task.profile, { 'content-type': 'application/json' }),
            body: JSON.stringify({ title: task.input.slice(0, 80), profile: task.profile }),
          });
          const json = await created.json().catch(() => ({}));
          if (!created.ok || !json.id) throw new Error(json.error || 'Hermes did not return a session id.');
          sessionId = json.id;
          state.bops = api.rememberSession(state.bops, task.taskId, sessionId);
        }
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
          method: 'POST',
          headers: profileHeaders(task.profile, { 'content-type': 'application/json' }),
          body: JSON.stringify({ input: task.input, profile: task.profile }),
        });
        if (!response.ok || !response.body) {
          const json = await response.json().catch(() => ({}));
          state.bops = api.applyTaskResult(state.bops, task.taskId, { ok: false, error: json.error || 'blocked' });
        } else {
          let blocked = null;
          await readSse(response, (event, data) => {
            let payload = {};
            try { payload = JSON.parse(data); } catch { payload = { text: data }; }
            const signal = api.signalFromEvent(event, payload);
            if (signal) blocked = signal;
          });
          if (!state.bops?.stopped) state.bops = api.applyTaskResult(state.bops, task.taskId, blocked || { ok: true });
        }
      } catch (error) {
        if (!state.bops?.stopped) state.bops = api.applyTaskResult(state.bops, task.taskId, { ok: false, error: error.message });
      }
      paintThread();
    }
    const jobs = plan.tasks.map(one);
    if (plan.handoff) {
      jobs.push((async () => {
        try {
          const created = await fetch('/api/sessions', {
            method: 'POST',
            headers: profileHeaders(plan.handoff.profile, { 'content-type': 'application/json' }),
            body: JSON.stringify({ title: plan.handoff.title, profile: plan.handoff.profile }),
          });
          const json = await created.json().catch(() => ({}));
          if (created.ok && json.id) {
            await fetch(`/api/sessions/${encodeURIComponent(json.id)}/chat`, {
              method: 'POST',
              headers: profileHeaders(plan.handoff.profile, { 'content-type': 'application/json' }),
              body: JSON.stringify({ input: plan.handoff.input, profile: plan.handoff.profile }),
            });
          }
        } catch { /* the handoff line stays; the stub does not copy a key */ }
      })());
    }
    await Promise.all(jobs);
  }

  async function sendTurn(text) {
    const sessionId = (state.call.active && state.call.sessionId) || state.chatId;
    if (!sessionId || !text) return;
    const api = window.IntelioBops;
    if (api) {
      const run = api.startRun({ text, profile: state.bot?.id || 'intelio', agentName: state.bot?.name || 'Intelio' });
      if (run.orchestration === 'app-fan-out' || run.handoff) {
        state.bops = run;
        pushLine('user', text);
        paintThread();
        state.thinking = true;
        try { await runPhonePlan(api.executionPlan(run)); } finally { state.thinking = false; paintThread(); }
        return;
      }
    }
    pushLine('user', text);
    const pending = { role: 'assistant', text: '', pending: true };
    for (const bucket of buckets()) bucket.push(pending);
    paintThread();
    unspoken = '';
    state.thinking = true;
    paintLive();
    try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: JSON.stringify({ input: text, profile: state.bot?.id || '' }),
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
        const failed = event.includes('fail');
        const done = failed || event.includes('complete') || event.includes('result') || event.includes('finished');
        if (/search|browse|web|fetch|http|crawl/i.test(String(name))) {
          state.searching = !done;
          paintLive();
        }
        if (event.includes('start') || done) {
          pushLine('activity', payload.summary || payload.error || name, { title: name, status: failed ? 'Failed' : (done ? 'Done' : 'Running') });
        }
        if (done) {
          pending.pending = false;
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
    } finally {
      state.thinking = false;
      state.searching = false;
      paintLive();
    }
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
    state.speaking = true;
    paintLive();
    const token = ttsToken;
    try {
      while (speakQueue.length && token === ttsToken && state.call.speaker && state.call.active) {
        const sentence = speakQueue.shift();
        try { await speakOne(sentence, token); } catch { /* keep the conversation going */ }
      }
    } finally {
      pumping = false;
      state.speaking = false;
      paintLive();
    }
  }

  async function speakOne(sentence, token) {
    if (resolvedEngine() === 'web') return speakWeb(sentence, token);
    const response = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json', 'x-intelio-engine': engine() }),
      body: JSON.stringify({ text: sentence, profile: state.bot?.id || '' }),
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
        state.listening = true;
        paintLive();
        bargeIn();
        startRecorder();
      }
      mic.quietSince = 0;
    } else if (mic.speaking && level < VAD_KEEP) {
      if (!mic.quietSince) mic.quietSince = now;
      if (now - mic.quietSince > SILENCE_MS) {
        mic.speaking = false;
        state.listening = false;
        paintLive();
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
    state.connecting = true;
    state.listening = false;
    render();
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
    } finally {
      state.connecting = false;
    }
    if (state.micError) render();
    else paintLive();
  }

  function micMessage(error) {
    if (!window.isSecureContext) return 'The microphone needs HTTPS. Open the tailscale cert address, then tap Call again.';
    if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return 'Allow the microphone, then tap Call again. iOS only asks after a tap on an HTTPS page.';
    if (error && error.name === 'NotFoundError') return 'This device has no microphone.';
    return error && error.message ? error.message : 'The microphone did not start.';
  }

  async function endCall() {
    const seconds = state.call.frozenSeconds != null
      ? Math.round(state.call.frozenSeconds)
      : Math.max(0, Math.round((Date.now() - (state.call.startedAt || Date.now())) / 1000));
    state.call.endedLabel = `${seconds}s - Call ended`;
    state.call.active = false;
    state.call.paused = false;
    state.listening = false;
    state.connecting = false;
    state.speaking = false;
    bargeIn();
    releaseMic();
    if (webRec) { try { webRec.stop(); } catch { /* ignore */ } webRec = null; }
    if (state.view === 'call') {
      state.view = state.chatId ? 'chat' : 'home';
      state.tab = state.chatId ? 'chat' : 'sessions';
    }
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
    state.thinking = false;
    state.speaking = false;
    state.listening = false;
    state.searching = false;
    state.connecting = false;
    state.call.active = true;
    state.call.paused = false;
    state.call.muted = false;
    state.call.speaker = true;
    state.call.sessionId = 'sample-intelio';
    state.error = '';
    if (name === 'home' || name === 'drawer') {
      state.view = 'home';
      state.tab = 'sessions';
      state.drawer = name === 'drawer';
      state.call.frozenSeconds = 33;
    } else if (name === 'chat') {
      state.call.active = false;
      state.thinking = true;
      state.chatId = 'sample-lamp';
      state.messages = await loadMessages('sample-lamp', []);
      state.view = 'chat';
      state.tab = 'chat';
      state.drawer = false;
    } else if (name === 'call') {
      state.call.frozenSeconds = 14;
      state.listening = true;
      state.captions = await loadMessages('sample-intelio', []);
      state.view = 'call';
    } else if (name === 'icons') {
      state.call.active = false;
      state.view = 'icons';
    } else if (name === 'settings') {
      state.call.active = false;
      state.view = 'settings';
      state.drawer = false;
    } else if (name === 'agent') {
      state.call.active = false;
      state.view = 'home';
      state.tab = 'sessions';
      state.drawer = false;
      render();
      openSheet('agent');
      return true;
    }
    render();
    return true;
  };

  const savedTheme = storedTheme();
  if (savedTheme) setTheme(savedTheme, false);
  else {
    setTheme(systemTheme(), false);
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const followSystem = () => { if (!storedTheme()) setTheme(systemTheme(), false); };
    if (media.addEventListener) media.addEventListener('change', followSystem);
    else if (media.addListener) media.addListener(followSystem);
  }

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
