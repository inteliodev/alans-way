'use strict';
/**
 * intelio node wire protocol and tool catalogue (contract v1, docs/intelio-node.md).
 * Shared by the desktop node and the VPS relay so both sides agree on names,
 * schemas, limits and the audit summary. Stdlib only.
 */

const PROTOCOL = 1;
const PING_MS = 25000;
const STALE_MS = 60000;
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const LIMITS = Object.freeze({
  listDirEntries: 2000,
  readTextBytes: 1024 * 1024,
  readBase64Bytes: 10 * 1024 * 1024,
  writeBytes: 10 * 1024 * 1024,
  searchDefault: 200,
  searchMax: 2000,
  searchFileBytes: 2 * 1024 * 1024,
  searchLineChars: 300,
  searchDefaultS: 60,
  searchMaxS: 300,
  runDefaultS: 120,
  runMaxS: 1800,
  runOutputBytes: 200 * 1024,
  // Stage 2: persistent terminal sessions (sessions.cjs).
  sessionMax: 8,
  sessionIdleMs: 2 * 60 * 60 * 1000,
  sessionBufferBytes: 1024 * 1024,
  sessionReadDefaultBytes: 64 * 1024,
  sessionReadMaxBytes: 1024 * 1024,
  sessionWaitDefaultMs: 2000,
  sessionWaitMaxMs: 30000,
  sessionInputChars: 64 * 1024,
});

const computerArg = { type: 'string', description: 'Computer name or id (case-insensitive). See list_computers.' };
const sessionArg = { type: 'string', description: 'session_id from start_session (see list_sessions).' };
const KEY_NAMES = ['ctrl-c', 'ctrl-d', 'esc', 'tab', 'up', 'down', 'left', 'right', 'enter', 'backspace'];

const TOOLS = Object.freeze([
  {
    name: 'list_computers',
    description: 'List the computers you can use: the person\'s enrolled computers and "cloud" (the intelio VPS itself). Each row: name, id, os, user, online, last_seen, version; paused means the person turned it off for agents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'computer_info',
    description: 'OS, arch, hostname, signed-in user, home folder, drives/volumes and shell of one computer.',
    inputSchema: { type: 'object', properties: { computer: computerArg }, required: ['computer'] },
  },
  {
    name: 'list_dir',
    description: 'List a folder on a computer (max 2000 entries). Paths are absolute or start with ~.',
    inputSchema: {
      type: 'object',
      properties: { computer: computerArg, path: { type: 'string' }, show_hidden: { type: 'boolean' } },
      required: ['computer', 'path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file on a computer. text returns up to 1 MB, base64 up to 10 MB; offset/limit are bytes. Secrets (SSH private keys, credential and cookie stores, .env/auth files) are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        encoding: { type: 'string', enum: ['text', 'base64'] },
      },
      required: ['computer', 'path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a file on a computer. mode create|overwrite|append (default overwrite); make_dirs creates parent folders.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['text', 'base64'] },
        mode: { type: 'string', enum: ['create', 'overwrite', 'append'] },
        make_dirs: { type: 'boolean' },
      },
      required: ['computer', 'path', 'content'],
    },
  },
  {
    name: 'search_files',
    description: 'Search under a folder on a computer. pattern is a regular expression matched against file lines; name_glob filters file names (e.g. *.md). Skips node_modules and .git unless the root is inside them.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        root: { type: 'string' },
        pattern: { type: 'string' },
        name_glob: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: LIMITS.searchMax },
        timeout_s: { type: 'integer', minimum: 1, maximum: LIMITS.searchMaxS, description: 'Time budget (default 60 s). A search that runs out returns partial results.' },
      },
      required: ['computer', 'root'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command on a computer as the signed-in user (Windows: PowerShell; macOS/Linux: login shell). Never elevates: sudo/runas/admin prompts are refused unless the person at that computer approves. A push (git push, gh pr merge, gh repo sync ...) first asks Hayden; if he does not allow it, do not retry another way. Secrets (SSH private keys, credential stores, .env/auth files) are refused. stdout/stderr max 200 KB each.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout_s: { type: 'integer', minimum: 1, maximum: LIMITS.runMaxS },
        shell: { type: 'string', description: 'Optional: powershell, pwsh, cmd, bash, zsh or sh.' },
      },
      required: ['computer', 'command'],
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a display of a computer as PNG.',
    inputSchema: {
      type: 'object',
      properties: { computer: computerArg, display: { type: 'integer', minimum: 1, description: '1-based display number (default 1).' } },
      required: ['computer'],
    },
  },
  {
    name: 'start_session',
    description: 'Start a persistent interactive terminal session on a computer (a real PTY when available) that keeps running across calls: Claude Code (command "claude"), Codex ("codex"), a REPL, or the login shell when command is omitted (Windows: PowerShell; macOS/Linux: $SHELL). Runs as the signed-in user; elevation is refused unless the person there approves. Max 8 sessions per computer; sessions idle for 2 h are killed. For one-shot work prefer run_command with `claude -p "..."` or `codex exec "..."`.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        command: { type: 'string', description: 'Program and arguments, run through the shell. Omit for the login shell.' },
        cwd: { type: 'string', description: 'Absolute or ~ path (default: home).' },
        cols: { type: 'integer', minimum: 20, maximum: 500, description: 'Terminal width (default 120).' },
        rows: { type: 'integer', minimum: 5, maximum: 200, description: 'Terminal height (default 40).' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
      },
      required: ['computer'],
    },
  },
  {
    name: 'send_input',
    description: 'Type into a terminal session: text first, then the named keys, then Enter (enter defaults to true when text is given, false for keys-only calls). Keys: ctrl-c, ctrl-d, esc, tab, up, down, left, right, enter, backspace (and ctrl-a to ctrl-z). Follow with read_output.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        session_id: sessionArg,
        text: { type: 'string' },
        enter: { type: 'boolean' },
        keys: { type: 'array', items: { type: 'string' }, description: `Named keys: ${KEY_NAMES.join(', ')}.` },
      },
      required: ['computer', 'session_id'],
    },
  },
  {
    name: 'read_output',
    description: 'Read new terminal output. Waits up to wait_ms (default 2000, max 30000) and returns as soon as output arrives. Pass the returned cursor back as since to continue (omitted since continues after the last read). ANSI-stripped unless raw is true; max_bytes default 64 KB. Returns JSON (cursor, exited, exit_code, truncated, more) followed by the output text.',
    inputSchema: {
      type: 'object',
      properties: {
        computer: computerArg,
        session_id: sessionArg,
        since: { type: 'integer', minimum: 0, description: 'Cursor from a previous read_output (bytes into the session output).' },
        wait_ms: { type: 'integer', minimum: 0, maximum: LIMITS.sessionWaitMaxMs },
        max_bytes: { type: 'integer', minimum: 1, maximum: LIMITS.sessionReadMaxBytes },
        raw: { type: 'boolean', description: 'Keep terminal escape sequences.' },
      },
      required: ['computer', 'session_id'],
    },
  },
  {
    name: 'stop_session',
    description: 'Stop a terminal session (hang up, then kill after 3 s; force kills at once) and forget it. Returns exit_code.',
    inputSchema: {
      type: 'object',
      properties: { computer: computerArg, session_id: sessionArg, force: { type: 'boolean' } },
      required: ['computer', 'session_id'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List the terminal sessions on a computer: id, command, cwd, started, idle_s, exited.',
    inputSchema: { type: 'object', properties: { computer: computerArg }, required: ['computer'] },
  },
]);

