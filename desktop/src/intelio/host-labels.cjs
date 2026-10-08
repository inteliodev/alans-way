/**
 * Names for this laptop, and the Settings lines Remote mode is allowed to show.
 * A Windows window says PC. A Mac window says Mac. Remote mode does not
 * surface the local Hermes probe.
 */
(function intelioHost(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.IntelioHost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioHostFactory() {
  const a = '\u2019';

  function hostLabels(platform = 'darwin') {
    const kind = platform === 'win32' ? 'pc' : platform === 'linux' ? 'computer' : 'mac';
    if (kind === 'pc') {
      return {
        pane: 'This PC',
        sshSaved: `This PC${a}s SSH address saved`,
        sshField: `This PC${a}s SSH address (as your VPS reaches it)`,
        sshPlaceholder: 'you@thispc or thispc.tailnet-name',
        connector: `this PC${a}s browser connector`,
        connectAgents: 'Connect your Hermes agents on a VPS to this PC. Fill in both SSH addresses, run the setup on your VPS, then test the agent path.',
        setupWires: `The setup installs the agent plugin on your gateway host and wires this PC${a}s browser connector for the selected bot. Run once per bot.`,
        stay: 'Bot discovery reads Telegram Web A’s local cache. Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this PC.',
        links: 'A link sent by you or a bot opens a local tab assigned to that bot, so both of you can see it. If this PC is unreachable, the bot opens its own copy on the VPS desktop instead.',
        sshInvalid: 'Enter the PC SSH address as user@host or host, with no spaces or symbols.',
        sshSavedInvalid: 'The saved PC SSH address is invalid. Re-enter it as user@host or host.',
        sshMissing: `Enter this PC${a}s SSH address as your VPS reaches it.`,
        sshOk: 'VPS reaches this PC over ssh — agents can route here.',
        pathCheck: 'Checking VPS → PC ssh path…',
        promptLead: 'Set up intelio on this machine and connect it to my PC.',
        promptSsh: `My PC${a}s SSH address is:`,
        controlLocal: 'your PC',
        statusLocal: 'PC',
        browse: 'Browse on this PC.',
      };
    }
    if (kind === 'computer') {
      return {
        pane: 'This computer',
        sshSaved: `This computer${a}s SSH address saved`,
        sshField: `This computer${a}s SSH address (as your VPS reaches it)`,
        sshPlaceholder: 'you@thiscomputer or thiscomputer.tailnet-name',
        connector: `this computer${a}s browser connector`,
        connectAgents: 'Connect your Hermes agents on a VPS to this computer. Fill in both SSH addresses, run the setup on your VPS, then test the agent path.',
        setupWires: `The setup installs the agent plugin on your gateway host and wires this computer${a}s browser connector for the selected bot. Run once per bot.`,
        stay: 'Bot discovery reads Telegram Web A’s local cache. Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this computer.',
        links: 'A link sent by you or a bot opens a local tab assigned to that bot, so both of you can see it. If this computer is unreachable, the bot opens its own copy on the VPS desktop instead.',
        sshInvalid: 'Enter the computer SSH address as user@host or host, with no spaces or symbols.',
        sshSavedInvalid: 'The saved computer SSH address is invalid. Re-enter it as user@host or host.',
        sshMissing: `Enter this computer${a}s SSH address as your VPS reaches it.`,
        sshOk: 'VPS reaches this computer over ssh — agents can route here.',
        pathCheck: 'Checking VPS → computer ssh path…',
        promptLead: 'Set up intelio on this machine and connect it to my computer.',
        promptSsh: `My computer${a}s SSH address is:`,
        controlLocal: 'your computer',
        statusLocal: 'computer',
        browse: 'Browse on this computer.',
      };
    }
    return {
      pane: 'Your Mac',
      sshSaved: `This Mac${a}s SSH address saved`,
      sshField: `This Mac${a}s SSH address (as your VPS reaches it)`,
      sshPlaceholder: 'you@mymac or mymac.tailnet-name',
      connector: `this Mac${a}s browser connector`,
      connectAgents: 'Connect your Hermes agents on a VPS to this Mac. Fill in both SSH addresses, run the setup on your VPS, then test the agent path.',
      setupWires: `The setup installs the agent plugin on your gateway host and wires this Mac${a}s browser connector for the selected bot. Run once per bot.`,
      stay: 'Bot discovery reads Telegram Web A’s local cache. Newly opened bot chats appear after Telegram saves them. Your Telegram session and browser logins stay on this Mac.',
      links: 'A link sent by you or a bot opens a local tab assigned to that bot, so both of you can see it. If the Mac is unreachable, the bot opens its own copy on the VPS desktop instead.',
      sshInvalid: 'Enter the Mac SSH address as user@host or host, with no spaces or symbols.',
      sshSavedInvalid: 'The saved Mac SSH address is invalid. Re-enter it as user@host or host.',
      sshMissing: `Enter this Mac${a}s SSH address as your VPS reaches it.`,
      sshOk: 'VPS reaches this Mac over ssh — agents can route here.',
      pathCheck: 'Checking VPS → Mac ssh path…',
      promptLead: 'Set up intelio on this machine and connect it to my Mac.',
      promptSsh: `My Mac${a}s SSH address is:`,
      controlLocal: 'your Mac',
      statusLocal: 'Mac',
      browse: 'Browse on your Mac.',
    };
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

  function hermesChecklist(state) {
    const remote = state && state.remoteHermes;
    if (remoteModeOn(remote)) {
      return { done: Boolean(String(remote.versionLabel || '').trim()), label: vpsHermesLine(remote) };
    }
    const hermes = state && state.intelio && state.intelio.hermes;
    if (!hermes) return { done: false, label: 'Hermes pin not loaded' };
    const pin = (hermes.pinCommit || '').slice(0, 12) || 'missing';
    return { done: hermes.match === 'commit', label: `Hermes pin ${pin} · ${hermes.summary}` };
  }

  return { hostLabels, remoteModeOn, vpsHermesLine, hermesChecklist };
});
