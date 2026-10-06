'use strict';
/**
 * Tailnet-only phone client for the VPS Hermes.
 * Sign-in is the caller's Tailscale login. The profile API key is read from
 * a mode-600 env file on this host and never written into the page or a cookie.
 * Voice audio is transcribed and spoken here (or by Hermes, if that profile
 * advertises audio). The page never sees the key.
 */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const { isTailnetOrLoopbackHost, normalizeRemoteConfig, DEFAULT_PORT } = require('../../desktop/src/intelio/remote-hermes.cjs');
const { resolveRepoRoot } = require('../../desktop/src/intelio/paths.cjs');
const { readBrandPng, scalePng } = require('../../desktop/src/intelio/png-icon.cjs');
const { createVoiceRuntime } = require('./voice.cjs');
const { normalizeIp, parseAllowlist, profileKeyPath, readProfileKey, createIdentity } = require('./identity.cjs');
const { renderOrbPng } = require('./orbs.cjs');
const { assertSlug, displayName, listProfiles, createProfile, restartGateway } = require('./profiles.cjs');

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SESSION_MS = 12 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AUDIO_LIMIT = 8 * 1024 * 1024;

const TILES = [
  { id: 'intelio', name: 'Intelio', color: '#ff8a1f', status: 'online' },
  { id: 'prc', name: 'PRC', color: '#5b7cfa', status: 'online' },
  { id: 'alignment', name: 'Alignment', color: '#b388ff', status: 'online' },
  { id: 'hhp', name: 'HHP', color: '#2eb8a0', status: 'away' },
  { id: 'kid-a', name: 'Kid A', color: '#ff8a80', status: 'online' },
];

const SAMPLE_HOME = {
  sample: true,
  label: 'SAMPLE DATA',
  profiles: TILES,
  conversations: [
    { id: 'sample-intelio', profileId: 'intelio', group: 'work', title: 'Intelio', preview: 'Need your yes on the Friday all-hands deck.', time: '7:34 PM', inCall: true },
    { id: 'sample-outreach', profileId: 'prc', group: 'work', title: 'Outreach', preview: '8 intros drafted — sitting in the CRM till you review.', time: '11:16 AM' },
    { id: 'sample-launch', profileId: 'alignment', group: 'work', title: 'Website launch', preview: 'Checkout is clean on staging. Three bugs left.', time: '11:02 AM' },
    { id: 'sample-support', profileId: 'hhp', group: 'work', title: 'Support', preview: 'Acme is wobbling. Drafted a Thursday check-in.', time: '2:20 PM' },
    { id: 'sample-marketing', profileId: 'kid-a', group: 'work', title: 'Marketing', preview: 'Launch post is live. First 200 impressions.', time: '1:05 PM' },
    { id: 'sample-renewal', profileId: 'hhp', group: 'work', title: 'Acme renewal', preview: 'Support: Acme is wobbling. Drafted a Thursday note.', time: '9:40 AM' },
  ],
  skillsOk: true,
  jobsOk: true,
  skills: [
    { name: 'web', description: 'SAMPLE DATA · Search and read pages the agent is allowed to open.', category: 'tools' },
    { name: 'session-search', description: 'SAMPLE DATA · Look through this profile’s Hermes sessions.', category: 'memory' },
  ],
  jobs: [
    { id: 'sample-digest', name: 'Friday digest', schedule: 'weekly', status: 'active', detail: 'SAMPLE DATA · Summarize the week’s sessions.' },
  ],
};

