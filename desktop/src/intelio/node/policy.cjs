'use strict';
/**
 * intelio computers policy (Hayden, Oct 8 2026: "It can read and drive on
 * computers yes anything push is an approval").
 *
 *  - Reads, file changes, commands and driving the computer run without asking.
 *  - A push (git push, gh pr merge, gh repo sync, gh api repository writes ...)
 *    needs Hayden's OK. The relay asks him through Hermes (MCP elicitation) and
 *    stamps the call; the computer refuses a push without that stamp.
 *  - Secrets are never read or written by an agent: SSH private keys, GnuPG,
 *    browser cookie and password stores, keychains, cloud/git credentials,
 *    Hermes .env/auth.json, intelio's own tokens, /etc/shadow and friends.
 *
 * Push detection mirrors alans-way-agents push-approval/push_guard.py
 * (find_pushes): quote-aware split into simple commands, wrappers and env
 * assignments stripped, `sh -c '...'` / ssh remote commands searched too. It
 * errs toward asking: text that cannot be parsed but looks like a push counts.
 *
 * Protected paths: the containment check (raw path and its realpath against a
 * list of protected roots) and the starting list are adapted from Herald OS,
 * plugins/herald-os-bridge/bridge/permissions.py (BUILTIN_PROTECTED,
 * protected_root). MIT License, Copyright (c) 2026 Luke The Dev (@iamlukethedev).
 * Changes here: secrets only (system folders such as /usr or /etc are not
 * protected; agents may act there), per-file rules, public SSH files stay
 * readable, Windows and browser stores added.
 */
const os = require('node:os');
const path = require('node:path');

// --- push detection ---------------------------------------------------------------------------

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf',
  'timeout', 'xargs', 'then', 'do', 'else', '!', 'eval', 'chronic', 'unbuffer', 'caffeinate', '&', 'start-process', 'invoke-expression', 'iex', 'call']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'wsl']);
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix',
  '--config-env', '--list-cmds', '--attr-source']);
const GH_API_PUSH_PATH = /\/git\/(?:refs|commits|trees|blobs|tags)\b|\/merges\b|\/merge-upstream\b|\/pulls\/[^/\s]+\/merge\b|\/contents\/|\/releases\b/i;
const GH_API_WRITE_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);
const SEPARATOR = /^(?:\|\||&&|\$\(|[;&|\n\r(){}`])/;
const LOOKS_LIKE_PUSH = /\bgit(?:\.exe)?\b[^;&|\n]*\bpush\b|\bgh(?:\.exe)?\s+(?:pr\s+merge|repo\s+sync)\b/i;

/** Shell text -> simple-command strings (separators outside quotes; $( and ` split even inside "..."). */
function splitSimpleCommands(text) {
  const out = [];
  let buf = '';
  let quote = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quote === "'") { buf += ch; if (ch === "'") quote = null; i += 1; continue; }
    if (ch === '\\' && i + 1 < text.length) { buf += text.slice(i, i + 2); i += 2; continue; }
    if (ch === "'" || ch === '"') {
      if (quote === ch) quote = null; else if (quote === null) quote = ch;
      buf += ch; i += 1; continue;
    }
    const m = SEPARATOR.exec(text.slice(i, i + 2));
    if (m && (quote === null || m[0] === '$(' || m[0] === '`')) { out.push(buf); buf = ''; i += m[0].length; continue; }
    buf += ch; i += 1;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** POSIX-ish word split (like shlex.split). Throws on an unterminated quote. */
function shellWords(text) {
  const words = [];
  let word = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) { word += text[i + 1]; i += 1; continue; }
      word += ch; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { word += text[i + 1]; has = true; i += 1; continue; }
    if (/\s/.test(ch)) { if (has || word) { words.push(word); word = ''; has = false; } continue; }
    word += ch; has = true;
  }
  if (quote) throw new Error('unterminated quote');
  if (has || word) words.push(word);
  return words;
}

function baseName(token) {
  let b = String(token).split(/[\\/]/).pop().toLowerCase();
  if (b.endsWith('.exe')) b = b.slice(0, -4);
  return b;
}

