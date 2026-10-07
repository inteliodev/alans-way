const { test } = require('node:test');
const assert = require('node:assert/strict');
const bops = require('../src/intelio/bops.cjs');

function element(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    type: '',
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
      add() {},
      remove() {},
    },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes.flat(); },
    setAttribute() {},
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type, event) {
      return Promise.all((this.listeners[type] || []).map((fn) => fn(event)));
    },
    querySelector() { return { textContent: '' }; },
  };
}

function walk(node, acc = []) {
  if (!node) return acc;
  acc.push(node);
  for (const child of node.children || []) walk(child, acc);
  return acc;
}

function installDom(handler) {
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
  globalThis.remoteHermes = { onEvent() {}, request: handler };
  return { byId };
}

test('a sentence is one task, not fragments split on and', () => {
  const run = bops.startRun({
    text: 'How do I give you context to my life and understand everything',
    profile: 'intelio',
    agentName: 'Intelio',
  });
  assert.equal(run.tasks.length, 1);
  assert.equal(run.orchestration, 'single-session');
  assert.equal(bops.executionPlan(run).header, '');
});

test('one chat fans out parallel Hermes sessions from the app', () => {
  const run = bops.startRun({
    text: 'Check the inbox\nDraft the Friday recap\nOpen the CRM',
    profile: 'intelio',
    agentName: 'Intelio',
  });
  const plan = bops.executionPlan(run);
  assert.equal(plan.orchestration, 'app-fan-out');
  assert.equal(plan.header, 'Working on 3 things');
  assert.equal(plan.tasks.length, 3);
  assert.ok(plan.tasks.every((task) => task.profile === 'intelio' && task.createSession));
  assert.equal(plan.handoff, null);
  assert.equal(bops.executionPlan(bops.startRun({ text: 'Only one thing' })).orchestration, 'single-session');
});

test('task titles redact secrets', () => {
  const run = bops.startRun({ text: 'Rotate token sk-live-ABCDEFGHIJKLMNOP\nEmail the summary' });
  const blob = JSON.stringify(run);
  assert.equal(blob.includes('sk-live'), false);
  assert.equal(blob.includes('ABCDEFGHIJKLMNOP'), false);
  assert.match(run.tasks[0].title, /\[redacted\]/);
});

test('a payment pauses inline and does not move money', () => {
  let run = bops.startRun({ text: "Pay Acme's invoice\nFile the receipt", profile: 'prc', agentName: 'PRC' });
  run = bops.applyTaskResult(run, 'task-1', { ok: false, error: 'Pay Acme invoice', code: 'approval_required' });
  const view = bops.viewModel(run);
  assert.equal(view.signIn, null);
  assert.equal(view.card, undefined);
  assert.equal(view.pills[0].status, 'paused');
  assert.match(view.statusLines[0].text, /Payment paused/);
  assert.equal(JSON.stringify(view).includes('Approve'), false);
  assert.equal(JSON.stringify(view).includes('Not now'), false);
  assert.equal(JSON.stringify(view).includes('Needs you'), false);
  const paused = bops.applyTaskResult(bops.startRun({ text: 'Confirm the guest list' }), 'task-1', { ok: false, error: 'human_has_control' });
  const held = bops.viewModel(paused);
  assert.equal(held.signIn, null);
  assert.match(held.statusLines[0].text, /^Paused\.$/);
  assert.equal(JSON.stringify(held).includes('Needs you'), false);
});

