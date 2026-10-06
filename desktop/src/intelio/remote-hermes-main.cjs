'use strict';
/**
 * Main-process wiring for Remote Hermes (VPS) mode: settings, encrypted key
 * storage, IPC for the chat window, and the window itself. The API key never
 * leaves this process.
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRemoteConfig, createRemoteHermesClient, redactKey, PROFILE_RE } = require('./remote-hermes.cjs');
const { createRemoteMain } = require('./remote-main-data.cjs');
const { checkTailscale, assertInstallUrl, installUrl } = require('./tailscale.cjs');

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

/** Several `profile=key` lines. A lone raw line, or `API_SERVER_KEY=`, is the intelio key. */
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
    if (value.length < 16) continue;
    if (/^API_SERVER_KEY$/i.test(named[1])) { keys.intelio = value; continue; }
    const profile = named[1].trim().toLowerCase();
    if (!PROFILE_RE.test(profile)) continue;
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
  const names = Object.keys(parsed);
  if (!names.length) {
    secureDelete(file, fsImpl);
    return { imported: false, refused: true };
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return { imported: false, unavailable: true };
  const keys = readKeys();
  for (const name of names) keys[name] = safeStorage.encryptString(parsed[name]).toString('base64');
  writeKeys(keys);
  secureDelete(file, fsImpl);
  return { imported: true, profiles: names, notice: 'Connected to VPS Hermes', profile: profile || names[0] };
}

function setupRemoteHermes({ app, BrowserWindow, ipcMain, safeStorage, shell, getPrefs, savePreferences, getMainWindow, root, rendererSandbox, icon, background }) {
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
    const stored = readKeys()[profile || 'default'];
    if (!stored || !safeStorage.isEncryptionAvailable()) return '';
    try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); } catch { return ''; }
  }
  function config() {
    const prefs = getPrefs();
    return normalizeRemoteConfig(prefs.remoteHermes || {});
  }
  const client = createRemoteHermesClient({ getConfig: config, getKey });
  const mainData = createRemoteMain({ getConfig: config, getKey, keyNames: () => Object.keys(readKeys()) });
  let versionLabel = '';
  function watchVersion(onUpdate) {
    const run = () => {
      let cfg;
      try { cfg = config(); } catch { return; }
      if (!cfg.enabled || !cfg.host) return;
      client.health().then((health) => {
        const next = health.label || '';
        if (!next || next === versionLabel) return;
        versionLabel = next;
        if (typeof onUpdate === 'function') onUpdate();
      }).catch(() => {});
    };
    run();
    const timer = setInterval(run, 60000);
    if (typeof timer.unref === 'function') timer.unref();
  }
  let startupNotice = '';
  try {
    const imported = importRemoteHermesKey({
      file: path.join(app.getPath('userData'), 'remote-hermes-key.import'),
      profile: (() => { try { return config().profile || 'default'; } catch { return 'default'; } })(),
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
    try { cfg = config(); } catch (e) { cfg = { ...(getPrefs().remoteHermes || {}) }; error = e.message; }
    const keys = readKeys();
    let encryptionAvailable = false;
    try { encryptionAvailable = safeStorage.isEncryptionAvailable(); } catch (e) { error = error || e.message; }
    return { ...cfg, hasKey: Boolean(keys[cfg.profile || 'default']), profilesWithKeys: Object.keys(keys), encryptionAvailable, error, versionLabel };
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
        const next = normalizeRemoteConfig({ ...(prefs.remoteHermes || {}), ...value });
        prefs.remoteHermes = next;
        savePreferences();
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

  function register() {
    ipcMain.handle('remote-hermes', async (event, name, value = {}) => {
      trusted(event);
      const profileHint = value.profile ? String(value.profile) : (config().profile || 'default');
      const key = await getKey(profileHint).catch(() => '');
      try {
        switch (name) {
          case 'state': return publicState();
          case 'agents': return await mainData.listAgents();
          case 'sessions': {
            const rows = await mainData.listSessions(value.profile ? String(value.profile) : undefined, { source: value.source, limit: Math.min(Number(value.limit) || 50, 200), offset: Number(value.offset) || 0 });
            return { data: rows };
          }
          case 'messages': return await client.messages(String(value.id), { profile: value.profile });
          case 'create-session': return await client.createSession(value.title, { profile: value.profile });
          case 'skills': return await client.skills();
          case 'send': {
            const id = String(value.id);
            const controller = new AbortController();
            inflight.set(id, controller);
            try {
              return await client.chat(id, String(value.input || '').slice(0, 100000), {
                signal: controller.signal,
                profile: value.profile,
                onEvent: (evt) => { if (!event.sender.isDestroyed()) event.sender.send('remote-hermes:event', { sessionId: id, event: evt.event, data: evt.data }); },
              });
            } finally { inflight.delete(id); }
          }
          case 'cancel': inflight.get(String(value.id))?.abort(); return true;
          default: throw new Error(`Unknown Remote Hermes request: ${name}`);
        }
      } catch (error) {
        throw new Error(redactKey(error?.message || String(error), key));
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

  return { register, command, open, publicState, watchVersion, startupNotice: () => startupNotice };
}

module.exports = { setupRemoteHermes, importRemoteHermesKey, keyFromImport, keysFromImport, secureDelete };