function stripPrefix(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || /^\$env:[A-Za-z_][A-Za-z0-9_]*=/i.test(tok)) { i += 1; continue; }
    if (WRAPPERS.has(baseName(tok))) {
      i += 1;
      while (i < tokens.length && (tokens[i].startsWith('-') || /^\d+[smhd]?$/.test(tokens[i]))) {
        if (['-u', '-g', '-n', '-s', '-k', '-C', '--user', '--group', '--signal', '-FilePath', '-ArgumentList'].includes(tokens[i])) i += 1;
        i += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function gitPush(tokens) {
  let i = 1;
  let tamper = false;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i];
    if (opt === '-c' && i + 1 < tokens.length && tokens[i + 1].toLowerCase().startsWith('core.hookspath')) tamper = true;
    if (!opt.includes('=') && GIT_OPTS_WITH_VALUE.has(opt)) i += 1;
    i += 1;
  }
  if (i >= tokens.length) return null;
  const sub = tokens[i];
  const rest = tokens.slice(i + 1);
  if (sub === 'push') return `git push${tamper || rest.includes('--no-verify') ? ' (skipping hooks)' : ''}`;
  if ((sub === 'subtree' || sub === 'lfs') && rest[0] === 'push') return `git ${sub} push`;
  return null;
}

function ghPush(tokens) {
  const words = [];
  for (let i = 1; i < tokens.length; i += 1) {
    if (['-R', '--repo', '--hostname'].includes(tokens[i])) { i += 1; continue; }
    words.push(tokens[i]);
  }
  if (words.length < 2 && words[0] !== 'api') return null;
  const [group, sub] = [words[0] || '', words[1] || ''];
  if (group === 'pr' && sub === 'merge') return 'gh pr merge';
  if (group === 'repo' && sub === 'sync') return 'gh repo sync';
  if (group === 'repo' && sub === 'create' && words.includes('--push')) return 'gh repo create --push';
  if (group === 'release' && sub === 'create') return 'gh release create (creates a tag on GitHub)';
  if (group === 'api') {
    let method = 'GET';
    words.forEach((t, idx) => {
      if ((t === '-X' || t === '--method') && idx + 1 < words.length) method = words[idx + 1].toUpperCase();
      else if (t.startsWith('--method=')) method = t.split('=')[1].toUpperCase();
      else if (t.startsWith('-X') && t.length > 2) method = t.slice(2).toUpperCase();
    });
    if (method === 'GET' && words.some((t) => GH_API_WRITE_FLAGS.has(t) || /^--(?:field|raw-field|input)=/.test(t))) method = 'POST';
    if (method !== 'GET' && words.slice(1).some((t) => GH_API_PUSH_PATH.test(t))) return `gh api ${method} (writes to a repository)`;
  }
  return null;
}

function pushesInTokens(tokens, depth) {
  tokens = stripPrefix(tokens);
  if (!tokens.length) return [];
  const prog = baseName(tokens[0]);
  if (prog === 'git') { const hit = gitPush(tokens); return hit ? [hit] : []; }
  if (prog === 'gh') { const hit = ghPush(tokens); return hit ? [hit] : []; }
  if (prog === 'hub' && tokens[1] === 'push') return ['hub push'];
  if (depth < 4 && (SHELLS.has(prog) || ['ssh', 'su', 'runuser', 'script'].includes(prog))) {
    const found = [];
    for (const tok of tokens.slice(1)) {
      if (/[\s;]/.test(tok) || tok === 'push') found.push(...findPushes(tok, depth + 1));
    }
    if (prog === 'ssh' || prog === 'wsl') {
      const start = tokens.findIndex((t, idx) => idx > 0 && ['git', 'gh'].includes(baseName(t)));
      if (start > 0) found.push(...pushesInTokens(tokens.slice(start), depth + 1));
    }
    return found;
  }
  return [];
}

/** Descriptions of every push in shell text ([] when there is none). */
function findPushes(command, depth = 0) {
  const text = String(command == null ? '' : command);
  if (!text.trim()) return [];
  const found = [];
  for (const part of splitSimpleCommands(text)) {
    let tokens;
    try { tokens = shellWords(part); } catch {
      if (LOOKS_LIKE_PUSH.test(part)) found.push('git push (could not parse the command)');
      continue;
    }
    found.push(...pushesInTokens(tokens, depth));
  }
  return found;
}

