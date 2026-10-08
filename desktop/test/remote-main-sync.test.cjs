const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

// Same minimal DOM as bops.test.cjs: enough for remote-main.js to paint.
function element(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    type: '',
    title: '',
    dataset: {},
    style: {},
    children: [],
    disabled: false,
    value: '',
    checked: false,
    classList: {
      hidden: false,
      contains(name) { return name === 'hidden' && this.hidden; },
      toggle(name, force) { if (name === 'hidden') this.hidden = force === undefined ? !this.hidden : Boolean(force); },
      add(name) { if (name === 'hidden') this.hidden = true; },
      remove(name) { if (name === 'hidden') this.hidden = false; },
    },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes.flat(); },
    setAttribute() {},
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type, event) { return Promise.all((this.listeners[type] || []).map((fn) => fn(event))); },
    querySelector() { return { textContent: '' }; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const AGENTS = [{ id: 'intelio', name: 'intelio' }, { id: 'prc', name: 'PRC' }];
const SESSIONS = {
  intelio: [{ id: 's-intelio', profileId: 'intelio', title: 'Notes', updated_at: '2026-10-06T12:00:00Z' }],
  prc: [{ id: 's-prc', profileId: 'prc', title: 'Outreach', updated_at: '2026-10-06T13:00:00Z' }],
};
const REMOTE = { enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio', profilesWithKeys: ['intelio', 'prc'] };

/** Loads a fresh remote-main.js against a fake DOM and a scriptable Hermes. */
function load(overrides = {}) {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const nodes = new Map();
  const byId = (id) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  globalThis.document = { getElementById: byId, createElement: element, createTextNode(text) { return { textContent: text }; } };
  const calls = [];
  let listener = null;
  globalThis.remoteHermes = {
    onEvent(fn) { listener = fn; },
    async request(name, value = {}) {
      calls.push({ name, profile: value.profile || '', id: value.id || '', input: value.input || '' });
      if (overrides[name]) return overrides[name](value);
      if (name === 'agents') return { agents: AGENTS };
      if (name === 'screens' || name === 'all-sessions') return { data: [] };
      if (name === 'sessions') return { data: SESSIONS[value.profile] || [] };
      if (name === 'messages') return { data: [{ role: 'assistant', content: `${value.id} reply` }] };
      if (name === 'model-options') return {};
      throw new Error(`unexpected ${name}`);
    },
  };
  const api = require('../src/remote-main.js');
  return { api, byId, calls, emit: (event) => listener && listener(event) };
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function pane(byId) {
  return byId('remote-messages').children.map((node) => String(node.textContent || '')).join('\n');
}

test('a slow reply for the previously selected agent does not overwrite the new agent', async () => {
  const held = [];
  const { api, byId } = load({
    messages(value) {
      if (value.id === 's-intelio' && held.length === 0) {
        const wait = deferred();
        held.push(wait);
        return wait.promise;
      }
      return { data: [{ role: 'assistant', content: `${value.id} reply` }] };
    },
  });
  const first = api.sync({ remoteHermes: REMOTE });
  await settle();
  assert.equal(held.length, 1, 'the intelio thread is still loading');
  await api.selectAgent('prc');
  assert.match(pane(byId), /s-prc reply/);
  held[0].resolve({ data: [{ role: 'assistant', content: 'stale intelio reply' }] });
  await first;
  await settle();
  assert.match(pane(byId), /s-prc reply/);
  assert.equal(pane(byId).includes('stale intelio reply'), false);
  api.stopAutoRefresh();
});

test('stream events and the end-of-stream reload for a thread no longer on screen are ignored', async () => {
  const sending = deferred();
  const { api, byId, calls, emit } = load({ send: () => sending.promise });
  api.sync({ remoteHermes: REMOTE });
  await settle();
  byId('remote-input').value = 'hello intelio';
  const sent = byId('remote-composer').dispatch('submit', { preventDefault() {} });
  await settle();
  assert.equal(calls.filter((call) => call.name === 'send').length, 1);
  emit({ sessionId: 's-intelio', event: 'assistant.delta', data: { delta: 'partial ' } });
  await api.selectAgent('prc');
  emit({ sessionId: 's-intelio', event: 'assistant.delta', data: { delta: 'late token' } });
  assert.equal(pane(byId).includes('late token'), false);
  const before = calls.filter((call) => call.name === 'messages' && call.id === 's-intelio').length;
  sending.resolve({ ok: true });
  await sent;
  await settle();
  assert.equal(calls.filter((call) => call.name === 'messages' && call.id === 's-intelio').length, before);
  assert.match(pane(byId), /s-prc reply/);
  api.stopAutoRefresh();
});

test('a call transcript said during a reply is queued and sent when the reply finishes', async () => {
  const sending = [deferred(), deferred()];
  let index = 0;
  const { api, byId, calls } = load({ send: () => sending[index++].promise });
  api.sync({ remoteHermes: REMOTE });
  await settle();
  byId('remote-input').value = 'first question';
  const first = byId('remote-composer').dispatch('submit', { preventDefault() {} });
  await settle();
  assert.equal(api.voiceTranscript('and one more thing'), 'queued');
  assert.equal(api.voiceTranscript('also this'), 'queued');
  assert.match(byId('composer-note').textContent, /Queued/);
  assert.equal(calls.filter((call) => call.name === 'send').length, 1);
  sending[0].resolve({ ok: true });
  await first;
  await settle();
  const sends = calls.filter((call) => call.name === 'send');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].input, 'and one more thing also this');
  assert.equal(sends[1].profile, 'intelio');
  assert.equal(sends[1].id, 's-intelio');
  sending[1].resolve({ ok: true });
  await settle();
  api.stopAutoRefresh();
});

test('a failed create-session clears the task bar and keeps the text', async () => {
  const { api, byId } = load({
    sessions: () => ({ data: [] }),
    'create-session': () => { throw new Error('Hermes is offline.'); },
  });
  api.sync({ remoteHermes: REMOTE });
  await settle();
  byId('remote-input').value = 'hello';
  await byId('remote-composer').dispatch('submit', { preventDefault() {} });
  assert.equal(byId('remote-status').textContent, 'Hermes is offline.');
  assert.equal(byId('remote-input').value, 'hello');
  assert.equal(byId('bops-bar').classList.hidden, true);
  await api.refresh({ quiet: true });
  assert.equal(byId('chat-status').textContent, '');
  api.stopAutoRefresh();
});

test('agents, threads and watching refresh every 45 s without overlapping, and pause while signed out', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let hold = null;
  const { api, calls } = load({
    agents() {
      if (hold) return hold.promise.then(() => ({ agents: AGENTS }));
      return { agents: AGENTS };
    },
  });
  assert.equal(api.REFRESH_MS, 45000);
  api.sync({ remoteHermes: REMOTE });
  await settle();
  const count = (name) => calls.filter((call) => call.name === name).length;
  assert.equal(count('agents'), 1);
  const messagesBefore = count('messages');

  t.mock.timers.tick(45000);
  await settle();
  assert.equal(count('agents'), 2);
  assert.equal(count('screens'), 2);
  assert.ok(calls.filter((call) => call.name === 'sessions' && call.profile === 'intelio').length >= 2);
  assert.equal(count('messages'), messagesBefore, 'an unchanged open thread is not reloaded');

  // A focus right after a refresh is skipped.
  assert.equal(api.autoRefresh({ focus: true }), null);

  hold = deferred();
  t.mock.timers.tick(45000);
  await settle();
  assert.equal(count('agents'), 3);
  t.mock.timers.tick(45000);
  await settle();
  assert.equal(count('agents'), 3, 'no second refresh while one is in flight');
  hold.resolve();
  hold = null;
  await settle();

  api.sync({ remoteHermes: { ...REMOTE, needsSignIn: true } });
  await settle();
  const signedOut = count('agents');
  t.mock.timers.tick(45000);
  await settle();
  assert.equal(count('agents'), signedOut, 'no refresh while sign-in is needed');
  api.stopAutoRefresh();
});

test('the call button shows only when the agent card says the phone line is live', async () => {
  const { api, byId } = load({ 'agent-card': (value) => ({ id: value.profile, phoneSoon: value.profile !== 'prc' }) });
  api.sync({ remoteHermes: REMOTE });
  await settle();
  assert.equal(byId('chat-call').classList.hidden, true);
  await api.selectAgent('prc');
  await settle();
  assert.equal(byId('chat-call').classList.hidden, false);
  await api.selectAgent('intelio');
  assert.equal(byId('chat-call').classList.hidden, true);
  api.stopAutoRefresh();
});

test('show the server name, fall back to the built-in one for a bare slug', () => {
  const { api } = load();
  assert.equal(api.shownAgent('prc', 'Outreach'), 'Outreach');
  assert.equal(api.shownAgent('prc', 'prc'), 'PRC');
  assert.equal(api.shownAgent('prc', ''), 'PRC');
  assert.equal(api.shownAgent('ops', ''), 'Agent');
  assert.equal(api.shownAgent('intelio', 'Intelio'), 'intelio');
});
