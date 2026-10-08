'use strict';
/**
 * intelio pages: Workspace (the cloud coding workspace on the VPS, embedded) and Transcripts
 * (Plaud meeting recordings from GET /api/transcripts). Shared by the desktop window
 * (intelio.exe and /desktop in a browser: sidebar entries, page covers the chat and browser
 * panes) and the phone client (drawer entries, full-screen page).
 *
 * Nothing here writes: the Workspace runs in its own service (workspace-service/, port 8670,
 * Tailscale identity) and transcripts are read-only.
 */
(function factory(root, build) {
  const api = build(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IntelioPages = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  const WORKSPACE_ORIGIN = 'https://intelio-vps.tail9c1007.ts.net:8670';
  const CLIENT_LABEL = { intelio: 'All (intelio)', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP', arlp: 'ARLP' };
  const PAGE_SIZE = 40;

  /** Workspace understands dark and light; Blue is light text on a dark-ish field, so dark. */
  function workspaceTheme(theme) {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  function workspaceUrl(theme, embed = 'intelio') {
    const base = String(root.INTELIO_WORKSPACE_URL || `${WORKSPACE_ORIGIN}/`);
    const url = new URL(base);
    url.searchParams.set('embed', embed);
    url.searchParams.set('theme', workspaceTheme(theme));
    return url.toString();
  }

  function clientLabel(id) {
    const key = String(id || '').toLowerCase();
    return CLIENT_LABEL[key] || key.toUpperCase();
  }

  function transcriptQuery({ profile = 'intelio', q = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const query = new URLSearchParams();
    query.set('profile', String(profile || 'intelio'));
    if (q) query.set('q', String(q).slice(0, 200));
    query.set('limit', String(limit));
    if (offset) query.set('offset', String(offset));
    return query.toString();
  }

  const api = { workspaceUrl, workspaceTheme, clientLabel, transcriptQuery, WORKSPACE_ORIGIN };
  const doc = root.document;
  if (!doc || typeof doc.createElement !== 'function') return api;

  // ---- tiny DOM helper ------------------------------------------------------
  function h(tag, attrs, ...children) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'class') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : doc.createTextNode(String(child)));
    }
    return node;
  }
  const SVG = {
    workspace: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m8 10 2.5 2L8 14M13 15h3"/></svg>',
    transcripts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4-4"/></svg>',
    reload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  };
  function icon(name) {
    const span = doc.createElement('span');
    span.className = 'ip-icon';
    span.innerHTML = SVG[name] || '';
    return span;
  }

  const state = {
    mode: '',
    view: '',
    overlay: null,
    nav: null,
    pages: {},
    openLink: null,
    frame: null,
    frameTheme: '',
    t: { profile: 'intelio', q: '', items: [], profiles: [], total: 0, matched: 0, loading: false, error: '', open: new Set(), token: 0 },
  };

  function theme() {
    return String(doc.documentElement?.dataset?.theme || 'dark');
  }

  async function fetchTranscripts(params) {
    if (root.remoteHermes?.request) return root.remoteHermes.request('transcripts', params);
    const response = await root.fetch(`/api/transcripts?${transcriptQuery(params)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || !body) throw new Error((body && body.error) || 'Could not load the transcripts.');
    return body;
  }

  // ---- layout ---------------------------------------------------------------
  function relayout() {
    if (state.mode === 'desktop' && state.overlay) {
      const sidebar = doc.querySelector('#shell > .sidebar');
      const rect = sidebar && sidebar.offsetParent !== null ? sidebar.getBoundingClientRect() : null;
      state.overlay.style.left = `${rect && rect.width > 0 ? Math.round(rect.right) : 0}px`;
    }
    try { root.intelioLayout?.(); } catch { /* the phone has no native views */ }
  }

  function ensureOverlay() {
    if (state.overlay) return state.overlay;
    state.overlay = h('section', { id: 'intelio-pages', class: `ip-overlay ip-${state.mode}`, hidden: true, 'aria-live': 'polite' });
    doc.body.append(state.overlay);
    return state.overlay;
  }

  function header(title, extra) {
    const close = h('button', { type: 'button', class: 'ip-btn ip-icon-btn', 'aria-label': state.mode === 'phone' ? 'Back' : 'Close', title: state.mode === 'phone' ? 'Back' : 'Close (Esc)', onclick: () => close() });
    close.append(icon(state.mode === 'phone' ? 'back' : 'close'));
    return h('header', { class: 'ip-head' }, state.mode === 'phone' ? close : null, h('h1', { class: 'ip-title' }, title), h('span', { class: 'ip-spacer' }), extra, state.mode === 'phone' ? null : close);
  }

  // ---- Workspace ------------------------------------------------------------
  /** Point the frame (and the new-window link) at the current theme. Reloads only on a change. */
  function syncWorkspaceTheme(force = false) {
    if (!state.frame) return;
    const next = workspaceTheme(theme());
    if (state.openLink) state.openLink.href = workspaceUrl(next);
    if (!force && state.frameTheme === next) return;
    state.frameTheme = next;
    state.frame.src = workspaceUrl(next);
  }

  function workspaceView() {
    const url = workspaceUrl(theme());
    const open = h('a', { class: 'ip-btn', href: url, target: '_blank', rel: 'noopener noreferrer', title: 'Open the Workspace in a new window' }, icon('external'), h('span', {}, 'Open in new window'));
    state.openLink = open;
    const reload = h('button', { type: 'button', class: 'ip-btn ip-icon-btn', title: 'Reload', 'aria-label': 'Reload the Workspace', onclick: () => syncWorkspaceTheme(true) }, icon('reload'));
    state.frame = h('iframe', { class: 'ip-frame', title: 'intelio Workspace', allow: 'clipboard-read; clipboard-write; fullscreen', referrerpolicy: 'no-referrer' });
    syncWorkspaceTheme(true);
    const note = h('p', { class: 'ip-frame-note' }, 'The Workspace runs on the VPS and opens over Tailscale. If it stays blank, use Open in new window.');
    return h('div', { class: 'ip-page ip-page--workspace' }, header('Workspace', [reload, open]), h('div', { class: 'ip-frame-wrap' }, note, state.frame));
  }

  // ---- Transcripts ----------------------------------------------------------
  let searchTimer = 0;
  async function loadTranscripts({ more = false } = {}) {
    const t = state.t;
    const token = ++t.token;
    t.loading = true;
    t.error = '';
    if (!more) paintList();
    try {
      const body = await fetchTranscripts({ profile: t.profile, q: t.q, limit: PAGE_SIZE, offset: more ? t.items.length : 0 });
      if (token !== t.token) return;
      const items = Array.isArray(body.items) ? body.items : [];
      t.items = more ? t.items.concat(items) : items;
      t.total = Number(body.total) || 0;
      t.matched = Number(body.matched) || t.items.length;
      if (Array.isArray(body.profiles) && body.profiles.length) t.profiles = body.profiles;
    } catch (error) {
      if (token !== t.token) return;
      t.error = String(error?.message || error || 'Could not load the transcripts.').slice(0, 200);
    } finally {
      if (token === t.token) { t.loading = false; paintList(); }
    }
  }

  function card(item) {
    const t = state.t;
    const key = item.id || item.file;
    const open = t.open.has(key);
    const meta = [item.date, item.duration].filter(Boolean).join(' · ');
    const toggle = () => { if (t.open.has(key)) t.open.delete(key); else t.open.add(key); paintList(); };
    const tags = (item.clients || []).map((client) => h('span', { class: 'ip-tag' }, clientLabel(client)));
    const head = h('button', { type: 'button', class: 'ip-card-head', 'aria-expanded': String(open), onclick: toggle },
      h('span', { class: 'ip-card-main' },
        h('span', { class: 'ip-card-title' }, item.title || item.file),
        h('span', { class: 'ip-card-meta' }, meta, tags.length ? ' ' : '', tags)),
      h('span', { class: `ip-caret${open ? ' ip-caret--open' : ''}`, 'aria-hidden': 'true' }, '›'));
    const body = [];
    if (!open && item.excerpt) body.push(h('p', { class: 'ip-excerpt' }, item.excerpt));
    if (open) {
      if (item.actions?.length) {
        body.push(h('section', { class: 'ip-block' }, h('h3', {}, 'Action items'), h('ul', { class: 'ip-actions' }, item.actions.map((action) => h('li', {}, action)))));
      }
      body.push(h('section', { class: 'ip-block' }, h('h3', {}, 'Summary'), h('div', { class: 'ip-summary' }, summaryBlocks(item.summary || item.excerpt || 'No summary.'))));
      body.push(h('p', { class: 'ip-file' }, item.file || ''));
    }
    return h('article', { class: `ip-card${open ? ' ip-card--open' : ''}` }, head, body);
  }

  /** Markdown-ish summary as safe text blocks: headings, bullets and paragraphs. */
  function summaryBlocks(text) {
    const out = [];
    let list = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim().replace(/\*\*/g, '');
      if (!line) { list = null; continue; }
      const heading = /^#{1,6}\s*(.*)$/.exec(line);
      if (heading) { list = null; out.push(h('h4', {}, heading[1])); continue; }
      const bullet = /^[-*]\s*(\[[ x]\]\s*)?(.*)$/.exec(line);
      if (bullet) {
        if (!list) { list = h('ul', {}); out.push(list); }
        list.append(h('li', {}, bullet[2]));
        continue;
      }
      list = null;
      out.push(h('p', {}, line));
    }
    return out;
  }

  function paintList() {
    const host = state.overlay?.querySelector('[data-ip-list]');
    if (!host || state.view !== 'transcripts') return;
    const t = state.t;
    const pageRoot = host.closest('.ip-page') || state.overlay;
    const chips = pageRoot.querySelector('[data-ip-chips]');
    if (chips) {
      const profiles = t.profiles.length ? t.profiles : [{ id: 'intelio', count: 0 }];
      chips.replaceChildren(...profiles.map((row) => h('button', {
        type: 'button', class: 'ip-chip', role: 'radio', 'aria-checked': String(row.id === t.profile),
        onclick: () => { if (t.profile === row.id) return; t.profile = row.id; t.open.clear(); loadTranscripts(); },
      }, clientLabel(row.id), row.count ? h('span', { class: 'ip-chip-count' }, String(row.count)) : null)));
    }
    const count = pageRoot.querySelector('[data-ip-count]');
    if (count) count.textContent = t.loading && !t.items.length ? 'Loading…' : (t.q ? `${t.matched} of ${t.total} match` : `${t.total} recordings`);
    const rows = [];
    if (t.error) rows.push(h('p', { class: 'ip-error', role: 'alert' }, t.error, ' ', h('button', { type: 'button', class: 'ip-link', onclick: () => loadTranscripts() }, 'Try again')));
    if (!t.error && !t.loading && !t.items.length) rows.push(h('p', { class: 'ip-empty' }, t.q ? 'No recordings match that search.' : 'No recordings for this client yet.'));
    for (const item of t.items) rows.push(card(item));
    if (t.items.length && t.items.length < t.matched) {
      rows.push(h('button', { type: 'button', class: 'ip-btn ip-more', disabled: t.loading, onclick: () => loadTranscripts({ more: true }) }, t.loading ? 'Loading…' : `Show more (${t.matched - t.items.length} left)`));
    }
    if (t.loading && !t.items.length) rows.push(h('p', { class: 'ip-empty' }, 'Loading recordings…'));
    host.replaceChildren(...rows);
  }

  function transcriptsView() {
    const t = state.t;
    const input = h('input', { type: 'search', class: 'ip-search-input', placeholder: 'Search titles and summaries…', 'aria-label': 'Search transcripts', value: t.q });
    input.value = t.q;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { t.q = input.value.trim(); t.open.clear(); loadTranscripts(); }, 250);
    });
    const search = h('label', { class: 'ip-search' }, icon('search'), input);
    const toolbar = h('div', { class: 'ip-toolbar' }, h('div', { class: 'ip-chips', role: 'radiogroup', 'aria-label': 'Client', 'data-ip-chips': '' }), search);
    const page = h('div', { class: 'ip-page ip-page--transcripts' },
      header('Meeting transcripts', h('span', { class: 'ip-count', 'data-ip-count': '' }, '')),
      toolbar,
      h('div', { class: 'ip-scroll' }, h('div', { class: 'ip-list', 'data-ip-list': '' })));
    return page;
  }

  // ---- open / close -----------------------------------------------------------
  function open(view) {
    const next = view === 'transcripts' ? 'transcripts' : 'workspace';
    if (!state.mode) mount();
    const overlay = ensureOverlay();
    try { root.IntelioHome?.closeBar?.(); } catch { /* home is optional */ }
    state.view = next;
    if (!state.pages[next]) {
      state.pages[next] = next === 'workspace' ? workspaceView() : transcriptsView();
      overlay.append(state.pages[next]);
    }
    for (const [name, page] of Object.entries(state.pages)) page.hidden = name !== next;
    if (next === 'workspace') syncWorkspaceTheme();
    overlay.hidden = false;
    doc.body.classList.add('ip-open');
    paintNav();
    relayout();
    if (next === 'transcripts') {
      paintList();
      if (!state.t.items.length || state.t.error) loadTranscripts();
    }
  }

  function close() {
    if (!state.view) return;
    state.view = '';
    if (state.overlay) state.overlay.hidden = true;
    doc.body.classList.remove('ip-open');
    paintNav();
    relayout();
  }

  function toggle(view) {
    if (state.view === view) close();
    else open(view);
  }

  function paintNav() {
    if (!state.nav) return;
    for (const button of state.nav.querySelectorAll('[data-ip-open]')) {
      button.setAttribute('aria-pressed', String(button.dataset.ipOpen === state.view));
    }
  }

  function mountDesktop() {
    const sidebar = doc.querySelector('#shell > .sidebar');
    if (!sidebar || doc.getElementById('ip-nav')) return;
    const item = (id, label) => {
      const button = h('button', { type: 'button', class: 'ip-nav-item no-drag', 'data-ip-open': id, 'aria-pressed': 'false', title: label, onclick: () => toggle(id) });
      button.append(icon(id), h('span', {}, label));
      return button;
    };
    state.nav = h('nav', { id: 'ip-nav', class: 'ip-nav', 'aria-label': 'intelio pages' }, item('workspace', 'Workspace'), item('transcripts', 'Transcripts'));
    const anchor = doc.getElementById('agent-presence') || sidebar.querySelector('.side-bottom');
    if (anchor && anchor.parentElement === sidebar) sidebar.insertBefore(state.nav, anchor);
    else sidebar.append(state.nav);
    // Leaving a page: picking an agent, a session or a thread in the sidebar.
    doc.addEventListener('click', (event) => {
      if (!state.view) return;
      if (event.target.closest?.('#bot-list, #all-sessions, #sidebar-threads, #lead-card, #session-new, #threads-new, .session-nav-item, #tab-sessions, #tab-agents')) close();
    }, true);
    root.addEventListener('resize', () => { if (state.view) relayout(); });
  }

  function mount() {
    if (state.mode) return api;
    state.mode = doc.querySelector('#shell > .sidebar') ? 'desktop' : 'phone';
    if (state.mode === 'desktop') mountDesktop();
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.view && !event.defaultPrevented) close();
    });
    // Theme changes repaint the page (the Workspace frame reloads with the new theme).
    try {
      new root.MutationObserver(() => syncWorkspaceTheme()).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch { /* no observer: the next open picks the theme up */ }
    return api;
  }

  Object.assign(api, {
    mount, open, close, toggle,
    covers: () => Boolean(state.view),
    view: () => state.view,
  });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  return api;
}));