/**
 * Text that a tool call would run, for push detection. send_input text is
 * typed into a live shell, so its lines are commands too.
 */
function commandTextFor(tool, args = {}) {
  if (!args || typeof args !== 'object') return '';
  if (tool === 'run_command' || tool === 'start_session') return String(args.command || '');
  if (tool === 'send_input') return String(args.data ?? args.input ?? args.text ?? '');
  return '';
}

/** The relay's stamp on an approved call. Only the relay can set it: it drops any agent-supplied value. */
function hasPushApproval(args) {
  const stamp = args && args.push_approval;
  return Boolean(stamp && typeof stamp === 'object' && typeof stamp.id === 'string' && /^[0-9a-f]{16,64}$/.test(stamp.id));
}

const PUSH_REFUSED = 'Refused: this pushes (%s). A push needs Hayden\'s approval, and this request did not carry it. Ask him; do not retry another way.';
function pushRefusal(pushes) { return PUSH_REFUSED.replace('%s', [...new Set(pushes)].join(', ')); }

// --- protected paths --------------------------------------------------------------------------

const SSH_PUBLIC = /^(?:[^/\\]+\.pub|known_hosts(?:\.old)?|config|authorized_keys2?)$/i;
const SECRET_FILE_NAMES = new Set(['Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal', 'Login Data For Account',
  'Web Data', 'key3.db', 'key4.db', 'logins.json', 'logins-backup.json', 'cookies.sqlite', 'cookies.sqlite-wal', 'signons.sqlite',
  'cert9.db', 'Local State']);

/**
 * Rules: { root, kind: 'dir'|'file', readable?(rel) }. A 'dir' root protects
 * everything under it. `readable` lets non-secret files under it be read
 * (never written).
 */
