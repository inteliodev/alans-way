'use strict';
/**
 * Ask-before gate for intelio agents on a LOCAL computer (Hayden, Oct 8 2026):
 * deleting files, pushing code and installing software ask him first, on that
 * computer; everything else runs on its own. The `cloud` computer (the VPS) is
 * not gated here: its pushes go through the VPS push guard.
 *
 * Lives in the desktop node, next to the executors, so an agent cannot talk its
 * way around it: the node classifies the actual tool call (tool name plus the
 * command text it would run, including lines typed into a terminal session with
 * send_input) and refuses a gated call unless the person clicks "Allow once"
 * within the timeout. No answer, a closed window or any error means Deny.
 *
 * classifyCommand() is a heuristic, deliberately biased toward asking:
 * quote-aware split into simple commands (policy.cjs), wrappers (sudo, env,
 * xargs, Start-Process ...) stripped, nested shells (bash -c, powershell
 * -Command / -EncodedCommand, cmd /c, ssh, wsl) and local shell scripts
 * (bash x.sh, ./x.sh, powershell -File x.ps1, x.cmd) searched too.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('./policy.cjs');

const APPROVAL_TIMEOUT_MS = 120000;
const KIND_WORDS = { delete: 'delete files', push: 'push code', install: 'install software' };

const DELETE_PROGS = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'shred', 'srm', 'trash', 'trash-put', 'rimraf', 'del-cli',
  'remove-item', 'ri', 'clear-recyclebin', 'remove-itemproperty']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl', 'ssh', 'su', 'runuser', 'script', 'busybox']);
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'osascript']);
const LAUNCHERS = new Set(['start-process', 'saps', 'start', 'open', 'invoke-item', 'ii', 'call', '&', 'explorer', 'runas', 'cmd']);
const INSTALLER_FILE = /(?:\.msi|\.msix|\.msixbundle|\.appx|\.pkg|\.mpkg)$|(?:^|[\\/])[^\\/]*(?:setup|install)[^\\/]*\.exe$/i;
const SCRIPT_FILE = /\.(?:sh|bash|zsh|ps1|psm1|cmd|bat)$/i;
const PROGRAMMATIC_DELETE = /\bshutil\.rmtree\b|\bos\.(?:remove|unlink|rmdir|removedirs)\s*\(|\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|rm_rf|rmtree)\s*\(|\.unlink\s*\(\s*\)|\bFileUtils\.(?:rm|rm_r|rm_rf|remove_dir)\b|\bFile\.delete\b|\bDeno\.remove\b|\brimraf\b|\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\b/i;
const PIPE_TO_SHELL = /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|iex|invoke-expression|pwsh|powershell)\b/i;
const IEX_DOWNLOAD = /\b(?:iex|invoke-expression)\b[^\n]*\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|curl|wget)\b/i;
const SHELL_OF_DOWNLOAD = /\b(?:sh|bash|zsh)\b[^\n]*(?:<\(|\$\(|`)\s*(?:curl|wget)\b/i;
const LOOKS_DANGEROUS = /\b(?:rm|rmdir|del|erase|rd|remove-item|unlink|shred)\b|\bgit\b[^\n]*\b(?:push|clean)\b|\bgh\b[^\n]*\b(?:pr\s+merge|repo\s+delete)\b|\b(?:install|msiexec)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:i|ci|add)\b/i;

function progName(token) {
  let b = String(token || '').split(/[\\/]/).pop().toLowerCase();
  b = b.replace(/\.(?:exe|cmd|bat|com)$/, '');
  return b;
}

function short(text, max = 160) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function item(kind, what, extra = {}) {
  return { kind, what: short(what), ...extra };
}

function firstSub(tokens, start = 1) {
  for (let i = start; i < tokens.length; i += 1) if (!tokens[i].startsWith('-')) return { sub: tokens[i].toLowerCase(), at: i };
  return { sub: '', at: tokens.length };
}

/** git: clean / rm delete; pushes come from policy.findPushes (relay-stampable). */
function gitItems(tokens, raw) {
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(tokens[i])) i += 1;
    i += 1;
  }
  const sub = (tokens[i] || '').toLowerCase();
  const rest = tokens.slice(i + 1);
  if (sub === 'clean' && !rest.some((t) => t === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(t))) return [item('delete', raw)];
  if (sub === 'rm' && !rest.some((t) => t === '--cached' || t === '-n' || t === '--dry-run')) return [item('delete', raw)];
  return [];
}

