const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const transcript = require('../src/intelio/transcript.cjs');

const STEPS_COPY = /Worked through|See all steps|Stop all/;

test('conversation(): tool steps never render; a running tail is one typing bubble', () => {
  const done = transcript.conversation([
    { role: 'user', content: 'Fix the tests' },
    { role: 'tool', tool_name: 'terminal', content: 'ok', status: 'Done' },
    { role: 'tool', tool_name: 'read_file', content: 'ok', status: 'Done' },
    { role: 'tool', tool_name: 'read_file', content: 'ok', status: 'Done' },
    { role: 'assistant', content: 'All green.' },
  ]);
  assert.deepEqual(done.map((item) => item.kind), ['bubble', 'bubble']);
  assert.equal(STEPS_COPY.test(JSON.stringify(done)), false);

  const working = transcript.conversation([
    { role: 'user', content: 'Fix the tests' },
    { role: 'tool', tool_name: 'terminal', content: 'ok', status: 'Done' },
    { role: 'tool', tool_name: 'web_search', content: '', status: 'Running' },
  ]);
  assert.deepEqual(working.map((item) => item.kind), ['bubble', 'typing']);
  assert.equal(working[1].status, 'Looking things up…');

  const waiting = transcript.conversation([{ role: 'user', content: 'hi' }], { working: true });
  assert.deepEqual(waiting.map((item) => item.kind), ['bubble', 'typing']);
  assert.equal(waiting[1].status, '');
  assert.equal(transcript.typingStatus([{ name: 'terminal', running: false }]), '');
  assert.equal(transcript.typingStatus([{ name: 'terminal', running: true }]), 'Running a command…');
  assert.equal(transcript.typingStatus([{ name: 'mystery_tool', running: true }]), 'Mystery Tool…');
});

// Minimal DOM, as in remote-main-sync.test.cjs, plus remove() and attributes.
function element(tag) {
  const node = {
    tag,
    className: '',
    textContent: '',
    type: '',
    title: '',
    hidden: false,
    dataset: {},
    style: {},
    attrs: {},
    children: [],
    parent: null,
    disabled: false,
    value: '',
    classList: {
      hidden: false,
      contains(name) { return name === 'hidden' && this.hidden; },
      toggle(name, force) { if (name === 'hidden') this.hidden = force === undefined ? !this.hidden : Boolean(force); },
      add(name) { if (name === 'hidden') this.hidden = true; },
      remove(name) { if (name === 'hidden') this.hidden = false; },
    },
    append(...nodes) { for (const child of nodes) { if (child && typeof child === 'object') child.parent = node; node.children.push(child); } },
    replaceChildren(...nodes) { node.children = []; node.append(...nodes.flat()); },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node); node.parent = null; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name]; },
    listeners: {},
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    dispatch(type, event) { return Promise.all((node.listeners[type] || []).map((fn) => fn(event))); },
    querySelector() { return null; },
  };
  return node;
}

function deferred() {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}
const allText = (node) => walk(node).map((item) => String(item.textContent || '')).join('\n');
const byClass = (node, name) => walk(node).filter((item) => String(item.className || '').split(/\s+/).includes(name));

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('desktop chat: typing bubble while the agent works, replaced by the reply, no step list', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const nodes = new Map();
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  globalThis.document = { getElementById: byId, createElement: element, createTextNode(text) { return { textContent: text }; } };
  globalThis.IntelioTranscript = transcript;
  const sending = deferred();
  let replied = false;
  let listener = null;
  globalThis.remoteHermes = {
    onEvent(fn) { listener = fn; },
    async request(name, value = {}) {
      if (name === 'agents') return { agents: [{ id: 'intelio', name: 'intelio' }] };
      if (name === 'screens' || name === 'all-sessions') return { data: [] };
      if (name === 'sessions') return { data: [{ id: 's1', profileId: 'intelio', title: 'Tests' }] };
      if (name === 'model-options') return {};
      if (name === 'send') return sending.promise;
      if (name === 'messages') {
        if (!replied) return { data: [] };
        return { data: [
          { role: 'user', content: 'get those tests to pass' },
          ...Array.from({ length: 16 }, (_, i) => ({ role: 'tool', tool_name: i % 2 ? 'read_file' : 'terminal', content: 'ok', status: 'Done' })),
          { role: 'assistant', content: 'Tests pass now.' },
        ] };
      }
      throw new Error(`unexpected ${name} ${value.id || ''}`);
    },
  };
  const api = require('../src/remote-main.js');
  api.sync({ remoteHermes: { enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio', profilesWithKeys: ['intelio'] } });
  await settle();
  byId('remote-input').value = 'get those tests to pass';
  const sent = byId('remote-composer').dispatch('submit', { preventDefault() {} });
  await settle();
  const pane = byId('remote-messages');

  let bubbles = byClass(pane, 'typing-bubble');
  assert.equal(bubbles.length, 1, 'one typing bubble while the agent works');
  assert.equal(byClass(bubbles[0], 'think-dots')[0].children.length, 3);
  assert.equal(byClass(bubbles[0], 'typing-stop').length, 1, 'a small stop control rides on the bubble');

  listener({ sessionId: 's1', event: 'tool.started', data: { tool_name: 'terminal' } });
  listener({ sessionId: 's1', event: 'tool.completed', data: { tool_name: 'terminal' } });
  listener({ sessionId: 's1', event: 'tool.started', data: { tool_name: 'read_file' } });
  listener({ sessionId: 's1', event: 'tool.started', data: { tool_name: 'read_file' } });
  bubbles = byClass(pane, 'typing-bubble');
  assert.equal(bubbles.length, 1, 'still one bubble, not a stack of tool pills');
  assert.equal(byClass(pane, 'tool-chip').length, 0);
  assert.equal(byClass(bubbles[0], 'typing-status')[0].textContent, 'Reading files…');
  assert.equal(STEPS_COPY.test(allText(pane)), false);

  replied = true;
  sending.resolve({ ok: true });
  await sent;
  await settle();
  assert.equal(byClass(pane, 'typing-bubble').length, 0, 'the reply replaces the bubble');
  assert.equal(byClass(pane, 'tool-chip').length, 0);
  assert.match(allText(pane), /Tests pass now\./);
  assert.equal(STEPS_COPY.test(allText(pane)), false);
  api.stopAutoRefresh();
  delete globalThis.IntelioTranscript;
});

test('phone and legacy chat views use conversation() and drop the step list', () => {
  const root = path.resolve(__dirname, '../..');
  const app = fs.readFileSync(path.join(root, 'mobile/pwa/public/app.js'), 'utf8');
  const legacy = fs.readFileSync(path.join(root, 'desktop/src/remote-hermes-ui.js'), 'utf8');
  for (const source of [app, legacy]) {
    assert.match(source, /IntelioTranscript\.conversation\(/);
    assert.match(source, /typing-status/);
    assert.equal(/'Stop all'|Worked through/.test(source), false);
  }
  const css = fs.readFileSync(path.join(root, 'desktop/src/remote-main.css'), 'utf8');
  assert.match(css, /\.msg\.assistant\.typing-bubble \{/);
  assert.match(fs.readFileSync(path.join(root, 'mobile/pwa/public/app.css'), 'utf8'), /\.bubble\.bot\.typing \{/);
});