function protectedRules({ home = os.homedir(), platform = process.platform, env = process.env, hermesHome } = {}) {
  const h = (p) => path.join(home, p);
  const hh = hermesHome || String(env.HERMES_HOME || '').trim() || h('.hermes');
  const rules = [
    { root: h('.ssh'), kind: 'dir', readable: (rel) => SSH_PUBLIC.test(rel), why: 'SSH keys' },
    { root: h('.gnupg'), kind: 'dir', why: 'GnuPG keys' },
    { root: h('.password-store'), kind: 'dir', why: 'passwords' },
    { root: h('.local/share/keyrings'), kind: 'dir', why: 'the keyring' },
    { root: h('.aws/credentials'), kind: 'file', why: 'cloud credentials' },
    { root: h('.aws/sso/cache'), kind: 'dir', why: 'cloud credentials' },
    { root: h('.azure'), kind: 'dir', why: 'cloud credentials' },
    { root: h('.config/gcloud'), kind: 'dir', why: 'cloud credentials' },
    { root: h('.config/gh/hosts.yml'), kind: 'file', why: 'the GitHub login' },
    { root: h('.git-credentials'), kind: 'file', why: 'git credentials' },
    { root: h('.netrc'), kind: 'file', why: 'credentials' },
    { root: h('_netrc'), kind: 'file', why: 'credentials' },
    { root: h('.npmrc'), kind: 'file', why: 'a registry token' },
    { root: h('.pypirc'), kind: 'file', why: 'a registry token' },
    { root: h('.docker/config.json'), kind: 'file', why: 'registry credentials' },
    { root: h('.kube/config'), kind: 'file', why: 'cluster credentials' },
    { root: h('.claude/.credentials.json'), kind: 'file', why: 'the Claude login' },
    { root: h('.codex/auth.json'), kind: 'file', why: 'the Codex login' },
    { root: h('.config/intelio'), kind: 'dir', why: 'intelio tokens and the push guard' },
    { root: h('.local/state/intelio/push-grants'), kind: 'dir', why: 'push approvals' },
    { root: path.join(hh, '.env'), kind: 'file', why: 'Hermes secrets' },
    { root: path.join(hh, 'auth.json'), kind: 'file', why: 'Hermes logins' },
    { root: path.join(hh, 'profiles', '*', '.env'), kind: 'file', why: 'Hermes secrets' },
    { root: path.join(hh, 'profiles', '*', 'auth.json'), kind: 'file', why: 'Hermes logins' },
  ];
  if (platform === 'darwin') {
    rules.push(
      { root: h('Library/Keychains'), kind: 'dir', why: 'the keychain' },
      { root: '/Library/Keychains', kind: 'dir', why: 'the keychain' },
      { root: h('Library/Cookies'), kind: 'dir', why: 'cookies' },
      { root: '/private/etc/master.passwd', kind: 'file', why: 'password hashes' },
      { root: '/etc/master.passwd', kind: 'file', why: 'password hashes' },
      { root: '/var/db/dslocal', kind: 'dir', why: 'password hashes' },
      { root: '/private/var/db/dslocal', kind: 'dir', why: 'password hashes' },
    );
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || h('AppData/Roaming');
    const local = env.LOCALAPPDATA || h('AppData/Local');
    const windir = env.SystemRoot || env.windir || 'C:\\Windows';
    rules.push(
      { root: path.join(appData, 'Microsoft', 'Credentials'), kind: 'dir', why: 'Windows credentials' },
      { root: path.join(local, 'Microsoft', 'Credentials'), kind: 'dir', why: 'Windows credentials' },
      { root: path.join(appData, 'Microsoft', 'Protect'), kind: 'dir', why: 'Windows key material' },
      { root: path.join(appData, 'Microsoft', 'Vault'), kind: 'dir', why: 'the Windows vault' },
      { root: path.join(local, 'Microsoft', 'Vault'), kind: 'dir', why: 'the Windows vault' },
      { root: path.join(windir, 'System32', 'config'), kind: 'dir', why: 'the SAM and SECURITY hives' },
    );
  } else {
    rules.push(
      { root: '/etc/shadow', kind: 'file', why: 'password hashes' },
      { root: '/etc/shadow-', kind: 'file', why: 'password hashes' },
      { root: '/etc/gshadow', kind: 'file', why: 'password hashes' },
      { root: '/etc/gshadow-', kind: 'file', why: 'password hashes' },
      { root: '/etc/sudoers', kind: 'file', why: 'sudo rules' },
      { root: '/etc/sudoers.d', kind: 'dir', why: 'sudo rules' },
      { root: '/etc/ssl/private', kind: 'dir', why: 'TLS private keys' },
      { root: '/etc/ssh/ssh_host_*_key', kind: 'file', why: 'SSH host keys' },
      { root: '/root', kind: 'dir', why: 'the root account' },
    );
  }
  return rules;
}

/**
 * createProtector(opts).check(absPath, op) -> null | { root, why, text }.
 * op: 'read' | 'write' | 'search'. Listing a folder's names is allowed.
 */
