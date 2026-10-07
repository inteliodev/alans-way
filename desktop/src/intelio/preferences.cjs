'use strict';
/**
 * Preference loading without Electron. A missing file, or a saved remoteHermes
 * object that omits the host, keeps the platform default. An explicit
 * enabled:false stays off.
 */
const path = require('node:path');
const { remoteHermesDefaults, normalizeRemoteConfig, VNC_URL } = require('./remote-hermes.cjs');
const { normalizeTheme } = require('./theme.cjs');
const { agentsFromKeys } = require('./remote-main-data.cjs');
const { normalizeConnectionMode } = require('./cloud-connection.cjs');

/**
 * App data stays in "Hermes Workspace" when the product name or the exe name
 * changes. A name-derived folder (Intelio, Electron) would ignore the saved theme.
 */
function resolveUserDataDir({ platform = 'win32', env = {}, home = '', appData = '' } = {}) {
  const override = String(env.HERMES_WORKSPACE_DATA || '').trim();
  if (override) return path.resolve(override);
  let base = appData;
  if (platform === 'win32') base = env.APPDATA || appData;
  else if (platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : appData);
  return path.join(base, 'Hermes Workspace');
}

/** preferences.json may be UTF-8, UTF-8 with a BOM, or UTF-16 from Notepad. */
function decodePreferencesText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le').replace(/^\uFEFF/, '');
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  const sample = buf.subarray(0, Math.min(buf.length, 80));
  let nulls = 0;
  for (const byte of sample) if (byte === 0) nulls += 1;
  if (sample.length > 8 && nulls > 4) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function mergeRemote(defaults, saved) {
  if (saved == null || typeof saved !== 'object' || Array.isArray(saved)) return { ...defaults };
  const enabled = typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled;
  const host = String(saved.host ?? '').trim() || (enabled ? defaults.host : '');
  const port = saved.port ?? defaults.port;
  const profile = String(saved.profile ?? '').trim() || defaults.profile;
  const connection = normalizeConnectionMode(saved.connection == null || saved.connection === '' ? defaults.connection : saved.connection);
  return { enabled, host, port, profile, connection };
}

/** A saved viewer URL wins. Otherwise remote mode uses the VPS noVNC page. */
function resolveDesktopUrl(remote, saved, env = {}) {
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  const fromEnv = String(env.HERMES_WORKSPACE_VPS_URL || '').trim();
  if (fromEnv) return fromEnv;
  if (remote && remote.enabled && remote.host) return VNC_URL;
  return '';
}

function loadPreferences({ text = null, bytes = null, platform = 'darwin', env = {} } = {}) {
  if (bytes != null) text = decodePreferencesText(bytes);
  else if (typeof text === 'string') text = text.replace(/^\uFEFF/, '');
  const defaults = {
    bots: [],
    order: [],
    hidden: [],
    selectedBotId: '',
    accountId: '',
    remoteUrl: '',
    chatWidth: 490,
    preview: true,
    previewPos: null,
    showBots: true,
    showBrowser: true,
    savedTabs: [],
    avatarLibrary: [],
    avatarPreferences: {},
    locationDefault: 'approximate',
    sitePermissions: {},
    browserExtensions: [],
    vpsBrowser: {},
    remoteHermes: remoteHermesDefaults(platform),
    agentIdleMinutes: 15,
    agentLastTabs: {},
    handoffs: [],
    overseerBots: String(env.HERMES_OVERSEER_BOTS || '').split(',').map((id) => id.trim()).filter((id) => id && id.length <= 100),
    sidebarTab: 'agents',
    theme: 'dark',
    screenGrid: 1,
    activeScreen: 0,
  };
  const desktop = (prefs, saved) => resolveDesktopUrl(prefs.remoteHermes, saved, env);
  if (text == null) {
    const prefs = { ...defaults, remoteUrl: desktop(defaults, undefined) };
    return { prefs, missing: true, corrupt: false };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const prefs = { ...defaults, remoteUrl: desktop(defaults, undefined) };
    return { prefs, missing: false, corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const prefs = { ...defaults, remoteUrl: desktop(defaults, undefined) };
    return { prefs, missing: false, corrupt: true };
  }
  const prefs = {
    ...defaults,
    ...parsed,
    remoteHermes: mergeRemote(defaults.remoteHermes, parsed.remoteHermes),
  };
  prefs.remoteUrl = desktop(prefs, typeof parsed.remoteUrl === 'string' ? parsed.remoteUrl : undefined);
  prefs.sidebarTab = prefs.sidebarTab === 'sessions' ? 'sessions' : 'agents';
  prefs.theme = normalizeTheme(prefs.theme);
  const grid = Number(prefs.screenGrid);
  prefs.screenGrid = [2, 3, 4].includes(grid) ? grid : 1;
  const screen = Number(prefs.activeScreen);
  prefs.activeScreen = Number.isInteger(screen) && screen >= 0 && screen < 4 ? screen : 0;
  return { prefs, missing: false, corrupt: false };
}

function initialDesktopTab(remoteOn) {
  return remoteOn ? 'vps' : 'home';
}

function freshWindowPlan({ platform = 'win32', preferencesText = null, keyNames = [], env = {} } = {}) {
  const { prefs } = loadPreferences({ text: preferencesText, platform, env });
  let remote;
  try { remote = normalizeRemoteConfig(prefs.remoteHermes); } catch {
    remote = { enabled: false, host: '', port: prefs.remoteHermes?.port || 8642, profile: prefs.remoteHermes?.profile || 'intelio' };
  }
  const on = remote.enabled === true && Boolean(remote.host);
  const profile = remote.profile || 'intelio';
  return {
    remote: on,
    host: remote.host,
    port: remote.port,
    profile,
    agents: on ? agentsFromKeys(keyNames, profile) : [],
    telegramSignIn: !on,
    desktop: prefs.remoteUrl,
  };
}

module.exports = {
  mergeRemote, loadPreferences, freshWindowPlan, resolveDesktopUrl, initialDesktopTab,
  resolveUserDataDir, decodePreferencesText,
};
