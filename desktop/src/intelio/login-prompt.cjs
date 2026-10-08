'use strict';
/**
 * The in-chat sign-in card, shared by the desktop window and the phone.
 *
 *   ask     "intelio is trying to sign in to github.com" + username, password
 *           (masked, Show/Hide), "Remember for this agent" (on), Cancel, Sign in
 *   saved   "Signed in with saved login for github.com"
 *   filled  "Signed in to github.com" (typed on the card)
 *   stored  "Saved login for github.com" (no page open to fill yet)
 *
 * Cards are kept by prompt id and moved, not rebuilt, when the chat repaints,
 * so typing survives a refresh. The password is read once on Sign in, handed
 * to send('submit'), and cleared from the field. It is never put in the DOM
 * as text, in storage, or in a log.
 */
(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IntelioLoginPrompt = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const NOTICE_STATES = new Set(['saved', 'filled', 'stored']);

  function headline(prompt, agent) {
    const who = agent || 'intelio';
    const site = prompt.domain || 'a site';
    if (prompt.state === 'saved') return `Signed in with saved login for ${site}`;
    if (prompt.state === 'filled') return `Signed in to ${site}`;
    if (prompt.state === 'stored') return `Saved login for ${site}`;
    return `${who} is trying to sign in to ${site}`;
  }

  function subline(prompt, agent, remembered) {
    const who = agent || 'intelio';
    if (prompt.state === 'saved') return prompt.username ? `As ${prompt.username}. Remembered for ${who}.` : `Remembered for ${who}.`;
    if (prompt.state === 'filled') return remembered === false ? 'Used once. Not saved.' : `Remembered for ${who}.`;
    if (prompt.state === 'stored') return `${who} will use it when the sign-in page is open.`;
    return prompt.reason || 'Enter the login for this site. It goes to the encrypted vault on your server, not to the chat.';
  }

  function mark(domain) {
    const first = String(domain || '?').replace(/^www\./, '').charAt(0);
    return first ? first.toUpperCase() : '?';
  }

  function createLoginCards({ doc = root.document, send, agentName, onChange } = {}) {
    const cards = new Map();
    const hidden = new Set();
    const remembered = new Map();
    const host = doc.createElement('div');
    host.className = 'login-cards';
    host.setAttribute('aria-live', 'polite');

    function el(tag, cls, text) {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function nameFor(profile) {
      try { return (typeof agentName === 'function' && agentName(profile)) || profile || 'intelio'; } catch { return profile || 'intelio'; }
    }

    function buildAsk(card, prompt) {
      const form = el('form', 'login-card-form');
      form.setAttribute('autocomplete', 'off');
      form.noValidate = true;
      const userLabel = el('label', 'login-card-field');
      userLabel.append(el('span', 'login-card-label', 'Username or email'));
      const user = el('input', 'login-card-input');
      user.type = 'text';
      user.name = 'username';
      user.autocomplete = 'off';
      user.setAttribute('autocapitalize', 'none');
      user.spellcheck = false;
      user.setAttribute('aria-label', 'Username or email');
      userLabel.append(user);
      const passLabel = el('label', 'login-card-field');
      passLabel.append(el('span', 'login-card-label', 'Password'));
      const secret = el('span', 'login-card-secret');
      const pass = el('input', 'login-card-input');
      pass.type = 'password';
      pass.name = 'password';
      pass.autocomplete = 'off';
      pass.setAttribute('autocapitalize', 'none');
      pass.spellcheck = false;
      pass.setAttribute('aria-label', 'Password');
      const reveal = el('button', 'login-card-reveal', 'Show');
      reveal.type = 'button';
      reveal.setAttribute('aria-pressed', 'false');
      reveal.setAttribute('aria-label', 'Show password');
      reveal.addEventListener('click', () => {
        const show = pass.type === 'password';
        pass.type = show ? 'text' : 'password';
        reveal.textContent = show ? 'Hide' : 'Show';
        reveal.setAttribute('aria-pressed', show ? 'true' : 'false');
        reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
      secret.append(pass, reveal);
      passLabel.append(secret);
      const keep = el('label', 'login-card-remember');
      const box = el('input');
      box.type = 'checkbox';
      box.name = 'remember';
      box.checked = true;
      keep.append(box, el('span', '', 'Remember for this agent'));
      const note = el('p', 'login-card-error');
      note.hidden = true;
      const actions = el('div', 'login-card-actions');
      const cancel = el('button', 'login-card-cancel', 'Cancel');
      cancel.type = 'button';
      const submit = el('button', 'login-card-submit', 'Sign in');
      submit.type = 'submit';
      actions.append(cancel, submit);
      form.append(userLabel, passLabel, keep, note, actions);

      cancel.addEventListener('click', () => {
        cards.delete(card.dataset.id);
        card.remove();
        Promise.resolve(send && send('dismiss', { promptId: card.dataset.id, profile: card.dataset.profile })).catch(() => {}).then(() => onChange && onChange());
      });
      form.addEventListener('submit', (event) => {
        if (event && event.preventDefault) event.preventDefault();
        const username = String(user.value || '').trim();
        let password = String(pass.value || '');
        if (!password) { showError(card, 'Enter the password.'); pass.focus(); return; }
        const save = box.checked === true;
        pass.value = '';
        pass.type = 'password';
        reveal.textContent = 'Show';
        reveal.setAttribute('aria-pressed', 'false');
        submit.disabled = true;
        cancel.disabled = true;
        submit.textContent = 'Signing in…';
        showError(card, '');
        remembered.set(card.dataset.id, save);
        const payload = {
          promptId: card.dataset.id,
          profile: card.dataset.profile,
          domain: card.dataset.domain,
          username,
          password,
          save,
          submit: true,
        };
        password = '';
        Promise.resolve(send ? send('submit', payload) : null).then((result) => {
          payload.password = '';
          submit.disabled = false;
          cancel.disabled = false;
          submit.textContent = 'Sign in';
          if (result && result.prompt) paint(card, result.prompt);
          else if (result && (result.filled || result.saved)) paint(card, { id: card.dataset.id, profile: card.dataset.profile, domain: card.dataset.domain, state: result.filled ? 'filled' : 'stored', username });
          else showError(card, (result && result.error) || `Could not sign in to ${card.dataset.domain}. Try again.`);
          if (onChange) onChange();
        }, () => {
          payload.password = '';
          submit.disabled = false;
          cancel.disabled = false;
          submit.textContent = 'Sign in';
          showError(card, 'Could not reach the vault. Try again.');
        });
      });
      return form;
    }

    function showError(card, text) {
      const note = card.querySelector('.login-card-error');
      if (!note) return;
      note.textContent = text || '';
      note.hidden = !text;
    }

    function paint(card, prompt) {
      const notice = NOTICE_STATES.has(prompt.state);
      const was = card.dataset.state;
      card.dataset.state = prompt.state;
      card.classList.toggle('is-notice', notice);
      const agent = nameFor(prompt.profile || card.dataset.profile);
      card.querySelector('.login-card-title').textContent = headline(prompt, agent);
      card.querySelector('.login-card-sub').textContent = subline(prompt, agent, remembered.get(card.dataset.id));
      card.setAttribute('aria-label', headline(prompt, agent));
      if (notice && was !== prompt.state) {
        const form = card.querySelector('.login-card-form');
        if (form) form.remove();
        if (!card.querySelector('.login-card-close')) {
          const close = el('button', 'login-card-close', '×');
          close.type = 'button';
          close.setAttribute('aria-label', 'Close');
          close.addEventListener('click', () => { hidden.add(card.dataset.id); cards.delete(card.dataset.id); card.remove(); });
          card.querySelector('.login-card-head').append(close);
        }
      }
      if (!notice) showError(card, prompt.message || '');
    }

    function build(prompt) {
      const card = el('section', 'login-card');
      card.dataset.id = prompt.id;
      card.dataset.profile = prompt.profile || '';
      card.dataset.domain = prompt.domain || '';
      card.setAttribute('role', 'group');
      const head = el('div', 'login-card-head');
      const badge = el('span', 'login-card-mark', mark(prompt.domain));
      badge.setAttribute('aria-hidden', 'true');
      const words = el('div', 'login-card-words');
      words.append(el('strong', 'login-card-title'), el('span', 'login-card-sub'));
      head.append(badge, words);
      card.append(head);
      if (!NOTICE_STATES.has(prompt.state)) card.append(buildAsk(card, prompt));
      paint(card, prompt);
      return card;
    }

    // prompts: rows from GET /api/vault/prompts for the agent on screen.
    function update(prompts) {
      const list = Array.isArray(prompts) ? prompts.filter((p) => p && p.id && !hidden.has(p.id)) : [];
      const live = new Set(list.map((p) => p.id));
      for (const [id, card] of cards) {
        const busy = card.querySelector('.login-card-submit[disabled]');
        if (!live.has(id) && !busy) { card.remove(); cards.delete(id); }
      }
      for (const prompt of list) {
        let card = cards.get(prompt.id);
        if (!card) {
          card = build(prompt);
          cards.set(prompt.id, card);
        } else if (card.dataset.state !== prompt.state || (prompt.state === 'ask' && prompt.message)) {
          paint(card, prompt);
        }
        if (card.parentNode !== host) host.append(card);
      }
      host.hidden = cards.size === 0;
      return host;
    }

    return { element: host, update, cards, size: () => cards.size };
  }

  return { createLoginCards, headline, subline, NOTICE_STATES };
}));
