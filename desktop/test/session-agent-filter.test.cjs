'use strict';
// Sessions filter: one compact dropdown (All agents + each agent), no colored-dot chips,
// remembered across launches. Desktop (remote-main.js, also the PWA /desktop page) and phone (app.js).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function element(tag) {
  const node = {
    tag,
    className: '',
    textContent: '',
    title: '',
    id: '',
    tabIndex: 0,
    dataset: {},
    style: {},
    attrs: {},
    children: [],
    disabled: false,
    value: '',
    classList: {
      hidden: false,
      contains(name) { return name === 'hidden' && this.hidden; },
      toggle(name, force) { if (name === 'hidden') this.hidden = force === undefined ? !this.hidden : Boolean(force); },
      add() {},
      remove() {},
    },
    append(...nodes) { node.children.push(...nodes); },
    replaceChildren(...nodes) { node.children = nodes; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name]; },
    listeners: {},
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    dispatch(type, event) { for (const fn of node.listeners[type] || []) fn(event); },
    querySelector() { return null; },
  };
  return node;
}

const AGENTS = [
  { id: 'intelio', name: 'intelio', orb: 'connecting' },
  { id: 'prc', name: 'PRC', orb: 'solving' },
  { id: 'alignment', name: 'Alignment', orb: 'searching' },
  { id: 'hhp', name: 'HHP', orb: 'weaving' },
  { id: 'arlp', name: 'Arlp', orb: 'working' },
];
const SESSIONS = AGENTS.map((agent, index) => ({
  id: `s-${agent.id}`,
  profileId: agent.id,
  title: `${agent.id} thread`,
  preview: 'p',
  updated_at: new Date(Date.now() - (index + 1) * 60000).toISOString(),
}));

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

function installDom(storage, { agentsGate } = {}) {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  globalThis.document = { getElementById: byId, createElement: element, createTextNode(text) { return { textContent: text }; } };
  globalThis.localStorage = storage;
  globalThis.workspace = { command() { return Promise.resolve({}); } };
  globalThis.remoteHermes = {
    onEvent() {},
    async request(name, value) {
      if (name === 'agents') { if (agentsGate) await agentsGate; return { agents: AGENTS }; }
      if (name === 'all-sessions') return { data: SESSIONS };
      if (name === 'sessions') return { data: SESSIONS.filter((row) => row.profileId === value.profile) };
      if (name === 'messages') return { data: [] };
      return {};
    },
  };
  return byId;
}

function loadRemote() {
  delete require.cache[require.resolve('../src/remote-main.js')];
  return require('../src/remote-main.js');
}

async function until(check) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

