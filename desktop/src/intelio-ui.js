/** Intelio profile, brand, and Hermes pin surfaces. Upstream Hermes strings stay as they are. */
(function intelioUi() {
  const $ = (id) => document.getElementById(id);
  function text(id, value) { const node = $(id); if (node) node.textContent = value; }

  function apply(state) {
    const intelio = state?.intelio;
    if (!intelio) return;
    const title = intelio.brand?.windowTitle || 'Intelio';
    const profile = intelio.ok ? intelio.profileName : 'Profile not loaded';
    document.title = intelio.ok ? `${title} — ${profile}` : title;
    text('product-title', title);
    const mark = $('intelio-mark');
    if (mark && intelio.brand?.mark) { mark.src = intelio.brand.mark; mark.hidden = false; }
    const tokens = intelio.brand?.tokens || {};
    const root = document.documentElement;
    if (tokens.background) root.style.setProperty('--bg', tokens.background);
    if (tokens.foreground) root.style.setProperty('--text', tokens.foreground);
    if (tokens.surface) root.style.setProperty('--intelio-surface', tokens.surface);
    if (tokens.line) root.style.setProperty('--line', tokens.line);
    if (tokens.font) root.style.setProperty('--intelio-font', `"${tokens.font}", "Geist Sans", ui-sans-serif, system-ui, sans-serif`);
    text('intelio-profile', intelio.ok ? `Profile · ${profile}` : `Profile · ${intelio.error || 'not loaded'}`);
    const hermes = intelio.hermes || {};
    const pin = hermes.pinCommit ? hermes.pinCommit.slice(0, 12) : 'missing';
    const launch = (intelio.launchArgv || []).join(' ') || 'hermes';
    text('hermes-pin', intelio.ok ? `${launch} · pin ${pin} · ${hermes.summary || 'unavailable'}` : 'Hermes pin unavailable');
  }

  function appendSettings(body, { element, command, state, toast }) {
    const intelio = state?.intelio || {};
    body.append(element('h3', '', 'Intelio profile'));
    if (!intelio.ok) body.append(element('p', 'settings-note', intelio.error || 'The Intelio profile did not load.'));
    const lines = [
      intelio.profileName ? `Profile name: ${intelio.profileName}` : '',
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
      intelio.attribution || '',
    ].filter(Boolean);
    for (const line of lines) body.append(element('p', 'settings-note', line));
    const field = element('div', 'field');
    const label = element('label', '', 'Intelio profile directory');
    label.htmlFor = 'intelio-profile-dir';
    const input = element('input');
    input.id = 'intelio-profile-dir';
    input.value = intelio.profileDir || '';
    input.spellcheck = false;
    field.append(label, input);
    const load = element('button', 'secondary-button', 'Load profile');
    load.onclick = async () => {
      const result = await command('reload-intelio', { profileDir: input.value.trim() });
      if (result?.intelio?.ok) toast(`Loaded Intelio profile ${result.intelio.profileName}.`);
    };
    const recheck = element('button', 'secondary-button', 'Recheck Hermes pin');
    recheck.onclick = async () => {
      const result = await command('reload-intelio', {});
      if (result?.intelio) toast(result.intelio.hermes?.summary || result.intelio.error || 'Hermes pin rechecked.');
    };
    body.append(field, load, recheck, element('hr', 'section-divider'));
    appendRemoteHermes(body, { element, command, toast });
  }

  /** Remote Hermes (VPS): this app as a client of the single Hermes on the VPS, over Tailscale only. */
  function appendRemoteHermes(body, { element, command, toast }) {
    body.append(element('h3', '', 'Remote Hermes (VPS)'));
    body.append(element('p', 'settings-note', 'When Remote Hermes is on, the main window lists each profile and chats through that profile’s VPS sessions. The host must be a tailnet address (a Tailscale CGNAT address or *.ts.net) or 127.0.0.1 for an SSH tunnel. The import file remote-hermes-key.import can hold several lines, one profile=key per line. A legacy API_SERVER_KEY= line, or a single raw key, is the intelio key. A vnc= line is the VPS desktop password, stored the same way and sent when the desktop asks. It is not a profile, and it is not put in the viewer URL. Each profile only accepts its own key. Intelio encrypts them and deletes that file. You do not type the keys or the desktop password.'));
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
      host.value = s.host || ''; port.value = s.port || 8642; profile.value = s.profile || 'default';
      status.textContent = s.error || `${s.hasKey ? 'Key saved' : 'No key saved'} for profile ${s.profile || 'default'}.${s.encryptionAvailable ? '' : ' OS encryption unavailable: keys cannot be saved.'}`;
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
        let s = await command('remote-hermes-config', { host: host.value.trim(), port: Number(port.value), profile: profile.value.trim(), enabled: true });
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
