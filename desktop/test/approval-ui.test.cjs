'use strict';
// Inline approval row (src/intelio/approval-ui.cjs) with a tiny DOM stand-in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const approval = require('../src/intelio/approval-ui.cjs');

function fakeDocument() {
  class Node {
    constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this._text = ''; this.className = ''; this.disabled = false; this.type = ''; this.title = ''; }
    get classList() { const self = this; return { add: (...c) => { self.className = [...new Set(`${self.className} ${c.join(' ')}`.trim().split(/\s+/))].join(' '); }, contains: (c) => self.className.split(/\s+/).includes(c) }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn(); }
    all() { return [this, ...this.children.flatMap((c) => c.all())]; }
    querySelector(sel) { const cls = sel.replace(/^\./, ''); return this.all().slice(1).find((n) => n.className.split(/\s+/).includes(cls)) || null; }
    querySelectorAll(sel) { const tag = sel.toUpperCase(); return this.all().slice(1).filter((n) => n.tagName === tag); }
  }
  const doc = { createElement: (tag) => new Node(tag.toUpperCase(), doc) };
  return doc;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

const PUSH = {
  command: 'prc wants to push: git push\n\ngit push origin fix/login\n\nin /home/user/code/app',
  description: 'intelio push approval: nothing is pushed unless you allow it.',
  pattern_key: 'mcp_elicitation', run_id: 'run_abc', request_id: 'req1', choices: ['once', 'session', 'always', 'deny'],
};

test('describe reads the push message from the plugin and the computers relay', () => {
  assert.deepEqual(approval.describe(PUSH), { kind: 'push', title: 'prc wants to push', what: 'git push', command: 'git push origin fix/login', where: 'in /home/user/code/app' });
  assert.deepEqual(approval.describe({ command: 'hayden-mac wants to push: gh pr merge\n\ngh pr merge 7 --squash\n\ntyped into terminal session s1' }).where, 'typed into terminal session s1');
  assert.deepEqual(approval.describe({ command: 'rm -rf build' }), { kind: 'other', title: 'Allow this?', what: '', command: 'rm -rf build', where: '' });
  assert.equal(approval.answerable(PUSH), true);
  assert.equal(approval.answerable({ command: 'x' }), false, 'no run id: nothing to answer');
});

test('Allow sends once and settles quietly; Don\'t allow sends deny', async () => {
  const doc = fakeDocument();
  const sent = [];
  const row = approval.render(doc, PUSH, { onAnswer: async (choice) => { sent.push(choice); } });
  assert.equal(row.className, 'approval-row');
  assert.equal(row.attrs.role, 'group');
  assert.match(row.textContent, /prc wants to push: git push/);
  assert.match(row.textContent, /git push origin fix\/login/);
  const [allow, deny] = row.querySelectorAll('button');
  assert.equal(allow.textContent, 'Allow');
  assert.equal(deny.textContent, "Don't allow");
  allow.click();
  await tick();
  assert.deepEqual(sent, ['once']);
  assert.equal(row.dataset.settled, 'once');
  assert.equal(row.querySelector('.approval-outcome').textContent, 'Allowed once');
  const row2 = approval.render(doc, PUSH, { onAnswer: async (choice) => { sent.push(choice); } });
  row2.querySelectorAll('button')[1].click();
  await tick();
  assert.deepEqual(sent, ['once', 'deny']);
  assert.equal(row2.querySelector('.approval-outcome').textContent, 'Not allowed');
});

test('a failed send can be retried; an expired prompt says so', async () => {
  const doc = fakeDocument();
  let fail = true;
  const row = approval.render(doc, PUSH, { onAnswer: async () => { if (fail) throw new Error('offline'); } });
  row.querySelectorAll('button')[0].click();
  await tick();
  assert.equal(row.dataset.settled, undefined);
  assert.equal(row.querySelector('.approval-note').textContent, 'Could not send the answer');
  assert.equal(row.querySelectorAll('button')[0].disabled, false);
  fail = false;
  row.querySelectorAll('button')[0].click();
  await tick();
  assert.equal(row.dataset.settled, 'once');
  const gone = approval.render(doc, PUSH, { onAnswer: async () => { throw Object.assign(new Error('Run has no pending approval'), { status: 409 }); } });
  gone.querySelectorAll('button')[0].click();
  await tick();
  assert.equal(gone.querySelector('.approval-outcome').textContent, 'No longer waiting');
});