function ghItems(tokens, raw) {
  const words = [];
  for (let i = 1; i < tokens.length; i += 1) {
    if (['-R', '--repo', '--hostname'].includes(tokens[i])) { i += 1; continue; }
    words.push(tokens[i].toLowerCase());
  }
  const [group, sub] = words;
  if (group === 'repo' && (sub === 'delete' || sub === 'archive')) return [item('push', raw)];
  if (group === 'release' && sub === 'delete') return [item('push', raw)];
  return [];
}

function installItems(prog, tokens, raw) {
  const { sub, at } = firstSub(tokens);
  const args = tokens.slice(at + 1).map((t) => t.toLowerCase());
  const yes = () => [item('install', raw)];
  switch (prog) {
    case 'npm': case 'pnpm': case 'cnpm':
      if (['install', 'i', 'ci', 'add', 'isntall', 'in', 'ins', 'inst', 'insta', 'instal', 'install-test', 'it', 'install-ci-test', 'cit'].includes(sub)) return yes();
      return [];
    case 'yarn':
      if (['install', 'add', 'global'].includes(sub) || (!sub && !tokens.slice(1).some((t) => /^(?:--version|-v|--help|-h)$/.test(t)))) return yes();
      return [];
    case 'bun':
      if (['install', 'i', 'add', 'a'].includes(sub)) return yes();
      return [];
    case 'pip': case 'pip3': case 'pipx':
      if (['install', 'inject'].includes(sub)) return yes();
      return [];
    case 'uv':
      if (sub === 'add' || sub === 'sync') return yes();
      if ((sub === 'pip' || sub === 'tool') && args[0] === 'install') return yes();
      return [];
    case 'poetry': case 'pdm':
      if (['add', 'install'].includes(sub)) return yes();
      return [];
    case 'conda': case 'mamba': case 'micromamba':
      if (['install', 'create'].includes(sub)) return yes();
      return [];
    case 'gem': case 'cargo': case 'go': case 'dotnet': case 'snap': case 'flatpak': case 'port': case 'mas': case 'sdkmanager':
      if (sub === 'install' || (prog === 'dotnet' && sub === 'tool' && args[0] === 'install')) return yes();
      return [];
    case 'winget':
      if (['install', 'add', 'upgrade', 'update', 'import'].includes(sub)) return yes();
      return [];
    case 'choco': case 'chocolatey': case 'cinst': case 'scoop':
      if (prog === 'cinst' || ['install', 'upgrade', 'update'].includes(sub)) return yes();
      return [];
    case 'brew':
      if (['install', 'reinstall', 'upgrade', 'tap'].includes(sub) || (sub === 'bundle' && (!args[0] || args[0] === 'install'))) return yes();
      return [];
    case 'apt': case 'apt-get': case 'aptitude': case 'dnf': case 'yum': case 'zypper': case 'apk':
      if (['install', 'reinstall', 'add', 'upgrade', 'dist-upgrade', 'full-upgrade', 'in'].includes(sub)) return yes();
      return [];
    case 'pacman': case 'yay': case 'paru':
      if (tokens.slice(1).some((t) => /^-S/.test(t) || /^-U/.test(t))) return yes();
      return [];
    case 'dpkg':
      if (tokens.slice(1).some((t) => t === '-i' || t === '--install')) return yes();
      return [];
    case 'rpm':
      if (tokens.slice(1).some((t) => /^-[a-z]*[iU]/.test(t) || t === '--install' || t === '--upgrade')) return yes();
      return [];
    case 'msiexec': case 'installer': case 'install-module': case 'install-package': case 'install-script': case 'add-appxpackage':
    case 'install-psresource': case 'update-module':
      return yes();
    default:
      return [];
  }
}

/**
 * Gated items in shell text: [{ kind: 'delete'|'push'|'install', what, relay? }].
 * relay: true marks a push the relay asks about itself (policy.findPushes) and can stamp.
 * opts.readScript(file) -> string|null lets the classifier look inside local shell scripts.
 */
