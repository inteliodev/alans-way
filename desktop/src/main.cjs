if (process.argv.includes('--smoke-test')) {
  process.on('uncaughtException', (error) => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exit(1);
  });
}
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, clipboard, shell, nativeTheme, screen, nativeImage, session, safeStorage, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { normalizeUrl, parseRemoteUrl, isSshTarget, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized, sanitizeBots } = require('./core.cjs');
const { createAvatarStore } = require('./avatar-store.cjs');
const { createAgentInput, tintScript, botAccent } = require('./agent-input.cjs');
const { createActivityTracker } = require('./activity.cjs');
const { createSitePermissions, installAppMicrophone, appMediaPage } = require('./site-permissions.cjs');
const { snapshotExpression, settleSnapshot, checkpointExpression, restoreExpression } = require('./browser-page.cjs');
const { createVpsBrowser } = require('./vps-browser.cjs');
const { createExtensionStore } = require('./extension-store.cjs');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { applyLinuxDemo, rendererSandbox } = require('./intelio/linux-demo.cjs');
const { agentNavigationDecision } = require('./intelio/safety.cjs');
const { loadIntelio, publicIntelioState, pngIcon } = require('./intelio/bridge.cjs');
const { agents, agentsSetup } = require('./intelio/forks.cjs');
const { setupRemoteHermes } = require('./intelio/remote-hermes-main.cjs');
const { loadPreferences, initialDesktopTab, resolveUserDataDir } = require('./intelio/preferences.cjs');
const { createVaultStore } = require('./intelio/vault.cjs');
const { usesRemoteVault } = require('./intelio/remote-vault.cjs');
const { buildFill, publicFill, fieldValue } = require('./intelio/login-fill.cjs');
const { normalizeTheme, themeVars } = require('./intelio/theme.cjs');
const clientApps = require('./intelio/client-apps.cjs');
const { hostLabels, hermesChecklist } = require('./intelio/host-labels.cjs');
const { checkTailscale, firstRunMessage } = require('./intelio/tailscale.cjs');

if (!applyLinuxDemo(app)) app.enableSandbox();
app.setName('intelio');
if (process.platform === 'win32') app.setAppUserModelId('co.intelio.alans-way');
// Keep existing sessions and the saved theme when the exe name or product name changes.
// setName does not retarget userData; pin the historical folder and pin it again on ready.
function pinUserData() {
  const dir = resolveUserDataDir({
    platform: process.platform,
    env: process.env,
    home: app.getPath('home'),
    appData: app.getPath('appData'),
  });
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
  return dir;
}
pinUserData();
const ROOT = __dirname;
const NEWTAB_URL = pathToFileURL(path.join(ROOT, 'newtab.html')).href;
const TELEGRAM = 'https://web.telegram.org/a/';
let win, backgroundWindow, telegramView, remoteView, apiServer, prefs, layout = {}, apiPort = 0;
let extensionStore, extensionHost, extensionPopup, extensionPopupTabId, extensionActiveContentsId;
let registeringExtensionTab = false;
let activeTabId = 'home', browserReturnTabId = 'home', apiError = '', remoteStatus = 'disconnected', telegramStatus = 'loading', telegramDiagnostics = {};
const tabs = new Map();
const vpsTabs = new Map();
const recentLinkTabs = new Map();
let vpsBrowserStatus = 'unconfigured', vpsRefreshBusy = false, vpsTimer;
const vpsBrowser = createVpsBrowser({ getConfig: () => prefs?.vpsBrowser });
const configuredSessions = new WeakSet();
const API_TOKEN = crypto.randomBytes(32).toString('hex');
// Connectors allow 90s for action requests; a batch stops starting new steps
// early enough that its last step (wait caps at 30s) still answers in time.
const BATCH_BUDGET_MS = 50000;
let isQuitting = false;
let intelioSession = null;
let remoteHermes = null; // Remote Hermes (VPS) client mode, see src/intelio/remote-hermes*.cjs
let backgroundCaptureQueue = Promise.resolve();
const avatarStore = createAvatarStore({ root: ROOT, nativeImage, dialog, getWindow: () => win, getPreferences: () => prefs });
const agentInput = createAgentInput({ command: browserCommand,
  requireActor: (tab, botId, epoch, mutate) => requireActor(tab, botId, epoch, mutate, isOverseer(botId)),
  botName: (id) => nameForBot(id) || 'Agent', onBusy: () => broadcast() });
const activity = createActivityTracker();
const sitePermissions = createSitePermissions({ getPreferences: () => prefs, savePreferences,
  canRequest: (wc) => {
    const tab = [...tabs.values()].find(item => item.view.webContents === wc);
    if (layout.obscured) return false;
    return tab ? tab.id === activeTabId && tab.controller === 'human' : wc === telegramView?.webContents;
  },
  prompt: async (origin, permissions) => {
    const answer = await dialog.showMessageBox(win, { type: 'question', buttons: ['Block for this site', 'Allow for this site'], defaultId: 0, cancelId: 0,
      message: `${origin} wants ${permissions.join(' and ').toLowerCase()} access.`, detail: 'Your choice is remembered. Change it in Workspace settings → Site permissions.' });
    return answer.response === 1;
  }
});
let pointerTimer, activityTimer, idleTimer;
let tailscaleFirstRun = false;