const SAMPLE_MESSAGES = {
  'sample-lamp': [
    { role: 'user', content: 'I\'m redoing the office. Can you find me a nice vintage desk lamp? Ideally brass, under $150.' },
    { role: 'activity', content: 'web_search · Searched 3 marketplaces' },
    { role: 'assistant', content: 'Best three: a 1960s brass banker\'s lamp ($95), a restored Bauhaus task lamp ($140), and an art-deco swing arm ($120). The banker\'s lamp is in the cleanest condition.' },
    { role: 'choice', content: 'Go with the banker\'s lamp.' },
    { role: 'assistant', content: 'Ordered — arriving Thursday. I sent the receipt to Finance for expenses.' },
    { role: 'time', content: '7:34 PM' },
    { role: 'assistant', content: 'Need your yes on the Friday all-hands deck.' },
  ],
  'sample-intelio': [
    { role: 'user', content: 'Hey, so I forgot what were the takeaways and action items from today\'s stand-up?' },
    { role: 'assistant', content: 'Three takeaways. The API migration is on track for Friday, but the auth service needs a security review before we ship. Dana\'s handling that review. And the staging deploy got pushed to Thursday.' },
    { role: 'assistant', content: 'All right.' },
    { role: 'user', content: 'Tell Dana that I\'m going to get' },
  ],
};

function icons() {
  let png;
  try { png = renderOrbPng('intelio', 512); }
  catch { png = readBrandPng(resolveRepoRoot()); }
  return {
    '/icon-192.png': scalePng(png, 192, 192),
    '/icon-512.png': scalePng(png, 512, 512),
    '/apple-touch-icon.png': scalePng(png, 180, 180),
  };
}

function listFrom(json, keys) {
  if (Array.isArray(json)) return json;
  for (const key of keys) if (Array.isArray(json?.[key])) return json[key];
  return [];
}

function normalizeSkills(json) {
  return listFrom(json, ['skills', 'data']).slice(0, 80).map((item) => ({
    name: String(item.name || item.id || 'Skill').slice(0, 80),
    description: String(item.description || '').slice(0, 240),
    category: String(item.category || '').slice(0, 40),
  }));
}

function normalizeJobs(json) {
  return listFrom(json, ['jobs', 'data']).slice(0, 80).map((item) => ({
    id: String(item.id || item.job_id || '').slice(0, 80),
    name: String(item.name || item.title || item.prompt || 'Scheduled job').slice(0, 120),
    schedule: String(item.schedule || item.cron || item.cadence || '').slice(0, 80),
    status: String(item.state || item.status || item.last_status || '').slice(0, 40),
    detail: String(item.prompt || item.description || '').slice(0, 240),
  }));
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return '';
}

