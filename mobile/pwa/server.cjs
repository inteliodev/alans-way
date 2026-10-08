'use strict';
/**
 * Phone client for the VPS Hermes.
 * The tailnet listener signs the caller in with Tailscale. When
 * INTELIO_PWA_ACCESS=1, a second plain HTTP listener on loopback accepts
 * Cloudflare Access (Cf-Access-Jwt-Assertion or the CF_Authorization cookie)
 * for app.intelio-ai.com.
 * Audience, team, and email allowlist come from the environment. This file
 * does not embed them. The profile API key is read from a mode-600 env file
 * on this host and never written into the page, a cookie, or a log.
 * Voice audio is transcribed and spoken here (or by Hermes, if that profile
 * advertises audio). The page never sees the key.
 */
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const { isTailnetOrLoopbackHost, normalizeRemoteConfig, DEFAULT_PORT } = require('../../desktop/src/intelio/remote-hermes.cjs');
const { resolveRepoRoot } = require('../../desktop/src/intelio/paths.cjs');
const { readBrandPng, scalePng } = require('../../desktop/src/intelio/png-icon.cjs');
const { createVoiceRuntime } = require('./voice.cjs');
const { createVaultStore } = require('../../desktop/src/intelio/vault.cjs');
const { fillLogin, scanLoginPages } = require('../../desktop/src/intelio/cdp-fill.cjs');
const { createLoginWatch } = require('../../desktop/src/intelio/login-watch.cjs');
const { normalizeIp, isLoopbackAddress, peerIsLocal, parseAllowlist, profileKeyPath, readProfileKey, createIdentity } = require('./identity.cjs');
const { renderOrbPng } = require('./orbs.cjs');
const { assertSlug, displayName, listProfiles, createProfile, restartGateway } = require('./profiles.cjs');
const { resolveVncUpstream, readVncPassword, bridgeVnc } = require('./vnc-proxy.cjs');
const { nodesEnabled, createNodesRelay } = require('./nodes-mcp.cjs');
const { handleComputersApi } = require('./nodes-human.cjs');
const { refuseUpgrade } = require('../../desktop/src/intelio/node/ws.cjs');
const { resolveCdpUrl } = require('../../desktop/src/intelio/cdp-fill.cjs');
const { harnessId, excludedAgent, buildCard, readProfileFiles, writePaused, writeReasoning, writeProfile, cleanColor, backupFile } = require('../../desktop/src/intelio/agent-card.cjs');
const picker = require('../../desktop/src/intelio/model-picker.cjs');
const { preview: previewTranscript } = require('../../desktop/src/intelio/transcript.cjs');
const { createSkillInstaller } = require('./skills-install.cjs');
const { createAccountsApi } = require('./accounts-routes.cjs');

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/thinking-orbs.js': 'thinking-orbs.js',
  '/sw.js': 'sw.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/desktop-boot.js': 'desktop-boot.js',
  '/desktop-transport.js': 'desktop-transport.js',
  '/home-tab.js': 'home-tab.js',
  '/home-tab.css': 'home-tab.css',
};
const DESKTOP_SRC = path.resolve(__dirname, '../../desktop/src');
// intelio home, missions, command bar and skill links (shared with the desktop renderer).
const HOME_CJS = ['intelio/commands.cjs', 'intelio/missions.cjs', 'intelio/home-feed.cjs', 'intelio/skill-link.cjs'];
const UI_EXT = new Set(['.css', '.js', '.woff2', '.png', '.svg']);
const UI_CJS = new Set(['intelio/approval-ui.cjs', 'intelio/bops.cjs', 'intelio/transcript.cjs', 'intelio/host-labels.cjs', 'intelio/calls.cjs', 'intelio/desktop-voice.cjs', 'intelio/model-picker.cjs', 'intelio/client-apps.cjs', 'intelio/login-prompt.cjs', ...HOME_CJS]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SESSION_MS = 12 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AUDIO_LIMIT = 8 * 1024 * 1024;

const TILES = [
  { id: 'intelio', name: 'intelio', color: '#ff8a1f', status: 'online' },
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
    { id: 'sample-intelio', profileId: 'intelio', group: 'work', title: 'intelio', preview: 'Need your yes on the Friday all-hands deck.', time: '7:34 PM', inCall: true },
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

function accessToken(req) {
  const header = String(req.headers['cf-access-jwt-assertion'] || '').trim();
  if (header) return header;
  return readCookie(req.headers.cookie, 'CF_Authorization').trim();
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
  // /api/home and /api/screens must answer well inside the desktop app's timeout
  // over Cloudflare Access: per-profile calls are capped and the profile list is cached.
  probeTimeoutMs = 1000,
  profileTtlMs = 60000,
  screensTtlMs = 15000,
  // /v1/skills is optional and some gateway builds answer it with a 500 on every call.
  // Remember the answer per profile so a polled /api/home does not re-ask (and re-log a
  // traceback on the gateway) every refresh: a good list for a minute, an HTTP error for 15.
  skillsTtlMs = 60000,
  skillsErrorTtlMs = 15 * 60000,
  sample = process.env.INTELIO_PWA_SAMPLE === '1',
  voice = null,
  profileKey = '',
  allowedLogins = parseAllowlist(process.env.INTELIO_PWA_ALLOWED_LOGINS),
  identify = null,
  log = (line) => process.stderr.write(`${line}\n`),
  profileHome = process.env.HOME || undefined,
  profileRun = undefined,
  profileOps = null,
  accessVerify = null,
  accessMode = process.env.INTELIO_PWA_ACCESS === '1',
  accessAud = process.env.INTELIO_PWA_ACCESS_AUD || '',
  accessEmails = parseAllowlist(process.env.INTELIO_PWA_ACCESS_EMAILS || ''),
  accessTeam = String(process.env.INTELIO_PWA_ACCESS_TEAM || '').replace(/\/$/, ''),
  localPort = Number(process.env.INTELIO_PWA_LOCAL_PORT || 8644),
  vncUpstream = process.env.INTELIO_PWA_VNC_URL || '',
  vncPassword,
  vaultRoot = process.env.INTELIO_VAULT_ROOT || '',
  vaultHome = process.env.INTELIO_VAULT_HOME || '',
  filler = null,
  loginScan = null,
  loginWatchMs,
  cdpImpl = null,
  selfCheck = null,
  githubFetch = globalThis.fetch,
  // A new agent is checked on its own /p/<name>/ route before the create call answers.
  readyTries = 6,
  readyDelayMs = 1000,
  accounts = null,
  activityFile = undefined,
  nodes = nodesEnabled() ? {} : null,
} = {}) {
  if (!isTailnetOrLoopbackHost(bind)) throw new Error('Refusing to listen: bind address must be a Tailscale address or loopback.');
  if (sample && !loopbackBind(bind)) throw new Error('Sample phone data is loopback-only.');
  if (accessMode && (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535)) throw new Error('INTELIO_PWA_LOCAL_PORT must be 0-65535.');
  const vncUrl = resolveVncUpstream(bind, vncUpstream);
  const vncSecret = vncPassword !== undefined ? String(vncPassword || '') : readVncPassword();
  const upstreamUrl = assertUpstream(upstream);
  const normalized = normalizeRemoteConfig({ host: '127.0.0.1', port: 8642, profile });
  const profileName = normalized.profile;
  const sessions = new Map();
  const vaultRootPath = vaultRoot || path.join(profileHome || os.homedir(), '.hermes', 'profiles');
  let listedProfilesForVault = [];
  // The intelio vault (data + key) lives outside ~/.hermes. A test that
  // passes its own vaultRoot gets a sibling folder instead of the real home.
  const skillInstaller = createSkillInstaller({ fetchImpl: githubFetch, profilesRoot: vaultRootPath });
  const vault = createVaultStore({
    root: vaultRootPath,
    home: vaultHome || (vaultRoot ? `${path.resolve(vaultRoot)}.intelio-home` : (profileHome || os.homedir())),
    profiles: () => [profileName, ...listedProfilesForVault],
  });
  // Accounts page and Settings > Activity (mobile/pwa/accounts-routes.cjs). Same auth as /api.
  const accountsApi = createAccountsApi({
    sample,
    home: profileHome || os.homedir(),
    profilesRoot: vaultRootPath,
    vaultCount: (id) => vault.list(id).length,
    accounts,
    activityFile,
    now,
  });
  const authFor = new WeakMap();
  const pendingCookies = new WeakMap();
  const iconBytes = icons();
  const runtime = voice || createVoiceRuntime();
  const identity = createIdentity();
  const cachedKeys = new Map();
  let keyError = '';
  let audioApi = false;
  let sessionModelLock = false;
  let listedProfiles = null;
  let featuresKnown = false;
  const profileCache = { at: 0, rows: null, pending: null, generation: 0 };
  const screenCache = { at: 0, rows: null, pending: null };
  const skillsCache = new Map();
  const denialLogAt = new Map();
  const certCache = { at: 0, keys: null };
  const NOVNC = path.resolve(__dirname, '../../desktop/node_modules/@novnc/novnc');
  const HOP = new Set(['cf-access-jwt-assertion', 'authorization', 'cookie', 'host', 'connection', 'keep-alive', 'transfer-encoding', 'proxy-authorization', 'upgrade']);

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
      sessionModelLock = Boolean(json.features && (json.features.session_model_lock || json.endpoints?.session_model_lock));
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
  function accessConfigured() {
    return Boolean(accessAud && accessTeam && accessEmails.length);
  }
  async function accessCerts() {
    if (!accessConfigured()) {
      const error = new Error('denied');
      error.code = 'denied';
      throw error;
    }
    if (certCache.keys && now() - certCache.at < 10 * 60 * 1000) return certCache.keys;
    const response = await fetchImpl(`${accessTeam}/cdn-cgi/access/certs`, { redirect: 'error' });
    if (!response.ok) {
      const error = new Error('denied');
      error.code = 'denied';
      throw error;
    }
    const keys = await response.json();
    certCache.at = now();
    certCache.keys = keys;
    return keys;
  }
  async function verifyCloudflare(token) {
    const { verifyAccessJwt } = require('../bootstrap/jwt.cjs');
    const keys = await accessCerts();
    const result = verifyAccessJwt(token, keys, {
      aud: accessAud,
      email: '',
      emails: accessEmails,
      team: accessTeam,
      now: now(),
    });
    return { ok: true, login: String(result.email || '').slice(0, 200) };
  }
  async function resolveAccess(token) {
    if (!token) return { ok: false, status: 401 };
    try {
      const ident = accessVerify ? await accessVerify(token) : await verifyCloudflare(token);
      if (!ident || !ident.ok) return { ok: false, status: ident?.status === 403 ? 403 : 401 };
      return { ok: true, login: String(ident.login || '').slice(0, 200) };
    } catch (error) {
      return { ok: false, status: error?.status === 403 || error?.code === 'email' ? 403 : 401 };
    }
  }
  function rememberAccess(req, res, login) {
    let session = sessionFrom(req);
    if (!session || session.login !== login || !session.access) {
      const token = crypto.randomBytes(32).toString('base64url');
      session = { login, exp: now() + SESSION_MS, access: true };
      sessions.set(token, session);
      queueCookie(req, res, token);
    }
    authFor.set(req, session);
    return session;
  }
  async function acceptAccess(req, res) {
    const assertion = accessToken(req);
    const ident = await resolveAccess(assertion);
    if (!ident.ok) {
      if (assertion) log(ident.status === 403 ? 'intelio-pwa denied access-email' : 'intelio-pwa denied access-jwt');
      return ident;
    }
    return { ok: true, session: rememberAccess(req, res, ident.login) };
  }
  async function authorize(req, res) {
    const existing = sessionFrom(req);
    if (existing?.access) {
      authFor.set(req, existing);
      return existing;
    }
    const assertion = accessToken(req);
    if (assertion && (accessVerify || accessMode)) {
      let ident = null;
      try { ident = accessVerify ? await accessVerify(assertion) : await verifyCloudflare(assertion); } catch { ident = null; }
      if (!ident?.ok) {
        log('intelio-pwa denied access-jwt');
        return null;
      }
      const login = String(ident.login || 'access').slice(0, 200);
      let session = sessionFrom(req);
      if (!session || session.login !== login) {
        const token = crypto.randomBytes(32).toString('base64url');
        session = { login, exp: now() + SESSION_MS, access: true };
        sessions.set(token, session);
        queueCookie(req, res, token);
      }
      authFor.set(req, session);
      return session;
    }
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
  function presentedBearer(req) {
    const header = String(req.headers.authorization || '');
    if (!header.trim()) return { present: false, token: '' };
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return { present: true, token: match ? match[1] : '' };
  }
  function keyEquals(token, profileId) {
    let expected = '';
    try { expected = bearerKey(profileId); } catch { return false; }
    const left = Buffer.from(String(token || ''));
    const right = Buffer.from(expected);
    if (left.length !== right.length || left.length === 0) return false;
    return crypto.timingSafeEqual(left, right);
  }
  function hostAddresses() {
    const found = [];
    for (const entries of Object.values(os.networkInterfaces() || {})) {
      for (const entry of entries || []) {
        const address = normalizeIp(entry.address);
        if (address && !found.includes(address)) found.push(address);
      }
    }
    return found;
  }
  async function peerIsSelf(ip) {
    if (selfCheck) return Boolean(await selfCheck(ip));
    const address = normalizeIp(ip);
    if (!address || isLoopbackAddress(address)) return true;
    const hosts = hostAddresses();
    if (hosts.includes(address)) return true;
    let described = null;
    try { described = await identity.describe(address); } catch { described = null; }
    if (!described) return true;
    return peerIsLocal({ address, whois: described.whois, self: described.self, hostIps: hosts });
  }
  function logVaultDenial(profileId, reason) {
    const stamp = `vault|${profileId}|${reason}`;
    if (denialLogAt.has(stamp) && now() - denialLogAt.get(stamp) <= 30000) return;
    denialLogAt.set(stamp, now());
    log(`intelio-pwa denied vault profile=${profileId} reason=${reason}`);
  }
  async function refreshVaultProfiles() {
    try {
      const rows = await listProfiles({ home: profileHome, run: profileRun });
      listedProfilesForVault = rows.map((row) => row.id);
    } catch {
      listedProfilesForVault = [];
    }
  }
  async function runFiller(profileId, body, saved) {
    const values = saved || {
      domain: body.domain,
      username: body.username,
      password: body.password,
      otp: body.otp,
      selectors: body.selectors,
    };
    const run = filler || fillLogin;
    try {
      return await run({
        profile: profileId,
        root: vaultRootPath,
        domain: values.domain || body.domain || body.site,
        selectors: body.selectors || values.selectors,
        values: { username: values.username, password: values.password, otp: values.otp },
        submit: body.submit === true,
        ...(cdpImpl ? { CDPImpl: cdpImpl } : {}),
      });
    } catch {
      return { ok: false, filled: false };
    }
  }
  const loginWatch = createLoginWatch({
    vault,
    fill: (profileId, hit, options) => runFiller(profileId, { domain: hit.domain, selectors: hit.selectors, submit: options?.submit === true }, hit),
    scan: sample ? null : (loginScan || ((profileId) => scanLoginPages({ profile: profileId, root: vaultRootPath, ...(cdpImpl ? { CDPImpl: cdpImpl } : {}) }))),
  });
  function profilesWithBrowser() {
    return [...new Set([profileName, ...vault.knownProfiles()])].filter((id) => {
      try { return Boolean(resolveCdpUrl({ profile: id, root: vaultRootPath })); } catch { return false; }
    });
  }
  function publicVault(result, extra = {}) {
    return {
      ok: result?.ok === true || extra.saved === true,
      filled: result?.filled === true,
      saved: extra.saved === true,
      domain: String(result?.domain || extra.domain || ''),
      ...(extra.username ? { username: String(extra.username) } : {}),
      ...(extra.logins ? { logins: extra.logins } : {}),
    };
  }
  function chosenProfile(req, body) {
    let fromQuery = '';
    try { fromQuery = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('profile') || ''; } catch { fromQuery = ''; }
    const raw = String((body && body.profile) || req.headers['x-intelio-profile'] || fromQuery || profileName || 'intelio').trim().toLowerCase();
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

  async function hermesJson(profileId, pathname, { method = 'GET', body } = {}) {
    const response = await fetchImpl(hermesUrl(profileId, pathname), {
      method,
      headers: {
        Authorization: `Bearer ${bearerKey(profileId)}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json };
  }
  async function catalogFor(profileId, current) {
    if (sample || !picker.subscriptionProvider(current.provider) || current.secret) return [];
    let groups = [];
    try {
      const options = await hermesJson(profileId, '/api/model/options');
      if (options.status === 200 && options.json) groups = picker.modelsFromHermes(options.json);
    } catch { groups = []; }
    if (groups.length) return groups;
    try {
      const listed = await hermesJson(profileId, '/v1/models');
      const models = listed.status === 200 ? picker.modelsFromList(listed.json) : [];
      const provider = picker.canonicalProvider(current.provider);
      if (!models.length || !picker.subscriptionProvider(provider)) return [];
      return [{ provider, label: picker.providerLabel(provider), models }];
    } catch { return []; }
  }
  function modelState(profileId) {
    const id = harnessId(profileId);
    const files = id ? readProfileFiles(vaultRootPath, id) : null;
    const current = picker.configModel(files?.configText || '');
    return {
      id,
      files,
      current,
      effort: picker.effortFromConfig(files?.configText || ''),
      keyless: picker.subscriptionProvider(current.provider) && !current.secret,
    };
  }
  function modelAllowed(state, provider, model, groups) {
    const canon = picker.canonicalProvider(provider);
    if (!picker.keepId(model) || !picker.subscriptionProvider(canon)) return false;
    if (!state.keyless) return false;
    const listed = (groups || []).some((group) => group.provider === canon && group.models.includes(model));
    const same = picker.canonicalProvider(state.current.provider) === canon && state.current.model === model;
    return listed || same;
  }
  async function threadModel(profileId, sessionId) {
    if (!sessionId || !ID_RE.test(sessionId)) return '';
    try {
      const hit = await hermesJson(profileId, `/api/sessions/${sessionId}`);
      const id = String(hit.json?.model || hit.json?.session?.model || '').trim();
      if (!picker.keepId(id) || id === profileId) return '';
      return id;
    } catch { return ''; }
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

  // `hermes profile list` takes seconds, so the list is cached: fresh for profileTtlMs,
  // then served stale while one background refresh runs. A cold cache waits briefly for
  // the full list and otherwise answers from the profile folders.
  function refreshProfiles() {
    if (profileCache.pending) return profileCache.pending;
    const started = profileCache.generation;
    const listing = Promise.resolve().then(() => (profileOps && profileOps.list
      ? profileOps.list()
      : listProfiles({ home: profileHome, run: profileRun })));
    const pending = listing.then((rows) => {
      if (Array.isArray(rows) && started === profileCache.generation) {
        profileCache.rows = rows;
        profileCache.at = now();
      }
      return Array.isArray(rows) ? rows : (profileCache.rows || []);
    }).catch(() => profileCache.rows || []).finally(() => {
      if (profileCache.pending === pending) profileCache.pending = null;
    });
    profileCache.pending = pending;
    return pending;
  }
  function forgetProfiles() {
    profileCache.generation += 1;
    profileCache.rows = null;
    profileCache.at = 0;
    profileCache.pending = null;
    screenCache.rows = null;
    screenCache.at = 0;
  }
  async function loadProfiles() {
    if (profileCache.rows) {
      if (now() - profileCache.at >= profileTtlMs) refreshProfiles();
      return profileCache.rows;
    }
    const full = refreshProfiles();
    if (profileOps && profileOps.list) return full;
    const first = await withTimeout(full, Math.min(probeTimeoutMs, 250), null);
    if (first) return first;
    try {
      const quick = await listProfiles({ home: profileHome, run: profileRun, cli: false });
      if (Array.isArray(quick) && quick.length) return quick;
    } catch { /* fall through to the full list */ }
    return full;
  }
  function withTimeout(promise, ms, fallback) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
    return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
  }
  function timeoutSignal(ms) {
    return ms && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  }
  async function sessionsFor(profileId, timeoutMs = 0) {
    try {
      const response = await fetchImpl(hermesUrl(profileId, '/api/sessions', { limit: '100', offset: '0' }), {
        headers: { Authorization: `Bearer ${bearerKey(profileId)}`, Accept: 'application/json' },
        redirect: 'error',
        signal: timeoutSignal(timeoutMs),
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
        preview: previewTranscript(String(row.preview || row.last_message || row.title || '')).slice(0, 180),
        last_message: previewTranscript(String(row.last_message || row.preview || '')).slice(0, 180),
        time: clockLabel(row.updated_at || row.updatedAt || row.created_at),
        updated_at: String(row.updated_at || row.updatedAt || row.created_at || '').slice(0, 40),
        source: String(row.source || ''),
        // intelio home and missions read these for status and "Recent work".
        last_active: typeof row.last_active === 'number' ? row.last_active : String(row.last_active || '').slice(0, 40),
        ended_at: typeof row.ended_at === 'number' ? row.ended_at : String(row.ended_at || '').slice(0, 40),
        message_count: Number(row.message_count) || 0,
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
      name: (['intelio', 'prc', 'alignment', 'hhp'].includes(String(item.id || '').toLowerCase())
        ? displayName(item.id)
        : String(item.name || displayName(item.id) || 'Agent')).slice(0, 80),
      description: String(item.description || '').slice(0, 240),
      status: item.status || 'online',
      orb: String(item.orb || '').slice(0, 40),
      color: cleanColor(item.color),
      title: String(item.title || '').slice(0, 80),
      needsSignIn: item.needsSignIn === true,
      gatewayNote: String(item.gatewayNote || '').slice(0, 160),
    })).filter((item) => item.id && item.id !== 'default' && !excludedAgent(item.id));
    // One slow or unreachable profile must not hold up the rest: fetch in parallel,
    // cap each, and return whatever answered.
    const lists = await Promise.all(profiles.map((agent) => withTimeout(sessionsFor(agent.id, probeTimeoutMs), probeTimeoutMs + 100, [])));
    const conversations = [];
    for (const list of lists) conversations.push(...list);
    return { sample: false, label: '', profiles, conversations, skills: [], jobs: [], skillsOk: false, jobsOk: false };
  }
  function uiFile(pathname) {
    if (!pathname.startsWith('/ui/')) return '';
    const rel = pathname.slice('/ui/'.length);
    if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) return '';
    const ext = path.extname(rel).toLowerCase();
    if (ext === '.cjs') {
      if (!UI_CJS.has(rel)) return '';
    } else if (!UI_EXT.has(ext)) return '';
    const file = path.resolve(DESKTOP_SRC, rel);
    const root = DESKTOP_SRC.endsWith(path.sep) ? DESKTOP_SRC : DESKTOP_SRC + path.sep;
    if (!file.startsWith(root)) return '';
    try {
      if (!fs.statSync(file).isFile()) return '';
    } catch { return ''; }
    return file;
  }
  function desktopShell() {
    let html = fs.readFileSync(path.join(DESKTOP_SRC, 'index.html'), 'utf8');
    html = html.replace(
      "connect-src 'none'",
      "connect-src 'self' ws: wss:",
    ).replace(
      "img-src 'self' data: crx:",
      "img-src 'self' data: blob: crx:",
    );
    html = html.replace(/(href|src)="(?!\/|https?:|data:)([^"]+)"/g, '$1="/ui/$2"');
    html = html.replace('</head>', '<script src="/desktop-boot.js?v=29"></script></head>');
    html = html.replace(
      '<script src="/ui/renderer.js"></script>',
      '<script src="/ui/intelio/host-labels.cjs"></script><script src="/desktop-transport.js?v=29"></script><script src="/ui/renderer.js"></script>',
    );
    return html;
  }
  function publicAsset(pathname) {
    if (STATIC[pathname] || iconBytes[pathname]) return true;
    if (pathname === '/desktop' || pathname === '/desktop/') return true;
    if (pathname === '/bops.js' || pathname === '/transcript.js') return true;
    if (pathname.startsWith('/avatars/') && /^\/avatars\/[a-z0-9-]+\.png$/.test(pathname)) return true;
    if (uiFile(pathname)) return true;
    return Boolean(novncFile(pathname));
  }
  function novncFile(pathname) {
    if (!pathname.startsWith('/novnc/')) return '';
    const rel = pathname.slice('/novnc/'.length);
    if (!rel || rel.split('/').some((part) => !part || part === '..')) return '';
    const file = path.resolve(NOVNC, rel);
    const root = NOVNC.endsWith(path.sep) ? NOVNC : NOVNC + path.sep;
    if (!file.startsWith(root)) return '';
    try {
      if (!fs.statSync(file).isFile()) return '';
    } catch { return ''; }
    return file;
  }
  function serveAsset(req, res, url) {
    if (url.pathname.startsWith('/avatars/')) {
      const name = path.basename(url.pathname);
      if (!/^[a-z0-9-]+\.png$/.test(name)) return send(res, 404, { error: 'Not found.' });
      const payload = renderOrbPng(name.slice(0, -4), 256);
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'image/png', 'content-length': payload.length, 'cache-control': 'public, max-age=86400' });
      return res.end(payload);
    }
    if (iconBytes[url.pathname]) {
      const payload = iconBytes[url.pathname];
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'image/png', 'content-length': payload.length, 'cache-control': 'public, max-age=86400' });
      return res.end(payload);
    }
    const novnc = novncFile(url.pathname);
    if (novnc) {
      const payload = fs.readFileSync(novnc);
      const ext = path.extname(novnc);
      const type = ext === '.js' ? 'text/javascript; charset=utf-8' : (TYPES[ext] || 'application/octet-stream');
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': type, 'content-length': payload.length, 'cache-control': 'public, max-age=300' });
      return res.end(payload);
    }
    if (url.pathname === '/desktop' || url.pathname === '/desktop/') {
      const payload = Buffer.from(desktopShell(), 'utf8');
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'text/html; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-cache' });
      return res.end(payload);
    }
    const ui = uiFile(url.pathname);
    if (ui) {
      const payload = fs.readFileSync(ui);
      const ext = path.extname(ui).toLowerCase();
      const type = ext === '.js' || ext === '.cjs' ? 'text/javascript; charset=utf-8' : (ext === '.woff2' ? 'font/woff2' : (TYPES[ext] || 'application/octet-stream'));
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': type, 'content-length': payload.length, 'cache-control': 'no-cache' });
      return res.end(payload);
    }
    if (url.pathname === '/bops.js' || url.pathname === '/transcript.js') {
      const file = path.join(__dirname, '../../desktop/src/intelio', url.pathname === '/transcript.js' ? 'transcript.cjs' : 'bops.cjs');
      const payload = fs.readFileSync(file);
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'text/javascript; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-cache' });
      return res.end(payload);
    }
    if (STATIC[url.pathname]) {
      const name = STATIC[url.pathname];
      const file = path.join(PUBLIC, name);
      const payload = fs.readFileSync(file);
      const ext = path.extname(name);
      const fresh = name === 'sw.js' || name === 'desktop-boot.js' || name === 'desktop-transport.js';
      res.writeHead(200, { ...cookieHeaders(res), 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': payload.length, 'cache-control': fresh ? 'no-cache' : 'public, max-age=300' });
      return res.end(payload);
    }
    return send(res, 404, { error: 'Not found.' });
  }
  function upstreamHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP.has(String(key).toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = vncUrl.host;
    return headers;
  }
  function proxyBrowser(req, res, pathname) {
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const lib = vncUrl.protocol === 'https:' ? https : http;
    const preq = lib.request({
      hostname: vncUrl.hostname,
      port: vncUrl.port || (vncUrl.protocol === 'https:' ? 443 : 80),
      path: `${pathname || '/'}${search}`,
      method: req.method,
      headers: upstreamHeaders(req),
    }, (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => {
      if (!res.headersSent) send(res, 502, { error: 'The shared browser is not connected.' });
    });
    if (req.method === 'GET' || req.method === 'HEAD') preq.end();
    else req.pipe(preq);
  }
  async function browserAllowed(req, res) {
    const bearer = presentedBearer(req);
    if (bearer.present) {
      let profileId = profileName;
      try { profileId = chosenProfile(req, {}); } catch { profileId = profileName; }
      if (!keyEquals(bearer.token, profileId)) return { ok: false, status: 401 };
      return { ok: true };
    }
    return acceptAccess(req, res);
  }
  async function browserDomain(profileId) {
    if (sample) return '';
    let origin = '';
    try { origin = resolveCdpUrl({ profile: profileId, root: vaultRootPath }); } catch { return ''; }
    try {
      const response = await Promise.race([
        fetchImpl(`${origin}/json/list`, { redirect: 'error' }),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('vnc')), 3000); }),
      ]);
      if (!response || !response.ok) return '';
      const rows = await response.json();
      const page = (Array.isArray(rows) ? rows : []).find((row) => row && row.type === 'page' && /^https?:/i.test(String(row.url || '')));
      if (!page) return '';
      return new URL(page.url).hostname.replace(/^www\./, '').slice(0, 253);
    } catch {
      return '';
    }
  }
  async function browserHosts(profileId, timeoutMs = 3000) {
    if (sample) return [];
    let origin = '';
    try { origin = resolveCdpUrl({ profile: profileId, root: vaultRootPath }); } catch { return []; }
    let timer;
    try {
      const response = await Promise.race([
        fetchImpl(`${origin}/json/list`, { redirect: 'error', signal: timeoutSignal(timeoutMs) }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cdp')), timeoutMs); }),
      ]);
      if (!response || !response.ok) return [];
      const rows = await response.json();
      const hosts = [];
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (!row || row.type !== 'page' || !/^https?:/i.test(String(row.url || ''))) continue;
        try {
          const host = new URL(row.url).hostname.replace(/^www\./, '').slice(0, 253);
          if (host && !hosts.includes(host)) hosts.push(host);
        } catch { /* skip a bad tab url */ }
      }
      return hosts.slice(0, 4);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
  // Screens are a snapshot: probe every agent's browser in parallel (capped per agent),
  // keep the result for screensTtlMs, and when it is stale give a refresh a short
  // head start before answering with the last snapshot.
  function refreshScreens() {
    if (screenCache.pending) return screenCache.pending;
    const pending = (async () => {
      const profiles = (await loadProfiles()).filter((profile) => profile && profile.id && !excludedAgent(profile.id));
      const hostLists = await Promise.all(profiles.map((profile) => browserHosts(profile.id, probeTimeoutMs)));
      const rows = [];
      profiles.forEach((profile, at) => {
        hostLists[at].forEach((host, index) => {
          rows.push({ profileId: profile.id, name: displayName(profile.id), host, screen: index + 1 });
        });
      });
      screenCache.rows = rows.slice(0, 12);
      screenCache.at = now();
      return screenCache.rows;
    })().catch(() => screenCache.rows || []).finally(() => {
      if (screenCache.pending === pending) screenCache.pending = null;
    });
    screenCache.pending = pending;
    return pending;
  }
  async function listScreens() {
    if (sample) return [{ profileId: 'intelio', name: 'intelio', host: 'google.com', screen: 1 }];
    if (screenCache.rows && now() - screenCache.at < screensTtlMs) return screenCache.rows;
    if (screenCache.rows) return withTimeout(refreshScreens(), Math.min(500, probeTimeoutMs), screenCache.rows);
    return refreshScreens();
  }
  async function placeOwnerCall() {
    const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
    const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
    const from = String(process.env.TWILIO_FROM || '').trim();
    if (!sid || !token || !from) return false;
    const voice = `${String(process.env.PHONE_PUBLIC_BASE || 'https://2-24-110-12.sslip.io/twilio').replace(/\/$/, '')}/voice`;
    const payload = new URLSearchParams({ To: '+19188991650', From: from, Url: voice });
    try {
      const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: payload,
        redirect: 'error',
      });
      return Boolean(response && response.ok);
    } catch {
      return false;
    }
  }
  function cardFromFiles(id, files, jobs) {
    return buildCard({
      id,
      configText: files.configText,
      userText: files.userText,
      memoryText: files.memoryText,
      paused: files.paused,
      computer: files.computer,
      jobs: jobs.list,
      needsSignIn: files.needsSignIn,
      gatewayNote: files.gatewayNote,
      title: files.title,
      color: files.color,
      orb: files.orb,
      soul: files.soul,
      displayName: files.displayName,
      emailOverride: files.email,
      mobileOverride: files.mobile,
      emailSet: files.emailSet,
      mobileSet: files.mobileSet,
    });
  }
  const liveSockets = new Set();
  function watchSocket(socket) {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
  }
  // intelio node: a signed-in computer dials in here. Same human checks as the
  // rest of the app: Access JWT on the Access listener (no profile bearer keys),
  // allowed Tailscale login on the tailnet listener. Device secret is checked by the hub.
  const nodeRelay = nodes ? createNodesRelay({ log, ...nodes }) : null;
  const computersExtra = null; // stage 2 adds the cloud terminal routes here
  async function acceptNode(req, socket, head, accessListener) {
    if (!nodeRelay) { refuseUpgrade(socket, 404); return; }
    const res = { writeHead() {}, end() {}, setHeader() {} };
    let login = '';
    if (accessListener) {
      const ident = await acceptAccess(req, res);
      if (!ident.ok) { log('intelio-nodes denied access'); refuseUpgrade(socket, ident.status === 403 ? 403 : 401); return; }
      login = ident.session.login;
    } else {
      const session = await authorize(req, res);
      if (!session || session.sample) { refuseUpgrade(socket, 401); return; }
      login = session.login;
    }
    if (socket.destroyed) return;
    nodeRelay.hub.accept(req, socket, head, { login });
  }
  async function onUpgrade(req, socket, head, accessListener) {
    watchSocket(socket);
    req.accessListener = accessListener;
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/node/connect') { await acceptNode(req, socket, head, accessListener); return; }
      if (!url.pathname.startsWith('/browser/')) { socket.destroy(); return; }
      const allowed = accessListener ? await browserAllowed(req, { writeHead() {}, end() {} }) : await authorize(req, { writeHead() {}, end() {} });
      const ok = accessListener ? allowed.ok : Boolean(allowed);
      if (!ok) {
        const status = accessListener && allowed.status === 403 ? 403 : 401;
        socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      await bridgeVnc({ req, socket, head, upstream: vncUrl, password: vncSecret });
    } catch {
      log('intelio-pwa vnc upstream failed');
      if (!socket.destroyed) {
        try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* already closed */ }
      }
    }
  }
  async function optionalList(profileId, pathname, normalize, timeoutMs = 0) {
    try {
      const request = fetchImpl(hermesUrl(profileId, pathname), {
        headers: { Authorization: `Bearer ${bearerKey(profileId)}`, Accept: 'application/json' },
        redirect: 'error',
        signal: timeoutSignal(timeoutMs),
      });
      const response = timeoutMs ? await withTimeout(request, timeoutMs + 100, null) : await request;
      if (!response) return { ok: false, list: [] };
      const text = await response.text();
      if (!response.ok) return { ok: false, list: [], status: response.status };
      let json = [];
      try { json = JSON.parse(text); } catch { json = []; }
      return { ok: true, list: normalize(json), status: response.status };
    } catch {
      return { ok: false, list: [] };
    }
  }

  /** Polls the new profile's own route with its own key until Hermes answers. */
  async function agentReady(id) {
    let reason = 'no reply';
    const tries = Math.max(1, Number(readyTries) || 1);
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, readyDelayMs));
      let key = '';
      try { key = bearerKey(id); } catch { reason = 'no key'; continue; }
      try {
        const response = await fetchImpl(hermesUrl(id, '/v1/capabilities'), {
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
          redirect: 'error',
          signal: timeoutSignal(4000),
        });
        if (typeof response.text === 'function') await response.text().catch(() => '');
        if (response.ok) return { ok: true, reason: '' };
        reason = `HTTP ${response.status}`;
        if (response.status === 401) cachedKeys.delete(id);
      } catch {
        reason = 'unreachable';
      }
    }
    return { ok: false, reason };
  }

  // Skills per profile, cached. Only real answers are cached: a timeout or a dropped
  // connection says nothing about the route, so the next call asks again.
  async function cachedSkills(profileId, timeoutMs = 0) {
    const hit = skillsCache.get(profileId);
    if (hit) {
      const ttl = hit.result.ok ? skillsTtlMs : skillsErrorTtlMs;
      if (now() - hit.at < ttl) return hit.result;
      skillsCache.delete(profileId);
    }
    const result = await optionalList(profileId, '/v1/skills', normalizeSkills, timeoutMs);
    if (result.status) skillsCache.set(profileId, { at: now(), result });
    return result;
  }

  /** Every listed profile's key (and the VNC secret), so an agent created after the first sign-in gets its key too. */
  async function bootstrapBody() {
    const body = { vnc: vncSecret };
    const names = ['intelio', 'prc', 'alignment', 'hhp'];
    let listed = [];
    try { listed = await loadProfiles(); } catch { listed = []; }
    for (const row of Array.isArray(listed) ? listed : []) {
      const id = String(row?.id || '');
      if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && id !== 'vnc' && !names.includes(id) && names.length < 64) names.push(id);
    }
    for (const name of names) {
      try { body[name] = bearerKey(name); } catch { body[name] = ''; }
    }
    return body;
  }
  /**
   * The same key bootstrap for a desktop app on the Tailscale route. All three
   * must hold: an allowed Tailscale login (the tailnet session), a profile key
   * this app already has (so only a set-up intelio app can ask), and a peer
   * that is not the VPS itself (agents run there and hold profile keys). No
   * key or secret is ever logged.
   */
  async function tailnetBootstrap(req, res, session) {
    if (!session || session.access || session.keyed || session.sample || !session.login) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Not found.' });
    const ip = normalizeIp(req.socket.remoteAddress);
    if (await peerIsSelf(ip)) {
      log('intelio-pwa denied key bootstrap from this server');
      return send(res, 403, { error: 'Not from this server.' });
    }
    const presented = presentedBearer(req);
    let profileId = '';
    try { profileId = chosenProfile(req, {}); } catch { profileId = ''; }
    if (!presented.present || !profileId || !keyEquals(presented.token, profileId)) {
      log('intelio-pwa denied key bootstrap without a profile key');
      return send(res, 401, { error: 'A saved agent key is needed.' });
    }
    const body = await bootstrapBody();
    log(`intelio-pwa key bootstrap over tailnet login=${session.login} profiles=${Object.keys(body).filter((name) => name !== 'vnc').length}`);
    return send(res, 200, body);
  }
  function hermesDesktopPath(pathname) {
    if (pathname === '/health' || pathname === '/intelio/bootstrap') return true;
    return /^\/p\/[a-z0-9][a-z0-9_-]{0,63}\/(?:api|v1)\//.test(pathname);
  }
  async function proxyDesktopHermes(req, res, url, session) {
    if (url.pathname === '/intelio/bootstrap') {
      if (!session.access) return send(res, 401, { error: 'Sign in again.' });
      return send(res, 200, await bootstrapBody());
    }
    let target;
    let profileId = '';
    let apiPath = '';
    if (url.pathname === '/health') {
      target = new URL(upstreamUrl.toString());
      target.pathname = '/health';
      target.search = '';
    } else {
      const match = url.pathname.match(/^\/p\/([a-z0-9][a-z0-9_-]{0,63})(\/(?:api|v1)\/.*)$/);
      if (!match) return send(res, 404, { error: 'Not found.' });
      profileId = match[1];
      apiPath = match[2];
      const query = {};
      for (const [key, value] of url.searchParams) if (value) query[key] = value;
      target = hermesUrl(profileId, match[2], query);
    }
    const method = req.method || 'GET';
    // PATCH/DELETE only for one session's sidebar metadata (rename, pin, archive, delete).
    const sessionEdit = (method === 'PATCH' || method === 'DELETE') && /^\/api\/sessions\/[A-Za-z0-9_-]{1,80}$/.test(apiPath);
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST' && !sessionEdit) return send(res, 405, { error: 'Not found.' });
    const raw = method === 'POST' || method === 'PATCH' ? await readRaw(req, method === 'PATCH' ? 4096 : 1024 * 1024) : null;
    let key = '';
    if (profileId) {
      try { key = bearerKey(profileId); } catch { return send(res, 401, { error: 'Profile key is not available.' }); }
    }
    const stream = /\/chat\/stream$/.test(url.pathname);
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          Accept: stream ? 'text/event-stream' : 'application/json',
          ...(raw && raw.length ? { 'Content-Type': 'application/json' } : {}),
        },
        body: raw && raw.length ? raw : undefined,
        redirect: 'error',
      });
    } catch {
      return send(res, 502, { error: 'Remote Hermes unreachable.' });
    }
    if (stream && response.body && typeof response.body.getReader === 'function') {
      res.writeHead(response.status, { ...cookieHeaders(res), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      const reader = response.body.getReader();
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        res.write(Buffer.from(step.value));
      }
      return res.end();
    }
    const text = typeof response.text === 'function' ? await response.text() : '';
    const type = response.headers?.get?.('content-type') || 'application/json; charset=utf-8';
    res.writeHead(response.status || 502, { ...cookieHeaders(res), 'content-type': type, 'cache-control': 'no-store' });
    return res.end(text);
  }

  async function handle(req, res) {
    if (!originOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/session') {
        await readRaw(req, 4096).catch(() => Buffer.alloc(0));
        return send(res, 405, { error: 'Sign-in uses Tailscale identity.' });
      }
      if (url.pathname.startsWith('/api/vault/')) {
        await refreshVaultProfiles();
        const needsBody = req.method === 'POST' || req.method === 'DELETE';
        const body = needsBody ? await readBody(req, 8192) : {};
        const profileId = chosenProfile(req, body);
        const bearer = presentedBearer(req);
        if (bearer.present) {
          if (!keyEquals(bearer.token, profileId)) {
            logVaultDenial(profileId, 'key');
            return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
          }
        } else if (req.accessListener) {
          const access = await acceptAccess(req, res);
          if (!access.ok) return send(res, access.status === 403 ? 403 : 401, { error: access.status === 403 ? 'This account is not allowed.' : 'This Tailscale identity is not allowed.' });
        } else if (await peerIsSelf(normalizeIp(req.socket.remoteAddress))) {
          logVaultDenial(profileId, 'local');
          return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
        } else {
          const session = await authorize(req, res);
          if (!session) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
        }
        if (req.method === 'POST' && url.pathname === '/api/vault/login') {
          try {
            let saved = false;
            if (body.save === true) {
              vault.saveLogin(profileId, {
                domain: body.domain,
                username: body.username,
                password: body.password,
                otp: body.otp,
                selectors: body.selectors,
              });
              saved = true;
            }
            const filled = await runFiller(profileId, body);
            const pub = publicVault(filled, { saved, domain: body.domain || filled.domain || '' });
            const prompt = loginWatch.resolved(profileId, body.promptId, { ...pub, username: body.username, fields: filled?.fields });
            return send(res, 200, prompt ? { ...pub, prompt } : pub);
          } catch {
            return send(res, 400, { ok: false, filled: false, error: 'Could not save that login.' });
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/vault/logins') {
          // Every agent's list is for the signed-in person; a profile key sees its own.
          if (url.searchParams.get('all') === '1' && !bearer.present) return send(res, 200, { ok: true, logins: vault.listAll() });
          return send(res, 200, { ok: true, logins: vault.list(profileId) });
        }
        if (req.method === 'GET' && url.pathname === '/api/vault/prompts') {
          await loginWatch.refresh(profileId);
          return send(res, 200, { ok: true, prompts: loginWatch.list(profileId) });
        }
        if (req.method === 'POST' && url.pathname === '/api/vault/prompt') {
          return send(res, 200, await loginWatch.request(profileId, { site: body.site, reason: body.reason, wait: body.wait }));
        }
        if (req.method === 'POST' && url.pathname === '/api/vault/dismiss') {
          return send(res, 200, { ok: loginWatch.dismiss(profileId, body.promptId) });
        }
        if (req.method === 'DELETE' && url.pathname === '/api/vault/logins') {
          return send(res, 200, { ok: true, logins: vault.remove(profileId, body.domain) });
        }
        if (req.method === 'POST' && url.pathname === '/api/vault/fill') {
          const hit = vault.fillerPayload(profileId, body.site);
          if (!hit) return send(res, 200, { ok: false, filled: false });
          const filled = await runFiller(profileId, { ...body, domain: hit.domain, selectors: body.selectors || hit.selectors }, hit);
          const pub = publicVault(filled, { domain: hit.domain, username: hit.username || '' });
          return send(res, 200, pub);
        }
        return send(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' && req.accessListener && publicAsset(url.pathname)) return serveAsset(req, res, url);
      if (req.accessListener && url.pathname.startsWith('/browser')) {
        const browserAuth = await browserAllowed(req, res);
        if (!browserAuth.ok) return send(res, browserAuth.status === 403 ? 403 : 401, { error: browserAuth.status === 403 ? 'This account is not allowed.' : 'This Tailscale identity is not allowed.' });
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Not found.' });
        return proxyBrowser(req, res, url.pathname.replace(/^\/browser/, '') || '/');
      }
      if (req.accessListener) {
        const keyed = presentedBearer(req);
        if (keyed.present) {
          const pathProfile = /^\/p\/([a-z0-9][a-z0-9_-]{0,63})\//.exec(url.pathname)?.[1];
          let profileId = profileName;
          try { profileId = pathProfile || chosenProfile(req, {}); } catch { profileId = profileName; }
          if (!keyEquals(keyed.token, profileId)) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
        } else {
          const access = await acceptAccess(req, res);
          if (!access.ok) return send(res, access.status === 403 ? 403 : 401, { error: access.status === 403 ? 'This account is not allowed.' : 'This Tailscale identity is not allowed.' });
        }
      }
      let session = sessionFrom(req);
      const keyedOk = Boolean(req.accessListener && presentedBearer(req).present);
      if (!session && !keyedOk) session = await authorize(req, res);
      if (!session && keyedOk) {
        session = { login: '', exp: now() + SESSION_MS, keyed: true };
        authFor.set(req, session);
      }
      if (!session) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
      if (req.accessListener && hermesDesktopPath(url.pathname)) return await proxyDesktopHermes(req, res, url, session);
      if (!req.accessListener && url.pathname === '/intelio/bootstrap') return await tailnetBootstrap(req, res, session);
      if (req.method === 'GET' && (url.pathname === '/session' || url.pathname === '/session/')) {
        return send(res, 200, { ok: true, login: session.login || '' });
      }
      if (req.method === 'DELETE' && url.pathname === '/session') {
        const token = readCookie(req.headers.cookie, 'intelio_session');
        if (token) sessions.delete(token);
        authFor.delete(req);
        return send(res, 200, { ok: true }, { 'set-cookie': 'intelio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      // intelio computers: the person's Computers list, kill switches and activity log (nodes-human.cjs).
      if (url.pathname.startsWith('/api/computers')) {
        const handled = await handleComputersApi({ req, res, url, session, relay: nodeRelay, send, readBody, mutationOk, peerIsSelf, normalizeIp, log, extra: computersExtra });
        if (handled !== false) return undefined;
      }
      if (req.method === 'GET' && url.pathname === '/api/browser/site') {
        return send(res, 200, { domain: await browserDomain(chosenProfile(req)) });
      }
      if (url.pathname === '/api/accounts' || url.pathname.startsWith('/api/accounts/') || url.pathname === '/api/activity') {
        return await accountsApi.handle(req, res, url, { send, readBody, chosenProfile, presentedBearer, mutationOk });
      }
      if (url.pathname === '/api/agent/card' || url.pathname === '/api/agent/thinking' || url.pathname === '/api/agent/pause') {
        const writing = req.method === 'POST';
        if (writing && !presentedBearer(req).present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = writing ? await readBody(req, 4096) : {};
        const id = harnessId(chosenProfile(req, body));
        if (!id) return send(res, 404, { error: 'Unknown agent.' });
        if (writing && url.pathname === '/api/agent/thinking') writeReasoning(vaultRootPath, id, String(body.effort || '').toLowerCase());
        if (writing && url.pathname === '/api/agent/pause') writePaused(vaultRootPath, id, body.paused !== false);
        const files = readProfileFiles(vaultRootPath, id);
        const jobs = sample ? { list: [] } : await optionalList(id, '/api/jobs', normalizeJobs);
        return send(res, 200, cardFromFiles(id, files, jobs));
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/profile') {
        if (!presentedBearer(req).present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readBody(req, 24000);
        const id = harnessId(chosenProfile(req, body));
        if (!id || excludedAgent(id)) return send(res, 404, { error: 'Unknown agent.' });
        const hasProfile = fs.existsSync(path.join(vaultRootPath, id, 'config.yaml'));
        if (!hasProfile) {
          if (!sample) return send(res, 404, { error: 'That agent was not found.' });
          const color = body.color == null ? '' : cleanColor(body.color);
          if (body.color != null && !color) return send(res, 400, { error: 'Choose a palette color or another hex value.' });
          return send(res, 200, buildCard({
            id,
            name: body.name || id,
            title: body.title || '',
            color,
            orb: body.orb || '',
            soul: body.soul || '',
            displayName: body.name || '',
            emailOverride: body.email || '',
            mobileOverride: body.mobile || '',
            emailSet: body.email != null,
            mobileSet: body.mobile != null,
            computer: { status: 'stopped' },
          }));
        }
        const saved = writeProfile(vaultRootPath, id, body);
        if (!saved.ok) return send(res, 400, { error: saved.error || 'Could not save that.' });
        const files = readProfileFiles(vaultRootPath, id);
        const jobs = sample ? { list: [] } : await optionalList(id, '/api/jobs', normalizeJobs);
        return send(res, 200, cardFromFiles(id, files, jobs));
      }
      if (req.method === 'GET' && url.pathname === '/api/screens') {
        return send(res, 200, { data: await listScreens() });
      }
      if (req.method === 'GET' && url.pathname === '/api/home') {
        if (sample) return send(res, 200, SAMPLE_HOME);
        await withTimeout(learnFeatures(), probeTimeoutMs, null);
        const home = await realHome();
        const primary = home.profiles[0]?.id || profileName;
        // /v1/skills can 500 on the gateway; skills are then left out (skillsOk false) and the
        // failure is remembered for skillsErrorTtlMs so polling /api/home does not hammer it.
        const [skills, jobs] = await Promise.all([
          cachedSkills(primary, probeTimeoutMs),
          optionalList(primary, '/api/jobs', normalizeJobs, probeTimeoutMs),
        ]);
        home.skills = skills.list;
        home.jobs = jobs.list;
        home.skillsOk = skills.ok;
        home.jobsOk = jobs.ok;
        return send(res, 200, home);
      }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        if (sample) return send(res, 200, { data: SAMPLE_HOME.skills, sample: true, label: 'SAMPLE DATA' });
        const skills = await cachedSkills(chosenProfile(req));
        if (!skills.ok) return send(res, 404, { error: 'This Hermes has no skills list.' });
        return send(res, 200, { data: skills.list });
      }
      if (req.method === 'POST' && (url.pathname === '/api/skills/preview' || url.pathname === '/api/skills/install')) {
        // Paste-a-link skill install. Preview only downloads into memory; install writes the
        // previewed files into one profile's skills folder (skills-install.cjs). Never runs them.
        const bearer = presentedBearer(req);
        if (!bearer.present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        let body;
        try { body = await readBody(req, 4096); } catch { return send(res, 400, { error: 'Send JSON.' }); }
        if (sample) return send(res, 400, { error: 'Skill install is off in sample mode.', sample: true, label: 'SAMPLE DATA' });
        try {
          if (url.pathname === '/api/skills/preview') {
            const profiles = (Array.isArray(body.profiles) ? body.profiles : [body.profile]).map((id) => String(id || '').trim().toLowerCase()).filter(Boolean).slice(0, 12);
            // Preview writes nothing: the key only has to belong to the profile asking (x-intelio-profile).
            if (bearer.present && !keyEquals(bearer.token, chosenProfile(req, {}))) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
            return send(res, 200, await skillInstaller.preview({ url: String(body.url || ''), profiles, category: String(body.category || '') }));
          }
          const id = String(body.profile || '').trim().toLowerCase();
          if (!id || excludedAgent(id)) return send(res, 404, { error: 'Unknown agent.' });
          if (bearer.present && !keyEquals(bearer.token, id)) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
          const result = await skillInstaller.install({ token: String(body.token || ''), profile: id, overwrite: body.overwrite === true });
          log(`intelio skill install: ${result.skill} -> ${id}`);
          return send(res, 200, result);
        } catch (error) {
          const status = Number(error?.status) || 500;
          return send(res, status >= 400 && status < 600 ? status : 500, { error: status === 500 ? 'Could not install that skill.' : String(error.message || 'Could not install that skill.').slice(0, 300) });
        }
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
          if (excludedAgent(slug)) return send(res, 400, { error: 'That name is reserved.' });
          const summary = String(body.description || body.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
          return send(res, 200, {
            id: slug,
            name: displayName(slug),
            description: summary,
            title: String(body.title || '').slice(0, 80),
            orb: String(body.orb || ''),
            needsSignIn: false,
            signInNote: '',
            gatewayNote: '',
            ready: true,
            needsGatewayRestart: false,
            sample: true,
            label: 'SAMPLE DATA',
          });
        }
        const created = profileOps && profileOps.create
          ? await profileOps.create(body)
          : await createProfile({
            name: body.name,
            description: body.description || body.title || '',
            title: body.title || body.role || '',
            soul: body.soul || body.instructions || '',
            orb: body.orb || '',
            color: body.color || '',
            home: profileHome,
            run: profileRun,
          });
        forgetProfiles();
        const ready = await agentReady(created.id);
        if (!ready.ok) log(`intelio-pwa new agent ${created.id} not answering yet (${ready.reason})`);
        return send(res, 200, {
          id: created.id,
          name: created.name,
          description: created.description || '',
          title: created.title || '',
          orb: created.orb || '',
          needsSignIn: created.needsSignIn === true,
          signInNote: created.signInNote || '',
          ready: ready.ok,
          gatewayNote: ready.ok ? (created.gatewayNote || '') : `${created.name || created.id} was created, but Hermes is not answering for it yet (${ready.reason}). Try it again in a minute.`,
          needsGatewayRestart: false,
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
      if (req.method === 'POST' && url.pathname === '/api/phone/call') {
        if (!presentedBearer(req).present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readBody(req, 2048);
        const id = harnessId(chosenProfile(req, body));
        if (!id || excludedAgent(id)) return send(res, 404, { error: 'Unknown agent.' });
        const files = readProfileFiles(vaultRootPath, id);
        const card = files ? cardFromFiles(id, files, { list: [] }) : buildCard({ id, computer: { status: 'stopped' } });
        if (!card || card.phoneSoon) return send(res, 200, { ready: false });
        const placed = await placeOwnerCall();
        return send(res, 200, { ready: placed === true });
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
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const state = modelState(chosenProfile(req, {}));
        if (!state.id) return send(res, 404, { error: 'Unknown agent.' });
        if (!sample && state.keyless) await learnFeatures();
        const groups = state.keyless && !sample ? await catalogFor(state.id, state.current) : [];
        const sessionId = url.searchParams.get('session') || '';
        const thread = !sample && state.keyless ? await threadModel(state.id, sessionId) : '';
        return send(res, 200, {
          provider: state.keyless ? picker.canonicalProvider(state.current.provider) : '',
          model: thread || state.current.model || '',
          profileModel: state.current.model || '',
          effort: state.effort,
          efforts: picker.EFFORTS,
          groups,
          keyless: state.keyless,
          sessionModelLock: Boolean(sessionModelLock),
          restartRequired: false,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/model') {
        if (!presentedBearer(req).present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readBody(req, 4096);
        const gated = chosenProfile(req, {});
        const asked = chosenProfile(req, body);
        if (gated !== asked) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
        const state = modelState(asked);
        if (!state.id || !state.files) return send(res, 404, { error: 'That agent was not found.' });
        const provider = picker.canonicalProvider(body.provider || state.current.provider);
        const model = String(body.model || '').trim();
        const groups = sample ? [] : await catalogFor(state.id, state.current);
        if (!modelAllowed(state, provider, model, groups)) return send(res, 400, { error: 'That model is not available.' });
        const file = path.join(vaultRootPath, state.id, 'config.yaml');
        const next = picker.applyModelDefault(state.files.configText, model, provider);
        if (next == null) return send(res, 400, { error: 'That model cannot be saved.' });
        backupFile(file, fs);
        fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
        return send(res, 200, {
          ok: true,
          model,
          provider,
          restartRequired: false,
          note: picker.defaultNote(displayName(state.id)),
        });
      }
      const sessionModelRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/);
      if (req.method === 'POST' && sessionModelRoute && ID_RE.test(sessionModelRoute[1])) {
        if (!presentedBearer(req).present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readBody(req, 4096);
        const gated = chosenProfile(req, {});
        const asked = chosenProfile(req, body);
        if (gated !== asked) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
        const state = modelState(asked);
        if (!state.id) return send(res, 404, { error: 'Unknown agent.' });
        const provider = picker.canonicalProvider(body.provider || state.current.provider);
        const model = String(body.model || '').trim();
        const effort = picker.EFFORTS.includes(String(body.effort || '').toLowerCase()) ? String(body.effort).toLowerCase() : 'auto';
        const groups = sample ? [] : await catalogFor(state.id, state.current);
        if (!modelAllowed(state, provider, model, groups)) return send(res, 400, { error: 'That model is not available.' });
        if (!sample) await learnFeatures();
        let applied = 'request';
        if (!sample) {
          try {
            const locked = await hermesJson(state.id, `/api/sessions/${sessionModelRoute[1]}/model`, {
              method: 'POST',
              body: picker.sessionSwitchBody(provider, model, effort),
            });
            if (locked.status === 404 || locked.status === 405) applied = 'request';
            else if (locked.status >= 200 && locked.status < 300) applied = 'session';
            else return send(res, 502, { error: 'Could not switch the model for this thread.' });
          } catch {
            applied = 'request';
          }
        }
        return send(res, 200, { ok: true, applied, model, provider, effort, restartRequired: false });
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
      const one = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if ((req.method === 'PATCH' || req.method === 'DELETE') && one && ID_RE.test(one[1])) {
        if (!mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        if (sample) return send(res, 200, { ok: true, sample: true, label: 'SAMPLE DATA' });
        if (req.method === 'DELETE') return await forward(req, res, `/api/sessions/${one[1]}`, { method: 'DELETE', profileId: chosenProfile(req) });
        const body = await readBody(req, 4096);
        // Only the sidebar fields the Sessions tab edits: rename, pin, archive.
        const fields = {};
        if (typeof body.title === 'string' && body.title.trim()) fields.title = body.title.trim().slice(0, 200);
        for (const flag of ['pinned', 'archived']) if (typeof body[flag] === 'boolean') fields[flag] = body[flag];
        if (!Object.keys(fields).length) return send(res, 400, { error: 'Nothing to change.' });
        return await forward(req, res, `/api/sessions/${one[1]}`, { method: 'PATCH', body: fields, profileId: chosenProfile(req) });
      }
      // Inline approval prompt (desktop/src/intelio/approval-ui.cjs): Hayden answers an
      // approval.request from the chat stream. Only "once" or "deny"; never remembered.
      const runApproval = url.pathname.match(/^\/api\/runs\/(run_[A-Za-z0-9]{1,64})\/approval$/);
      if (req.method === 'POST' && runApproval) {
        if (!mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
        const body = await readBody(req, 4096);
        if (sample) return send(res, 200, { ok: true, sample: true, label: 'SAMPLE DATA' });
        const requestId = typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(body.request_id) ? body.request_id : '';
        return await forward(req, res, `/v1/runs/${runApproval[1]}/approval`, {
          method: 'POST',
          body: { choice: body.choice === 'once' ? 'once' : 'deny', ...(requestId ? { request_id: requestId } : {}) },
          profileId: chosenProfile(req, body),
        });
      }
      if (req.method === 'POST' && chat && ID_RE.test(chat[1])) {
        const body = await readBody(req, 200000);
        if (sample && messagesLookSample(chat[1])) {
          if (!sessionFrom(req)) return send(res, 401, { error: 'Sign in again.' });
          res.writeHead(200, { ...cookieHeaders(res), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
          res.end('event: assistant.delta\ndata: {"delta":"SAMPLE DATA reply."}\n\n');
          return;
        }
        const agent = chosenProfile(req, body);
        const state = modelState(agent);
        const groups = !sample && body.model ? await catalogFor(agent, state.current) : [];
        const extra = picker.chatFields({
          ...body,
          profileModel: state.current.model,
          profileProvider: state.current.provider,
        }, groups);
        return await forward(req, res, `/api/sessions/${chat[1]}/chat/stream`, {
          method: 'POST',
          body: { input: String(body.input || '').slice(0, 100000), ...extra },
          stream: true,
          profileId: agent,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await readBody(req, 4096);
        if (sample) {
          if (!sessionFrom(req)) return send(res, 401, { error: 'Sign in again.' });
          return send(res, 200, { id: 'sample-lamp', title: String(body.title || 'intelio').slice(0, 200), profileId: body.profile || 'intelio', sample: true, label: 'SAMPLE DATA' });
        }
        return await forward(req, res, '/api/sessions', { method: 'POST', body: { title: String(body.title || '').slice(0, 200) }, profileId: chosenProfile(req, body) });
      }
      if (req.method === 'GET' && (publicAsset(url.pathname) || url.pathname.startsWith('/browser'))) {
        if (url.pathname.startsWith('/browser')) {
          if (!sessionFrom(req)) return send(res, 401, { error: 'This Tailscale identity is not allowed.' });
          return proxyBrowser(req, res, url.pathname.replace(/^\/browser/, '') || '/');
        }
        return serveAsset(req, res, url);
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      const code = Number(error?.status) || 400;
      return send(res, code >= 400 && code < 600 ? code : 400, { error: String(error?.message || 'Bad request').slice(0, 200) });
    }
  }

  let server;
  let localServer = null;
  const tailnetHandle = (req, res) => { req.accessListener = false; return handle(req, res); };
  if (certPath || keyPath) {
    if (!certPath || !keyPath) throw new Error('Set both INTELIO_PWA_CERT and INTELIO_PWA_KEY, or neither.');
    server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, tailnetHandle);
  } else server = http.createServer(tailnetHandle);
  server.on('upgrade', (req, socket, head) => { onUpgrade(req, socket, head, false); });
  if (accessMode) {
    localServer = http.createServer((req, res) => { req.accessListener = true; return handle(req, res); });
    localServer.on('upgrade', (req, socket, head) => { onUpgrade(req, socket, head, true); });
  }

  function close(done) {
    const finish = typeof done === 'function' ? done : () => {};
    loginWatch.stop();
    if (nodeRelay) nodeRelay.close();
    for (const socket of [...liveSockets]) {
      try { socket.destroy(); } catch { /* already closed */ }
    }
    let pending = 1 + (localServer ? 1 : 0);
    const step = () => { pending -= 1; if (pending === 0) finish(); };
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(step);
    if (localServer) {
      if (typeof localServer.closeAllConnections === 'function') localServer.closeAllConnections();
      localServer.close(step);
    }
  }

  return {
    server,
    local: localServer,
    sessions,
    nodes: nodeRelay,
    sample: Boolean(sample),
    voice: runtime,
    warmVoice() {
      return runtime.warm ? runtime.warm() : Promise.resolve();
    },
    // Fill the profile and screens caches so the first /api/home after a restart is fast.
    warmLists() {
      if (sample) return Promise.resolve();
      return refreshProfiles().then(() => refreshScreens()).catch(() => {});
    },
    close,
    listen() {
      return new Promise((resolve, reject) => {
        const done = () => {
          if (!nodeRelay) return resolve(server.address());
          nodeRelay.listen().then(() => resolve(server.address()), () => resolve(server.address()));
        };
        const startLocal = () => {
          if (!localServer) return done();
          localServer.once('error', reject);
          localServer.listen(localPort, '127.0.0.1', done);
        };
        server.once('error', reject);
        server.listen(port, bind, startLocal);
        // Background look for sign-in forms in each agent browser, so a saved
        // login is used even with no screen open. Off for injected test fakes.
        const watchMs = loginWatchMs !== undefined ? Number(loginWatchMs) : (filler || cdpImpl || loginScan || sample ? 0 : Number(process.env.INTELIO_LOGIN_WATCH_MS || 6000));
        loginWatch.start(watchMs, profilesWithBrowser);
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
    process.stdout.write(`intelio phone client listening on ${address.address}:${address.port}\n`);
    if (app.local) {
      const local = app.local.address();
      process.stdout.write(`intelio Access listener on ${local.address}:${local.port}\n`);
    }
    app.warmLists();
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