test('login is a write-only secure sign-in', () => {
  let run = bops.startRun({ text: 'Sign in to the portal' });
  run = bops.applyTaskResult(run, 'task-1', { ok: false, error: 'login wall https://portal.example.com/login' });
  const view = bops.viewModel(run);
  assert.equal(view.signIn.domain, 'portal.example.com');
  assert.match(view.signIn.selectors.password, /input\[type="password"\]/);
  assert.deepEqual(view.signIn.actions.map((action) => action.label), ['Submit', 'Do it on screen']);
  assert.ok(view.signIn.fields.filter((field) => field.id !== 'username').every((field) => field.type === 'password'));
  const secret = 'hunter2-secret-value';
  const submitted = bops.submitSignIn(run, 'task-1', { username: 'ada', password: secret, otp: '123456', save: true });
  assert.equal(submitted.effect.type, 'secure-signin');
  assert.equal(submitted.effect.writeOnly, true);
  assert.equal(submitted.effect.moneyMove, false);
  assert.equal(submitted.effect.password, secret);
  assert.equal(submitted.effect.selectors.password, view.signIn.selectors.password);
  assert.equal(JSON.stringify(submitted.run).includes(secret), false);
  assert.equal(JSON.stringify(bops.executionPlan(submitted.run)).includes(secret), false);
  assert.equal(JSON.stringify(bops.viewModel(submitted.run)).includes(secret), false);
  assert.equal(JSON.stringify(bops.publicEffect(submitted.effect)).includes(secret), false);
  assert.equal(JSON.stringify(bops.publicEffect(submitted.effect)).includes('123456'), false);
  const screen = bops.doOnScreen(run, 'task-1');
  assert.equal(screen.effect.type, 'on-screen');
  assert.equal(screen.effect.moneyMove, false);
  assert.equal(bops.signalFromEvent('tool.failed', { error: 'human_has_control' }).ok, false);
});

test('handoff is a profile-isolated stub and copies no key', () => {
  const run = bops.startRun({ text: 'Check the deck\nHand this to PRC', profile: 'hhp', agentName: 'HHP' });
  const plan = bops.executionPlan(run);
  assert.equal(run.handoff.label, 'handed to PRC');
  assert.equal(run.handoff.stub, true);
  assert.ok(plan.tasks.every((task) => task.profile === 'hhp'));
  assert.equal(plan.handoff.profile, 'prc');
  assert.equal(plan.handoff.stub, true);
  const blob = JSON.stringify(plan);
  assert.equal(blob.includes('API_SERVER_KEY'), false);
  assert.equal(blob.includes('sk-live'), false);
  assert.match(bops.HANDOFF_STUB, /not copied/);
  assert.equal(bops.startRun({ text: 'Hand this to HHP', profile: 'hhp' }).handoff, null);
});

test('pills render, a click focuses that preview, and sign-in stays write-only', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const { byId } = installDom(async () => { throw new Error('unused'); });
  const api = require('../src/remote-main.js');
  let run = bops.startRun({ text: 'Check the inbox\nDraft the Friday recap', profile: 'intelio', agentName: 'Intelio' });
  api.pushFrame({ taskId: 'task-1', caption: 'inbox' });
  api.pushFrame({ taskId: 'task-2', caption: 'recap' });
  api.presentBops(run);
  assert.equal(byId('chat-status').textContent, 'Working on 2 things');
  assert.equal(byId('bops-bar').classList.hidden, true);
  assert.equal(byId('bops-pills').children.length, 0);
  assert.equal(byId('remote-messages').textContent.includes('Check the inbox'), false);
  api.focusBops('task-2');
  assert.equal(byId('preview-screen').dataset.taskId, 'task-2');
  assert.equal(byId('preview-live').textContent, 'recap');
  assert.equal(byId('preview-badge').textContent, 'intelio is browsing');
  assert.match(byId('preview-chrome').style.boxShadow, /#7a5cff/);
  assert.equal(byId('preview-chrome').dataset.highlight, '#7a5cff');

  byId('bops-stop').onclick();
  assert.equal(byId('bops-pills').children.length, 0);
  assert.equal(byId('chat-status').textContent, '');

  run = bops.applyTaskResult(bops.startRun({ text: 'Sign in to the portal\nDraft the recap', profile: 'intelio', agentName: 'Intelio' }), 'task-1', { ok: false, error: 'login wall https://portal.example.com/login' });
  const seen = [];
  globalThis.workspace = { command: async (name, value) => { seen.push({ name, domain: value.domain, password: value.password }); return { ok: true }; } };
  api.presentBops(run);
  api.focusBops('task-1');
  assert.equal(byId('bops-signin').classList.hidden, false);
  assert.match(walk(byId('bops-signin')).map((node) => node.textContent).join(' '), /portal\.example\.com/);
  const form = walk(byId('bops-signin')).find((node) => node.className === 'signin-form');
  const inputs = walk(form).filter((node) => node.dataset.field);
  assert.equal(inputs.find((node) => node.dataset.field === 'password').type, 'password');
  inputs.find((node) => node.dataset.field === 'username').value = 'ada';
  inputs.find((node) => node.dataset.field === 'password').value = 's3cret-password-value';
  inputs.find((node) => node.dataset.field === 'save').checked = true;
  await form.dispatch('submit', { preventDefault() {} });
  assert.equal(byId('bops-signin').classList.hidden, true);
  assert.equal(seen[0].name, 'fill-login');
  assert.equal(seen[0].password, 's3cret-password-value');
  assert.equal(JSON.stringify(api.bopsEffect()).includes('s3cret'), false);
  assert.equal(api.bopsEffect().moneyMove, false);
  const painted = walk(byId('bops-bar')).map((node) => node.textContent).join(' ');
  assert.equal(painted.includes('Approve'), false);
  assert.equal(painted.includes('Needs you'), false);

  const payment = bops.applyTaskResult(
    bops.startRun({ text: "Pay Acme's invoice\nFile the receipt", profile: 'intelio', agentName: 'Intelio' }),
    'task-1',
    { ok: false, error: 'Pay Acme invoice' },
  );
  api.presentBops(payment);
  assert.equal(byId('bops-signin').classList.hidden, true);
  assert.match(byId('bops-status').children[0].textContent, /Payment paused/);
  assert.equal(byId('bops-status').textContent.includes('Approve'), false);
});

