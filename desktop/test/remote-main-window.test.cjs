const { test } = require('node:test');
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
    addEventListener() {},
    querySelector(sel) {
      if (sel === 'h3' || sel === 'p') return { textContent: '' };
      return null;
    },
  };
}

function installDom() {
  const nodes = new Map();
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
      if (name === 'sessions') {
        return { data: [{ id: 's1', profileId: value.profile, source: 'telegram', sourceLabel: 'Telegram', title: 'Notes' }] };
      }
      if (name === 'messages') return { data: [{ role: 'user', content: 'hello' }] };
      throw new Error(`unexpected ${name}`);
    },
  };
  return { byId };
}

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
  assert.equal(globalThis.IntelioRemote, api);
});
