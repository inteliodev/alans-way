'use strict';
/**
 * Client apps: the work accounts each client runs on (Google Workspace or Microsoft 365) and the
 * web apps the Sessions tab opens for them. Shared by the main process (which builds the URL and
 * picks the client's own browser partition) and the renderer (which draws the icons).
 *
 * Each client gets its own persistent browser partition, so PRC's Google sign-in and HHP's
 * Microsoft sign-in stay logged in side by side and never share cookies. Nothing here signs in,
 * stores a password, or gives an agent access: that is the agent's own Hermes connection.
 */
(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IntelioClientApps = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const GOOGLE = 'google';
  const MICROSOFT = 'microsoft';

  /** Web apps per suite. `primary` ones sit on the row; the rest are under More. */
  const SUITES = {
    [GOOGLE]: [
      { id: 'mail', label: 'Gmail', icon: 'mail', url: 'https://mail.google.com/mail/', primary: true },
      { id: 'calendar', label: 'Calendar', icon: 'calendar', url: 'https://calendar.google.com/calendar/', primary: true },
      { id: 'drive', label: 'Drive', icon: 'drive', url: 'https://drive.google.com/drive/', primary: true },
      { id: 'chat', label: 'Google Chat', icon: 'chat', url: 'https://chat.google.com/', primary: true },
      { id: 'meet', label: 'Meet', icon: 'video', url: 'https://meet.google.com/' },
      { id: 'docs', label: 'Docs', icon: 'doc', url: 'https://docs.google.com/document/' },
      { id: 'sheets', label: 'Sheets', icon: 'sheet', url: 'https://docs.google.com/spreadsheets/' },
      { id: 'slides', label: 'Slides', icon: 'slides', url: 'https://docs.google.com/presentation/' },
    ],
    [MICROSOFT]: [
      { id: 'mail', label: 'Outlook', icon: 'mail', url: 'https://outlook.office.com/mail/', primary: true },
      { id: 'calendar', label: 'Calendar', icon: 'calendar', url: 'https://outlook.office.com/calendar/', primary: true },
      { id: 'teams', label: 'Teams', icon: 'chat', url: 'https://teams.microsoft.com/', primary: true },
      { id: 'onedrive', label: 'OneDrive', icon: 'drive', url: 'https://www.office.com/launch/onedrive', primary: true },
      { id: 'sharepoint', label: 'SharePoint', icon: 'folder', url: 'https://www.office.com/launch/sharepoint' },
      { id: 'word', label: 'Word', icon: 'doc', url: 'https://www.office.com/launch/word' },
      { id: 'excel', label: 'Excel', icon: 'sheet', url: 'https://www.office.com/launch/excel' },
      { id: 'powerpoint', label: 'PowerPoint', icon: 'slides', url: 'https://www.office.com/launch/powerpoint' },
    ],
  };

  /** The clients, in sidebar order. `account` is the default sign-in hint; Settings can change it. */
  const CLIENTS = [
    { id: 'intelio', name: 'intelio', suite: GOOGLE, account: 'hayden@intelio.co', extra: [] },
    { id: 'prc', name: 'PRC Equity', short: 'PRC', suite: GOOGLE, account: '', extra: [
      { id: 'box', label: 'Box', icon: 'box', url: 'https://app.box.com/', primary: true },
      { id: 'center', label: 'The Center', icon: 'dashboard', url: 'https://the-center-prc.vercel.app/' },
    ] },
    { id: 'alignment', name: 'Alignment', suite: MICROSOFT, account: '', extra: [
      { id: 'platform', label: 'Alignment platform', icon: 'dashboard', url: 'https://app.alignmentpa.com/', primary: true },
    ] },
    { id: 'hhp', name: 'HHP', suite: MICROSOFT, account: 'hayden@hhpasset.com', extra: [] },
    { id: 'arlp', name: 'ARLP', suite: MICROSOFT, account: '', extra: [] },
  ];

  const SUITE_LABEL = { [GOOGLE]: 'Google Workspace', [MICROSOFT]: 'Microsoft 365' };

  function clientById(id) {
    const key = String(id || '').trim().toLowerCase();
    return CLIENTS.find((client) => client.id === key) || null;
  }

  function appsFor(clientId) {
    const client = clientById(clientId);
    if (!client) return [];
    return [...SUITES[client.suite], ...client.extra].map((app) => ({ ...app, suite: client.suite }));
  }

  function appFor(clientId, appId) {
    return appsFor(clientId).find((app) => app.id === String(appId || '')) || null;
  }

  /** Each client's own cookie jar. Only catalog ids reach here, so the name is always safe. */
  function partitionFor(clientId) {
    const client = clientById(clientId);
    if (!client) throw new Error('Unknown client.');
    return `persist:client-${client.id}`;
  }

  function validAccount(value) {
    const text = String(value || '').trim();
    return /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(text) ? text : '';
  }

  /**
   * The URL to open. With an account set, the suite's own account hint is added so the right
   * login is picked: Google's authuser, Microsoft's login_hint. Suite apps only; client sites
   * open as they are.
   */
  function urlFor(clientId, appId, account) {
    const client = clientById(clientId);
    const app = appFor(clientId, appId);
    if (!client || !app) throw new Error('Unknown app.');
    const url = new URL(app.url);
    const email = validAccount(account === undefined ? client.account : account);
    const inSuite = SUITES[client.suite].some((item) => item.id === app.id);
    if (email && inSuite) {
      if (client.suite === GOOGLE) url.searchParams.set('authuser', email);
      else url.searchParams.set('login_hint', email);
    }
    return url.toString();
  }

  /**
   * Browser sign-in cookies per suite. Present means this client's browser is signed in;
   * it says nothing about the agent's own access.
   */
  const SIGNIN_COOKIES = {
    [GOOGLE]: [{ url: 'https://accounts.google.com', names: ['SID', '__Secure-1PSID', '__Secure-3PSID'] }],
    [MICROSOFT]: [{ url: 'https://login.microsoftonline.com', names: ['ESTSAUTHPERSISTENT', 'ESTSAUTH'] }],
  };

  async function signedIn(cookieJar, clientId) {
    const client = clientById(clientId);
    if (!client || !cookieJar?.get) return false;
    for (const rule of SIGNIN_COOKIES[client.suite]) {
      const cookies = await cookieJar.get({ url: rule.url }).catch(() => []);
      if (cookies.some((cookie) => rule.names.includes(cookie.name) && cookie.value)) return true;
    }
    return false;
  }

  return { GOOGLE, MICROSOFT, SUITES, CLIENTS, SUITE_LABEL, clientById, appsFor, appFor, partitionFor, urlFor, validAccount, signedIn };
}));