test('a multi-task send creates one Hermes session per task', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const calls = [];
  const { byId } = installDom(async (name, value) => {
    calls.push({ name, profile: value?.profile || '', input: value?.input || '' });
    if (name === 'agents') {
      return { agents: [{ id: 'intelio', name: 'Intelio', orb: 'connecting' }, { id: 'prc', name: 'PRC' }, { id: 'alignment', name: 'Alignment' }, { id: 'hhp', name: 'HHP' }] };
    }
    if (name === 'all-sessions' || name === 'sessions' || name === 'messages') return { data: [] };
    if (name === 'create-session') return { session: { id: `s-${calls.length}` } };
    if (name === 'send') {
      if (String(value.input).includes('invoice')) {
        const error = new Error('Pay Acme invoice');
        error.code = 'approval_required';
        throw error;
      }
      return { ok: true };
    }
    throw new Error(`unexpected ${name}`);
  });
  const api = require('../src/remote-main.js');
  await api.sync({
    remoteHermes: { enabled: true, host: '127.0.0.1', port: 9, profile: 'intelio', profilesWithKeys: ['intelio', 'prc', 'alignment', 'hhp'] },
  });
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && byId('bot-list').children.length < 4) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const input = byId('remote-input');
  input.value = 'Check the inbox\nPay Acme invoice';
  await byId('remote-composer').dispatch('submit', { preventDefault() {} });
  const created = calls.filter((call) => call.name === 'create-session' && call.profile === 'intelio');
  assert.equal(created.length, 2);
  const sent = calls.filter((call) => call.name === 'send');
  assert.equal(sent.length, 2);
  assert.ok(sent.every((call) => call.profile === 'intelio'));
  assert.equal(JSON.stringify(sent).includes('sk-live'), false);
  const threadText = byId('remote-messages').children.map((node) => String(node.textContent || '')).join('\n');
  assert.match(threadText, /Read /);
  assert.equal(threadText.includes('Working on 2 things'), false);
  assert.equal(byId('chat-status').textContent, '');
  assert.equal(byId('remote-messages').children.some((node) => String(node.className).includes('bops-pill')), false);
  assert.equal(byId('bops-signin').classList.hidden, true);
  assert.match(byId('bops-status').children[0].textContent, /Payment paused/);
  assert.equal(byId('bops-status').textContent.includes('Approve'), false);
  assert.equal(byId('bops-status').textContent.includes('Needs you'), false);
});
