const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const log = require('../src/intelio/activity-log.cjs');
const accounts = require('../../mobile/pwa/accounts.cjs');
const hermes = require('../../mobile/pwa/hermes-activity.cjs');
const ui = require('../src/accounts-ui.js');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const GH_TOKEN = `gho_${'A1b2C3d4'.repeat(4)}`;
const SECRET = 'sk-ant-notarealsecret1234567890';
const ENV_SECRET = 'twilio-secret-value-1234';
const AUTH_SECRET = 'auth-json-refresh-token-value';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }

/* ---------------- activity log ---------------- */

test('redaction removes tokens, passwords and keys but keeps commands readable', () => {
  const cases = [
    `gh auth login --with-token ${GH_TOKEN}`,
    `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`,
    'mysql --password=hunter2hunter2 -u root',
    'export TWILIO_AUTH_TOKEN=abc123def456',
    'git push https://someone:pa55word@github.com/inteliodev/alans-way.git',
    'echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4In0.c2lnbmF0dXJlc2lnbmF0dXJl',
    'open https://auth.example.com/cb?code=SplxlOBeZQQYbYS6WxSbIA&state=1',
    `OPENAI_API_KEY: ${SECRET}`,
  ];
  for (const line of cases) {
    const out = log.redact(line);
    assert.equal(/hunter2|abc123def456|pa55word|SplxlOBeZQQYbYS6WxSbIA|eyJzdWIi/.test(out), false, out);
    assert.equal(out.includes(GH_TOKEN) || out.includes(SECRET), false, out);
    assert.match(out, /\[redacted/);
  }
  assert.equal(log.redact('git checkout 78347f9d0c8a6f1e2b3c4d5e6f7a8b9c0d1e2f3a'), 'git checkout 78347f9d0c8a6f1e2b3c4d5e6f7a8b9c0d1e2f3a');
  assert.equal(log.redact('ls /home/user/intelio/alans-way-pwa/mobile/pwa'), 'ls /home/user/intelio/alans-way-pwa/mobile/pwa');
});

test('appendActivity writes a private, redacted JSONL line and readActivity returns newest first', () => {
  const dir = tmp('intelio-activity-');
  const file = path.join(dir, 'nested', 'activity.jsonl');
  const first = log.appendActivity({ profile: 'prc', kind: 'vault', action: 'fill', summary: `Filled app.box.com password=${SECRET}`, ts: '2026-10-08T15:00:00Z' }, { file });
  log.appendActivity({ profile: 'intelio', kind: 'signin', action: 'signed-in', summary: 'Claude Code work account signed in', account: 'claude:work', ok: true, ts: '2026-10-08T16:00:00Z' }, { file });
  assert.equal(log.appendActivity({ kind: 'github', summary: '' }, { file }), null);
  assert.equal(first.v, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(SECRET), false);
  fs.appendFileSync(file, `not json\n${JSON.stringify({ v: 1, ts: '2026-10-08T17:00:00Z', kind: 'terminal', summary: `token ${GH_TOKEN}` })}\n`);
  const rows = log.readActivity({ file });
  assert.deepEqual(rows.map((row) => row.kind), ['terminal', 'signin', 'vault']);
  assert.equal(JSON.stringify(rows).includes(GH_TOKEN), false);
  assert.equal(rows[1].account, 'claude:work');
  assert.equal(rows[0].source, 'intelio');
  assert.deepEqual(log.filterActivity(rows, { profile: 'prc' }).map((r) => r.kind), ['vault']);
  assert.deepEqual(log.filterActivity(rows, { kind: 'signin,terminal' }).map((r) => r.kind), ['terminal', 'signin']);
  assert.deepEqual(log.filterActivity(rows, { query: 'box.com' }).map((r) => r.kind), ['vault']);
});

test('commands are classified as GitHub, Claude Code, Codex or terminal', () => {
  assert.deepEqual(log.classifyCommand('cd repo && git push origin main'), { kind: 'github', action: 'push' });
  assert.deepEqual(log.classifyCommand('gh pr create --fill'), { kind: 'github', action: 'pr' });
  assert.deepEqual(log.classifyCommand('gh api user'), { kind: 'github', action: 'gh' });
  assert.deepEqual(log.classifyCommand('claude -p "fix the tests"'), { kind: 'claude', action: 'run' });
  assert.deepEqual(log.classifyCommand('CODEX_HOME=~/.codex-work codex exec "lint"'), { kind: 'codex', action: 'run' });
  assert.deepEqual(log.classifyCommand('ls -la'), { kind: 'terminal', action: 'command' });
});

/* ---------------- Hermes transcripts (read-only) ---------------- */

function hermesFixture() {
  const root = tmp('intelio-hermes-');
  const dir = path.join(root, 'intelio');
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL, last_activity_at REAL, title TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL);
    CREATE TABLE session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0, last_seen REAL);`);
  const now = Date.now() / 1000;
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('s1', 'telegram', now - 600, now - 60, 'Deploy');
  const call = (name, args) => ({ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const insert = db.prepare('INSERT INTO messages (session_id, role, tool_calls, timestamp) VALUES (?, ?, ?, ?)');
  insert.run('s1', 'assistant', JSON.stringify([call('terminal', { command: 'git push origin main' })]), now - 500);
  insert.run('s1', 'assistant', JSON.stringify([call('terminal', { command: `gh pr create --title x --body y; export GH_TOKEN=${GH_TOKEN}` })]), now - 400);
  insert.run('s1', 'assistant', JSON.stringify([call('read_file', { path: '/etc/hosts' }), call('browser_vault_save_login', { label: 'app.box.com' })]), now - 300);
  insert.run('s1', 'assistant', JSON.stringify([call('tool_call', { calls: [{ name: 'terminal', arguments: { command: 'claude -p "review"' } }, { name: 'computer_use', arguments: { action: 'click' } }] })]), now - 200);
  insert.run('s1', 'assistant', JSON.stringify([call('browser_navigate', { url: 'https://accounts.google.com/signin' })]), now - 100);
  db.prepare('INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?)').run('s1', 'gpt-6-sol', 'openai-codex', 12, now - 60);
  db.prepare('INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?)').run('s1', 'never', 'openrouter', 0, now - 30);
  db.close();
  return { root, file: path.join(dir, 'state.db') };
}

test('Hermes state.db is read read-only into redacted activity rows', { skip: !sqlite && 'node:sqlite needs Node 22.5+' }, () => {
  const { root, file } = hermesFixture();
  const before = fs.readFileSync(file);
  const rows = hermes.readHermesActivity({ root, profiles: ['intelio', 'missing', '../etc'] });
  assert.deepEqual(rows.map((row) => `${row.kind}:${row.action}`), ['browser:sign-in', 'claude:run', 'connector:click', 'vault:save-login', 'github:pr', 'github:push']);
  assert.ok(rows.every((row) => row.profile === 'intelio' && row.source === 'hermes' && row.session === 's1' && row.actor === 'agent'));
  assert.equal(JSON.stringify(rows).includes(GH_TOKEN), false);
  assert.ok(!rows.some((row) => row.summary.includes('/etc/hosts')), 'file reads are not activity');
  assert.deepEqual(fs.readFileSync(file), before, 'the database is not modified');
  const usage = hermes.profileUsage({ root, profile: 'intelio' });
  assert.equal(usage.models['openai-codex'].model, 'gpt-6-sol');
  assert.equal(usage.models.openrouter, undefined, 'calls that never succeeded are not "last used"');
  assert.ok(usage.sources.telegram > Date.now() - 120000);
});

/* ---------------- status parsers ---------------- */

test('status parsers keep only safe fields', () => {
  const claude = accounts.parseClaudeStatus({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', orgId: 'c114-org', orgName: 'Org', subscriptionType: 'max', configDirectory: '/home/user/.claude' }) });
  assert.deepEqual(claude, { signedIn: true, email: 'owner@example.com', plan: 'max', method: 'claude.ai' });
  assert.deepEqual(accounts.parseCodexStatus({ stdout: 'Not logged in\n' }), { signedIn: false });
  assert.deepEqual(accounts.parseCodexStatus({ stdout: 'Logged in using ChatGPT\n' }), { signedIn: true, method: 'ChatGPT', plan: 'ChatGPT subscription' });
  const gh = accounts.parseGhStatus({ stdout: [
    'github.com',
    '  ✓ Logged in to github.com account inteliodev (/home/user/.config/gh/hosts.yml)',
    '  - Active account: true',
    '  - Git operations protocol: https',
    `  - Token: ${GH_TOKEN}`,
    "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
    '',
    '  X Failed to log in to github.com account old-bot (default)',
    '  - Active account: false',
  ].join('\n') });
  assert.deepEqual(gh.accounts.map((a) => [a.login, a.signedIn, a.active]), [['inteliodev', true, true], ['old-bot', false, false]]);
  assert.deepEqual(gh.accounts[0].scopes, ['gist', 'read:org', 'repo', 'workflow']);
  assert.equal(JSON.stringify(gh).includes(GH_TOKEN), false);
});

test('config.yaml and .env give names and the model block, never values', () => {
  const summary = accounts.readConfigSummary([
    'model:',
    '  default: gpt-6-sol',
    '  provider: openai-codex',
    '  base_url: https://chatgpt.com/backend-api/codex',
    'mcp_servers:',
    '  workspace_browser:',
    '    command: node',
    '    env:',
    `      API_TOKEN: ${SECRET}`,
    '  old_server:',
    '    enabled: false',
    'plugins:',
    '  enabled:',
    '  - alans-way',
    '  - intelio-vault',
    '  disabled: []',
    'platforms:',
    '  photon:',
    '    enabled: true',
    'bot_desktop:',
    '  auto_start: true',
  ].join('\n'));
  assert.deepEqual(summary.model, { provider: 'openai-codex', name: 'gpt-6-sol', baseUrl: 'https://chatgpt.com/backend-api/codex' });
  assert.deepEqual(summary.mcpServers, [{ name: 'workspace_browser', enabled: true }, { name: 'old_server', enabled: false }]);
  assert.deepEqual(summary.pluginsEnabled, ['alans-way', 'intelio-vault']);
  assert.equal(summary.platforms.photon, true);
  assert.equal(JSON.stringify(summary).includes(SECRET), false);
  assert.deepEqual(accounts.envNames(`TELEGRAM_BOT_TOKEN=${SECRET}\n# COMMENTED=1\nexport TWILIO_AUTH_TOKEN="${ENV_SECRET}"\nnot a line\n`), ['TELEGRAM_BOT_TOKEN', 'TWILIO_AUTH_TOKEN']);
});