function readPreferences() {
  const file = path.join(app.getPath('userData'), 'preferences.json');
  let bytes = null;
  try { bytes = fs.readFileSync(file); } catch { bytes = null; }
  const loaded = loadPreferences({ bytes, platform: process.platform, env: process.env });
  if (loaded.missing && process.platform === 'win32') tailscaleFirstRun = true;
  if (loaded.corrupt) {
    // Keep the unreadable file: the next save would otherwise erase every bot,
    // permission and extension record with defaults.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
  }
  return loaded.prefs;
}
function writePrivateJson(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
function savePreferences() {
  if (!prefs) return;
  if (win && !win.isDestroyed()) prefs.savedTabs = [...tabs.values()].filter(tab => !tab.extensionPage && tab.view?.webContents && !tab.view.webContents.isDestroyed()).map((tab) => ({ url: tab.view.webContents.getURL(), botId: tab.botId, ...(tab.client ? { client: tab.client } : {}) }));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  writePrivateJson(path.join(app.getPath('userData'), 'preferences.json'), prefs);
}
function describeTab(tab) {
  const wc = tab.view?.webContents;
  const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
  return { id: tab.id, title: tab.title || 'New tab', url, internal: url === NEWTAB_URL || url === 'about:blank', botId: tab.botId, client: tab.client || '', favicon: tab.favicon || '', agentHue: botAccent(tab.botId).hue,
    controller: tab.controller, epoch: tab.epoch, loading: tab.loading, error: tab.error || '', allowedBots: tab.allowedBots, agentCursor: tab.agentCursor || null, agentBusy: agentInput.isDispatching(tab), extensionPage: tab.extensionPage === true, viewport: tab.viewport || null, host: 'mac', session: 'shared-mac', handoff: tab.handoff || null };
}
function isVpsTab(id) { return vpsTabs.has(id); }
async function refreshVpsTabs() {
  if (!prefs?.vpsBrowser?.sshHost || vpsRefreshBusy) return;
  vpsRefreshBusy = true;
  try { const wasVps=vpsTabs.has(activeTabId); const data = await vpsBrowser.request('/v1/tabs', 'GET', undefined, { human: true }); vpsTabs.clear(); data.tabs.forEach(tab => { vpsTabs.set(tab.id, tab); resolveFavicon(tab, [tab.favicon]).catch(() => {}); }); if(wasVps&&!vpsTabs.has(activeTabId)){prefs.remoteControl=false;activeTabId='home';applyLayout();} vpsBrowserStatus = 'connected'; }
  catch { vpsBrowserStatus = 'disconnected'; }
  finally { vpsRefreshBusy = false; broadcast(); }
}
const nameForBot = (id) => prefs?.bots.find((bot) => bot.id === id)?.name || '';
const isOverseer = (botId) => Array.isArray(prefs?.overseerBots) && prefs.overseerBots.includes(botId);
async function remoteRequest(id, operation, body, { human = true, botId = prefs.selectedBotId || 'shared' } = {}) {
  const result = await vpsBrowser.request(`/v1/tabs/${id}${operation ? '/' + operation : ''}`, body === undefined ? 'GET' : 'POST', body, {human, botId, botName: nameForBot(botId)});
  const tab = result.tab || (result.id ? result : null); if (tab) vpsTabs.set(tab.id, tab);
  broadcast(); return result;
}
function selectAgent(id) {
  const old = prefs.selectedBotId;
  if (old === id) return;
  const viewingVps = activeTabId === 'vps';
  const localId = viewingVps ? browserReturnTabId : activeTabId;
  if (tabs.has(localId)) prefs.agentLastTabs[old] = localId;
  prefs.selectedBotId = id;
  prefs.remoteControl = false;
  const own = [...tabs.values()].filter(tab => tab.botId === id || (tab.allowedBots ?? []).includes(id));
  const nextLocal = own.some(tab => tab.id === prefs.agentLastTabs[id]) ? prefs.agentLastTabs[id] : own.at(-1)?.id || 'home';
  browserReturnTabId = nextLocal;
  activeTabId = viewingVps ? 'vps' : nextLocal;
  applyLayout();
}
function assertIntelioAgentUrl(url) {
  if (!intelioSession?.ok) throw Object.assign(new Error('intelio profile is not loaded; agent browsing is paused.'), { status: 403 });
  const decision = agentNavigationDecision(url, {
    origins: intelioSession.browsingOrigins,
    appPages: [NEWTAB_URL, 'about:blank', ''],
  });
  if (!decision.ok) throw Object.assign(new Error(decision.error), { status: decision.status });
}
function intelioTitle() {
  return 'intelio';
}
function currentTheme() { return normalizeTheme(prefs?.theme); }
let pushedTelegramTheme = '';
function applyThemeChrome() {
  const theme = currentTheme();
  nativeTheme.themeSource = theme;
  const background = theme === 'light' ? '#f6f6f8' : (intelioSession?.public?.brand?.tokens?.background || '#0a0a0a');
  if (win && !win.isDestroyed()) win.setBackgroundColor(background);
  if (remoteView && !remoteView.webContents.isDestroyed()) remoteView.setBackgroundColor(theme === 'light' ? '#f3f3f6' : '#101011');
  if (theme === pushedTelegramTheme) return;
  pushedTelegramTheme = theme;
  if (telegramView && !telegramView.webContents.isDestroyed()) telegramView.webContents.send('workspace:theme', theme);
}
function applyIntelioChrome() {
  if (!win || win.isDestroyed()) return;
  win.setTitle(intelioTitle());
  applyThemeChrome();
  try { win.setIcon(nativeImage.createFromBuffer(pngIcon())); } catch { /* icon is cosmetic; the profile report still stands */ }
}
function getState() {
  const intelio = publicIntelioState(intelioSession);
  const remote = remoteHermes?.publicState?.() || null;
  return { name: app.getName(), version: app.getVersion(), intelio, bots: prefs.bots.map(bot => ({ ...bot, activity: activity.get(bot.id), hue: botAccent(bot.id).hue })), order: prefs.order, hidden: prefs.hidden,
    selectedBotId: prefs.selectedBotId, chatWidth: prefs.chatWidth, preview: prefs.preview, previewPos: prefs.previewPos, showBots: prefs.showBots, showBrowser: prefs.showBrowser, remoteUrl: typeof remoteHermes?.viewerUrl === 'function' ? remoteHermes.viewerUrl() : prefs.remoteUrl,
    remoteStatus, remoteControl: prefs.remoteControl === true, telegramStatus, tabs: [...tabs.values()].map(describeTab),
    vpsBrowser: prefs.vpsBrowser, vpsBrowserStatus, handoffs: prefs.handoffs, macSshHost: prefs.macSshHost || '',
    primaryBotId: prefs.primaryBotId || (prefs.overseerBots || [])[0] || '', primaryBotPref: prefs.primaryBotId || '', overseerBots: prefs.overseerBots || [],
    botSort: prefs.botSort || 'manual',
    autoOpenLinks: prefs.autoOpenLinks !== false,
    activeTabId, browserContentsId: tabs.get(activeTabId)?.view.webContents.id || null, browserTabId: activeTabId === 'vps' ? (tabs.has(browserReturnTabId) ? browserReturnTabId : 'home') : activeTabId, avatarLibrary: avatarStore.library(), avatarPreferences: prefs.avatarPreferences,
    locationDefault: prefs.locationDefault, sitePermissions: prefs.sitePermissions, extensions: extensionStore?.list() || [],
    fullscreen: win?.isFullScreen() || false, api: { url: apiPort ? `http://127.0.0.1:${apiPort}` : '', ready: !!apiPort, error: apiError },
    remoteHermesNotice: remoteHermes?.startupNotice?.() || '',
    remoteHermes: remote,
    hermesStatus: hermesChecklist({ remoteHermes: remote, intelio }),
    sidebarTab: prefs.sidebarTab === 'sessions' ? 'sessions' : 'agents',
    screenGrid: prefs.screenGrid || 1,
    activeScreen: prefs.activeScreen || 0,
    platform: process.platform,
    host: hostLabels(process.platform),
    theme: currentTheme() };
}
let lastBotWorkSignature = '';
// Bots with agent tabs that are dispatching, navigating, or recently acted
// count as working — the Telegram preload draws the composer orbit glow.
function computeBotWork() {
  const working = {};
  for (const tab of tabs.values()) {
    if (tab.controller === 'agent' && (agentInput.isDispatching(tab) || tab.loading || Date.now() - Math.max(tab.agentSince || 0, tab.lastAgentActivity || 0) < 15000)) working[tab.botId] = botAccent(tab.botId).hue;
  }
  for (const tab of vpsTabs.values()) {
    if (tab.controller === 'agent' && tab.agentBusy) working[tab.botId] = botAccent(tab.botId).hue;
  }
  return working;
}
function sendBotWork() {
  const working = computeBotWork();
  lastBotWorkSignature = JSON.stringify(working);
  if (telegramView && !telegramView.webContents.isDestroyed()) telegramView.webContents.send('workspace:bot-activity', working);
}
function broadcast() {
  if (!win || win.isDestroyed() || !prefs) return;
  const state = getState();
  win.webContents.send('workspace:state', state);
  if (remoteView && !remoteView.webContents.isDestroyed()) remoteView.webContents.send('workspace:state', state);
  const signature = JSON.stringify(computeBotWork());
  if (signature !== lastBotWorkSignature) sendBotWork();
}
function fit(view, rect) {
  if (!view || view.webContents.isDestroyed()) return;
  if (!rect || rect.width < 1 || rect.height < 1 || layout.obscured) { if (view.getVisible()) view.setVisible(false); return; }
  const size = win.getContentBounds();
  const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
  const next = { x, y, width: Math.max(1, Math.min(Math.round(rect.width), size.width - x)), height: Math.max(1, Math.min(Math.round(rect.height), size.height - y)) };
  const previous = view.getBounds();
  if (Object.keys(next).some(key => next[key] !== previous[key])) view.setBounds(next);
  if (!view.getVisible()) view.setVisible(true);
}
function backgroundHost(width = 900, height = 700) {
  width = Math.max(900, Math.ceil(width)); height = Math.max(700, Math.ceil(height));
  if (!backgroundWindow || backgroundWindow.isDestroyed()) {
    // A hidden WebContentsView in the human window can acquire native focus
    // during load and has no viewport before its first show. Keep inactive
    // tabs visible inside a separate window that can never accept native focus.
    backgroundWindow = new BrowserWindow({ show: false, focusable: false, frame: false, skipTaskbar: true,
      width, height, webPreferences: { sandbox: rendererSandbox(), backgroundThrottling: false } });
  } else {
    const [currentWidth, currentHeight] = backgroundWindow.getContentSize();
    if (width > currentWidth || height > currentHeight) backgroundWindow.setContentSize(Math.max(width, currentWidth), Math.max(height, currentHeight));
  }
  return backgroundWindow;
}
function applyLayout() {
  if (extensionPopup && extensionPopupTabId !== activeTabId) extensionPopup.destroy();
  const activeTab = tabs.get(activeTabId);
  const active = activeTab?.view.webContents;
  // Client app tabs live in their own session, which the extension host does not manage.
  if (active && !activeTab.client && active.id !== extensionActiveContentsId) { extensionActiveContentsId = active.id; extensionHost?.selectTab(active); }
  fit(telegramView, layout.telegram);
  for (const tab of tabs.values()) {
    const foreground = activeTabId === tab.id && layout.browser?.width > 0 && layout.browser?.height > 0 && !layout.obscured;
    const host = foreground ? win : backgroundHost(layout.browser?.width || 900, layout.browser?.height || 700);
    if (tab.host !== host) {
      tab.view.setVisible(false);
      tab.host?.contentView.removeChildView(tab.view);
      host.contentView.addChildView(tab.view);
      tab.host = host;
    }
    if (foreground) fit(tab.view, layout.browser);
    else {
      const previous = tab.view.getBounds();
      const next = { x: 0, y: 0, width: Math.max(1, Math.round(layout.browser?.width || previous.width || 900)), height: Math.max(1, Math.round(layout.browser?.height || previous.height || 700)) };
      if (Object.keys(next).some(key => next[key] !== previous[key])) tab.view.setBounds(next);
      if (!tab.view.getVisible()) tab.view.setVisible(true);
    }
  }
  fit(remoteView, activeTabId === 'vps' ? layout.browser : prefs.preview ? layout.preview : null);
  if (remoteView && win.contentView.children.at(-1) !== remoteView) win.contentView.addChildView(remoteView);
}
function configureContents(contents, isTelegram = false) {
  contents.setWindowOpenHandler((details) => {
    let url;
    const extensionPage = !isTelegram && isExtensionUrl(details.url);
    try { url = extensionPage ? details.url : normalizeUrl(details.url); } catch { return { action: 'deny' }; }
    if (isTelegram) {
      // Guest windows inherit the persist:telegram session, which the extension
      // host rejects — open Telegram links in our own browser-session tab.
      const opened = recentLinkTabs.get(url);
      if (opened && Date.now() - opened.at < 15000 && tabs.has(opened.tabId)) {
        if (details.disposition !== 'background-tab') { activeTabId = opened.tabId; broadcast(); }
      } else {
        try { createTab({ url }); } catch {}
      }
      return { action: 'deny' };
    }
    return { action: 'allow', createWindow: (options) => {
      const parent = [...tabs.values()].find((tab) => tab.view.webContents === contents);
      const tab = createTab({ url, extensionPage, client: parent?.client || '', botId: parent?.botId || prefs.selectedBotId || 'shared', controller: extensionPage ? 'human' : parent?.controller || 'human', options, skipLoad: details.disposition !== 'background-tab', activate: parent?.controller !== 'agent' && details.disposition !== 'background-tab' });
      return tab.view.webContents;
    } };
  });
  contents.on('will-navigate', (event, url) => {
    if (isTelegram && !url.startsWith(TELEGRAM)) { event.preventDefault(); try { createTab({ url }); } catch {} }
    else if (!isTelegram && !/^https?:\/\//i.test(url) && url !== 'about:blank') {
      if (!isExtensionUrl(url)) event.preventDefault();
      else { const tab = [...tabs.values()].find(item => item.view.webContents === contents); if (tab) { tab.extensionPage = true; changeController(tab.id, 'human'); } }
    } else if (!isTelegram) {
      const tab = [...tabs.values()].find(item => item.view.webContents === contents);
      if (tab?.controller === 'agent') {
        try { assertIntelioAgentUrl(url); }
        catch (error) { event.preventDefault(); tab.error = error.message; broadcast(); }
      }
    }
  });
  contents.on('before-input-event', (event, input) => {
    const targetTab = [...tabs.values()].find(tab => tab.view.webContents === contents);
    if (targetTab && agentInput.isDispatching(targetTab)) return;
    if ((input.meta || input.control) && input.type === 'keyDown') {
      const key = input.key.toLowerCase();
      if (key === 'l') { event.preventDefault(); win.webContents.send('workspace:focus-address'); }
      if (key === 't') { event.preventDefault(); createTab({}); }
      if (key === 'w' && !isTelegram && activeTabId !== 'home') { event.preventDefault(); closeTab(activeTabId); }
    }
  });
  const session = contents.session;
  if (configuredSessions.has(session)) return;
  configuredSessions.add(session);
  sitePermissions.install(session, isTelegram ? 'telegram' : 'browser');
  session.on('will-download', (_event, item) => {
    if (item.getState() !== 'interrupted') item.setSaveDialogOptions({ title: 'Save download' });
  });
}
function isExtensionUrl(value) {
  try { const url = new URL(value); return url.protocol === 'chrome-extension:' && !url.username && !url.password && !!session.fromPartition('persist:browser').extensions.getExtension(url.hostname); } catch { return false; }
}
// Blank pages show the bundled backdrop instead of an empty dark document.
function pageUrl(url, extensionPage = false) {
  if (url === 'about:blank' || url === NEWTAB_URL) return NEWTAB_URL;
  if (extensionPage && isExtensionUrl(url)) return url;
  return normalizeUrl(url);
}
const faviconCache = new Map();
async function resolveFavicon(tab, favicons) {
  const seq = (tab.faviconSeq = (tab.faviconSeq || 0) + 1);
  const apply = (value) => { if (tab.faviconSeq === seq && value !== tab.favicon) { tab.favicon = value; broadcast(); } };
  const url = favicons.find((item) => /^https?:\/\//i.test(item));
  if (!url) return apply(favicons.find((item) => item && item !== 'data:,') || '');
  if (faviconCache.has(url)) return apply(faviconCache.get(url));
  try {
    const response = await session.fromPartition('persist:browser').fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !buffer.length || buffer.length > 262144) return apply('');
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim() || (url.endsWith('.ico') ? 'image/x-icon' : 'image/png');
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    if (faviconCache.size > 300) faviconCache.clear();
    faviconCache.set(url, dataUrl);
    apply(dataUrl);
  } catch { apply(''); }
}
/** The sign-in hint for a client: Settings value, else the catalog default. */
function clientAccount(id) {
  const saved = prefs?.clientAccounts && Object.prototype.hasOwnProperty.call(prefs.clientAccounts, id) ? prefs.clientAccounts[id] : undefined;
  return saved === undefined ? clientApps.clientById(id)?.account || '' : saved;
}
/** Per client: account hint and whether its own browser jar holds a work sign-in. */
async function clientAppsStatus() {
  const clients = {};
  for (const client of clientApps.CLIENTS) {
    const jar = session.fromPartition(clientApps.partitionFor(client.id)).cookies;
    clients[client.id] = { account: clientAccount(client.id), signedIn: await clientApps.signedIn(jar, client.id), suite: client.suite };
  }
  return { clients };
}
function createTab({ url = 'about:blank', botId = prefs.selectedBotId || 'shared', controller = 'human', options, skipLoad = false, activate = true, extensionPage = false, client = '' } = {}) {
  if (tabs.size >= 40) throw new Error('Close a tab before opening another.');
  // A client app tab uses that client's own cookie jar (persist:client-<id>), so each client's
  // work account stays signed in on its own. Popups from it inherit the jar via options.
  const clientId = client && clientApps.clientById(client) ? clientApps.clientById(client).id : '';
  const partition = clientId ? clientApps.partitionFor(clientId) : 'persist:browser';
  const targetUrl = pageUrl(url, extensionPage);
  if (controller === 'agent') assertIntelioAgentUrl(targetUrl);
  const view = new WebContentsView({ ...(options?.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options?.webPreferences, preload: undefined, partition, contextIsolation: true, nodeIntegration: false, sandbox: rendererSandbox(),
      webSecurity: true, backgroundThrottling: false } });
  view.setBackgroundColor('#0b0b0c');
  const tab = { id: crypto.randomUUID(), view, botId: String(botId).slice(0, 100), controller, extensionPage, client: clientId, epoch: 1, title: 'New tab', loading: false, allowedBots: [], refs: new Set(), generation: 0, queue: Promise.resolve() };
  if (controller === 'agent') tab.agentSince = Date.now();
  tabs.set(tab.id, tab);
  tab.host = backgroundHost();
  tab.host.contentView.addChildView(view);
  // Background agent tabs still need a real viewport for layout and screenshots.
  const viewport = layout.browser || { x: 0, y: 0, width: 900, height: 700 };
  view.setBounds({ x: Math.round(viewport.x), y: Math.round(viewport.y), width: Math.round(viewport.width), height: Math.round(viewport.height) });
  configureContents(view.webContents);
  // The library selects newly registered tabs. Registration must not reparent
  // or focus a background agent view in the human window.
  registeringExtensionTab = true;
  // Extensions live in the shared browser session only; client jars stay extension-free.
  try { if (!clientId) extensionHost?.addTab(view.webContents, win); } finally { registeringExtensionTab = false; }
  extensionActiveContentsId = undefined;
  view.webContents.on('context-menu', (_event, params) => {
    const items = (!clientId && extensionHost?.getContextMenuItems(view.webContents, params)) || [];
    if (items.length && tab.id === activeTabId && tab.controller === 'human') Menu.buildFromTemplate(items).popup({ window: win });
  });
  view.webContents.on('page-title-updated', (_event, title) => { tab.title = title; broadcast(); });
  view.webContents.on('did-start-loading', () => { tab.loading = true; tab.error = ''; broadcast(); });
  view.webContents.on('did-stop-loading', () => { tab.loading = false; savePreferences(); broadcast(); });
  view.webContents.on('did-navigate', () => { tab.refs.clear(); tab.generation++; if (tab.controller === 'agent') view.webContents.executeJavaScript(tintScript(true)).catch(() => {}); broadcast(); });
  view.webContents.on('page-favicon-updated', (event, favicons) => { resolveFavicon(tab, favicons).catch(() => {}); });
  view.webContents.on('did-navigate-in-page', () => { tab.refs.clear(); tab.generation++; broadcast(); });
  view.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = description; tab.loading = false; broadcast(); }
  });
  view.webContents.on('render-process-gone', () => { tab.error = 'This page stopped. Reload to reconnect.'; broadcast(); });
  // Pages can close themselves (OAuth popups end with window.close()); once the
  // webContents is gone the tab is a zombie — route it through normal cleanup.
  // During teardown the hosts are already gone and cleanup only throws.
  view.webContents.on('destroyed', () => { if (!isQuitting && tabs.has(tab.id)) closeTab(tab.id); });
  if (activate) { prefs.remoteControl = false; activeTabId = tab.id; }
  applyLayout(); broadcast();
  if (!skipLoad) view.webContents.loadURL(targetUrl).catch(() => {});
  return tab;
}
function closeTab(id) {
  if (id === 'home' || id === 'vps') { prefs.remoteControl=false; activeTabId = 'home'; applyLayout(); broadcast(); return; }
  const tab = tabs.get(id);
  if (!tab) return;
  tabs.delete(id);
  if (tab.view.webContents && !tab.client) extensionHost?.removeTab(tab.view.webContents);
  if (browserReturnTabId === id) browserReturnTabId = [...tabs.keys()].at(-1) || 'home';
  tab.host?.contentView.removeChildView(tab.view);
  tab.view.webContents?.close();
  if (activeTabId === id) activeTabId = [...tabs.keys()].at(-1) || 'home';
  savePreferences(); applyLayout(); broadcast();
}
function changeController(id, controller) {
  const tab = tabs.get(id);
  if (!tab) throw new Error('Tab not found.');
  if (tab.extensionPage && controller === 'agent') throw new Error('Extension account pages stay under your control.');
  if (controller === 'agent') assertIntelioAgentUrl(tab.view.webContents.getURL());
  tab.controller = controller === 'agent' ? 'agent' : 'human';
  if (tab.controller === 'agent') tab.agentSince = Date.now();
  if (tab.controller === 'agent' && tab.botId === 'shared' && prefs.selectedBotId) tab.botId = prefs.selectedBotId;
  tab.view.webContents.executeJavaScript(tintScript(tab.controller === 'agent')).catch(() => {});
  tab.epoch++;
  tab.refs.clear();
  agentInput.clear(tab).catch(() => {});
  broadcast();
  return describeTab(tab);
}
async function openExtension(key, anchor) {
  if (activeTabId === 'vps') throw new Error('Extensions are available in local browser tabs.');
  const item = extensionStore.list().find(item => item.key === key && item.loaded);
  if (!item) throw new Error('Enable this extension before opening it.');
  if (!tabs.has(activeTabId)) createTab({});
  const targetId = activeTabId, tab = tabs.get(targetId);
  // An extension popup may fill the page. Invalidate new agent actions first.
  if (tab) { changeController(tab.id, 'human'); await tab.queue; }
  if (activeTabId !== targetId || (tab && !tabs.has(tab.id))) throw new Error('The selected tab changed. Open the extension again on the intended tab.');
  const details = { eventType: 'click', extensionId: item.id, tabId: tab.view.webContents.id, alignment: 'bottom',
    anchorRect: { x: Number.isFinite(anchor?.x) ? anchor.x - 28 : win.getContentBounds().width - 90, y: Number.isFinite(anchor?.y) ? anchor.y - 28 : 100, width: 28, height: 28 } };
  await win.webContents.executeJavaScript(`window.browserAction.activate('persist:browser', ${JSON.stringify(details)})`);
}
function trustSender(event) {
  // Reading .webContents or .getURL() on a torn-down view throws; a destroyed
  // sender is simply untrusted.
  try {
    const trusted = [win?.webContents, remoteView?.webContents];
    if (!trusted.includes(event.sender) || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith('file:')) throw new Error('untrusted');
  } catch { throw new Error('Untrusted workspace request.'); }
}
async function openBot(id) {
  if (!prefs.bots.some((bot) => bot.id === id)) throw new Error('Select a verified Telegram bot.');
  selectAgent(id);
  savePreferences(); broadcast();
  const selected = await telegramView.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll('#LeftColumn a[href]')].find(el => el.hash?.slice(1).split('_')[0] === '${id}');
    if (link) {
      link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      link.click(); return true;
    } return false;
  })()`).catch(() => false);
  if (!selected) {
    await telegramView.webContents.loadURL(`${TELEGRAM}#${id}`).catch(() => {});
    telegramView.webContents.reload();
  }
}
let loginVault = null;
function loginVaultStore() {
  if (!loginVault) loginVault = createVaultStore({ root: process.env.INTELIO_VAULT_ROOT || path.join(app.getPath('home'), '.hermes', 'profiles') });
  return loginVault;
}
function vaultProfile(value) {
  return value?.profile || prefs.remoteHermes?.profile || 'intelio';
}
async function remoteVault(action, value) {
  if (typeof remoteHermes?.vault !== 'function') return { ok: false, filled: false, error: 'Remote vault is not connected.' };
  return remoteHermes.vault(action, value || {});
}
async function rememberLogin(value) {
  if (usesRemoteVault(prefs)) return remoteVault('login', value);
  try {
    const instruction = buildFill(value || {});
    let saved = false;
    if (value?.save === true && fieldValue(instruction, 'password') && instruction.domain) {
      loginVaultStore().saveLogin(vaultProfile(value), {
        domain: instruction.domain,
        username: fieldValue(instruction, 'username'),
        password: fieldValue(instruction, 'password'),
        otp: fieldValue(instruction, 'otp'),
        selectors: value.selectors,
      });
      saved = true;
    }
    return { ok: true, saved, ...publicFill(instruction) };
  } catch (error) {
    const message = String(error?.message || '');
    if (/password|otp|secret/i.test(message)) return { ok: false, filled: false };
    return { ok: false, filled: false, error: message.slice(0, 120) };
  }
}
function registerIpc() {
  remoteHermes.register();
  ipcMain.on('workspace:theme-sync', (event) => { event.returnValue = currentTheme(); });
  ipcMain.handle('workspace:get', (event) => { trustSender(event); return getState(); });
  ipcMain.on('workspace:layout', (event, value) => { try { trustSender(event); layout = value || {}; applyLayout(); } catch {} });
  ipcMain.handle('workspace:command', async (event, command, value = {}) => {
    trustSender(event);
    switch (command) {
      case 'remote-hermes-state': case 'remote-hermes-config': case 'remote-hermes-key': case 'remote-hermes-test': case 'open-remote-hermes': case 'remote-hermes-sign-in': {
        const result = await remoteHermes.command(command, value);
        if (command === 'remote-hermes-config' || command === 'remote-hermes-key' || command === 'remote-hermes-sign-in') broadcast();
        return result;
      }
      case 'create-tab': return describeTab(createTab({ url: value.url || 'about:blank' }));
      // Client apps: the URL comes from the catalog, never from the renderer.
      case 'open-client-app': {
        const client = clientApps.clientById(value.client);
        if (!client || !clientApps.appFor(client.id, value.app)) throw new Error('Unknown app.');
        const url = clientApps.urlFor(client.id, value.app, clientAccount(client.id));
        if (prefs.showBrowser === false) prefs.showBrowser = true;
        return describeTab(createTab({ url, client: client.id, botId: client.id }));
      }
      case 'client-apps-status': return await clientAppsStatus();
      case 'client-account': {
        const client = clientApps.clientById(value.client);
        if (!client) throw new Error('Unknown client.');
        const account = String(value.account || '').trim() ? clientApps.validAccount(value.account) : '';
        if (String(value.account || '').trim() && !account) throw new Error('That is not an email address.');
        prefs.clientAccounts = { ...(prefs.clientAccounts || {}), [client.id]: account };
        savePreferences();
        return await clientAppsStatus();
      }
      case 'client-sign-out': {
        const client = clientApps.clientById(value.client);
        if (!client) throw new Error('Unknown client.');
        for (const tab of [...tabs.values()]) if (tab.client === client.id) closeTab(tab.id);
        await session.fromPartition(clientApps.partitionFor(client.id)).clearStorageData();
        broadcast();
        return await clientAppsStatus();
      }
      case 'close-tab':
        if (isVpsTab(value.id)) { if(activeTabId===value.id)prefs.remoteControl=false; await vpsBrowser.request(`/v1/tabs/${value.id}`,'DELETE',undefined,{human:true}); vpsTabs.delete(value.id); if(activeTabId===value.id)activeTabId='home'; applyLayout(); } else closeTab(value.id); break;
      case 'activate': {
        const id=isVpsTab(value.id)?'vps':value.id;
        if(id==='vps'&&activeTabId!=='vps')browserReturnTabId=activeTabId;
        if(activeTabId!==id)prefs.remoteControl=false;
        activeTabId=tabs.has(id)||['home','vps'].includes(id)?id:'home';
        if(isVpsTab(value.id))await remoteRequest(value.id,'activate',{});
        applyLayout();break;
      }
      case 'toggle-vps-view': {
        if(activeTabId==='vps')activeTabId=tabs.has(browserReturnTabId)?browserReturnTabId:'home';
        else {browserReturnTabId=activeTabId;activeTabId='vps';}
        prefs.remoteControl=false;applyLayout();break;
      }
      case 'navigate': {
        if (isVpsTab(value.id)) { await navigateVps(value.id,value.url); break; }
        const tab = tabs.get(value.id); if (tab) { changeController(tab.id, 'human'); await tab.view.webContents.loadURL(pageUrl(value.url)).catch(() => {}); } break;
      }
      case 'history': {
        if (isVpsTab(value.id)) { await remoteRequest(value.id,'control',{controller:'human'}); await remoteRequest(value.id,'human-actions',{action:value.action}); break; }
        const tab = tabs.get(value.id); if (!tab) break;
        changeController(tab.id, 'human'); const history = tab.view.webContents.navigationHistory;
        if (value.action === 'back' && history.canGoBack()) history.goBack();
        if (value.action === 'forward' && history.canGoForward()) history.goForward();
        if (value.action === 'reload') tab.view.webContents.reload(); break;
      }
      case 'control': {
        if(isVpsTab(value.id)){if(value.controller==='agent')prefs.remoteControl=false;return remoteRequest(value.id,'control',{controller:value.controller});}
        const tab = tabs.get(value.id);
        if (tab && value.controller === 'agent') tab.handoff = reviewedHandoff(tab.handoff);
        return changeController(value.id, value.controller);
      }
      case 'share-page': {
        const tab = tabs.get(activeTabId);
        const url = tab ? tab.view.webContents.getURL() : '';
        if (!tab || !/^https?:\/\//i.test(url)) throw new Error('Open a web page first.');
        const title = (tab.view.webContents.getTitle() || url).slice(0, 300);
        if (!prefs.selectedBotId) throw new Error('Select a bot in the sidebar first — that is who the page goes to.');
        if (!telegramView || telegramView.webContents.isDestroyed()) throw new Error('Telegram is not loaded.');
        const tg = telegramView.webContents;
        const chatHash = new RegExp(`#${prefs.selectedBotId.replace(/\W/g, '')}(?:_|/|$)`);
        if (!chatHash.test(tg.getURL())) await openBot(prefs.selectedBotId);
        if (tg.isLoading()) throw new Error('Telegram is still loading — try again in a moment.');
        let point = null;
        for (let i = 0; i < 16 && !point; i++) {
          // A stopped or never-committed page can leave executeJavaScript pending
          // forever; bound the probe so the button reports instead of hanging.
          point = await Promise.race([
            tg.executeJavaScript(`(() => {
              const el = document.querySelector('#editable-message-text') || document.querySelector('.Composer [contenteditable="true"], #MiddleColumn [contenteditable="true"]');
              if (!el || !el.offsetParent) return null;
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`).catch(() => null),
            new Promise(resolve => setTimeout(() => resolve(null), 3000)),
          ]);
          if (!point) await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!point) throw new Error('The bot chat opened but no message box appeared.');
        if (!tg.debugger.isAttached()) tg.debugger.attach('1.3');
        try {
          await tg.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
          await tg.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
          await tg.debugger.sendCommand('Input.insertText', { text: `${title}\n${url}\n` });
        }
        finally { tg.debugger.detach(); }
        break;
      }
      case 'handoff': return handoffTab(value);
      case 'grant-tab': {
        if (isVpsTab(value.id)) { await remoteRequest(value.id,'grant',value); break; }
        const tab = tabs.get(value.id); if (!tab) throw new Error('Tab not found.');
        if (tab.extensionPage) throw new Error('Extension account pages stay under your control.');
        if (typeof value.botId === 'string' && value.botId.length > 0 && value.botId.length <= 100) tab.botId = value.botId;
        tab.allowedBots = Array.isArray(value.botIds) ? [...new Set(value.botIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 100 && id !== tab.botId))] : [];
        tab.epoch++; tab.refs.clear(); agentInput.clear(tab).catch(() => {}); break;
      }
      case 'import-avatars': await avatarStore.importFiles(); savePreferences(); break;
      case 'set-bot-avatar': avatarStore.set(value); savePreferences(); break;
      case 'remove-avatar': avatarStore.remove(value.avatarId); savePreferences(); break;
      case 'add-extension': await extensionStore.importFolder(); break;
      case 'pin-extension': extensionStore.pin(value.key, value.pinned); break;
      case 'enable-extension': extensionPopup?.destroy(); await extensionStore.setEnabled(value.key, value.enabled); break;
      case 'remove-extension': extensionPopup?.destroy(); await extensionStore.remove(value.key); break;
      case 'open-extension': await openExtension(value.key, value.anchor); break;
      case 'browse-extensions': createTab({ url: 'https://chromewebstore.google.com/category/extensions' }); break;
      case 'list-cookies': {
        const groups = new Map();
        for (const c of await session.fromPartition('persist:browser').cookies.get({})) {
          const d = (c.domain || '').replace(/^\./, '');
          groups.set(d, (groups.get(d) || 0) + 1);
        }
        return [...groups.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count);
      }
      case 'clear-cookies': {
        const domain = String(value?.domain || '');
        const jar = session.fromPartition('persist:browser').cookies;
        for (const c of await jar.get({})) {
          const d = (c.domain || '').replace(/^\./, '');
          if (domain && d !== domain && !d.endsWith(`.${domain}`)) continue;
          await jar.remove(`${c.secure ? 'https' : 'http'}://${d}${c.path || '/'}`, c.name).catch(() => {});
        }
        broadcast(); break;
      }
      case 'open-bot': await openBot(String(value.id)); break;
      case 'sort-bots': prefs.order = Array.isArray(value.ids) ? value.ids.filter((id) => prefs.bots.some((bot) => bot.id === id)) : prefs.order; savePreferences(); break;
      case 'bot-sort': if (['recent', 'alpha', 'manual'].includes(value.mode)) { prefs.botSort = value.mode; savePreferences(); } break;
      case 'hide-bot':
      case 'set-bot-visibility': {
        const id = String(value.id);
        if (!prefs.bots.some((bot) => bot.id === id)) throw new Error('Telegram bot not found. Sync your bot list and try again.');
        if (command === 'set-bot-visibility' && typeof value.visible !== 'boolean') throw new Error('Choose whether to show this bot.');
        if (command === 'set-bot-visibility' && value.visible) prefs.hidden = prefs.hidden.filter((hiddenId) => hiddenId !== id);
        else if (!prefs.hidden.includes(id)) prefs.hidden.push(id);
        savePreferences(); break;
      }
      case 'set-site-permission': sitePermissions.set(value); break;
      case 'reset-site-permissions': sitePermissions.reset(); break;
      case 'reload-intelio': {
        const requested = typeof value?.profileDir === 'string' ? value.profileDir.trim() : '';
        const next = requested ? loadIntelio({ profileDir: requested, prefs }) : loadIntelio({ argv: process.argv, prefs });
        intelioSession = next;
        if (next.ok && requested) prefs.intelioProfile = requested;
        applyIntelioChrome();
        if (!next.ok) { broadcast(); throw new Error(next.error || 'intelio profile failed to load.'); }
        break;
      }
      case 'fill-login': return rememberLogin(value);
      case 'vault-list':
        if (usesRemoteVault(prefs)) return remoteVault('logins', value);
        return { logins: loginVaultStore().list(vaultProfile(value)) };
      case 'vault-delete':
        if (usesRemoteVault(prefs)) return remoteVault('delete', value);
        return { logins: loginVaultStore().remove(vaultProfile(value), value.domain) };
      case 'fill-saved-login':
        if (usesRemoteVault(prefs)) return remoteVault('fill', value);
        return loginVaultStore().toolResult(vaultProfile(value), value.site);
      case 'settings':
        if (typeof value.macSshHost === 'string' && value.macSshHost.trim() && !isSshTarget(value.macSshHost.trim())) throw new Error(hostLabels(process.platform).sshInvalid);
        if (value.vpsBrowser && typeof value.vpsBrowser === 'object') { prefs.vpsBrowser={sshHost:String(value.vpsBrowser.sshHost || '').trim(),scriptPath:String(value.vpsBrowser.scriptPath || '').trim(),sudo:value.vpsBrowser.sudo===true}; vpsBrowserStatus='connecting'; refreshVpsTabs(); }
        if (Number.isFinite(value.agentIdleMinutes)) prefs.agentIdleMinutes = Math.max(1, Math.min(240, value.agentIdleMinutes));
        if (typeof value.remoteUrl === 'string') { parseRemoteUrl(value.remoteUrl); prefs.remoteUrl = value.remoteUrl; remoteStatus = 'disconnected'; prefs.remoteControl = false; }
        if (typeof value.preview === 'boolean') prefs.preview = value.preview;
        if (typeof value.showBots === 'boolean') prefs.showBots = value.showBots;
        if (typeof value.showBrowser === 'boolean') prefs.showBrowser = value.showBrowser;
        if (typeof value.macSshHost === 'string') prefs.macSshHost = value.macSshHost.trim();
        if (typeof value.autoOpenLinks === 'boolean') prefs.autoOpenLinks = value.autoOpenLinks;
        if (typeof value.primaryBotId === 'string') prefs.primaryBotId = prefs.bots.some((bot) => bot.id === value.primaryBotId) || value.primaryBotId === '' ? value.primaryBotId : prefs.primaryBotId;
        if (typeof value.intelioProfile === 'string') prefs.intelioProfile = value.intelioProfile.trim();
        if (['ask', 'block', 'approximate'].includes(value.locationDefault)) prefs.locationDefault = value.locationDefault;
        if (value.sidebarTab === 'agents' || value.sidebarTab === 'sessions') prefs.sidebarTab = value.sidebarTab;
        if (value.theme === 'light' || value.theme === 'dark') prefs.theme = value.theme;
        if ([1, 2, 3, 4].includes(Number(value.screenGrid))) prefs.screenGrid = Number(value.screenGrid);
        if (Number.isInteger(Number(value.activeScreen)) && Number(value.activeScreen) >= 0 && Number(value.activeScreen) < 4) prefs.activeScreen = Number(value.activeScreen);
        if (Number.isFinite(value.chatWidth)) prefs.chatWidth = Math.max(320, Math.min(680, value.chatWidth));
        savePreferences(); applyThemeChrome(); applyLayout(); break;
      case 'preview-move': {
        // The mini VM window floats anywhere inside the workspace pane.
        const x = Number(value.x), y = Number(value.y);
        if (Number.isFinite(x) && Number.isFinite(y)) { prefs.previewPos = { x: Math.round(x), y: Math.round(y) }; savePreferences(); }
        break;
      }
      case 'preview-nudge': {
        // The streamed desktop's own surface forwards drag deltas — the window
        // renderer owns the slot's position, so relay rather than duplicating.
        const dx = Number(value?.dx), dy = Number(value?.dy);
        if (Number.isFinite(dx) && Number.isFinite(dy) && win && !win.isDestroyed()) win.webContents.send('workspace:preview-nudge', { dx, dy });
        break;
      }
      case 'preview-drop': if (win && !win.isDestroyed()) win.webContents.send('workspace:preview-drop'); break;
      case 'remote-control': prefs.remoteControl = value.enabled === true; break;
      case 'remote-status': remoteStatus = String(value.status).slice(0, 50); break;
      case 'remote-vnc-password':
        if (event.sender !== remoteView?.webContents) throw new Error('Untrusted workspace request.');
        return remoteHermes?.vncPassword?.() || '';
      case 'remote-paste': if (!prefs.remoteControl || remoteStatus!=='connected') throw new Error('Take control of the connected VPS desktop first.'); return clipboard.readText().slice(0,20000);
      case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
      case 'open-settings': win.webContents.send('workspace:settings'); break;
      case 'focus-workspace': win.webContents.send('workspace:focus-workspace'); break;
      case 'copy-connection': clipboard.writeText(JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN }, null, 2)); break;
      case 'agent-setup': {
        const botId = String(value?.botId || prefs.selectedBotId || '').replace(/[^0-9A-Za-z_-]/g, '');
        if (!botId) throw new Error('Select a bot first — its ID goes in the agent config.');
        const bot = prefs.bots.find(item => item.id === botId);
        const macSsh = (prefs.macSshHost || '').trim();
        const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
        clipboard.writeText([
          "# intelio setup — paste into a terminal on the host running your Hermes gateway",
          `curl -fsSL ${agentsSetup} | bash -s -- --bot-id ${q(botId)}${bot ? ` --bot-name ${q(bot.name.replace(/'/g, ''))}` : ''}${macSsh ? ` --mac-ssh ${q(macSsh)}` : ''} --restart`,
          '# The bootstrap installs the plugin + hook, configures the browser connector,',
          '# offers to bind the primary route, restarts the gateway, and verifies itself.',
        ].join('\n'));
        break;
      }
      case 'agent-prompt': {
        const botId = String(value?.botId || prefs.selectedBotId || '').replace(/[^0-9A-Za-z_-]/g, '');
        const macSsh = (prefs.macSshHost || '').trim();
        const labels = hostLabels(process.platform);
        clipboard.writeText(`${labels.promptLead}
1. If Tailscale isn't installed or connected here, install it (tailscaled + \`tailscale up\`). Tell me this machine's tailnet name/IP when done. ${labels.promptSsh} ${macSsh || '<my-mac-tailscale>'}.
2. Fetch the bootstrap: git clone ${agents} (or \`git -C alans-way-agents pull\` if already cloned).
3. Run: ./alans-way-agents/setup.sh --bot-id '${botId || '<telegram-bot-id>'}' --mac-ssh '${macSsh || '<my-mac-tailscale>'}' --restart — answer its prompts; if it asks to bind a primary route, pick the bot matching this chat.
4. Report: plugin status, whether the browser host started, the workspace_browser block location, and anything it flagged. Then run ./alans-way-agents/setup.sh --verify and paste me the summary.
5. If the VPS needs a desktop/VNC stack for the browser host and none exists, tell me the exact apt commands it printed — don't install the display stack on your own.`);
        break;
      }
      case 'test-agent-path': {
        const host = (prefs.vpsBrowser?.sshHost || '').trim();
        const mac = (prefs.macSshHost || '').trim();
        if (!host) throw new Error('Save a VPS browser SSH host first.');
        const labels = hostLabels(process.platform);
        if (!mac) throw new Error(labels.sshMissing);
        if (!isSshTarget(mac)) throw new Error(labels.sshSavedInvalid);
        return new Promise((resolve) => {
          const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', host,
            `ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=yes ${mac} 'echo AGENT_PATH_OK'`], { timeout: 30000 });
          let out = '';
          child.stdout.on('data', chunk => { out += chunk; });
          child.stderr.on('data', chunk => { out += chunk; });
          child.on('error', () => resolve({ ok: false, detail: 'Could not start ssh — check local ssh access.' }));
          child.on('close', code => resolve(out.includes('AGENT_PATH_OK')
            ? { ok: true, detail: hostLabels(process.platform).sshOk }
            : { ok: false, detail: `Path check failed (exit ${code}). ${out.trim().slice(0, 300)}` }));
        });
      }
      case 'show-data': shell.openPath(app.getPath('userData')); break;
      case 'sync-telegram': telegramView.webContents.reload(); break;
      case 'open-username': {
        const username = String(value.username || '').replace(/^@/, '');
        if (!/^[A-Za-z][\w]{3,31}$/.test(username)) throw new Error('Enter a Telegram bot username.');
        const link = `tg://resolve?domain=${username}`;
        prefs.selectedBotId = '';
        await telegramView.webContents.loadURL(`${TELEGRAM}#?tgaddr=${encodeURIComponent(link)}`).catch(() => {});
        telegramView.webContents.reload(); break;
      }
      default: throw new Error('Unknown workspace command.');
    }
    broadcast(); return getState();
  });
  ipcMain.on('telegram:catalog', (event, value) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (!value || typeof value !== 'object') return;
    telegramStatus = ['connected', 'login', 'locked', 'loading'].includes(value.status) ? value.status : 'loading';
    telegramDiagnostics = value.diagnostics || {};
    if (value.accountId && /^\d+$/.test(value.accountId)) {
      if (prefs.accountId && prefs.accountId !== value.accountId) { prefs.bots = []; prefs.order = []; prefs.hidden = []; prefs.selectedBotId = ''; prefs.avatarPreferences = {}; }
      prefs.accountId = value.accountId;
      const bots = sanitizeBots(value.bots);
      const merged = new Map(prefs.bots.map((bot) => [bot.id, bot]));
      bots.forEach((bot) => merged.set(bot.id, bot));
      prefs.bots = [...merged.values()];
      if (value.selectedId && prefs.bots.some((bot) => bot.id === value.selectedId)) selectAgent(value.selectedId);
      if (!prefs.selectedBotId && prefs.bots.length && telegramStatus === 'connected') {
        const bot = prefs.bots.find((item) => !prefs.hidden.includes(item.id));
        if (bot) openBot(bot.id).catch(() => {});
      }
      savePreferences();
    }
    activity.setContext({ accountId: prefs.accountId, bots: prefs.bots, connected: telegramStatus === 'connected' });
    broadcast();
  });
  ipcMain.on('telegram:activity', (event, packet) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (activity.ingest(packet)) broadcast();
  });
  // The preload pulls the work map after attaching its listener so a send that
  // raced a reload can never wedge the signature dedup.
  ipcMain.on('workspace:bot-activity-pull', (event) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame) return;
    sendBotWork();
  });
  const linkOpenedAt = new Map();
  ipcMain.on('telegram:link', (event, value) => {
    if (event.sender !== telegramView?.webContents || event.senderFrame !== event.sender.mainFrame || !event.sender.getURL().startsWith(TELEGRAM)) return;
    if (prefs.autoOpenLinks === false) return;
    const chatId = String(value?.chatId || ''), url = String(value?.url || '').slice(0, 2048);
    if (!prefs.bots.some((bot) => bot.id === chatId) || !/^https?:\/\//i.test(url)) return;
    const now = Date.now();
    if (now - (linkOpenedAt.get(chatId) || 0) < 3000) return;
    linkOpenedAt.set(chatId, now);
    try {
      const normalized = normalizeUrl(url);
      const tab = createTab({ url: normalized, botId: chatId, controller: 'agent', activate: value.outgoing === true });
      recentLinkTabs.set(normalized, { tabId: tab.id, at: now });
      if (recentLinkTabs.size > 50) recentLinkTabs.clear();
    } catch {}
  });
}