function loopbackBind(bind) {
  const host = String(bind || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function assertUpstream(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Hermes URL must be http(s).');
  if (url.username || url.password) throw new Error('Hermes URL must not carry credentials.');
  if (!isTailnetOrLoopbackHost(url.hostname)) throw new Error('Hermes URL must stay on the tailnet or loopback.');
  return url;
}

function titleCase(name) {
  const raw = String(name || 'intelio');
  return raw.slice(0, 1).toUpperCase() + raw.slice(1);
}

function clockLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function createPwaServer({
  bind = process.env.INTELIO_PWA_BIND,
  port = Number(process.env.INTELIO_PWA_PORT || 8643),
  upstream = process.env.INTELIO_HERMES_URL || `http://127.0.0.1:${DEFAULT_PORT}`,
  profile = process.env.INTELIO_HERMES_PROFILE || 'intelio',
  certPath = process.env.INTELIO_PWA_CERT || '',
  keyPath = process.env.INTELIO_PWA_KEY || '',
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sample = process.env.INTELIO_PWA_SAMPLE === '1',
  voice = null,
  profileKey = '',
  allowedLogins = parseAllowlist(process.env.INTELIO_PWA_ALLOWED_LOGINS),
  identify = null,
  log = (line) => process.stderr.write(`${line}\n`),
  profileHome = process.env.HOME || undefined,
  profileRun = undefined,
  profileOps = null,
} = {}) {
  if (!isTailnetOrLoopbackHost(bind)) throw new Error('Refusing to listen: bind address must be a Tailscale address or loopback.');
  if (sample && !loopbackBind(bind)) throw new Error('Sample phone data is loopback-only.');
  const upstreamUrl = assertUpstream(upstream);
  const normalized = normalizeRemoteConfig({ host: '127.0.0.1', port: 8642, profile });
  const profileName = normalized.profile;
  const sessions = new Map();
  const authFor = new WeakMap();
  const pendingCookies = new WeakMap();
  const iconBytes = icons();
  const runtime = voice || createVoiceRuntime();
  const identity = createIdentity();
  const cachedKeys = new Map();
  let keyError = '';
  let audioApi = false;
  let listedProfiles = null;
  let featuresKnown = false;
  const denialLogAt = new Map();

  function prune() {
    for (const [token, session] of sessions) if (session.exp <= now()) sessions.delete(token);
  }
  function sessionFrom(req) {
    if (authFor.has(req)) return authFor.get(req);
    prune();
    const token = readCookie(req.headers.cookie, 'intelio_session');
    const session = token ? sessions.get(token) : null;
    if (!session || session.exp <= now()) return null;
    return session;
  }
  function bearerKey(profileId) {
    const id = profileId || profileName;
    if (cachedKeys.has(id)) return cachedKeys.get(id);
    if (sample) throw new Error('Sample mode does not call Hermes.');
    if (profileOps && profileOps.keyFor) {
      const key = profileOps.keyFor(id);
      if (!key) throw new Error('Profile key is not available.');
      cachedKeys.set(id, key);
      return key;
    }
    if (id === profileName && profileKey) {
      cachedKeys.set(id, profileKey);
      return profileKey;
    }
    if (keyError && id === profileName) throw new Error(keyError);
    try {
      const key = readProfileKey(profileKeyPath({ profile: id }));
      cachedKeys.set(id, key);
      return key;
    } catch (error) {
      const message = String(error.message || 'Profile key is not available.');
      if (id === profileName) keyError = message;
      throw new Error(message);
    }
  }
  async function learnFeatures() {
    if (featuresKnown || sample) return;
    try {
      const probe = await fetchImpl(hermesUrl(profileName, '/v1/capabilities'), { headers: { Authorization: `Bearer ${bearerKey(profileName)}`, Accept: 'application/json' }, redirect: 'error' });
      const text = await probe.text();
      let json = {};
      if (probe.ok) { try { json = JSON.parse(text); } catch { json = {}; } }
      audioApi = Boolean(json.features && json.features.audio_api);
      listedProfiles = Array.isArray(json.profiles) ? json.profiles : null;
    } catch {
      audioApi = false;
    }
    featuresKnown = true;
  }
  function queueCookie(req, res, token) {
    const secure = req.socket.encrypted ? '; Secure' : '';
    pendingCookies.set(res, `intelio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
  }
  function cookieHeaders(res) {
    return pendingCookies.has(res) ? { 'set-cookie': pendingCookies.get(res) } : {};
  }
  async function authorize(req, res) {
    if (sample) {
      let session = sessionFrom(req);
      if (!session) {
        const token = crypto.randomBytes(32).toString('base64url');
        session = { login: 'sample', exp: now() + SESSION_MS, sample: true };
        sessions.set(token, session);
        queueCookie(req, res, token);
      }
      authFor.set(req, session);
      return session;
    }
    const ip = normalizeIp(req.socket.remoteAddress);
    const ident = identify ? await identify(ip) : await identity.identify(ip, allowedLogins);
    if (!ident || !ident.ok) {
      const reason = ident?.reason || 'denied';
      const stamp = `${ip}|${reason}|${ident?.login || ''}`;
      if (!denialLogAt.has(stamp) || now() - denialLogAt.get(stamp) > 30000) {
        denialLogAt.set(stamp, now());
        log(`intelio-pwa denied ${ip || 'unknown'} ${reason}${ident?.login ? ` login=${ident.login}` : ''}`);
      }
      return null;
    }
    let session = sessionFrom(req);
    if (!session || session.login !== ident.login) {
      const token = crypto.randomBytes(32).toString('base64url');
      session = { login: ident.login, exp: now() + SESSION_MS };
      sessions.set(token, session);
      queueCookie(req, res, token);
    }
    authFor.set(req, session);
    return session;
  }
  function originOk(req) {
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  }
  function mutationOk(req) {
    if (!req.headers.origin) return false;
    return originOk(req);
  }
  function chosenProfile(req, body) {
    const raw = String((body && body.profile) || req.headers['x-intelio-profile'] || profileName || 'intelio').trim().toLowerCase();
    return assertSlug(raw);
  }
  function send(res, code, body, headers = {}) {
    const payload = Buffer.from(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    const type = headers['content-type'] || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=utf-8');
    res.writeHead(code, { ...cookieHeaders(res), 'content-type': type, 'cache-control': 'no-store', 'content-length': payload.length, ...headers });
    res.end(payload);
  }
  async function readRaw(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('Request body is too large.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function readBody(req, limit) {
    const raw = await readRaw(req, limit);
    if (!raw.length) return {};
    return JSON.parse(raw.toString('utf8'));
  }
  function hermesUrl(profileId, pathname, query) {
    const url = new URL(upstreamUrl.toString());
    url.pathname = `/p/${profileId}${pathname}`;
    url.search = '';
    for (const [key, value] of Object.entries(query || {})) if (value) url.searchParams.set(key, value);
    return url;
  }
  async function forward(req, res, pathname, { method = 'GET', body, query, stream = false, profileId } = {}) {
    const session = sessionFrom(req);
    if (!session) return send(res, 401, { error: 'Sign in again.' });
    const agent = profileId || chosenProfile(req, body);
    const response = await fetchImpl(hermesUrl(agent, pathname, query), {
      method,
      headers: { Authorization: `Bearer ${bearerKey(agent)}`, Accept: stream ? 'text/event-stream' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
    });
    if (stream) {
      res.writeHead(response.status, { ...cookieHeaders(res), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      if (!response.body) return res.end();
      const reader = response.body.getReader();
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        res.write(Buffer.from(step.value));
      }
      return res.end();
    }
    const text = await response.text();
    res.writeHead(response.status, { ...cookieHeaders(res), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  }

  function engineChoice(req) {
    const raw = String(req.headers['x-intelio-engine'] || 'auto').toLowerCase();
    if (raw === 'hermes' || raw === 'vps' || raw === 'web' || raw === 'auto') return raw;
    return 'auto';
  }

  async function voiceStatus() {
    if (!sample) await learnFeatures();
    const local = runtime.status ? await runtime.status() : { vps: false, whisper: false, piper: false };
    const hermesAudio = Boolean(audioApi);
    let recommended = 'web';
    if (hermesAudio) recommended = 'hermes';
    else if (local.vps) recommended = 'vps';
    return {
      sample: Boolean(sample),
      hermesAudio,
      vps: Boolean(local.vps),
      web: true,
      recommended,
      whisper: local.whisper ? (process.env.INTELIO_VOICE_WHISPER_MODEL || 'base') : '',
      compute: local.piper || local.whisper ? (process.env.INTELIO_VOICE_WHISPER_COMPUTE || 'int8') : '',
    };
  }

  async function resolveEngine(requested) {
    if (!sample) await learnFeatures();
    if (requested === 'web') return 'web';
    if (requested === 'hermes') return audioApi ? 'hermes' : 'vps';
    if (requested === 'vps') return 'vps';
    if (audioApi) return 'hermes';
    const local = runtime.status ? await runtime.status() : { vps: false };
    return local.vps ? 'vps' : 'web';
  }

  async function hermesTranscribe(audio, contentType, profileId) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: contentType || 'audio/wav' }), 'speech.wav');
    form.append('model', 'whisper-1');
    const response = await fetchImpl(hermesUrl(profileId, '/v1/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearerKey(profileId)}` },
      body: form,
      redirect: 'error',
    });
    const text = await response.text();
    if (!response.ok) throw new Error('Hermes refused the recording.');
    const json = JSON.parse(text);
    return { text: String(json.text || '').trim() };
  }

  async function hermesSpeak(text, profileId) {
    const response = await fetchImpl(hermesUrl(profileId, '/v1/audio/speech'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearerKey(profileId)}`, 'Content-Type': 'application/json', Accept: 'audio/wav, audio/mpeg, application/octet-stream' },
      body: JSON.stringify({ input: text, model: 'tts-1' }),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Hermes refused to speak.');
    const wav = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') || 'audio/wav';
    return { wav, type };
  }

  async function loadProfiles() {
    if (profileOps && profileOps.list) return profileOps.list();
    return listProfiles({ home: profileHome, run: profileRun });
  }
  async function sessionsFor(profileId) {
    try {
      const response = await fetchImpl(hermesUrl(profileId, '/api/sessions', { limit: '100', offset: '0' }), {
        headers: { Authorization: `Bearer ${bearerKey(profileId)}`, Accept: 'application/json' },
        redirect: 'error',
      });
      const text = await response.text();
      if (!response.ok) return [];
      let json = {};
      try { json = JSON.parse(text); } catch { json = {}; }
      const rows = json.data || json.sessions || [];
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        id: String(row.id || ''),
        profileId,
        group: String(row.source || 'chat').toLowerCase(),
        title: String(row.title || 'Conversation').slice(0, 120),
        preview: String(row.preview || row.last_message || row.title || '').slice(0, 180),
        time: clockLabel(row.updated_at || row.updatedAt || row.created_at),
        source: String(row.source || ''),
      })).filter((row) => ID_RE.test(row.id));
    } catch {
      return [];
    }
  }
  async function realHome() {
    let listed = [];
    try { listed = await loadProfiles(); } catch { listed = []; }
    if (!Array.isArray(listed) || !listed.length) {
      listed = [{ id: profileName || 'intelio', name: displayName(profileName || 'intelio'), description: '', status: 'online' }];
    }
    const profiles = listed.slice(0, 40).map((item) => ({
      id: String(item.id || '').slice(0, 32),
      name: String(item.name || displayName(item.id) || 'Agent').slice(0, 80),
      description: String(item.description || '').slice(0, 240),
      status: item.status || 'online',
    })).filter((item) => item.id && item.id !== 'default');
    const conversations = [];
    for (const agent of profiles) conversations.push(...await sessionsFor(agent.id));
    return { sample: false, label: '', profiles, conversations, skills: [], jobs: [], skillsOk: false, jobsOk: false };
  }
  async function optionalList(profileId, pathname, normalize) {
    try {
      const response = await fetchImpl(hermesUrl(profileId, pathname), {
        headers: { Authorization: `Bearer ${bearerKey(profileId)}`, Accept: 'application/json' },
        redirect: 'error',
      });
      const text = await response.text();
      if (!response.ok) return { ok: false, list: [] };
      let json = [];
      try { json = JSON.parse(text); } catch { json = []; }
      return { ok: true, list: normalize(json) };
    } catch {
      return { ok: false, list: [] };
    }
  }

  async function handle(req, res) {
    if (!originOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/session') {
        await readRaw(req, 4096).catch(() => Buffer.alloc(0));
        return send(res, 405, { error: 'Sign-in uses Tailscale identity.' });
      }
      const session = await authorize(req, res);
      if (!session) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
      if (req.method === 'GET' && (url.pathname === '/session' || url.pathname === '/session/')) {
        return send(res, 200, { ok: true, login: session.login || '' });
      }
      if (req.method === 'DELETE' && url.pathname === '/session') {
        const token = readCookie(req.headers.cookie, 'intelio_session');
        if (token) sessions.delete(token);
        authFor.delete(req);
        return send(res, 200, { ok: true }, { 'set-cookie': 'intelio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'GET' && url.pathname === '/api/home') {
        if (sample) return send(res, 200, SAMPLE_HOME);
        await learnFeatures();
        const home = await realHome();
        const primary = home.profiles[0]?.id || profileName;
        const skills = await optionalList(primary, '/v1/skills', normalizeSkills);
        const jobs = await optionalList(primary, '/api/jobs', normalizeJobs);
        home.skills = skills.list;
        home.jobs = jobs.list;
        home.skillsOk = skills.ok;
        home.jobsOk = jobs.ok;
        return send(res, 200, home);
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        if (sample) return send(res, 200, { data: SAMPLE_HOME.skills, sample: true, label: 'SAMPLE DATA' });
        const skills = await optionalList(chosenProfile(req), '/v1/skills', normalizeSkills);
        if (!skills.ok) return send(res, 404, { error: 'This Hermes has no skills list.' });
        return send(res, 200, { data: skills.list });
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        if (sample) return send(res, 200, { data: SAMPLE_HOME.jobs, sample: true, label: 'SAMPLE DATA' });
        const jobs = await optionalList(chosenProfile(req), '/api/jobs', normalizeJobs);
        if (!jobs.ok) return send(res, 404, { error: 'This Hermes has no scheduled jobs.' });
        return send(res, 200, { data: jobs.list });
      }
      if (req.method === 'POST' && url.pathname === '/api/profiles') {
        if (!mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readBody(req, 8192);
        if (sample) {
          const slug = assertSlug(body.name);
          const summary = String(body.description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
          return send(res, 200, { id: slug, name: displayName(slug), description: summary, needsGatewayRestart: true, sample: true, label: 'SAMPLE DATA' });
        }
        const created = profileOps && profileOps.create
          ? await profileOps.create(body)
          : await createProfile({ name: body.name, description: body.description, cloneFrom: body.cloneFrom, home: profileHome, run: profileRun });
        return send(res, 200, {
          id: created.id,
          name: created.name,
          description: created.description || '',
          needsGatewayRestart: true,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/gateway/restart') {
        if (!mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        await readBody(req, 1024).catch(() => ({}));
        if (sample) return send(res, 200, { ok: true, sample: true, label: 'SAMPLE DATA' });
        if (profileOps && profileOps.restart) await profileOps.restart();
        else await restartGateway({ run: profileRun });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/voice') {
        return send(res, 200, await voiceStatus());
      }
      if (req.method === 'POST' && url.pathname === '/api/voice/stt') {
        const audio = await readRaw(req, AUDIO_LIMIT);
        if (audio.length < 16) return send(res, 400, { error: 'That recording was empty.' });
        const engine = await resolveEngine(engineChoice(req));
        if (engine === 'web') return send(res, 503, { error: 'Use the on-phone speech engine.', fallback: 'web' });
        const agent = chosenProfile(req);
        try {
          const result = engine === 'hermes'
            ? await hermesTranscribe(audio, req.headers['content-type'], agent)
            : await runtime.transcribe(audio);
          return send(res, 200, { text: result.text || '' });
        } catch (error) {
          return send(res, 503, { error: String(error.message || 'Speech to text failed.').slice(0, 200), fallback: 'web' });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/voice/tts') {
        const session = sessionFrom(req);
        if (!session) return send(res, 401, { error: 'Sign in again.' });
        const body = await readBody(req, 8192);
        const text = String(body.text || '').trim().slice(0, 2000);
        if (!text) return send(res, 400, { error: 'Nothing to speak.' });
        const engine = await resolveEngine(engineChoice(req));
        if (engine === 'web') return send(res, 503, { error: 'Use the on-phone speech engine.', fallback: 'web' });
        const agent = chosenProfile(req, body);
        try {
          const spoken = engine === 'hermes' ? await hermesSpeak(text, agent) : await runtime.synthesize(text);
          const wav = spoken.wav || spoken;
          const type = spoken.type || 'audio/wav';
          return send(res, 200, wav, { 'content-type': type.includes('audio') ? type : 'audio/wav' });
        } catch (error) {
          return send(res, 503, { error: String(error.message || 'Speech failed.').slice(0, 200), fallback: 'web' });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return await forward(req, res, '/api/sessions', { query: { source: url.searchParams.get('source') || '', limit: '100', offset: '0' }, profileId: chosenProfile(req) });
      }
      const messages = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (req.method === 'GET' && messages && ID_RE.test(messages[1])) {
        if (sample && SAMPLE_MESSAGES[messages[1]]) {
          if (!sessionFrom(req)) return send(res, 401, { error: 'Sign in again.' });
          return send(res, 200, { data: SAMPLE_MESSAGES[messages[1]], sample: true, label: 'SAMPLE DATA' });
        }
        return await forward(req, res, `/api/sessions/${messages[1]}/messages`, { query: { inline_images: 'false' }, profileId: chosenProfile(req) });
      }
      const chat = url.pathname.match(/^\/api\/sessions\/([^/]+)\/chat$/);
      if (req.method === 'POST' && chat && ID_RE.test(chat[1])) {
        const body = await readBody(req, 200000);
        if (sample && messagesLookSample(chat[1])) {
          if (!sessionFrom(req)) return send(res, 401, { error: 'Sign in again.' });
          res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
          res.end('event: assistant.delta\ndata: {"delta":"SAMPLE DATA reply."}\n\n');
          return;
        }
        return await forward(req, res, `/api/sessions/${chat[1]}/chat/stream`, { method: 'POST', body: { input: String(body.input || '').slice(0, 100000) }, stream: true, profileId: chosenProfile(req, body) });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readBody(req, 4096);
        if (sample) {
          if (!sessionFrom(req)) return send(res, 401, { error: 'Sign in again.' });
          return send(res, 200, { id: 'sample-lamp', title: String(body.title || 'Intelio').slice(0, 200), profileId: body.profile || 'intelio', sample: true, label: 'SAMPLE DATA' });
        }
        return await forward(req, res, '/api/sessions', { method: 'POST', body: { title: String(body.title || '').slice(0, 200) }, profileId: chosenProfile(req, body) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/avatars/')) {
        const name = path.basename(url.pathname);
        if (!/^[a-z0-9-]+\.png$/.test(name)) return send(res, 404, { error: 'Not found.' });
        const payload = renderOrbPng(name.slice(0, -4), 256);
        res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'image/png', 'content-length': payload.length, 'cache-control': 'public, max-age=86400' });
        return res.end(payload);
      }
      if (req.method === 'GET' && iconBytes[url.pathname]) {
        const payload = iconBytes[url.pathname];
        res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'image/png', 'content-length': payload.length, 'cache-control': 'public, max-age=86400' });
        return res.end(payload);
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const name = STATIC[url.pathname];
        const file = path.join(PUBLIC, name);
        const payload = fs.readFileSync(file);
        const ext = path.extname(name);
        res.writeHead(200, { ...cookieHeaders(res), 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': payload.length, 'cache-control': name === 'sw.js' ? 'no-cache' : 'public, max-age=300' });
        return res.end(payload);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      const code = Number(error?.status) || 400;
      return send(res, code >= 400 && code < 600 ? code : 400, { error: String(error?.message || 'Bad request').slice(0, 200) });
    }
  }

  let server;
  if (certPath || keyPath) {
    if (!certPath || !keyPath) throw new Error('Set both INTELIO_PWA_CERT and INTELIO_PWA_KEY, or neither.');
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handle);
  } else server = http.createServer(handle);

  return {
    server,
    sessions,
    sample: Boolean(sample),
    voice: runtime,
    warmVoice() {
      return runtime.warm ? runtime.warm() : Promise.resolve();
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => resolve(server.address()));
      });
    },
  };
}

function messagesLookSample(id) {
  return Object.prototype.hasOwnProperty.call(SAMPLE_MESSAGES, id) || id.startsWith('sample-');
}

module.exports = { createPwaServer };

if (require.main === module) {
  if (!process.env.INTELIO_HERMES_URL && process.env.INTELIO_PWA_SAMPLE !== '1') {
    process.stderr.write('Set INTELIO_HERMES_URL to the tailnet address from tailscale ip -4, port 8642. Hermes does not listen on loopback.\n');
    process.exit(1);
  }
  const app = createPwaServer();
  app.listen().then((address) => {
    process.stdout.write(`Intelio phone client listening on ${address.address}:${address.port}\n`);
    if (process.env.INTELIO_VOICE_PYTHON) {
      app.warmVoice().catch((error) => {
        process.stderr.write(`Voice engines did not warm: ${error.message}\n`);
      });
    }
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
