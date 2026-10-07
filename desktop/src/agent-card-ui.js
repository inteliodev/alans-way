/** Agent profile page. Orb color is a per-agent accent, separate from the app theme. */
(function (root) {
  'use strict';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function copyText(value) {
    const text = String(value || '');
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
    return Promise.resolve(false);
  }

  function segment(label, options, selected, { disabled, onPick }) {
    const wrap = el('div', 'agent-block');
    const head = el('div', 'agent-block-head');
    head.append(el('h3', '', label));
    wrap.append(head);
    const row = el('div', 'agent-segment');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', label);
    for (const option of options) {
      const button = el('button', 'agent-seg', option.label);
      button.type = 'button';
      button.disabled = Boolean(disabled);
      button.setAttribute('aria-pressed', String(option.id === selected));
      if (!disabled) button.addEventListener('click', () => onPick(option.id));
      row.append(button);
    }
    wrap.append(row);
    return wrap;
  }

  const PALETTE = ['#7a5cff', '#1d4ed8', '#059669', '#0f766e', '#7c3aed', '#db2777', '#0369a1', '#44403c'];
  const ORB_STYLES = [
    ['connecting', 'Connecting'],
    ['solving', 'Solving'],
    ['searching', 'Searching'],
    ['weaving', 'Weaving'],
    ['working', 'Working'],
    ['listening', 'Listening'],
    ['breathing', 'Breathing'],
    ['shaping', 'Shaping'],
    ['composing', 'Composing'],
  ];

  function appearancePicker(card, actions) {
    const wrap = el('div', 'appearance-picker');
    wrap.append(el('p', 'picker-label', 'Orb'));
    const gallery = el('div', 'orb-gallery');
    gallery.setAttribute('role', 'listbox');
    gallery.setAttribute('aria-label', 'Orb style');
    const current = String(actions.orb || card.orb || '').trim().toLowerCase();
    for (const [id, label] of ORB_STYLES) {
      const button = el('button', 'orb-choice');
      button.type = 'button';
      button.dataset.orb = id;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(id === current));
      const canvas = el('canvas');
      canvas.width = 36;
      canvas.height = 36;
      canvas.dataset.orb = id;
      if (root.ThinkingOrbs) {
        root.ThinkingOrbs.mount(canvas, { state: id, display: 36, size: 64, paused: true, speed: 1, accent: card.color || actions.accent || '' });
      }
      button.append(canvas, el('span', 'orb-label', label));
      button.addEventListener('click', () => actions.onOrb?.(id));
      gallery.append(button);
    }
    wrap.append(gallery);
    wrap.append(el('p', 'picker-label', 'Color'));
    const colors = el('div', 'color-picker');
    for (const color of PALETTE) {
      const button = el('button', 'swatch');
      button.type = 'button';
      button.dataset.color = color;
      button.style.background = color;
      button.setAttribute('aria-label', color);
      button.setAttribute('aria-pressed', String(String(card.color || '').toLowerCase() === color));
      button.addEventListener('click', () => actions.onColor?.(color));
      colors.append(button);
    }
    const hex = el('input', 'hex-input');
    hex.value = card.color || '';
    hex.maxLength = 7;
    hex.setAttribute('aria-label', 'Custom color');
    hex.addEventListener('change', () => actions.onColor?.(hex.value.trim()));
    colors.append(hex);
    wrap.append(colors);
    return wrap;
  }

  function mountPicker(host, options = {}) {
    if (!host) return;
    host.replaceChildren(appearancePicker({ color: options.color || '', orb: options.orb || '' }, options));
  }

  function mount(host, card, actions = {}) {
    if (!host || !card) return;
    const tab = actions.tab || 'details';
    host.replaceChildren();
    host.classList.remove('hidden');
    const page = el('div', 'agent-page');
    const head = el('header', 'agent-head');
    const orbHit = el('button', 'orb-hit');
    orbHit.type = 'button';
    orbHit.setAttribute('aria-label', 'Change orb and color');
    const orb = el('canvas', 'agent-orb');
    orb.width = 72;
    orb.height = 72;
    if (root.ThinkingOrbs && actions.orb) {
      root.ThinkingOrbs.mount(orb, { state: actions.orb, display: 72, size: 64, paused: true, speed: 1, accent: card.color || actions.accent || '' });
    }
    orb.dataset.orb = actions.orb || '';
    orb.dataset.accent = card.color || actions.accent || '';
    orbHit.append(orb);
    orbHit.addEventListener('click', () => actions.onPickColor?.());
    const titles = el('div', 'agent-titles');
    titles.append(el('h2', '', card.name));
    if (card.title) titles.append(el('p', 'agent-role', card.title));
    const tools = el('div', 'agent-tools');
    const message = el('button', 'agent-tool', 'Message');
    message.type = 'button';
    message.setAttribute('aria-label', `Message ${card.name}`);
    message.addEventListener('click', () => actions.onMessage?.(card));
    const call = el('button', 'agent-tool', 'Call');
    call.type = 'button';
    call.setAttribute('aria-label', `Call ${card.name}`);
    call.addEventListener('click', () => actions.onCall?.(card));
    const video = el('button', 'agent-tool', 'Video');
    video.type = 'button';
    video.disabled = true;
    video.title = 'Video soon';
    video.setAttribute('aria-label', 'Video soon');
    const email = el('button', 'agent-tool', 'Email');
    email.type = 'button';
    email.disabled = !card.email;
    email.title = card.email ? `Copy ${card.email}` : 'No email configured';
    email.setAttribute('aria-label', card.email ? `Email ${card.name}` : 'Email not configured');
    email.addEventListener('click', () => actions.onCopy?.(card.email, 'Email copied.'));
    tools.append(message, call, video, email);
    head.append(orbHit, titles, tools);
    page.append(head);
    if (actions.picking) page.append(appearancePicker(card, actions));
    if (card.needsSignIn) page.append(el('p', 'agent-note', 'Needs sign-in'));
    if (card.gatewayNote) page.append(el('p', 'agent-muted', card.gatewayNote));

    const tabs = el('div', 'agent-subtabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['computer', 'Computer'], ['details', 'Details'], ['memory', 'Memory'], ['phone', card.phoneSoon ? 'Phone soon' : 'Phone']]) {
      const button = el('button', 'agent-subtab', label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === id));
      button.addEventListener('click', () => {
        if (id === 'computer') { actions.onComputer?.(); return; }
        actions.onTab?.(id);
      });
      tabs.append(button);
    }
    page.append(tabs);

    if (tab === 'memory') page.append(memoryPane(card, actions));
    else if (tab === 'phone') page.append(phonePane(card, actions));
    else page.append(detailsPane(card, actions));
    if (actions.note) page.append(el('p', 'agent-note', actions.note));
    host.append(page);
  }

  function field(label, value, copyLabel, onCopy) {
    const row = el('div', 'agent-field');
    const copy = el('div', '');
    copy.append(el('p', 'agent-kicker', label), el('p', 'agent-value', value || 'Not configured'));
    row.append(copy);
    if (value && onCopy) {
      const button = el('button', 'agent-copy', 'Copy');
      button.type = 'button';
      button.addEventListener('click', () => onCopy(value, copyLabel));
      row.append(button);
    }
    return row;
  }

  function editor(card, actions) {
    const form = el('form', 'profile-editor');
    const specs = [
      ['name', 'Name', card.name || ''],
      ['title', 'Title / role', card.title || ''],
      ['email', 'Email', card.email || ''],
      ['mobile', 'Mobile', card.phoneLabel || card.phone || ''],
    ];
    const inputs = {};
    for (const [key, label, value] of specs) {
      const row = el('label', 'edit-field', label);
      const input = el('input');
      input.value = value;
      inputs[key] = input;
      row.append(input);
      form.append(row);
    }
    const soulRow = el('label', 'edit-field', 'Instructions');
    const soul = el('textarea');
    soul.value = card.soul || '';
    soul.rows = 6;
    inputs.soul = soul;
    soulRow.append(soul);
    form.append(soulRow);
    const actionsRow = el('div', 'edit-actions');
    const save = el('button', 'agent-pause', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'agent-text', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => actions.onCancelEdit?.());
    actionsRow.append(save, cancel);
    form.append(actionsRow);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      actions.onSave?.({
        name: inputs.name.value,
        title: inputs.title.value,
        email: inputs.email.value,
        mobile: inputs.mobile.value,
        soul: inputs.soul.value,
      });
    });
    return form;
  }

  function detailsPane(card, actions) {
    const wrap = el('div', 'agent-details');
    if (actions.editing) {
      wrap.append(editor(card, actions));
      return wrap;
    }
    const persona = el('div', 'agent-block');
    const head = el('div', 'agent-block-head');
    head.append(el('h3', '', 'Instructions'));
    const edit = el('button', 'agent-text', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => actions.onEdit?.());
    head.append(edit);
    const text = String(card.soul || '').trim();
    const open = actions.soulOpen || text.length <= 180;
    persona.append(head, el('p', 'agent-muted', open ? (text || 'No instructions yet.') : `${text.slice(0, 180)}…`));
    if (text.length > 180) {
      const more = el('button', 'agent-text', actions.soulOpen ? 'Show less' : 'Show full');
      more.type = 'button';
      more.addEventListener('click', () => actions.onSoul?.(!actions.soulOpen));
      persona.append(more);
    }
    wrap.append(persona);
    wrap.append(field(card.phone ? 'mobile · iMessage' : 'mobile', card.phoneLabel, 'Number copied.', actions.onCopy));
    wrap.append(field('email', card.email, 'Email copied.', actions.onCopy));
    const computer = el('button', 'agent-block agent-link');
    computer.type = 'button';
    const compHead = el('div', 'agent-block-head');
    compHead.append(el('h3', '', 'Computer'), el('span', 'agent-status', `${card.computer.label} · open`));
    computer.append(compHead, el('p', 'agent-muted', `${card.name}'s computer`));
    computer.addEventListener('click', () => actions.onComputer?.());
    wrap.append(computer);

    const uses = el('div', 'agent-block');
    const usesHead = el('div', 'agent-block-head');
    usesHead.append(el('h3', '', 'Uses'));
    const manage = el('button', 'agent-text', 'Manage in Vault');
    manage.type = 'button';
    manage.addEventListener('click', () => actions.onVault?.(card));
    usesHead.append(manage);
    const icons = el('div', 'agent-uses');
    if (!card.uses.length) icons.append(el('p', 'agent-muted', 'No connected toolsets in this profile.'));
    for (const item of card.uses) {
      const badge = el('span', 'agent-use', item.name.slice(0, 1).toUpperCase());
      badge.title = item.name;
      icons.append(badge);
    }
    uses.append(usesHead, icons);
    wrap.append(uses);

    wrap.append(segment('Thinking', [
      { id: 'auto', label: 'Auto' },
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
    ], card.thinking, {
      disabled: !card.thinkingWritable || actions.busy,
      onPick: (id) => actions.onThinking?.(id),
    }));
    if (!card.thinkingWritable) wrap.append(el('p', 'agent-muted', 'Reasoning effort is read-only until this profile config has a model block.'));

    wrap.append(segment('Works on', [
      { id: 'auto', label: 'Auto' },
      { id: 'cloud', label: 'Cloud' },
      { id: 'local', label: 'Your computer' },
    ], card.worksOn, { disabled: true, onPick() {} }));
    wrap.append(el('p', 'agent-muted', 'These agents run on the VPS. This choice is read-only.'));

    const routines = el('div', 'agent-block');
    routines.append(el('h3', '', 'Routines and scheduled'));
    if (!card.routines.length) routines.append(el('p', 'agent-muted', 'No scheduled jobs.'));
    for (const job of card.routines) {
      const row = el('div', 'agent-job');
      row.append(el('strong', '', job.name), el('span', 'agent-muted', [job.schedule, job.status].filter(Boolean).join(' · ')));
      routines.append(row);
    }
    wrap.append(routines);

    const where = el('div', 'agent-block');
    where.append(el('h3', '', `Where to find ${card.name}`));
    const grid = el('div', 'agent-channels');
    for (const channel of card.channels) {
      const cell = el('div', 'agent-channel');
      const name = el('span', 'agent-channel-name', channel.label);
      const dot = el('span', `agent-dot ${channel.state}`);
      name.append(dot);
      cell.append(name, el('span', 'agent-muted', channel.detail));
      grid.append(cell);
    }
    where.append(grid);
    wrap.append(where);

    const share = el('button', 'agent-wide', 'Share contact');
    share.type = 'button';
    share.addEventListener('click', () => actions.onCopy?.(card.contact, 'Contact copied.'));
    wrap.append(share);

    if (actions.confirming) {
      const ask = el('div', 'agent-confirm');
      ask.append(el('p', '', actions.confirming));
      const yes = el('button', 'agent-pause', actions.confirmLabel || 'Pause');
      yes.type = 'button';
      yes.addEventListener('click', () => actions.onConfirm?.());
      const no = el('button', 'agent-text', 'Cancel');
      no.type = 'button';
      no.addEventListener('click', () => actions.onCancel?.());
      ask.append(yes, no);
      wrap.append(ask);
    } else {
      const pause = el('button', 'agent-pause', card.paused ? `Resume ${card.name}` : `Pause ${card.name}`);
      pause.type = 'button';
      pause.addEventListener('click', () => actions.onPause?.(card));
      wrap.append(pause);
    }
    return wrap;
  }

  function memoryPane(card, actions) {
    const wrap = el('div', 'agent-details');
    const search = el('input', 'agent-search');
    search.type = 'search';
    search.placeholder = 'Search memory';
    search.setAttribute('aria-label', 'Search memory');
    search.value = actions.query || '';
    const body = el('pre', 'agent-memory');
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const text = card.memory || 'No memory file for this profile.';
      if (!q) { body.textContent = text; return; }
      const lines = text.split('\n').filter((line) => line.toLowerCase().includes(q));
      body.textContent = lines.length ? lines.join('\n') : 'No matching lines.';
    };
    search.addEventListener('input', () => { actions.onQuery?.(search.value); paint(); });
    paint();
    wrap.append(search, body);
    return wrap;
  }

  function phonePane(card, actions) {
    const wrap = el('div', 'agent-details');
    wrap.append(el('h3', '', card.phoneSoon ? 'Phone soon' : 'Phone'));
    wrap.append(el('p', 'agent-muted', card.phoneSoon ? 'Twilio voice is not live for this agent. iMessage uses the number below.' : 'Calling uses the number below.'));
    wrap.append(field('iMessage', card.phoneLabel, 'Number copied.', actions.onCopy));
    return wrap;
  }

  root.IntelioAgentCard = { mount, copyText, mountPicker, styles: ORB_STYLES };
}(typeof window !== 'undefined' ? window : globalThis));
