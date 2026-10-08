'use strict';
/**
 * Electron glue for the intelio node (docs/intelio-node.md):
 * - prefs.intelioNode = { enabled (default true), name ('' = OS hostname), asked (first-run
 *   prompt answered), cleared / hold (managed work computers, see managedDevice) }
 * - an always-on-top pill while an agent is using this computer, with Stop (indicator.cjs)
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
const { tailnetNameFor } = require('../tailscale.cjs');
const { VPS_HOST } = require('../remote-hermes.cjs');

const RELAY_PORT = 8643;
const CONFIRM_TIMEOUT_MS = 120000;

function nodePrefs(prefs) {
  const raw = prefs && typeof prefs.intelioNode === 'object' && prefs.intelioNode ? prefs.intelioNode : {};
  return {
    enabled: raw.enabled !== false,
    name: typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) : '',
    // First run: the app asks once ("Let my agents use this computer", Allow is the default).
    asked: raw.asked === true,
    // A managed work computer (see managedDevice) stays held until this is set after its IT team clears it.
    cleared: raw.cleared === true,
    // Hold this computer regardless of detection.
    hold: raw.hold === true,
  };
}

// Signs of a managed work computer whose security team has not cleared the intelio node
// (the ARLP PC on the Alliance network: Cisco Umbrella DNS filtering, SentinelOne, no admin).
// Detection only decides to hold the node OFF; it never changes or works around those tools.
const MANAGED_PATHS_WIN = [
  'C:\\Program Files\\SentinelOne',
  'C:\\ProgramData\\Sentinel',
  'C:\\Program Files (x86)\\OpenDNS\\Umbrella Roaming Client',
  'C:\\Program Files (x86)\\Cisco\\Cisco Secure Client\\Umbrella',
  'C:\\Program Files (x86)\\Cisco\\Cisco AnyConnect Secure Mobility Client\\Umbrella',
  'C:\\ProgramData\\Cisco\\Cisco Secure Client\\Umbrella',
];
const MANAGED_PATHS_MAC = ['/Library/Sentinel', '/Applications/SentinelOne', '/Applications/Cisco/Cisco Secure Client.app', '/opt/cisco/secureclient/umbrella'];

/** { managed, reasons[] } for this computer. */
function managedDevice({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const reasons = [];
  const domain = `${env.USERDNSDOMAIN || ''} ${env.USERDOMAIN || ''}`;
  if (/alliance/i.test(domain)) reasons.push('it is joined to the Alliance domain');
  const paths = platform === 'win32' ? MANAGED_PATHS_WIN : platform === 'darwin' ? MANAGED_PATHS_MAC : [];
  for (const p of paths) {
    let found = false;
    try { found = exists(p); } catch { found = false; }
    if (found) { reasons.push(/sentinel/i.test(p) ? 'SentinelOne is installed' : 'Cisco Umbrella is installed'); }
  }
  return { managed: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** Why the node is held off on this computer, or '' when it may run. */
function holdReason({ env = process.env, prefs = {}, managed = { managed: false, reasons: [] } } = {}) {
  const p = nodePrefs(prefs);
  if (String(env.INTELIO_NODE_HOLD || '') === '1') return 'Held by INTELIO_NODE_HOLD=1 on this computer.';
  if (p.hold) return 'Held in Settings.';
  if (managed.managed && !p.cleared) return `Held because this looks like a managed work computer (${managed.reasons.join('; ')}). It stays off until its IT team clears it; then tick "IT has cleared this computer" in Settings.`;
  return '';
}

function deviceName(prefs, hostname = os.hostname()) {
  return nodePrefs(prefs).name || String(hostname || 'computer').slice(0, 64);
}

/** WebSocket URLs to try for a remote-hermes node target. */
function relayUrls(target, env = process.env, { cloudOnly = false } = {}) {
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
  // A managed work computer only ever uses intelio cloud (app.intelio-ai.com), never Tailscale.
  if (target.mode === 'tailscale' && target.host && !cloudOnly) {
    const raw = String(target.host).trim();
    const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
    const wss = `wss://${host}:${RELAY_PORT}/node/connect`;
    const urls = [];
    // The phone listener's certificate is issued for its *.ts.net name. Dialing a bare
    // Tailscale IP fails the name check (and ws:// fails against TLS), so verify against
    // the MagicDNS name for that IP when we know it.
    const tlsName = String(target.tlsName || '').trim().toLowerCase();
    if (isTailnetIp(raw) && /^([a-z0-9-]+\.)+ts\.net$/.test(tlsName)) urls.push({ url: wss, servername: tlsName });
    urls.push(wss, `ws://${host}:${RELAY_PORT}/node/connect`);
    return { urls, headers: {}, mode: 'tailscale' };
  }
  return null;
}

function isTailnetIp(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/.test(h);
}

/** Adds tlsName for a Tailscale-IP target: the peer's MagicDNS name, else the known VPS name. */
async function withTlsName(target, { nameFor = tailnetNameFor, fallback = VPS_HOST } = {}) {
  if (!target || target.mode !== 'tailscale' || !isTailnetIp(target.host) || target.tlsName) return target;
  let name = '';
  try { name = await nameFor(String(target.host).replace(/^\[|\]$/g, '')); } catch { name = ''; }
  return { ...target, tlsName: name || fallback };
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

function readLocalAudit(file, limit = 200, fsImpl = fs) {
  let text = '';
  try {
    const stat = fsImpl.statSync(file);
    const fd = fsImpl.openSync(file, 'r');
    try {
      const size = Math.min(stat.size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(size);
      fsImpl.readSync(fd, buf, 0, size, stat.size - size);
      text = buf.toString('utf8');
    } finally { fsImpl.closeSync(fd); }
  } catch { return []; }
  const out = [];
  for (const line of text.split('\n').slice(-limit - 1)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial first line */ }
  }
  return out.slice(-limit);
}

function setupIntelioNode({ app, safeStorage, dialog, desktopCapturer, screen, getPrefs, savePreferences, remoteHermes, getMainWindow = () => null, env = process.env, BrowserWindow, ipcMain }) {
  const dir = path.join(app.getPath('userData'), 'intelio-node');
  const identity = createIdentityStore(path.join(dir, 'identity.bin'), safeStorage);
  const auditFile = path.join(dir, 'audit.jsonl');
  const audit = createAuditLog(auditFile);
  let listener = () => {};
  const name = () => deviceName(getPrefs());
  let managedCache = null; // installed security tools do not change while the app runs
  const managedNow = () => (managedCache = managedCache || managedDevice({ env }));
  const held = () => holdReason({ env, prefs: getPrefs(), managed: managedNow() });
  let askOpen = false;
  let indicator = null;
  try {
    if (!BrowserWindow || !ipcMain) ({ BrowserWindow, ipcMain } = require('electron'));
    if (env.INTELIO_E2E !== '1') {
      indicator = require('./indicator.cjs').createIndicator({
        BrowserWindow, ipcMain, screen,
        onStop: () => { configure({ enabled: false }); indicator && indicator.stopped(); },
      });
    }
  } catch { indicator = null; }

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
        message: 'An intelio agent wants to run (or type into a terminal session) a command that asks for administrator rights.',
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
    getTarget: async () => relayUrls(await withTlsName(remoteHermes && typeof remoteHermes.nodeTarget === 'function' ? await remoteHermes.nodeTarget() : null), env, { cloudOnly: managedNow().managed }),
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
    onActivity: (event) => { try { indicator && indicator.update(event.active); } catch { /* indicator */ } listener(); },
  });

  function publicState() {
    const prefs = nodePrefs(getPrefs());
    const s = client.state();
    const hold = held();
    const m = managedNow();
    return {
      enabled: prefs.enabled,
      name: name(),
      customName: prefs.name,
      hostname: os.hostname(),
      status: hold ? 'held' : !prefs.asked ? 'ask' : prefs.enabled ? s.status : 'off',
      detail: hold || s.detail,
      held: Boolean(hold),
      managed: m.managed,
      managedReasons: m.reasons,
      cleared: prefs.cleared,
      asked: prefs.asked,
      active: client.active(),
      enrolled: Boolean(identity.load()),
      encryptionAvailable: identity.available(),
      auditFile,
    };
  }

  /** First run: ask once in the app. Allow (the default button) turns access on. */
  async function askFirstRun() {
    if (askOpen) return;
    askOpen = true;
    try {
      const options = {
        type: 'question',
        buttons: ['Allow', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: 'intelio',
        message: 'Let my agents use this computer?',
        detail: 'Your intelio agents on the VPS can then work with the files and terminal on this computer as you (including Claude Code or Codex if they are installed). They never get administrator rights, you can see when they are working, and Settings has an on/off switch and an activity log. Change this any time in Settings.',
      };
      const win = getMainWindow();
      const answer = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      configure({ enabled: answer.response === 0, asked: true });
    } catch { /* asked again next launch */ } finally { askOpen = false; }
  }

  function start() {
    if (env.INTELIO_E2E === '1' || env.INTELIO_NODE === '0') return;
    if (held()) { listener(); return; }
    const prefs = nodePrefs(getPrefs());
    if (!prefs.asked) { setTimeout(() => askFirstRun(), 1500); return; }
    if (prefs.enabled) setImmediate(() => client.start());
  }

  function configure(value = {}) {
    const prefs = getPrefs();
    const current = nodePrefs(prefs);
    const next = { ...current };
    if (typeof value.enabled === 'boolean') next.enabled = value.enabled;
    if (typeof value.name === 'string') next.name = value.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
    if (value.asked === true || typeof value.enabled === 'boolean') next.asked = true;
    if (typeof value.cleared === 'boolean') next.cleared = value.cleared;
    if (typeof value.hold === 'boolean') next.hold = value.hold;
    prefs.intelioNode = next;
    savePreferences();
    const running = client.state().enabled;
    const shouldRun = next.enabled && next.asked && !held() && env.INTELIO_NODE !== '0' && env.INTELIO_E2E !== '1';
    if (!shouldRun) { if (running || client.state().status !== 'off') client.stop(held() ? 'held' : 'turned off'); }
    else if (!running) {
      if (client.state().status === 'revoked') client.forgetIdentity();
      client.start();
    } else if (next.name !== current.name) client.reconnect();
    if (!next.asked && !held() && env.INTELIO_NODE !== '0' && env.INTELIO_E2E !== '1') setImmediate(() => askFirstRun());
    listener();
    return publicState();
  }

  async function computers(nameArg, value = {}) {
    if (!remoteHermes || typeof remoteHermes.computersRequest !== 'function') throw new Error('Connect to the VPS to see your computers.');
    if (nameArg === 'intelio-computers') return remoteHermes.computersRequest('/api/computers');
    if (nameArg === 'intelio-computers-pause') {
      return remoteHermes.computersRequest('/api/computers/pause', { method: 'POST', body: { computer: String(value.computer || '').slice(0, 128), paused: value.paused !== false } });
    }
    const limit = Math.min(500, Math.max(1, Number(value.limit) || 200));
    return remoteHermes.computersRequest(`/api/computers/audit?limit=${limit}`);
  }

  async function command(nameArg, value = {}) {
    if (nameArg === 'intelio-node-state') return publicState();
    if (nameArg === 'intelio-node-config') return configure(value || {});
    if (nameArg === 'intelio-node-audit') return { file: auditFile, entries: readLocalAudit(auditFile, Math.min(1000, Math.max(1, Number(value && value.limit) || 200))) };
    if (nameArg === 'intelio-computers' || nameArg === 'intelio-computers-pause' || nameArg === 'intelio-computers-audit') return computers(nameArg, value || {});
    throw new Error(`Unknown intelio node command ${String(nameArg).slice(0, 40)}.`);
  }

  return {
    start,
    kick: () => { const p = nodePrefs(getPrefs()); if (p.enabled && p.asked && !held()) client.kick(); },
    stop: () => { client.stop('app quitting'); try { indicator && indicator.close(); } catch { /* closing */ } },
    command,
    publicState,
    onChange(fn) { listener = typeof fn === 'function' ? fn : () => {}; },
    client,
  };
}

module.exports = { setupIntelioNode, nodePrefs, deviceName, relayUrls, withTlsName, isTailnetIp, createIdentityStore, captureDisplay, managedDevice, holdReason, readLocalAudit, RELAY_PORT };
