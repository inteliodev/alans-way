'use strict';
/**
 * Main-process wiring for Remote Hermes (VPS) mode: settings, encrypted key
 * storage, IPC for the chat window, and the window itself. The API key never
 * leaves this process.
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRemoteConfig, createRemoteHermesClient, redactKey, PROFILE_RE, isTailnetOrLoopbackHost, selectFetch } = require('./remote-hermes.cjs');
const { harnessId, buildCard } = require('./agent-card.cjs');
const { vaultOrigin, postProfileVault } = require('./remote-vault.cjs');
const { createRemoteMain } = require('./remote-main-data.cjs');
const { checkTailscale, assertInstallUrl, installUrl } = require('./tailscale.cjs');
const { normalizeConnectionMode, chooseConnection, labelWithMode, allowedSignInUrl, mergeAccessCookies, cloudTargets, CLOUD_PARTITION } = require('./cloud-connection.cjs');

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

/** Import-file name for the VPS desktop password. Not a Hermes profile. */
const VNC_KEY = 'vnc';

function profileNames(keys) {
  return Object.keys(keys || {}).filter((name) => name !== VNC_KEY);
}

/** Several `profile=key` lines. A lone raw line, or `API_SERVER_KEY=`, is the intelio key. `vnc=` is the desktop password. */
function keysFromImport(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const keys = {};
  if (lines.length === 1 && !lines[0].includes('=')) {
    const value = unquote(lines[0]);
    if (value.length >= 16) keys.intelio = value;
    return keys;
  }
  for (const line of lines) {
    const named = line.match(/^(?:export\s+)?([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!named) continue;
    const value = unquote(named[2]);
    if (/^vnc$/i.test(named[1])) {
      if (value.length >= 1 && value.length <= 256) keys[VNC_KEY] = value;
      continue;
    }
    if (value.length < 16) continue;
    if (/^API_SERVER_KEY$/i.test(named[1])) { keys.intelio = value; continue; }
    const profile = named[1].trim().toLowerCase();
    if (!PROFILE_RE.test(profile) || profile === VNC_KEY) continue;
    keys[profile] = value;
  }
  return keys;
}

function keyFromImport(text) {
  return keysFromImport(text).intelio || '';
}

function secureDelete(file, fsImpl = fs) {
  const st = fsImpl.statSync(file);
  const fd = fsImpl.openSync(file, 'r+');
  try {
    const zeros = Buffer.alloc(Math.max(st.size, 1));
    fsImpl.writeSync(fd, zeros, 0, zeros.length, 0);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  fsImpl.unlinkSync(file);
}

function importRemoteHermesKey({ file, profile, safeStorage, readKeys, writeKeys, fsImpl = fs }) {
  if (!fsImpl.existsSync(file)) return { imported: false };
  const st = fsImpl.statSync(file);
  if (st.size > 16384) {
    secureDelete(file, fsImpl);
    return { imported: false, refused: true };
  }
  const parsed = keysFromImport(fsImpl.readFileSync(file, 'utf8'));
  const names = profileNames(parsed);
  if (!names.length && !parsed[VNC_KEY]) {
    secureDelete(file, fsImpl);
    return { imported: false, refused: true };
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return { imported: false, unavailable: true };
  const keys = readKeys();
  for (const name of Object.keys(parsed)) keys[name] = safeStorage.encryptString(parsed[name]).toString('base64');
  writeKeys(keys);
  secureDelete(file, fsImpl);
  return { imported: true, profiles: names, vnc: Boolean(parsed[VNC_KEY]), notice: 'Connected to VPS Hermes', profile: profile || names[0] };
}

function secretsFromBootstrap(body) {
  const parsed = {};
  if (!body || typeof body !== 'object') return parsed;
  for (const name of ['intelio', 'prc', 'alignment', 'hhp']) {
    const value = String(body[name] || '').trim();
    if (value.length >= 16 && value.length <= 4096) parsed[name] = value;
  }
  const vnc = String(body.vnc || '').trim();
  if (vnc.length >= 1 && vnc.length <= 256) parsed[VNC_KEY] = vnc;
  return parsed;
}

/**
 * Only requests to the intelio cloud origin (its https and wss URLs) read the
 * session's cookies. Every other request in the cloud partition passes through
 * untouched, so the hook does not do a cookie-store read per request.
 */
function cloudCookieFilter(origin) {
  let url;
  try { url = new URL(origin); } catch { return null; }
  const socket = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // Match patterns ignore ports; the handler compares the full origin.
  return { origin: url.origin, urls: [`${url.protocol}//${url.hostname}/*`, `${socket}//${url.hostname}/*`] };
}

function attachCloudSessionCookies(ses, origin = cloudTargets().origin) {
  if (!ses || ses.__intelioAccessCookie || !ses.webRequest || typeof ses.webRequest.onBeforeSendHeaders !== 'function') return;
  const filter = cloudCookieFilter(origin);
  if (!filter) return;
  ses.__intelioAccessCookie = true;
  ses.webRequest.onBeforeSendHeaders({ urls: filter.urls }, (details, callback) => {
    const finish = (requestHeaders) => { try { callback({ requestHeaders }); } catch { /* the request already moved on */ } };
    const headers = { ...(details?.requestHeaders || {}) };
    let pageUrl = '';
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      pageUrl = parsed.origin;
    } catch {
      finish(headers);
      return;
    }
    if (pageUrl !== filter.origin) {
      finish(headers);
      return;
    }
    const read = ses.cookies && typeof ses.cookies.get === 'function' ? ses.cookies.get({ url: pageUrl }) : Promise.resolve([]);
    Promise.resolve(read).then((cookies) => {
      const current = headers.Cookie || headers.cookie || '';
      const next = mergeAccessCookies(current, cookies);
      if (next && next !== current) {
        headers.Cookie = next;
        delete headers.cookie;
      }
      finish(headers);
    }).catch(() => finish(headers));
  });
}

function setupRemoteHermes({ app, BrowserWindow, ipcMain, safeStorage, shell, getPrefs, savePreferences, getMainWindow, root, rendererSandbox, icon, background, session, net }) {
  let chatWindow = null;
  const keyFile = () => path.join(app.getPath('userData'), 'remote-hermes-keys.json');
  const inflight = new Map();

  function readKeys() {
    try { return JSON.parse(fs.readFileSync(keyFile(), 'utf8')) || {}; } catch { return {}; }
  }
  function writeKeys(keys) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(`${keyFile()}.tmp`, JSON.stringify(keys, null, 2), { mode: 0o600 });
    fs.renameSync(`${keyFile()}.tmp`, keyFile());
  }
  async function getKey(profile) {
    if (profile === VNC_KEY) return '';
    const stored = readKeys()[profile || 'default'];
    if (!stored || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { return ''; }
  }
  const sessionFor = (partition) => (session && typeof session.fromPartition === 'function' ? session.fromPartition(partition) : null);
  attachCloudSessionCookies(sessionFor(CLOUD_PARTITION));
  let resolved = null;
  let needsSignIn = false;
  let generation = 0;
  let notify = () => {};
  let signInWindow = null;
  let signInTimer = null;
  let signInOpenedAt = 0;
  let finishingSignIn = false;

  function savedConnection() {
    return normalizeConnectionMode(getPrefs().remoteHermes?.connection);
  }
  async function baseConfig() {
    const prefs = getPrefs();
    return normalizeRemoteConfig(prefs.remoteHermes || {});
  }
  async function config() {
    const base = await baseConfig();
    if (!resolved) await refreshConnection();
    const connection = savedConnection();
    if (resolved?.mode === 'cloud') {
      return { ...base, origin: resolved.origin, partition: resolved.partition || CLOUD_PARTITION, activeMode: 'cloud', connection };
    }
    return { ...base, origin: '', partition: '', activeMode: 'tailscale', connection };
  }
  const client = createRemoteHermesClient({ getConfig: config, getKey, sessionFor, net });
  const mainData = createRemoteMain({ getConfig: config, getKey, keyNames: () => profileNames(readKeys()), sessionFor, net });
  let versionLabel = '';

  async function hasCloudCookie(origin) {
    const ses = sessionFor(CLOUD_PARTITION);
    if (!ses || !origin) return false;
    try {
      const cookies = await ses.cookies.get({ url: origin, name: 'CF_Authorization' });
      return Array.isArray(cookies) && cookies.some((cookie) => cookie && cookie.value);
    } catch {
      return false;
    }
  }

  async function maybeBootstrap(force = false) {
    if (!resolved || resolved.mode !== 'cloud') return;
    if (!force && profileNames(readKeys()).length) return;
    if (!(await hasCloudCookie(resolved.origin))) return;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return;
    const ses = sessionFor(CLOUD_PARTITION);
    if (!ses) return;
    const url = `${resolved.origin}/intelio/bootstrap`;
    const doFetch = (target, init) => ses.fetch(target, init);
    let response;
    try {
      response = await doFetch(url, { redirect: 'manual', headers: { Accept: 'application/json' } });
    } catch {
      process.stderr.write('Intelio Cloud key bootstrap failed.\n');
      return;
    }
    if (!response || !response.ok) return;
    let body;
    try { body = await response.json(); } catch { return; }
    const parsed = secretsFromBootstrap(body);
    if (!profileNames(parsed).length) return;
    const keys = readKeys();
    for (const name of Object.keys(parsed)) keys[name] = safeStorage.encryptString(parsed[name]).toString('base64');
    writeKeys(keys);
  }

  function closeSignInPoll() {
    if (signInTimer) clearInterval(signInTimer);
    signInTimer = null;
  }

  async function finishSignIn() {
    if (finishingSignIn) return;
    finishingSignIn = true;
    try {
      needsSignIn = false;
      await maybeBootstrap();
      await publishVersion();
      notify();
    } finally {
      finishingSignIn = false;
    }
  }

  async function openSignIn() {
    if (!BrowserWindow || !resolved || resolved.mode !== 'cloud') return;
    const origin = resolved.origin;
    if (await hasCloudCookie(origin)) {
      needsSignIn = false;
      await maybeBootstrap(true);
      notify();
      return;
    }
    if (signInWindow && !signInWindow.isDestroyed()) {
      signInWindow.show();
      signInWindow.focus();
      return;
    }
    const now = Date.now();
    if (now - signInOpenedAt < 15000) return;
    signInOpenedAt = now;
    const ses = sessionFor(CLOUD_PARTITION);
    if (!ses) return;
    signInWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'Sign in to intelio',
      backgroundColor: background || '#0a0a0a',
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const guard = (event, url) => { if (!allowedSignInUrl(url)) event.preventDefault(); };
    signInWindow.webContents.on('will-navigate', guard);
    signInWindow.webContents.on('will-redirect', guard);
    signInWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedSignInUrl(url) && signInWindow && !signInWindow.isDestroyed()) signInWindow.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    signInWindow.on('closed', () => { closeSignInPoll(); signInWindow = null; });
    signInWindow.loadURL(`${origin}/`).catch(() => {});
    closeSignInPoll();
    let claimed = false;
    const poll = async () => {
      if (claimed || !signInWindow || signInWindow.isDestroyed()) return;
      if (!(await hasCloudCookie(origin))) return;
      if (claimed) return;
      claimed = true;
      closeSignInPoll();
      if (signInWindow && !signInWindow.isDestroyed()) signInWindow.close();
      await finishSignIn();
    };
    signInTimer = setInterval(() => { poll().catch(() => {}); }, 400);
  }

  async function refreshConnection() {
    const gen = ++generation;
    let cfg;
    try { cfg = await baseConfig(); } catch { cfg = { enabled: false, host: '', port: 8642, profile: 'intelio' }; }
    const choice = await chooseConnection({ mode: savedConnection(), host: cfg.host, port: cfg.port, env: process.env });
    if (gen !== generation) return resolved;
    resolved = choice;
    if (choice.mode === 'cloud') {
      needsSignIn = !(await hasCloudCookie(choice.origin));
      if (gen !== generation) return resolved;
      if (!needsSignIn) await maybeBootstrap();
      else openSignIn();
    } else {
      needsSignIn = false;
    }
    return resolved;
  }

  async function publishVersion() {
    if (!resolved) await refreshConnection();
    if (needsSignIn) return;
    let cfg;
    try { cfg = await config(); } catch { return; }
    if (!cfg.enabled || (!cfg.host && !cfg.origin)) return;
    try {
      const health = await client.health();
      const next = labelWithMode(health.label || '', resolved?.mode || cfg.activeMode);
      if (!next || next === versionLabel) return;
      versionLabel = next;
      notify();
    } catch (error) {
      if (error?.code === 'CLOUD_ACCESS') {
        needsSignIn = true;
        versionLabel = '';
        openSignIn();
        notify();
      }
    }
  }

  function watchVersion(onUpdate) {
    notify = typeof onUpdate === 'function' ? onUpdate : () => {};
    const run = () => { publishVersion().catch(() => {}); };
    refreshConnection().then(() => {
      if (needsSignIn) notify();
      else return publishVersion();
    }).catch(() => {});
    const timer = setInterval(run, 60000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  let startupNotice = '';
  try {
    const imported = importRemoteHermesKey({
      file: path.join(app.getPath('userData'), 'remote-hermes-key.import'),
      profile: (() => { try { return normalizeRemoteConfig(getPrefs().remoteHermes || {}).profile || 'default'; } catch { return 'default'; } })(),
      safeStorage,
      readKeys,
      writeKeys,
    });
    if (imported.imported) startupNotice = imported.notice;
  } catch (error) {
    process.stderr.write(`Remote Hermes key import failed: ${String(error?.message || 'error').replace(/\s+/g, ' ').slice(0, 180)}\n`);
  }
  let tailscaleCache = { at: 0, value: null };
  async function tailscaleStatus() {
    if (tailscaleCache.value && Date.now() - tailscaleCache.at < 15000) return tailscaleCache.value;
    const value = await checkTailscale().catch(() => ({ installed: false, connected: false, detail: 'Could not check Tailscale.', installUrl: installUrl() }));
    tailscaleCache = { at: Date.now(), value };
    return value;
  }

  function publicState() {
    let cfg;
    let error = '';
    try { cfg = normalizeRemoteConfig(getPrefs().remoteHermes || {}); } catch (e) { cfg = { ...(getPrefs().remoteHermes || {}) }; error = e.message; }
    const keys = readKeys();
    let encryptionAvailable = false;
    try { encryptionAvailable = safeStorage.isEncryptionAvailable(); } catch (e) { error = error || e.message; }
    return {
      ...cfg,
      connection: savedConnection(),
      activeMode: resolved?.mode || '',
      needsSignIn: Boolean(needsSignIn && resolved?.mode === 'cloud'),
      hasKey: Boolean(keys[cfg.profile || 'default']),
      profilesWithKeys: profileNames(keys),
      hasVncPassword: Boolean(keys[VNC_KEY]),
      encryptionAvailable,
      error,
      versionLabel,
    };
  }

  function viewerUrl() {
    const prefs = getPrefs();
    if (resolved?.mode === 'cloud') return needsSignIn ? '' : (resolved.desktop || '');
    return prefs.remoteUrl || '';
  }

  function trusted(event) {
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    const windows = [chatWindow, mainWindow].filter((item) => item && !item.isDestroyed());
    const ok = windows.some((item) => event.sender === item.webContents && event.senderFrame === event.sender.mainFrame && event.sender.getURL().startsWith('file:'));
    if (!ok) throw new Error('Untrusted Remote Hermes request.');
  }

  /** Settings commands, called from the main window's existing trusted workspace:command handler. */
  async function command(name, value = {}) {
    const prefs = getPrefs();
    switch (name) {
      case 'remote-hermes-state': return { ...publicState(), tailscale: await tailscaleStatus() };
      case 'remote-hermes-config': {
        const connection = normalizeConnectionMode(value.connection ?? prefs.remoteHermes?.connection);
        const next = { ...normalizeRemoteConfig({ ...(prefs.remoteHermes || {}), ...value }), connection };
        prefs.remoteHermes = next;
        savePreferences();
        resolved = null;
        await refreshConnection();
        if (!needsSignIn) await publishVersion();
        else notify();
        return publicState();
      }
      case 'remote-hermes-sign-in': {
        if (!resolved) await refreshConnection();
        needsSignIn = resolved?.mode === 'cloud' ? !(await hasCloudCookie(resolved.origin)) : false;
        if (needsSignIn) openSignIn();
        else if (resolved?.mode === 'cloud') await finishSignIn();
        return publicState();
      }
      case 'remote-hermes-key': {
        const key = String(value.key || '').trim();
        const profile = normalizeRemoteConfig({ ...(prefs.remoteHermes || {}), profile: value.profile ?? prefs.remoteHermes?.profile }).profile || 'default';
        const keys = readKeys();
        if (!key) { delete keys[profile]; writeKeys(keys); return publicState(); }
        if (key.length < 16) throw new Error('That key is too short; Hermes refuses keys under 16 characters.');
        if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable; the key was not saved.');
        keys[profile] = safeStorage.encryptString(key).toString('base64');
        writeKeys(keys);
        return publicState();
      }
      case 'remote-hermes-test': {
        const health = await client.health();
        const caps = await client.capabilities();
        const features = caps?.features || {};
        return { ...publicState(), health, sessionChat: features.session_chat_streaming === true, model: caps?.model || caps?.model_name || '' };
      }
      case 'open-remote-hermes': open(); return publicState();
      case 'remote-hermes-install-tailscale': {
        const status = await tailscaleStatus();
        await shell.openExternal(assertInstallUrl(status.installUrl));
        return { ...publicState(), tailscale: status };
      }
      default: return undefined;
    }
  }

  function pwaBase(cfg) {
    const explicit = String(process.env.INTELIO_PWA_ORIGIN || '').trim().replace(/\/$/, '');
    if (explicit) {
      let url;
      try { url = new URL(explicit); } catch { return ''; }
      const host = url.hostname.toLowerCase();
      const loop = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (host !== 'app.intelio-ai.com' && !loop && !isTailnetOrLoopbackHost(host)) return '';
      return url.origin;
    }
    if (process.env.INTELIO_E2E === '1') return '';
    if (cfg?.origin || cfg?.activeMode === 'cloud') return 'https://app.intelio-ai.com';
    if (!cfg?.host || !isTailnetOrLoopbackHost(cfg.host)) return '';
    const port = Number(process.env.INTELIO_PWA_PORT || 8643);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    const scheme = cfg.host === '127.0.0.1' || cfg.host === 'localhost' || cfg.host === '::1' ? 'http' : 'https';
    return `${scheme}://${host}:${port}`;
  }

  async function pwaRequest(profile, key, pathname, body, { timeoutMs = 1200, expectId = true, query = '' } = {}) {
    let cfg;
    try { cfg = await config(); } catch { return null; }
    const cloud = Boolean(cfg?.origin || cfg?.activeMode === 'cloud');
    if (!key && !cloud) return null;
    const base = pwaBase(cfg);
    if (!base) return null;
    const doFetch = selectFetch(cfg, { fetchImpl: globalThis.fetch, sessionFor });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const extra = query ? `&${String(query).replace(/^\?/, '')}` : '';
      const join = String(pathname).includes('?') ? '&' : '?';
      const response = await doFetch(`${base}${pathname}${join}profile=${encodeURIComponent(profile)}${extra}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          Accept: 'application/json',
          Origin: base,
          'x-intelio-profile': profile,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response || !response.ok) return null;
      const parsed = await response.json();
      if (!parsed) return null;
      if (expectId && parsed.id !== profile) return null;
      return parsed;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pullPwaCard(profile, key, pathname, body, expectId = true) {
    return pwaRequest(profile, key, pathname, body, { expectId });
  }

  async function createAgent(value = {}) {
    let cfg;
    try { cfg = await config(); } catch { cfg = null; }
    const base = pwaBase(cfg || {});
    if (!base) throw new Error('Add the agent from the VPS connection. Cloud mode does not create profiles.');
    const key = await getKey('intelio').catch(() => '') || await getKey(cfg?.profile || 'intelio').catch(() => '');
    if (!key) throw new Error('No profile key is saved for the VPS.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const doFetch = selectFetch(cfg, { fetchImpl: globalThis.fetch, sessionFor });
      const response = await doFetch(`${base}/api/profiles`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: base,
          'x-intelio-profile': 'intelio',
        },
        body: JSON.stringify({
          name: value.name,
          title: value.title || '',
          orb: value.orb || '',
          color: value.color || '',
          soul: value.soul || '',
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await response.text();
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      if (!response.ok) throw new Error(parsed.error || 'Could not create that agent.');
      if (text.includes('API_SERVER_KEY') || /sk-[a-z0-9]{8,}/i.test(text)) throw new Error('Could not create that agent.');
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  async function voiceRequest(profile, { pathname, method = 'GET', body, contentType, accept = 'application/json', timeoutMs = 20000 } = {}) {
    const id = harnessId(profile) || 'intelio';
    let cfg;
    try { cfg = await config(); } catch { cfg = null; }
    const cloud = Boolean(cfg?.origin || cfg?.activeMode === 'cloud');
    const key = await keyForPwa(id, cloud);
    if (!key && !cloud) throw Object.assign(new Error("Voice isn't set up on the server yet"), { code: 'VOICE_OFF' });
    const base = pwaBase(cfg || {});
    if (!base) throw Object.assign(new Error("Voice isn't set up on the server yet"), { code: 'VOICE_OFF' });
    const doFetch = selectFetch(cfg, { fetchImpl: globalThis.fetch, sessionFor });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const join = pathname.includes('?') ? '&' : '?';
      return await doFetch(`${base}${pathname}${join}profile=${encodeURIComponent(id)}`, {
        method,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          Accept: accept,
          Origin: base,
          'x-intelio-profile': id,
          'x-intelio-engine': 'auto',
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function voiceOff() {
    return Object.assign(new Error("Voice isn't set up on the server yet"), { code: 'VOICE_OFF' });
  }

  /** Session ids from the renderer, same shape the phone server accepts (ID_RE); refuse anything path-like. */
  function sessionIdOf(raw) {
    const id = String(raw || '').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Unknown session.');
    return id;
  }

  /** Only the sidebar fields the Sessions tab edits reach Hermes's PATCH /api/sessions/<id>. */
  function sessionFields(raw = {}) {
    const fields = {};
    if (typeof raw.title === 'string' && raw.title.trim()) fields.title = raw.title.trim().slice(0, 200);
    for (const flag of ['pinned', 'archived']) if (typeof raw[flag] === 'boolean') fields[flag] = raw[flag];
    if (!Object.keys(fields).length) throw new Error('Nothing to change.');
    return fields;
  }

  async function voiceStatus(profile) {
    const response = await voiceRequest(profile, { pathname: '/api/voice' });
    if (!response?.ok) throw voiceOff();
    return response.json();
  }

  async function voiceTranscribe(profile, value = {}) {
    const audio = Buffer.from(String(value.audio || ''), 'base64');
    if (audio.length < 16) throw new Error('That recording was empty.');
    const response = await voiceRequest(profile, {
      pathname: '/api/voice/stt',
      method: 'POST',
      body: audio,
      contentType: String(value.type || 'audio/webm').slice(0, 80),
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    if (!response.ok) {
      if (parsed.fallback === 'web' || response.status === 503) throw voiceOff();
      throw new Error(String(parsed.error || 'Could not transcribe.').slice(0, 200));
    }
    if (text.includes('API_SERVER_KEY')) throw new Error('Could not transcribe.');
    return { text: String(parsed.text || '').trim() };
  }

  async function voiceSpeak(profile, value = {}) {
    const id = harnessId(profile) || 'intelio';
    const sentence = String(value.text || '').trim().slice(0, 2000);
    if (!sentence) return { audio: '', type: 'audio/wav' };
    const response = await voiceRequest(id, {
      pathname: '/api/voice/tts',
      method: 'POST',
      body: JSON.stringify({ text: sentence, profile: id }),
      contentType: 'application/json',
      accept: 'audio/wav, audio/mpeg, application/octet-stream',
    });
    if (!response.ok) {
      const text = await response.text();
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      if (parsed.fallback === 'web' || response.status === 503) throw voiceOff();
      throw new Error('Could not speak.');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { audio: bytes.toString('base64'), type: response.headers.get('content-type') || 'audio/wav' };
  }

  /**
   * The profile's own key. On the Access listener (cloud) mobile/pwa/server.cjs
   * compares the bearer with the key of the profile named by ?profile= or
   * x-intelio-profile, so the intelio key sent for another profile is a 401;
   * cloud falls back to the Access cookie instead. The tailnet listener does
   * not check the bearer, so the intelio key stays a fallback there.
   */
  async function keyForPwa(id, cloud) {
    const own = await getKey(id).catch(() => '');
    if (own || cloud) return own;
    return getKey('intelio').catch(() => '');
  }

  async function phoneCall(profile) {
    const id = harnessId(profile) || 'intelio';
    let cfg;
    try { cfg = await config(); } catch { cfg = null; }
    const key = await keyForPwa(id, Boolean(cfg?.origin || cfg?.activeMode === 'cloud'));
    const remote = await pwaRequest(id, key, '/api/phone/call', { profile: id }, { timeoutMs: 8000, expectId: false });
    return { ready: remote?.ready === true };
  }

  async function agentCard(profile) {
    const id = harnessId(profile) || 'intelio';
    const key = await getKey(id).catch(() => '');
    const remote = key ? await pullPwaCard(id, key, '/api/agent/card') : null;
    if (remote) return remote;
    // Hermes has no memory route (GET /api/memory never existed); the memory
    // text comes only from the phone server's /api/agent/card above.
    const jobs = await client.optional('GET', '/api/jobs', { profile: id });
    return buildCard({
      id,
      jobs,
      userText: '',
      memoryText: '',
      computer: { status: 'stopped' },
    });
  }

  async function agentThinking(profile, effort) {
    const id = harnessId(profile) || 'intelio';
    const key = await getKey(id).catch(() => '');
    const remote = key ? await pullPwaCard(id, key, '/api/agent/thinking', { effort, profile: id }) : null;
    if (remote) return remote;
    const card = await agentCard(id);
    return { ...card, readOnly: true };
  }

  async function saveAgentProfile(value = {}) {
    const id = harnessId(value.profile) || 'intelio';
    const key = await getKey(id).catch(() => '');
    const remote = key ? await pullPwaCard(id, key, '/api/agent/profile', {
      profile: id,
      name: value.name,
      title: value.title,
      email: value.email,
      mobile: value.mobile,
      soul: value.soul,
      color: value.color,
      orb: value.orb,
    }) : null;
    if (!remote) throw new Error('Could not save that profile.');
    return remote;
  }

  async function listRemoteScreens() {
    const key = await getKey('intelio').catch(() => '');
    const parsed = key ? await pullPwaCard('intelio', key, '/api/screens', null, false) : null;
    return Array.isArray(parsed?.data) ? parsed.data : [];
  }

  async function agentPause(profile, paused) {
    const id = harnessId(profile) || 'intelio';
    const key = await getKey(id).catch(() => '');
    const remote = key ? await pullPwaCard(id, key, '/api/agent/pause', { paused: paused === true, profile: id }) : null;
    if (remote) return remote;
    const card = await agentCard(id);
    return { ...card, paused: paused === true, localOnly: true };
  }

  async function modelCall(profile, pathname, body, query = '') {
    const id = harnessId(profile) || 'intelio';
    const key = await getKey(id).catch(() => '');
    const remote = await pwaRequest(id, key, pathname, body, { timeoutMs: 8000, expectId: false, query });
    if (!remote) throw new Error('Could not reach the model list.');
    return remote;
  }

  async function modelOptions(profile, sessionId) {
    const query = sessionId ? `session=${encodeURIComponent(sessionId)}` : '';
    try { return await modelCall(profile, '/api/models', null, query); }
    catch { return { model: '', provider: '', groups: [], effort: 'auto', efforts: ['auto', 'low', 'medium', 'high'], restartRequired: false }; }
  }

  async function sessionModel(profile, value = {}) {
    const id = String(value.id || '');
    return modelCall(profile, `/api/sessions/${encodeURIComponent(id)}/model`, {
      profile: harnessId(profile) || 'intelio',
      model: value.model,
      provider: value.provider,
      effort: value.effort,
    });
  }

  async function agentModel(profile, value = {}) {
    const id = harnessId(profile) || 'intelio';
    return modelCall(id, '/api/agent/model', { profile: id, model: value.model, provider: value.provider });
  }

  function register() {
    ipcMain.handle('remote-hermes', async (event, name, value = {}) => {
      trusted(event);
      if (!resolved) await refreshConnection();
      if (needsSignIn && name !== 'state') {
        const error = new Error('Sign in to intelio');
        error.code = 'CLOUD_ACCESS';
        throw error;
      }
      const profileHint = value.profile ? String(value.profile) : ((await config()).profile || 'default');
      const key = await getKey(profileHint).catch(() => '');
      try {
        switch (name) {
          case 'state': return publicState();
          case 'agents': return await mainData.listAgents();
          case 'sessions': {
            const rows = await mainData.listSessions(value.profile ? String(value.profile) : undefined, { source: value.source, limit: Math.min(Number(value.limit) || 50, 200), offset: Number(value.offset) || 0 });
            return { data: rows };
          }
          case 'all-sessions': {
            const rows = await mainData.listAllSessions(Array.isArray(value.profiles) ? value.profiles : undefined);
            return { data: rows };
          }
          case 'messages': return await client.messages(String(value.id), { profile: value.profile });
          case 'create-session': return await client.createSession(value.title, { profile: value.profile });
          case 'session-update': return await client.updateSession(sessionIdOf(value.id), sessionFields(value.fields), { profile: value.profile });
          case 'session-delete': return await client.deleteSession(sessionIdOf(value.id), { profile: value.profile });
          case 'skills': return await client.skills();
          case 'create-agent': return await createAgent(value);
          case 'agent-card': return await agentCard(value.profile);
          case 'agent-thinking': return await agentThinking(value.profile, value.effort);
          case 'agent-pause': return await agentPause(value.profile, value.paused !== false);
          case 'agent-profile': return await saveAgentProfile(value);
          case 'phone-call': return await phoneCall(value.profile);
          case 'voice-status': return await voiceStatus(value.profile);
          case 'voice-transcribe': return await voiceTranscribe(value.profile, value);
          case 'voice-speak': return await voiceSpeak(value.profile, value);
          case 'model-options': return await modelOptions(value.profile, value.id);
          case 'session-model': return await sessionModel(value.profile, value);
          case 'agent-model': return await agentModel(value.profile, value);
          case 'screens': return { data: await listRemoteScreens() };
          case 'send': {
            const id = String(value.id);
            const controller = new AbortController();
            inflight.set(id, controller);
            try {
              const picker = require('./model-picker.cjs');
              const switched = value.model && value.provider && picker.keepId(value.model) && picker.subscriptionProvider(value.provider)
                ? picker.sessionSwitchBody(value.provider, value.model, value.effort)
                : null;
              return await client.chat(id, String(value.input || '').slice(0, 100000), {
                signal: controller.signal,
                profile: value.profile,
                model: switched,
                onEvent: (evt) => { if (!event.sender.isDestroyed()) event.sender.send('remote-hermes:event', { sessionId: id, event: evt.event, data: evt.data }); },
              });
            } finally { inflight.delete(id); }
          }
          case 'cancel': inflight.get(String(value.id))?.abort(); return true;
          default: throw new Error(`Unknown Remote Hermes request: ${name}`);
        }
      } catch (error) {
        if (error?.code === 'CLOUD_ACCESS') {
          needsSignIn = true;
          openSignIn();
          notify();
        }
        const wrapped = new Error(redactKey(error?.message || String(error), key));
        if (error?.code) wrapped.code = error.code;
        throw wrapped;
      }
    });
  }

  function open() {
    if (chatWindow && !chatWindow.isDestroyed()) { chatWindow.show(); chatWindow.focus(); return chatWindow; }
    chatWindow = new BrowserWindow({ width: 1000, height: 760, minWidth: 720, minHeight: 480, title: 'Remote Hermes (VPS)', backgroundColor: background || '#0a0a0a', icon,
      webPreferences: { preload: path.join(root, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: rendererSandbox() } });
    chatWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    chatWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    chatWindow.on('closed', () => { for (const c of inflight.values()) c.abort(); inflight.clear(); chatWindow = null; });
    chatWindow.loadFile(path.join(root, 'remote-hermes.html'));
    return chatWindow;
  }

  async function vault(action, value = {}) {
    const cfg = await config();
    const profile = String(value.profile || cfg.profile || 'intelio');
    const key = await getKey(profile);
    if (!key) throw new Error(`No API key saved for Hermes profile "${profile}".`);
    const origin = vaultOrigin({ ...cfg, vaultOrigin: getPrefs().remoteHermes?.vaultOrigin, vaultPort: getPrefs().remoteHermes?.vaultPort });
    const paths = { login: '/api/vault/login', logins: '/api/vault/logins', delete: '/api/vault/logins', fill: '/api/vault/fill' };
    const method = action === 'logins' ? 'GET' : action === 'delete' ? 'DELETE' : 'POST';
    let body;
    if (action === 'login') {
      body = {
        profile,
        domain: value.domain || '',
        username: value.username || '',
        password: value.password || '',
        otp: value.otp || '',
        save: value.save === true,
        selectors: value.selectors || null,
      };
    } else if (action === 'delete') body = { profile, domain: value.domain || '' };
    else if (action === 'fill') body = { profile, site: value.site || value.domain || '' };
    return postProfileVault({
      origin,
      profile,
      key,
      method,
      path: paths[action] || '/api/vault/fill',
      body,
      fetchImpl: selectVaultFetch(cfg),
    });
  }
  function selectVaultFetch(cfg) {
    if (cfg.partition && sessionFor) {
      const ses = sessionFor(cfg.partition);
      if (ses && typeof ses.fetch === 'function') return (url, init = {}) => ses.fetch(url, init);
    }
    return globalThis.fetch;
  }

  async function vncPassword() {
    const stored = readKeys()[VNC_KEY];
    if (!stored) return '';
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return '';
    }
  }

  /**
   * Where the intelio node (desktop/src/intelio/node) dials. Uses the connection
   * already chosen (never opens a sign-in window itself): cloud → origin plus the
   * Access cookies from the cloud session; Tailscale → the configured host.
   */
  async function nodeTarget() {
    if (!resolved) return null;
    if (resolved.mode === 'cloud') {
      if (needsSignIn) return null;
      const ses = sessionFor(resolved.partition || CLOUD_PARTITION);
      if (!ses || !ses.cookies) return null;
      let cookies = [];
      try { cookies = await ses.cookies.get({ url: resolved.origin }); } catch { return null; }
      const cookie = mergeAccessCookies('', cookies);
      if (!/(?:^|; )CF_Authorization=/.test(cookie)) return null;
      return { mode: 'cloud', origin: resolved.origin, cookie };
    }
    let cfg;
    try { cfg = await baseConfig(); } catch { return null; }
    if (!cfg.host) return null;
    return { mode: 'tailscale', host: cfg.host };
  }

  return { register, command, open, publicState, watchVersion, viewerUrl, vncPassword, vault, nodeTarget, startupNotice: () => startupNotice };
}

module.exports = { setupRemoteHermes, importRemoteHermesKey, keyFromImport, keysFromImport, profileNames, secureDelete, attachCloudSessionCookies, cloudCookieFilter, VNC_KEY };
