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
  }

  window.IntelioUI = { apply, appendSettings };
}());
