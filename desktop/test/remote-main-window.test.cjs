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
            { id: 'prc', name: 'PRC', orb: 'solving', title: 'Outreach', description: 'In one short sentence, who are you?' },
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
    if (byId('bot-count').textContent === '4' && byId('bot-list').children.length === 3 && sessions.length >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(byId('bot-list').children.length, 3);
  assert.equal(byId('lead-card').classList.hidden, false);
  const prc = byId('bot-list').children.find((node) => node.dataset.botId === 'prc');
  const prcText = collectedText(prc);
  assert.equal(prcText.includes('In one short sentence'), false);
  assert.ok(prcText.includes('Outreach'));
  assert.ok(prcText.includes('Drafted intros.'));
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
    threads = byId('sidebar-threads').children.filter((node) => String(node.className).includes('thread-line'));
    if (api.sidebar() === 'agents' && byId('bot-count').textContent === '4' && threads.length >= 1) break;
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
  assert.ok(rows.every((row) => row.children.some((child) => String(child.className).includes('session-dot'))));
  const newest = collectedText(rows[0]);
  assert.equal(newest.includes('photon/iMessage'), false);
  assert.equal(newest.includes('Telegram'), false);
  assert.equal(newest.includes('One-shot'), false);
  assert.equal(/\bAPI\b/.test(newest), false);
  assert.ok(newest.includes('Outreach'));
  assert.ok(rows[0].title.includes('Drafted intros.'));
  assert.ok(/\d|now/.test(newest));

  const search = byId('session-search');
  search.value = 'checkout';
  search.dispatch('input', { target: search });
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.profile), ['alignment']);

  search.value = '';
  search.dispatch('input', { target: search });
  const chip = (agent) => byId('session-agents').children.find((node) => node.dataset.agent === agent);
  assert.deepEqual(byId('session-agents').children.map((node) => node.dataset.agent), ['', 'intelio', 'prc', 'alignment', 'hhp']);
  chip('hhp').onclick();
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.profile), ['hhp']);

  chip('').onclick();
  const prc = sessionItems(byId).find((row) => row.dataset.profile === 'prc');
  await prc.onclick();
  const opened = calls.find((call) => call.name === 'messages' && call.profile === 'prc');
  assert.equal(opened.id, 's-prc');
  assert.equal(byId('remote-status').textContent, '');

  api.setSidebar('agents');
  assert.equal(api.sidebar(), 'agents');
  assert.equal(byId('bot-list').classList.hidden, false);
  assert.equal(byId('bot-list').children.length, 3);
  assert.equal(byId('all-sessions').classList.hidden, true);
  assert.equal(saved.at(-1).value.sidebarTab, 'agents');
});

test('the Sessions tab groups by date, pins first, and renames, pins, archives and deletes through Hermes', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const { byId } = installDom();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const rows = [
    { id: 's-today', profileId: 'prc', title: 'Today work', preview: 'p1', updated_at: iso(60 * 1000) },
    { id: 's-old', profileId: 'hhp', title: 'Old one', preview: 'p2', updated_at: iso(60 * 86400000) },
    { id: 's-pinned', profileId: 'intelio', title: 'Pinned plan', preview: 'p3', pinned: true, updated_at: iso(90 * 86400000) },
    { id: 's-archived', profileId: 'alignment', title: 'Shelved', preview: 'p4', archived: true, updated_at: iso(2 * 86400000) },
  ];
  const updates = [];
  const original = globalThis.remoteHermes.request;
  globalThis.remoteHermes.request = async (name, value) => {
    if (name === 'all-sessions') return { data: rows.map((row) => ({ ...row })) };
    if (name === 'session-update') { updates.push(value); return { ok: true }; }
    if (name === 'session-delete') { updates.push({ deleted: value.id, profile: value.profile }); return { ok: true }; }
    return original(name, value);
  };
  const api = require('../src/remote-main.js');
  await api.sync({ remoteHermes: { enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio', profilesWithKeys: ['intelio', 'prc', 'alignment', 'hhp'] } });
  api.setSidebar('sessions');
  const until = Date.now() + 1000;
  while (Date.now() < until && sessionItems(byId).length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
  const groups = () => byId('all-sessions').children.filter((node) => node.className === 'session-group').map((node) => node.textContent);
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.sessionId), ['s-pinned', 's-today', 's-old']);
  const sections = byId('all-sessions').children.filter((node) => node.className === 'session-section').map((node) => collectedText(node));
  assert.deepEqual(sections, ['Pinned', 'Sessions']);
  assert.deepEqual(groups(), ['Older']);
  assert.equal(byId('session-archived').textContent, 'Archived (1)');

  const menuFor = (id) => {
    const row = sessionItems(byId).find((node) => node.dataset.sessionId === id);
    row.children.find((node) => node.className === 'session-more').onclick({ stopPropagation() {} });
    const menu = row.children.find((node) => node.className === 'session-menu');
    return (label) => menu.children.find((node) => node.textContent === label);
  };
  menuFor('s-today')('Pin to top').onclick({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates.at(-1), { profile: 'prc', id: 's-today', fields: { pinned: true } });
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.sessionId).slice(0, 2).sort(), ['s-pinned', 's-today']);

  menuFor('s-old')('Archive').onclick({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates.at(-1), { profile: 'hhp', id: 's-old', fields: { archived: true } });
  assert.equal(sessionItems(byId).some((row) => row.dataset.sessionId === 's-old'), false);
  byId('session-archived').dispatch('click', {});
  assert.deepEqual(sessionItems(byId).map((row) => row.dataset.sessionId).sort(), ['s-archived', 's-old']);
  byId('session-archived').dispatch('click', {});

  const del = menuFor('s-today')('Delete');
  del.onclick({ stopPropagation() {} });
  assert.equal(updates.some((entry) => entry.deleted), false, 'the first click only arms Delete');
  del.onclick({ stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates.at(-1), { deleted: 's-today', profile: 'prc' });
  assert.equal(sessionItems(byId).some((row) => row.dataset.sessionId === 's-today'), false);
});
test('New session opens an empty thread with the agent wordmark instead of the latest thread', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const { byId, calls } = installDom();
  const api = require('../src/remote-main.js');
  await api.sync({ remoteHermes: { enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio', profilesWithKeys: ['intelio', 'prc', 'alignment', 'hhp'] } });
  const until = Date.now() + 1000;
  while (Date.now() < until && !calls.some((call) => call.name === 'messages')) await new Promise((resolve) => setTimeout(resolve, 10));
  const before = calls.filter((call) => call.name === 'messages').length;
  byId('session-new').dispatch('click', {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.filter((call) => call.name === 'messages').length, before, 'no older thread is opened');
  const empty = byId('remote-messages').children.find((node) => node.className === 'chat-empty');
  assert.ok(empty);
  assert.equal(empty.children[0].className, 'chat-wordmark');
  assert.equal(empty.children[0].textContent, 'intelio');
});
});