function classifyCommand(command, opts = {}, depth = 0) {
  const text = String(command == null ? '' : command);
  if (!text.trim() || depth > 4) return [];
  const found = [];
  for (const desc of policy.findPushes(text)) {
    const force = /(?:^|\s)(?:--force(?:-with-lease)?(?:=\S*)?|-f|--mirror|--delete|-d)(?=\s|$)|\s\+\S/.test(text) && /push/.test(desc);
    found.push(item('push', force ? `${desc} (force or delete on the remote)` : desc, { relay: true }));
  }
  if (PIPE_TO_SHELL.test(text) || IEX_DOWNLOAD.test(text) || SHELL_OF_DOWNLOAD.test(text)) found.push(item('install', `downloaded script piped to a shell: ${text}`));
  for (const part of policy.splitSimpleCommands(text)) {
    let tokens;
    try { tokens = policy.shellWords(part); } catch {
      if (LOOKS_DANGEROUS.test(part)) found.push(item(/install|npm|pnpm|yarn|bun|msiexec/i.test(part) ? 'install' : /push|merge|repo/i.test(part) ? 'push' : 'delete', `${part} (could not parse the command)`));
      continue;
    }
    found.push(...classifyTokens(tokens, part, opts, depth));
  }
  return dedupe(found);
}

