/**
 * Accounts page per agent and the low-key Settings > Activity list.
 * Shared by the desktop app (Electron, and /desktop in a browser) and the phone PWA.
 * Talks to the phone server's /api/accounts and /api/activity routes: through the main
 * process in Electron (remoteHermes.request), or same-origin fetch in a browser.
 * A paste-back sign-in code lives only in its masked input until it is sent.
 */
(function factory(root, build) {
  const api = build(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.IntelioAccounts = api;
}(typeof window !== 'undefined' ? window : globalThis, (root) => {
  'use strict';

  const TTL_MS = 60000;
  const GROUPS = [
    ['model', 'Model sign-in', 'How this agent talks to its model. Managed by Hermes.'],
    ['claude', 'Claude Code', ''],
    ['codex', 'Codex CLI', ''],
    ['github', 'GitHub', ''],
    ['channel', 'Messaging', ''],
    ['mcp', 'MCP servers and plugins', ''],
    ['desktop', 'Computer', ''],
    ['vault', 'Saved logins', ''],
    ['client', 'Client apps on this computer', 'Browser sign-ins in this app, not the agent’s own access.'],
  ];
  const SIGN_IN_TOOLS = { claude: 'Claude Code', codex: 'Codex', github: 'GitHub' };
  const KIND_LABEL = { github: 'GitHub', claude: 'Claude Code', codex: 'Codex', terminal: 'Terminal', browser: 'Browser', connector: 'Computer', vault: 'Vault', signin: 'Sign-in', account: 'Account', other: 'Other' };
  const cache = new Map();

  /* ---------- pure helpers (unit-tested) ---------- */

  function relTime(iso, now = Date.now()) {
    const at = Date.parse(iso || '');
    if (!Number.isFinite(at)) return '';
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)}d ago`;
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function clockTime(iso) {
    const at = new Date(iso || '');
    if (!Number.isFinite(at.getTime())) return '';
    return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function planLabel(plan) {
    const text = String(plan || '').trim();
    if (!text) return '';
    const known = { max: 'Max plan', pro: 'Pro plan', team: 'Team plan', enterprise: 'Enterprise', free: 'Free' };
    return known[text.toLowerCase()] || text;
  }

  function grouped(rows) {
    const out = new Map(GROUPS.map(([id]) => [id, []]));
    for (const row of rows || []) {
      const key = out.has(row.group) ? row.group : 'mcp';
      out.get(key).push(row);
    }
    return out;
  }

  function clientRows(status, profile, catalog) {
    const clients = status?.clients || status || {};
    const row = clients[profile];
    if (!row) return [];
    const client = catalog?.clientById?.(profile);
    const suite = catalog?.SUITE_LABEL?.[row.suite] || (row.suite === 'microsoft' ? 'Microsoft 365' : 'Google Workspace');
    return [{ id: `client:${profile}`, group: 'client', label: suite, account: row.account || '', signedIn: row.signedIn === true, detail: client ? `${client.short || client.name} browser on this computer` : 'Browser on this computer' }];
  }

  /** Request name -> HTTP call, for the browser transport. Same routes the main process proxies. */
  function route(name, value = {}) {
    const profile = String(value.profile || 'intelio');
    const q = new URLSearchParams();
    if (name === 'activity') for (const key of ['agent', 'kind', 'q', 'limit']) if (value[key]) q.set(key, String(value[key]));
    q.set('profile', profile);
    const table = {
      accounts: { path: `/api/accounts?${value.fresh ? 'fresh=1&' : ''}profile=${encodeURIComponent(profile)}` },
      'accounts-signin': { path: '/api/accounts/signin', body: { profile, tool: value.tool, name: value.name } },
      'accounts-signin-state': { path: `/api/accounts/signin?id=${encodeURIComponent(String(value.id || ''))}&profile=${encodeURIComponent(profile)}` },
      'accounts-code': { path: '/api/accounts/signin/code', body: { profile, id: value.id, code: value.code } },
      'accounts-cancel': { path: '/api/accounts/signin/cancel', body: { profile, id: value.id } },
      'accounts-assign': { path: '/api/accounts/assign', body: { profile, tool: value.tool, account: value.account } },
      activity: { path: `/api/activity?${q}` },
    };
    return table[name] || null;
  }

  async function fetchRequest(name, value) {
    const call = route(name, value);
    if (!call) throw new Error('Unknown request.');
    const headers = { Accept: 'application/json', 'x-intelio-profile': String(value.profile || 'intelio') };
    if (call.body) headers['content-type'] = 'application/json';
    const response = await root.fetch(call.path, { method: call.body ? 'POST' : 'GET', headers, body: call.body ? JSON.stringify(call.body) : undefined, credentials: 'same-origin' });
    let json = {};
    try { json = await response.json(); } catch { json = {}; }
    if (!response.ok) throw new Error(String(json.error || 'That did not work.').slice(0, 200));
    return json;
  }

  function request(name, value = {}) {
    const electron = root.location?.protocol === 'file:' && root.remoteHermes?.request;
    return electron ? root.remoteHermes.request(name, value) : fetchRequest(name, value);
  }

  /* ---------- DOM ---------- */

  function el(tag, className, text) {
    const node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, className, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function copy(text) {
    try { return root.navigator.clipboard.writeText(String(text || '')).then(() => true, () => false); } catch { return Promise.resolve(false); }
  }

  function openUrl(url) {
    const command = root.workspace?.command;
    if (root.location?.protocol === 'file:' && typeof command === 'function') {
      command('create-tab', { url }).catch(() => root.open?.(url, '_blank', 'noopener'));
      return;
    }
    root.open?.(url, '_blank', 'noopener');
  }

  const shown = new WeakSet();

  function entry(profile) {
    if (!cache.has(profile)) cache.set(profile, { data: null, at: 0, loading: false, error: '', note: '', clients: [], hosts: new Set() });
    return cache.get(profile);
  }

  function paintAll(profile) {
    const state = entry(profile);
    for (const host of [...state.hosts]) {
      // A new pane is not in the page yet when its first load starts; only drop panes that were shown and then removed.
      if (!host.isConnected) { if (shown.has(host)) state.hosts.delete(host); else host.replaceChildren(body(profile, state)); continue; }
      shown.add(host);
      host.replaceChildren(body(profile, state));
    }
  }

  async function load(profile, { fresh = false } = {}) {
    const state = entry(profile);
    if (state.loading) return;
    if (!fresh && state.data && Date.now() - state.at < TTL_MS) return;
    state.loading = true;
    state.error = '';
    paintAll(profile);
    try {
      state.data = await request('accounts', { profile, fresh });
      state.at = Date.now();
    } catch (error) {
      state.error = error?.message || 'Could not load accounts.';
    }
    if (root.location?.protocol === 'file:' && typeof root.workspace?.command === 'function') {
      try { state.clients = clientRows(await root.workspace.command('client-apps-status'), profile, root.IntelioClientApps); } catch { state.clients = []; }
    }
    state.loading = false;
    paintAll(profile);
  }

  function dot(on, attention) {
    const node = el('span', `acct-dot${on ? ' on' : ''}${attention ? ' attention' : ''}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function accountRow(profile, row, state) {
    const item = el('div', 'acct-row');
    item.dataset.account = row.id;
    const main = el('div', 'acct-main');
    const title = el('div', 'acct-title');
    title.append(dot(row.signedIn, row.needsAttention), el('span', 'acct-name', row.tool ? (row.name === 'default' ? 'Main account' : row.name) : row.label));
    if (row.account) title.append(el('span', 'acct-who', row.account));
    const plan = planLabel(row.plan);
    if (plan) title.append(el('span', 'acct-plan', plan));
    if (row.group === 'vault' && Number.isInteger(row.count)) title.append(el('span', 'acct-plan', `${row.count} saved`));
    main.append(title);
    const facts = [];
    if (!row.signedIn) facts.push(row.group === 'channel' || row.group === 'mcp' || row.group === 'desktop' ? 'Not connected' : row.group === 'vault' ? 'None saved' : 'Not signed in');
    if (row.detail) facts.push(row.detail);
    if (row.group === 'model' && row.lastOkAt) facts.push(`last successful call ${relTime(row.lastOkAt)}`);
    if (row.group === 'model' && row.authUpdatedAt) facts.push(`sign-in updated ${relTime(row.authUpdatedAt)}`);
    if (row.tool && row.configDir) facts.push(row.configDir);
    if (row.scopes?.length) facts.push(`scopes: ${row.scopes.join(', ')}`);
    if (row.others?.length) facts.push(`also on this config: ${row.others.map((o) => o.login).join(', ')}`);
    if (row.error) facts.push(row.error);
    main.append(el('p', 'acct-detail agent-muted', facts.join(' · ')));
    item.append(main);
    const side = el('div', 'acct-side');
    if (row.group !== 'model') side.append(el('span', 'acct-used agent-muted', row.lastUsedAt ? `Used ${relTime(row.lastUsedAt)}` : (row.tool && !row.assigned ? '' : 'Not used yet')));
    if (row.tool) {
      if (row.assigned) side.append(el('span', 'acct-tag', 'This agent'));
      else if (row.signedIn) {
        side.append(button('Use for this agent', 'acct-btn agent-seg', async (event) => {
          event.currentTarget.disabled = true;
          try {
            await request('accounts-assign', { profile, tool: row.tool, account: row.name });
            state.note = `${SIGN_IN_TOOLS[row.tool] || row.label} for this agent now uses ${row.name === 'default' ? 'the main account' : row.name}.`;
            await load(profile, { fresh: true });
          } catch (error) {
            state.note = error.message;
            paintAll(profile);
          }
        }));
      }
    }
    item.append(side);
    return item;
  }

  function body(profile, state) {
    const wrap = el('div', 'acct-body');
    const head = el('div', 'acct-head');
    head.append(el('p', 'acct-lede agent-muted', 'What this agent is connected to and signed in with. Read from the server; nothing here changes Hermes.'));
    head.append(button(state.loading ? 'Checking…' : 'Refresh', 'acct-btn agent-seg', () => load(profile, { fresh: true })));
    wrap.append(head);
    if (state.note) wrap.append(el('p', 'acct-note agent-note', state.note));
    if (state.error) wrap.append(el('p', 'acct-note agent-note', state.error));
    if (!state.data && state.loading) { wrap.append(el('p', 'agent-muted', 'Checking accounts…')); return wrap; }
    const rows = [...(state.data?.accounts || []), ...state.clients];
    const groups = grouped(rows);
    for (const [id, label, hint] of GROUPS) {
      const list = groups.get(id) || [];
      if (!list.length && !SIGN_IN_TOOLS[id]) continue;
      const section = el('section', 'acct-group agent-block');
      section.dataset.group = id;
      const top = el('div', 'acct-group-head agent-block-head');
      top.append(el('h3', '', label));
      if (SIGN_IN_TOOLS[id] && !state.data?.sample) top.append(button('Sign in another account', 'acct-link agent-text', () => openSignIn(profile, id)));
      section.append(top);
      if (hint) section.append(el('p', 'acct-hint agent-muted', hint));
      if (!list.length) section.append(el('p', 'acct-detail agent-muted', 'Nothing found on the server.'));
      for (const row of list) section.append(accountRow(profile, row, state));
      wrap.append(section);
    }
    if (state.data?.generatedAt) wrap.append(el('p', 'acct-foot agent-muted', `Checked ${relTime(state.data.generatedAt)}${state.data.cached ? ' (cached)' : ''}. Assignments are kept in ~/.config/intelio/accounts.json on the server.`));
    return wrap;
  }

  /** The Accounts tab. Returns a node; data is cached per agent so re-renders are cheap. */
  function pane(profile, { phone = false } = {}) {
    const id = String(profile || 'intelio');
    const host = el('div', `acct-pane${phone ? ' acct-phone' : ''}`);
    host.dataset.profile = id;
    const state = entry(id);
    if (state.hosts.size > 12) for (const old of [...state.hosts]) if (!old.isConnected) state.hosts.delete(old);
    state.hosts.add(host);
    host.append(body(id, state));
    load(id);
    return host;
  }

  /* ---------- sign-in modal ---------- */

  function openSignIn(profile, tool) {
    const doc = root.document;
    doc.querySelector('.acct-modal')?.remove();
    const overlay = el('div', 'acct-modal');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const card = el('div', 'acct-modal-card');
    overlay.append(card);
    let session = null;
    let timer = 0;
    let closed = false;
    const close = async () => {
      closed = true;
      clearTimeout(timer);
      if (session && !['done', 'failed', 'expired', 'cancelled'].includes(session.state)) request('accounts-cancel', { profile, id: session.id }).catch(() => {});
      overlay.remove();
    };
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });

    function frame(title) {
      card.replaceChildren();
      const top = el('div', 'acct-modal-head');
      top.append(el('h2', '', title), button('×', 'acct-close', close));
      top.lastChild.setAttribute('aria-label', 'Close');
      card.append(top);
    }

    function askName(message) {
      frame(`Sign in another ${SIGN_IN_TOOLS[tool]} account`);
      card.append(el('p', 'acct-modal-text', `Signs in on the server in its own config folder, so the main account is not touched. ${tool === 'claude' ? 'Claude asks you to paste a code back here.' : 'You enter a short code on the sign-in page.'}`));
      const form = el('form', 'acct-form');
      const label = el('label', 'acct-label', 'Account name');
      const input = el('input', 'acct-input');
      input.name = 'account';
      input.placeholder = 'work';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.maxLength = 24;
      input.pattern = '[a-z0-9][a-z0-9-]*';
      label.append(input);
      form.append(label, el('p', 'acct-hint', 'Lowercase letters, numbers and dashes. Use “default” only to sign in the main account when it is signed out.'));
      if (message) form.append(el('p', 'acct-error', message));
      const start = el('button', 'acct-primary', 'Start sign-in');
      start.type = 'submit';
      form.append(start);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = input.value.trim().toLowerCase();
        start.disabled = true;
        start.textContent = 'Starting…';
        try {
          session = await request('accounts-signin', { profile, tool, name });
          showProgress();
        } catch (error) {
          askName(error.message);
        }
      });
      card.append(form);
      setTimeout(() => input.focus(), 0);
    }

    function showProgress() {
      if (closed || !session) return;
      frame(`${SIGN_IN_TOOLS[tool]} · ${session.name}`);
      if (session.state === 'done') {
        card.append(el('p', 'acct-modal-text acct-ok', `Signed in${session.account ? ` as ${session.account}` : ''}. Checked with the status command on the server.`));
        card.append(button('Done', 'acct-primary', close));
        entry(profile).note = `${SIGN_IN_TOOLS[tool]} account “${session.name}” signed in.`;
        load(profile, { fresh: true });
        return;
      }
      if (['failed', 'expired', 'cancelled'].includes(session.state)) {
        card.append(el('p', 'acct-error', session.error || 'The sign-in did not finish.'));
        card.append(button('Try again', 'acct-primary', () => { session = null; askName(''); }));
        return;
      }
      if (!session.url) card.append(el('p', 'acct-modal-text', 'Starting the sign-in on the server…'));
      if (session.url) {
        card.append(el('p', 'acct-step', '1. Open this page and sign in'));
        const link = el('a', 'acct-url', session.url);
        link.href = session.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.addEventListener('click', (event) => { event.preventDefault(); openUrl(session.url); });
        const row = el('div', 'acct-copy-row');
        row.append(link, button('Copy', 'acct-btn agent-seg', () => copy(session.url)));
        card.append(row);
      }
      if (session.userCode) {
        card.append(el('p', 'acct-step', '2. Enter this code on that page'));
        const row = el('div', 'acct-copy-row');
        row.append(el('code', 'acct-code', session.userCode), button('Copy', 'acct-btn agent-seg', () => copy(session.userCode)));
        card.append(row);
      }
      if (session.needsCode) {
        card.append(el('p', 'acct-step', '2. Paste the code Claude shows you'));
        const form = el('form', 'acct-form');
        const input = el('input', 'acct-input');
        input.type = 'password';
        input.name = 'signin-code';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Sign-in code');
        const send = el('button', 'acct-primary', 'Send code');
        send.type = 'submit';
        form.append(input, send);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const code = input.value;
          input.value = '';
          if (!code.trim()) return;
          send.disabled = true;
          try { session = await request('accounts-code', { profile, id: session.id, code }); } catch (error) { card.append(el('p', 'acct-error', error.message)); }
          showProgress();
        });
        card.append(form, el('p', 'acct-hint', 'The code goes straight to the sign-in window on the server. It is not saved or logged.'));
        setTimeout(() => input.focus(), 0);
      }
      card.append(el('p', 'acct-wait agent-muted', session.state === 'verifying' ? 'Checking the sign-in…' : 'Waiting for you to finish signing in…'));
      card.append(button('Cancel', 'acct-link', close));
      clearTimeout(timer);
      timer = setTimeout(poll, 2000);
    }

    async function poll() {
      if (closed || !session) return;
      const typing = card.querySelector('input[name="signin-code"]');
      if (typing && typing.value) { timer = setTimeout(poll, 2000); return; }
      try { session = await request('accounts-signin-state', { profile, id: session.id }); } catch (error) { session = { ...session, state: 'failed', error: error.message }; }
      showProgress();
    }

    askName('');
    doc.body.append(overlay);
    return overlay;
  }

  /* ---------- Settings > Activity ---------- */

  function appendActivity(container, { profiles = [] } = {}) {
    const doc = root.document;
    const section = el('section', 'acct-activity');
    section.append(el('h3', '', 'Activity'));
    section.append(el('p', 'settings-note acct-hint', 'What agents did with GitHub, Claude Code, Codex, terminals, browser sign-ins and the computer connector. Read from Hermes session history (read-only) and intelio’s own log. Secrets are redacted.'));
    const toggle = button('Show activity', 'secondary-button acct-btn', () => {
      const open = list.hidden;
      list.hidden = !open;
      filters.hidden = !open;
      toggle.textContent = open ? 'Hide activity' : 'Show activity';
      if (open) refresh();
    });
    const filters = el('div', 'acct-filters');
    filters.hidden = true;
    const agent = el('select', 'acct-select');
    agent.setAttribute('aria-label', 'Agent');
    agent.append(new root.Option('All agents', ''));
    for (const id of profiles) agent.append(new root.Option(id, id));
    const kind = el('select', 'acct-select');
    kind.setAttribute('aria-label', 'Kind');
    kind.append(new root.Option('Everything', ''));
    for (const [id, label] of Object.entries(KIND_LABEL)) if (id !== 'other') kind.append(new root.Option(label, id));
    const search = el('input', 'acct-input acct-search');
    search.type = 'search';
    search.placeholder = 'Filter';
    search.setAttribute('aria-label', 'Filter activity');
    filters.append(agent, kind, search);
    const list = el('div', 'acct-log');
    list.hidden = true;
    let rows = [];
    let seq = 0;
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const shown = rows.filter((row) => !q || `${row.summary} ${row.profile} ${row.account || ''}`.toLowerCase().includes(q));
      list.replaceChildren();
      if (!shown.length) { list.append(el('p', 'settings-note', rows.length ? 'Nothing matches.' : 'No activity yet.')); return; }
      for (const row of shown.slice(0, 300)) {
        const line = el('div', 'acct-log-row');
        line.dataset.kind = row.kind;
        const meta = el('div', 'acct-log-meta');
        meta.append(el('span', 'acct-log-time', clockTime(row.ts)), el('span', 'acct-log-agent', row.profile || 'intelio'), el('span', 'acct-tag', KIND_LABEL[row.kind] || row.kind));
        if (row.source === 'intelio') meta.append(el('span', 'acct-log-src', 'intelio'));
        if (row.ok === false) meta.append(el('span', 'acct-log-src', 'failed'));
        line.append(meta, el('code', 'acct-log-text', row.summary));
        list.append(line);
      }
    };
    async function refresh() {
      const mine = ++seq;
      list.replaceChildren(el('p', 'settings-note', 'Loading…'));
      try {
        const result = await request('activity', { profile: agent.value || profiles[0] || 'intelio', agent: agent.value, kind: kind.value, limit: 300 });
        if (mine !== seq) return;
        rows = Array.isArray(result?.data) ? result.data : [];
        if (!profiles.length) {
          const seen = [...new Set(rows.map((row) => row.profile).filter(Boolean))].sort();
          for (const id of seen) if (![...agent.options].some((o) => o.value === id)) agent.append(new root.Option(id, id));
        }
        paint();
      } catch (error) {
        if (mine === seq) list.replaceChildren(el('p', 'settings-note', error.message || 'Could not load activity.'));
      }
    }
    agent.addEventListener('change', refresh);
    kind.addEventListener('change', refresh);
    search.addEventListener('input', paint);
    section.append(toggle, filters, list);
    container.append(section);
    void doc;
    return section;
  }

  return { pane, appendActivity, openSignIn, relTime, planLabel, grouped, clientRows, route, request, GROUPS, KIND_LABEL };
}));
