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

test('payment Approve does not move money', () => {
  let run = bops.startRun({ text: "Pay Acme's invoice\nFile the receipt", profile: 'prc', agentName: 'PRC' });
  run = bops.applyTaskResult(run, 'task-1', { ok: false, error: 'Pay Acme invoice', code: 'approval_required' });
  const view = bops.viewModel(run);
  assert.equal(view.card.kind, 'payment');
  assert.equal(view.card.executesPayment, false);
  assert.deepEqual(view.card.actions.map((action) => action.label), ['Approve', 'Not now']);
  const acted = bops.actOnCard(view.card.taskId ? run : run, 'task-1', 'approve');
  assert.equal(acted.effect.type, 'hold-payment');
  assert.equal(acted.effect.moneyMove, false);
  assert.equal(acted.effect.lease, 'human');
  const released = bops.actOnCard(
    bops.applyTaskResult(bops.startRun({ text: 'Confirm the guest list' }), 'task-1', { ok: false, error: 'human_has_control' }),
    'task-1',
    'approve',
  );
  assert.equal(released.effect.type, 'release-lease');
  assert.equal(released.effect.lease, 'agent');
  assert.equal(released.effect.moneyMove, false);
});

test('login card Not now pauses computer use', () => {
  let run = bops.startRun({ text: 'Sign in to the portal' });
  run = bops.applyTaskResult(run, 'task-1', { ok: false, error: 'login wall' });
  assert.deepEqual(bops.viewModel(run).card.actions.map((action) => action.id), ['open-login', 'not-now']);
  const paused = bops.actOnCard(run, 'task-1', 'not-now');
  assert.equal(paused.effect.type, 'pause');
  assert.equal(paused.effect.lease, 'human');
  assert.equal(paused.effect.moneyMove, false);
  assert.equal(bops.viewModel(paused.run).card, null);
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

test('pills render, a click focuses that preview, and card actions stay local', async () => {
  delete require.cache[require.resolve('../src/remote-main.js')];
  const { byId } = installDom(async () => { throw new Error('unused'); });
  const api = require('../src/remote-main.js');
  let run = bops.startRun({ text: 'Check the inbox\nDraft the Friday recap', profile: 'intelio', agentName: 'Intelio' });
  api.pushFrame({ taskId: 'task-1', caption: 'inbox' });
  api.pushFrame({ taskId: 'task-2', caption: 'recap' });
  api.presentBops(run);
  assert.equal(byId('bops-header').textContent, 'Working on 2 things');
  assert.equal(byId('bops-bar').classList.hidden, false);
  const pills = byId('bops-pills').children;
  assert.equal(pills.length, 2);
  assert.equal(pills[0].dataset.status, 'running');
  assert.match(pills[0].className, /focused/);
  pills[1].onclick();
  assert.equal(byId('preview-screen').dataset.taskId, 'task-2');
  assert.equal(byId('preview-live').textContent, 'recap');
  assert.equal(byId('preview-badge').textContent, 'Intelio is browsing');
  assert.match(byId('preview-chrome').style.boxShadow, /#7a5cff/);
  assert.equal(byId('preview-chrome').dataset.highlight, '#7a5cff');

  byId('bops-stop').onclick();
  assert.ok(byId('bops-pills').children.every((pill) => pill.dataset.status === 'stopped'));
  assert.equal(byId('bops-header').textContent, '2 things');

  run = bops.applyTaskResult(bops.startRun({ text: 'Sign in to the portal\nDraft the recap', profile: 'intelio', agentName: 'Intelio' }), 'task-1', { ok: false, error: 'login wall' });
  api.presentBops(run);
  api.focusBops('task-1');
  assert.equal(byId('bops-card').classList.hidden, false);
  assert.match(byId('bops-card').children[0].textContent, /Login needs you|Sign in to the portal/);
  const actions = byId('bops-card').children.find((node) => node.className === 'bops-actions');
  actions.children.find((node) => node.dataset.action === 'not-now').onclick();
  assert.equal(byId('bops-card').classList.hidden, true);
  assert.equal(api.bopsEffect().type, 'pause');
  assert.equal(api.bopsEffect().moneyMove, false);

  const payment = bops.applyTaskResult(
    bops.startRun({ text: "Pay Acme's invoice\nFile the receipt", profile: 'intelio', agentName: 'Intelio' }),
    'task-1',
    { ok: false, error: 'Pay Acme invoice' },
  );
  api.presentBops(payment);
  const payActions = byId('bops-card').children.find((node) => node.className === 'bops-actions');
  payActions.children.find((node) => node.dataset.action === 'approve').onclick();
  assert.equal(api.bopsEffect().type, 'hold-payment');
  assert.equal(api.bopsEffect().moneyMove, false);
  assert.equal(api.bopsEffect().lease, 'human');
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
  assert.ok(byId('remote-messages').children.some((node) => String(node.textContent).includes('Working on 2 things')));
  assert.equal(byId('bops-header').textContent, '2 things');
  assert.equal(byId('bops-card').classList.hidden, false);
  assert.equal(byId('bops-card').children[0].textContent.includes('invoice') || byId('bops-card').textContent.includes('Pay'), true);
});
