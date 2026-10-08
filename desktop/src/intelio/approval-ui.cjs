'use strict';
/**
 * Inline approval prompt for the intelio chat (desktop and phone).
 *
 * Hermes sends `approval.request` on the chat stream when an agent needs a yes
 * before it acts. Under Hayden's rule that is only a push ("anything push is an
 * approval"): from the push-approval Hermes plugin (alans-way-agents) or from the
 * intelio computers relay. The answer goes to POST /v1/runs/<run_id>/approval
 * with { choice: 'once' | 'deny', request_id }; "Allow" is always for this one
 * command only.
 *
 * Low-key on purpose: one quiet line in the transcript with two small buttons,
 * no card, no warning colours. Styles: .approval-row in remote-main.css and the
 * phone's app.css (light, dark and blue themes).
 */
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.IntelioApproval = api;
}(typeof window !== 'undefined' ? window : null, () => {
  const OUTCOME_TEXT = {
    once: 'Allowed once',
    deny: 'Not allowed',
    expired: 'No longer waiting',
    failed: 'Could not send the answer',
  };

  /** Hermes approval payload -> what the row shows. */
  function describe(data = {}) {
    const text = String(data.command || '').replace(/\r\n/g, '\n');
    const m = /^(.+?) wants to ([^:\n]+): ([^\n]+)\n\n([\s\S]*?)(?:\n\n((?:in|typed into) [^\n]+))?$/.exec(text);
    if (m) {
      return { kind: m[2] === 'push' ? 'push' : 'other', title: `${m[1]} wants to ${m[2]}`, what: m[3], command: m[4].trim(), where: m[5] || '' };
    }
    return { kind: 'other', title: 'Allow this?', what: '', command: text.trim(), where: '' };
  }

  function answerable(data = {}) {
    return Boolean(data && data.run_id) && (!Array.isArray(data.choices) || data.choices.includes('once'));
  }

  /**
   * Builds the row. onAnswer(choice) must resolve when the answer was delivered;
   * a rejection shows "Could not send the answer" and re-enables the buttons.
   */
  function render(doc, data, { onAnswer } = {}) {
    const info = describe(data);
    const row = doc.createElement('div');
    row.className = 'approval-row';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', info.title);
    if (data.request_id) row.dataset.requestId = String(data.request_id);

    const line = doc.createElement('div');
    line.className = 'approval-line';
    const title = doc.createElement('span');
    title.className = 'approval-title';
    title.textContent = info.what ? `${info.title}:` : info.title;
    line.append(title);
    if (info.what) {
      const what = doc.createElement('span');
      what.className = 'approval-what';
      what.textContent = ` ${info.what}`;
      line.append(what);
    }
    row.append(line);

    if (info.command) {
      const code = doc.createElement('code');
      code.className = 'approval-command';
      code.textContent = info.command;
      row.append(code);
    }
    if (info.where) {
      const where = doc.createElement('div');
      where.className = 'approval-where';
      where.textContent = info.where;
      row.append(where);
    }

    const actions = doc.createElement('div');
    actions.className = 'approval-actions';
    const allow = doc.createElement('button');
    allow.type = 'button';
    allow.className = 'approval-allow';
    allow.textContent = 'Allow';
    allow.title = 'Allow this one command, once';
    const deny = doc.createElement('button');
    deny.type = 'button';
    deny.className = 'approval-deny';
    deny.textContent = "Don't allow";
    const note = doc.createElement('span');
    note.className = 'approval-note';
    note.setAttribute('aria-live', 'polite');
    actions.append(allow, deny, note);
    row.append(actions);

    const answer = async (choice) => {
      allow.disabled = true;
      deny.disabled = true;
      note.textContent = '';
      try {
        await (typeof onAnswer === 'function' ? onAnswer(choice) : Promise.resolve());
        settle(row, choice);
      } catch (error) {
        const gone = error && (error.status === 409 || /approval_not_pending|approval_not_active|no pending approval/i.test(String(error.message || '')));
        if (gone) { settle(row, 'expired'); return; }
        allow.disabled = false;
        deny.disabled = false;
        note.textContent = OUTCOME_TEXT.failed;
      }
    };
    allow.addEventListener('click', () => answer('once'));
    deny.addEventListener('click', () => answer('deny'));
    row.approval = { info, answer };
    return row;
  }

  /** Replaces the buttons with a quiet outcome line. */
  function settle(row, outcome) {
    if (!row || row.dataset.settled) return;
    row.dataset.settled = outcome;
    row.classList.add('settled', `settled-${outcome}`);
    const actions = row.querySelector('.approval-actions');
    if (!actions) return;
    const done = row.ownerDocument.createElement('span');
    done.className = 'approval-outcome';
    done.textContent = OUTCOME_TEXT[outcome] || outcome;
    actions.replaceChildren(done);
  }

  return { describe, answerable, render, settle, OUTCOME_TEXT };
}));