function classifyTokens(original, raw, opts, depth) {
  const out = [];
  const firstProg = progName(original[0]);
  // Installer files (setup.exe, x.msi, x.pkg) run directly or through a launcher.
  if (original.length) {
    const direct = INSTALLER_FILE.test(original[0]);
    const launched = (LAUNCHERS.has(firstProg) || firstProg === 'sudo') && original.slice(1).some((t) => INSTALLER_FILE.test(t.replace(/^['"]|['"]$/g, '')));
    if (direct || launched) out.push(item('install', raw));
  }
  const tokens = policy.stripPrefix(original);
  if (!tokens.length) return out;
  const prog = progName(tokens[0]);
  if (DELETE_PROGS.has(prog) && !tokens.slice(1).some((t) => t === '--help' || t === '-?' || t === '/?')) out.push(item('delete', raw));
  if (prog === 'find' && tokens.some((t) => t === '-delete')) out.push(item('delete', raw));
  if (prog === 'find') {
    const ex = tokens.findIndex((t) => t === '-exec' || t === '-execdir' || t === '-ok');
    if (ex >= 0) out.push(...classifyTokens(tokens.slice(ex + 1).filter((t) => t !== '{}' && t !== ';' && t !== '+' && t !== '\\;'), raw, opts, depth + 1));
  }
  if (prog === 'rsync' && tokens.some((t) => /^--delete/.test(t) || t === '--remove-source-files')) out.push(item('delete', raw));
  if (prog === 'robocopy' && tokens.some((t) => /^\/(?:mir|purge|move|mov)$/i.test(t))) out.push(item('delete', raw));
  if (prog === 'git') out.push(...gitItems(tokens, raw));
  if (prog === 'gh') out.push(...ghItems(tokens, raw));
  out.push(...installItems(prog, tokens, raw));
  // python -m pip install x / py -m pip install x / python -m ensurepip
  if (INTERPRETERS.has(prog)) {
    const m = tokens.findIndex((t) => t === '-m');
    if (m > 0 && tokens[m + 1]) {
      const mod = tokens[m + 1].toLowerCase();
      if (mod === 'pip' || mod === 'pipx' || mod === 'uv' || mod === 'ensurepip') out.push(...installItems(mod === 'ensurepip' ? 'msiexec' : mod, tokens.slice(m + 1), raw));
    }
    if (PROGRAMMATIC_DELETE.test(tokens.slice(1).join(' '))) out.push(item('delete', raw));
    // Shell commands inside the script text (subprocess / execSync / os.system strings).
    if (depth < 4) {
      for (const tok of tokens.slice(1)) {
        for (const m of tok.matchAll(/(['"`])((?:(?!\1).){2,})\1/g)) out.push(...classifyCommand(m[2], opts, depth + 1));
      }
    }
  }
  // Nested shells: bash -c "...", powershell -Command "...", -EncodedCommand, cmd /c ..., ssh host cmd, wsl cmd.
  if (SHELLS.has(prog) && depth < 4) {
    const rest = tokens.slice(1);
    const enc = rest.findIndex((t) => /^-(?:e|ec|enc|encodedcommand)$/i.test(t));
    if (enc >= 0 && rest[enc + 1]) {
      let decoded = '';
      try { decoded = Buffer.from(rest[enc + 1], 'base64').toString('utf16le'); } catch { decoded = ''; }
      out.push(...classifyCommand(decoded, opts, depth + 1));
    }
    const inner = rest.filter((t, i) => !(i > 0 && /^-(?:e|ec|enc|encodedcommand)$/i.test(rest[i - 1])) && !/^-(?:c|lc|ic|command|noprofile|noninteractive|nologo|executionpolicy|e|ec|enc|encodedcommand)$/i.test(t) && !/^\/[a-z]$/i.test(t) && !/^(?:bypass|unrestricted|remotesigned)$/i.test(t));
    out.push(...classifyCommand(inner.join(' '), opts, depth + 1));
    for (const tok of rest) if (/[\s;|&]/.test(tok)) out.push(...classifyCommand(tok, opts, depth + 1));
    if (['ssh', 'wsl', 'su', 'runuser'].includes(prog)) {
      // ssh host rm -rf x / wsl -d Ubuntu npm i: the remote/inner command starts somewhere after the options.
      for (let i = 1; i < rest.length; i += 1) {
        const hits = classifyTokens(rest.slice(i), rest.slice(i).join(' '), opts, depth + 1);
        if (hits.length) { out.push(...hits); break; }
      }
    }
    const file = rest.findIndex((t) => /^-(?:file|f)$/i.test(t));
    if (file >= 0 && rest[file + 1]) out.push(...scriptItems(rest[file + 1], opts, depth));
    else { const script = rest.find((t) => SCRIPT_FILE.test(t)); if (script) out.push(...scriptItems(script, opts, depth)); }
  } else if (SCRIPT_FILE.test(tokens[0])) {
    out.push(...scriptItems(tokens[0], opts, depth)); // ./cleanup.sh, .\setup.ps1, build.cmd
  }
  return out;
}

/** Look inside a local shell script the command runs (best effort; an unreadable script is not gated). */
function scriptItems(file, opts, depth) {
  if (typeof opts.readScript !== 'function' || depth >= 4) return [];
  let body = null;
  try { body = opts.readScript(String(file)); } catch { body = null; }
  if (typeof body !== 'string' || !body) return [];
  return classifyCommand(body.slice(0, 256 * 1024), opts, depth + 1).map((hit) => ({ ...hit, what: short(`${hit.what} (in ${path.basename(String(file))})`), relay: false }));
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.kind}\u0000${it.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** Gated items for one node tool call. Command tools are classified by their text; delete-like tool names always ask. */
function classifyToolCall(tool, args = {}, opts = {}) {
  const name = String(tool || '');
  const out = [];
  if (/(?:^|_)(?:delete|remove|rm|unlink|rmdir|trash)(?:_|$)/i.test(name)) out.push(item('delete', `${name} ${String(args && (args.path || args.root) || '')}`.trim()));
  if (/(?:^|_)(?:install|push)(?:_|$)/i.test(name)) out.push(item(/push/i.test(name) ? 'push' : 'install', name));
  const text = opts.text !== undefined ? String(opts.text) : policy.commandTextFor(name, args);
  out.push(...classifyCommand(text, opts));
  // Typed into a terminal session, the line may go to a REPL (python, node) rather than a shell.
  if (name === 'send_input' && PROGRAMMATIC_DELETE.test(text) && !out.some((i) => i.kind === 'delete')) out.push(item('delete', text));
  return dedupe(out);
}

/** "delete files: rm -rf build; install software: npm install x" */
function describe(items) {
  const byKind = new Map();
  for (const it of items) {
    if (!byKind.has(it.kind)) byKind.set(it.kind, []);
    byKind.get(it.kind).push(it.what);
  }
  return [...byKind].map(([kind, whats]) => `${KIND_WORDS[kind] || kind}: ${[...new Set(whats)].join('; ')}`).join(' | ');
}

/** Reads a script for classifyCommand relative to cwd/home; small files only. */
function scriptReader({ cwd, home = os.homedir(), fsImpl = fs } = {}) {
  return (file) => {
    let p = String(file).replace(/^['"]|['"]$/g, '');
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2));
    if (!path.isAbsolute(p)) p = path.resolve(cwd || home, p);
    const st = fsImpl.statSync(p);
    if (!st.isFile() || st.size > 256 * 1024) return null;
    return fsImpl.readFileSync(p, 'utf8');
  };
}

/**
 * createApprovalGate({ enabled, ask, timeoutMs, audit, computerName })
 *  - enabled(): the per-computer setting "Ask before deletes, pushes and installs" (default on)
 *  - ask({ agent, computer, summary, items, tool, command, signal, timeoutMs }) -> 'allow' | 'deny'
 *    (anything but 'allow' / true denies; the signal aborts at the timeout)
 * gate.check({ tool, args, text, agent, cwd }) resolves when allowed (or nothing is gated) and
 * throws an Error with a message for the agent when denied or unanswered.
 */
function createApprovalGate({
  enabled = () => true,
  ask = null,
  timeoutMs = APPROVAL_TIMEOUT_MS,
  audit = () => {},
  computerName = () => os.hostname(),
  home = os.homedir(),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  async function decide(request) {
    if (typeof ask !== 'function') return 'unavailable';
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs); });
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => ask({ ...request, signal: controller.signal, timeoutMs })).then((a) => (a === true || a === 'allow' ? 'allow' : a === 'timeout' ? 'timeout' : 'deny'), () => 'error'),
        timeout,
      ]);
      return answer;
    } finally { clearTimeout(timer); }
  }

  async function check({ tool, args = {}, text, agent = '', cwd } = {}) {
    let on = true;
    try { on = enabled() !== false; } catch { on = true; }
    if (!on) return { asked: false, items: [] };
    let items = classifyToolCall(tool, args, { text, readScript: scriptReader({ cwd, home }) });
    // A push the relay already put to Hayden (and he allowed) carries its stamp: not asked twice.
    if (policy.hasPushApproval(args)) items = items.filter((it) => !(it.kind === 'push' && it.relay));
    if (!items.length) return { asked: false, items: [] };
    const who = String(agent || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
    const computer = (() => { try { return computerName(); } catch { return os.hostname(); } })();
    const summary = describe(items);
    const command = String(text !== undefined ? text : policy.commandTextFor(tool, args)).slice(0, 2000);
    const started = now();
    const outcome = await decide({ agent: who, computer, summary, items, tool, command });
    const allowed = outcome === 'allow';
    const note = allowed ? 'allowed' : outcome === 'timeout' ? 'no answer (timed out)' : outcome === 'unavailable' ? 'could not ask' : outcome === 'error' ? 'prompt failed' : 'denied';
    try {
      audit({
        time: new Date(started).toISOString(),
        tool: 'approval',
        args: { for: String(tool).slice(0, 40), kinds: [...new Set(items.map((i) => i.kind))], summary: summary.slice(0, 300), ...(who ? { agent: who } : {}) },
        ok: allowed,
        note,
        by: outcome === 'allow' || outcome === 'deny' ? 'person' : 'timeout',
        ms: now() - started,
      });
    } catch { /* auditing never breaks a call */ }
    log(`intelio-node approval tool=${tool} kinds=${items.map((i) => i.kind).join(',')} outcome=${note}`);
    if (allowed) return { asked: true, allowed: true, items };
    const verb = outcome === 'deny' ? 'Hayden denied' : `Hayden did not approve (${note})`;
    const error = new Error(`${verb}: ${summary} on ${computer}. Nothing was run. Do not try it another way; tell him what you wanted to do and why, and let him run it or approve it next time.`);
    error.approval = { outcome, items };
    throw error;
  }

  return { check, classify: classifyToolCall };
}

module.exports = { classifyCommand, classifyToolCall, createApprovalGate, describe, scriptReader, APPROVAL_TIMEOUT_MS, KIND_WORDS };
