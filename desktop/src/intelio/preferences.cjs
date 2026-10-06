'use strict';
/**
 * Preference loading without Electron. A missing file, or a saved remoteHermes
 * object that omits the host, keeps the platform default. An explicit
 * enabled:false stays off.
 */
const { remoteHermesDefaults, normalizeRemoteConfig, VNC_URL } = require('./remote-hermes.cjs');
const { agentsFromKeys } = require('./remote-main-data.cjs');

function mergeRemote(defaults, saved) {
  if (saved == null || typeof saved !== 'object' || Array.isArray(saved)) return { ...defaults };
  const enabled = typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled;
  const host = String(saved.host ?? '').trim() || (enabled ? defaults.host : '');
  const port = saved.port ?? defaults.port;
  const profile = String(saved.profile ?? '').trim() || defaults.profile;
  return { enabled, host, port, profile };
}

/** A saved viewer URL wins. Otherwise remote mode uses the VPS noVNC page. */
function resolveDesktopUrl(remote, saved, env = {}) {
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  const fromEnv = String(env.HERMES_WORKSPACE_VPS_URL || '').trim();
  if (fromEnv) return fromEnv;
  if (remote && remote.enabled && remote.host) return VNC_URL;
  return '';
}

function loadPreferences({ text = null, platform = 'darwin', env = {} } = {}) {
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
  return { prefs, missing: false, corrupt: false };
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

module.exports = { mergeRemote, loadPreferences, freshWindowPlan, resolveDesktopUrl };
