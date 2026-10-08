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
    bot: { id: 'intelio', name: 'intelio', color: '#ff8a1f', status: 'online' },
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
    readFor: '',
    readAt: 0,
    bops: null,
    frames: [],
    speaking: false,
    listening: false,
    searching: false,
    connecting: false,
    browserControl: false,
    browserPane: 'computer',
    profileTab: 'details',
    profileCard: null,
    profileNote: '',
    profileQuery: '',
    profileConfirm: false,
    profileBusy: false,
    profileLoaded: '',
    profileEdit: false,
    soulOpen: false,
    colorOpen: false,
    screens: [],
    updateReady: false,
    modelOpen: false,
    modelId: '',
    modelProvider: '',
    modelEffort: 'auto',
    modelGroups: [],
    modelApplied: '',
    modelNote: '',
    profileModel: '',
  };
  let rfb = null;
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
      monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
      lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
      eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      moon: '<path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
      waveform: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10v4"/>',
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
    hhp: ['#0f766e', '#5eead4'],
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
    const custom = String(profile?.color || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(custom)) return [custom, custom];
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

  const ORB_CHOICES = ['connecting', 'solving', 'searching', 'weaving', 'working', 'listening', 'breathing', 'shaping', 'composing'];
  const ORB_LABELS = { connecting: 'Connecting', solving: 'Solving', searching: 'Searching', weaving: 'Weaving', working: 'Working', listening: 'Listening', breathing: 'Breathing', shaping: 'Shaping', composing: 'Composing' };
  function excludedAgent(id) {
    const slug = String(id || '').trim().toLowerCase();
    const compact = slug.replace(/[\s_]+/g, '-');
    if (!slug || slug === 'default') return true;
    if (slug === 'kid-a' || slug === 'kida' || slug === 'kid a' || compact === 'kid-a' || compact.startsWith('kid-a-')) return true;
    if (slug.includes('alignment-bot-vps') || compact.includes('alignment-bot-vps')) return true;
    return false;
  }
  function signatureOf(profile) {
    const chosen = String(profile?.orb || '').trim().toLowerCase();
    if (ORB_CHOICES.includes(chosen)) return chosen;
    const key = String(profile?.id || profile?.name || profile || 'intelio').trim().toLowerCase();
    if (SIGNATURES[key]) return SIGNATURES[key];
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return OPEN_TYPES[(hash >>> 0) % OPEN_TYPES.length];
  }

  const FACE_PX = { avatar: 72, 'avatar sm': 36, 'avatar lg': 148, face: 32, tile: 96, pip: 28, mark: 96 };
  const VPS_AGENTS = ['intelio', 'prc', 'alignment', 'hhp'];
  const AGENT_NAMES = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP', arlp: 'ARLP' };
  function workStatus() {
    const tasks = (state.bops?.tasks || []).filter((task) => task.status === 'running').length;
    const steps = (state.messages || []).filter((row) => row.liveStep && row.status === 'Running').length;
    let count = 0;
    if (tasks > 1) count = tasks;
    else if (steps) count = steps;
    else if (state.thinking || tasks === 1) count = Math.max(tasks, 1);
    if (!count) return '';
    return `Working on ${count} ${count === 1 ? 'thing' : 'things'}`;
  }

  function readText(at) {
    if (window.IntelioTranscript?.readText) return window.IntelioTranscript.readText(at);
    const time = new Date(at || Date.now());
    if (!Number.isFinite(time.getTime())) return '';
    return `Read ${time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }

  function agentLabel(profile) {
    const id = String(profile?.id || '').trim().toLowerCase();
    if (AGENT_NAMES[id]) return AGENT_NAMES[id];
    const name = String(profile?.name || '').trim();
    if (name.toLowerCase() === 'intelio') return 'intelio';
    return name || 'intelio';
  }
  const CLIENT_VERSION = 'intelio-pwa-24';

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

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function themeIconButton() {
    const light = currentTheme() === 'light';
    const button = el('button', 'iconbtn theme-toggle');
    button.type = 'button';
    button.id = 'theme-toggle';
    button.title = light ? 'Dark mode' : 'Light mode';
    button.setAttribute('aria-label', button.title);
    button.append(icon(light ? 'moon' : 'sun'));
    button.addEventListener('click', () => {
      setTheme(light ? 'dark' : 'light', true);
      render();
    });
    return button;
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

  function vpsAgents(profiles) {
    const rows = (Array.isArray(profiles) ? profiles : []).filter((item) => !excludedAgent(item.id));
    const rank = { intelio: 0, prc: 1, alignment: 2, hhp: 3 };
    return rows.slice().sort((a, b) => {
      const left = rank[String(a.id || '').toLowerCase()] ?? 9;
      const right = rank[String(b.id || '').toLowerCase()] ?? 9;
      if (left !== right) return left - right;
      return String(a.id).localeCompare(String(b.id));
    }).map((item) => ({ ...item, name: agentLabel(item) }));
  }

  function visibleChats() {
    const id = String(state.bot?.id || 'intelio').toLowerCase();
    const q = state.query.trim().toLowerCase();
    return state.home.conversations.filter((row) => {
      const profile = String(row.profileId || '').toLowerCase();
      if (excludedAgent(profile) || profile !== id) return false;
      return !q || `${row.title} ${row.preview}`.toLowerCase().includes(q);
    });
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
    if (state.updateReady) screen.append(updateBanner());
    const hint = installHint();
    if (hint) screen.append(hint);
    if (state.error) screen.append(el('div', 'toast', state.error));
    if (state.view === 'call') screen.append(callView());
    else if (state.view === 'icons') screen.append(iconsView());
    else if (state.view === 'settings') screen.append(settingsView());
    else if (state.view === 'browser') screen.append(browserView());
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
    const orb = face({ id: 'intelio', name: 'intelio' }, 'mark');
    wrap.append(statusBar(), orb, el('h1', '', 'intelio'), el('p', 'credit', 'Alan’s Way'), el('p', 'note', state.error || 'Checking sign-in…'));
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
    const bar = el('div', state.view === 'chat' ? 'topbar chat-top' : 'topbar home-top');
    if (state.view === 'chat') {
      const back = el('button', 'iconbtn');
      back.type = 'button';
      back.classList.add('chat-back');
      back.setAttribute('aria-label', 'Back');
      back.append(icon('back'));
      back.addEventListener('click', () => { haptic(); state.view = 'home'; state.tab = 'sessions'; render(); });
      const call = el('button', 'iconbtn');
      call.type = 'button';
      call.classList.add('chat-phone');
      call.title = 'Call my phone';
      call.setAttribute('aria-label', 'Call my phone');
      call.append(icon('phone'));
      call.addEventListener('click', () => { haptic(); callMyPhone(); });
      const hero = el('button', 'chat-hero');
      hero.type = 'button';
      hero.append(face(state.bot, 'avatar sm'));
      const card = el('span', 'chat-card');
      card.append(el('strong', '', agentLabel(state.bot)));
      card.append(el('span', '', state.bot?.title || state.bot?.description || 'Agent'));
      hero.append(card);
      hero.addEventListener('click', () => { haptic(); openBrowser('agent'); });
      bar.append(back, hero, call);
      if (state.phoneNote) {
        const note = el('p', 'phone-note', state.phoneNote);
        note.id = 'phone-note';
        bar.append(note);
      }
      return bar;
    }
    const menu = el('button', 'iconbtn');
    menu.type = 'button';
    menu.setAttribute('aria-label', 'Menu');
    menu.append(icon('menu'));
    menu.addEventListener('click', () => { haptic(); state.drawer = true; render(); });
    const word = el('div', 'home-word', 'intelio');
    const add = el('button', 'iconbtn');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add agent');
    add.append(icon('plus'));
    add.addEventListener('click', () => openSheet('agent'));
    bar.append(menu, word, add);
    return bar;
  }

  function agentRole(profile) {
    return String(profile?.title || profile?.description || 'Agent').replace(/\s+/g, ' ').trim().slice(0, 48) || 'Agent';
  }

  function leadCard() {
    const profile = state.bot || {};
    const button = el('button', 'lead-card');
    button.type = 'button';
    const orb = el('span', 'lead-orb');
    orb.append(face(profile, 'avatar'));
    const badge = el('span', 'lead-badge');
    badge.setAttribute('aria-hidden', 'true');
    orb.append(badge);
    button.append(orb, el('strong', 'lead-name', agentLabel(profile)), el('span', 'lead-status', workStatus() || 'Online'));
    button.addEventListener('click', () => { haptic(); openBrowser('agent'); });
    return button;
  }

  function watchingBlock() {
    const rows = (state.screens || []).filter((row) => row && row.host && !excludedAgent(row.profileId));
    if (!rows.length) return null;
    const wrap = el('section', 'side-block');
    wrap.append(el('p', 'section-label', 'WATCHING'));
    rows.forEach((row) => {
      const button = el('button', 'watch-row');
      button.type = 'button';
      const name = agentLabel(profileById(row.profileId) || { id: row.profileId, name: row.name });
      const extra = rows.filter((item) => item.profileId === row.profileId).length > 1 ? ` ${row.screen}` : '';
      button.append(icon('eye'), el('strong', '', row.host), el('span', '', ` · ${name}'s screen${extra}`));
      button.addEventListener('click', () => {
        state.bot = profileById(row.profileId) || state.bot;
        openBrowser('computer');
      });
      wrap.append(button);
    });
    return wrap;
  }

  const SESSION_AGENT_KEY = 'intelio-session-agent';
  /** The Sessions filter: '' is All agents. Shared with the web desktop on this origin. */
  function sessionAgent() {
    if (state.sessionAgent === undefined) {
      try { state.sessionAgent = String(localStorage.getItem(SESSION_AGENT_KEY) || '').trim().toLowerCase(); } catch { state.sessionAgent = ''; }
    }
    const id = state.sessionAgent || '';
    return id && vpsAgents(state.home.profiles).some((profile) => profile.id === id) ? id : '';
  }

  function setSessionAgent(id) {
    haptic();
    state.sessionAgent = String(id || '').trim().toLowerCase();
    try {
      if (state.sessionAgent) localStorage.setItem(SESSION_AGENT_KEY, state.sessionAgent);
      else localStorage.removeItem(SESSION_AGENT_KEY);
    } catch { /* the filter still applies until reload */ }
    const picked = state.sessionAgent ? vpsAgents(state.home.profiles).find((profile) => profile.id === state.sessionAgent) : null;
    if (picked) state.bot = picked;
    render();
  }

  /** One compact dropdown instead of a list of agents: All agents, intelio, PRC, Alignment, HHP, ARLP. */
  function sessionFilter() {
    const wrap = el('label', 'session-filter');
    wrap.append(el('span', 'session-filter-label', 'Showing'));
    const select = document.createElement('select');
    select.className = 'session-filter-select';
    select.setAttribute('aria-label', 'Show sessions for');
    const current = sessionAgent();
    const rows = [{ id: '', name: 'All agents' }, ...vpsAgents(state.home.profiles).map((profile) => ({ id: profile.id, name: agentLabel(profile) }))];
    for (const row of rows) {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = row.name;
      option.selected = row.id === current;
      select.append(option);
    }
    select.value = current;
    select.addEventListener('change', () => setSessionAgent(select.value));
    wrap.append(select);
    return wrap;
  }

  /** Threads under the Sessions filter: every agent's for All agents, newest first. */
  function filteredChats() {
    const id = sessionAgent();
    const q = state.query.trim().toLowerCase();
    return state.home.conversations.filter((row) => {
      const profile = String(row.profileId || '').toLowerCase();
      if (excludedAgent(profile)) return false;
      if (id && profile !== id) return false;
      return !q || `${row.title} ${row.preview}`.toLowerCase().includes(q);
    }).sort((a, b) => (id ? 0 : String(b.updated_at || '').localeCompare(String(a.updated_at || ''))));
  }

  function threadLine(row, { showAgent = false } = {}) {
    const button = el('button', `thread-line${row.id === state.chatId ? ' on' : ''}`);
    button.type = 'button';
    button.append(el('span', 'thread-title', row.title || 'Untitled'));
    if (showAgent) button.append(el('span', 'thread-agent', agentLabel(profileById(row.profileId) || { id: row.profileId })));
    if (row.id === state.chatId && (state.thinking || state.connecting)) button.append(el('span', 'thread-dot'));
    button.addEventListener('click', () => openChat(row));
    return button;
  }

  function sessionsView() {
    const list = el('div', 'home-list');
    list.id = 'list';
    list.append(leadCard());
    if (vpsAgents(state.home.profiles).length > 1) list.append(sessionFilter());
    const watching = watchingBlock();
    if (watching) list.append(watching);
    const threads = el('section', 'side-block');
    threads.append(el('p', 'section-label', 'THREADS'));
    const all = !sessionAgent();
    const rows = filteredChats();
    if (!rows.length) threads.append(el('p', 'empty', state.sample ? 'No sample conversations.' : 'No conversations yet.'));
    for (const row of rows) threads.append(threadLine(row, { showAgent: all }));
    list.append(threads);
    return list;
  }

  function sessionCard(row) {
    const profile = profileById(row.profileId);
    const button = el('button', 'feed-card');
    button.type = 'button';
    button.append(face(profile, 'avatar sm'));
    const copy = el('div', 'copy');
    const shown = window.IntelioTranscript ? window.IntelioTranscript.preview(row.preview || '') : (row.preview || '');
    copy.append(el('strong', '', row.title), el('p', '', shown));
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
    input.placeholder = `Ask ${agentLabel(state.bot)}`;
    input.autocomplete = 'off';
    const mic = roundButton('mic', () => dictateIntoBox(mic));
    mic.id = 'dictate';
    mic.title = 'Dictate';
    mic.setAttribute('aria-label', 'Dictate');
    const pill = modelPill();
    const voice = roundButton('waveform', () => { if (state.chatId) startCall(state.chatId); });
    voice.title = 'Voice conversation';
    voice.setAttribute('aria-label', 'Voice conversation');
    const send = roundButton('send', () => {});
    send.classList.add('send');
    send.type = 'submit';
    send.title = 'Send';
    send.setAttribute('aria-label', 'Send');
    form.append(plus, input, pill, mic, voice, send);
    if (state.modelOpen) wrap.append(modelMenu());
    if (state.modelNote) wrap.append(el('p', 'model-note', state.modelNote));
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
    head.append(el('h1', '', agentLabel(state.bot)));
    const gear = el('button', 'iconbtn');
    gear.type = 'button';
    gear.setAttribute('aria-label', 'Settings');
    gear.append(icon('gear'));
    gear.addEventListener('click', () => openSettings());
    const tools = el('span', 'drawer-tools');
    tools.append(themeIconButton(), gear);
    head.append(tools);
    panel.append(head);
    const agentHead = el('div', 'kicker-row');
    agentHead.append(el('div', 'kicker', 'AGENTS'));
    const addAgent = el('button', 'iconbtn');
    addAgent.type = 'button';
    addAgent.setAttribute('aria-label', 'Add agent');
    addAgent.append(icon('plus'));
    addAgent.addEventListener('click', () => { state.drawer = false; openSheet('agent'); });
    agentHead.append(addAgent);
    panel.append(agentHead);
    const agents = vpsAgents(state.home.profiles);
    for (const profile of agents) {
      const button = el('button', `navbtn${profile.id === state.bot.id ? ' on' : ''}`);
      button.type = 'button';
      const orb = face(profile, 'pip');
      orb.addEventListener('click', (event) => {
        event.stopPropagation();
        state.bot = profile;
        state.drawer = false;
        openBrowser('agent');
      });
      button.append(orb, el('span', '', agentLabel(profile)));
      button.addEventListener('click', () => selectProfile(profile));
      panel.append(button);
    }
    const profileRow = el('button', 'navbtn', 'Profile');
    profileRow.type = 'button';
    profileRow.addEventListener('click', () => openBrowser('agent'));
    panel.append(profileRow);
    panel.append(el('div', 'kicker', 'THREADS'));
    const sides = el('div', 'sides');
    const threads = visibleChats();
    if (!threads.length) sides.append(el('p', 'empty', 'No threads for this agent.'));
    for (const row of threads) {
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

  function installHint() {
    let standalone = false;
    try { standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch { standalone = false; }
    if (standalone) return null;
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua);
    const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(ua);
    if (!ios || !safari) return null;
    try { if (localStorage.getItem('intelio-a2hs') === '1') return null; } catch { /* keep the hint */ }
    const bar = el('div', 'a2hs');
    bar.append(el('p', '', 'Add intelio to your Home Screen. Tap Share, then Add to Home Screen.'));
    const close = el('button', 'a2hs-x', 'OK');
    close.type = 'button';
    close.addEventListener('click', () => {
      try { localStorage.setItem('intelio-a2hs', '1'); } catch { /* still hide it */ }
      bar.remove();
    });
    bar.append(close);
    return bar;
  }

  let profileToken = 0;

  async function loadProfile(force) {
    const id = String(state.bot?.id || '').toLowerCase();
    if (excludedAgent(id)) return;
    if (!force && state.profileLoaded === id) return;
    state.profileLoaded = id;
    const token = ++profileToken;
    try {
      const response = await fetch(`/api/agent/card?profile=${encodeURIComponent(id)}`, { headers: profileHeaders(id) });
      const card = await response.json().catch(() => null);
      if (token !== profileToken || String(state.bot?.id || '').toLowerCase() !== id) return;
      if (card && card.id === id) {
        state.profileCard = card;
        state.profileNote = '';
      } else if (!state.profileCard || state.profileCard.id !== id) {
        state.profileNote = 'Profile details are not available yet.';
      }
    } catch {
      if (token !== profileToken) return;
      if (!state.profileCard || state.profileCard.id !== id) state.profileNote = 'Profile details are not available yet.';
    }
    if (state.view === 'browser' && state.browserPane === 'agent') render();
  }

  async function postProfile(pathname, body) {
    const id = String(state.bot?.id || '').toLowerCase();
    state.profileBusy = true;
    render();
    try {
      const response = await fetch(pathname, {
        method: 'POST',
        headers: profileHeaders(id, { 'content-type': 'application/json' }),
        body: JSON.stringify({ ...body, profile: id }),
      });
      const card = await response.json().catch(() => null);
      if (!response.ok) {
        state.profileNote = card?.error || 'Could not save that.';
        return;
      }
      if (card && card.id === id) {
        state.profileCard = card;
        state.profileNote = '';
        state.profileEdit = false;
        state.colorOpen = false;
        applyCardStyle(card);
      }
      state.profileLoaded = id;
    } catch {
      state.profileNote = 'Could not save that.';
    } finally {
      state.profileBusy = false;
      if (state.view === 'browser') render();
    }
  }

  async function copyProfile(value, note) {
    let ok = false;
    try {
      if (value && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(String(value));
        ok = true;
      }
    } catch { ok = false; }
    state.profileNote = ok ? note : 'Could not copy that.';
    const node = document.querySelector('.profile-note');
    if (node) node.textContent = state.profileNote;
    else if (state.view === 'browser') render();
  }

  const COLOR_SWATCHES = ['#7a5cff', '#1d4ed8', '#059669', '#0f766e', '#7c3aed', '#db2777', '#0369a1', '#44403c'];

  function applyCardStyle(card) {
    if (!card) return;
    const patch = { color: card.color || '', title: card.title || '', name: card.name || '', orb: card.orb || '' };
    state.bot = { ...state.bot, ...patch, id: state.bot?.id || card.id };
    state.home.profiles = (state.home.profiles || []).map((row) => (row.id === card.id ? { ...row, ...patch } : row));
  }

  function colorPicker(card) {
    const wrap = el('div', 'appearance-picker');
    wrap.append(el('p', 'picker-label', 'Orb'));
    const gallery = el('div', 'orb-gallery');
    gallery.setAttribute('aria-label', 'Orb style');
    const current = signatureOf(card);
    for (const id of ORB_CHOICES) {
      const choice = el('button', 'orb-choice');
      choice.type = 'button';
      choice.dataset.orb = id;
      choice.setAttribute('aria-label', ORB_LABELS[id] || id);
      choice.setAttribute('aria-pressed', String(id === current));
      choice.append(face({ ...card, orb: id }, 'pip', { still: true, pinned: true }), el('span', 'orb-label', ORB_LABELS[id] || id));
      choice.addEventListener('click', () => postProfile('/api/agent/profile', { orb: id }));
      gallery.append(choice);
    }
    wrap.append(gallery);
    wrap.append(el('p', 'picker-label', 'Color'));
    const colors = el('div', 'color-picker');
    for (const color of COLOR_SWATCHES) {
      const swatch = el('button', 'swatch');
      swatch.type = 'button';
      swatch.style.background = color;
      swatch.setAttribute('aria-label', color);
      swatch.addEventListener('click', () => postProfile('/api/agent/profile', { color }));
      colors.append(swatch);
    }
    const hex = document.createElement('input');
    hex.className = 'hex-input';
    hex.value = card.color || '';
    hex.maxLength = 7;
    hex.setAttribute('aria-label', 'Custom color');
    hex.placeholder = '#7a5cff';
    hex.addEventListener('change', () => {
      const value = hex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(value)) postProfile('/api/agent/profile', { color: value });
      else state.profileNote = 'Use a hex color like #7a5cff.';
    });
    colors.append(hex);
    wrap.append(colors);
    return wrap;
  }

  function profileField(label, value, copyNote) {
    const row = el('div', 'profile-field');
    const copy = el('div', '');
    copy.append(el('p', 'profile-kicker', label), el('p', 'profile-value', value || 'Not configured'));
    row.append(copy);
    if (value) {
      const button = el('button', 'profile-text', 'Copy');
      button.type = 'button';
      button.addEventListener('click', () => copyProfile(value, copyNote));
      row.append(button);
    }
    return row;
  }

  function profileSegment(label, options, selected, disabled, onPick) {
    const wrap = el('div', 'profile-block');
    wrap.append(el('h3', '', label));
    const row = el('div', 'profile-segment');
    for (const option of options) {
      const button = el('button', 'profile-seg', option.label);
      button.type = 'button';
      button.disabled = disabled || state.profileBusy;
      button.setAttribute('aria-pressed', String(option.id === selected));
      if (!button.disabled) button.addEventListener('click', () => onPick(option.id));
      row.append(button);
    }
    wrap.append(row);
    return wrap;
  }

  function profileEditor(card) {
    const form = el('form', 'profile-editor');
    const fields = [
      ['name', 'Name', card.name || ''],
      ['title', 'Title / role', card.title || ''],
      ['email', 'Email', card.email || ''],
      ['mobile', 'Mobile', card.phoneLabel || card.phone || ''],
    ];
    const inputs = {};
    for (const [key, label, value] of fields) {
      const row = el('label', 'edit-field', label);
      const input = document.createElement('input');
      input.value = value;
      input.autocomplete = 'off';
      inputs[key] = input;
      row.append(input);
      form.append(row);
    }
    const soulLabel = el('label', 'edit-field', 'Instructions');
    const soul = document.createElement('textarea');
    soul.value = card.soul || '';
    soul.rows = 6;
    inputs.soul = soul;
    soulLabel.append(soul);
    form.append(soulLabel);
    const actions = el('div', 'edit-actions');
    const save = el('button', 'profile-pause', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'profile-text', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { state.profileEdit = false; render(); });
    actions.append(save, cancel);
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      postProfile('/api/agent/profile', {
        name: inputs.name.value,
        title: inputs.title.value,
        email: inputs.email.value,
        mobile: inputs.mobile.value,
        soul: inputs.soul.value,
      });
    });
    return form;
  }

  function profileDetails(card) {
    const wrap = el('div', 'profile-stack');
    if (card.needsSignIn) wrap.append(el('p', 'profile-note', 'Needs sign-in'));
    if (state.profileEdit) {
      wrap.append(profileEditor(card));
      return wrap;
    }
    const persona = el('div', 'profile-block');
    const personaHead = el('div', 'profile-row');
    personaHead.append(el('h3', '', 'Instructions'));
    const edit = el('button', 'profile-text', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => { state.profileEdit = true; state.soulOpen = true; render(); });
    personaHead.append(edit);
    const text = String(card.soul || '').trim();
    const shown = state.soulOpen || text.length <= 180 ? text : `${text.slice(0, 180)}…`;
    persona.append(personaHead, el('p', 'profile-soul', shown || 'No instructions yet.'));
    if (text.length > 180) {
      const more = el('button', 'profile-text', state.soulOpen ? 'Show less' : 'Show full');
      more.type = 'button';
      more.addEventListener('click', () => { state.soulOpen = !state.soulOpen; render(); });
      persona.append(more);
    }
    wrap.append(persona);
    if (card.gatewayNote) wrap.append(el('p', 'profile-muted', card.gatewayNote));
    wrap.append(profileField(card.phone ? 'mobile · iMessage' : 'mobile', card.phoneLabel, 'Number copied.'));
    wrap.append(profileField('email', card.email, 'Email copied.'));
    const computer = el('button', 'profile-block profile-link');
    computer.type = 'button';
    const head = el('div', 'profile-row');
    head.append(el('h3', '', 'Computer'), el('span', 'profile-muted', `${card.computer?.label || 'Stopped'} · open`));
    computer.append(head, el('p', 'profile-muted', `${card.name}'s computer`));
    computer.addEventListener('click', () => openBrowser('computer'));
    wrap.append(computer);
    const uses = el('div', 'profile-block');
    const usesHead = el('div', 'profile-row');
    usesHead.append(el('h3', '', 'Uses'));
    const manage = el('button', 'profile-text', 'Manage in Vault');
    manage.type = 'button';
    manage.addEventListener('click', () => openSavedLogins(''));
    usesHead.append(manage);
    const icons = el('div', 'profile-uses');
    const list = Array.isArray(card.uses) ? card.uses : [];
    if (!list.length) icons.append(el('p', 'profile-muted', 'No connected toolsets in this profile.'));
    for (const item of list) {
      const badge = el('span', 'profile-use', String(item.name || '?').slice(0, 1).toUpperCase());
      badge.title = item.name || '';
      icons.append(badge);
    }
    uses.append(usesHead, icons);
    wrap.append(uses);
    wrap.append(profileSegment('Thinking', [
      { id: 'auto', label: 'Auto' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
    ], card.thinking, !card.thinkingWritable, (effort) => postProfile('/api/agent/thinking', { effort })));
    if (!card.thinkingWritable) wrap.append(el('p', 'profile-muted', 'Reasoning effort is read-only until this profile config has a model block.'));
    wrap.append(profileSegment('Works on', [
      { id: 'auto', label: 'Auto' },
      { id: 'cloud', label: 'Cloud' },
      { id: 'local', label: 'Your computer' },
    ], card.worksOn || 'cloud', true, () => {}));
    wrap.append(el('p', 'profile-muted', 'These agents run on the VPS. This choice is read-only.'));
    const routines = el('div', 'profile-block');
    routines.append(el('h3', '', 'Routines and scheduled'));
    const jobs = Array.isArray(card.routines) ? card.routines : [];
    if (!jobs.length) routines.append(el('p', 'profile-muted', 'No scheduled jobs.'));
    for (const job of jobs) {
      const row = el('div', 'profile-row');
      row.append(el('strong', '', job.name || 'Scheduled job'), el('span', 'profile-muted', [job.schedule, job.status].filter(Boolean).join(' · ')));
      routines.append(row);
    }
    wrap.append(routines);
    const where = el('div', 'profile-block');
    where.append(el('h3', '', `Where to find ${card.name}`));
    const grid = el('div', 'profile-channels');
    for (const channel of card.channels || []) {
      const cell = el('div', 'profile-channel');
      const name = el('span', '', channel.label);
      name.append(el('span', `profile-dot ${channel.state || 'off'}`));
      cell.append(name, el('span', 'profile-muted', channel.detail || ''));
      grid.append(cell);
    }
    where.append(grid);
    wrap.append(where);
    const share = el('button', 'profile-wide', 'Share contact');
    share.type = 'button';
    share.addEventListener('click', () => copyProfile(card.contact, 'Contact copied.'));
    wrap.append(share);
    if (state.profileConfirm) {
      const ask = el('div', 'profile-block');
      ask.append(el('p', '', card.paused ? `Resume ${card.name}? New turns from this app start again.` : `Pause ${card.name}? New turns from this app stop. Scheduled jobs stay listed.`));
      const yes = el('button', 'profile-pause', card.paused ? 'Resume' : 'Pause');
      yes.type = 'button';
      yes.addEventListener('click', () => {
        state.profileConfirm = false;
        postProfile('/api/agent/pause', { paused: !card.paused });
      });
      const no = el('button', 'profile-text', 'Cancel');
      no.type = 'button';
      no.addEventListener('click', () => { state.profileConfirm = false; render(); });
      ask.append(yes, no);
      wrap.append(ask);
    } else {
      const pause = el('button', 'profile-pause', card.paused ? `Resume ${card.name}` : `Pause ${card.name}`);
      pause.type = 'button';
      pause.disabled = state.profileBusy;
      pause.addEventListener('click', () => { state.profileConfirm = true; render(); });
      wrap.append(pause);
    }
    return wrap;
  }

  function profileMemory(card) {
    const wrap = el('div', 'profile-stack');
    const search = document.createElement('input');
    search.className = 'profile-search';
    search.type = 'search';
    search.placeholder = 'Search memory';
    search.setAttribute('aria-label', 'Search memory');
    search.value = state.profileQuery || '';
    const body = el('pre', 'profile-memory');
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const text = card.memory || 'No memory file for this profile.';
      if (!q) { body.textContent = text; return; }
      const lines = text.split('\n').filter((line) => line.toLowerCase().includes(q));
      body.textContent = lines.length ? lines.join('\n') : 'No matching lines.';
    };
    search.addEventListener('input', () => { state.profileQuery = search.value; paint(); });
    paint();
    wrap.append(search, body);
    return wrap;
  }

  function profilePhone(card) {
    const wrap = el('div', 'profile-stack');
    wrap.append(el('h3', '', card.phoneSoon ? 'Phone soon' : 'Phone'));
    wrap.append(el('p', 'profile-muted', card.phoneSoon ? 'Twilio voice is not live for this agent. iMessage uses the number below.' : 'Calling uses the number below.'));
    wrap.append(profileField('iMessage', card.phoneLabel, 'Number copied.'));
    return wrap;
  }

  function profileBody() {
    const wrap = el('div', 'profile-sheet');
    const card = state.profileCard && state.profileCard.id === state.bot?.id ? state.profileCard : null;
    const head = el('header', 'profile-head');
    const tinted = { ...state.bot, color: card?.color || state.bot?.color || '' };
    const orbButton = el('button', 'orb-hit');
    orbButton.type = 'button';
    orbButton.setAttribute('aria-label', 'Change orb and color');
    orbButton.append(face(tinted, 'avatar', { still: true, pinned: true }));
    orbButton.addEventListener('click', () => { state.colorOpen = !state.colorOpen; render(); });
    head.append(orbButton);
    const titles = el('div', '');
    titles.append(el('h2', '', card?.name || agentLabel(state.bot)));
    if (card?.title) titles.append(el('p', 'profile-muted', card.title));
    head.append(titles);
    const tools = el('div', 'profile-tools');
    const message = el('button', 'profile-tool', 'Message');
    message.type = 'button';
    message.addEventListener('click', () => {
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfb = null;
      state.view = state.chatId ? 'chat' : 'home';
      render();
    });
    const call = el('button', 'profile-tool', 'Call');
    call.type = 'button';
    call.addEventListener('click', () => {
      if (state.chatId) startCall(state.chatId);
      else { state.profileNote = 'Open a thread, then call.'; render(); }
    });
    const video = el('button', 'profile-tool', 'Video');
    video.type = 'button';
    video.disabled = true;
    video.title = 'Video soon';
    const email = el('button', 'profile-tool', 'Email');
    email.type = 'button';
    email.disabled = !card?.email;
    email.title = card?.email ? `Copy ${card.email}` : 'No email configured';
    email.addEventListener('click', () => { if (card?.email) copyProfile(card.email, 'Email copied.'); });
    tools.append(message, call, video, email);
    head.append(tools);
    wrap.append(head);
    if (state.colorOpen && card) wrap.append(colorPicker(card));
    const tabs = el('div', 'profile-subtabs');
    for (const [id, label] of [['computer', 'Computer'], ['details', 'Details'], ['memory', 'Memory'], ['phone', card?.phoneSoon === false ? 'Phone' : 'Phone soon']]) {
      const button = el('button', 'profile-subtab', label);
      button.type = 'button';
      button.setAttribute('aria-selected', String(id === 'computer' ? state.browserPane !== 'agent' : state.profileTab === id));
      button.addEventListener('click', () => {
        if (id === 'computer') { openBrowser('computer'); return; }
        state.profileTab = id;
        state.profileConfirm = false;
        state.profileEdit = false;
        render();
      });
      tabs.append(button);
    }
    wrap.append(tabs);
    if (!card) wrap.append(el('p', 'profile-muted', state.profileNote || 'Loading profile…'));
    else if (state.profileTab === 'memory') wrap.append(profileMemory(card));
    else if (state.profileTab === 'phone') wrap.append(profilePhone(card));
    else wrap.append(profileDetails(card));
    if (state.profileNote) wrap.append(el('p', 'profile-note', state.profileNote));
    return wrap;
  }

  function updateBanner() {
    const bar = el('button', 'update-banner', 'New version. Tap to reload.');
    bar.type = 'button';
    bar.addEventListener('click', () => location.reload());
    return bar;
  }

  function openBrowser(pane) {
    haptic();
    const next = pane === 'agent' ? 'agent' : 'computer';
    if (next === 'agent') {
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfb = null;
    }
    state.view = 'browser';
    state.browserPane = next;
    state.drawer = false;
    render();
  }

  function browserView() {
    const wrap = el('div', 'browser-sheet');
    const bar = el('div', 'browser-bar');
    const back = el('button', 'iconbtn');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back');
    back.append(icon('back'));
    back.addEventListener('click', () => {
      try { rfb?.disconnect(); } catch { /* already closed */ }
      rfb = null;
      state.view = state.chatId ? 'chat' : 'home';
      render();
    });
    const strip = el('div', 'pane-tabs');
    const computerTab = el('button', `pane-tab${state.browserPane === 'agent' ? '' : ' on'}`, `${agentLabel(state.bot)}'s computer`);
    computerTab.type = 'button';
    computerTab.addEventListener('click', () => { if (state.browserPane === 'agent') openBrowser('computer'); });
    const agentTab = el('button', `pane-tab${state.browserPane === 'agent' ? ' on' : ''}`, agentLabel(state.bot));
    agentTab.type = 'button';
    agentTab.addEventListener('click', () => { if (state.browserPane !== 'agent') openBrowser('agent'); });
    strip.append(computerTab, agentTab);
    bar.append(back, strip);
    if (state.browserPane === 'agent') {
      wrap.append(bar, profileBody());
      queueMicrotask(() => loadProfile(false));
      return wrap;
    }
    const lock = el('button', 'iconbtn');
    lock.type = 'button';
    lock.setAttribute('aria-label', 'Saved login for this site');
    lock.append(icon('lock'));
    lock.addEventListener('click', () => openSiteLogin());
    const control = el('button', 'control-button', state.browserControl ? 'Stop control' : 'Take control');
    control.type = 'button';
    control.id = 'take-control';
    control.setAttribute('aria-pressed', state.browserControl ? 'true' : 'false');
    control.addEventListener('click', () => {
      state.browserControl = !state.browserControl;
      control.textContent = state.browserControl ? 'Stop control' : 'Take control';
      control.setAttribute('aria-pressed', state.browserControl ? 'true' : 'false');
      if (rfb) {
        rfb.viewOnly = !state.browserControl;
        fitRemote(rfb, document.getElementById('vnc-screen'));
      }
      const hint = document.getElementById('browser-hint');
      if (hint) hint.textContent = state.browserControl ? 'You control this view.' : 'Watching. Take control to use the pointer and keyboard.';
    });
    bar.append(lock, control);
    const hint = el('p', 'browser-hint', state.browserControl ? 'You control this view.' : 'Watching. Take control to use the pointer and keyboard.');
    hint.id = 'browser-hint';
    const screen = el('div', 'vnc-screen');
    screen.id = 'vnc-screen';
    screen.append(el('p', 'browser-empty', 'Watching the shared browser'));
    wrap.append(bar, hint, screen);
    queueMicrotask(() => connectBrowser(screen));
    return wrap;
  }

  function browserMessage(screen, text, failed) {
    let empty = screen.querySelector('.browser-empty');
    if (!empty) {
      empty = el('p', 'browser-empty');
      screen.append(empty);
    }
    empty.textContent = text;
    empty.classList.toggle('browser-error', Boolean(failed));
  }

  function containRemote(cw, ch, fw, fh) {
    if (!(cw > 0 && ch > 0 && fw > 0 && fh > 0)) return { scale: 0, width: 0, height: 0, x: 0, y: 0 };
    const scale = Math.min(cw / fw, ch / fh);
    const width = fw * scale;
    const height = fh * scale;
    return { scale, width, height, x: (cw - width) / 2, y: (ch - height) / 2 };
  }

  function fitRemote(client, screen) {
    if (!client || !screen) return;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.clipViewport = false;
    const cw = screen.clientWidth;
    const ch = screen.clientHeight;
    const fw = client._fbWidth || client._display?.width || 0;
    const fh = client._fbHeight || client._display?.height || 0;
    const fit = containRemote(cw, ch, fw, fh);
    if (fit.scale > 0 && client._display) client._display.scale = fit.scale;
  }

  async function connectBrowser(screen) {
    if (!screen.isConnected) return;
    try { rfb?.disconnect(); } catch { /* already closed */ }
    rfb = null;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/browser/websockify`;
    const fail = () => {
      if (!screen.isConnected) return;
      browserMessage(screen, 'The shared browser is not connected.', true);
    };
    let timer = 0;
    try {
      const mod = await import('/novnc/core/rfb.js');
      const RFB = mod.default;
      if (!screen.isConnected) return;
      const client = new RFB(screen, url);
      const fit = () => {
        if (rfb !== client) return;
        fitRemote(client, screen);
      };
      client.viewOnly = !state.browserControl;
      client.scaleViewport = true;
      client.resizeSession = false;
      client.clipViewport = false;
      client.focusOnClick = state.browserControl;
      client.background = currentTheme() === 'light' ? '#f4f4f6' : '#070708';
      if (screen._fit) screen._fit.disconnect();
      screen._fit = new ResizeObserver(() => fit());
      screen._fit.observe(screen);
      timer = setTimeout(fail, 8000);
      client.addEventListener('connect', () => {
        clearTimeout(timer);
        const empty = screen.querySelector('.browser-empty');
        if (empty) empty.remove();
        fit();
        setTimeout(fit, 160);
      });
      client.addEventListener('disconnect', () => {
        clearTimeout(timer);
        if (rfb !== client || !screen.isConnected) return;
        fail();
      });
      client.addEventListener('securityfailure', () => {
        clearTimeout(timer);
        if (!screen.isConnected) return;
        browserMessage(screen, 'The shared browser rejected the connection.', true);
      });
      rfb = client;
    } catch {
      clearTimeout(timer);
      fail();
    }
  }

  async function openSiteLogin() {
    let domain = '';
    try {
      const response = await fetch('/api/browser/site', { headers: profileHeaders(state.bot?.id) });
      const body = await response.json();
      domain = String(body.domain || '');
    } catch { domain = ''; }
    openSheet('signin', { domain });
  }

  function iconsView() {
    const wrap = el('div', 'icons');
    const names = [['intelio', 'intelio'], ['PRC', 'prc'], ['Alignment', 'alignment'], ['HHP', 'hhp']];
    names.forEach(([label, id]) => {
      const figure = document.createElement('figure');
      figure.append(face({ id }, 'tile', { paused: true, still: true, pinned: true }), el('figcaption', '', label));
      wrap.append(figure);
    });
    return wrap;
  }

  function phoneChip(item) {
    const wrap = el('div', 'tool-run');
    const button = el('button', `tool-chip${item.running ? ' running' : ''}${item.failed ? ' failed' : ''}`);
    button.type = 'button';
    button.append(el('span', 'mark', item.running ? '' : (item.failed ? '!' : '✓')));
    button.append(document.createTextNode(` ${item.label}`));
    if (item.detail) {
      button.setAttribute('aria-expanded', 'false');
      const detail = el('pre', 'tool-detail', item.detail);
      button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') === 'true';
        button.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      wrap.append(button, detail);
    } else wrap.append(button);
    return wrap;
  }

  /** Agent work is one typing bubble (dots, a short status, a small stop); tool steps are not listed. */
  function typingBubble(status, onStop) {
    const wrap = el('div', 'bubble bot typing');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'The agent is working');
    const dots = el('span', 'think-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(el('i'), el('i'), el('i'));
    wrap.append(dots);
    if (status) wrap.append(el('span', 'typing-status', status));
    if (typeof onStop === 'function') {
      const stop = el('button', 'typing-stop');
      stop.type = 'button';
      stop.title = 'Stop';
      stop.setAttribute('aria-label', 'Stop');
      stop.addEventListener('click', onStop);
      wrap.append(stop);
    }
    return wrap;
  }

  function threadItems(messages, working = false) {
    if (window.IntelioTranscript?.conversation) return window.IntelioTranscript.conversation(messages, { working });
    if (window.IntelioTranscript) return window.IntelioTranscript.present(messages);
    return messages.map((message) => ({ kind: 'bubble', role: message.role === 'user' ? 'user' : 'assistant', text: message.text || '' }));
  }

  function threadSource(messages) {
    const rows = Array.isArray(messages) ? messages.slice() : [];
    if (!state.readFor || !state.readAt || rows.some((row) => row.role === 'read')) return rows;
    const at = rows.findIndex((row) => row.role === 'user' && String(row.text || '') === state.readFor);
    if (at < 0) return rows;
    rows.splice(at + 1, 0, { role: 'read', text: readText(state.readAt) });
    return rows;
  }

  function fillThread(thread, messages) {
    thread.replaceChildren();
    const working = Boolean(state.thinking || (state.bops?.tasks || []).some((task) => task.status === 'running'));
    const stopAll = () => {
      if (window.IntelioBops && state.bops) state.bops = window.IntelioBops.stopAll(state.bops);
      state.thinking = false;
      render();
    };
    for (const item of threadItems(threadSource(messages), working)) {
      if (item.kind === 'typing') thread.append(typingBubble(item.status || '', working ? stopAll : null));
      else if (item.kind === 'chip') thread.append(phoneChip(item));
      else if (item.kind === 'read') thread.append(el('div', 'read-receipt', item.text));
      else if (item.kind === 'time') thread.append(el('div', 'stamp', item.text));
      else if (item.kind === 'choice') {
        const choice = el('button', 'choice', item.text);
        choice.type = 'button';
        choice.addEventListener('click', () => sendTurn(item.text));
        thread.append(choice);
      } else if (item.kind === 'bubble' && item.text) thread.append(el('div', `bubble ${item.role === 'user' ? 'user' : 'bot'}`, item.text));
    }
    const block = bopsBlock();
    if (block) thread.append(block);
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
    hero.append(face(state.bot, 'avatar lg'), el('h1', '', agentLabel(state.bot)), timer);
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
    for (const item of threadItems(lines)) {
      if (item.kind !== 'bubble' || !item.text) continue;
      node.append(el('p', `cap ${item.role === 'user' ? 'user' : 'bot'}`, item.text));
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

  function pushLine(role, text, extra) {
    const line = Object.assign({ role, text }, extra || {});
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
    state.home.profiles = vpsAgents(state.home.profiles);
    state.home.conversations = (state.home.conversations || []).filter((row) => !excludedAgent(row.profileId));
    state.sample = Boolean(state.home.sample);
    state.bot = state.home.profiles[0] || state.bot;
    const screens = await fetch('/api/screens');
    if (screens.ok) {
      const body = await screens.json().catch(() => ({ data: [] }));
      state.screens = Array.isArray(body.data) ? body.data : [];
    }
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
      const hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (!hadController || event.data?.type !== 'intelio-pwa-update') return;
        state.updateReady = true;
        location.reload();
      });
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  async function openChat(row) {
    state.chatId = row.id;
    state.bot = profileById(row.profileId);
    state.modelApplied = '';
    state.modelOpen = false;
    state.view = 'chat';
    state.tab = 'chat';
    state.drawer = false;
    state.messages = [];
    render();
    await loadMessages(row.id, state.messages);
    loadModelOptions().catch(() => {});
    if (state.call.active && state.call.sessionId === row.id) state.captions = state.messages;
    render();
  }

  async function loadMessages(id, target) {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/messages`, { headers: profileHeaders(state.bot?.id) });
    const body = await response.json().catch(() => ({ data: [] }));
    const lines = (body.data || []).map((message) => ({
      role: message.role || 'assistant',
      text: typeof message.content === 'string' ? message.content : (message.text || ''),
      content: message.content,
      tool_name: message.tool_name || message.name || '',
      tool_calls: message.tool_calls || message.toolCalls || [],
      status: message.status || '',
      title: message.title || '',
    })).filter((message) => message.text || message.content || message.role === 'tool' || message.role === 'activity' || (message.tool_calls && message.tool_calls.length));
    if (target) {
      target.splice(0, target.length, ...lines);
    }
    return lines;
  }

  async function startChatWith(profile) {
    state.bot = profile;
    const response = await fetch('/api/sessions', { method: 'POST', headers: profileHeaders(profile.id, { 'content-type': 'application/json' }), body: JSON.stringify({ title: agentLabel(profile), profile: profile.id }) });
    const body = await response.json().catch(() => ({}));
    const id = body.id || (body.data && body.data.id);
    if (!id) { state.error = body.error || 'Could not start a chat.'; render(); return; }
    state.chatId = id;
    state.messages = [];
    state.modelApplied = '';
    state.view = 'chat';
    state.tab = 'chat';
    state.drawer = false;
    render();
    loadModelOptions().catch(() => {});
  }

  function modelApi() {
    return window.IntelioModelPicker || null;
  }

  function modelPill() {
    const api = modelApi();
    const pill = el('button', 'model-pill');
    pill.type = 'button';
    pill.id = 'model-pill';
    pill.setAttribute('aria-haspopup', 'listbox');
    pill.setAttribute('aria-expanded', state.modelOpen ? 'true' : 'false');
    const text = api ? api.pillLabel(state.modelId) : (state.modelId || 'Model');
    pill.textContent = `${text} ▾`;
    pill.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.modelOpen) { state.modelOpen = false; render(); return; }
      await loadModelOptions();
      state.modelOpen = true;
      render();
    });
    return pill;
  }

  function modelOption(label, selected, onClick) {
    const button = el('button', '');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.textContent = label;
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onClick(); });
    return button;
  }

  function modelMenu() {
    const api = modelApi();
    const menu = el('div', 'model-menu');
    menu.id = 'model-menu';
    menu.setAttribute('role', 'listbox');
    if (!api) return menu;
    const groups = state.modelGroups || [];
    if (!groups.length && state.modelId) {
      menu.append(el('div', 'model-label', api.providerLabel(state.modelProvider)));
      menu.append(modelOption(state.modelId, true, () => {}));
    }
    for (const group of groups) {
      menu.append(el('div', 'model-label', group.label || api.providerLabel(group.provider)));
      for (const id of group.models || []) menu.append(modelOption(id, id === state.modelId, () => choosePhoneModel(group.provider, id)));
    }
    menu.append(el('div', 'model-label', 'Thinking'));
    for (const effort of api.EFFORTS) menu.append(modelOption(api.EFFORT_LABELS[effort], effort === (state.modelEffort || 'auto'), () => choosePhoneEffort(effort)));
    menu.append(modelOption(`Make default for ${agentLabel(state.bot)}`, false, () => makePhoneDefault()));
    return menu;
  }

  async function loadModelOptions() {
    const id = state.bot?.id || '';
    const session = state.chatId ? `&session=${encodeURIComponent(state.chatId)}` : '';
    const response = await fetch(`/api/models?profile=${encodeURIComponent(id)}${session}`, { headers: profileHeaders(id) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) return;
    state.modelProvider = json.provider || '';
    state.modelId = json.model || '';
    state.modelEffort = json.effort || 'auto';
    state.modelGroups = Array.isArray(json.groups) ? json.groups : [];
    state.profileModel = json.profileModel || '';
    if (state.view === 'chat') render();
  }

  async function applyPhoneModel(provider, model, effort) {
    const api = modelApi();
    state.modelProvider = api ? api.canonicalProvider(provider) : provider;
    state.modelId = model;
    state.modelEffort = effort || state.modelEffort || 'auto';
    state.modelOpen = false;
    state.modelNote = '';
    if (!state.chatId) { state.modelApplied = 'request'; render(); return; }
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.chatId)}/model`, {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: JSON.stringify({ profile: state.bot?.id || '', model, provider: state.modelProvider, effort: state.modelEffort }),
    });
    const json = await response.json().catch(() => ({}));
    state.modelApplied = response.ok ? (json.applied || 'request') : 'request';
    if (!response.ok) state.modelNote = json.error || 'Could not switch the model for this thread.';
    render();
  }

  function choosePhoneModel(provider, model) { return applyPhoneModel(provider, model, state.modelEffort || 'auto'); }
  function choosePhoneEffort(effort) {
    const model = state.modelId || state.profileModel;
    if (!model) return;
    return applyPhoneModel(state.modelProvider, model, effort);
  }

  async function makePhoneDefault() {
    const model = state.modelId || state.profileModel;
    state.modelOpen = false;
    if (!model) return;
    const response = await fetch('/api/agent/model', {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: JSON.stringify({ profile: state.bot?.id || '', model, provider: state.modelProvider }),
    });
    const json = await response.json().catch(() => ({}));
    state.modelNote = response.ok ? (json.note || '') : (json.error || 'Could not save that model.');
    if (response.ok) state.profileModel = model;
    render();
  }

  function agentStrip() {
    const strip = el('div', 'agents');
    for (const profile of state.home.profiles) {
      const button = el('button', `agent${profile.id === state.bot.id ? ' on' : ''}`);
      button.type = 'button';
      button.append(face(profile, 'avatar sm'), el('span', '', agentLabel(profile)));
      button.addEventListener('click', () => selectProfile(profile));
      strip.append(button);
    }
    return strip;
  }

  async function openAgentChat(profile) {
    haptic();
    state.bot = profile;
    state.drawer = false;
    const latest = (state.home.conversations || []).find((row) => String(row.profileId || '').toLowerCase() === String(profile.id || '').toLowerCase() && !excludedAgent(row.profileId));
    if (latest) { await openChat(latest); return; }
    await startChatWith(profile);
  }

  function selectProfile(profile) {
    haptic();
    state.bot = profile;
    state.profileLoaded = '';
    state.profileCard = null;
    state.profileNote = '';
    state.profileConfirm = false;
    state.drawer = true;
    if (state.view === 'chat' || state.view === 'browser') {
      state.view = 'home';
      state.tab = 'sessions';
      state.chatId = '';
    }
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
    if (state.sample) return 'SAMPLE DATA. The profile key stays on the VPS.';
    if (state.login && state.login !== 'sample') return `Signed in as ${state.login}. The profile key stays on the VPS.`;
    return 'Signed in. The profile key stays on the VPS.';
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
    wrap.append(el('h2', '', 'Saved logins'));
    const saved = el('button', 'block quiet', 'Saved logins');
    saved.type = 'button';
    saved.addEventListener('click', () => openSavedLogins(''));
    wrap.append(saved);
    wrap.append(el('p', '', 'Domain and username only. The password stays in this agent’s vault.'));
    wrap.append(el('h2', '', 'Appearance'));
    wrap.append(themeIconButton(), el('p', '', 'Light is the default. Your choice is saved on this device.'));
    wrap.append(el('h2', '', 'About'));
    wrap.append(el('p', '', 'intelio · Alan’s Way'));
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
    else if (name === 'logins') card.append(loginsSheet(extra || {}));
    else if (name === 'signin') card.append(secureLoginCard(extra?.domain || ''));
    else card.append(newCard());
    sheet.append(card);
    sheet.dataset.ready = '0';
    sheet.addEventListener('click', (event) => {
      if (sheet.dataset.ready !== '1') return;
      if (event.target === sheet) sheet.remove();
    });
    app.append(sheet);
    setTimeout(() => { if (sheet.isConnected) sheet.dataset.ready = '1'; }, 450);
  }

  function loginsSheet(extra) {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', 'Saved logins'));
    const rows = Array.isArray(extra.logins) ? extra.logins : [];
    if (!rows.length) frag.append(el('p', '', 'No saved logins for this agent.'));
    for (const row of rows) {
      const domain = String(row.domain || '');
      const username = String(row.username || '');
      frag.append(el('p', 'login-row', `${domain} · ${username}`));
    }
    const add = el('button', 'block', 'Add a login');
    add.type = 'button';
    add.addEventListener('click', () => openSheet('signin', { domain: extra.domain || '' }));
    frag.append(add);
    return frag;
  }

  async function openSavedLogins(domain) {
    let logins = [];
    try {
      const response = await fetch('/api/vault/logins', { headers: profileHeaders(state.bot?.id) });
      const body = await response.json();
      logins = (Array.isArray(body.logins) ? body.logins : []).map((row) => ({ domain: String(row.domain || ''), username: String(row.username || '') }));
    } catch { logins = []; }
    openSheet('logins', { logins, domain: domain || '' });
  }

  function secureLoginCard(domain) {
    const card = el('form', 'bops-signin');
    const initial = String(domain || '').replace(/^www\./, '');
    const head = el('div', 'signin-head');
    head.append(el('span', 'signin-mark', (initial || 'S').slice(0, 1).toUpperCase()), el('strong', '', initial || 'Secure sign-in'));
    card.append(head);
    const fields = [
      ['domain', 'Domain', 'text', 'off', initial],
      ['username', 'Username', 'text', 'username', ''],
      ['password', 'Password', 'password', 'current-password', ''],
      ['otp', 'One-time code', 'password', 'one-time-code', ''],
    ];
    for (const [id, label, type, autocomplete, value] of fields) {
      const lab = el('label', 'signin-label', label);
      const input = el('input');
      input.type = type;
      input.autocomplete = autocomplete;
      input.dataset.field = id;
      if (value) input.value = value;
      lab.append(input);
      card.append(lab);
    }
    const save = el('label', 'signin-save', 'Save login');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.field = 'save';
    save.append(box);
    card.append(save);
    const status = el('p', 'login-status', '');
    const submit = el('button', 'bops-action', 'Submit');
    submit.type = 'submit';
    card.append(submit, status);
    card.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = {};
      card.querySelectorAll('input').forEach((input) => {
        if (input.dataset.field === 'save') values.save = input.checked;
        else values[input.dataset.field] = input.value;
        if (input.type === 'password') input.value = '';
      });
      const response = await fetch('/api/vault/login', {
        method: 'POST',
        headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
        body: JSON.stringify({
          profile: state.bot?.id,
          domain: values.domain,
          username: values.username,
          password: values.password,
          otp: values.otp,
          save: values.save === true,
        }),
      });
      await response.json().catch(() => ({}));
      if (!response.ok) {
        status.textContent = 'Could not save that login.';
        return;
      }
      status.textContent = values.save ? 'Saved.' : 'Sent to the browser.';
      if (values.save) openSavedLogins(values.domain || '');
    });
    return card;
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

  function labeledField(text, control) {
    const row = el('label', 'field');
    row.append(el('span', 'field-label', text), control);
    return row;
  }

  function agentCard() {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', '', 'Add agent'));
    const name = document.createElement('input');
    name.id = 'agent-name';
    name.autocomplete = 'off';
    name.maxLength = 32;
    name.required = true;
    const title = document.createElement('input');
    title.id = 'agent-title';
    title.maxLength = 80;
    const soul = document.createElement('textarea');
    soul.id = 'agent-soul';
    soul.maxLength = 8000;
    soul.rows = 4;
    const starts = el('div', 'field');
    starts.append(el('span', 'field-label', 'Starts from'));
    const loading = el('p', 'orb-loading', 'Loading styles…');
    const gallery = el('div', 'orb-gallery');
    gallery.hidden = true;
    starts.append(loading, gallery);
    let chosenOrb = 'working';
    let chosenColor = '#7a5cff';
    const paintGallery = () => {
      gallery.replaceChildren();
      for (const id of ORB_CHOICES) {
        const choice = el('button', 'orb-choice');
        choice.type = 'button';
        choice.dataset.orb = id;
        choice.setAttribute('aria-label', ORB_LABELS[id]);
        choice.setAttribute('aria-pressed', String(id === chosenOrb));
        choice.append(face({ id: 'new-agent', orb: id, color: chosenColor }, 'pip', { still: true, pinned: true }), el('span', 'orb-label', ORB_LABELS[id]));
        choice.addEventListener('click', () => { chosenOrb = id; paintGallery(); });
        gallery.append(choice);
      }
      const colors = el('div', 'color-picker');
      for (const color of COLOR_SWATCHES) {
        const swatch = el('button', 'swatch');
        swatch.type = 'button';
        swatch.style.background = color;
        swatch.setAttribute('aria-label', color);
        swatch.setAttribute('aria-pressed', String(color === chosenColor));
        swatch.addEventListener('click', () => { chosenColor = color; paintGallery(); });
        colors.append(swatch);
      }
      gallery.append(el('p', 'picker-label', 'Color'), colors);
    };
    const actions = el('div', 'dialog-actions');
    const cancel = el('button', 'quiet', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => document.getElementById('sheet')?.remove());
    const save = el('button', 'block', 'Create agent');
    save.type = 'button';
    save.addEventListener('click', () => createAgent(name.value, title.value, chosenOrb, soul.value, chosenColor));
    actions.append(cancel, save);
    frag.append(labeledField('Name', name), labeledField('Title or role', title), starts, labeledField('Instructions', soul), actions);
    frag.append(el('p', '', 'Creates an isolated profile from intelio. Messaging platforms stay off. Ready after the next agent restart.'));
    setTimeout(() => {
      if (!gallery.isConnected) return;
      loading.remove();
      gallery.hidden = false;
      paintGallery();
    }, 40);
    return frag;
  }

  async function createAgent(name, title, orb, soul, color) {
    const response = await fetch('/api/profiles', {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: JSON.stringify({ name, title, orb, soul, color }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      state.error = body.error || 'Could not create that agent.';
      render();
      return;
    }
    const created = {
      id: body.id,
      name: body.name || body.id,
      description: body.description || '',
      title: body.title || '',
      orb: body.orb || orb,
      color: body.color || color || '',
      needsSignIn: body.needsSignIn === true,
      gatewayNote: body.gatewayNote || 'Ready after the next agent restart',
      status: 'online',
    };
    if (!state.home.profiles.some((item) => item.id === created.id)) state.home.profiles.push(created);
    state.bot = created;
    state.profileCard = null;
    state.profileLoaded = '';
    state.profileNote = [created.needsSignIn ? 'Needs sign-in' : '', created.gatewayNote].filter(Boolean).join(' ');
    document.getElementById('sheet')?.remove();
    openBrowser('agent');
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
    const chat = el('button', 'block', `Message ${agentLabel(state.bot)}`);
    chat.type = 'button';
    chat.addEventListener('click', () => { document.getElementById('sheet')?.remove(); startChatWith(state.bot); });
    const call = el('button', 'block call-choice', `Call ${agentLabel(state.bot)}`);
    call.type = 'button';
    let armed = false;
    call.addEventListener('pointerdown', (event) => {
      armed = event.target === call || call.contains(event.target);
    });
    call.addEventListener('pointerup', (event) => {
      const hit = armed && (event.target === call || call.contains(event.target));
      armed = false;
      const sheet = call.closest('.sheet');
      if (!hit || !sheet || sheet.dataset.ready !== '1') return;
      event.preventDefault();
      event.stopPropagation();
      sheet.remove();
      const go = async () => {
        if (!state.chatId) await startChatWith(state.bot);
        startCall(state.chatId);
      };
      go();
    });
    call.addEventListener('pointercancel', () => { armed = false; });
    call.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); });
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

  async function callMyPhone() {
    let ready = false;
    try {
      const response = await fetch('/api/phone/call', {
        method: 'POST',
        headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
        body: JSON.stringify({ profile: state.bot?.id }),
      });
      const body = await response.json().catch(() => ({}));
      ready = response.ok && body.ready === true;
    } catch { ready = false; }
    state.phoneNote = ready ? '' : 'Phone line not set up yet';
    if (state.view === 'chat') render();
  }

  async function dictateIntoBox(button) {
    const input = document.getElementById('ask');
    if (!input) return;
    if (state.dictating) {
      state.dictating = false;
      button?.classList.remove('hot');
      if (webRec) {
        try { webRec.stop(); } catch { /* already stopped */ }
        return;
      }
      const blob = await stopRecorder();
      releaseMic();
      const text = blob ? await transcribeBlob(blob).catch(() => '') : '';
      if (text) input.value = `${input.value ? `${input.value.trim()} ` : ''}${String(text).trim()}`;
      return;
    }
    state.dictating = true;
    button?.classList.add('hot');
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Rec) {
      try {
        startWebRecognizer(false, true);
        return;
      } catch { /* fall through to the recorder */ }
    }
    try {
      await openMic();
      startRecorder();
    } catch (error) {
      state.dictating = false;
      button?.classList.remove('hot');
      state.error = micMessage(error);
      render();
    }
  }

  function startWebRecognizer(continuous, intoBox) {
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
        if (intoBox) {
          const input = document.getElementById('ask');
          if (input) input.value = `${input.value ? `${input.value.trim()} ` : ''}${finalText.trim()}`;
          state.dictating = false;
        } else sendTurn(finalText.trim());
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
    if (!view.handoff && !view.signIn && !(view.statusLines || []).length) return null;
    const bar = el('div', 'bops-bar');
    if (view.handoff) bar.append(el('p', 'bops-handoff', view.handoff.label));
    for (const line of view.statusLines || []) bar.append(el('p', 'bops-status-line', line.text));
    if (view.signIn) bar.append(phoneSignIn(api, view.signIn));
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
      const run = api.startRun({ text, profile: state.bot?.id || 'intelio', agentName: agentLabel(state.bot) });
      if (run.orchestration === 'app-fan-out' || run.handoff) {
        state.bops = run;
        state.readFor = text;
        state.readAt = Date.now();
        pushLine('user', text);
        pushLine('read', readText(state.readAt));
        state.thinking = true;
        render();
        try { await runPhonePlan(api.executionPlan(run)); } finally { state.thinking = false; render(); }
        return;
      }
    }
    state.readFor = text;
    state.readAt = Date.now();
    pushLine('user', text);
    pushLine('read', readText(state.readAt));
    const pending = { role: 'assistant', text: '', pending: true };
    for (const bucket of buckets()) bucket.push(pending);
    const steps = [];
    let sawTool = false;
    const placeSteps = () => {
      for (const bucket of buckets()) {
        for (let i = bucket.length - 1; i >= 0; i -= 1) {
          if (bucket[i] && bucket[i].turnStep) bucket.splice(i, 1);
        }
        const at = bucket.indexOf(pending);
        const live = pending.pending === true;
        const rows = steps.map((step) => ({
          role: 'activity',
          turnStep: true,
          liveStep: live && step.running === true,
          live: live,
          text: step.detail || '',
          title: step.name,
          status: step.failed ? 'Failed' : (step.running ? 'Running' : 'Done'),
        }));
        if (at >= 0) bucket.splice(at + 1, 0, ...rows);
        else bucket.push(...rows);
      }
      paintThread();
    };
    paintThread();
    unspoken = '';
    state.thinking = true;
    paintLive();
    try {
    const payload = { input: text, profile: state.bot?.id || '' };
    if (state.modelApplied === 'request' && state.modelId && state.modelProvider) {
      payload.model = state.modelId;
      payload.provider = state.modelProvider;
      payload.effort = state.modelEffort || 'auto';
    }
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: profileHeaders(state.bot?.id, { 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
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
        if (!sawTool) { steps.length = 0; sawTool = true; }
        const detail = payload.summary || payload.error || '';
        if (done) {
          const open = [...steps].reverse().find((step) => step.running && step.name === name);
          if (open) { open.running = false; open.failed = failed; if (detail) open.detail = detail; }
          else steps.push({ name, detail, running: false, failed });
        } else steps.push({ name, detail, running: true, failed: false });
        placeSteps();
        return;
      }
      const delta = payload.delta || payload.text || '';
      if (!delta) return;
      const before = window.IntelioTranscript ? window.IntelioTranscript.peel(pending.text).prose : pending.text;
      pending.text += delta;
      const after = window.IntelioTranscript ? window.IntelioTranscript.peel(pending.text).prose : pending.text;
      const spoken = after.startsWith(before) ? after.slice(before.length) : '';
      if (!sawTool && window.IntelioTranscript) {
        const peeled = window.IntelioTranscript.peel(pending.text);
        steps.length = 0;
        for (const part of peeled.chips) steps.push({ name: part.name, detail: part.detail || '', running: false, failed: false });
        placeSteps();
      } else paintThread();
      if (spoken && state.call.active && state.call.speaker) feedSpeech(spoken);
    });
    pending.pending = false;
    placeSteps();
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
    } else if (name === 'browser') {
      state.call.active = false;
      state.view = 'browser';
      state.drawer = false;
      state.browserControl = false;
    } else if (name === 'signin') {
      state.call.active = false;
      state.thinking = false;
      state.chatId = 'sample-intelio';
      state.messages = await loadMessages('sample-intelio', []);
      state.view = 'chat';
      state.tab = 'chat';
      state.drawer = false;
      state.bops = {
        profile: 'intelio',
        agentName: 'intelio',
        focusedId: 'signin-1',
        orchestration: 'single-session',
        tasks: [{
          id: 'signin-1',
          title: 'Sign in',
          status: 'blocked',
          dismissed: false,
          blocker: { kind: 'login', domain: 'accounts.example.com' },
        }],
      };
    }
    render();
    return true;
  };

  const savedTheme = storedTheme();
  setTheme(savedTheme || 'light', false);

  function pinKeyboard() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--kb', `${Math.round(inset)}px`);
  }
  window.visualViewport?.addEventListener('resize', pinKeyboard);
  window.visualViewport?.addEventListener('scroll', pinKeyboard);
  pinKeyboard();

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