const rowsOf = (byId) => byId('all-sessions').children.filter((node) => String(node.className).startsWith('all-session'));
const selectOf = (byId) => byId('session-agents').children[0];
const CONFIG = { remoteHermes: { enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio', profilesWithKeys: AGENTS.map((agent) => agent.id) } };

describe('desktop Sessions filter', { concurrency: false }, () => {
  test('is one dropdown with All agents and every agent by display name, and no chips or dots', async () => {
    const byId = installDom(memoryStorage());
    const api = loadRemote();
    await api.sync(CONFIG);
    api.setSidebar('sessions');
    await until(() => rowsOf(byId).length === 5 && selectOf(byId)?.children?.length === 6);
    const host = byId('session-agents');
    assert.equal(host.children.length, 1, 'one control, not a chip row');
    const select = selectOf(byId);
    assert.equal(select.tag, 'select');
    assert.equal(select.attrs['aria-label'], 'Show sessions for');
    assert.deepEqual(select.children.map((node) => node.value), ['', 'intelio', 'prc', 'alignment', 'hhp', 'arlp']);
    assert.deepEqual(select.children.map((node) => node.textContent), ['All agents', 'intelio', 'PRC', 'Alignment', 'HHP', 'ARLP']);
    assert.equal(select.children.some((node) => (node.children || []).length), false, 'options carry no dot');
    assert.equal(select.value, '');
    select.value = 'alignment';
    select.dispatch('change', { target: select });
    assert.deepEqual(rowsOf(byId).map((row) => row.dataset.profile), ['alignment']);
    select.value = '';
    select.dispatch('change', { target: select });
    assert.equal(rowsOf(byId).length, 5);
  });

  test('the choice is remembered and restored on the next launch', async () => {
    const storage = memoryStorage();
    let byId = installDom(storage);
    let api = loadRemote();
    await api.sync(CONFIG);
    api.setSidebar('sessions');
    await until(() => selectOf(byId)?.children?.length === 6);
    const select = selectOf(byId);
    select.value = 'prc';
    select.dispatch('change', { target: select });
    assert.equal(storage.getItem('intelio-session-agent'), 'prc');

    // Next launch: the agent list arrives late; the saved choice must survive the wait.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    byId = installDom(storage, { agentsGate: gate });
    api = loadRemote();
    const synced = api.sync({ ...CONFIG, sidebarTab: 'sessions' });
    api.setSidebar('sessions');
    release();
    await synced;
    await until(() => selectOf(byId)?.value === 'prc' && rowsOf(byId).length === 1);
    assert.equal(selectOf(byId).value, 'prc');
    assert.deepEqual(rowsOf(byId).map((row) => row.dataset.profile), ['prc']);
    assert.equal(storage.getItem('intelio-session-agent'), 'prc');

    selectOf(byId).value = '';
    selectOf(byId).dispatch('change', { target: selectOf(byId) });
    assert.equal(storage.getItem('intelio-session-agent'), null, 'All agents clears the saved filter');
  });

  test('a saved agent that no longer exists falls back to All agents', async () => {
    const byId = installDom(memoryStorage({ 'intelio-session-agent': 'gone' }));
    const api = loadRemote();
    await api.sync(CONFIG);
    api.setSidebar('sessions');
    await until(() => rowsOf(byId).length === 5);
    assert.equal(selectOf(byId).value, '');
  });

  test('the page markup and styles have no chip row and no yellow or lime', () => {
    const html = fs.readFileSync(path.join(ROOT, 'desktop/src/index.html'), 'utf8');
    assert.match(html, /<div id="session-agents" class="session-agent-filter"><\/div>/);
    assert.doesNotMatch(html, /client-chips/);
    const css = fs.readFileSync(path.join(ROOT, 'desktop/src/remote-main.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'desktop/src/theme-light.css'), 'utf8');
    assert.doesNotMatch(css, /\.session-chip/);
    const rules = css.split('\n').filter((line) => line.includes('session-agent'));
    assert.ok(rules.length >= 4);
    assert.doesNotMatch(rules.join('\n'), /yellow|lime|#ff0|#ffff00|#cddc39|#d4e157|#facc15|#eab308|#a3e635|#84cc16/i);
  });
});

describe('phone Sessions filter', () => {
  const app = fs.readFileSync(path.join(ROOT, 'mobile/pwa/public/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'mobile/pwa/public/app.css'), 'utf8');

  test('the Sessions tab shows one dropdown instead of the agent list', () => {
    const view = app.slice(app.indexOf('function sessionsView()'), app.indexOf('function sessionCard('));
    assert.match(view, /sessionFilter\(\)/);
    assert.doesNotMatch(view, /agent-lines|agentLine\(/);
    assert.doesNotMatch(app, /function agentLine\(/);
    const filter = app.slice(app.indexOf('function sessionFilter()'), app.indexOf('function filteredChats()'));
    assert.match(filter, /createElement\('select'\)/);
    assert.match(filter, /'All agents'/);
    assert.match(filter, /aria-label', 'Show sessions for'/);
  });

  test('the phone remembers the filter under the same key as the web desktop', () => {
    assert.match(app, /const SESSION_AGENT_KEY = 'intelio-session-agent';/);
    assert.match(app, /localStorage\.setItem\(SESSION_AGENT_KEY/);
    assert.match(app, /localStorage\.getItem\(SESSION_AGENT_KEY\)/);
    assert.match(app, /arlp: 'ARLP'/);
  });

  test('the dropdown is neutral grey in light and dark', () => {
    const rules = css.split('\n').filter((line) => line.includes('session-filter'));
    assert.ok(rules.some((line) => line.startsWith('html[data-theme="dark"] .session-filter-select')));
    const block = css.slice(css.indexOf('.session-filter {'), css.indexOf('.thread-line.on {'));
    assert.doesNotMatch(block, /yellow|lime|#ff0\b|#ffff00|#facc15|#eab308|#a3e635|#84cc16/i);
  });
});