const TOOL_NAMES = Object.freeze(TOOLS.map((tool) => tool.name));
const NODE_TOOLS = Object.freeze(TOOL_NAMES.filter((name) => name !== 'list_computers'));

/**
 * Relay-side timeout for one call: timeout_s (run_command, default 120) + 10 s;
 * read_output: wait_ms (default 2 s, max 30 s) + 10 s.
 */
function callTimeoutMs(tool, args = {}) {
  if (tool === 'read_output') {
    const wait = Number(args && args.wait_ms);
    const ms = Number.isFinite(wait) && wait >= 0 ? Math.min(wait, LIMITS.sessionWaitMaxMs) : LIMITS.sessionWaitDefaultMs;
    return Math.floor(ms) + 10000;
  }
  let seconds = LIMITS.runDefaultS;
  const asked = Number(args && args.timeout_s);
  if (tool === 'run_command' && Number.isFinite(asked) && asked > 0) seconds = Math.min(asked, LIMITS.runMaxS);
  if (tool === 'search_files') seconds = Number.isFinite(asked) && asked > 0 ? Math.min(asked, LIMITS.searchMaxS) : LIMITS.searchDefaultS;
  return (seconds + 10) * 1000;
}

function parseFrame(text) {
  let msg;
  try { msg = JSON.parse(String(text)); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return null;
  return msg;
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Validates and trims the node's hello. Returns null when malformed. */
function normalizeHello(msg) {
  if (!msg || msg.type !== 'hello') return null;
  const name = cleanText(msg.name, 64);
  if (!name) return null;
  const hello = {
    type: 'hello',
    name,
    os: cleanText(msg.os, 32),
    arch: cleanText(msg.arch, 16),
    user: cleanText(msg.user, 64),
    version: cleanText(msg.version, 32),
  };
  if (msg.device_id != null) {
    const id = String(msg.device_id);
    if (!/^[a-z0-9_-]{4,64}$/i.test(id)) return null;
    hello.device_id = id;
    hello.device_secret = String(msg.device_secret || '').slice(0, 256);
  }
  return hello;
}

const frames = {
  hello: (info, identity) => ({
    type: 'hello',
    ...(identity && identity.device_id ? { device_id: identity.device_id, device_secret: identity.device_secret } : {}),
    name: info.name, os: info.os, arch: info.arch, user: info.user, version: info.version,
  }),
  welcome: (deviceId, secret) => ({ type: 'welcome', device_id: deviceId, ...(secret ? { device_secret: secret } : {}) }),
  refused: (reason, code = '') => ({ type: 'refused', reason: String(reason), ...(code ? { code } : {}) }),
  call: (id, tool, args) => ({ type: 'call', id, tool, args: args || {} }),
  ok: (id, content) => ({ type: 'result', id, ok: true, content }),
  fail: (id, error) => ({ type: 'result', id, ok: false, error: String(error || 'Failed.').slice(0, 4000) }),
  ping: () => ({ type: 'ping', t: Date.now() }),
  pong: (t) => ({ type: 'pong', t }),
};

function textContent(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/** Bytes of a result's content, for audit lines. */
function contentSize(content) {
  let size = 0;
  for (const item of Array.isArray(content) ? content : []) {
    if (item && typeof item.text === 'string') size += Buffer.byteLength(item.text);
    if (item && typeof item.data === 'string') size += Math.floor(item.data.length * 3 / 4);
  }
  return size;
}

/**
 * Masks secret-looking tokens (API keys, bearer tokens, password=..., long
 * random strings) before a preview of typed text reaches an audit line.
 */
function maskSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/(\bBearer\s+)\S+/gi, '$1***')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|credential)s?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(--?(?:password|passwd|token|secret|api[_-]?key|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 3)}***`)
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza|ya29)[A-Za-z0-9_.-]{8,}/g, (m) => `${m.slice(0, 4)}***`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, 'eyJ***')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '***' : m));
}

/** First 80 characters of typed text, secrets masked, control characters shown as spaces. */
function inputPreview(text) {
  return maskSecrets(String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 80);
}

/**
 * Audit summary of arguments: never file contents, never full commands on the relay.
 * scope 'node' keeps the command (truncated) in the computer's own audit file;
 * scope 'relay' keeps only the program name and the command length.
 */
function summarizeArgs(tool, args = {}, scope = 'relay') {
  const a = args && typeof args === 'object' ? args : {};
  const out = {};
  for (const key of ['path', 'root', 'cwd', 'name_glob', 'encoding', 'mode', 'display', 'offset', 'limit', 'max_results', 'timeout_s', 'shell', 'show_hidden', 'make_dirs', 'session_id', 'cols', 'rows', 'since', 'wait_ms', 'max_bytes', 'raw', 'enter', 'force']) {
    if (a[key] !== undefined && a[key] !== null && a[key] !== '') out[key] = typeof a[key] === 'string' ? a[key].slice(0, 300) : a[key];
  }
  if (typeof a.pattern === 'string') out.pattern = a.pattern.slice(0, 120);
  if (typeof a.content === 'string') out.content_chars = a.content.length;
  if (tool === 'run_command' && typeof a.command === 'string') {
    if (scope === 'node') out.command = a.command.slice(0, 300);
    else {
      out.program = (a.command.trim().split(/\s+/)[0] || '').replace(/[^\w.\-\\/:]/g, '').slice(0, 60);
      out.command_chars = a.command.length;
    }
  }
  if (tool === 'start_session' && typeof a.command === 'string' && a.command.trim()) {
    out.program = (a.command.trim().split(/\s+/)[0] || '').replace(/[^\w.\-\\/:]/g, '').slice(0, 60);
    out.command_chars = a.command.length;
    if (scope === 'node') out.command_preview = inputPreview(a.command);
  }
  if (tool === 'start_session' && a.env && typeof a.env === 'object') out.env_keys = Object.keys(a.env).slice(0, 64).map((k) => String(k).slice(0, 64));
  if (tool === 'send_input') {
    if (typeof a.text === 'string') {
      out.text_chars = a.text.length;
      if (scope === 'node' && a.text) out.text_preview = inputPreview(a.text);
    }
    if (Array.isArray(a.keys)) out.keys = a.keys.slice(0, 16).map((k) => String(k).slice(0, 20));
  }
  return out;
}

module.exports = {
  PROTOCOL,
  PING_MS,
  STALE_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
  MAX_FRAME_BYTES,
  LIMITS,
  TOOLS,
  TOOL_NAMES,
  NODE_TOOLS,
  callTimeoutMs,
  parseFrame,
  normalizeHello,
  frames,
  textContent,
  contentSize,
  summarizeArgs,
  maskSecrets,
  inputPreview,
};
