'use strict';
/**
 * Accounts per agent: what each Hermes profile is connected to, what is signed in, and which
 * account an agent or terminal should use. Runs in the PWA server as the same user as Hermes.
 *
 * Read-only by design. Status comes from safe signals only:
 *  - Hermes model sign-in: whether the profile (or shared) auth file EXISTS and its mtime, the
 *    model block of config.yaml (provider / model / base_url), and the last successful model
 *    call Hermes recorded in state.db. Auth files are never opened.
 *  - Claude Code: `claude auth status` (JSON; only loggedIn/authMethod/email/subscriptionType kept).
 *  - Codex CLI: `codex login status` (only the signed-in phrase is kept).
 *  - GitHub CLI: `gh auth status` (login names, active flag and scope names; token lines dropped).
 *  - Messaging: variable NAMES in the profile .env (values are discarded as they are read) and
 *    the gateway's own connection state for that platform.
 *  - MCP servers and plugins: names in config.yaml. Bot desktop: files on disk. Saved logins: a count.
 *
 * The only writes are intelio-owned: the assignment map (~/.config/intelio/accounts.json, 0600),
 * new account config dirs (~/.claude-<name>, ~/.codex-<name>, ~/.config/gh-<name>), the
 * activity log, and a tmux window for a sign-in the user started. Hermes config is never written.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { appendActivity, redact } = require('../../desktop/src/intelio/activity-log.cjs');

const TOOLS = ['claude', 'codex', 'github'];
const PROFILE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const EMAIL = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TMUX_SESSION = 'intelio-accounts';
const CODE_RE = /^[A-Za-z0-9#_\-.~+/=:]{4,2048}$/;
const SIGNIN_HOSTS = {
  claude: ['claude.ai', 'claude.com', 'console.anthropic.com', 'platform.claude.com', 'anthropic.com'],
  codex: ['auth.openai.com', 'chatgpt.com'],
  github: ['github.com'],
};
const TOOL_LABEL = { claude: 'Claude Code', codex: 'Codex CLI', github: 'GitHub' };
const PROVIDERS = {
  'openai-codex': { label: 'ChatGPT (Codex)', plan: 'ChatGPT subscription' },
  'openai': { label: 'OpenAI', plan: '' },
  'anthropic': { label: 'Claude', plan: '' },
  'claude-code': { label: 'Claude Code', plan: 'Claude subscription' },
  'openrouter': { label: 'OpenRouter', plan: '' },
  'nous': { label: 'Nous Portal', plan: '' },
};
const CHANNELS = [
  { id: 'telegram', label: 'Telegram', vars: /^TELEGRAM_/, platform: 'telegram' },
  { id: 'sms', label: 'SMS (Twilio)', vars: /^(TWILIO_|SMS_)/, platform: 'sms' },
  { id: 'imessage', label: 'iMessage (Photon)', vars: /^PHOTON_/, platform: 'photon' },
  { id: 'slack', label: 'Slack', vars: /^SLACK_/, platform: 'slack' },
  { id: 'discord', label: 'Discord', vars: /^DISCORD_/, platform: 'discord' },
  { id: 'email', label: 'Email', vars: /^(EMAIL_|SMTP_|IMAP_)/, platform: 'email' },
  { id: 'whatsapp', label: 'WhatsApp', vars: /^WHATSAPP_/, platform: 'whatsapp' },
];

/* ---------- small helpers ---------- */

function defaultRun(file, args, { env, timeoutMs = 15000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: error?.code === 'ENOENT' });
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

function slugOk(value, pattern) {
  const text = String(value || '').trim().toLowerCase();
  return pattern.test(text) ? text : '';
}

function statOf(file, fsImpl) {
  try { return fsImpl.statSync(file); } catch { return null; }
}

function hostOf(url) {
  try { return url ? new URL(url).host : ''; } catch { return ''; }
}