function createProtector(opts = {}) {
  const platform = opts.platform || process.platform;
  const caseless = platform === 'win32' || platform === 'darwin';
  const sep = platform === 'win32' ? /[\\/]+/ : /\/+/;
  const norm = (p) => {
    let s = String(p || '');
    if (platform === 'win32') s = s.replace(/\//g, '\\');
    s = s.replace(/[\\/]+$/, '') || s;
    return caseless ? s.toLowerCase() : s;
  };
  const rules = protectedRules({ ...opts, platform }).map((r) => ({ ...r, parts: norm(r.root).split(sep) }));

  function segMatch(pattern, seg) {
    if (!pattern.includes('*')) return pattern === seg;
    const rx = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\/]*')}$`);
    return rx.test(seg);
  }

  /** Rule whose root is target or contains it; rel = rest of the path. */
  function match(target) {
    const parts = norm(target).split(sep);
    for (const rule of rules) {
      if (parts.length < rule.parts.length) continue;
      if (rule.kind === 'file' && parts.length !== rule.parts.length) continue;
      let ok = true;
      for (let i = 0; i < rule.parts.length; i += 1) if (!segMatch(rule.parts[i], parts[i])) { ok = false; break; }
      if (ok) return { rule, rel: parts.slice(rule.parts.length).join('/') };
    }
    return null;
  }

  function check(target, op = 'read') {
    if (!target) return null;
    const hit = match(target);
    if (hit) {
      if (op === 'read' && hit.rule.readable && hit.rel && hit.rule.readable(hit.rel)) return null;
      return { root: hit.rule.root, why: hit.rule.why, text: refusalText(hit.rule.why) };
    }
    const name = String(target).split(/[\\/]/).pop();
    if (SECRET_FILE_NAMES.has(name)) return { root: target, why: 'a browser cookie or password store', text: refusalText('a browser cookie or password store') };
    return null;
  }

  /** A folder search must not enter (or start in) a protected folder. */
  function blocksFolder(dir) {
    const hit = match(dir);
    return Boolean(hit && hit.rule.kind === 'dir');
  }

  /** Plain data for the search worker (it may only require node: builtins). Glob rules are post-filtered by check(). */
  function searchSkips() {
    const plain = rules.filter((r) => !r.root.includes('*'));
    return {
      dirs: plain.filter((r) => r.kind === 'dir').map((r) => norm(r.root)),
      files: plain.filter((r) => r.kind === 'file').map((r) => norm(r.root)),
      names: [...SECRET_FILE_NAMES],
    };
  }

  return { check, blocksFolder, searchSkips, rules };
}

function refusalText(why) {
  return `Refused: that is ${why}. intelio never lets agents read or change secrets on a computer. Ask the person to do it themselves.`;
}

/**
 * Best-effort: a command that names a protected path (cat ~/.ssh/id_ed25519,
 * cp ~/.hermes/.env /tmp). Not a sandbox: a script can still reach a secret
 * without naming it. `ssh -i KEY` / `-o IdentityFile=KEY` and ssh-add use a key
 * without showing it, so they are allowed.
 */
function commandSecretRefusal(command, { protector, home = os.homedir(), cwd = home, platform = process.platform } = {}) {
  if (!protector) return null;
  const expand = (tok) => {
    let t = tok.replace(/^\$\{?HOME\}?(?=$|[\\/])/, home).replace(/^%USERPROFILE%(?=$|[\\/])/i, home).replace(/^\$env:USERPROFILE(?=$|[\\/])/i, home);
    if (t === '~') t = home; else if (t.startsWith('~/') || t.startsWith('~\\')) t = path.join(home, t.slice(2));
    return t;
  };
  for (const part of splitSimpleCommands(String(command || ''))) {
    let tokens;
    try { tokens = shellWords(part); } catch { tokens = part.split(/\s+/); }
    const words = stripPrefix(tokens);
    const prog = words.length ? baseName(words[0]) : '';
    if (prog === 'ssh-add') continue;
    for (let i = 0; i < tokens.length; i += 1) {
      const prev = tokens[i - 1] || '';
      const redirected = /^\d?>>?/.test(tokens[i]) || /^\d?>>?$/.test(prev) || ['tee', 'dd'].includes(prog);
      const raw = tokens[i].replace(/^(?:\d?>>?|<)/, '').replace(/^of=/, '');
      if (['ssh', 'scp', 'sftp', 'rsync', 'git'].includes(prog) && (prev === '-i' || /^IdentityFile=/i.test(raw))) continue;
      const value = raw.includes('=') && !raw.startsWith('/') ? raw.slice(raw.indexOf('=') + 1) : raw;
      if (!/[\\/]|^~/.test(value)) continue;
      let candidate = expand(value);
      if (!path.isAbsolute(candidate)) {
        if (!/^\.{0,2}[\\/]|^\.[A-Za-z]/.test(value) && !value.includes('/')) continue;
        candidate = path.resolve(cwd, candidate);
      }
      const hit = protector.check(platform === 'win32' ? candidate : path.posix.normalize(candidate), redirected ? 'write' : 'read');
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = {
  findPushes,
  commandTextFor,
  hasPushApproval,
  pushRefusal,
  splitSimpleCommands,
  shellWords,
  protectedRules,
  createProtector,
  commandSecretRefusal,
  SECRET_FILE_NAMES,
};
