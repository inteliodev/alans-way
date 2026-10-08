/** Intelio profile, brand, and Hermes pin surfaces. Upstream Hermes strings stay as they are. */
(function intelioUi() {
  const $ = (id) => document.getElementById(id);
  function text(id, value) { const node = $(id); if (node) node.textContent = value; }
  function visibleName(raw) {
    const value = String(raw || '').trim();
    const known = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
    return known[value.toLowerCase()] || (value.toLowerCase() === 'intelio' ? 'intelio' : value);
  }

  function apply(state) {
    const intelio = state?.intelio;
    if (!intelio) return;
    document.title = 'intelio';
    text('product-title', 'intelio');
    const mark = $('intelio-mark');
    if (mark && intelio.brand?.mark) { mark.src = intelio.brand.mark; mark.hidden = false; }
    const tokens = intelio.brand?.tokens || {};
    const root = document.documentElement;
    const light = String(state.theme || '').trim().toLowerCase() === 'light';
    if (!light) {
      if (tokens.background) root.style.setProperty('--bg', tokens.background);
      if (tokens.foreground) root.style.setProperty('--text', tokens.foreground);
      if (tokens.surface) root.style.setProperty('--intelio-surface', tokens.surface);
      if (tokens.line) root.style.setProperty('--line', tokens.line);
    }
    if (tokens.font) root.style.setProperty('--intelio-font', `"${tokens.font}", "Geist Sans", ui-sans-serif, system-ui, sans-serif`);
    const profileLabel = visibleName(intelio.profileName || intelio.profile || '');
    text('intelio-profile', intelio.ok ? `Profile · ${profileLabel || 'intelio'}` : `Profile · ${intelio.error || 'not loaded'}`);
    const hermes = intelio.hermes || {};
    const pin = hermes.pinCommit ? hermes.pinCommit.slice(0, 12) : 'missing';
    const launch = (intelio.launchArgv || []).join(' ') || 'hermes';
    text('hermes-pin', intelio.ok ? `${launch} · pin ${pin} · ${hermes.summary || 'unavailable'}` : 'Hermes pin unavailable');
  }

  function remoteModeOn(remote) {
    if (!remote || remote.enabled !== true) return false;
    if (String(remote.host || '').trim()) return true;
    if (remote.activeMode === 'cloud') return true;
    return Array.isArray(remote.profilesWithKeys) && remote.profilesWithKeys.length > 0;
  }

  function vpsHermesLine(remote) {
    const version = String(remote && remote.versionLabel || '').trim();
    return version ? `VPS Hermes ${version}` : 'VPS Hermes version is still loading.';
  }

  function remoteOn(state) {
    return remoteModeOn(state?.remoteHermes);
  }

  function appendVpsHermes(body, { element, state }) {
    const remote = state?.remoteHermes || {};
    const line = state?.hermesStatus?.label || vpsHermesLine(remote);
    body.append(element('h3', '', 'VPS Hermes'));
    body.append(element('p', 'settings-note', line));
    const where = [remote.host ? `${remote.host}:${remote.port || 8642}` : '', remote.profile ? `profile ${visibleName(remote.profile)}` : ''].filter(Boolean).join(' · ');
    if (where) body.append(element('p', 'settings-note', where));
    body.append(element('hr', 'section-divider'));
  }

  function appendSettings(body, { element, command, state, toast }) {
    if (remoteOn(state)) {
      appendVpsHermes(body, { element, state });
      appendRemoteHermes(body, { element, command, toast, state });
      appendIntelioNode(body, { element, command, toast });
      return;
    }
    const intelio = state?.intelio || {};
    body.append(element('h3', '', 'intelio profile'));
    if (!intelio.ok) body.append(element('p', 'settings-note', intelio.error || 'The intelio profile did not load.'));
    const lines = [
      intelio.profileName ? `Profile name: ${visibleName(intelio.profileName)}` : '',
      intelio.profileDir ? `Directory: ${intelio.profileDir}` : '',
      `Hermes command: ${(intelio.launchArgv || ['hermes']).join(' ')}`,
      intelio.hermes ? `Pin ${intelio.hermes.pinCommit || 'missing'} · ${intelio.hermes.summary || 'unavailable'}` : '',
      intelio.hermes?.version ? `Installed Hermes: ${intelio.hermes.version.split('\n')[0]}` : '',
      intelio.pinVerifiedOn ? `Verified ${intelio.pinVerifiedOn}` : '',
      `Safety: YOLO off, consequential actions ask-first, credentials vault-blind.`,
      `Browsing zone: ${intelio.browsingOrigins?.length ? intelio.browsingOrigins.join(', ') : 'not set — upstream tab rules only'}`,
      `Allowed folders: ${intelio.allowedFolders?.length ? intelio.allowedFolders.join(', ') : 'none'}`,
      intelio.panels?.length ? `Panels: ${intelio.panels.join(', ')}` : '',
      intelio.skills?.length ? `Skills: ${intelio.skills.join(', ')}` : 'Skills are listed on the profile and are not installed into Hermes from this app.',
    ].filter(Boolean);
    for (const line of lines) body.append(element('p', 'settings-note', line));
    const field = element('div', 'field');
    const label = element('label', '', 'intelio profile directory');
    label.htmlFor = 'intelio-profile-dir';
    const input = element('input');
    input.id = 'intelio-profile-dir';
    input.value = intelio.profileDir || '';
    input.spellcheck = false;
    field.append(label, input);
    const load = element('button', 'secondary-button', 'Load profile');
    load.onclick = async () => {
      const result = await command('reload-intelio', { profileDir: input.value.trim() });
      if (result?.intelio?.ok) toast(`Loaded intelio profile ${visibleName(result.intelio.profileName)}.`);
    };
    const recheck = element('button', 'secondary-button', 'Recheck Hermes pin');
    recheck.onclick = async () => {
      const result = await command('reload-intelio', {});
      if (result?.intelio) toast(result.intelio.hermes?.summary || result.intelio.error || 'Hermes pin rechecked.');
    };
    body.append(field, load, recheck, element('hr', 'section-divider'));
    appendRemoteHermes(body, { element, command, toast, state });
    appendIntelioNode(body, { element, command, toast });
  }

  /** intelio node (docs/intelio-node.md): VPS agents use this computer as the signed-in user. */
  function appendIntelioNode(body, { element, command, toast }) {
    body.append(element('h3', '', 'This computer'));
    const held = element('p', 'settings-note intelio-node-held', '');
    held.hidden = true;
    const clearedField = element('div', 'field checkbox-field');
    clearedField.hidden = true;
    const cleared = element('input');
    cleared.id = 'intelio-node-cleared';
    cleared.type = 'checkbox';
    const clearedLabel = element('label', '', 'IT has cleared this computer for intelio');
    clearedLabel.htmlFor = 'intelio-node-cleared';
    clearedField.append(cleared, clearedLabel);
    const allowField = element('div', 'field checkbox-field');
    const allow = element('input');
    allow.id = 'intelio-node-enabled';
    allow.type = 'checkbox';
    allow.checked = true;
    const allowLabel = element('label', '', 'Let my agents use this computer');
    allowLabel.htmlFor = 'intelio-node-enabled';
    allowField.append(allow, allowLabel);
    const nameField = element('div', 'field');
    const nameLabel = element('label', '', 'Computer name');
    nameLabel.htmlFor = 'intelio-node-name';
    const name = element('input');
    name.id = 'intelio-node-name';
    name.spellcheck = false;
    name.autocomplete = 'off';
    nameField.append(nameLabel, name);
    const status = element('p', 'settings-note', 'Loading…');
    status.id = 'intelio-node-status';
    const words = { online: 'Connected: agents can use this computer.', connecting: 'Connecting…', waiting: 'Waiting for sign-in.', retrying: 'Reconnecting…', revoked: 'Revoked on the VPS. Turn the switch off and on to enroll again.', error: 'Not connected.', off: 'Off: agents cannot use this computer.', held: 'Held: agents cannot use this computer.', ask: 'Not set up yet: tick the box to let your agents use this computer.', unavailable: 'Not available.' };
    const doing = { list_dir: 'looking at files', stat: 'looking at files', read_file: 'reading a file', search_files: 'searching files', write_file: 'changing a file', run_command: 'running a command', screenshot: 'taking a screenshot', computer_info: 'checking this computer' };
    const show = (s) => {
      allow.checked = s.enabled !== false && s.status !== 'ask';
      allow.disabled = Boolean(s.held);
      if (document.activeElement !== name) name.value = s.customName || s.name || '';
      name.placeholder = s.hostname || '';
      held.hidden = !s.held;
      held.textContent = s.held ? s.detail : '';
      clearedField.hidden = !s.managed;
      cleared.checked = Boolean(s.cleared);
      const active = Array.isArray(s.active) ? s.active : [];
      const using = active.length ? `An agent is using this computer now (${[...new Set(active.map((a) => doing[a.tool] || 'using the terminal'))].join(', ')}).` : '';
      status.textContent = [words[s.status] || s.status || '', s.detail && !['online', 'held'].includes(s.status) ? s.detail : '', using].filter(Boolean).join(' ');
    };
    const load = () => command('intelio-node-state', {}).then(show).catch((e) => { status.textContent = e.message; });
    load();
    const poll = setInterval(() => { if (!status.isConnected) { clearInterval(poll); return; } load(); }, 3000);
    allow.onchange = async () => {
      try { show(await command('intelio-node-config', { enabled: allow.checked })); toast(allow.checked ? 'Your agents can use this computer.' : 'Your agents can no longer use this computer.'); }
      catch (e) { status.textContent = e.message; }
    };
    cleared.onchange = async () => {
      try { show(await command('intelio-node-config', { cleared: cleared.checked })); toast(cleared.checked ? 'Marked as cleared by IT.' : 'Held until IT clears this computer.'); }
      catch (e) { status.textContent = e.message; }
    };
    const save = element('button', 'secondary-button', 'Save name');
    save.onclick = async () => {
      try { show(await command('intelio-node-config', { name: name.value.trim() })); toast('Computer name saved.'); }
      catch (e) { status.textContent = e.message; }
    };
    const activity = element('div', 'intelio-node-activity');
    activity.hidden = true;
    const view = element('button', 'secondary-button', 'View activity');
    view.onclick = async () => {
      if (!activity.hidden) { activity.hidden = true; view.textContent = 'View activity'; return; }
      try {
        const result = await command('intelio-node-audit', { limit: 200 });
        renderActivity(activity, element, result.entries || [], false);
        activity.prepend(element('p', 'settings-note', `What agents did on this computer (newest first). Saved in ${result.file}.`));
        activity.hidden = false;
        view.textContent = 'Hide activity';
      } catch (e) { status.textContent = e.message; }
    };
    body.append(held, clearedField, allowField, nameField, status, save, view, activity,
      element('p', 'settings-note', 'When this is on, your intelio agents on the VPS can work with files and the terminal on this computer as you (and Claude Code or Codex through the terminal if they are installed), search, and take screenshots. They never get administrator rights: a command that asks for them shows a prompt here first. A notice with a Stop button shows at the top of the screen while an agent is working here. Every request is logged; View activity shows the log. Turning this off disconnects immediately.'),
      element('hr', 'section-divider'));
    appendComputers(body, { element, command, toast });
  }

  function renderActivity(container, element, entries, relay) {
    container.textContent = '';
    if (!entries.length) { container.append(element('p', 'settings-note', 'No agent activity yet.')); return; }
    const list = element('ol', 'intelio-node-activity-list');
    for (const e of entries.slice().reverse()) {
      const when = e.time ? new Date(e.time).toLocaleString() : '';
      const a = e.args || {};
      const what = a.path || a.root || a.cwd || a.command || (a.program ? `${a.program}…` : '') || '';
      const line = [when, relay ? e.computer : '', e.tool, what, e.ok === false ? `failed${e.error ? `: ${e.error}` : ''}` : (e.exit_code !== undefined ? `exit ${e.exit_code}` : '')].filter(Boolean).join(' · ');
      list.append(element('li', e.ok === false ? 'failed' : '', line));
    }
    container.append(list);
  }

  /** Every computer the agents can use (relay list) with its kill switch, plus the relay's activity log. */
  function appendComputers(body, { element, command, toast }) {
    body.append(element('h3', '', 'Your computers'));
    const list = element('div', 'intelio-computers');
    const note = element('p', 'settings-note', 'Loading…');
    const activity = element('div', 'intelio-node-activity');
    activity.hidden = true;
    const render = (result) => {
      list.textContent = '';
      const rows = Array.isArray(result?.computers) ? result.computers : [];
      note.textContent = rows.length ? 'Untick a computer to turn it off for agents (its kill switch). It stays connected and comes back when you tick it again.' : 'No computers yet.';
      for (const c of rows) {
        const row = element('div', 'field checkbox-field intelio-computer-row');
        const box = element('input');
        box.type = 'checkbox';
        box.id = `intelio-computer-${String(c.id).replace(/[^\w-]/g, '')}`;
        box.checked = !c.paused;
        const state = [c.kind === 'cloud' ? 'the VPS' : c.os, c.online ? 'online' : 'offline', c.in_use ? `in use${c.current_tool ? ` (${c.current_tool})` : ''}` : ''].filter(Boolean).join(' · ');
        const label = element('label', '', `${c.name}${state ? ` · ${state}` : ''}`);
        label.htmlFor = box.id;
        box.onchange = async () => {
          try {
            await command('intelio-computers-pause', { computer: c.id, paused: !box.checked });
            toast(box.checked ? `Agents can use ${c.name} again.` : `${c.name} is turned off for agents.`);
          } catch (e) { box.checked = !box.checked; note.textContent = e.message; }
        };
        row.append(box, label);
        list.append(row);
      }
    };
    const refresh = () => command('intelio-computers', {}).then(render).catch((e) => { list.textContent = ''; note.textContent = e.message; });
    refresh();
    const again = element('button', 'secondary-button', 'Refresh');
    again.onclick = refresh;
    const all = element('button', 'secondary-button', 'All agent activity');
    all.onclick = async () => {
      if (!activity.hidden) { activity.hidden = true; all.textContent = 'All agent activity'; return; }
      try {
        const result = await command('intelio-computers-audit', { limit: 200 });
        renderActivity(activity, element, result.entries || [], true);
        activity.prepend(element('p', 'settings-note', 'Every agent request to any computer, as the VPS saw it (newest first). Commands show the program only; each computer\'s own log has the full command.'));
        activity.hidden = false;
        all.textContent = 'Hide activity';
      } catch (e) { note.textContent = e.message; }
    };
    body.append(list, note, again, all, activity, element('hr', 'section-divider'));
  }

  /** Remote Hermes (VPS): this app as a client of the single Hermes on the VPS, over Tailscale only. */
  function appendRemoteHermes(body, { element, command, toast, state }) {
    body.append(element('h3', '', 'Remote Hermes (VPS)'));
    const remote = state?.remoteHermes;
    if (remote && (remote.host || remote.versionLabel || remote.activeMode)) {
      const pathName = remote.activeMode === 'cloud' ? 'intelio cloud' : remote.activeMode === 'tailscale' ? 'Tailscale' : '';
      if (pathName) body.append(element('p', 'settings-note path-note', pathName));
      const host = remote.host ? `${remote.host}:${remote.port || 8642}` : '';
      body.append(element('p', 'settings-note', ['VPS Hermes', host, remote.versionLabel || ''].filter(Boolean).join(' · ')));
    }
    body.append(element('p', 'settings-note', 'When Remote Hermes is on, the main window lists each profile and chats through that profile’s VPS sessions. Connection is Auto, Tailscale, or intelio cloud (app.intelio-ai.com). Auto tries the Tailscale host for a few seconds and, if it does not answer, uses intelio cloud. intelio cloud opens a sign-in window for the one-time email code. The sign-in cookie stays in the app session and is not saved in preferences. The Tailscale host must be a tailnet address (a Tailscale CGNAT address or *.ts.net) or 127.0.0.1 for an SSH tunnel. The import file remote-hermes-key.import can hold several lines, one profile=key per line. A legacy API_SERVER_KEY= line, or a single raw key, is the intelio key. A vnc= line is the VPS desktop password, stored the same way and sent when the desktop asks. It is not a profile, and it is not put in the viewer URL. Each profile only accepts its own key. intelio encrypts them and deletes that file. You do not type the keys or the desktop password. A new machine can receive the same keys after intelio cloud sign-in.'));
    const modeField = element('div', 'field');
    const modeLabel = element('label', '', 'Connection');
    modeLabel.htmlFor = 'remote-hermes-connection';
    const mode = element('select');
    mode.id = 'remote-hermes-connection';
    for (const [value, text] of [['auto', 'Auto'], ['tailscale', 'Tailscale'], ['cloud', 'intelio cloud (app.intelio-ai.com)']]) {
      const option = element('option', '', text);
      option.value = value;
      mode.append(option);
    }
    modeField.append(modeLabel, mode);
    body.append(modeField);
    const status = element('p', 'settings-note', 'Loading…');
    const tail = element('p', 'settings-note', 'Checking Tailscale…');
    tail.id = 'remote-hermes-tailscale';
    const make = (id, labelText, value, type = 'text') => {
      const field = element('div', 'field');
      const label = element('label', '', labelText); label.htmlFor = id;
      const input = element('input'); input.id = id; input.type = type; input.value = value ?? ''; input.spellcheck = false; input.autocomplete = 'off';
      field.append(label, input); body.append(field); return input;
    };
    const host = make('remote-hermes-host', 'VPS host (Tailscale)', '');
    const port = make('remote-hermes-port', 'Port', '8642');
    const profile = make('remote-hermes-profile', 'Hermes profile', 'intelio');
    const key = make('remote-hermes-key', 'API key for this profile (write-only)', '', 'password');
    key.placeholder = 'unchanged';
    const install = element('button', 'secondary-button', 'Install Tailscale');
    install.hidden = true;
    install.onclick = () => command('remote-hermes-install-tailscale', {}).catch((e) => { status.textContent = e.message; });
    const show = (s) => {
      host.value = s.host || ''; port.value = s.port || 8642; profile.value = visibleName(s.profile || 'default');
      mode.value = s.connection === 'tailscale' || s.connection === 'cloud' ? s.connection : 'auto';
      status.textContent = s.error || `${s.hasKey ? 'Key saved' : 'No key saved'} for profile ${visibleName(s.profile || 'default')}.${s.encryptionAvailable ? '' : ' OS encryption unavailable: keys cannot be saved.'}`;
      if (s.tailscale) {
        tail.textContent = s.tailscale.detail || '';
        install.hidden = Boolean(s.tailscale.connected);
        install.textContent = s.tailscale.installed ? 'Open Tailscale download' : 'Install Tailscale';
      }
    };
    command('remote-hermes-state', {}).then(show).catch((e) => { status.textContent = e.message; });
    const save = element('button', 'secondary-button', 'Save');
    save.onclick = async () => {
      try {
        const profileId = { intelio: 'intelio', Intelio: 'intelio', PRC: 'prc', Alignment: 'alignment', HHP: 'hhp' }[profile.value.trim()] || profile.value.trim().toLowerCase();
        let s = await command('remote-hermes-config', { host: host.value.trim(), port: Number(port.value), profile: profileId, enabled: true, connection: mode.value });
        if (key.value) { s = await command('remote-hermes-key', { key: key.value, profile: s.profile }); key.value = ''; }
        show(s); toast('Remote Hermes settings saved.');
      } catch (e) { status.textContent = e.message; }
    };
    const test = element('button', 'secondary-button', 'Test connection');
    test.onclick = async () => {
      try { const r = await command('remote-hermes-test', {}); status.textContent = `Reachable (HTTP ${r.health?.status}). Session chat streaming: ${r.sessionChat ? 'yes' : 'no'}.`; }
      catch (e) { status.textContent = e.message; }
    };
    const open = element('button', 'secondary-button', 'Open Remote Hermes');
    open.onclick = () => command('open-remote-hermes', {}).catch((e) => { status.textContent = e.message; });
    body.append(status, tail, install, save, test, open, element('hr', 'section-divider'));
  }

  window.IntelioUI = { apply, appendSettings };
}());
