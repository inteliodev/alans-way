'use strict';
/**
 * Main-process wiring for Remote Hermes (VPS) mode: settings, encrypted key
 * storage, IPC for the chat window, and the window itself. The API key never
 * leaves this process.
 */
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRemoteConfig, createRemoteHermesClient, redactKey } = require('./remote-hermes.cjs');
const { checkTailscale, assertInstallUrl, installUrl } = require('./tailscale.cjs');

function keyFromImport(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const line = lines[0] || '';
  const named = line.match(/^(?:export\s+)?API_SERVER_KEY\s*=\s*(.*)$/);
  const value = (named ? named[1] : line).trim().replace(/^['"]|['"]$/g, '');
  return value;
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
  if (st.size > 4096) {
    secureDelete(file, fsImpl);
    return { imported: false, refused: true };
  }
  const key = keyFromImport(fsImpl.readFileSync(file, 'utf8'));
  if (key.length < 16) {
    secureDelete(file, fsImpl);
    return { imported: false, refused: true };
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) return { imported: false, unavailable: true };
  const keys = readKeys();
  const name = profile || 'default';
  keys[name] = safeStorage.encryptString(key).toString('base64');
  writeKeys(keys);
  secureDelete(file, fsImpl);
  return { imported: true, notice: 'Connected to VPS Hermes' };
}

function setupRemoteHermes({ app, BrowserWindow, ipcMain, safeStorage, shell, getPrefs, savePreferences, root, rendererSandbox, icon, background }) {
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
    return { ...cfg, hasKey: Boolean(keys[cfg.profile || 'default']), profilesWithKeys: Object.keys(keys), encryptionAvailable: safeStorage.isEncryptionAvailable(), error };
  }

  function trusted(event) {
    try {
      const ok = chatWindow && !chatWindow.isDestroyed() && event.sender === chatWindow.webContents && event.senderFrame === event.sender.mainFrame && event.sender.getURL().startsWith('file:');
      if (!ok) throw new Error();
    } catch { throw new Error('Untrusted Remote Hermes request.'); }
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
      const key = await getKey(config().profile || 'default').catch(() => '');
      try {
        switch (name) {
          case 'state': return publicState();
          case 'sessions': return await client.listSessions({ source: value.source, limit: Math.min(Number(value.limit) || 50, 200), offset: Number(value.offset) || 0 });
          case 'messages': return await client.messages(String(value.id));
          case 'create-session': return await client.createSession(value.title);
          case 'skills': return await client.skills();
          case 'send': {
            const id = String(value.id);
            const controller = new AbortController();
            inflight.set(id, controller);
            try {
              return await client.chat(id, String(value.input || '').slice(0, 100000), {
                signal: controller.signal,
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

  return { register, command, open, publicState, startupNotice: () => startupNotice };
}

module.exports = { setupRemoteHermes, importRemoteHermesKey, keyFromImport, secureDelete };