const intParam = (url, key, min, max) => {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw Object.assign(new Error(`${key} must be an integer.`), { status: 400 });
  return Math.max(min, Math.min(max, value));
};
async function snapshot(tab, opts = {}) {
  const work = tab.queue.then(async () => {
    const generation = ++tab.generation;
    let timer;
    // A wedged renderer leaves executeJavaScript pending forever; bound it so
    // a snapshot can never outlive the connector's own timeout.
    const result = await Promise.race([
      tab.view.webContents.executeJavaScript(snapshotExpression(generation, { ...opts, keep: tab.snapshotStamp?.base })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Snapshot timed out after 10s. The page may be unresponsive.'), { status: 503 })), 10000); }),
    ]).finally(() => clearTimeout(timer));
    if (!result || !Array.isArray(result.elements)) throw Object.assign(new Error('Snapshot returned no page data.'), { status: 503 });
    return { ...settleSnapshot(tab, result, generation, opts.since), tab: describeTab(tab) };
  });
  tab.queue = work.catch(() => {});
  return work;
}
async function navigateVps(id,url) {
  await remoteRequest(id,'control',{controller:'human'});
  await remoteRequest(id,'human-actions',{action:'navigate',url:normalizeUrl(url)});
}
async function handoffTab({id,destination,includeDrafts=false,note=''}) {
  const source=tabs.get(id) || vpsTabs.get(id); if(!source)throw new Error('Source tab not found.');
  const sourceHost=tabs.has(id)?'mac':'vps';
  if(!['mac','vps'].includes(destination)||destination===sourceHost)throw new Error('Choose the other computer.');
  if(sourceHost==='mac') { changeController(id,'human'); await source.queue; }
  else await remoteRequest(id,'control',{controller:'human'});
  const checkpoint=sourceHost==='mac'?await source.view.webContents.executeJavaScript(checkpointExpression(includeDrafts)):await remoteRequest(id,'checkpoint',{includeDrafts});
  if(!/^https?:\/\//.test(checkpoint.url))throw new Error('Open a web page before handing it off.');
  const handoff={id:crypto.randomUUID(),sourceHost,sourceTabId:id,destinationHost:destination,createdAt:Date.now(),note:String(note).slice(0,4000),phase:'review_required'};
  let target,result;
  if(destination==='vps') {
    target=await vpsBrowser.request('/v1/tabs','POST',{url:checkpoint.url},{botId:source.botId,human:true});vpsTabs.set(target.id,target);
    result=await remoteRequest(target.id,'restore',{checkpoint,handoff});target=result.tab;
  } else {
    target=createTab({url:checkpoint.url,botId:source.botId,controller:'human',activate:false});target.handoff=handoff;
    for(let n=0;n<100;n++){if(!target.view.webContents.isLoading()&&target.view.webContents.getURL()!=='about:blank')break;await new Promise(r=>setTimeout(r,100));}
    if(target.view.webContents.isLoading()){try{closeTab(target.id)}catch{}throw new Error('Mac destination is still loading. Its tab was closed — retry the handoff.');}
    result=await target.view.webContents.executeJavaScript(restoreExpression(checkpoint));
  }
  const record={...handoff,destinationTabId:target.id,verification:result.verification,restoredDrafts:result.restored,skippedDrafts:result.skipped};
  if(destination==='mac')target.handoff=record;
  else {target.handoff=record;vpsTabs.set(target.id,target);}
  const retired={id:record.id,phase:'handed_off',sourceHost,destinationHost:destination,destinationTabId:target.id,createdAt:record.createdAt};
  if(sourceHost==='mac')source.handoff=retired;
  else record.sourceRetired=await remoteRequest(id,'control',{controller:'human',handoff:retired}).then(()=>true,()=>false);
  prefs.remoteControl=false; prefs.handoffs=[record,...prefs.handoffs].slice(0,20);activeTabId=destination==='vps'?'vps':target.id;
  if(destination==='vps')await remoteRequest(target.id,'activate',{});
  savePreferences();applyLayout();broadcast();return record;
}
// History navigation has no promise. Listeners go on before the trigger so a
// fast (cached or same-document) navigation cannot finish unobserved.
function settleNavigation(wc, trigger, timeout = 15000) {
  return new Promise((resolve) => {
    const events = ['did-stop-loading', 'did-navigate-in-page', 'destroyed'];
    const done = () => { clearTimeout(timer); for (const name of events) wc.off(name, done); resolve(); };
    const timer = setTimeout(done, timeout);
    for (const name of events) wc.on(name, done);
    try { trigger(); } catch { done(); }
  });
}
function browserCommand(tab, method, params) {
  const wc = tab.view.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  return wc.debugger.sendCommand(method, params);
}
async function captureTab(tab, { format = 'png', quality = 80, maxWidth = 0 } = {}) {
  const capture = backgroundCaptureQueue.then(async () => {
    const wc = tab.view.webContents;
    const encode = async () => {
      if (format === 'webp') {
        // nativeImage has no webp encoder; the compositor does, and clip.scale
        // downscales at capture instead of a full-size decode then resize.
        const size = await wc.executeJavaScript('({ width: innerWidth, height: innerHeight, dsf: devicePixelRatio })');
        const scale = maxWidth && size.width * size.dsf > maxWidth ? Math.max(0.01, maxWidth / size.width) : size.dsf;
        const shot = await browserCommand(tab, 'Page.captureScreenshot', { format: 'webp', quality, fromSurface: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale } });
        return shot.data;
      }
      let image = await wc.capturePage(undefined, { stayHidden: true });
      if (maxWidth && image.getSize().width > maxWidth) image = image.resize({ width: maxWidth });
      return (format === 'jpeg' ? image.toJPEG(quality) : image.toPNG()).toString('base64');
    };
    if (tab.host === win) return encode();
    // Hidden tabs share one host. Bring only this surface to its top while
    // capturing; never reparent it into the human's window or change selection.
    if (tab.host.contentView.children.at(-1) !== tab.view) tab.host.contentView.addChildView(tab.view);
    // Agent input keeps its own per-tab focus hold — don't steal or release it.
    const heldFocus = tab.focusEmulation === true;
    if (!heldFocus) await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    try {
      await wc.executeJavaScript('new Promise(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })');
      return await encode();
    }
    finally { if (!heldFocus && !wc.isDestroyed()) await browserCommand(tab, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {}); }
  });
  backgroundCaptureQueue = capture.catch(() => {});
  return capture;
}
async function performAction(tab, body, botId, depth = 0) {
  const overseer = isOverseer(botId);
  requireActor(tab, botId, body.epoch, true, overseer);
  const wc = tab.view.webContents;
  if (body.action === 'batch') {
    if (depth > 0) throw Object.assign(new Error('Batches cannot nest.'), { status: 400 });
    const steps = Array.isArray(body.steps) ? body.steps.slice(0, 25) : [];
    if (!steps.length) throw Object.assign(new Error('batch needs a non-empty steps array (max 25).'), { status: 400 });
    const results = [], started = Date.now();
    for (const step of steps) {
      if (!step || typeof step !== 'object') { results.push({ error: 'Invalid step.' }); break; }
      if (Date.now() - started > BATCH_BUDGET_MS) { results.push({ error: `batch stopped after ${BATCH_BUDGET_MS / 1000}s; remaining steps were not run. Snapshot, then continue.` }); break; }
      try { results.push(await performAction(tab, { ...step, epoch: body.epoch }, botId, 1)); }
      catch (error) { results.push({ error: error.message }); break; }
    }
    return { results, tab: describeTab(tab), dispatched: true };
  }
  if (body.action === 'eval') {
    const code = String(body.code || '');
    if (!code || code.length > 16384) throw Object.assign(new Error('eval needs a code string (max 16KB).'), { status: 400 });
    const wc = tab.view.webContents;
    let value = await Promise.race([
      wc.executeJavaScript(code, true),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('eval timed out after 15s.'), { status: 408 })), 15000)),
    ]);
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
    return { value, tab: describeTab(tab), dispatched: true };
  }
  if (body.action === 'wait') {
    const selector = String(body.selector || '').slice(0, 2000);
    const text = String(body.text || '').slice(0, 2000);
    const urlPart = String(body.url || '').slice(0, 2000);
    const visible = body.visible === true;
    const timeout = Math.min(Math.max(Number(body.timeout) || 10000, 100), 30000);
    if (!selector && !text && !urlPart) throw Object.assign(new Error('wait needs a selector, text, or url to wait for.'), { status: 400 });
    const waitCode = (ms) => `new Promise((resolve) => {
      const sel = ${JSON.stringify(selector)}, txt = ${JSON.stringify(text)}, urlP = ${JSON.stringify(urlPart)}, vis = ${visible};
      const deadline = Date.now() + ${ms};
      const check = () => {
        if (urlP && !location.href.includes(urlP)) return false;
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return false;
          if (vis) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return false;
            if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
          }
        }
        if (txt && !(document.body && document.body.innerText.includes(txt))) return false;
        return true;
      };
      const t0 = Date.now();
      let mo, poll;
      const done = (found) => { clearInterval(poll); if (mo) mo.disconnect(); resolve({ found, waited: Date.now() - t0 }); };
      if (check()) return done(true);
      mo = new MutationObserver(() => { if (check()) done(true); });
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      poll = setInterval(() => { if (check() || Date.now() > deadline) done(check()); }, 100);
      setTimeout(() => done(check()), ${ms});
    })`;
    const hostStart = Date.now();
    let value = null;
    while (Date.now() - hostStart < timeout + 1000) {
      const remaining = Math.max(400, timeout - (Date.now() - hostStart));
      const attempt = await Promise.race([
        wc.executeJavaScript(waitCode(remaining), true).catch(() => ({ navRetry: true })),
        new Promise((r) => setTimeout(() => r({ navRetry: true }), remaining + 1500)),
      ]);
      if (attempt && !attempt.navRetry) { value = attempt; break; }
      if (urlPart && wc.getURL().includes(urlPart)) { value = { found: true, waited: Date.now() - hostStart }; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!value || !value.found) throw Object.assign(new Error(`wait timed out after ${value ? value.waited : Date.now() - hostStart}ms for ${[selector && `selector ${JSON.stringify(selector)}`, text && `text ${JSON.stringify(text.slice(0, 80))}`, urlPart && `url containing ${JSON.stringify(urlPart.slice(0, 80))}`].filter(Boolean).join(' and ')}. Snapshot the page to see its current state.`), { status: 408 });
    return { waited: value.waited, tab: describeTab(tab), dispatched: true };
  }
  if (body.action === 'viewport') {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    if (body.clear === true) {
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
      delete tab.viewport;
      return { viewport: null, tab: describeTab(tab), dispatched: true };
    }
    const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
    const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 5);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 7680 || height < 100 || height > 4320)
      throw Object.assign(new Error('viewport needs width 100-7680 and height 100-4320, or clear:true.'), { status: 400 });
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    tab.viewport = { width, height, scale };
    broadcast();
    return { viewport: tab.viewport, tab: describeTab(tab), dispatched: true };
  }
  if (body.action === 'cdp') {
    const method = String(body.method || '');
    if (!/^(Page|Runtime|Input|Emulation|Network|DOM|DOMSnapshot|Accessibility|CSS|Log|Fetch|Storage)\.[a-zA-Z]+$/.test(method))
      throw Object.assign(new Error('Unsupported CDP method. Allowed domains: Page, Runtime, Input, Emulation, Network, DOM, DOMSnapshot, Accessibility, CSS, Log, Fetch, Storage.'), { status: 400 });
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    if (JSON.stringify(params).length > 64000) throw Object.assign(new Error('cdp params too large (max 64KB).'), { status: 400 });
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    let value = await Promise.race([
      wc.debugger.sendCommand(method, params),
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('cdp timed out after 20s.'), { status: 408 })), 20000)),
    ]);
    const cdpSerialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (cdpSerialized && cdpSerialized.length > 48000) value = cdpSerialized.slice(0, 48000) + '…[truncated]';
    return { value, tab: describeTab(tab), dispatched: true };
  }
  if (['click', 'type', 'press', 'scroll', 'move'].includes(body.action)) {
    const result = await agentInput.perform(tab, body, botId);
    if (body.action !== 'move') tab.refs.clear();
    broadcast();
    return { ...result, tab: describeTab(tab), dispatched: true };
  }
  if (body.action === 'navigate') {
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true, overseer);
    const target = pageUrl(body.url);
    assertIntelioAgentUrl(target);
    // loadURL resolves only at did-finish-load — far past the connector's own
    // abort. Cap the wait at commit+settle; the caller reads `loading` and can
    // snapshot to follow a still-loading page.
    const outcome = await Promise.race([
      wc.loadURL(target).then(() => 'loaded', (error) => ({ error })),
      new Promise(resolve => setTimeout(() => resolve('loading'), 12000)),
    ]);
    if (outcome === 'loading') { tab.refs.clear(); broadcast(); return { loading: true, url: target, tab: describeTab(tab), dispatched: true }; }
    if (outcome !== 'loaded') throw outcome.error;
  } else if (['back', 'forward', 'reload'].includes(body.action)) {
    await agentInput.clear(tab);
    requireActor(tab, botId, body.epoch, true, overseer);
    const history = wc.navigationHistory;
    const go = body.action === 'back' ? history.canGoBack() && (() => history.goBack())
      : body.action === 'forward' ? history.canGoForward() && (() => history.goForward())
      : () => wc.reload();
    if (go) await settleNavigation(wc, go);
  } else throw Object.assign(new Error('Supported actions: navigate, click, type, press, move, scroll, back, forward, reload, batch, eval, wait, viewport, cdp.'), { status: 400 });
  tab.refs.clear(); broadcast();
  return { tab: describeTab(tab), dispatched: true };
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 100000) throw Object.assign(new Error('Request too large.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function startApi() {
  apiServer = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    // No browser-origin requests or CORS: this endpoint is for the paired native connector.
    if (req.headers.origin || !isAuthorized(req.headers.authorization, API_TOKEN)) return send(401, { error: 'Unauthorized' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const botId = String(req.headers['x-hermes-bot'] || '');
      const overseer = isOverseer(botId);
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { name: app.getName(), version: app.getVersion(), protocol: 1, host: 'mac', hosts:{mac:'connected',vps:vpsBrowserStatus}, capabilities: ['tabs', 'snapshot', 'screenshot', 'navigate', 'click', 'type', 'press', 'move', 'scroll', 'batch', 'eval', 'wait', 'viewport', 'cdp', 'agent-cursor', 'background-input', 'control-epochs'], tabCount: tabs.size+vpsTabs.size });
      if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
        const appearance = await telegramView.webContents.executeJavaScript(`(() => ({
          styled: document.body.classList.contains('hw-chat'),
          composerCount: document.querySelectorAll('.Composer').length,
          middleClasses: document.querySelector('#MiddleColumn')?.className || '',
          middleChildren: [...(document.querySelector('#MiddleColumn')?.children || [])].map(el => ({ tag: el.tagName, id: el.id, className: String(el.className), background: getComputedStyle(el).backgroundImage, display: getComputedStyle(el).display })),
        }))()`).catch(() => ({}));
        const activityStates = prefs.bots.map(bot => activity.get(bot.id).state);
        return send(200, { telegram: { status: telegramStatus, ...telegramDiagnostics, appearance,
          activity: { available: activityStates.some(state => state !== 'unknown'), activeBots: activityStates.filter(state => state === 'active').length } }, remote: remoteStatus,
          window: { visible: win.isVisible(), focused: win.isFocused() } });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'GET') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        // The 5s timer already keeps vpsTabs warm; a blocking SSH refresh here
        // cost seconds on a read-only list call. Serve the cache, refresh async.
        if(prefs.vpsBrowser?.sshHost)refreshVpsTabs();
        return send(200, { tabs: [...tabs.values()].filter(tab => !tab.extensionPage).map(describeTab).concat([...vpsTabs.values()]).filter((tab) => overseer || tab.botId === botId || (tab.allowedBots ?? []).includes(botId)) });
      }
      if (url.pathname === '/v1/tabs' && req.method === 'POST') {
        if (!botId || botId.length > 100) throw Object.assign(new Error('X-Hermes-Bot is required.'), { status: 400 });
        const body = await readJson(req);
        if(body.host==='vps'){const result=await vpsBrowser.request('/v1/tabs','POST',body,{botId,botName:nameForBot(botId)});vpsTabs.set(result.id,result);broadcast();return send(201,result);}
        if(body.host!==undefined&&body.host!=='mac')throw new Error('Choose mac or vps explicitly.');
        { const created = createTab({ url: body.url, botId, controller: 'agent', activate: body.background === false }); created.agentSince = Date.now();
          // Answer after commit (not full load): the first snapshot or eval then
          // sees the real document instead of racing about:blank. Cap the wait
          // so a slow site still returns promptly — `loading` reports the rest.
          if (/^https?:\/\//i.test(pageUrl(body.url))) {
            const wc = created.view.webContents;
            await new Promise(resolve => {
              const done = () => { clearTimeout(timer); wc.removeListener('did-navigate', done).removeListener('did-fail-load', failed).removeListener('destroyed', done); resolve(); };
              const failed = (_e, _c, _d, _u, main) => { if (main) done(); };
              const timer = setTimeout(done, 1500);
              wc.once('did-navigate', done); wc.on('did-fail-load', failed); wc.once('destroyed', done);
            });
          }
          return send(201, describeTab(created)); }
      }
      const match = /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions|control))?$/.exec(url.pathname);
      const tab = match && tabs.get(match[1]);
      if(match&&!tab&&prefs.vpsBrowser?.sshHost){
        const result=await vpsBrowser.request(url.pathname+url.search,req.method,req.method==='POST'?await readJson(req):undefined,{botId,botName:nameForBot(botId),epoch:Number(req.headers['x-control-epoch'])});
        const remote=result.tab || (result.id?result:null);if(remote)vpsTabs.set(remote.id,remote);if(req.method==='DELETE')vpsTabs.delete(match[1]);broadcast();return send(200,result);
      }
      if (!tab || tab.extensionPage) return send(404, { error: 'Tab not found.' });
      // Shared tabs are claimable by any known bot via POST control; the
      // per-endpoint gates still fence reads/actions until it is claimed.
      requireActor(tab, botId, undefined, false, overseer || (tab.botId === 'shared' && prefs.bots.some((bot) => bot.id === botId)));
      if (req.method === 'GET' && !match[2]) return send(200, describeTab(tab));
      tab.lastAgentActivity = Date.now();
      if (req.method === 'GET' && match[2] === 'snapshot') { requireAgentRead(tab);
        return send(200, await snapshot(tab, { maxChars: intParam(url, 'maxChars', 0, 20000), maxElements: intParam(url, 'maxElements', 0, 300), since: intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER) }));
      }
      if (req.method === 'GET' && match[2] === 'screenshot') { requireAgentRead(tab);
        const format = url.searchParams.get('format') ?? 'jpeg';
        if (!['jpeg', 'png', 'webp'].includes(format)) throw Object.assign(new Error('format must be jpeg, png, or webp.'), { status: 400 });
        const quality = intParam(url, 'quality', 1, 100) ?? 70;
        const maxWidth = intParam(url, 'maxWidth', 1, 10000) ?? 1280;
        const capture = tab.queue.then(async () => {
          const base64 = await captureTab(tab, { format, quality, maxWidth });
          const viewport = await tab.view.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })');
          return { base64, viewport };
        });
        tab.queue = capture.catch(() => {});
        const { base64, viewport } = await capture;
        return send(200, { mimeType: { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }[format], base64, viewport, tab: describeTab(tab) });
      }
      if (req.method === 'POST' && match[2] === 'actions') {
        const body = await readJson(req);
        tab.pendingActions = (tab.pendingActions || 0) + 1;
        const action = tab.queue.then(() => performAction(tab, body, botId))
          .finally(() => { tab.pendingActions--; tab.lastAgentActivity = Date.now(); });
        tab.queue = action.catch(() => {});
        return send(200, await action);
      }
      if (req.method === 'POST' && match[2] === 'control') {
        const body = await readJson(req);
        const granted = (tab.allowedBots || []).includes(botId)
          || (tab.botId === 'shared' && prefs.bots.some((bot) => bot.id === botId));
        if (botId !== tab.botId && !overseer && !granted) throw Object.assign(new Error('Only the owning bot can change control.'), { status: 403 });
        if (body.controller === 'agent') { requireAgentClaim(tab); tab.handoff = reviewedHandoff(tab.handoff); }
        if (tab.botId === 'shared' && body.controller === 'agent') tab.botId = botId;
        return send(200, changeController(tab.id, body.controller));
      }
      if (req.method === 'DELETE' && !match[2]) { requireActor(tab, botId, Number(req.headers['x-control-epoch']), true, overseer); closeTab(tab.id); return send(200, { closed: true }); }
      return send(405, { error: 'Method not supported.' });
    } catch (error) { send(error.status || 400, { error: error.message }); }
  });
  apiServer.requestTimeout = 30000;
  apiServer.on('error', (error) => { apiError = error.message; broadcast(); });
  const envPort = Number(process.env.HERMES_WORKSPACE_PORT);
  apiServer.listen(Number.isInteger(envPort) && envPort >= 0 && envPort < 65536 ? envPort : 9464, '127.0.0.1', () => {
    apiPort = apiServer.address().port;
    writePrivateJson(path.join(app.getPath('userData'), 'connection.json'), { url: `http://127.0.0.1:${apiPort}`, token: API_TOKEN, protocol: 1 });
    broadcast();
  });
}
function createWindow() {
  const bootTheme = currentTheme();
  nativeTheme.themeSource = bootTheme;
  const windowOptions = { width: 1550, height: 980, minWidth: 1120, minHeight: 680, backgroundColor: bootTheme === 'light' ? '#f6f6f8' : (intelioSession?.public?.brand?.tokens?.background || '#0a0a0a'), title: intelioTitle(), icon: nativeImage.createFromBuffer(pngIcon()),
    webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: rendererSandbox() } };
  if (process.platform === 'darwin') { windowOptions.titleBarStyle = 'hiddenInset'; windowOptions.trafficLightPosition = { x: 18, y: 18 }; }
  win = new BrowserWindow(windowOptions);
  installAppMicrophone(win.webContents.session, (wc) => appMediaPage(wc?.getURL?.(), ROOT));
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(intelioTitle());
  });
  telegramView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'telegram-preload.bundle.cjs'), partition: 'persist:telegram', contextIsolation: true, nodeIntegration: false, sandbox: rendererSandbox() } });
  telegramView.setBackgroundColor('#09090a');
  configureContents(telegramView.webContents, true);
  telegramView.webContents.on('did-start-loading', () => { lastBotWorkSignature = ''; activity.clear(); broadcast(); });
  telegramView.webContents.on('did-finish-load', () => { pushedTelegramTheme = ''; applyThemeChrome(); });
  telegramView.webContents.on('render-process-gone', () => { telegramStatus = 'offline'; activity.clear(); broadcast(); });
  telegramView.webContents.on('did-fail-load', (_e, code, _desc, _url, main) => { if (main && code !== -3) { telegramStatus = 'offline'; activity.clear(); broadcast(); } });
  win.contentView.addChildView(telegramView);
  remoteView = new WebContentsView({ webPreferences: { preload: path.join(ROOT, 'preload.bundle.cjs'), partition: 'persist:intelio-cloud', contextIsolation: true, nodeIntegration: false, sandbox: rendererSandbox() } });
  remoteView.setBackgroundColor('#101011');
  remoteView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  remoteView.webContents.on('will-navigate', (event) => event.preventDefault());
  remoteView.webContents.on('before-input-event',(event,input)=>{
    if(prefs.remoteControl && remoteStatus==='connected' && input.meta && input.type==='keyDown' && /^[altrwf]$/i.test(input.key)){
      event.preventDefault();remoteView.webContents.send('workspace:remote-shortcut',{key:input.key.toLowerCase(),shift:input.shift});
    }
  });
  win.contentView.addChildView(remoteView);
  registerIpc();
  const stampTheme = (contents) => {
    if (!contents || contents.isDestroyed()) return;
    const theme = currentTheme();
    const vars = themeVars(theme);
    const paint = vars
      ? `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)};${Object.entries(vars).map(([key, value]) => `document.documentElement.style.setProperty(${JSON.stringify(key)},${JSON.stringify(value)})`).join(';')}`
      : `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`;
    contents.executeJavaScript(paint).catch(() => {});
  };
  win.webContents.on('did-finish-load', () => stampTheme(win.webContents));
  remoteView.webContents.on('did-finish-load', () => stampTheme(remoteView.webContents));
  win.loadFile(path.join(ROOT, 'index.html'));
  remoteView.webContents.loadFile(path.join(ROOT, 'remote.html'));
  const remoteOn = Boolean(prefs?.remoteHermes?.enabled && prefs?.remoteHermes?.host);
  if (!remoteOn) telegramView.webContents.loadURL(prefs.selectedBotId ? `${TELEGRAM}#${prefs.selectedBotId}` : TELEGRAM).catch(() => {});
  for (const item of prefs.savedTabs.slice(0, 12)) { try { createTab({ url: item.url, botId: item.botId, client: item.client || '', activate: false }); } catch {} }
  activeTabId = initialDesktopTab(remoteOn);
  win.on('enter-full-screen', broadcast); win.on('leave-full-screen', broadcast);
  win.on('close', (event) => { if (!isQuitting) { event.preventDefault(); win.hide(); } });
  // The app-name menu and hide/zoom/front roles are macOS conventions; Windows and Linux
  // get About under Help and Quit under File instead.
  const isMac = process.platform === 'darwin';
  const aboutItem = { label: 'About intelio', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About intelio', message: `intelio ${app.getVersion()}`, detail: "Alan's Way by Alex Hansen (MIT). Hermes Agent by Nous Research." }) };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: 'intelio', submenu: [aboutItem, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'New Browser Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab({}) }, { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => extensionPopup?.browserWindow?.isFocused() ? extensionPopup.destroy() : closeTab(activeTabId) }, ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Quit intelio' }])] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Reload Page', accelerator: 'CmdOrCtrl+R', click: () => tabs.get(activeTabId)?.view.webContents.reload() }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ label: 'App Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => win.webContents.toggleDevTools() }])] },
    { label: 'Window', submenu: [{ label: 'Remote Hermes (VPS)', accelerator: 'CmdOrCtrl+Shift+H', click: () => remoteHermes.open() }, { type: 'separator' }, { role: 'minimize' }, ...(isMac ? [{ role: 'zoom' }, { role: 'front' }] : [{ role: 'close' }])] },
    ...(isMac ? [] : [{ label: 'Help', submenu: [aboutItem] }]),
  ]));
  startApi();
  // Read the real pointer position, even over native child views or another app.
  // This never installs a global input hook or moves the system cursor.
  // Every 100 ms, and only when the position actually changed, so an idle
  // pointer costs no IPC.
  let lastPointer = '';
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    const point = screen.getCursorScreenPoint(), bounds = win.getContentBounds();
    const zoom = win.webContents.getZoomFactor();
    const next = { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom };
    const signature = `${Math.round(next.x)},${Math.round(next.y)}`;
    if (signature === lastPointer) return;
    lastPointer = signature;
    win.webContents.send('workspace:pointer', next);
  }, 100);
  pointerTimer.unref();
  activityTimer = setInterval(() => { if (activity.expire() || JSON.stringify(computeBotWork()) !== lastBotWorkSignature) broadcast(); }, 500);
  activityTimer.unref();
  idleTimer = setInterval(() => {
    const idleMs = Math.max(1, Number(process.env.HERMES_AGENT_IDLE_MINUTES) || prefs.agentIdleMinutes || 15) * 60000, now = Date.now();
    for (const tab of tabs.values()) {
      if (tab.controller !== 'agent' || tab.extensionPage || tab.pendingActions > 0 || agentInput.isDispatching(tab)) continue;
      if (now - Math.max(tab.agentSince || 0, tab.lastAgentActivity || 0) > idleMs) changeController(tab.id, 'human');
    }
  }, 30000).unref();
  vpsTimer=setInterval(refreshVpsTabs,5000);vpsTimer.unref();refreshVpsTabs();
}
if (process.argv.includes('--smoke-test')) {
  const { runPackagedSmoke } = require('./intelio/smoke.cjs');
  app.whenReady().then(() => {
    let code = 1;
    try {
      code = runPackagedSmoke();
      process.stdout.write(code === 0 ? 'smoke ok\n' : 'smoke failed\n');
    } catch (error) {
      process.stderr.write(`${error && error.stack || error}\n`);
      code = 1;
    }
    app.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error && error.stack || error}\n`);
    app.exit(1);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    app.setAccessibilitySupportEnabled(true);
    pinUserData();
    prefs = readPreferences();
    prefs.remoteControl = false;
    if (process.env.INTELIO_E2E === '1') {
      process.stderr.write('intelio e2e: skip profile loader\n');
      intelioSession = { ok: false, error: 'e2e', browsingOrigins: [], public: { ok: false, error: 'Profile skipped for the packaged check.', brand: { windowTitle: 'intelio', tokens: {} }, hermes: {} } };
    } else {
      intelioSession = loadIntelio({ argv: process.argv, prefs });
    }
    remoteHermes = setupRemoteHermes({ app, BrowserWindow, ipcMain, safeStorage, shell, getPrefs: () => prefs, savePreferences, getMainWindow: () => win, root: ROOT, rendererSandbox,
      icon: nativeImage.createFromBuffer(pngIcon()), background: intelioSession?.public?.brand?.tokens?.background, session, net });
    remoteHermes.watchVersion(() => broadcast());
    try { parseRemoteUrl(prefs.remoteUrl); } catch { prefs.remoteUrl = ''; }
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const browserSession = session.fromPartition('persist:browser');
    extensionHost = new ElectronChromeExtensions({ license: 'GPL-3.0', session: browserSession,
      createTab: async details => { const tab = createTab({ url: details.url || 'about:blank', activate: details.active !== false, extensionPage: isExtensionUrl(details.url) }); return [tab.view.webContents, win]; },
      selectTab: wc => { if (isQuitting || registeringExtensionTab) return; const tab = [...tabs.values()].find(item => item.view.webContents === wc); if (tab) { activeTabId = tab.id; prefs.remoteControl = false; applyLayout(); broadcast(); } else BrowserWindow.fromWebContents(wc)?.show(); },
      removeTab: (wc, window) => { if (isQuitting) return; const tab = [...tabs.values()].find(item => item.view.webContents === wc); if (tab) closeTab(tab.id); else if (window !== win && window !== backgroundWindow && !window?.isDestroyed()) window?.close(); },
      createWindow: async details => {
        const popup = new BrowserWindow({ parent: win, width: details.width || 640, height: details.height || 720, webPreferences: { session: browserSession, sandbox: rendererSandbox(), contextIsolation: true, nodeIntegration: false } });
        extensionHost.addTab(popup.webContents, popup); configureContents(popup.webContents);
        const url = Array.isArray(details.url) ? details.url[0] : details.url || 'about:blank';
        await popup.loadURL(isExtensionUrl(url) ? url : normalizeUrl(url)); return popup;
      },
      removeWindow: window => { if (window.isDestroyed()) return; if (window === win) throw new Error('The workspace window cannot be closed by an extension.'); window.close(); },
      requestPermissions: async (extension, permissions) => {
        if (!win?.isFocused() || activeTabId === 'vps') return false;
        const answer = await dialog.showMessageBox(win, { type: 'question', message: `${extension.name} requests additional access`, detail: [...(permissions.permissions || []), ...(permissions.origins || [])].join('\n'), buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0 });
        return answer.response === 1;
      } });
    for (const type of ['frame', 'service-worker']) browserSession.registerPreloadScript({ id: `hermes-extension-namespace-${type}`, type, filePath: path.join(ROOT, 'extension-namespace-preload.cjs') });
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
    extensionHost.on('browser-action-popup-created', popup => {
      extensionPopup = popup; extensionPopupTabId = activeTabId;
      popup.browserWindow?.once('closed', () => { if (extensionPopup === popup) extensionPopup = undefined; });
      popup.browserWindow?.webContents.setWindowOpenHandler(({ url }) => { createTab({ url, extensionPage: isExtensionUrl(url) }); return { action: 'deny' }; });
    });
    extensionStore = createExtensionStore({ root: app.getPath('userData'), session: browserSession, dialog, nativeImage, getWindow: () => win, getPreferences: () => prefs, savePreferences, onChanged: broadcast,
      canInstall: frame => [...tabs.values()].some(tab => tab.id === activeTabId && tab.controller === 'human' && tab.view.webContents.mainFrame === frame && !layout.obscured) });
    if (process.env.INTELIO_E2E === '1') process.stderr.write('intelio e2e: open window\n');
    else await extensionStore.installStore();
    createWindow();
    if (process.env.INTELIO_E2E !== '1') await extensionStore.restore();
    broadcast();
    if (process.env.INTELIO_E2E === '1') process.stderr.write('intelio e2e: window ready\n');
    if (tailscaleFirstRun && process.env.INTELIO_E2E !== '1') {
      const remoteReady = (async () => {
        const start = Date.now();
        while (Date.now() - start < 8000) {
          const remote = remoteHermes?.publicState?.() || {};
          if (remote.activeMode === 'cloud' || remote.activeMode === 'tailscale') return remote;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return remoteHermes?.publicState?.() || {};
      })();
      Promise.all([checkTailscale(), remoteReady]).then(async ([status, remote]) => {
        if (remote?.activeMode === 'cloud' || remote?.connection === 'cloud') return;
        const prompt = firstRunMessage(status);
        if (!prompt || !win || win.isDestroyed()) return;
        const buttons = prompt.install ? ['Install Tailscale', 'Later'] : ['OK'];
        const answer = await dialog.showMessageBox(win, {
          type: 'info', buttons, defaultId: 0, cancelId: buttons.length - 1, message: prompt.message, detail: prompt.detail,
        });
        if (prompt.install && answer.response === 0) await shell.openExternal(status.installUrl);
      }).catch(() => {});
    }
  });
  // show() alone does not un-minimize on Windows; restore first so relaunching brings the window back.
  app.on('second-instance', () => { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
  app.on('activate', () => { win?.show(); win?.focus(); });
  app.on('before-quit', () => { isQuitting = true; clearInterval(pointerTimer); clearInterval(activityTimer); clearInterval(idleTimer); clearInterval(vpsTimer); savePreferences(); apiServer?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