test('the sign-in screen parser only trusts the tool’s own sign-in hosts', () => {
  const claude = accounts.parseSignInScreen('claude', 'Browser didn\'t open? Use the url below to sign in:\n\nhttps://evil.example/login\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz │\n\nPaste code here if prompted >');
  assert.equal(new URL(claude.url).hostname, 'claude.ai');
  assert.equal(claude.needsCode, true);
  assert.equal(claude.userCode, '');
  const codex = accounts.parseSignInScreen('codex', 'Follow these steps to sign in with ChatGPT using device code authorization:\n1. Open this link in your browser\n   https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345\n');
  assert.equal(codex.url, 'https://auth.openai.com/codex/device');
  assert.equal(codex.userCode, 'ABCD-12345');
  const gh = accounts.parseSignInScreen('github', '! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser...');
  assert.equal(gh.url, 'https://github.com/login/device');
  assert.equal(gh.userCode, '1A2B-3C4D');
  assert.equal(gh.pressEnter, true);
  assert.equal(accounts.parseSignInScreen('github', 'visit https://github.evil.com/login/device').url, '');
});

/* ---------------- accounts service ---------------- */

function fakeHome() {
  const home = tmp('intelio-home-');
  const profiles = path.join(home, '.hermes', 'profiles');
  const dir = path.join(profiles, 'intelio');
  fs.mkdirSync(path.join(dir, 'plugins', 'intelio-vault'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bot-desktop', 'browser-profile'), { recursive: true });
  fs.mkdirSync(path.join(profiles, 'arlp'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model:\n  default: gpt-6-sol\n  provider: openai-codex\n  base_url: https://chatgpt.com/backend-api/codex\nmcp_servers:\n  workspace_browser:\n    command: node\nplugins:\n  enabled:\n  - intelio-vault\nplatforms:\n  photon:\n    enabled: true\n');
  fs.writeFileSync(path.join(profiles, 'arlp', 'config.yaml'), 'model:\n  provider: openai-codex\n  default: gpt-6-sol\n');
  fs.writeFileSync(path.join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${SECRET}\nTWILIO_AUTH_TOKEN=${ENV_SECRET}\nAPI_SERVER_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ refresh: AUTH_SECRET }));
  fs.writeFileSync(path.join(home, '.hermes', 'auth.json'), JSON.stringify({ refresh: AUTH_SECRET }));
  const hourAgo = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(dir, 'auth.json'), hourAgo, hourAgo);
  fs.writeFileSync(path.join(home, '.hermes', 'gateway_state.json'), JSON.stringify({ platforms: { 'intelio:telegram': { state: 'connected', error_message: SECRET, needs_attention: false }, 'intelio:photon': { state: 'connected' } } }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ token: AUTH_SECRET }));
  fs.mkdirSync(path.join(home, '.claude-work'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true });
  return { home, profiles };
}