function isoOrNull(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** First JSON object in a command's output. */
function firstJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/* ---------- status parsers (pure, unit-tested) ---------- */

function parseClaudeStatus(result) {
  const json = firstJson(result?.stdout);
  if (!json) return { signedIn: false, error: result?.missing ? 'Claude Code is not installed.' : '' };
  const email = EMAIL.test(String(json.email || '')) ? String(json.email) : '';
  const plan = String(json.subscriptionType || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const method = String(json.authMethod || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
  return { signedIn: json.loggedIn === true, email, plan, method };
}

function parseCodexStatus(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (result?.missing) return { signedIn: false, error: 'Codex CLI is not installed.' };
  if (/not logged in|not signed in|no credentials/i.test(text)) return { signedIn: false };
  if (/logged in/i.test(text)) {
    const method = /chatgpt/i.test(text) ? 'ChatGPT' : /api key/i.test(text) ? 'API key' : /access token/i.test(text) ? 'access token' : '';
    return { signedIn: true, method, plan: method === 'ChatGPT' ? 'ChatGPT subscription' : '' };
  }
  return { signedIn: false };
}

/** gh auth status: login names, active flags and scope names. Token lines never leave here. */
function parseGhStatus(result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (result?.missing) return { accounts: [], error: 'GitHub CLI is not installed.' };
  const accounts = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const ok = /Logged in to ([A-Za-z0-9.-]+) account ([A-Za-z0-9-]+)/.exec(line);
    const bad = /Failed to log in to ([A-Za-z0-9.-]+)(?: account ([A-Za-z0-9-]+))?/.exec(line);
    if (ok || bad) {
      const login = (ok ? ok[2] : bad[2]) || '';
      current = { host: (ok || bad)[1], login: GH_LOGIN.test(login) ? login : '', signedIn: Boolean(ok), active: false, scopes: [] };
      accounts.push(current);
      continue;
    }
    if (!current) continue;
    if (/Active account:\s*true/i.test(line)) current.active = true;
    const scopes = /Token scopes:\s*(.*)$/i.exec(line);
    if (scopes) current.scopes = (scopes[1].match(/[a-z][a-z:_]{1,30}/g) || []).slice(0, 12);
  }
  return { accounts };
}

/**
 * The bits of a Hermes config.yaml the Accounts page shows. Values are kept only for the
 * whitelisted model fields and on/off flags; everything else contributes key names only.
 */
function readConfigSummary(text) {
  const out = { model: { provider: '', name: '', baseUrl: '' }, mcpServers: [], pluginsEnabled: [], pluginsDisabled: [], platforms: {}, botDesktop: null, browser: false };
  const stack = [];
  const mcp = new Map();
  const listAt = (keyPath, value) => {
    const items = String(value).replace(/^\[|\]$/g, '').split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (keyPath === 'plugins.enabled') out.pluginsEnabled.push(...items);
    if (keyPath === 'plugins.disabled') out.pluginsDisabled.push(...items);
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const item = /^(\s*)-\s+(.*)$/.exec(raw);
    if (item) {
      // YAML lets "- item" sit at the same indent as its key, so only deeper keys close here.
      while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
      listAt(stack.map((row) => row.key).join('.'), item[2].replace(/\s+#.*$/, ''));
      continue;
    }
    const kv = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = kv[2];
    const rest = kv[3].replace(/\s+#.*$/, '').trim();
    const parents = stack.map((row) => row.key);
    const keyPath = [...parents, key].join('.');
    const value = rest.replace(/^['"]|['"]$/g, '');
    if (parents.length === 1 && parents[0] === 'mcp_servers') mcp.set(key, true);
    if (parents.length === 1 && parents[0] === 'platforms') out.platforms[key] = out.platforms[key] ?? (rest ? !/^(false|off|no)$/i.test(value) : true);
    if (parents.length === 2 && parents[0] === 'platforms' && key === 'enabled') out.platforms[parents[1]] = !/^(false|off|no)$/i.test(value);
    if (parents.length === 2 && parents[0] === 'mcp_servers' && (key === 'enabled' || key === 'disabled')) {
      const on = /^(true|on|yes)$/i.test(value);
      mcp.set(parents[1], key === 'enabled' ? on : !on);
    }
    if (keyPath === 'model' && rest) out.model.name = value.slice(0, 80);
    if (keyPath === 'model.provider') out.model.provider = value.slice(0, 40);
    if (keyPath === 'model.default' || keyPath === 'model.model' || keyPath === 'model.name') out.model.name = out.model.name || value.slice(0, 80);
    if (keyPath === 'model.base_url') out.model.baseUrl = /^https?:\/\/[^\s@]+$/.test(value) ? value.slice(0, 120) : '';
    if (keyPath === 'bot_desktop') out.botDesktop = out.botDesktop || {};
    if (keyPath === 'bot_desktop.auto_start') out.botDesktop = { ...(out.botDesktop || {}), autoStart: /^(true|on|yes)$/i.test(value) };
    if (keyPath === 'browser') out.browser = true;
    if ((keyPath === 'plugins.enabled' || keyPath === 'plugins.disabled') && rest.startsWith('[')) listAt(keyPath, rest);
    if (!rest || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') stack.push({ indent, key });
  }
  out.mcpServers = [...mcp.entries()].map(([name, enabled]) => ({ name: name.slice(0, 60), enabled }));
  return out;
}

/** Variable names from a .env file. Values are dropped line by line and never returned. */
function envNames(text) {
  const names = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,63})\s*=/.exec(line);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Find the sign-in URL, device code and paste prompt on a tmux screen. Nothing else is kept. */
function parseSignInScreen(tool, screen) {
  const text = String(screen || '').replace(/[│┃║|]+\s*$/gm, '');
  const hosts = SIGNIN_HOSTS[tool] || [];
  let url = '';
  for (const match of text.matchAll(/https:\/\/[^\s"'<>│┃║]+/g)) {
    let candidate = match[0].replace(/[).,;]+$/, '');
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) { url = parsed.toString(); break; }
    } catch { /* not a URL */ }
  }
  let userCode = '';
  const near = text.search(/one-time code|device code|enter (?:this|the) code|user code/i);
  if (near >= 0 && tool !== 'claude') {
    const hit = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/.exec(text.slice(near, near + 240));
    if (hit) userCode = hit[1];
  }
  const needsCode = tool === 'claude' && /paste (?:the )?code|enter (?:the )?code|authorization code/i.test(text);
  const pressEnter = tool === 'github' && /press enter to open/i.test(text);
  const failed = /error|failed|expired|denied/i.test(text.split(/\r?\n/).slice(-6).join('\n')) && !url;
  return { url, userCode, needsCode, pressEnter, failed };
}

/* ---------- accounts service ---------- */

function createAccounts({
  home = os.homedir(),
  hermesRoot = path.join(home, '.hermes'),
  profilesRoot = path.join(hermesRoot, 'profiles'),
  mappingFile = path.join(home, '.config', 'intelio', 'accounts.json'),
  run = defaultRun,
  now = Date.now,
  ttlMs = 60000,
  signInTimeoutMs = 10 * 60000,
  vaultCount = () => null,
  usage = () => ({ models: {}, sources: {} }),
  lastUsed = () => ({}),
  appendEvent = (event) => appendActivity(event),
  fsImpl = fs,
  bins = {},
  tmuxSocket = '',
} = {}) {
  const cache = new Map();
  const toolCache = { at: 0, value: null, pending: null };
  const signIns = new Map();

  function bin(name) {
    if (bins[name]) return bins[name];
    const local = path.join(home, '.local', 'bin', name);
    return statOf(local, fsImpl) ? local : name;
  }

  /** Commands get a minimal environment: no server secrets, no GH_TOKEN, no colour codes. */
  function childEnv(extra = {}) {
    return {
      HOME: home,
      PATH: `${path.join(home, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`,
      USER: process.env.USER || os.userInfo().username,
      LANG: 'C.UTF-8',
      NO_COLOR: '1',
      TERM: 'dumb',
      GH_PROMPT_DISABLED: '1',
      ...extra,
    };
  }

  function dirFor(tool, name) {
    if (tool === 'claude') return name === 'default' ? path.join(home, '.claude') : path.join(home, `.claude-${name}`);
    if (tool === 'codex') return name === 'default' ? path.join(home, '.codex') : path.join(home, `.codex-${name}`);
    return name === 'default' ? path.join(home, '.config', 'gh') : path.join(home, '.config', `gh-${name}`);
  }

  function envVarFor(tool) {
    return tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : tool === 'codex' ? 'CODEX_HOME' : 'GH_CONFIG_DIR';
  }

  function envForAccount(tool, name) {
    return name === 'default' ? {} : { [envVarFor(tool)]: dirFor(tool, name) };
  }

  /** Account names on disk for a tool: 'default' plus every ~/.claude-<name> style dir. */
  function accountNames(tool) {
    const names = ['default'];
    const [parent, prefix] = tool === 'github' ? [path.join(home, '.config'), 'gh-'] : [home, tool === 'claude' ? '.claude-' : '.codex-'];
    let entries = [];
    try { entries = fsImpl.readdirSync(parent, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const name = entry.name.slice(prefix.length);
      if (ACCOUNT.test(name) && name !== 'default' && !names.includes(name)) names.push(name);
    }
    return names.slice(0, 12);
  }

  async function checkAccount(tool, name) {
    const env = childEnv(envForAccount(tool, name));
    if (tool === 'claude') {
      const status = parseClaudeStatus(await run(bin('claude'), ['auth', 'status'], { env }));
      return { tool, name, ...status, account: status.email };
    }
    if (tool === 'codex') {
      const status = parseCodexStatus(await run(bin('codex'), ['login', 'status'], { env }));
      return { tool, name, ...status, account: '' };
    }
    const parsed = parseGhStatus(await run(bin('gh'), ['auth', 'status', '--hostname', 'github.com'], { env }));
    const active = parsed.accounts.find((row) => row.active && row.signedIn) || parsed.accounts.find((row) => row.signedIn) || parsed.accounts[0] || null;
    return {
      tool,
      name,
      signedIn: Boolean(active?.signedIn),
      account: active?.login || '',
      scopes: active?.scopes || [],
      others: parsed.accounts.filter((row) => row !== active && row.login).map((row) => ({ login: row.login, signedIn: row.signedIn })),
      error: parsed.error || '',
    };
  }

  async function toolStatus(fresh) {
    if (!fresh && toolCache.value && now() - toolCache.at < ttlMs) return toolCache.value;
    if (toolCache.pending) return toolCache.pending;
    toolCache.pending = (async () => {
      const value = {};
      for (const tool of TOOLS) {
        value[tool] = await Promise.all(accountNames(tool).map((name) => checkAccount(tool, name).catch(() => ({ tool, name, signedIn: false, account: '', error: 'Status check failed.' }))));
      }
      toolCache.value = value;
      toolCache.at = now();
      return value;
    })().finally(() => { toolCache.pending = null; });
    return toolCache.pending;
  }

  /* ----- assignment map (intelio-owned, 0600) ----- */

  function readMapping() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(mappingFile, 'utf8'));
      const agents = parsed && typeof parsed.agents === 'object' && parsed.agents ? parsed.agents : {};
      const clean = {};
      for (const [profile, row] of Object.entries(agents)) {
        if (!PROFILE.test(profile) || !row || typeof row !== 'object') continue;
        clean[profile] = {};
        for (const tool of TOOLS) if (ACCOUNT.test(String(row[tool] || ''))) clean[profile][tool] = row[tool];
      }
      return { version: 1, agents: clean };
    } catch {
      return { version: 1, agents: {} };
    }
  }

  function writeMapping(mapping) {
    fsImpl.mkdirSync(path.dirname(mappingFile), { recursive: true, mode: 0o700 });
    const tmp = `${mappingFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fsImpl.writeFileSync(tmp, `${JSON.stringify({ ...mapping, updatedAt: new Date(now()).toISOString() }, null, 2)}\n`, { mode: 0o600 });
    fsImpl.renameSync(tmp, mappingFile);
    try { fsImpl.chmodSync(mappingFile, 0o600); } catch { /* best effort */ }
  }

  function assignedFor(profile) {
    const row = readMapping().agents[profile] || {};
    const out = {};
    for (const tool of TOOLS) out[tool] = row[tool] || 'default';
    return out;
  }

  /** The environment a terminal for this agent should get so its CLIs use the assigned accounts. */
  function envFor(profile) {
    const id = slugOk(profile, PROFILE);
    if (!id) return {};
    const assigned = assignedFor(id);
    return Object.assign({}, ...TOOLS.map((tool) => envForAccount(tool, assigned[tool])));
  }

  function assign({ profile, tool, account }) {
    const id = slugOk(profile, PROFILE);
    const name = slugOk(account, ACCOUNT);
    if (!id) throw Object.assign(new Error('Unknown agent.'), { status: 404 });
    if (!TOOLS.includes(tool)) throw Object.assign(new Error('Unknown tool.'), { status: 400 });
    if (!name || !accountNames(tool).includes(name)) throw Object.assign(new Error('That account is not on this server.'), { status: 400 });
    const mapping = readMapping();
    mapping.agents[id] = { ...(mapping.agents[id] || {}), [tool]: name };
    if (name === 'default') delete mapping.agents[id][tool];
    if (!Object.keys(mapping.agents[id]).length) delete mapping.agents[id];
    writeMapping(mapping);
    cache.clear();
    appendEvent({ profile: id, kind: 'account', action: 'assign', summary: `${TOOL_LABEL[tool]} for ${id} now uses the ${name} account`, account: `${tool}:${name}`, actor: 'user' });
    return assignedFor(id);
  }

  /* ----- per-profile status ----- */

  function readText(file, limit = 200000) {
    const stat = statOf(file, fsImpl);
    if (!stat || !stat.isFile() || stat.size > limit) return '';
    try { return fsImpl.readFileSync(file, 'utf8'); } catch { return ''; }
  }

  function gatewayPlatforms() {
    const parsed = (() => { try { return JSON.parse(readText(path.join(hermesRoot, 'gateway_state.json'), 2000000)); } catch { return null; } })();
    const out = {};
    for (const [key, row] of Object.entries(parsed?.platforms || {})) {
      if (!row || typeof row !== 'object') continue;
      out[key] = { state: String(row.state || (row.ingress_url ? 'listening' : '')).slice(0, 20), needsAttention: row.needs_attention === true, updatedAt: String(row.updated_at || '').slice(0, 40) };
    }
    return out;
  }

  function pidAlive(file) {
    const pid = Number(String(readText(file, 64)).trim());
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  }

  function modelRow(id, config, models) {
    const own = statOf(path.join(profilesRoot, id, 'auth.json'), fsImpl);
    const shared = own ? null : statOf(path.join(hermesRoot, 'auth.json'), fsImpl);
    const provider = config.model.provider || '';
    const meta = PROVIDERS[provider] || { label: provider || 'Model', plan: '' };
    const used = models[provider] || Object.values(models).sort((a, b) => b.lastOkAt - a.lastOkAt)[0] || null;
    const authFile = own || shared;
    const subscription = provider === 'openai-codex' || provider === 'claude-code' || provider === 'nous';
    const signedIn = subscription ? Boolean(authFile) : Boolean(provider);
    return {
      id: 'model',
      group: 'model',
      label: `Model sign-in · ${meta.label}`,
      account: config.model.name ? `${config.model.name}` : '',
      signedIn,
      plan: meta.plan,
      detail: [
        authFile ? (own ? 'Profile sign-in on file' : 'Uses the shared Hermes sign-in') : (subscription ? 'No sign-in on file' : ''),
        hostOf(config.model.baseUrl),
      ].filter(Boolean).join(' · '),
      authUpdatedAt: isoOrNull(authFile?.mtimeMs),
      lastOkAt: isoOrNull(used?.lastOkAt),
      verified: Boolean(used?.lastOkAt && (!authFile || used.lastOkAt >= authFile.mtimeMs - 5000)),
      lastUsedAt: isoOrNull(used?.lastOkAt),
      provider,
    };
  }

  function toolRows(tools, assigned, used) {
    const rows = [];
    for (const tool of TOOLS) {
      for (const status of tools[tool] || []) {
        rows.push({
          id: `${tool}:${status.name}`,
          group: tool,
          tool,
          name: status.name,
          label: TOOL_LABEL[tool],
          account: status.account || '',
          signedIn: status.signedIn === true,
          plan: status.plan || '',
          method: status.method || '',
          scopes: status.scopes || undefined,
          others: status.others?.length ? status.others : undefined,
          error: status.error || '',
          assigned: assigned[tool] === status.name,
          configDir: status.name === 'default' ? (tool === 'github' ? '~/.config/gh' : `~/.${tool}`) : (tool === 'github' ? `~/.config/gh-${status.name}` : `~/.${tool}-${status.name}`),
          lastUsedAt: assigned[tool] === status.name ? (used[tool] || null) : null,
        });
      }
    }
    return rows;
  }

  function channelRows(id, config, names, gateway, sources) {
    const rows = [];
    for (const channel of CHANNELS) {
      const vars = names.filter((name) => channel.vars.test(name));
      const enabled = config.platforms[channel.platform];
      const live = gateway[`${id}:${channel.platform}`] || null;
      if (!vars.length && !enabled && !live) continue;
      const connected = live?.state === 'connected' || live?.state === 'listening';
      rows.push({
        id: `channel:${channel.id}`,
        group: 'channel',
        label: channel.label,
        account: '',
        signedIn: connected,
        plan: '',
        detail: [live?.state ? `Gateway: ${live.state}` : (enabled === false ? 'Disabled in config' : 'Configured'), vars.length ? `${vars.join(', ')} set` : ''].filter(Boolean).join(' · '),
        needsAttention: live?.needsAttention === true,
        lastUsedAt: isoOrNull(sources[channel.platform === 'photon' ? 'photon' : channel.platform]),
      });
    }
    return rows;
  }

  function pluginRows(id, config) {
    const rows = [];
    for (const server of config.mcpServers) rows.push({ id: `mcp:${server.name}`, group: 'mcp', label: server.name, account: '', signedIn: server.enabled, plan: '', detail: server.enabled ? 'MCP server · enabled' : 'MCP server · disabled' });
    let installed = [];
    try { installed = fsImpl.readdirSync(path.join(profilesRoot, id, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { installed = []; }
    const names = [...new Set([...config.pluginsEnabled, ...installed])];
    for (const name of names.slice(0, 20)) {
      const enabled = config.pluginsEnabled.includes(name) && !config.pluginsDisabled.includes(name);
      rows.push({ id: `plugin:${name}`, group: 'mcp', label: name, account: '', signedIn: enabled, plan: '', detail: enabled ? 'Plugin · enabled' : (installed.includes(name) ? 'Plugin · installed, not enabled' : 'Plugin · not installed') });
    }
    return rows;
  }

  function desktopRow(id, config, used) {
    const dir = path.join(profilesRoot, id, 'bot-desktop');
    const exists = Boolean(statOf(dir, fsImpl));
    if (!exists && !config.botDesktop) return null;
    const running = exists && (pidAlive(path.join(dir, 'launcher.pid')) || Boolean(readText(path.join(dir, 'cdp.url'), 4096).trim()));
    const browserProfile = Boolean(statOf(path.join(dir, 'browser-profile'), fsImpl));
    return {
      id: 'desktop',
      group: 'desktop',
      label: 'Bot desktop and browser',
      account: '',
      signedIn: running,
      plan: '',
      detail: [running ? 'Running' : 'Stopped', browserProfile ? 'browser profile kept (site sign-ins persist)' : 'no browser profile yet', config.botDesktop?.autoStart ? 'starts on demand' : ''].filter(Boolean).join(' · '),
      lastUsedAt: used.browser || used.connector || null,
    };
  }

  async function build(id) {
    const config = readConfigSummary(readText(path.join(profilesRoot, id, 'config.yaml')));
    const names = envNames(readText(path.join(profilesRoot, id, '.env'), 100000));
    const [tools, use] = await Promise.all([toolStatus(false), Promise.resolve().then(() => usage(id) || {})]);
    const used = lastUsed(id) || {};
    const assigned = assignedFor(id);
    const gateway = gatewayPlatforms();
    let saved = null;
    try { saved = vaultCount(id); } catch { saved = null; }
    const rows = [
      modelRow(id, config, use.models || {}),
      ...toolRows(tools, assigned, used),
      ...channelRows(id, config, names, gateway, use.sources || {}),
      ...pluginRows(id, config),
    ];
    const desktop = desktopRow(id, config, used);
    if (desktop) rows.push(desktop);
    rows.push({ id: 'vault', group: 'vault', label: 'Saved logins', account: '', signedIn: Number(saved) > 0, plan: '', count: Number.isInteger(saved) ? saved : null, detail: Number.isInteger(saved) ? `${saved} saved in this agent's vault (site and username only)` : 'Vault not readable from here', lastUsedAt: used.vault || null });
    return { profile: id, generatedAt: new Date(now()).toISOString(), assigned, accounts: rows.map((row) => scrub(row)) };
  }

  /** Last line of defence: no string in the response can carry a token-looking value. */
  function scrub(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, scrub(v)]));
    return value;
  }

  async function status(profile, { fresh = false } = {}) {
    const id = slugOk(profile, PROFILE);
    if (!id) throw Object.assign(new Error('Unknown agent.'), { status: 404 });
    if (!statOf(path.join(profilesRoot, id), fsImpl)) throw Object.assign(new Error('That agent was not found.'), { status: 404 });
    const hit = cache.get(id);
    if (!fresh && hit?.value && now() - hit.at < ttlMs) return { ...hit.value, cached: true };
    if (hit?.pending) return hit.pending;
    if (fresh) toolCache.at = 0;
    const pending = build(id).then((value) => { cache.set(id, { at: now(), value }); return value; })
      .finally(() => { const row = cache.get(id); if (row?.pending) delete row.pending; });
    cache.set(id, { ...(hit || {}), pending });
    return pending;
  }

  /* ----- sign-in in a tmux window ----- */

  function tmux(args, opts = {}) {
    const socket = tmuxSocket ? ['-L', tmuxSocket] : [];
    return run(bin('tmux'), [...socket, ...args], { env: childEnv({ TERM: 'xterm-256color' }), timeoutMs: 8000, ...opts });
  }

  function publicSignIn(row) {
    return {
      id: row.id, tool: row.tool, name: row.name, profile: row.profile, state: row.state,
      url: row.url || '', userCode: row.userCode || '', needsCode: Boolean(row.needsCode && !row.codeSent),
      codeSent: Boolean(row.codeSent), account: row.account || '', error: row.error || '',
      startedAt: new Date(row.startedAt).toISOString(),
    };
  }

  function signInCommand(tool) {
    if (tool === 'claude') return [bin('claude'), 'auth', 'login', '--claudeai'];
    if (tool === 'codex') return [bin('codex'), 'login', '--device-auth'];
    return [bin('gh'), 'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key'];
  }

  async function startSignIn({ profile, tool, name }) {
    const id = slugOk(profile, PROFILE);
    const account = slugOk(name, ACCOUNT);
    if (!id) throw Object.assign(new Error('Unknown agent.'), { status: 404 });
    if (!TOOLS.includes(tool)) throw Object.assign(new Error('Sign-in is available for Claude Code, Codex and GitHub.'), { status: 400 });
    if (!account) throw Object.assign(new Error('Name the account with lowercase letters, numbers or dashes.'), { status: 400 });
    if (!statOf(path.join(profilesRoot, id), fsImpl)) throw Object.assign(new Error('That agent was not found.'), { status: 404 });
    for (const row of signIns.values()) {
      if (row.tool === tool && row.name === account && !['done', 'failed', 'expired', 'cancelled'].includes(row.state)) return publicSignIn(row);
    }
    if ([...signIns.values()].filter((row) => !['done', 'failed', 'expired', 'cancelled'].includes(row.state)).length >= 3) throw Object.assign(new Error('Finish the open sign-ins first.'), { status: 429 });
    if (accountNames(tool).includes(account)) {
      const current = await checkAccount(tool, account).catch(() => null);
      if (current?.signedIn) throw Object.assign(new Error(`The ${account} ${TOOL_LABEL[tool]} account is already signed in.`), { status: 409 });
    }
    const dir = dirFor(tool, account);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const signInId = crypto.randomBytes(9).toString('base64url');
    const windowName = `signin-${tool}-${account}`.slice(0, 40);
    const has = await tmux(['has-session', '-t', TMUX_SESSION]);
    if (has.code !== 0) {
      const made = await tmux(['new-session', '-d', '-s', TMUX_SESSION, '-x', '220', '-y', '50', '-n', 'idle']);
      if (made.code !== 0) throw Object.assign(new Error('Could not start tmux on the server.'), { status: 500 });
    }
    const envArgs = [];
    for (const [key, value] of Object.entries({ ...envForAccount(tool, account), ...(tool === 'github' ? { GH_BROWSER: 'true', BROWSER: 'true' } : { BROWSER: 'true' }) })) envArgs.push('-e', `${key}=${value}`);
    const made = await tmux(['new-window', '-d', '-P', '-F', '#{window_id}', '-t', `${TMUX_SESSION}:`, '-n', windowName, ...envArgs, ...signInCommand(tool)]);
    const target = String(made.stdout || '').trim();
    if (made.code !== 0 || !/^@\d+$/.test(target)) throw Object.assign(new Error('Could not open the sign-in window.'), { status: 500 });
    await tmux(['set-option', '-w', '-t', target, 'remain-on-exit', 'on']);
    const row = { id: signInId, profile: id, tool, name: account, target, state: 'starting', startedAt: now(), url: '', userCode: '', needsCode: false, codeSent: false, entered: false, checkedAt: 0, account: '', error: '' };
    signIns.set(signInId, row);
    appendEvent({ profile: id, kind: 'signin', action: 'started', summary: `Started ${TOOL_LABEL[tool]} sign-in for the ${account} account`, account: `${tool}:${account}`, actor: 'user' });
    return refresh(row);
  }

  async function closeWindow(row) {
    if (!row.target) return;
    await tmux(['clear-history', '-t', row.target]).catch(() => {});
    await tmux(['kill-window', '-t', row.target]).catch(() => {});
    row.target = '';
  }

  async function finish(row, state, extra = {}) {
    Object.assign(row, { state, ...extra });
    await closeWindow(row);
    toolCache.at = 0;
    cache.clear();
    if (state === 'done') appendEvent({ profile: row.profile, kind: 'signin', action: 'signed-in', summary: `${TOOL_LABEL[row.tool]} ${row.name} account signed in${row.account ? ` as ${row.account}` : ''}`, account: `${row.tool}:${row.name}`, ok: true, actor: 'user' });
    else if (state !== 'cancelled') appendEvent({ profile: row.profile, kind: 'signin', action: state, summary: `${TOOL_LABEL[row.tool]} sign-in for ${row.name} ${state === 'expired' ? 'timed out' : 'did not finish'}`, account: `${row.tool}:${row.name}`, ok: false, actor: 'user' });
  }

  async function refresh(row) {
    if (['done', 'failed', 'expired', 'cancelled'].includes(row.state)) return publicSignIn(row);
    if (now() - row.startedAt > signInTimeoutMs) { await finish(row, 'expired', { error: 'The sign-in timed out. Start again.' }); return publicSignIn(row); }
    const shot = await tmux(['capture-pane', '-p', '-J', '-t', row.target, '-S', '-300']);
    const pane = await tmux(['display-message', '-p', '-t', row.target, '#{pane_dead}']);
    const dead = String(pane.stdout || '').trim() === '1' || pane.code !== 0;
    const seen = parseSignInScreen(row.tool, shot.stdout);
    if (seen.url) row.url = seen.url;
    if (seen.userCode) row.userCode = seen.userCode;
    if (seen.needsCode) row.needsCode = true;
    if (seen.pressEnter && !row.entered) { row.entered = true; await tmux(['send-keys', '-t', row.target, 'Enter']); }
    if (row.url && row.state === 'starting') row.state = 'waiting';
    const due = dead || row.codeSent || now() - row.checkedAt > 5000;
    if (due && row.state !== 'starting') {
      row.checkedAt = now();
      const check = await checkAccount(row.tool, row.name).catch(() => null);
      if (check?.signedIn) { await finish(row, 'done', { account: check.account || '' }); return publicSignIn(row); }
    }
    if (dead) await finish(row, 'failed', { error: 'The sign-in ended without signing in.' });
    return publicSignIn(row);
  }

  async function signInState(signInId) {
    const row = signIns.get(String(signInId || ''));
    if (!row) throw Object.assign(new Error('That sign-in is no longer open.'), { status: 404 });
    return refresh(row);
  }

  /**
   * Send a paste-back code to the sign-in window. The code goes through a one-shot tmux
   * buffer on stdin (never argv, never a file, never logged) and the buffer is deleted on paste.
   */
  async function submitCode({ id: signInId, code }) {
    const row = signIns.get(String(signInId || ''));
    if (!row || ['done', 'failed', 'expired', 'cancelled'].includes(row.state)) throw Object.assign(new Error('That sign-in is no longer open.'), { status: 404 });
    const value = String(code || '').replace(/[\r\n\t ]+/g, '');
    if (!CODE_RE.test(value)) throw Object.assign(new Error('That code does not look right.'), { status: 400 });
    const buffer = `intelio-${crypto.randomBytes(6).toString('hex')}`;
    const loaded = await tmux(['load-buffer', '-b', buffer, '-'], { input: value });
    if (loaded.code !== 0) throw Object.assign(new Error('Could not reach the sign-in window.'), { status: 500 });
    await tmux(['paste-buffer', '-d', '-b', buffer, '-t', row.target]);
    await tmux(['send-keys', '-t', row.target, 'Enter']);
    await tmux(['delete-buffer', '-b', buffer]).catch(() => {});
    row.codeSent = true;
    row.needsCode = false;
    row.state = 'verifying';
    return publicSignIn(row);
  }

  async function cancelSignIn(signInId) {
    const row = signIns.get(String(signInId || ''));
    if (!row) return { ok: true };
    if (!['done', 'failed', 'expired', 'cancelled'].includes(row.state)) await finish(row, 'cancelled');
    return publicSignIn(row);
  }

  return { status, assign, envFor, assignedFor, startSignIn, signInState, submitCode, cancelSignIn, accountNames, readMapping };
}

/** Fixed rows for the loopback-only sample server (INTELIO_PWA_SAMPLE=1). No commands run. */
function sampleStatus(profile, now = Date.now) {
  const at = (minutes) => new Date(now() - minutes * 60000).toISOString();
  const id = String(profile || 'intelio');
  return {
    profile: id,
    sample: true,
    generatedAt: new Date(now()).toISOString(),
    assigned: { claude: 'default', codex: 'default', github: 'default' },
    accounts: [
      { id: 'model', group: 'model', label: 'Model sign-in · ChatGPT (Codex)', account: 'gpt-6-sol', signedIn: true, plan: 'ChatGPT subscription', detail: 'Profile sign-in on file · chatgpt.com', verified: true, lastOkAt: at(3), lastUsedAt: at(3), authUpdatedAt: at(60 * 50) },
      { id: 'claude:default', group: 'claude', tool: 'claude', name: 'default', label: 'Claude Code', account: 'owner@example.com', signedIn: true, plan: 'max', method: 'claude.ai', assigned: true, configDir: '~/.claude', lastUsedAt: at(42) },
      { id: 'codex:default', group: 'codex', tool: 'codex', name: 'default', label: 'Codex CLI', account: '', signedIn: false, plan: '', assigned: true, configDir: '~/.codex', lastUsedAt: null },
      { id: 'github:default', group: 'github', tool: 'github', name: 'default', label: 'GitHub', account: 'inteliodev', signedIn: true, plan: '', scopes: ['gist', 'read:org', 'repo', 'workflow'], assigned: true, configDir: '~/.config/gh', lastUsedAt: at(18) },
      { id: 'channel:telegram', group: 'channel', label: 'Telegram', account: '', signedIn: true, detail: 'Gateway: connected · TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS set', lastUsedAt: at(95) },
      { id: 'channel:imessage', group: 'channel', label: 'iMessage (Photon)', account: '', signedIn: true, detail: 'Gateway: connected · PHOTON_PROJECT_ID set', lastUsedAt: at(240) },
      { id: 'mcp:workspace_browser', group: 'mcp', label: 'workspace_browser', account: '', signedIn: true, detail: 'MCP server · enabled' },
      { id: 'plugin:intelio-vault', group: 'mcp', label: 'intelio-vault', account: '', signedIn: true, detail: 'Plugin · enabled' },
      { id: 'desktop', group: 'desktop', label: 'Bot desktop and browser', account: '', signedIn: true, detail: 'Running · browser profile kept (site sign-ins persist)', lastUsedAt: at(12) },
      { id: 'vault', group: 'vault', label: 'Saved logins', account: '', signedIn: true, count: 3, detail: "3 saved in this agent's vault (site and username only)", lastUsedAt: at(300) },
    ],
  };
}

module.exports = { sampleStatus, TOOLS, createAccounts, parseClaudeStatus, parseCodexStatus, parseGhStatus, parseSignInScreen, readConfigSummary, envNames };
