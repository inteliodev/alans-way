const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

function element(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    title: '',
    tabIndex: 0,
    dataset: {},
    style: {},
    children: [],
    disabled: false,
    value: '',
    width: 0,
    height: 0,
    classList: {
      hidden: false,
      contains(name) { return name === 'hidden' && this.hidden; },
      toggle(name, force) { if (name === 'hidden') this.hidden = force === undefined ? !this.hidden : Boolean(force); },
      add() {},
      remove() {},
    },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute() {},
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type, event) { for (const fn of this.listeners[type] || []) fn(event); },
    querySelector(sel) {
      if (sel === 'h3' || sel === 'p') return { textContent: '' };
      return null;
    },
  };
}

const ALL_SESSIONS = [
  { id: 's-prc', profileId: 'prc', source: 'photon', sourceLabel: 'photon/iMessage', title: 'Outreach', preview: 'Drafted intros.', updated_at: '2026-10-06T15:00:00Z' },
  { id: 's-alignment', profileId: 'alignment', source: 'api_server', sourceLabel: 'API', title: 'Launch', preview: 'Checkout is clean.', updated_at: '2026-10-06T14:00:00Z' },
  { id: 's-hhp', profileId: 'hhp', source: 'oneshot', sourceLabel: 'One-shot', title: 'Acme', preview: 'Thursday check-in.', updated_at: '2026-10-06T13:00:00Z' },
  { id: 's-intelio', profileId: 'intelio', source: 'telegram', sourceLabel: 'Telegram', title: 'Friday notes', preview: 'Need your yes.', updated_at: '2026-10-06T12:00:00Z' },
];

function installDom() {
  const nodes = new Map();
  const calls = [];
  function byId(id) {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  }
  globalThis.document = {
    getElementById: byId,
    createElement: element,
    createTextNode(text) { return { textContent: text }; },
  };
  globalThis.remoteHermes = {
    onEvent() {},
    async request(name, value) {
      calls.push({ name, profile: value?.profile || '', id: value?.id || '' });
      if (name === 'agents') {
        return {
          agents: [
            { id: 'intelio', name: 'Intelio', orb: 'connecting' },
            { id: 'prc', name: 'PRC', orb: 'solving' },
            { id: 'alignment', name: 'Alignment', orb: 'searching' },
            { id: 'hhp', name: 'HHP', orb: 'weaving' },
          ],
        };
      }
      if (name === 'all-sessions') return { data: ALL_SESSIONS };
      if (name === 'sessions') return { data: ALL_SESSIONS.filter((session) => session.profileId === value.profile) };
      if (name === 'messages') return { data: [{ role: 'user', content: 'hello' }] };
      throw new Error(`unexpected ${name}`);
    },
  };
  return { byId, calls };
}

function sessionItems(byId) {
  return byId('all-sessions').children.filter((node) => String(node.className).split(' ').includes('all-session') || String(node.className).startsWith('all-session'));
}

function collectedText(node) {
  return `${node.textContent || ''}${(node.children || []).map(collectedText).join('')}`;
}

describe('remote main window', { concurrency: false }, () => {
test('the main window factory receives root and renders the agent list', async () => {
  const { byId } = installDom();
  const api = require('../src/remote-main.js');
  await api.sync({
    remoteHermes: {
      enabled: true,
      host: '127.0.0.1',
      port: 9,
      profile: 'intelio',
      profilesWithKeys: ['intelio', 'prc', 'alignment', 'hhp'],
    },
  });
  const deadline = Date.now() + 1000;
  let sessions = [];
  while (Date.now() < deadline) {
    sessions = byId('remote-sessions').children.filter((node) => node.className.includes('session-item'));
    if (byId('bot-list').children.length === 4 && sessions.length >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(byId('bot-list').children.length, 4);
  assert.equal(byId('bot-count').textContent, '4');
  assert.ok(sessions.length >= 1);
  assert.equal(byId('remote-status').textContent, '');
  assert.equal(api.sidebar(), 'agents');
  assert.equal(byId('all-sessions').classList.hidden, true);
  assert.equal(globalThis.IntelioRemote, api);
});

test('threads for the selected agent sit under the agents, and the sessions list still filters', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const { byId, calls } = installDom();
  const saved = [];
  globalThis.workspace = {
    command(name, value) { saved.push({ name, value }); return Promise.resolve(); },
  };
  const api = require('../src/remote-main.js');
  await api.sync({
    sidebarTab: 'sessions',
    remoteHermes: {
      enabled: true,
      host: '127.0.0.1',
      port: 9,
      profile: 'intelio',
      profilesWithKeys: ['intelio', 'prc', 'alignment', 'hhp'],
    },
  });
  const deadline = Date.now() + 1000;
  let threads = [];
  while (Date.now() < deadline) {
    threads = byId('sidebar-threads').children.filter((node) => String(node.className).includes('session-item'));
    if (api.sidebar() === 'agents' && byId('bot-list').children.length === 4 && threads.length >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(api.sidebar(), 'agents');
  assert.equal(byId('bot-list').classList.hidden, false);
  assert.ok(threads.length >= 1);
  assert.equal(saved.some((entry) => entry.value?.sidebarTab === 'sessions'), false);
  api.setSidebar('sessions');
  let rows = [];
  const listedUntil = Date.now() + 1000;
  while (Date.now() < listedUntil) {
    rows = sessionItems(byId);
    if (rows.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].dataset.profile, 'prc');
  assert.deepEqual([...new Set(rows.map((row) => row.dataset.profile))].sort(), ['alignment', 'hhp', 'intelio', 'prc']);
  assert.ok(rows.some((row) => row.children.some((child) => String(child.className).includes('avatar'))));
  const newest = collectedText(rows[0]);
  assert.equal(newest.includes('photon/iMessage'), false);
  assert.equal(newest.includes('Telegram'), false);
  assert.equal(newest.includes('One-shot'), false);
  assert.equal(/\bAPI\b/.test(newest), false);
  assert.ok(newest.includes('Outreach'));
  assert.ok(newest.includes('Drafted intros.'));
  assert.ok(/\d/.test(newest));

  const search = byId('session-search');
  search.value = 'checkout';
  search.dispatch('input', { target: search });
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.profile), ['alignment']);

  search.value = '';
  search.dispatch('input', { target: search });
  const filter = byId('session-agent');
  filter.value = 'hhp';
  filter.dispatch('change', { target: filter });
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.profile), ['hhp']);

  filter.value = '';
  filter.dispatch('change', { target: filter });
  const prc = sessionItems(byId).find((row) => row.dataset.profile === 'prc');
  await prc.onclick();
  const opened = calls.find((call) => call.name === 'messages' && call.profile === 'prc');
  assert.equal(opened.id, 's-prc');
  assert.equal(byId('remote-status').textContent, '');

  api.setSidebar('agents');
  assert.equal(api.sidebar(), 'agents');
  assert.equal(byId('bot-list').classList.hidden, false);
  assert.equal(byId('bot-list').children.length, 4);
  assert.equal(byId('all-sessions').classList.hidden, true);
  assert.equal(saved.at(-1).value.sidebarTab, 'agents');
});
});
