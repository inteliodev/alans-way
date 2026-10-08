const path = require('node:path');
const { fileURLToPath } = require('node:url');
const PERMISSIONS = Object.freeze({ geolocation: 'Precise location', 'geolocation-approximate': 'General area', notifications: 'Notifications', camera: 'Camera', microphone: 'Microphone', 'clipboard-read': 'Read clipboard' });

function originOf(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}
function permissionKeys(permission, details = {}) {
  if (permission !== 'media') return Object.hasOwn(PERMISSIONS, permission) ? [permission] : [];
  const types = Array.isArray(details.mediaTypes) && details.mediaTypes.length ? details.mediaTypes : [details.mediaType || 'audio', ...(details.mediaType ? [] : ['video'])];
  if (types.some(type => !['audio', 'video'].includes(type))) return [];
  return [...new Set(types.map(type => type === 'audio' ? 'microphone' : 'camera'))];
}
function createSitePermissions({ getPreferences, savePreferences, canRequest, prompt }) {
  const pending = new Map();
  function decision(scope, origin, key) {
    const prefs = getPreferences();
    const stored = prefs.sitePermissions?.[scope]?.[origin]?.[key];
    if (['allow', 'block'].includes(stored)) return stored;
    if (key === 'geolocation-approximate') return prefs.locationDefault === 'approximate' ? 'allow' : 'block';
    return key === 'geolocation' && prefs.locationDefault !== 'ask' ? 'block' : 'ask';
  }
  function set({ scope = 'browser', origin, permission, decision: choice }) {
    origin = originOf(origin);
    if (!origin || !['browser', 'telegram'].includes(scope) || !Object.hasOwn(PERMISSIONS, permission) || !['allow', 'block', 'ask'].includes(choice)) throw new Error('Choose a valid site, permission and setting.');
    const prefs = getPreferences();
    prefs.sitePermissions ||= {};
    prefs.sitePermissions[scope] ||= {};
    prefs.sitePermissions[scope][origin] ||= {};
    if (choice === 'ask') delete prefs.sitePermissions[scope][origin][permission];
    else prefs.sitePermissions[scope][origin][permission] = choice;
    if (!Object.keys(prefs.sitePermissions[scope][origin]).length) delete prefs.sitePermissions[scope][origin];
    savePreferences();
  }
  function reset(scope = 'browser') {
    if (!['browser', 'telegram'].includes(scope)) throw new Error('Unknown browser session.');
    const prefs = getPreferences();
    if (prefs.sitePermissions) delete prefs.sitePermissions[scope];
    savePreferences();
  }
  function context(wc, details, requestingOrigin) {
    const origin = originOf(requestingOrigin || details.securityOrigin || details.requestingUrl || wc?.getURL());
    return { origin, url: wc?.getURL(), eligible: !!wc && !wc.isDestroyed() && canRequest(wc) };
  }
  function install(session, scope) {
    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
      const ctx = context(wc, details, requestingOrigin);
      if (!ctx.eligible) return false;
      if (permission === 'fullscreen') return true;
      const keys = permissionKeys(permission, details);
      return !!ctx.origin && keys.length > 0 && keys.every(key => decision(scope, ctx.origin, key) === 'allow');
    });
    session.setPermissionRequestHandler(async (wc, permission, callback, details = {}) => {
      let allowed = false;
      try {
        const ctx = context(wc, details);
        if (!ctx.eligible) return;
        if (permission === 'fullscreen') { allowed = true; return; }
        const keys = permissionKeys(permission, details);
        if (!ctx.origin || !keys.length || keys.some(key => decision(scope, ctx.origin, key) === 'block')) return;
        const unknown = keys.filter(key => decision(scope, ctx.origin, key) === 'ask');
        if (unknown.length) {
          const id = JSON.stringify([scope, ctx.origin, unknown.slice().sort()]);
          if (!pending.has(id)) {
            const answer = Promise.resolve().then(() => prompt(ctx.origin, unknown.map(key => PERMISSIONS[key]))).then(choice => {
              // Persist the human's choice even if a tab was closed while the dialog was open.
              for (const key of unknown) set({ scope, origin: ctx.origin, permission: key, decision: choice === true ? 'allow' : 'block' });
            }).finally(() => pending.delete(id));
            pending.set(id, answer);
          }
          await pending.get(id);
        }
        // A takeover, tab switch or navigation during the prompt must not authorize the new page/agent.
        allowed = !wc.isDestroyed() && wc.getURL() === ctx.url && canRequest(wc) && keys.every(key => decision(scope, ctx.origin, key) === 'allow');
      } catch { allowed = false; }
      finally { callback(allowed); }
    });
  }
  return { install, set, reset };
}

function mediaTypesOf(details = {}) {
  if (Array.isArray(details.mediaTypes) && details.mediaTypes.length) return details.mediaTypes;
  if (details.mediaType) return [details.mediaType];
  return ['audio'];
}

/** file:// pages inside the app directory. Browser tabs and other origins are not included. */
function appMediaPage(pageUrl, rootDir) {
  try {
    const url = new URL(String(pageUrl || ''));
    if (url.protocol !== 'file:' || url.username || url.password) return false;
    const file = path.resolve(fileURLToPath(url));
    const root = path.resolve(String(rootDir || ''));
    return file === root || file.startsWith(root + path.sep);
  } catch { return false; }
}

/**
 * Grant microphone capture for the app's own pages only.
 * Camera, remote sites, and every other permission stay denied on this session.
 */
function installAppMicrophone(session, owns) {
  function allow(wc, permission, details) {
    try {
      if (permission !== 'media') return false;
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
      if (typeof owns !== 'function' || owns(wc) !== true) return false;
      const types = mediaTypesOf(details);
      return types.length > 0 && types.every((type) => type === 'audio');
    } catch { return false; }
  }
  session.setPermissionCheckHandler((wc, permission, _origin, details = {}) => allow(wc, permission, details));
  session.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    callback(allow(wc, permission, details));
  });
}

module.exports = { createSitePermissions, originOf, PERMISSIONS, installAppMicrophone, appMediaPage, mediaTypesOf };