/** fs that refuses to open any credential file, so a test fails if status code ever reads one. */
function guardedFs(seen) {
  const banned = /(auth\.json|\.credentials\.json|hosts\.yml)$/;
  return new Proxy(fs, {
    get(target, prop) {
      if (prop === 'readFileSync' || prop === 'openSync' || prop === 'createReadStream') {
        return (file, ...rest) => {
          if (banned.test(String(file))) { seen.push(String(file)); throw new Error(`credential file opened: ${file}`); }
          return target[prop](file, ...rest);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function fakeRun(calls, { claudeWork = false } = {}) {
  return async (file, args, opts = {}) => {
    calls.push({ file, args, env: opts.env, input: opts.input });
    const tool = path.basename(file);
    if (tool === 'claude' && args.join(' ') === 'auth status') {
      if (opts.env.CLAUDE_CONFIG_DIR) return { code: claudeWork ? 0 : 1, stdout: JSON.stringify(claudeWork ? { loggedIn: true, email: 'ops@example.com', subscriptionType: 'pro', orgId: 'org-secret' } : { loggedIn: false }) };
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', subscriptionType: 'max', orgId: 'org-secret' }) };
    }
    if (tool === 'codex') return { code: 1, stdout: 'Not logged in\n' };
    if (tool === 'gh') return { code: 0, stdout: `github.com\n  ✓ Logged in to github.com account inteliodev (x)\n  - Active account: true\n  - Token: ${GH_TOKEN}\n  - Token scopes: 'repo'\n` };
    return { code: 0, stdout: '' };
  };
}

test('per-agent status covers every connection, reads no credential file and leaks no secret', async () => {
  const { home, profiles } = fakeHome();
  const calls = [];
  const seen = [];
  process.env.INTELIO_TEST_SERVER_SECRET = SECRET;
  const svc = accounts.createAccounts({
    home, profilesRoot: profiles, run: fakeRun(calls), fsImpl: guardedFs(seen),
    bins: { claude: 'claude', codex: 'codex', gh: 'gh' },
    vaultCount: () => 3,
    usage: () => ({ models: { 'openai-codex': { model: 'gpt-6-sol', lastOkAt: Date.now() - 60000 } }, sources: { telegram: Date.now() - 120000 } }),
    lastUsed: () => ({ claude: '2026-10-08T15:00:00.000Z', github: '2026-10-08T15:30:00.000Z' }),
    appendEvent: () => {},
  });
  const status = await svc.status('intelio');
  const text = JSON.stringify(status);
  delete process.env.INTELIO_TEST_SERVER_SECRET;
  assert.deepEqual(seen, [], 'no credential file was opened');
  for (const secret of [SECRET, ENV_SECRET, AUTH_SECRET, GH_TOKEN, 'org-secret']) assert.equal(text.includes(secret), false, secret);
  const byId = Object.fromEntries(status.accounts.map((row) => [row.id, row]));
  assert.equal(byId.model.signedIn, true);
  assert.equal(byId.model.verified, true);
  assert.equal(byId.model.plan, 'ChatGPT subscription');
  assert.match(byId.model.detail, /Profile sign-in on file/);
  assert.equal(byId['claude:default'].account, 'owner@example.com');
  assert.equal(byId['claude:default'].plan, 'max');
  assert.equal(byId['claude:default'].assigned, true);
  assert.equal(byId['claude:default'].lastUsedAt, '2026-10-08T15:00:00.000Z');
  assert.equal(byId['claude:work'].signedIn, false);
  assert.equal(byId['codex:default'].signedIn, false);
  assert.equal(byId['github:default'].account, 'inteliodev');
  assert.equal(byId['channel:telegram'].signedIn, true);
  assert.match(byId['channel:telegram'].detail, /TELEGRAM_BOT_TOKEN/);
  assert.match(byId['channel:sms'].detail, /TWILIO_AUTH_TOKEN set/);
  assert.equal(byId['channel:imessage'].signedIn, true);
  assert.equal(byId['mcp:workspace_browser'].signedIn, true);
  assert.equal(byId['plugin:intelio-vault'].signedIn, true);
  assert.equal(byId.vault.count, 3);
  assert.ok(byId.desktop);
  // Only status commands ran, with a minimal environment.
  for (const call of calls) {
    assert.ok(['auth status', 'login status', 'auth status --hostname github.com'].includes(call.args.join(' ')), call.args.join(' '));
    assert.equal(Object.values(call.env).includes(SECRET), false);
    assert.equal(call.env.GH_TOKEN, undefined);
  }
  assert.ok(calls.some((c) => c.env.CLAUDE_CONFIG_DIR === path.join(home, '.claude-work')), 'second Claude account uses its own config dir');
  // Cached for about a minute.
  const again = await svc.status('intelio');
  assert.equal(again.cached, true);
  // A profile without its own auth file uses the shared Hermes sign-in.
  const arlp = await svc.status('arlp');
  assert.match(arlp.accounts.find((row) => row.id === 'model').detail, /shared Hermes sign-in/);
  await assert.rejects(svc.status('../etc'), /Unknown agent/);
  await assert.rejects(svc.status('ghost'), /not found/);
});

test('assignments live in an intelio-owned 0600 file and give terminals the right env', async () => {
  const { home, profiles } = fakeHome();
  const events = [];
  const svc = accounts.createAccounts({ home, profilesRoot: profiles, run: fakeRun([], { claudeWork: true }), appendEvent: (e) => events.push(e), bins: { claude: 'claude', codex: 'codex', gh: 'gh' } });
  assert.deepEqual(svc.assignedFor('intelio'), { claude: 'default', codex: 'default', github: 'default' });
  assert.deepEqual(svc.assign({ profile: 'intelio', tool: 'claude', account: 'work' }), { claude: 'work', codex: 'default', github: 'default' });
  const file = path.join(home, '.config', 'intelio', 'accounts.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agents, { intelio: { claude: 'work' } });
  assert.deepEqual(svc.envFor('intelio'), { CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') });
  assert.deepEqual(svc.envFor('prc'), {});
  assert.throws(() => svc.assign({ profile: 'intelio', tool: 'claude', account: 'nope' }), /not on this server/);
  assert.throws(() => svc.assign({ profile: 'intelio', tool: 'hermes', account: 'default' }), /Unknown tool/);
  const status = await svc.status('intelio', { fresh: true });
  assert.equal(status.accounts.find((r) => r.id === 'claude:work').assigned, true);
  assert.equal(status.accounts.find((r) => r.id === 'claude:default').assigned, false);
  svc.assign({ profile: 'intelio', tool: 'claude', account: 'default' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agents, {});
  assert.equal(events[0].kind, 'account');
  // Hermes config is never touched.
  assert.doesNotMatch(fs.readFileSync(path.join(profiles, 'intelio', 'config.yaml'), 'utf8'), /claude-work/);
});

test('sign-in runs in a tmux window, the paste-back code goes over stdin only, and the result is verified', async () => {
  const { home, profiles } = fakeHome();
  const calls = [];
  const events = [];
  let signedIn = false;
  let screen = '';
  const CODE = 'abcDEF123#state-XYZ789';
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args: [...args], input: opts.input, env: opts.env });
    const tool = path.basename(file);
    if (tool === 'tmux') {
      if (args[0] === 'has-session') return { code: 1, stdout: '' };
      if (args[0] === 'new-window') { screen = 'Browser didn\'t open? Use the url below to sign in:\nhttps://claude.ai/oauth/authorize?client_id=x&state=y\nPaste code here if prompted >'; return { code: 0, stdout: '@7\n' }; }
      if (args[0] === 'capture-pane') return { code: 0, stdout: screen };
      if (args[0] === 'display-message') return { code: 0, stdout: '0\n' };
      if (args[0] === 'paste-buffer') { signedIn = true; return { code: 0, stdout: '' }; }
      return { code: 0, stdout: '' };
    }
    if (tool === 'claude') return { code: 0, stdout: JSON.stringify(!opts.env.CLAUDE_CONFIG_DIR ? { loggedIn: true, email: 'owner@example.com' } : signedIn ? { loggedIn: true, email: 'ops@example.com' } : { loggedIn: false }) };
    return { code: 0, stdout: '' };
  };
  const svc = accounts.createAccounts({ home, profilesRoot: profiles, run, appendEvent: (e) => events.push(e), bins: { claude: 'claude', codex: 'codex', gh: 'gh', tmux: 'tmux' } });
  await assert.rejects(svc.startSignIn({ profile: 'intelio', tool: 'claude', name: 'default' }), /already signed in/);
  await assert.rejects(svc.startSignIn({ profile: 'intelio', tool: 'hermes', name: 'x' }), /Claude Code, Codex and GitHub/);
  await assert.rejects(svc.startSignIn({ profile: 'intelio', tool: 'claude', name: 'Bad Name!' }), /lowercase/);
  const started = await svc.startSignIn({ profile: 'intelio', tool: 'claude', name: 'ops' });
  assert.equal(started.state, 'waiting');
  assert.equal(new URL(started.url).hostname, 'claude.ai');
  assert.equal(started.needsCode, true);
  assert.ok(fs.statSync(path.join(home, '.claude-ops')).isDirectory());
  const win = calls.find((c) => c.args[0] === 'new-window');
  assert.ok(win.args.includes(`CLAUDE_CONFIG_DIR=${path.join(home, '.claude-ops')}`));
  assert.deepEqual(win.args.slice(-3), ['auth', 'login', '--claudeai']);
  await assert.rejects(svc.submitCode({ id: started.id, code: 'x' }), /does not look right/);
  const sent = await svc.submitCode({ id: started.id, code: ` ${CODE}\n` });
  assert.equal(sent.state, 'verifying');
  assert.equal(calls.find((c) => c.args[0] === 'load-buffer').input, CODE);
  assert.ok(calls.find((c) => c.args[0] === 'paste-buffer').args.includes('-d'));
  for (const call of calls) assert.equal(call.args.join(' ').includes(CODE), false, 'the code is never on a command line');
  const done = await svc.signInState(started.id);
  assert.equal(done.state, 'done');
  assert.equal(done.account, 'ops@example.com');
  assert.ok(calls.some((c) => c.args[0] === 'kill-window' && c.args.includes('@7')));
  assert.ok(calls.some((c) => c.args[0] === 'clear-history'));
  assert.deepEqual(events.map((e) => e.action), ['started', 'signed-in']);
  assert.equal(JSON.stringify(events).includes(CODE), false);
  assert.equal(JSON.stringify(done).includes(CODE), false);
  await assert.rejects(svc.submitCode({ id: started.id, code: CODE }), /no longer open/);
});

test('GitHub sign-in presses Enter once and keeps its own GH_CONFIG_DIR', async () => {
  const { home, profiles } = fakeHome();
  const calls = [];
  const run = async (file, args, opts = {}) => {
    calls.push({ file, args: [...args], env: opts.env });
    if (path.basename(file) === 'tmux') {
      if (args[0] === 'new-window') return { code: 0, stdout: '@9\n' };
      if (args[0] === 'capture-pane') return { code: 0, stdout: '! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser...' };
      if (args[0] === 'display-message') return { code: 0, stdout: '0' };
      return { code: 0, stdout: '' };
    }
    if (path.basename(file) === 'gh') return { code: 1, stdout: 'You are not logged into any GitHub hosts.' };
    return { code: 0, stdout: '' };
  };
  const svc = accounts.createAccounts({ home, profilesRoot: profiles, run, appendEvent: () => {}, bins: { gh: 'gh', tmux: 'tmux' } });
  const started = await svc.startSignIn({ profile: 'prc', tool: 'github', name: 'client-bot' }).catch((e) => e);
  assert.match(String(started.message || ''), /not found|Unknown/i, 'unknown profile dirs are refused');
  const row = await svc.startSignIn({ profile: 'intelio', tool: 'github', name: 'client-bot' });
  assert.equal(row.userCode, '1A2B-3C4D');
  assert.equal(row.url, 'https://github.com/login/device');
  await svc.signInState(row.id);
  assert.equal(calls.filter((c) => c.args[0] === 'send-keys').length, 1);
  const win = calls.find((c) => c.args[0] === 'new-window');
  assert.ok(win.args.includes(`GH_CONFIG_DIR=${path.join(home, '.config', 'gh-client-bot')}`));
  assert.ok(win.args.includes('--web'));
  const cancelled = await svc.cancelSignIn(row.id);
  assert.equal(cancelled.state, 'cancelled');
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
test('a real tmux window carries a pasted code to the CLI without putting it on argv', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const { home, profiles } = fakeHome();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // A stand-in "claude": prints a sign-in URL, reads the pasted code, records only its length.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/ok" ]; then echo '{"loggedIn":true,"email":"ops@example.com"}'; else echo '{"loggedIn":false}'; fi
  exit 0
fi
echo "Use the url below to sign in:"
echo "https://claude.ai/oauth/authorize?state=demo"
printf "Paste code here if prompted > "
read code
printf "%s" "\${#code}" > "$CLAUDE_CONFIG_DIR/ok"
sleep 30
`, { mode: 0o755 });
  const socket = `intelio-acct-test-${process.pid}`;
  const svc = accounts.createAccounts({ home, profilesRoot: profiles, appendEvent: () => {}, bins: { claude: path.join(bin, 'claude'), tmux: 'tmux' }, tmuxSocket: socket });
  try {
    let row = await svc.startSignIn({ profile: 'intelio', tool: 'claude', name: 'ops' });
    for (let i = 0; i < 20 && !row.needsCode; i += 1) { await new Promise((r) => setTimeout(r, 150)); row = await svc.signInState(row.id); }
    assert.equal(row.needsCode, true);
    assert.equal(row.url, 'https://claude.ai/oauth/authorize?state=demo');
    await svc.submitCode({ id: row.id, code: 'code#1234567' });
    for (let i = 0; i < 20 && row.state !== 'done'; i += 1) { await new Promise((r) => setTimeout(r, 150)); row = await svc.signInState(row.id); }
    assert.equal(row.state, 'done');
    assert.equal(row.account, 'ops@example.com');
    assert.equal(fs.readFileSync(path.join(home, '.claude-ops', 'ok'), 'utf8'), '12');
    const windows = spawnSync('tmux', ['-L', socket, 'list-windows', '-a', '-F', '#{window_name}'], { encoding: 'utf8' }).stdout;
    assert.equal(windows.includes('signin-claude-ops'), false, 'the sign-in window is closed afterwards');
    const buffers = spawnSync('tmux', ['-L', socket, 'list-buffers'], { encoding: 'utf8' }).stdout;
    assert.equal(buffers.includes('code#1234567'), false, 'no tmux buffer keeps the code');
  } finally {
    spawnSync('tmux', ['-L', socket, 'kill-server']);
  }
});

/* ---------------- HTTP routes ---------------- */

function request(port, method, pathname, { body, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...headers, ...(origin ? { origin, host: `127.0.0.1:${port}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('the accounts and activity routes sit behind the normal sign-in and refuse cross-site writes', async () => {
  const { home, profiles } = fakeHome();
  const activityFile = path.join(home, '.config', 'intelio', 'activity.jsonl');
  log.appendActivity({ profile: 'intelio', kind: 'vault', action: 'fill', summary: `Filled login secret=${SECRET}` }, { file: activityFile });
  const seen = [];
  const fakeService = {
    status: async (profile, opts) => { seen.push(['status', profile, opts.fresh]); return { profile, accounts: [] }; },
    startSignIn: async (args) => { seen.push(['start', args]); return { id: 'abc', state: 'waiting' }; },
    signInState: async (id) => ({ id, state: 'waiting' }),
    submitCode: async ({ id, code }) => { seen.push(['code', id, code.length]); return { id, state: 'verifying' }; },
    cancelSignIn: async (id) => ({ id, state: 'cancelled' }),
    assign: ({ profile, tool, account }) => ({ [tool]: account, profile }),
  };
  let allow = true;
  const logs = [];
  const app = createPwaServer({ bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', profileKey: 'k', vaultRoot: profiles, profileHome: home, accounts: fakeService, activityFile, log: (line) => logs.push(line), identify: async () => (allow ? { ok: true, login: 'owner@example' } : { ok: false, reason: 'nope' }) });
  const { port } = await app.listen();
  const origin = `http://127.0.0.1:${port}`;
  try {
    const got = await request(port, 'GET', '/api/accounts?profile=intelio&fresh=1');
    assert.equal(got.status, 200);
    assert.deepEqual(seen[0], ['status', 'intelio', true]);
    assert.equal((await request(port, 'POST', '/api/accounts/signin', { body: JSON.stringify({ profile: 'intelio', tool: 'claude', name: 'ops' }) })).status, 403, 'no Origin: refused');
    assert.equal((await request(port, 'POST', '/api/accounts/signin', { body: '{}', origin: 'https://evil.example' })).status, 403);
    const started = await request(port, 'POST', '/api/accounts/signin', { origin, body: JSON.stringify({ profile: 'intelio', tool: 'claude', name: 'ops' }) });
    assert.equal(started.status, 200);
    assert.equal(JSON.parse(started.body).id, 'abc');
    const code = await request(port, 'POST', '/api/accounts/signin/code', { origin, body: JSON.stringify({ id: 'abc', code: 'pasted#code-1234' }) });
    assert.equal(code.status, 200);
    assert.equal(code.body.includes('pasted#code-1234'), false);
    assert.equal(logs.join('\n').includes('pasted#code-1234'), false);
    assert.equal((await request(port, 'GET', '/api/accounts/signin?id=abc')).status, 200);
    assert.equal((await request(port, 'POST', '/api/accounts/signin/cancel', { origin, body: JSON.stringify({ id: 'abc' }) })).status, 200);
    const assigned = await request(port, 'POST', '/api/accounts/assign', { origin, body: JSON.stringify({ profile: 'intelio', tool: 'claude', account: 'ops' }) });
    assert.equal(JSON.parse(assigned.body).assigned.claude, 'ops');
    const activity = await request(port, 'GET', '/api/activity?agent=intelio&kind=vault');
    const rows = JSON.parse(activity.body).data;
    assert.equal(rows.length, 1);
    assert.equal(activity.body.includes(SECRET), false);
    allow = false;
    const denied = await request(port, 'GET', '/api/accounts?profile=intelio', { headers: { cookie: '' } });
    assert.equal(denied.status, 401);
    assert.equal((await request(port, 'GET', '/api/activity')).status, 401);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('sample mode shows fixed rows and never starts a sign-in', async () => {
  const app = createPwaServer({ bind: '127.0.0.1', port: 0, sample: true, upstream: 'http://127.0.0.1:9' });
  const { port } = await app.listen();
  try {
    const got = JSON.parse((await request(port, 'GET', '/api/accounts?profile=intelio')).body);
    assert.equal(got.sample, true);
    assert.ok(got.accounts.some((row) => row.id === 'claude:default' && row.account === 'owner@example.com'));
    const start = await request(port, 'POST', '/api/accounts/signin', { origin: `http://127.0.0.1:${port}`, body: JSON.stringify({ tool: 'claude', name: 'x' }) });
    assert.equal(start.status, 409);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

/* ---------------- UI helpers and wiring ---------------- */

test('UI helpers map requests to the same routes the main process proxies', () => {
  assert.equal(ui.route('accounts', { profile: 'prc', fresh: true }).path, '/api/accounts?fresh=1&profile=prc');
  assert.deepEqual(ui.route('accounts-code', { profile: 'prc', id: 'a', code: 'c' }).body, { profile: 'prc', id: 'a', code: 'c' });
  assert.match(ui.route('activity', { profile: 'intelio', agent: 'prc', kind: 'github' }).path, /^\/api\/activity\?agent=prc&kind=github&profile=intelio$/);
  assert.equal(ui.route('nope'), null);
  assert.equal(ui.relTime(new Date(Date.now() - 5 * 60000).toISOString()), '5m ago');
  assert.equal(ui.relTime(''), '');
  assert.equal(ui.planLabel('max'), 'Max plan');
  assert.deepEqual(ui.clientRows({ clients: { hhp: { account: 'someone@example.com', signedIn: true, suite: 'microsoft' } } }, 'hhp', null)[0].signedIn, true);
  assert.deepEqual(ui.clientRows({ clients: {} }, 'hhp', null), []);
});

test('the Accounts tab and Settings > Activity are wired in desktop and phone, with no main-screen UI', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(read('desktop/src/agent-card-ui.js'), /\['accounts', 'Accounts'\]/);
  assert.match(read('desktop/src/index.html'), /<script src="accounts-ui\.js"><\/script>/);
  assert.match(read('desktop/src/renderer.js'), /IntelioAccounts\.appendActivity/);
  assert.match(read('mobile/pwa/public/app.js'), /\['accounts', 'Accounts'\]/);
  assert.match(read('mobile/pwa/public/index.html'), /\/ui\/accounts-ui\.js/);
  const css = read('desktop/src/accounts.css');
  assert.equal(/#(ff0|ffff00|fde047|facc15|eab308|ca8a04|a3e635|84cc16|65a30d|bef264|d9f99d|00ff00|32cd32)\b|yellow|lime/i.test(css), false, 'no yellow or lime');
  const uiText = read('desktop/src/accounts-ui.js');
  assert.equal(/Intelio(?![A-Za-z])/.test(uiText.replace(/IntelioAccounts|IntelioClientApps/g, '')), false, 'brand is all-lowercase intelio');
  assert.equal(/Needs you/i.test(uiText), false);
  assert.equal(/Notification|notify\(/.test(uiText), false, 'the activity log raises no notifications');
});

test('accounts pane fills in after it is attached (load starts before the pane is in the page)', async () => {
  const body = { isRoot: true, children: [] };
  const make = (tag) => {
    const node = {
      tag, className: '', dataset: {}, children: [], parent: null, textContent: '', attrs: {},
      append(...items) { for (const item of items) { if (item && typeof item === 'object') { item.parent = node; node.children.push(item); } } },
      replaceChildren(...items) { node.children = []; node.append(...items); },
      addEventListener() {}, setAttribute(k, v) { node.attrs[k] = v; },
      get isConnected() { let at = node.parent; while (at) { if (at.isRoot) return true; at = at.parent; } return false; },
    };
    return node;
  };
  const saved = { document: globalThis.document, fetch: globalThis.fetch, location: globalThis.location };
  const modulePath = require.resolve('../src/accounts-ui.js');
  delete require.cache[modulePath];
  try {
    globalThis.document = { createElement: make };
    globalThis.location = { protocol: 'http:' };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async () => { await gate; return { ok: true, json: async () => ({ profile: 'intelio', generatedAt: new Date().toISOString(), accounts: [{ id: 'github:default', group: 'github', tool: 'github', name: 'default', label: 'GitHub', account: 'octo', signedIn: true }] }) }; };
    const ui = require(modulePath);
    const host = ui.pane('intelio');
    body.children.push(host); host.parent = body; // attached after pane() returns, like the agent card does
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const find = (node, cls) => (String(node.className).split(' ').includes(cls) ? [node] : []).concat(...node.children.map((child) => find(child, cls)));
    assert.equal(find(host, 'acct-row').length, 1);
    assert.equal(find(host, 'acct-who')[0].textContent, 'octo');
  } finally {
    delete require.cache[modulePath];
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
});
