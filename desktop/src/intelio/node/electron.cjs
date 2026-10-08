'use strict';
/**
 * Electron glue for the intelio node (docs/intelio-node.md):
 * - prefs.intelioNode = { enabled (default true), name ('' = OS hostname) }
 * - device identity encrypted with safeStorage in <userData>/intelio-node/identity.bin
 * - audit log <userData>/intelio-node/audit.jsonl
 * - target: cloud origin + CF_Authorization cookie, or the tailnet phone listener
 * - screenshot via desktopCapturer, elevation confirm via a native dialog
 * Started from main.cjs after the window is created; never blocks startup.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNodeClient, createAuditLog } = require('./client.cjs');
const { createExecutors, osLabel } = require('./executors.cjs');

const RELAY_PORT = 8643;
const CONFIRM_TIMEOUT_MS = 120000;

function nodePrefs(prefs) {
  const raw = prefs && typeof prefs.intelioNode === 'object' && prefs.intelioNode ? prefs.intelioNode : {};
  return {
    enabled: raw.enabled !== false,
    name: typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) : '',
  };
}

function deviceName(prefs, hostname = os.hostname()) {
  return nodePrefs(prefs).name || String(hostname || 'computer').slice(0, 64);
}

/** WebSocket URLs to try for a remote-hermes node target. */
function relayUrls(target, env = process.env) {
  const override = String(env.INTELIO_NODE_RELAY_URL || '').trim();
  if (override && /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i.test(override)) {
    // Loopback-only override for tests and SSH tunnels; never sends the cookie elsewhere.
    return { urls: [override], headers: target && target.cookie ? { Cookie: target.cookie } : {}, mode: 'override' };
  }
  if (!target) return null;
  if (target.mode === 'cloud' && target.origin && target.cookie) {
    const url = new URL('/node/connect', target.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return { urls: [url.toString()], headers: { Cookie: target.cookie }, mode: 'cloud' };
  }
  if (target.mode === 'tailscale' && target.host) {
    const raw = String(target.host).trim();
    const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
    return { urls: [`wss://${host}:${RELAY_PORT}/node/connect`, `ws://${host}:${RELAY_PORT}/node/connect`], headers: {}, mode: 'tailscale' };
  }
  return null;
}

function createIdentityStore(file, safeStorage, fsImpl = fs) {
  return {
    available: () => Boolean(safeStorage && safeStorage.isEncryptionAvailable()),
    load() {
      try {
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
        const parsed = JSON.parse(safeStorage.decryptString(fsImpl.readFileSync(file)));
        return parsed && parsed.device_id && parsed.device_secret ? parsed : null;
      } catch { return null; }
    },
    save(identity) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable.');
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(identity)), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    },
    clear() { try { fsImpl.unlinkSync(file); } catch { /* none */ } },
  };
}

async function captureDisplay({ desktopCapturer, screen }, display) {
  const displays = screen.getAllDisplays();
  const chosen = displays[display - 1];
  if (!chosen) throw new Error(`There is no display ${display}; this computer has ${displays.length}.`);
  const scale = chosen.scaleFactor || 1;
  let width = Math.round(chosen.size.width * scale);
  let height = Math.round(chosen.size.height * scale);
  const longest = Math.max(width, height);
  if (longest > 3840) { width = Math.round(width * 3840 / longest); height = Math.round(height * 3840 / longest); }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  const source = sources.find((s) => String(s.display_id) === String(chosen.id)) || sources[display - 1] || sources[0];
  if (!source || source.thumbnail.isEmpty()) return { png: Buffer.alloc(0), width: 0, height: 0, count: displays.length };
  const size = source.thumbnail.getSize();
  return { png: source.thumbnail.toPNG(), width: size.width, height: size.height, count: displays.length, scale };
}

function setupIntelioNode({ app, safeStorage, dialog, desktopCapturer, screen, getPrefs, savePreferences, remoteHermes, getMainWindow = () => null, env = process.env }) {
  const dir = path.join(app.getPath('userData'), 'intelio-node');
  const identity = createIdentityStore(path.join(dir, 'identity.bin'), safeStorage);
  const audit = createAuditLog(path.join(dir, 'audit.jsonl'));
  let listener = () => {};
  const name = () => deviceName(getPrefs());

  async function confirmElevation({ command, reason }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIRM_TIMEOUT_MS);
    try {
      const options = {
        type: 'warning',
        buttons: ['Refuse', 'Allow once'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'intelio',
        message: 'An intelio agent wants to run a command that asks for administrator rights.',
        detail: `${reason}.\n\n${String(command).slice(0, 600)}\n\nAllow once runs it as you; Windows or macOS still asks for the administrator password. Refuse if you did not expect this.`,
        signal: controller.signal,
      };
      const win = getMainWindow();
      const answer = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      return answer.response === 1;
    } catch { return false; } finally { clearTimeout(timer); }
  }

  const executors = createExecutors({
    confirmElevation,
    screenshot: (display) => captureDisplay({ desktopCapturer, screen }, display),
    computerName: name,
  });

  const client = createNodeClient({
    getTarget: async () => relayUrls(remoteHermes && typeof remoteHermes.nodeTarget === 'function' ? await remoteHermes.nodeTarget() : null, env),
    getInfo: () => {
      let user = '';
      try { user = os.userInfo().username; } catch { user = ''; }
      return { name: name(), os: osLabel(), arch: process.arch, user, version: app.getVersion() };
    },
    identity,
    executors,
    audit,
    log: (line) => process.stderr.write(`${line}\n`),
    onState: () => listener(),
  });

  function publicState() {
    const prefs = nodePrefs(getPrefs());
    const s = client.state();
    return {
      enabled: prefs.enabled,
      name: name(),
      customName: prefs.name,
      hostname: os.hostname(),
      status: prefs.enabled ? s.status : 'off',
      detail: s.detail,
      enrolled: Boolean(identity.load()),
      encryptionAvailable: identity.available(),
      auditFile: path.join(dir, 'audit.jsonl'),
    };
  }

  function start() {
    if (env.INTELIO_E2E === '1' || env.INTELIO_NODE === '0') return;
    if (nodePrefs(getPrefs()).enabled) setImmediate(() => client.start());
  }

  function configure(value = {}) {
    const prefs = getPrefs();
    const current = nodePrefs(prefs);
    const next = { ...current };
    if (typeof value.enabled === 'boolean') next.enabled = value.enabled;
    if (typeof value.name === 'string') next.name = value.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
    prefs.intelioNode = next;
    savePreferences();
    if (!next.enabled) client.stop('turned off');
    else if (!current.enabled) {
      if (client.state().status === 'revoked') client.forgetIdentity();
      client.start();
    } else if (next.name !== current.name) client.reconnect();
    return publicState();
  }

  async function command(nameArg, value = {}) {
    if (nameArg === 'intelio-node-state') return publicState();
    if (nameArg === 'intelio-node-config') return configure(value || {});
    throw new Error(`Unknown intelio node command ${String(nameArg).slice(0, 40)}.`);
  }

  return {
    start,
    kick: () => { if (nodePrefs(getPrefs()).enabled) client.kick(); },
    stop: () => client.stop('app quitting'),
    command,
    publicState,
    onChange(fn) { listener = typeof fn === 'function' ? fn : () => {}; },
    client,
  };
}

module.exports = { setupIntelioNode, nodePrefs, deviceName, relayUrls, createIdentityStore, captureDisplay, RELAY_PORT };
