/** Agent profile page. Colors come from the app theme. No second palette. */
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

  function mount(host, card, actions = {}) {
    if (!host || !card) return;
    const tab = actions.tab || 'details';
    host.replaceChildren();
    host.classList.remove('hidden');
    const page = el('div', 'agent-page');
    const head = el('header', 'agent-head');
    const orb = el('canvas', 'agent-orb');
    orb.width = 72;
    orb.height = 72;
    if (root.ThinkingOrbs && actions.orb) {
      root.ThinkingOrbs.mount(orb, { state: actions.orb, display: 72, size: 64, paused: true, speed: 1, accent: actions.accent || '' });
    }
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
    head.append(orb, titles, tools);
    page.append(head);

    const tabs = el('div', 'agent-subtabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['details', 'Details'], ['memory', 'Memory'], ['phone', card.phoneSoon ? 'Phone soon' : 'Phone']]) {
      const button = el('button', 'agent-subtab', label);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === id));
      button.addEventListener('click', () => actions.onTab?.(id));
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

  function detailsPane(card, actions) {
    const wrap = el('div', 'agent-details');
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

  root.IntelioAgentCard = { mount, copyText };
}(typeof window !== 'undefined' ? window : globalThis));
