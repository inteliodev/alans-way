const api = window.workspace;
let state, draggingBot = '', focusMode = false, modalOpen = false, resizeFrame, toastTimer, botListSignature = '';
const $ = (id) => document.getElementById(id);
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
async function command(name, value = {}) { try { return await api.command(name, value); } catch (error) { toast(error.message); } }
function orderedBots(includeHidden = false) {
  const bots = state.bots.filter((bot) => includeHidden || !state.hidden.includes(bot.id));
  const mode = state.botSort || 'manual';
  if (mode === 'recent') bots.sort((a, b) => (b.lastId || 0) - (a.lastId || 0));
  else if (mode === 'alpha') bots.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  else {
    const order = new Map(state.order.map((id, index) => [id, index]));
    bots.sort((a, b) => (order.get(a.id) ?? 10000) - (order.get(b.id) ?? 10000));
  }
  return bots.sort((a, b) => Number(b.id === state.primaryBotId) - Number(a.id === state.primaryBotId));
}
function colorFor(value) {
  const colors = ['#e6e6eb', '#00ba83', '#e9428b', '#f18b31', '#9673e1', '#22b9b7', '#689be4'];
  return colors[Array.from(value).reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % colors.length];
}
function renderBots() {
  const search = $('bot-search').value.toLowerCase();
  const bots = orderedBots().filter((bot) => `${bot.name} ${bot.username}`.toLowerCase().includes(search));
  const list = $('bot-list');
  const signature = JSON.stringify([bots.map(({ activity, ...bot }) => bot), state.selectedBotId, state.primaryBotId, state.botSort]);
  if (signature === botListSignature) {
    for (const row of list.children) {
      const bot = bots.find(item => item.id === row.dataset.botId);
      if (bot) { window.HermesAvatars.paint(row.querySelector('.avatar'), bot, state); renderBotActivity(row, bot); }
    }
    document.querySelectorAll('.bridge-dot').forEach((dot) => dot.classList.toggle('offline', !state.api.ready));
    return;
  }
  botListSignature = signature; list.replaceChildren();
  for (const bot of bots) {
    const row = element('div', `bot-row${state.selectedBotId === bot.id ? ' selected' : ''}${state.primaryBotId === bot.id ? ' primary' : ''}`);
    row.setAttribute('role', 'button'); row.setAttribute('tabindex', '0'); row.setAttribute('aria-label', `Open ${bot.name}`); row.draggable = (state.botSort || 'manual') === 'manual'; row.dataset.botId = bot.id;
    const avatar = element('span', 'avatar'); window.HermesAvatars.paint(avatar, bot, state);
    const copy = element('span', 'bot-copy');
    const nameLine = element('div', 'bot-name', bot.name);
    if (state.primaryBotId === bot.id) nameLine.append(element('span', 'primary-badge', 'PRIMARY'));
    copy.append(nameLine, element('div', 'bot-preview', bot.preview || (bot.username ? `@${bot.username}` : 'Telegram bot')), element('div', 'bot-activity'));
    const hide = element('button', 'bot-hide', '×'); hide.title = `Hide ${bot.name}`; hide.setAttribute('aria-label', hide.title);
    hide.onclick = (event) => { event.stopPropagation(); command('hide-bot', { id: bot.id }); };
    row.append(avatar, copy); if (bot.unread) row.append(element('span', 'unread')); row.append(hide);
    row.onclick = () => command('open-bot', { id: bot.id });
    row.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); command('open-bot', { id: bot.id }); } };
    row.ondragstart = (event) => { draggingBot = bot.id; row.classList.add('dragging'); event.dataTransfer.setData('text/plain', bot.id); event.dataTransfer.effectAllowed = 'move'; };
    row.ondragend = () => { draggingBot = ''; row.classList.remove('dragging'); document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')); };
    row.ondragover = (event) => { if (draggingBot && draggingBot !== bot.id && bot.id !== state.primaryBotId) { event.preventDefault(); row.classList.add('drop-target'); } };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = (event) => {
      event.preventDefault(); row.classList.remove('drop-target');
      const ids = orderedBots(true).map((item) => item.id), from = ids.indexOf(draggingBot), to = ids.indexOf(bot.id);
      if (from >= 0 && to >= 0) { ids.splice(from, 1); ids.splice(to, 0, draggingBot); command('sort-bots', { ids }); }
    };
    renderBotActivity(row, bot); list.append(row);
  }
  $('bot-count').textContent = orderedBots().length;
  $('sort-bots').classList.toggle('active', (state.botSort || 'manual') !== 'manual');
  $('empty-bots').classList.toggle('hidden', state.bots.length > 0);
  $('empty-bots').querySelector('p').textContent = state.telegramStatus === 'connected' ? 'Finding your Telegram bot chats…' : 'Sign in to Telegram to load your bot chats here.';
  document.querySelectorAll('.bridge-dot').forEach((dot) => dot.classList.toggle('offline', !state.api.ready));
}
function renderBotActivity(row, bot) {
  const status = row.querySelector('.bot-activity'), activity = bot.activity;
  const active = activity?.state === 'active' && (!activity.expiresAt || activity.expiresAt > Date.now());
  status.replaceChildren();
  if (active) {
    const dots = element('span', 'hw-dots');
    dots.append(element('i'), element('i'), element('i'));
    if (bot.hue !== undefined) dots.style.setProperty('--h', String(bot.hue));
    status.append(dots, document.createTextNode(activity.label || 'Telegram activity'));
  } else {
    status.textContent = activity?.state === 'idle' ? 'Idle' : 'Activity unavailable';
  }
  status.classList.toggle('active', active);
  status.title = activity?.detail || 'Live Telegram chat actions. No activity signal does not prove a bot has stopped working.';
}
function tabIcon(tab) {
  const icon = element('span', 'tab-icon');
  if (tab.controller === 'agent') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 19 25');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', 'M1 1v19l5-5 4 9 4-2-4-8h7Z'); svg.append(path);
    icon.append(svg); icon.classList.add('tab-agent-cursor'); icon.style.setProperty('--h', String(tab.agentHue ?? 168)); return icon;
  }
  if (tab.favicon) { const img = element('img', 'tab-favicon'); img.src = tab.favicon; img.alt = ''; img.onerror = () => { img.replaceWith(tab.symbol || '◈'); }; icon.append(img); return icon; }
  icon.textContent = tab.symbol; return icon;
}
let agentPane = false;
const agentUi = { id: '', tab: 'details', query: '', note: '', confirming: false, card: null, busy: false, editing: false, picking: false, soulOpen: false };
function pinTab(label, selected, onClick) {
  const node = element('div', `tab pin${selected ? ' active' : ''}`);
  node.setAttribute('role', 'tab');
  node.setAttribute('aria-selected', selected ? 'true' : 'false');
  node.tabIndex = 0;
  node.append(element('span', 'tab-title', label));
  node.onclick = onClick;
  node.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } };
  return node;
}
function paneAgentName(id) {
  const key = String(id || '').trim().toLowerCase();
  const card = agentUi.card && agentUi.card.id === key ? String(agentUi.card.name || '').trim() : '';
  // The server's name wins; the built-in names cover a missing name or a bare slug.
  if (card && card.toLowerCase() !== key) return card.toLowerCase() === 'intelio' ? 'intelio' : card;
  const known = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
  return known[key] || card;
}
window.renderIntelioTabs = () => renderTabs();
function renderTabs() {
  const container = $('tabs'); container.replaceChildren();
  if (remoteActive()) {
    const chatName = window.IntelioRemote?.selectedName?.() || 'Agent';
    const shown = agentPane ? (paneAgentName(agentUi.id) || chatName) : chatName;
    container.append(pinTab(`${shown}'s computer`, !agentPane && state.activeTabId === 'vps', () => {
      agentPane = false;
      agentUi.confirming = false;
      if (state.activeTabId !== 'vps') command('activate', { id: 'vps' });
      else render(state);
    }));
    container.append(pinTab(shown, agentPane, () => openAgentPane(agentUi.id || undefined)));
  }
  const entries = state.tabs.map((tab) => ({ ...tab, symbol: tab.loading ? '◌' : '◈' }));
  for (const tab of entries) {
    const selected = !agentPane && state.browserTabId === tab.id;
    const node = element('div', `tab${selected ? ' active' : ''}`); node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', selected ? 'true' : 'false'); node.tabIndex = 0;
    node.append(tabIcon(tab), element('span', 'tab-title', tab.title || 'New tab'));
    if (tab.controller === 'agent') { node.classList.add('agent'); node.append(element('span', 'agent-dot')); }
    if (tab.agentBusy) node.classList.add('busy');
    if(tab.host)node.title=`${tab.host==='vps'?'VPS':'Mac'} · ${state.bots.find(bot=>bot.id===tab.botId)?.name || tab.botId}${tab.controller === 'agent' ? ' · agent-controlled' : ''}`;
    node.onclick = () => { agentPane = false; command('activate', { id: tab.id }); };
    node.onkeydown = (event) => { if (event.key === 'Enter') { agentPane = false; command('activate', { id: tab.id }); } };
    const close = element('button', 'tab-close', '×'); close.title = `Close ${tab.title || 'tab'}`; close.setAttribute('aria-label', close.title);
    close.onclick = (event) => { event.stopPropagation(); command('close-tab', { id: tab.id }); }; node.append(close);
    container.append(node);
  }
}
function extensionIcon(item) {
  if (!item.icon) return element('span', 'extension-letter', item.name.slice(0, 1));
  const image = element('img'); image.src = item.icon; image.alt = ''; return image;
}
function openExtension(item, button) {
  const box = button.getBoundingClientRect();
  closeModal(); command('open-extension', { key: item.key, anchor: { x: box.right, y: box.bottom + 6 } });
}
function renderExtensions() {
  const items = state.extensions || [], signature = JSON.stringify(items);
  let actions = $('native-extension-actions');
  if (!actions) {
    actions = element('browser-action-list'); actions.id = 'native-extension-actions'; actions.setAttribute('partition', 'persist:browser'); actions.setAttribute('alignment', 'bottom'); $('pinned-extensions').append(actions);
    actions.addEventListener('click', event => {
      const button = event.composedPath().find(node => node.tagName === 'BUTTON'), item = state.extensions.find(item => item.id === button?.id);
      if (item) { event.preventDefault(); event.stopImmediatePropagation(); openExtension(item, button); }
    }, true);
    actions.addEventListener('contextmenu', event => { event.preventDefault(); event.stopImmediatePropagation(); showExtensions(); }, true);
  }
  actions.setAttribute('tab', String(state.browserContentsId || -1));
  if (actions.shadowRoot) {
    let style = actions.shadowRoot.querySelector('#pin-filter');
    if (!style) { style = element('style'); style.id = 'pin-filter'; actions.shadowRoot.append(style); }
    const pinned = items.filter(item => item.pinned && item.loaded && item.enabled && /^[a-p]{32}$/.test(item.id));
    style.textContent = `.action${pinned.map(item => `:not([id="${item.id}"])`).join('')}{display:none!important}`;
  }
  const list = $('extension-list'); if (!modalOpen || !list || list.dataset.signature === signature) return;
  const focused = document.activeElement?.getAttribute('aria-label');
  list.dataset.signature = signature; list.replaceChildren();
  if (!items.length) list.append(element('p', 'settings-note', 'No extensions added yet. Browse the Chrome Web Store to add one.'));
  for (const item of items) {
    const row = element('div', 'extension-row'), icon = element('span', 'extension-manager-icon'), copy = element('div', 'visibility-copy'); icon.append(extensionIcon(item));
    const name = element('button', 'visibility-name extension-name', item.name); name.setAttribute('aria-label', `Open ${item.name}`);
    name.disabled = !item.loaded || state.activeTabId === 'vps'; name.onclick = () => openExtension(item, $('extensions-button'));
    copy.append(name, element('span', 'visibility-username', `${item.version} · ${item.error ? 'Could not load' : !item.enabled ? 'Disabled' : item.hasPopup ? 'Popup available' : 'Runs on matching pages'}`));
    if (item.error) copy.append(element('p', 'settings-note', item.error));
    if (item.nativeMessaging) copy.append(element('p', 'settings-note', 'Desktop app connection may require signed-browser approval in that app.'));
    const actions = element('div', 'extension-row-actions'), enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = item.enabled;
    enabled.setAttribute('role', 'switch'); enabled.setAttribute('aria-label', `Enable ${item.name}`);
    enabled.onchange = async () => { enabled.disabled = true; const result = await command('enable-extension', { key: item.key, enabled: enabled.checked }); if (result) render(result); else { enabled.disabled = false; enabled.checked = item.enabled; } };
    const pin = element('button', 'secondary-button', item.pinned ? 'Unpin' : 'Pin'); pin.setAttribute('aria-label', `${item.pinned ? 'Unpin' : 'Pin'} ${item.name}`);
    pin.onclick = () => command('pin-extension', { key: item.key, pinned: !item.pinned });
    const remove = element('button', 'text-button', 'Remove'); remove.setAttribute('aria-label', `Remove ${item.name}`); remove.onclick = () => command('remove-extension', { key: item.key });
    actions.append(enabled, pin, remove); row.append(icon, copy, actions); list.append(row);
  }
  if (focused) [...list.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
}
function showExtensions() {
  openModal('Extensions');
  const body = $('modal-body');
  body.append(element('p', 'settings-note', 'Install extensions from the Chrome Web Store, then pin them beside the address bar. They run in your local Mac tabs.'));
  const browse = element('button', 'primary-button', 'Browse Chrome Web Store'); browse.onclick = async () => { closeModal(); await command('browse-extensions'); }; body.append(browse);
  const list = element('div'); list.id = 'extension-list'; body.append(list);
  const add = element('button', 'secondary-button', 'Add unpacked extension'); add.onclick = async () => { add.disabled = true; const result = await command('add-extension'); if (result) { render(result); toast('Extension list updated. Reload existing pages to apply content scripts.'); } add.disabled = false; };
  body.append(add, element('hr', 'section-divider'), element('h3', '', 'Sign-in and passwords'));
  body.append(element('p', 'settings-note', 'This browser is Chromium, not Chrome — Google sync and Chrome’s built-in password manager are not included. For passwords and passkeys, install your manager’s extension from the Web Store and sign in inside it.'));
  renderExtensions();
}
// Three appearances: light, dark (default) and blue (white on electric blue).
// The bottom-left button walks light -> dark -> blue and shows the next one.
const THEME_ORDER = ['light', 'dark', 'blue'];
const THEME_LABEL = { light: 'Light', dark: 'Dark', blue: 'Blue' };
const THEME_VARS = {
  light: { '--bg': '#f6f6f8', '--text': '#1c1c21', '--muted': '#5e5e68', '--line': '#d5d5dc', '--panel': '#ffffff', '--intelio-surface': '#ffffff' },
  blue: { '--bg': '#0000e8', '--text': '#ffffff', '--muted': 'rgba(255, 255, 255, 0.74)', '--line': 'rgba(255, 255, 255, 0.24)', '--panel': '#1414ee', '--intelio-surface': '#1414ee' },
};
function themeName(theme) {
  const raw = String(theme || '').trim().toLowerCase();
  return raw === 'light' || raw === 'blue' ? raw : 'dark';
}
function followingTheme(theme) {
  return THEME_ORDER[(THEME_ORDER.indexOf(themeName(theme)) + 1) % THEME_ORDER.length];
}
function applyTheme(theme) {
  const next = themeName(theme);
  const root = document.documentElement;
  root.dataset.theme = next;
  root.style.colorScheme = next === 'light' ? 'light' : 'dark';
  for (const [name, vars] of Object.entries(THEME_VARS)) {
    if (name === next) continue;
    for (const [key, value] of Object.entries(vars)) {
      if (root.style.getPropertyValue(key).trim().toLowerCase() === value) root.style.removeProperty(key);
    }
  }
  for (const [key, value] of Object.entries(THEME_VARS[next] || {})) root.style.setProperty(key, value);
  const button = $('theme-toggle');
  if (!button) return;
  const after = followingTheme(next);
  button.title = `${THEME_LABEL[after]} theme`;
  button.setAttribute('aria-label', `Switch to the ${THEME_LABEL[after]} theme`);
  button.dataset.theme = next;
  button.querySelector('.theme-moon')?.classList.toggle('hidden', after !== 'dark');
  button.querySelector('.theme-sun')?.classList.toggle('hidden', after !== 'light');
  button.querySelector('.theme-blue')?.classList.toggle('hidden', after !== 'blue');
  for (const choice of document.querySelectorAll('[data-theme-choice]')) choice.setAttribute('aria-pressed', String(choice.dataset.themeChoice === next));
}
function chooseTheme(choice) {
  const next = themeName(choice);
  applyTheme(next);
  command('settings', { theme: next });
}
function hostCopy() {
  return state?.host || {
    pane: 'Your Mac',
    sshSaved: 'This Mac\u2019s SSH address saved',
    sshField: 'This Mac\u2019s SSH address (as your VPS reaches it)',
    sshPlaceholder: 'you@mymac or mymac.tailnet-name',
    connectAgents: 'Connect your Hermes agents on a VPS to this Mac. Fill in both SSH addresses, run the setup on your VPS, then test the agent path.',
    setupWires: 'The setup installs the agent plugin on your gateway host and wires this Mac\u2019s browser connector for the selected bot. Run once per bot.',
    stay: 'Bot discovery reads Telegram Web A\u2019s local cache. Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this Mac.',
    links: 'A link sent by you or a bot opens a local tab assigned to that bot, so both of you can see it. If the Mac is unreachable, the bot opens its own copy on the VPS desktop instead.',
    pathCheck: 'Checking VPS \u2192 Mac ssh path\u2026',
    controlLocal: 'your Mac',
    statusLocal: 'Mac',
    browse: 'Browse on your Mac.',
  };
}
function hermesChecklist(current) {
  if (current?.hermesStatus?.label) return current.hermesStatus;
  const hermes = current?.intelio?.hermes;
  if (!hermes) return { done: false, label: 'Hermes pin not loaded' };
  const pin = (hermes.pinCommit || '').slice(0, 12) || 'missing';
  return { done: hermes.match === 'commit', label: `Hermes pin ${pin} · ${hermes.summary}` };
}
function agentOrb(id) {
  return window.IntelioRemote?.signatureOf?.(id) || 'working';
}
function shownOrb(card) {
  const chosen = String(card?.orb || '').trim().toLowerCase();
  const styles = window.IntelioAgentCard?.styles || [];
  if (styles.some((row) => row[0] === chosen)) return chosen;
  return agentOrb(card?.id);
}
function agentProfileId(id) {
  const value = String(id || '').trim().toLowerCase();
  const compact = value.replace(/[\s_]+/g, '-');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)) return 'intelio';
  if (value === 'default' || value === 'kid-a' || value === 'kida' || compact === 'kid-a' || value.includes('alignment-bot-vps') || compact.includes('alignment-bot-vps')) return 'intelio';
  return value;
}
function openAgentPane(id, tab) {
  agentPane = true;
  if (typeof tab === 'string' && ['details', 'memory', 'phone'].includes(tab)) agentUi.tab = tab;
  const profile = agentProfileId(id || window.IntelioRemote?.selectedId?.() || 'intelio');
  if (state?.showBrowser === false) command('settings', { showBrowser: true }).catch(() => {});
  loadAgentCard(profile);
  render(state);
}
window.openAgentDetails = openAgentPane;
function openAgentComputer(id) {
  agentPane = false;
  const profile = agentProfileId(id);
  if (window.IntelioRemote?.selectAgent) window.IntelioRemote.selectAgent(profile);
  if (state?.showBrowser === false) command('settings', { showBrowser: true }).catch(() => {});
  if (state?.activeTabId !== 'vps') command('activate', { id: 'vps' });
  else render(state);
}
window.openAgentComputer = openAgentComputer;
async function loadAgentCard(id) {
  const profile = agentProfileId(id);
  agentUi.id = profile;
  agentUi.note = '';
  paintAgentCard();
  let card = null;
  try { card = await window.remoteHermes?.request('agent-card', { profile }); } catch { card = null; }
  if (agentUi.id !== profile) return;
  agentUi.card = card && card.id === profile ? card : agentUi.card;
  if (!agentUi.card) agentUi.note = 'Profile details are not available yet.';
  paintAgentCard();
}
function paintAgentCard() {
  const host = $('agent-card');
  if (!host || !agentPane) return;
  const card = agentUi.card;
  if (!card || !window.IntelioAgentCard) {
    host.replaceChildren(element('p', 'agent-note', 'Loading profile…'));
    host.classList.remove('hidden');
    return;
  }
  window.IntelioAgentCard.mount(host, card, {
    tab: agentUi.tab,
    query: agentUi.query,
    note: agentUi.note,
    confirming: agentUi.confirming,
    confirmLabel: card.paused ? 'Resume' : 'Pause',
    busy: agentUi.busy,
    orb: shownOrb(card),
    accent: card.color || '',
    editing: agentUi.editing,
    picking: agentUi.picking,
    soulOpen: agentUi.soulOpen,
    onTab(next) { agentUi.tab = next; agentUi.confirming = false; agentUi.editing = false; paintAgentCard(); },
    onPickColor() { agentUi.picking = !agentUi.picking; paintAgentCard(); },
    async onColor(color) {
      await saveAgentProfile({ color });
    },
    async onOrb(orb) {
      await saveAgentProfile({ orb });
    },
    onEdit() { agentUi.editing = true; agentUi.soulOpen = true; paintAgentCard(); },
    onCancelEdit() { agentUi.editing = false; paintAgentCard(); },
    onSoul(open) { agentUi.soulOpen = open; paintAgentCard(); },
    onSave(patch) { saveAgentProfile(patch); },
    onQuery(value) { agentUi.query = value; },
    onMessage() {
      agentPane = false;
      const input = $('remote-input');
      if (input) input.focus();
      render(state);
    },
    onCall() { window.IntelioRemote?.toggleCall?.(); },
    onComputer() {
      agentPane = false;
      agentUi.confirming = false;
      if (state.activeTabId !== 'vps') command('activate', { id: 'vps' });
      else render(state);
    },
    onVault() { showSettings(card.id); },
    async onThinking(effort) {
      if (agentUi.busy) return;
      agentUi.busy = true;
      paintAgentCard();
      try {
        const next = await window.remoteHermes.request('agent-thinking', { profile: card.id, effort });
        if (next?.id === card.id) agentUi.card = next;
        agentUi.note = next?.readOnly ? 'Reasoning effort is read-only from this computer.' : '';
      } catch (error) {
        agentUi.note = error.message || 'Could not save reasoning effort.';
      } finally {
        agentUi.busy = false;
        paintAgentCard();
      }
    },
    onPause(current) {
      agentUi.confirming = current.paused
        ? `Resume ${current.name}? New turns from this app start again.`
        : `Pause ${current.name}? New turns from this app stop. Scheduled jobs stay listed.`;
      paintAgentCard();
    },
    onCancel() { agentUi.confirming = false; paintAgentCard(); },
    async onConfirm() {
      const paused = !card.paused;
      agentUi.confirming = false;
      agentUi.busy = true;
      paintAgentCard();
      try {
        const next = await window.remoteHermes.request('agent-pause', { profile: card.id, paused });
        if (next?.id === card.id) agentUi.card = next;
        else agentUi.card = { ...card, paused };
      } catch (error) {
        agentUi.note = error.message || 'Could not pause this agent.';
      } finally {
        agentUi.busy = false;
        paintAgentCard();
      }
    },
    onCopy(value, note) {
      window.IntelioAgentCard.copyText(value).then((ok) => { agentUi.note = ok ? note : 'Could not copy that.'; paintAgentCard(); });
    },
  });
}
async function saveAgentProfile(patch) {
  if (agentUi.busy || !agentUi.card) return;
  agentUi.busy = true;
  paintAgentCard();
  try {
    const next = await window.remoteHermes.request('agent-profile', { profile: agentUi.card.id, ...patch });
    if (next?.id === agentUi.card.id) agentUi.card = next;
    agentUi.editing = false;
    agentUi.picking = false;
    agentUi.note = '';
    if (next?.id) {
      window.IntelioRemote?.applyLook?.({
        id: next.id,
        color: next.color || '',
        orb: next.orb || '',
        title: next.title || '',
        name: next.name || '',
      });
    }
  } catch (error) {
    agentUi.note = error.message || 'Could not save that.';
  } finally {
    agentUi.busy = false;
    paintAgentCard();
  }
}
window.onIntelioAgent = (id) => { if (agentPane) loadAgentCard(id); };
function remoteActive(next = state) {
  const remote = next?.remoteHermes;
  if (window.IntelioRemote?.remoteConfigured) return window.IntelioRemote.remoteConfigured(remote);
  return Boolean(remote?.enabled && remote?.host) || Boolean(remote?.profilesWithKeys?.length);
}
function render(next) {
  const wasRemote = remoteActive(state);
  state = next;
  const nowRemote = remoteActive();
  if (wasRemote !== nowRemote) botListSignature = '';
  document.body.classList.toggle('remote-main', nowRemote);
  $('telegram-slot').classList.toggle('hidden', nowRemote);
  $('telegram-note').classList.toggle('hidden', nowRemote);
  $('remote-chat')?.classList.toggle('hidden', !nowRemote);
  $('add-bot').classList.remove('hidden');
  $('add-bot').title = nowRemote ? 'Add agent' : 'Open a Telegram bot';
  $('add-bot').setAttribute('aria-label', $('add-bot').title);
  $('sort-bots').classList.toggle('hidden', nowRemote);
  window.HermesAvatars.update(state);
  const bot = state.bots.find((item) => item.id === state.selectedBotId);
  document.documentElement.style.setProperty('--chat-width', `${state.chatWidth}px`);
  $('shell').classList.toggle('bots-hidden', state.showBots === false);
  $('bots-toggle').setAttribute('aria-pressed', String(state.showBots !== false));
  $('bots-toggle').title = state.showBots === false ? 'Show agent list' : 'Hide agent list';
  if (nowRemote) {
    $('chat-title').textContent = window.IntelioRemote?.selectedName() || 'VPS Hermes';
    $('agent-presence').classList.add('hidden');
    window.IntelioRemote?.sync(state);
  } else {
    $('chat-title').textContent = bot?.name || 'Telegram';
    const pill = $('chat-pill');
    if (pill) { pill.onclick = null; pill.removeAttribute('role'); }
    window.HermesAvatars.paint($('chat-avatar'), bot || { id: '', name: 'Telegram' }, state);
    $('chat-avatar').title = bot ? `Customize ${bot.name} avatar` : 'Select a bot to customize its avatar';
    $('chat-avatar').onclick = () => showAvatarEditor();
    $('agent-presence').classList.toggle('hidden', !bot);
    if (bot) {
      window.HermesAvatars.paint($('presence-avatar'), bot, state);
      $('presence-name').textContent = bot.name;
      $('presence-status').textContent = window.HermesAvatars.activityLabel(bot.activity);
      $('presence-status').classList.toggle('active', window.HermesAvatars.isActive(bot.activity));
    }
    renderBots();
  }
  renderTabs(); renderSettingsBots(); renderSitePermissions(); renderExtensions();
  window.IntelioUI?.apply(state);
  applyTheme(state.theme);
  themeReady = true;
  $('sidebar-threads-wrap')?.classList.toggle('hidden', !nowRemote);
  if (nowRemote) {
    const cloud = state.remoteHermes.activeMode === 'cloud';
    const profile = $('intelio-profile');
    profile.textContent = cloud ? 'VPS Hermes · Cloud' : `VPS Hermes · ${state.remoteHermes.host}:${state.remoteHermes.port}`;
    profile.classList.add('hidden');
    const pin = $('hermes-pin');
    if (pin) {
      pin.textContent = state.remoteHermes.versionLabel || 'VPS Hermes';
      pin.classList.add('hidden');
    }
  } else {
    $('intelio-profile')?.classList.remove('hidden');
    $('hermes-pin')?.classList.remove('hidden');
  }
  const signIn = $('cloud-signin');
  if (signIn) signIn.classList.toggle('hidden', !state.remoteHermes?.needsSignIn);
  const signInButton = $('cloud-signin-button');
  if (signInButton && !signInButton.dataset.bound) {
    signInButton.dataset.bound = '1';
    signInButton.onclick = () => command('remote-hermes-sign-in', {});
  }
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  const remote = state.activeTabId==='vps';
  $('vm-toggle').title = remote ? 'Local browser' : 'Agent computer';
  $('vm-toggle').setAttribute('aria-label', $('vm-toggle').title);
  $('vm-toggle').setAttribute('aria-pressed', String(remote));
  const browserHidden = state.showBrowser === false;
  $('shell').classList.toggle('browser-hidden', browserHidden);
  // With the pane hidden its footer is off-screen, so the pane actions carry the VPS desktop status.
  const paneStatus = $('pane-status');
  if (paneStatus) {
    const vpsStatus = state.remoteStatus || 'connecting';
    $('pane-status-text').textContent = `VPS desktop · ${vpsStatus}`;
    paneStatus.title = `VPS desktop viewer is ${vpsStatus}. This is the remote screen, not the agent chat connection.`;
    paneStatus.querySelector('.status-dot')?.classList.toggle('offline', vpsStatus !== 'connected');
  }
  // The pane actions float over the chat header while the pane is hidden; reserve their width
  // so they never sit on top of the header's own buttons (Call my phone).
  const paneActions = document.querySelector('.pane-actions');
  $('shell').style.setProperty('--pane-actions-w', browserHidden && paneActions ? `${Math.ceil(paneActions.getBoundingClientRect().width)}px` : '0px');
  document.querySelector('.workspace-pane')?.classList.toggle('agent-open', Boolean(agentPane && nowRemote));
  if (!nowRemote) agentPane = false;
  $('browser-collapse').title = state.showBrowser === false ? 'Show browser pane' : 'Hide browser pane';
  $('browser-collapse').setAttribute('aria-label', $('browser-collapse').title);
  $('browser-collapse').setAttribute('aria-pressed', String(state.showBrowser === false));
  $('home').classList.toggle('hidden', !!tab || state.activeTabId === 'vps');
  $('browser-toolbar').classList.toggle('hidden', state.activeTabId === 'vps');
  $('remote-preview-slot').classList.toggle('hidden', !state.preview || remote);
  $('preview-chip').classList.toggle('hidden', state.preview || remote);
  $('preview-label').textContent = state.remoteStatus === 'connected' ? 'VPS desktop' : `VPS · ${state.remoteStatus}`;
  positionPreview();
  $('control-button').textContent = tab?.controller === 'agent' ? 'Take over' : 'Give to agent';
  $('control-button').classList.toggle('agent', tab?.controller === 'agent');
  $('control-button').disabled = !tab || tab.extensionPage;
  const askBot = $('ask-bot'); askBot.disabled = !tab || !/^https?:\/\//.test(tab?.url || ''); askBot.title = tab ? `Share ${tab.title || 'this page'} with ${bot?.name || 'the selected bot'}` : 'Discuss this page with your agent';
  $('browser-slot').classList.toggle('agent-live', !!tab && tab.controller === 'agent');
  if (tab?.extensionPage) $('control-button').textContent = 'You';
  const machine = hostCopy();
  const blurb = $('home-blurb');
  if (blurb?.firstChild && machine.browse) blurb.firstChild.textContent = `Talk to your agents. ${machine.browse}`;
  $('control-button').title = tab ? `Browser runs on ${tab.host==='vps'?'the VPS':machine.controlLocal || 'your Mac'} · ${tab.controller === 'agent' ? 'Agent' : 'You'} control it` : 'Open a browser tab first';
  if (document.activeElement !== $('address')) $('address').value = tab?.internal ? '' : tab?.url || '';
  const agentName = tab ? state.bots.find(bot => bot.id === tab.botId)?.name || 'Agent' : '';
  $('workspace-status').textContent = tab?.error ? `Page: ${tab.error}` : tab?.loading ? 'Loading…' : tab ? `${tab.controller === 'agent' ? `${agentName}${tab.agentBusy ? ' is working' : ' is browsing'}` : 'You'} in control${tab.controller === 'agent' ? ' · Take over anytime' : ''} · ${tab.host==='vps'?'VPS':(machine.statusLocal || 'Mac')}${tab.handoff?.phase==='handed_off'?` · Handed off to the ${tab.handoff.destinationHost==='vps'?'VPS':(machine.statusLocal || 'Mac')} — agents continue there`:tab.handoff&&tab.handoff.phase!=='reviewed'?' · Handoff: review page before continuing':''}` : state.activeTabId === 'vps' ? `VPS desktop · ${state.remoteStatus}` : 'Ready';
  $('connection-status').textContent = state.api.ready ? 'Browser connector ready' : state.api.error ? 'Browser connector unavailable' : 'Browser connector starting…';
  const notes = { login: 'Sign in with your Telegram account. Your bots appear on the left.', connected: 'Your Telegram account · bot chats only', locked: 'Unlock Telegram to load your bot chats.', offline: 'Telegram is offline. Check your connection, then sync in Settings.', loading: 'Connecting to Telegram…' };
  if (!nowRemote) $('telegram-note').textContent = notes[state.telegramStatus] || notes.loading;
  for (const button of document.querySelectorAll('#screen-count button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.screens) === (state.screenGrid || 1)));
  }
  paintScreenGrid();
  scheduleLayout();
}
function rect(id) {
  const el = $(id); if (!el || el.classList.contains('hidden')) return null;
  const box = el.getBoundingClientRect(); if (!box.width || !box.height) return null;
  return { x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2 };
}
function browserRect() {
  if (agentPane) return null;
  if (state?.activeTabId === 'vps' && (state.screenGrid || 1) > 1) {
    const cell = document.querySelector('.screen-cell.active');
    if (cell) {
      const box = cell.getBoundingClientRect();
      if (box.width && box.height) return { x: box.x + 3, y: box.y + 3, width: Math.max(0, box.width - 6), height: Math.max(0, box.height - 6) };
    }
  }
  return rect('browser-slot');
}
function paintScreenGrid() {
  const grid = $('screen-grid');
  if (!grid) return;
  const count = [2, 3, 4].includes(state?.screenGrid) ? state.screenGrid : 1;
  const show = state?.activeTabId === 'vps' && count > 1;
  grid.classList.toggle('hidden', !show);
  grid.dataset.count = String(count);
  grid.replaceChildren();
  if (!show) return;
  const labels = ["Agent's computer", state?.host?.pane || 'Your Mac', 'Screen 3', 'Screen 4'];
  const active = Number.isInteger(state.activeScreen) ? state.activeScreen : 0;
  for (let i = 0; i < count; i += 1) {
    const cell = element('button', `screen-cell${i === active ? ' active' : ''}`, labels[i]);
    cell.type = 'button';
    cell.dataset.screen = String(i);
    cell.onclick = () => command('settings', { activeScreen: i });
    grid.append(cell);
  }
}
function scheduleLayout() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => api.layout({ telegram: focusMode ? null : rect('telegram-slot'), browser: browserRect(), preview: rect('preview-screen'), obscured: modalOpen }));
}
// The mini VM window is anchored bottom-right until dragged; its saved offset
// is relative to the workspace pane and clamped so it can never get lost.
let previewDragging = false;
function positionPreview() {
  const slot = $('remote-preview-slot'), pos = state?.previewPos;
  if (previewDragging) return;
  if (state?.showBrowser === false || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) { slot.style.left = ''; slot.style.top = ''; slot.style.right = ''; slot.style.bottom = ''; return; }
  const pane = slot.parentElement.getBoundingClientRect();
  const x = Math.max(0, Math.min(pos.x, pane.width - slot.offsetWidth));
  const y = Math.max(0, Math.min(pos.y, pane.height - slot.offsetHeight));
  slot.style.left = `${x}px`; slot.style.top = `${y}px`; slot.style.right = 'auto'; slot.style.bottom = 'auto';
}
function wirePreviewDrag() {
  const chrome = $('preview-chrome'), slot = $('remote-preview-slot');
  let drag = null;
  chrome.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || state?.showBrowser === false) return;
    previewDragging = true;
    const paneBox = slot.parentElement.getBoundingClientRect(), slotBox = slot.getBoundingClientRect();
    drag = { dx: event.clientX - slotBox.left, dy: event.clientY - slotBox.top, pane: paneBox };
    chrome.setPointerCapture(event.pointerId);
  });
  chrome.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const x = Math.max(0, Math.min(event.clientX - drag.pane.left - drag.dx, drag.pane.width - slot.offsetWidth));
    const y = Math.max(0, Math.min(event.clientY - drag.pane.top - drag.dy, drag.pane.height - slot.offsetHeight));
    slot.style.left = `${x}px`; slot.style.top = `${y}px`; slot.style.right = 'auto'; slot.style.bottom = 'auto';
    drag.pos = { x: Math.round(x), y: Math.round(y) };
    scheduleLayout();
  });
  const end = () => { if (drag?.pos) command('preview-move', drag.pos).catch(() => {}); drag = null; previewDragging = false; };
  chrome.addEventListener('pointerup', end); chrome.addEventListener('pointercancel', end);
}
// A drag started inside the streamed picture lands here as deltas — the slot
// moves live and the drop point persists exactly like a chrome-strip drag.
let previewLivePos = null;
api.onPreviewNudge?.(({ dx, dy }) => {
  if (!state?.preview || state.activeTabId === 'vps' || state?.showBrowser === false) return;
  const slot = $('remote-preview-slot'), pane = slot.parentElement.getBoundingClientRect(), box = slot.getBoundingClientRect();
  const x = Math.max(0, Math.min(box.left - pane.left + dx, pane.width - slot.offsetWidth));
  const y = Math.max(0, Math.min(box.top - pane.top + dy, pane.height - slot.offsetHeight));
  slot.style.left = `${x}px`; slot.style.top = `${y}px`; slot.style.right = 'auto'; slot.style.bottom = 'auto';
  previewLivePos = { x: Math.round(x), y: Math.round(y) };
  previewDragging = true;
  scheduleLayout();
});
api.onPreviewDrop?.(() => {
  if (previewLivePos) command('preview-move', previewLivePos).catch(() => {});
  previewLivePos = null; previewDragging = false;
});
function openModal(title) {
  modalOpen = true; $('modal-title').textContent = title; $('modal-body').replaceChildren(); $('modal').classList.remove('hidden'); scheduleLayout();
}
function closeModal() {
  modalOpen = false;
  const modal = $('modal');
  modal.classList.add('hidden');
  modal.classList.remove('agent-open');
  modal.querySelector('.modal-card')?.classList.remove('agent-dialog');
  scheduleLayout();
}
function renderSettingsBots() {
  const list = $('settings-bots');
  if (!modalOpen || !list) return;
  const bots = orderedBots(true);
  const signature = JSON.stringify(bots.map(bot => [bot.id, bot.name, bot.username, !state.hidden.includes(bot.id)]));
  if (list.dataset.signature === signature) return;
  const focusedId = document.activeElement?.dataset.botId;
  list.dataset.signature = signature; list.replaceChildren();
  if (!bots.length) list.append(element('p', 'settings-note', 'Sign in to Telegram and sync to find your bot chats.'));
  for (const bot of bots) {
    const row = element('label', 'bot-visibility'), toggle = element('input');
    toggle.type = 'checkbox'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', `Show ${bot.name}`);
    toggle.dataset.botId = bot.id; toggle.checked = !state.hidden.includes(bot.id);
    const copy = element('span', 'visibility-copy');
    copy.append(element('span', 'visibility-name', bot.name));
    if (bot.username) copy.append(element('span', 'visibility-username', `@${bot.username}`));
    toggle.onchange = async () => {
      const visible = toggle.checked; toggle.disabled = true;
      const result = await command('set-bot-visibility', { id: bot.id, visible });
      if (result) render(result);
      else { toggle.checked = !state.hidden.includes(bot.id); toggle.disabled = false; }
    };
    row.append(copy, toggle); list.append(row);
    if (focusedId === bot.id) toggle.focus({ preventScroll: true });
  }
}
const permissionLabels = { geolocation: 'Precise location', 'geolocation-approximate': 'General area', notifications: 'Notifications', camera: 'Camera', microphone: 'Microphone', 'clipboard-read': 'Read clipboard' };
function permissionChoice(selected, onChange) {
  const select = element('select');
  for (const [value, label] of [['block', 'Block'], ['allow', 'Allow'], ['ask', 'Use default']]) {
    const option = element('option', '', label); option.value = value; option.selected = selected === value; select.append(option);
  }
  select.onchange = () => onChange(select.value); return select;
}
function renderSitePermissions() {
  const list = $('site-permissions'); if (!modalOpen || !list) return;
  const signature = JSON.stringify(state.sitePermissions);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature; list.replaceChildren();
  for (const [scope, sites] of Object.entries(state.sitePermissions || {})) {
    for (const [origin, permissions] of Object.entries(sites)) for (const [permission, decision] of Object.entries(permissions)) {
      if (!permissionLabels[permission]) continue;
      const row = element('div', 'setting-row'), copy = element('span', 'visibility-copy');
      copy.append(element('span', 'visibility-name', `${permissionLabels[permission]} · ${scope === 'telegram' ? 'Telegram' : 'Browser'}`), element('span', 'visibility-username', origin));
      const choice = permissionChoice(decision, value => command('set-site-permission', {scope, origin, permission, decision:value}));
      choice.setAttribute('aria-label', `${origin} ${permissionLabels[permission]}`); row.append(copy, choice); list.append(row);
    }
  }
}
function showSitePermissionSettings(body) {
  body.append(element('h3', '', 'Site permissions'), element('p', 'settings-note', 'General area only blocks precise location and allows approximate requests where supported. Sites can also estimate your area from your IP. Camera, microphone, notifications and clipboard access ask once per site and remember your choice. Only the tab you control can request access.'));
  const locationRow = element('div', 'setting-row'); locationRow.append(element('span', '', 'Location requests'));
  const location = element('select'); location.setAttribute('aria-label', 'Default location access');
  for (const [value, label] of [['approximate', 'General area only'], ['block', 'Block device location'], ['ask', 'Ask once for precise location']]) { const option = element('option', '', label); option.value = value; option.selected = state.locationDefault === value; location.append(option); }
  location.onchange = () => command('settings', { locationDefault:location.value }); locationRow.append(location); body.append(locationRow);
  const field = element('div', 'field'), label = element('label', '', 'Add a site permission'), input = element('input');
  input.id = 'permission-origin'; label.htmlFor = input.id; input.placeholder = 'https://www.google.com';
  const permission = element('select'); permission.setAttribute('aria-label', 'Site permission type');
  for (const [value, label] of Object.entries(permissionLabels)) { const option = element('option', '', label); option.value = value; permission.append(option); }
  const decision = permissionChoice('block', () => {}); decision.setAttribute('aria-label', 'Site permission setting');
  const save = element('button', 'secondary-button', 'Save site permission');
  save.onclick = async () => { const result = await command('set-site-permission', { origin:input.value.trim(), permission:permission.value, decision:decision.value }); if (result) { input.value = ''; toast('Site permission saved. Reload the site to apply it.'); } };
  field.append(label, input, permission, decision, save); body.append(field);
  const list = element('div'); list.id = 'site-permissions'; body.append(list); renderSitePermissions();
  const reset = element('button', 'secondary-button', 'Reset browser permissions'); reset.onclick = () => command('reset-site-permissions'); body.append(reset, element('hr', 'section-divider'));
}
async function showCookieSettings(body) {
  body.append(element('h3', '', 'Cookies and site data'), element('p', 'settings-note', 'Shared by all local browser tabs. Clearing a site signs you out of it.'));
  const list = element('div'); list.id = 'cookie-list';
  const refresh = async () => {
    const items = await command('list-cookies');
    list.replaceChildren(...(Array.isArray(items) && items.length ? items.map((item) => {
      const row = element('div', 'setting-row');
      row.append(element('span', '', `${item.domain} · ${item.count} ${item.count === 1 ? 'cookie' : 'cookies'}`));
      const clear = element('button', 'secondary-button', 'Clear'); clear.onclick = async () => { await command('clear-cookies', { domain: item.domain }); refresh(); };
      row.append(clear); return row;
    }) : [element('p', 'settings-note', 'No cookies stored.')]));
  };
  const clearAll = element('button', 'secondary-button', 'Clear all cookies'); clearAll.onclick = async () => { await command('clear-cookies'); refresh(); };
  body.append(list, clearAll, element('hr', 'section-divider'));
  await refresh();
}
// Saved logins for every agent: site, username, agent, last used, Delete.
// Rows come from vault-list, which never carries a password.
function savedLoginWhen(at) {
  const ms = Number(at) || 0;
  if (!ms) return 'Not used yet';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'Used just now';
  if (mins < 60) return `Used ${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Used ${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `Used ${days} d ago` : `Used ${new Date(ms).toLocaleDateString()}`;
}
async function paintSavedLogins(vaultList, profile) {
  const remote = window.IntelioRemote;
  const agents = (remote?.agentList?.() || []).filter((agent) => agent && agent.id);
  if (!agents.length) {
    const only = typeof profile === 'string' && profile ? profile : (remote?.selectedId?.() || state.remoteHermes?.profile || 'intelio');
    agents.push({ id: only, name: remote?.shownAgent?.(only) || only });
  }
  const lists = await Promise.all(agents.map((agent) => Promise.resolve(command('vault-list', { profile: agent.id })).then((result) => (result?.logins || []).map((row) => ({ ...row, agent }))).catch(() => [])));
  const rows = lists.flat().sort((a, b) => (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0) || String(a.domain).localeCompare(String(b.domain)));
  vaultList.replaceChildren();
  if (!rows.length) { vaultList.append(element('p', 'settings-note', 'No saved logins yet. When an agent signs in to a site, choose Remember for this agent.')); return; }
  for (const row of rows) {
    const line = element('div', 'setting-row saved-login-row');
    const main = element('div', 'saved-login-main');
    main.append(element('strong', 'saved-login-site', row.domain), element('span', 'saved-login-meta', [row.username || 'No username', row.agent.name, savedLoginWhen(row.lastUsedAt)].join(' · ')));
    const del = element('button', 'text-button saved-login-delete', 'Delete');
    del.setAttribute('aria-label', `Delete saved login for ${row.domain} (${row.agent.name})`);
    del.onclick = () => {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Delete?'; return; }
      del.disabled = true;
      Promise.resolve(command('vault-delete', { profile: row.agent.id, domain: row.domain })).catch(() => {}).then(() => paintSavedLogins(vaultList, profile));
    };
    line.append(main, del);
    vaultList.append(line);
  }
}
function showSettings(profile) {
  openModal('Workspace settings');
  const body = $('modal-body'), field = element('div', 'field');
  const themeRow = element('div', 'setting-row');
  themeRow.append(element('span', '', 'Appearance'));
  const themePicker = element('div', 'theme-picker');
  themePicker.setAttribute('role', 'group');
  themePicker.setAttribute('aria-label', 'Appearance');
  for (const name of THEME_ORDER) {
    const choice = element('button', `secondary-button theme-choice theme-choice-${name}`, THEME_LABEL[name]);
    choice.type = 'button';
    choice.dataset.themeChoice = name;
    choice.setAttribute('aria-pressed', String(themeName(state.theme) === name));
    choice.onclick = () => chooseTheme(name);
    themePicker.append(choice);
  }
  themeRow.append(themePicker);
  body.append(themeRow, element('hr', 'section-divider'));
  const vaultHead = element('h3', '', 'Saved logins');
  const vaultNote = element('p', 'settings-note', 'Logins your agents use to sign in. Each one is encrypted on your server and kept for one agent. Passwords are never shown here or sent to the chat.');
  const vaultList = element('div', 'settings-bots saved-logins');
  body.append(vaultHead, vaultNote, vaultList);
  paintSavedLogins(vaultList, profile);
  window.IntelioUI?.appendSettings(body, { element, command, state, toast });
  const extensions = element('button', 'secondary-button', 'Manage browser extensions'); extensions.onclick = showExtensions;
  body.append(extensions, element('hr', 'section-divider'));
  body.append(element('h3', '', 'Telegram bots'));
  body.append(element('p', 'settings-note', 'Choose which bots appear in your sidebar. Changes save immediately. Drag visible bots in the sidebar to sort them.'));
  const bots = element('div', 'settings-bots'); bots.id = 'settings-bots';
  body.append(bots); renderSettingsBots();
  body.append(element('p', 'settings-note', 'Hiding a bot only changes this app. Its Telegram chat, messages and Hermes agent stay available.'), element('hr', 'section-divider'));
  const avatars = element('button', 'secondary-button', 'Customize bot avatars');
  avatars.onclick = () => showAvatarEditor(); body.append(avatars);
  body.append(element('p', 'settings-note', 'Pick a marble avatar or import your own. Eyes follow your mouse only while Telegram reports activity.'), element('hr', 'section-divider'));
  showSitePermissionSettings(body);
  showCookieSettings(body);
  const label = element('label', '', 'VPS desktop connection'); label.htmlFor = 'remote-url';
  const input = element('input'); input.id = 'remote-url'; input.placeholder = 'https://your-server/vnc.html or wss://…'; input.value = state.remoteUrl;
  field.append(label, input, element('p', '', 'Paste your existing noVNC viewer URL. Connect through Tailscale when your server is private. The small preview starts in watch mode.'));
  const save = element('button', 'primary-button', 'Save connection'); save.onclick = async () => { const result = await command('settings', { remoteUrl: input.value.trim() }); if (result) { closeModal(); toast('VPS connection saved.'); } };
  body.append(field, save, element('hr', 'section-divider'));
  const row = element('div', 'setting-row'); row.append(element('span', '', 'VPS preview in the corner'));
  const toggle = element('button', 'secondary-button', state.preview ? 'Hide preview' : 'Show preview'); toggle.onclick = async () => { await command('settings', { preview: !state.preview }); toggle.textContent = state.preview ? 'Hide preview' : 'Show preview'; }; row.append(toggle); body.append(row);
  body.append(element('hr', 'section-divider'), element('h3', '', 'Browser connector'));
  body.append(element('p', 'settings-note', state.api.ready ? `Ready at ${state.api.url}. Your add-on can pair with this local connection to operate assigned tabs.` : state.api.error || 'Starting…'));
  const copy = element('button', 'secondary-button', 'Copy connection'); copy.onclick = async () => { await command('copy-connection'); toast('Connection URL and private token copied. Share only with your own agent connector.'); };
  const folder = element('button', 'secondary-button', 'Open app data'); folder.onclick = () => command('show-data'); body.append(copy, folder);
  body.append(element('h3', '', 'Agent setup'));
  const checklist = element('div', 'checklist');
  const labels = hostCopy();
  const hermesCheck = hermesChecklist(state);
  const checks = [
    [state.telegramStatus === 'connected', 'Signed in to Telegram'],
    [state.bots.length > 0, state.bots.length ? `${state.bots.length} bot${state.bots.length === 1 ? '' : 's'} discovered` : 'No bots discovered yet'],
    [!!(state.vpsBrowser?.sshHost), 'VPS SSH address saved'],
    [!!state.macSshHost, labels.sshSaved || 'This Mac’s SSH address saved'],
    [state.api.ready, 'Browser connector ready'],
    [hermesCheck.done, hermesCheck.label],
  ];
  for (const [done, label] of checks) checklist.append(element('p', `check-item${done ? ' done' : ''}`, `${done ? '✓' : '○'} ${label}`));
  body.append(checklist);
  body.append(element('p', 'settings-note', labels.connectAgents || 'Connect your Hermes agents on a VPS to this Mac. Fill in both SSH addresses, run the setup on your VPS, then test the agent path.'));
  const vpsField = element('div', 'field'), vpsLabel = element('label', '', 'VPS SSH address (where your Hermes gateway runs)'); vpsLabel.htmlFor = 'vps-ssh-host';
  const vpsInput = element('input'); vpsInput.id = 'vps-ssh-host'; vpsInput.placeholder = 'you@your-vps'; vpsInput.value = state.vpsBrowser?.sshHost || ''; vpsInput.autocomplete = 'off';
  vpsField.append(vpsLabel, vpsInput);
  const sshField = element('div', 'field'), sshLabel = element('label', '', labels.sshField || 'This Mac’s SSH address (as your VPS reaches it)'); sshLabel.htmlFor = 'mac-ssh-host';
  const sshInput = element('input'); sshInput.id = 'mac-ssh-host'; sshInput.placeholder = labels.sshPlaceholder || 'you@mymac or mymac.tailnet-name'; sshInput.value = state.macSshHost || ''; sshInput.autocomplete = 'off';
  sshField.append(sshLabel, sshInput);
  const sshSave = element('button', 'secondary-button', 'Save addresses'); sshSave.onclick = async () => { if (await command('settings', { macSshHost: sshInput.value.trim(), vpsBrowser: { ...state.vpsBrowser, sshHost: vpsInput.value.trim() } })) toast('SSH addresses saved.'); };
  const agentSetup = element('button', 'secondary-button', 'Copy setup command'); agentSetup.onclick = async () => { const ok = await command('agent-setup', { botId: state.selectedBotId }); if (ok !== false) toast('Bootstrap command copied — paste it in a terminal on your VPS.'); };
  const agentPrompt = element('button', 'secondary-button', 'Copy setup prompt'); agentPrompt.onclick = async () => { const ok = await command('agent-prompt', { botId: state.selectedBotId }); if (ok !== false) toast('Setup prompt copied — paste it to a Hermes agent that has a terminal on your VPS.'); };
  const agentTest = element('button', 'secondary-button', 'Test agent path'); const agentResult = element('p', 'settings-note', '');
  agentTest.onclick = async () => { agentTest.disabled = true; agentResult.textContent = labels.pathCheck || 'Checking VPS → Mac ssh path…'; const result = await command('test-agent-path'); agentTest.disabled = false; agentResult.textContent = result && typeof result === 'object' ? `${result.ok ? '✓' : '✗'} ${result.detail}` : '✗ Path check failed.'; };
  body.append(vpsField, sshField, element('div', 'setting-row'), sshSave, agentSetup, agentPrompt, agentTest, agentResult);
  const primaryField = element('div', 'field'), primaryLabel = element('label', '', 'Primary bot'); primaryLabel.htmlFor = 'primary-bot';
  const primarySelect = element('select'); primarySelect.id = 'primary-bot';
  const none = element('option', '', 'None (defaults to the overseer bot)'); none.value = ''; primarySelect.append(none);
  for (const bot of state.bots) { const option = element('option', '', `${bot.name}${bot.username ? ` @${bot.username}` : ''}`); option.value = bot.id; primarySelect.append(option); }
  primarySelect.value = state.primaryBotPref || '';
  primarySelect.onchange = async () => { await command('settings', { primaryBotId: primarySelect.value }); toast(primarySelect.value ? 'Primary bot pinned at the top of the sidebar.' : 'Primary bot cleared.'); };
  primaryField.append(primaryLabel, primarySelect); body.append(primaryField);
  const linkRow = element('div', 'setting-row'); linkRow.append(element('span', '', 'Open links sent in bot chats as tabs'));
  const linkToggle = element('button', 'secondary-button', state.autoOpenLinks ? 'On' : 'Off');
  linkToggle.onclick = async () => { const next = !state.autoOpenLinks; await command('settings', { autoOpenLinks: next }); state.autoOpenLinks = next; linkToggle.textContent = next ? 'On' : 'Off'; };
  linkRow.append(linkToggle); body.append(linkRow);
  body.append(element('p', 'settings-note', labels.links || 'A link sent by you or a bot opens a local tab assigned to that bot, so both of you can see it. If the Mac is unreachable, the bot opens its own copy on the VPS desktop instead.'));
  body.append(element('p', 'settings-note', labels.setupWires || 'The setup installs the agent plugin on your gateway host and wires this Mac’s browser connector for the selected bot. Run once per bot.'));
  body.append(element('p', 'settings-note', 'Taking over a local tab blocks new agent actions on that tab. VPS control currently uses your existing shared desktop; it does not pause your Hermes bots.'));
  body.append(element('hr', 'section-divider'));
  const sync = element('button', 'secondary-button', 'Sync Telegram bots'); sync.onclick = () => { command('sync-telegram'); toast('Reading Telegram’s bot chat list…'); };
  body.append(sync, element('p', 'settings-note', labels.stay || 'Bot discovery reads Telegram Web A’s local cache. Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this Mac.'));
}
function showAvatarEditor(botId = state.selectedBotId || orderedBots()[0]?.id) {
  if (!botId) return toast('Open a Telegram bot before customizing its avatar.');
  openModal('Bot appearance');
  window.HermesAvatars.mountEditor($('modal-body'), { botId, command, onState: render, toast });
}
function showAddAgent() {
  openModal('Add agent');
  $('modal').classList.add('agent-open');
  $('modal').querySelector('.modal-card')?.classList.add('agent-dialog');
  const form = element('form', 'agent-form');
  const name = element('input');
  name.id = 'agent-name';
  name.maxLength = 32;
  name.autocomplete = 'off';
  name.required = true;
  const nameField = element('label', 'field');
  nameField.append(element('span', 'field-label', 'Name'), name);
  const title = element('input');
  title.id = 'agent-title';
  title.maxLength = 80;
  const titleField = element('label', 'field');
  titleField.append(element('span', 'field-label', 'Title or role'), title);
  const starts = element('div', 'field');
  starts.append(element('span', 'field-label', 'Starts from'));
  const loading = element('p', 'orb-loading', 'Loading styles…');
  const picker = element('div', 'agent-picker');
  picker.hidden = true;
  starts.append(loading, picker);
  const soul = element('textarea');
  soul.id = 'agent-soul';
  soul.maxLength = 8000;
  soul.rows = 4;
  const soulField = element('label', 'field');
  soulField.append(element('span', 'field-label', 'Instructions'), soul);
  const note = element('p', 'settings-note', '');
  const actions = element('div', 'dialog-actions');
  const cancel = element('button', 'secondary-button', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => closeModal();
  const submit = element('button', 'primary-button', 'Create agent');
  submit.type = 'submit';
  actions.append(cancel, submit);
  let chosenOrb = 'working';
  let chosenColor = '#7a5cff';
  form.append(nameField, titleField, starts, soulField, actions, note);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    note.textContent = '';
    try {
      const created = await window.remoteHermes.request('create-agent', {
        name: name.value,
        title: title.value,
        orb: chosenOrb,
        color: chosenColor,
        soul: soul.value,
      });
      const lines = [];
      if (created?.needsSignIn) lines.push(created.signInNote || 'Needs sign-in');
      if (created?.gatewayNote) lines.push(created.gatewayNote);
      note.textContent = lines.join(' ') || 'Ready after the next agent restart';
      await window.IntelioRemote?.refresh?.();
      if (created?.id) {
        window.IntelioRemote?.applyLook?.({ id: created.id, color: created.color || chosenColor, orb: created.orb || chosenOrb, title: created.title || title.value, name: created.name || name.value });
        openAgentPane(created.id);
      }
    } catch (error) {
      note.textContent = error.message || 'Could not create that agent.';
      submit.disabled = false;
    }
  };
  $('modal-body').append(form);
  const paintPicker = () => {
    window.IntelioAgentCard?.mountPicker(picker, {
      orb: chosenOrb,
      color: chosenColor,
      onOrb(next) { chosenOrb = next; paintPicker(); },
      onColor(next) { chosenColor = next; paintPicker(); },
    });
  };
  setTimeout(() => {
    if (!picker.isConnected) return;
    loading.remove();
    picker.hidden = false;
    paintPicker();
  }, 40);
  name.focus();
}
function showAddBot() {
  openModal('Open a Telegram bot');
  const form = element('form'), field = element('div', 'field'), label = element('label', '', 'Bot username'); label.htmlFor = 'bot-username';
  const input = element('input'); input.id = 'bot-username'; input.placeholder = '@your_agent_bot'; input.autocomplete = 'off';
  field.append(label, input, element('p', '', 'The chat opens in Telegram. Only verified bot accounts are added to your agent list.'));
  const submit = element('button', 'primary-button', 'Open bot'); submit.type = 'submit';
  form.append(field, submit); form.onsubmit = async (event) => { event.preventDefault(); const result = await command('open-username', { username: input.value.trim() }); if (result) closeModal(); };
  $('modal-body').append(form); input.focus();
}
$('search-toggle').onclick = () => { $('bot-search').classList.toggle('hidden'); if (!$('bot-search').classList.contains('hidden')) $('bot-search').focus(); else { $('bot-search').value = ''; if (remoteActive()) window.IntelioRemote?.filter(''); else renderBots(); } };
$('bot-search').oninput = () => { if (remoteActive()) window.IntelioRemote?.filter($('bot-search').value); else renderBots(); };
$('add-bot').onclick = () => { if (remoteActive()) showAddAgent(); else showAddBot(); };
$('settings-button').onclick = showSettings;
$('settings-fallback').onclick = showSettings;
let themeStamp = 0;
let themeReady = false;
function onThemeToggle() {
  if (!themeReady) return;
  const now = Date.now();
  if (now - themeStamp < 400) return;
  themeStamp = now;
  chooseTheme(followingTheme(document.documentElement.dataset.theme));
}
const themeToggle = $('theme-toggle');
themeToggle.addEventListener('pointerup', onThemeToggle);
themeToggle.addEventListener('click', onThemeToggle);
$('browser-collapse').onclick = () => { if (focusMode) { focusMode = false; $('shell').classList.remove('focus-workspace'); } command('settings', { showBrowser: state?.showBrowser === false }); };
$('bots-toggle').onclick = () => command('settings', { showBots: state.showBots === false });
$('sort-bots').onclick = (event) => {
  event.stopPropagation();
  const menu = $('sort-menu'), open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('sort-bots').setAttribute('aria-expanded', String(open));
  if (open) menu.querySelectorAll('button').forEach((button) => {
    const active = button.dataset.sort === (state.botSort || 'manual');
    button.classList.toggle('selected', active);
    button.setAttribute('aria-checked', String(active));
    if (!button.querySelector('.sort-check')) button.prepend(element('span', 'sort-check', '✓'));
  });
};
$('sort-menu').onclick = (event) => {
  const button = event.target.closest('button[data-sort]');
  if (button) command('bot-sort', { mode: button.dataset.sort });
  $('sort-menu').classList.add('hidden'); $('sort-bots').setAttribute('aria-expanded', 'false');
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('#sort-menu') && !event.target.closest('#sort-bots')) { $('sort-menu').classList.add('hidden'); $('sort-bots').setAttribute('aria-expanded', 'false'); }
});
$('presence-avatar').onclick = () => showAvatarEditor();
$('chat-avatar').onclick = () => showAvatarEditor();
$('chat-avatar').onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showAvatarEditor(); } };
for (const button of document.querySelectorAll('#screen-count button')) {
  button.onclick = () => command('settings', { screenGrid: Number(button.dataset.screens) });
}
$('vm-toggle').onclick = () => { if (state?.showBrowser === false) command('settings', { showBrowser: true }); command('toggle-vps-view'); };
$('preview-expand').onclick = () => command('toggle-vps-view');
$('preview-hide').onclick = () => command('settings', { preview: false });
$('preview-chip').onclick = () => command('settings', { preview: true });
wirePreviewDrag();
$('extensions-button').onclick = showExtensions;
$('new-tab').onclick = async () => { await command('create-tab'); $('address').focus(); };
function submitUrl(event, inputId) { event.preventDefault(); const url = $(inputId).value.trim(); if (!url) return; if (state.tabs.some((tab) => tab.id === state.activeTabId)) command('navigate', { id: state.activeTabId, url }); else command('create-tab', { url }); }
$('address-form').onsubmit = (event) => submitUrl(event, 'address');
$('home-search').onsubmit = (event) => submitUrl(event, 'home-address');
document.querySelectorAll('[data-url]').forEach((button) => { button.onclick = () => command('create-tab', { url: button.dataset.url }); });
for (const action of ['back', 'forward', 'reload']) $(action).onclick = () => command('history', { id: state.activeTabId, action });
$('control-button').onclick = () => { const tab = state.tabs.find((item) => item.id === state.activeTabId); if (tab) command('control', { id: tab.id, controller: tab.controller === 'agent' ? 'human' : 'agent' }); };
$('ask-bot').onclick = () => command('share-page');

$('modal-close').onclick = closeModal;
$('modal').onclick = (event) => { if (event.target === $('modal')) closeModal(); };
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && modalOpen) closeModal(); });
$('splitter').onpointerdown = (event) => {
  const startX = event.clientX, startWidth = state.chatWidth; $('splitter').setPointerCapture(event.pointerId); $('splitter').classList.add('active');
  const sidebar = document.querySelector('.sidebar');
  const handleMove = (ev) => { const max = Math.min(680, innerWidth - sidebar.getBoundingClientRect().width - 355); const width = Math.max(320, Math.min(max, startWidth + ev.clientX - startX)); document.documentElement.style.setProperty('--chat-width', `${width}px`); scheduleLayout(); };
  const end = () => { $('splitter').classList.remove('active'); $('splitter').removeEventListener('pointermove', handleMove); $('splitter').removeEventListener('pointerup', end); command('settings', { chatWidth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--chat-width')) }); };
  $('splitter').addEventListener('pointermove', handleMove); $('splitter').addEventListener('pointerup', end);
};
api.onPointer?.(point => window.HermesAvatars.receivePointer(point));
api.onFocusAddress(() => { $('address').focus(); $('address').select(); });
api.onSettings?.(showSettings);
api.onFocusWorkspace?.(() => { if (state?.showBrowser === false) return; focusMode = !focusMode; $('shell').classList.toggle('focus-workspace', focusMode); scheduleLayout(); });
new ResizeObserver(scheduleLayout).observe($('shell'));
window.addEventListener('resize', () => { positionPreview(); scheduleLayout(); });
let remoteNoticeShown = false;
function showRemoteNotice(next) {
  if (remoteNoticeShown || !next?.remoteHermesNotice) return;
  remoteNoticeShown = true;
  toast(next.remoteHermesNotice);
}
function showStartupError(message) {
  const text = message || 'intelio did not finish starting.';
  const profile = $('intelio-profile');
  if (profile) profile.textContent = text;
  toast(text);
}
api.onState((next) => { showRemoteNotice(next); render(next); });
api.getState().then((next) => { showRemoteNotice(next); render(next); }).catch((error) => showStartupError(error.message));
setTimeout(() => { if (!state) showStartupError('intelio did not finish starting.'); }, 8000);
