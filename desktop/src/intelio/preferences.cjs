'use strict';
/**
 * Preference loading without Electron. A missing file, or a saved remoteHermes
 * object that omits the host, keeps the platform default. An explicit
 * enabled:false stays off.
 */
const { remoteHermesDefaults, normalizeRemoteConfig } = require('./remote-hermes.cjs');
const { agentsFromKeys } = require('./remote-main-data.cjs');

function mergeRemote(defaults, saved) {
  if (saved == null || typeof saved !== 'object' || Array.isArray(saved)) return { ...defaults };
  const enabled = typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled;
  const host = String(saved.host ?? '').trim() || (enabled ? defaults.host : '');
  const port = saved.port ?? defaults.port;
  const profile = String(saved.profile ?? '').trim() || defaults.profile;
  return { enabled, host, port, profile };
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
  const remoteUrl = env.HERMES_WORKSPACE_VPS_URL || '';
  if (text == null) return { prefs: { ...defaults, remoteUrl }, missing: true, corrupt: false };
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { prefs: { ...defaults, remoteUrl }, missing: false, corrupt: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { prefs: { ...defaults, remoteUrl }, missing: false, corrupt: true };
  }
  const prefs = {
    ...defaults,
    ...parsed,
    remoteHermes: mergeRemote(defaults.remoteHermes, parsed.remoteHermes),
  };
  if (parsed.remoteUrl == null) prefs.remoteUrl = remoteUrl;
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
  };
}

module.exports = { mergeRemote, loadPreferences, freshWindowPlan };
