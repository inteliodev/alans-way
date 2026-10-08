'use strict';
/**
 * intelio workspace core. Hermes Agent (profile `builder`) is the only driver:
 * every task is a git worktree + branch, a tmux session, and `hermes -p builder chat`
 * runs streamed to data/runs/<id>.jsonl. Codex / Claude Code / Cursor are optional
 * helpers Hermes may delegate to (via skills), chosen per task.
 *
 * Push policy: agents may commit, push feature branches and open/update PRs.
 * Only changes that land on the default branch need Hayden's click (Merge to main):
 * enforced by the per-worktree pre-push hook + gh/git wrappers on the agent PATH.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { normalize } = require('./normalize.cjs');

const HOME = os.homedir();
const APP = path.resolve(__dirname, '..');
const DATA = path.join(APP, 'data');
const RUNS = path.join(DATA, 'runs');
const TASKS_FILE = path.join(DATA, 'tasks.json');
const MODELS_FILE = path.join(DATA, 'models.json');
const WS = path.join(HOME, 'workspaces');
const REPOS = path.join(WS, 'repos');
const TASKDIR = path.join(WS, 'tasks');
const GRANTS = path.join(WS, 'grants');
const HOOKS = path.join(WS, 'hooks');
const WSBIN = path.join(WS, 'bin');
const CODE = path.join(HOME, 'code');
const BUILDER = path.join(HOME, '.hermes', 'profiles', 'builder');
const TMUX_SOCK = 'intelio-ws';
const TMUX_CONF = path.join(APP, 'tmux.conf');
const MAX_RUNNING = 2;
const TOOLSETS = 'terminal,file,browser,web,delegation,skills,todo,code_execution';
const ENGINE_PATH = [WSBIN, path.join(HOME, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':');

for (const d of [DATA, RUNS, REPOS, TASKDIR, GRANTS, HOOKS, WSBIN]) fs.mkdirSync(d, { recursive: true });

let log = (...a) => console.log(new Date().toISOString(), ...a);
function setLogger(fn) { log = fn; }

// ---------------------------------------------------------------- exec helpers
function run(cmd, args, { cwd, env, timeout = 120000, input, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env: env || { ...process.env, PATH: ENGINE_PATH }, timeout, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && !stdout ? String(err.message || '') : '') });
    });
    if (input != null) child.stdin.end(input);
  });
}
async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.filter((a) => !/\s/.test(a)).slice(0, 4).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  return r.stdout;
}
const realGit = (cwd, args, opts = {}) => run('/usr/bin/git', ['-C', cwd, ...args], opts);
const gitMust = (cwd, args, opts = {}) => must('/usr/bin/git', ['-C', cwd, ...args], opts);
const tmux = (args, opts) => run('tmux', ['-L', TMUX_SOCK, '-f', TMUX_CONF, ...args], opts);
function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// ---------------------------------------------------------------- store
let tasks = [];
try { tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { tasks = []; }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${TASKS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    fs.renameSync(tmp, TASKS_FILE);
  }, 50);
}
function touch(t, fields = {}) { Object.assign(t, fields, { updated: Date.now() }); save(); }
function getTask(id) { return tasks.find((t) => t.id === id) || null; }
function publicTask(t) { const { pending, ...rest } = t; return { ...rest, pendingCount: (pending || []).length }; }
function listTasks() { return tasks.slice().sort((a, b) => b.updated - a.updated).map(publicTask); }
function summary() {
  return {
    running: tasks.filter((t) => t.status === 'running').length,
    queued: tasks.filter((t) => t.status === 'queued').length,
    needsYou: tasks.filter((t) => t.status === 'needs-you').length,
    tasks: tasks.slice().sort((a, b) => b.updated - a.updated).map((t) => ({ id: t.id, title: t.title, status: t.status, repo: t.repo, updated: t.updated })),
  };
}

// ---------------------------------------------------------------- models (Hermes providers) + helpers
const PROVIDERS = [
  { id: 'openai-codex', label: 'ChatGPT (openai-codex)', defaults: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'], login: 'hermes -p builder auth add openai-codex --no-browser' },
  { id: 'copilot', label: 'GitHub Copilot', defaults: ['claude-opus-5.5', 'claude-sonnet-5.5', 'gpt-5.5', 'gemini-3.8-flash'], login: 'gh auth login (needs a Copilot plan), then hermes -p builder auth add copilot' },
  { id: 'anthropic', label: 'Anthropic (Claude)', defaults: ['claude-opus-5-5', 'claude-sonnet-5-5'], login: 'hermes -p builder auth add anthropic' },
  { id: 'xai-oauth', label: 'Grok (3 accounts, rotating)', defaults: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1', 'grok-4-fast'], login: 'hermes -p default auth add xai-oauth --no-browser' },
  { id: 'openrouter', label: 'OpenRouter', defaults: [], login: 'hermes -p builder auth add openrouter --type api-key' },
  { id: 'nous', label: 'Nous Portal', defaults: [], login: 'hermes -p builder auth add nous --no-browser' },
  { id: 'gemini', label: 'Google Gemini', defaults: [], login: 'hermes -p builder auth add gemini --type api-key' },
];
const HELPERS = [
  { id: 'codex', label: 'Codex', skill: 'codex', check: ['codex', ['login', 'status']], ok: (r) => r.code === 0 && /logged in/i.test(r.stdout + r.stderr), login: 'codex login --device-auth' },
  { id: 'claude', label: 'Claude Code', skill: 'claude-code', check: ['claude', ['auth', 'status']], ok: (r) => /"loggedIn":\s*true/.test(r.stdout), login: 'claude auth login' },
  { id: 'cursor', label: 'Cursor', skill: 'cursor-agent', check: ['cursor-agent', ['status']], ok: (r) => r.code === 0 && !/not logged in/i.test(r.stdout + r.stderr), login: 'NO_OPEN_BROWSER=1 ~/.local/bin/cursor-agent login' },
];
let probes = {};
try { probes = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch { probes = {}; }
const STATUS_FILE = path.join(DATA, 'status.json');
const statusCache = { at: 0, providers: [], helpers: [], builder: false };
try { Object.assign(statusCache, JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))); } catch { /* first run */ }

async function refreshStatus() {
  const builder = fs.existsSync(path.join(BUILDER, 'config.yaml'));
  let cached = {};
  try { const c = JSON.parse(fs.readFileSync(path.join(BUILDER, 'provider_models_cache.json'), 'utf8')); for (const [k, v] of Object.entries(c)) cached[k] = v.models || []; } catch { cached = {}; }
  const providers = [];
  for (const p of PROVIDERS) {
    const r = builder ? await run('hermes', ['-p', 'builder', 'auth', 'status', p.id], { cwd: '/tmp', timeout: 30000 }) : { code: 1, stdout: '' };
    let signedIn = /logged in/i.test(r.stdout) && !/logged out/i.test(r.stdout);
    // Hermes borrows Claude Code's login (~/.claude/.credentials.json) for anthropic.
    if (!signedIn && p.id === 'anthropic' && fs.existsSync(path.join(HOME, '.claude', '.credentials.json'))) signedIn = true;
    const models = (cached[p.id] && cached[p.id].length ? cached[p.id] : p.defaults).filter((m) => !/-900k$|search|exec-agent/.test(m)).slice(0, 14);
    const probed = models.map((m) => probes[`${p.id}/${m}`]).filter(Boolean);
    const noAccess = signedIn && probed.length && probed.every((x) => !x.ok);
    providers.push({ id: p.id, label: p.label, signedIn, state: !signedIn ? 'needs-sign-in' : noAccess ? 'no-working-models' : 'ready', login: p.login,
      models: models.map((m) => ({ id: m, probe: probes[`${p.id}/${m}`] || null })) });
  }
  const helpers = [];
  for (const h of HELPERS) {
    const bin = [path.join(HOME, '.local', 'bin', h.check[0]), `/usr/bin/${h.check[0]}`].find((p) => fs.existsSync(p));
    if (!bin) { helpers.push({ id: h.id, label: h.label, state: 'not-installed', login: h.login }); continue; }
    const r = await run(bin, h.check[1], { cwd: '/tmp', timeout: 30000 });
    helpers.push({ id: h.id, label: h.label, skill: h.skill, state: h.ok(r) ? 'ready' : 'needs-sign-in', login: h.login });
  }
  Object.assign(statusCache, { at: Date.now(), providers, helpers, builder });
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(statusCache)); } catch { /* best effort */ }
  return statusCache;
}
function engineStatus() { return { builder: statusCache.builder, providers: statusCache.providers, helpers: statusCache.helpers, checkedAt: statusCache.at, defaultModel: { provider: 'openai-codex', model: 'gpt-6-sol' } }; }

async function probeModel(provider, model) {
  if (!PROVIDERS.some((p) => p.id === provider) || !/^[A-Za-z0-9._:/-]{1,80}$/.test(model)) throw new Error('bad model');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-probe-'));
  const q = path.join(dir, 'q.txt');
  fs.writeFileSync(q, 'Reply with exactly: ok');
  const r = await run('hermes', ['-p', 'builder', 'chat', '--query-file', q, '--format', 'stream-json', '--in', dir, '--source', 'tool', '-t', 'todo', '--provider', provider, '-m', model], { cwd: dir, timeout: 120000 });
  fs.rmSync(dir, { recursive: true, force: true });
  let ok = false; let error = '';
  for (const line of r.stdout.split('\n')) {
    try { const j = JSON.parse(line); if (j.type === 'result') { ok = j.exit_code === 0 && !j.error && /ok/i.test(j.text || ''); error = j.error || (ok ? '' : String(j.text || '').slice(0, 200)); } } catch { /* not json */ }
  }
  if (!ok && !error) error = (r.stdout.split('\n').find((l) => l && !l.startsWith('{')) || r.stderr || 'no result').slice(0, 300);
  probes[`${provider}/${model}`] = { ok, error, at: Date.now() };
  fs.writeFileSync(MODELS_FILE, JSON.stringify(probes, null, 2));
  await refreshStatus();
  return probes[`${provider}/${model}`];
}

// ---------------------------------------------------------------- repos
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GH_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

async function listRepos() {
  const out = [];
  const seen = new Set();
  for (const base of [CODE, REPOS]) {
    let names = [];
    try { names = await fsp.readdir(base); } catch { continue; }
    for (const n of names.sort()) {
      if (!NAME_RE.test(n) || seen.has(n) || !fs.existsSync(path.join(base, n, '.git'))) continue;
      seen.add(n);
      out.push({ name: n, source: base === CODE ? 'code' : 'workspace' });
    }
  }
  return out;
}

async function validateGithub(spec) {
  if (!GH_RE.test(spec)) return { ok: false, error: 'Use owner/repo.' };
  const r = await run('/usr/bin/gh', ['repo', 'view', spec, '--json', 'name,nameWithOwner,defaultBranchRef,visibility'], { timeout: 20000 });
  if (r.code !== 0) return { ok: false, error: 'Repository not found or not accessible with gh.' };
  try { const j = JSON.parse(r.stdout); return { ok: true, name: j.name, nameWithOwner: j.nameWithOwner, defaultBranch: j.defaultBranchRef?.name || 'main', visibility: j.visibility }; }
  catch { return { ok: false, error: 'Unexpected gh output.' }; }
}

const repoLocks = new Map();
function withRepoLock(name, fn) {
  const prev = repoLocks.get(name) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  repoLocks.set(name, next.catch(() => {}));
  return next;
}
let gitIdentity = null;
async function ghIdentity() {
  if (gitIdentity) return gitIdentity;
  const r = await run('/usr/bin/gh', ['api', 'user', '--jq', '.login + " " + (.id|tostring)'], { timeout: 15000 });
  const [login, uid] = r.stdout.trim().split(' ');
  gitIdentity = login ? { name: login, email: `${uid}+${login}@users.noreply.github.com` } : { name: 'intelio-workspace', email: 'intelio-workspace@localhost' };
  return gitIdentity;
}

/** ~/workspaces/repos/<name>: a no-checkout clone used as the worktree source. */
async function ensureRepo(spec) {
  const isGh = spec.includes('/');
  const name = isGh ? spec.split('/')[1] : spec;
  const dir = path.join(REPOS, name);
  return withRepoLock(name, async () => {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      if (isGh) await must('/usr/bin/gh', ['repo', 'clone', spec, dir, '--', '--no-checkout'], { timeout: 600000 });
      else {
        const src = path.join(CODE, name);
        if (!fs.existsSync(path.join(src, '.git'))) throw new Error(`~/code/${name} is not a git repo`);
        const origin = (await realGit(src, ['remote', 'get-url', 'origin'])).stdout.trim();
        await must('/usr/bin/git', ['clone', '--no-checkout', origin || src, dir], { timeout: 600000 });
      }
      await gitMust(dir, ['config', 'core.repositoryformatversion', '1']);
      await gitMust(dir, ['config', 'extensions.worktreeConfig', 'true']);
      const id = await ghIdentity();
      await gitMust(dir, ['config', 'user.name', id.name]);
      await gitMust(dir, ['config', 'user.email', id.email]);
    }
    await gitMust(dir, ['fetch', 'origin', '--prune'], { timeout: 600000 });
    let head = (await realGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
    if (!head) { await realGit(dir, ['remote', 'set-head', 'origin', '-a'], { timeout: 60000 }); head = (await realGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim(); }
    const base = head ? head.replace(/^origin\//, '') : 'main';
    const url = (await realGit(dir, ['remote', 'get-url', 'origin'])).stdout.trim();
    return { name, dir, base, url };
  });
}

// ---------------------------------------------------------------- runs log
const runFile = (id) => path.join(RUNS, `${id}.jsonl`);
function appendRun(id, obj) { fs.appendFileSync(runFile(id), `${JSON.stringify(obj)}\n`); }
function readRun(id) { try { return fs.readFileSync(runFile(id), 'utf8').split('\n'); } catch { return []; } }
function conversation(id) {
  let size = 0;
  try { size = fs.statSync(runFile(id)).size; } catch { size = 0; }
  const { turns, sessions } = normalize(readRun(id));
  return { version: size, turns, sessions };
}

// ---------------------------------------------------------------- tasks
function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task'; }
function cleanModel(m) {
  const provider = String(m?.provider || 'openai-codex');
  const model = String(m?.model || 'gpt-6-sol');
  if (!PROVIDERS.some((p) => p.id === provider) || !/^[A-Za-z0-9._:/-]{1,80}$/.test(model)) throw new Error('Pick a valid model.');
  const p = statusCache.providers.find((x) => x.id === provider);
  if (p && !p.signedIn) throw new Error(`${p.label} needs sign-in: ${p.login}`);
  return { provider, model };
}
function cleanHelpers(h) { return (Array.isArray(h) ? h : []).filter((x) => HELPERS.some((y) => y.id === x)); }
function parsePr(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^#?(\d{1,7})$/) || s.match(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/(\d{1,7})\b/);
  if (!m) throw new Error('PR must be a number or a github.com pull URL.');
  return Number(m[1]);
}

function createTask(body) {
  const brief = String(body.brief || '').trim();
  const repo = String(body.repo || '').trim();
  const prNumber = parsePr(body.pr);
  if (!brief && !prNumber) throw new Error('Brief is required.');
  if (brief.length > 50000) throw new Error('Brief is too long.');
  if (!(NAME_RE.test(repo) || GH_RE.test(repo))) throw new Error('Pick a repo.');
  if (!fs.existsSync(path.join(BUILDER, 'config.yaml'))) throw new Error('The Hermes builder profile is missing.');
  const model = cleanModel(body.model);
  const helpers = cleanHelpers(body.helpers);
  let title = String(body.title || '').trim().slice(0, 200);
  if (!title) title = prNumber ? `PR #${prNumber}` : brief.split('\n')[0].slice(0, 80);
  const id = crypto.randomBytes(4).toString('hex');
  const now = Date.now();
  const t = {
    id, title, repo: repo.includes('/') ? repo.split('/')[1] : repo, repoSpec: repo, prNumber,
    branch: prNumber ? null : `ws/${slugify(title)}-${id.slice(0, 4)}`, base: null, model, helpers,
    status: brief ? 'queued' : 'needs-you', setup: 'preparing', created: now, updated: now, worktree: path.join(TASKDIR, id),
    sessions: {}, pending: brief ? [{ text: brief, model }] : [], pr: null, preview: null,
  };
  tasks.push(t);
  save();
  appendRun(id, { ws: 'note', text: `Preparing worktree for ${repo}${prNumber ? ` (PR #${prNumber})` : ''}…`, ts: now });
  setupTask(t).catch((err) => {
    log('setup failed', id, err.message);
    appendRun(id, { ws: 'error', text: `Setup failed: ${err.message}`, ts: Date.now() });
    touch(t, { status: 'failed', setup: 'failed', pending: [] });
  });
  return publicTask(t);
}

async function setupTask(t) {
  const r = await ensureRepo(t.repoSpec);
  t.remote = r.url.replace(/\/\/[^@/]*@/, '//');
  if (t.prNumber) {
    const v = await run('/usr/bin/gh', ['pr', 'view', String(t.prNumber), '--json', 'number,url,title,headRefName,baseRefName,isDraft,state,isCrossRepository'], { cwd: r.dir, timeout: 30000 });
    if (v.code !== 0) throw new Error(`gh pr view #${t.prNumber}: ${(v.stderr || v.stdout).trim().slice(-300)}`);
    const pr = JSON.parse(v.stdout);
    t.base = pr.baseRefName;
    t.pr = { url: pr.url, number: pr.number, draft: pr.isDraft, state: pr.state, title: pr.title };
    if (t.title === `PR #${t.prNumber}`) t.title = pr.title;
    if (pr.isCrossRepository) {
      // Fork PR: read/edit locally on a private branch; pushing back to the fork is not supported.
      t.branch = `ws/pr-${pr.number}-${t.id.slice(0, 4)}`;
      t.crossRepo = true;
      await gitMust(r.dir, ['fetch', 'origin', `+refs/pull/${pr.number}/head:refs/remotes/origin/pr/${pr.number}`], { timeout: 300000 });
      await gitMust(r.dir, ['worktree', 'add', '--no-track', '-b', t.branch, t.worktree, `origin/pr/${pr.number}`], { timeout: 300000 });
    } else {
      t.branch = pr.headRefName;
      await gitMust(r.dir, ['fetch', 'origin', `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`], { timeout: 300000 });
      const exists = (await realGit(r.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${pr.headRefName}`])).code === 0;
      if (exists) {
        const add = await realGit(r.dir, ['worktree', 'add', t.worktree, pr.headRefName], { timeout: 300000 });
        if (add.code !== 0) throw new Error(`Branch ${pr.headRefName} is already checked out by another task. ${add.stderr.trim().slice(-200)}`);
        await realGit(t.worktree, ['merge', '--ff-only', `origin/${pr.headRefName}`]);
      } else {
        await gitMust(r.dir, ['worktree', 'add', '--track', '-b', pr.headRefName, t.worktree, `origin/${pr.headRefName}`], { timeout: 300000 });
      }
    }
  } else {
    t.base = r.base;
    await gitMust(r.dir, ['worktree', 'add', '--no-track', '-b', t.branch, t.worktree, `origin/${r.base}`], { timeout: 300000 });
  }
  await gitMust(t.worktree, ['config', '--worktree', 'core.hooksPath', HOOKS]);
  await gitMust(t.worktree, ['config', '--worktree', 'intelio.workspace.task', t.id]);
  await ensureSession(t);
  appendRun(t.id, { ws: 'note', text: t.prNumber ? `Worktree ready on ${t.branch} (PR #${t.prNumber} → ${t.base}).` : `Worktree ready on ${t.branch} (from origin/${t.base}).`, ts: Date.now() });
  touch(t, { setup: 'ready' });
  schedule();
}

function sessionEnv(t) { return [`PATH=${ENGINE_PATH}`, `INTELIO_WORKSPACE_TASK=${t.id}`, 'GIT_TERMINAL_PROMPT=0']; }
async function ensureSession(t) {
  if ((await tmux(['has-session', '-t', `=ws-${t.id}`])).code === 0) return;
  if (!fs.existsSync(t.worktree)) throw new Error('worktree missing');
  await must('tmux', ['-L', TMUX_SOCK, '-f', TMUX_CONF, 'new-session', '-d', '-s', `ws-${t.id}`, '-n', 'shell', '-c', t.worktree, '-x', '200', '-y', '50', ...sessionEnv(t).flatMap((e) => ['-e', e])]);
}
async function windows(t) {
  const r = await tmux(['list-windows', '-t', `=ws-${t.id}`, '-F', '#{window_index}\t#{window_name}\t#{pane_current_command}\t#{pane_pid}']);
  if (r.code !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [index, name, command, pid] = l.split('\t'); return { index: Number(index), name, command, pid: Number(pid) }; });
}

// ---------------------------------------------------------------- Hermes runs
function preamble(t) {
  const allowed = t.helpers.map((h) => HELPERS.find((x) => x.id === h)).filter(Boolean);
  const helperLine = allowed.length
    ? `You may hand work to these coding CLIs (load the matching skill first): ${allowed.map((h) => `${h.label} (skill: ${h.skill})`).join(', ')}. Review their diff before reporting.`
    : 'Do not delegate to external coding CLIs (Codex, Claude Code, Cursor) for this task; do the work yourself.';
  return [
    `You are the coding agent for the task "${t.title}". Work in the git worktree ${t.worktree} (branch ${t.branch}, base ${t.base}).`,
    t.pr ? `This task continues pull request ${t.pr.url}; keep pushing to branch ${t.branch}.` : '',
    'Push policy: you may commit, push this feature branch and open or update a pull request (gh pr create --draft). Never push to, merge into or rewrite the default branch (main/master) — only Hayden merges to main.',
    helperLine,
    'Do not install system packages. Finish with a short report: what changed, how to verify, and the PR link if you opened one.',
    '',
    'Task brief:',
  ].filter((x) => x !== '').join('\n');
}

const running = new Map();

async function startRun(t) {
  const job = t.pending.shift();
  if (!job) return;
  const model = job.model || t.model;
  const conv = conversation(t.id);
  const sessionId = conv.sessions.hermes || null;
  const prompt = sessionId ? job.text : `${preamble(t)}\n${job.text}`;
  const ts = Date.now();
  appendRun(t.id, { ws: 'user', text: job.text, engine: 'hermes', model, ts });
  const promptFile = path.join(RUNS, `${t.id}.prompt.txt`);
  fs.writeFileSync(promptFile, prompt);
  const skills = t.helpers.map((h) => HELPERS.find((x) => x.id === h)?.skill).filter(Boolean);
  const cmd = ['hermes', '-p', 'builder', 'chat', '--query-file', promptFile, '--format', 'stream-json', '--yolo', '--in', t.worktree,
    '--source', 'intelio-workspace', '-t', TOOLSETS, '--provider', model.provider, '-m', model.model];
  if (skills.length) cmd.push('-s', skills.join(','));
  if (sessionId) cmd.push('--resume', sessionId);
  const script = [
    '#!/bin/bash',
    `cd ${shq(t.worktree)} || exit 1`,
    `export PATH=${shq(ENGINE_PATH)} INTELIO_WORKSPACE_TASK=${t.id} GIT_TERMINAL_PROMPT=0`,
    'unset INTELIO_WS_GRANT INTELIO_PUSH_GRANT',
    `${cmd.map(shq).join(' ')} < /dev/null >> ${shq(runFile(t.id))} 2>> ${shq(path.join(RUNS, `${t.id}.err.log`))}`,
    'code=$?',
    `printf '{"ws":"end","code":%d,"ts":%s}\\n' "$code" "$(date +%s%3N)" >> ${shq(runFile(t.id))}`,
  ].join('\n');
  const scriptFile = path.join(RUNS, `${t.id}.run.sh`);
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o700 });
  await ensureSession(t);
  await tmux(['kill-window', '-t', `=ws-${t.id}:agent`]);
  const r = await tmux(['new-window', '-d', '-t', `=ws-${t.id}:`, '-n', 'agent', '-c', t.worktree, `bash ${shq(scriptFile)}`]);
  if (r.code !== 0) {
    appendRun(t.id, { ws: 'error', text: `Could not start Hermes: ${r.stderr.trim()}`, ts: Date.now() });
    appendRun(t.id, { ws: 'end', code: 1, ts: Date.now() });
    running.delete(t.id);
    touch(t, { status: 'failed' });
    return;
  }
  running.set(t.id, { start: ts, stopping: false });
  touch(t, { status: 'running', model });
  log('run started', t.id, `${model.provider}/${model.model}`, sessionId ? 'resume' : 'new');
}

function schedule() {
  const queued = tasks.filter((t) => t.status === 'queued' && t.setup === 'ready' && (t.pending || []).length && !running.has(t.id)).sort((a, b) => a.updated - b.updated);
  for (const t of queued) {
    if (running.size >= MAX_RUNNING) break;
    running.set(t.id, { start: Date.now(), stopping: false });
    startRun(t).catch((err) => {
      running.delete(t.id);
      appendRun(t.id, { ws: 'error', text: `Run start failed: ${err.message}`, ts: Date.now() });
      touch(t, { status: 'failed' });
    });
  }
}

function lastEnd(id) {
  const lines = readRun(id).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('{"ws":"user"')) return null;
    if (lines[i].startsWith('{"ws":"end"')) { try { return JSON.parse(lines[i]); } catch { return null; } }
  }
  return null;
}

async function monitor() {
  if (!running.size) return;
  const r = await tmux(['list-windows', '-a', '-F', '#{session_name}:#{window_name}']);
  const alive = new Set(r.code === 0 ? r.stdout.trim().split('\n') : []);
  for (const [id, info] of [...running]) {
    const t = getTask(id);
    if (!t) { running.delete(id); continue; }
    if (t.status !== 'running' || alive.has(`ws-${id}:agent`)) continue;
    let end = lastEnd(id);
    if (!end) {
      if (info.stopping) appendRun(id, { ws: 'note', text: 'Stopped by Hayden.', ts: Date.now() });
      end = { ws: 'end', code: info.stopping ? 130 : -1, ts: Date.now() };
      appendRun(id, end);
    }
    running.delete(id);
    const conv = conversation(id);
    const status = (t.pending || []).length ? 'queued' : (end.code === 0 || info.stopping ? 'needs-you' : 'failed');
    touch(t, { status, sessions: { ...t.sessions, ...conv.sessions } });
    log('run ended', id, end.code, status);
    prStatus(t).catch(() => {});
  }
  schedule();
}

async function reconcile() {
  for (const t of tasks) {
    if (t.status === 'running') running.set(t.id, { start: Date.now(), stopping: false });
    if (t.setup === 'preparing') { touch(t, { setup: 'failed', status: 'failed' }); appendRun(t.id, { ws: 'error', text: 'Runner restarted during setup.', ts: Date.now() }); }
    if (t.preview) {
      const alive = await probe(t.preview.port);
      if (alive) { try { startForward(t); } catch (e) { t.preview = null; } } else { await tmux(['kill-window', '-t', `=ws-${t.id}:dev`]); t.preview = null; }
    }
    if (!t.model) t.model = { provider: 'openai-codex', model: 'gpt-6-sol' };
    if (!Array.isArray(t.helpers)) t.helpers = [];
    delete t.engine;
  }
  save();
  await refreshStatus().catch((e) => log('status', e.message));
  await monitor();
  schedule();
}

function message(t, { text, model }) {
  text = String(text || '').trim();
  if (!text) throw new Error('Message is empty.');
  if (text.length > 50000) throw new Error('Message is too long.');
  if (t.setup !== 'ready') throw new Error('Task worktree is not ready.');
  const m = cleanModel(model || t.model);
  t.pending = t.pending || [];
  t.pending.push({ text, model: m });
  if (t.status !== 'running') touch(t, { status: 'queued' }); else touch(t);
  schedule();
  return publicTask(t);
}

async function stop(t) {
  if (t.status === 'queued') { t.pending = []; touch(t, { status: 'needs-you' }); appendRun(t.id, { ws: 'note', text: 'Queued run cancelled.', ts: Date.now() }); return; }
  const info = running.get(t.id);
  if (!info) return;
  info.stopping = true;
  t.pending = [];
  await tmux(['kill-window', '-t', `=ws-${t.id}:agent`]);
  await monitor();
}

function setStatus(t, status) {
  if (!['done', 'needs-you'].includes(status)) throw new Error('bad status');
  if (t.status === 'running' || t.status === 'queued') throw new Error('Task is busy.');
  touch(t, { status });
}

function setHelpers(t, helpers) { touch(t, { helpers: cleanHelpers(helpers) }); return publicTask(t); }

// ---------------------------------------------------------------- changes / files
async function mergeBase(t) {
  const r = await realGit(t.worktree, ['merge-base', `origin/${t.base}`, 'HEAD']);
  return r.stdout.trim() || `origin/${t.base}`;
}
function splitPatch(text) {
  const files = [];
  for (const p of text.split(/^(?=diff --git )/m).filter((x) => x.startsWith('diff --git'))) {
    const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(p);
    let add = 0; let del = 0;
    for (const line of p.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) add++;
      else if (line.startsWith('-') && !line.startsWith('---')) del++;
    }
    const status = /^new file/m.test(p) ? 'added' : /^deleted file/m.test(p) ? 'deleted' : /^rename from/m.test(p) ? 'renamed' : 'modified';
    files.push({ path: m ? m[2] : '?', status, add, del, binary: /^Binary files/m.test(p), patch: p.length > 200000 ? `${p.slice(0, 200000)}\n… diff truncated` : p });
  }
  return files;
}
async function changes(t) {
  if (t.setup !== 'ready') return { files: [], commits: [], base: t.base, branch: t.branch, totals: { add: 0, del: 0 } };
  const mb = await mergeBase(t);
  const files = splitPatch((await realGit(t.worktree, ['diff', '--no-color', '--no-ext-diff', '-M', mb])).stdout);
  const untracked = (await realGit(t.worktree, ['ls-files', '--others', '--exclude-standard'])).stdout.split('\n').filter(Boolean).slice(0, 200);
  for (const f of untracked) {
    const r = await realGit(t.worktree, ['diff', '--no-color', '--no-index', '--', '/dev/null', f]);
    files.push(...splitPatch(r.stdout).map((x) => ({ ...x, path: f, status: 'added', untracked: true })));
  }
  const lg = await realGit(t.worktree, ['log', '--format=%h%x09%s%x09%an%x09%cr', `${mb}..HEAD`, '-n', '100']);
  const commits = lg.stdout.trim().split('\n').filter(Boolean).map((l) => { const [sha, subject, author, when] = l.split('\t'); return { sha, subject, author, when }; });
  const totals = files.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 });
  const dirty = (await realGit(t.worktree, ['status', '--porcelain'])).stdout.trim().length > 0;
  const ahead = Number((await realGit(t.worktree, ['rev-list', '--count', `origin/${t.branch}..HEAD`])).stdout.trim() || NaN);
  return { base: t.base, branch: t.branch, files, commits, totals, dirty, unpushed: Number.isNaN(ahead) ? commits.length : ahead };
}
async function fileList(t) {
  const all = (await realGit(t.worktree, ['ls-files', '-co', '--exclude-standard'])).stdout.split('\n').filter(Boolean);
  return { files: all.slice(0, 8000), truncated: all.length > 8000 };
}
function safePath(t, rel) {
  rel = String(rel || '');
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!rel || rel.includes('\0') || path.isAbsolute(rel)) throw bad('bad path');
  const root = fs.realpathSync(t.worktree);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw bad('path escapes worktree');
  const real = fs.realpathSync(full);
  if (!real.startsWith(root + path.sep)) throw bad('path escapes worktree');
  if (path.relative(root, real).split(path.sep)[0] === '.git') throw bad('not allowed');
  return real;
}
async function readFileSafe(t, rel) {
  const p = safePath(t, rel);
  const st = await fsp.stat(p);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
  if (st.size > 1024 * 1024) return { path: rel, size: st.size, tooLarge: true, content: '' };
  const buf = await fsp.readFile(p);
  if (buf.subarray(0, 8000).includes(0)) return { path: rel, size: st.size, binary: true, content: '' };
  return { path: rel, size: st.size, content: buf.toString('utf8') };
}

// ---------------------------------------------------------------- previews
const forwards = new Map();
let tlsOpts = null; let identifyFn = null; let bindHost = '127.0.0.1'; let publicHost = 'localhost';
function configurePreview({ cert, key, identify, bind, host }) { tlsOpts = { cert, key }; identifyFn = identify; bindHost = bind; publicHost = host; }
function freeSlot() {
  const used = new Set(tasks.filter((t) => t.preview).map((t) => t.preview.slot));
  for (let i = 1; i <= 9; i++) if (!used.has(i)) return i;
  return null;
}
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}
/**
 * TLS-terminating HTTP proxy on the Tailscale IP (8671-8679) -> 127.0.0.1:<dev port>.
 * Rewrites Host so dev servers with host checks (vite allowedHosts) accept it; passes
 * WebSocket upgrades (HMR) through. Every request/upgrade passes the Tailscale identity check.
 */
function startForward(t) {
  const { proxyPort, port } = t.preview;
  const upstreamHost = `127.0.0.1:${port}`;
  const deny = (res) => { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('This Tailscale identity is not allowed.\n'); };
  const server = https.createServer({ ...tlsOpts }, (req, res) => {
    identifyFn(req.socket.remoteAddress).then((id) => {
      if (!id.ok) return deny(res);
      const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: upstreamHost } }, (r) => {
        res.writeHead(r.statusCode || 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); } res.end('Dev server is not reachable yet.\n'); });
      req.pipe(up);
    }).catch(() => res.destroy());
  });
  server.on('upgrade', (req, sock, head) => {
    identifyFn(req.socket.remoteAddress).then((id) => {
      if (!id.ok) { sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      const up = net.connect({ host: '127.0.0.1', port }, () => {
        let h = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i];
          h += `${k}: ${k.toLowerCase() === 'host' ? upstreamHost : req.rawHeaders[i + 1]}\r\n`;
        }
        up.write(`${h}\r\n`);
        if (head && head.length) up.write(head);
        sock.pipe(up); up.pipe(sock);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    }).catch(() => sock.destroy());
  });
  server.on('tlsClientError', () => {});
  server.on('error', (err) => log('preview forward error', t.id, err.message));
  server.listen(proxyPort, bindHost);
  forwards.set(t.id, server);
}
async function previewStart(t) {
  if (t.setup !== 'ready') throw new Error('Task is not ready.');
  if (t.preview) return previewStatus(t);
  let pkg;
  try { pkg = JSON.parse(await fsp.readFile(path.join(t.worktree, 'package.json'), 'utf8')); } catch { throw new Error('No package.json in the worktree root.'); }
  if (!pkg.scripts?.dev) throw new Error('package.json has no "dev" script.');
  const slot = freeSlot();
  if (!slot) throw new Error('All 9 preview slots are in use. Stop another preview first.');
  const port = 5170 + slot;
  const proxyPort = 8670 + slot;
  if (await probe(port)) throw new Error(`Port ${port} is already in use.`);
  t.preview = { slot, port, proxyPort, started: Date.now() };
  const devBin = (pkg.scripts.dev.trim().split(/\s+/)[0] || '').replace(/[^A-Za-z0-9._-]/g, '');
  const installed = devBin && fs.existsSync(path.join(t.worktree, 'node_modules', '.bin', devBin));
  const install = installed ? 'true' : fs.existsSync(path.join(t.worktree, 'package-lock.json')) ? 'npm ci --include=dev --no-audit --no-fund' : 'npm install --include=dev --no-audit --no-fund';
  const isVite = /\bvite\b/.test(pkg.scripts.dev);
  const devArgs = isVite ? `-- --host 127.0.0.1 --port ${port} --strictPort` : '';
  const cmd = `export NODE_ENV=development; ${install} && echo '[intelio] starting dev server on 127.0.0.1:${port}' && PORT=${port} HOST=127.0.0.1 __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${publicHost} BROWSER=none npm run dev ${devArgs}; echo '[intelio] dev server exited'; sleep 3600`;
  await ensureSession(t);
  await tmux(['kill-window', '-t', `=ws-${t.id}:dev`]);
  const r = await tmux(['new-window', '-d', '-t', `=ws-${t.id}:`, '-n', 'dev', '-c', t.worktree, `bash -c ${shq(cmd)}`]);
  if (r.code !== 0) { t.preview = null; throw new Error(`tmux: ${r.stderr.trim()}`); }
  startForward(t);
  touch(t);
  return previewStatus(t);
}
async function previewStop(t) {
  await tmux(['kill-window', '-t', `=ws-${t.id}:dev`]);
  const s = forwards.get(t.id);
  if (s) { s.close(); forwards.delete(t.id); }
  touch(t, { preview: null });
}
async function previewStatus(t) {
  if (!t.preview) return { state: 'stopped' };
  const up = await probe(t.preview.port);
  const cap = await tmux(['capture-pane', '-p', '-t', `=ws-${t.id}:dev`, '-S', '-40']);
  return { state: up ? 'running' : 'starting', url: `https://${publicHost}:${t.preview.proxyPort}/`, port: t.preview.port, proxyPort: t.preview.proxyPort, log: cap.stdout.replace(/\n+$/, '').split('\n').slice(-25).join('\n') };
}

// ---------------------------------------------------------------- git / PR actions
async function commitAll(t, msg) {
  await gitMust(t.worktree, ['add', '-A']);
  if ((await realGit(t.worktree, ['diff', '--cached', '--quiet'])).code === 0) return { committed: false, message: 'Nothing to commit.' };
  const m = String(msg || '').trim().slice(0, 500) || t.title;
  await gitMust(t.worktree, ['commit', '-m', m]);
  appendRun(t.id, { ws: 'note', text: `Committed all changes: "${m}"`, ts: Date.now() });
  touch(t);
  return { committed: true };
}
async function push(t) {
  if (t.crossRepo) throw new Error('This PR comes from a fork; pushing back to it is not supported.');
  const p = await run('/usr/bin/git', ['-C', t.worktree, 'push', '-u', 'origin', `HEAD:refs/heads/${t.branch}`], { timeout: 180000 });
  if (p.code !== 0) throw new Error(`git push failed: ${p.stderr.trim().slice(-600)}`);
  await realGit(t.worktree, ['branch', `--set-upstream-to=origin/${t.branch}`]);
  appendRun(t.id, { ws: 'note', text: `Pushed ${t.branch} to origin.`, ts: Date.now() });
  touch(t);
  return { pushed: true };
}
async function openPr(t) {
  await prStatus(t);
  if (t.pr) return { pr: t.pr };
  await push(t);
  const r = await run('/usr/bin/gh', ['pr', 'create', '--draft', '--fill', '--base', t.base, '--head', t.branch], { cwd: t.worktree, timeout: 120000 });
  if (r.code !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim().slice(-600)}`);
  const url = r.stdout.trim().split('\n').filter((l) => l.startsWith('http')).pop();
  t.pr = { url, draft: true, state: 'OPEN' };
  appendRun(t.id, { ws: 'note', text: `Opened draft PR ${url}`, ts: Date.now() });
  touch(t);
  await prStatus(t);
  return { pr: t.pr };
}
async function prReady(t) {
  if (!t.pr?.url) throw new Error('No PR yet.');
  const r = await run('/usr/bin/gh', ['pr', 'ready', t.pr.url], { cwd: t.worktree, timeout: 60000 });
  if (r.code !== 0) throw new Error(`gh pr ready failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
  appendRun(t.id, { ws: 'note', text: 'PR marked ready for review.', ts: Date.now() });
  await prStatus(t);
  return { pr: t.pr };
}
/** The only approve-gated action: Hayden clicked "Merge to main" and confirmed. */
async function mergeToMain(t, method) {
  if (!t.pr?.url) throw new Error('Open a PR first.');
  if (t.status === 'running') throw new Error('Stop the running agent first.');
  method = ['squash', 'merge', 'rebase'].includes(method) ? method : 'squash';
  const nonce = crypto.randomBytes(16).toString('hex');
  const grant = path.join(GRANTS, t.id);
  fs.writeFileSync(grant, nonce, { mode: 0o600 });
  try {
    const env = { ...process.env, PATH: ENGINE_PATH, INTELIO_WORKSPACE_TASK: t.id, INTELIO_WS_GRANT: nonce };
    if (t.pr.draft) {
      const rd = await run(path.join(WSBIN, 'gh'), ['pr', 'ready', t.pr.url], { cwd: t.worktree, env, timeout: 60000 });
      if (rd.code !== 0) throw new Error(`gh pr ready failed: ${(rd.stderr || rd.stdout).trim().slice(-300)}`);
    }
    const r = await run(path.join(WSBIN, 'gh'), ['pr', 'merge', t.pr.url, `--${method}`], { cwd: t.worktree, env, timeout: 120000 });
    if (r.code !== 0) throw new Error(`gh pr merge failed: ${(r.stderr || r.stdout).trim().slice(-500)}`);
  } finally {
    try { fs.unlinkSync(grant); } catch { /* gone */ }
  }
  appendRun(t.id, { ws: 'note', text: `Merged ${t.pr.url} into ${t.base} (${method}) — approved by Hayden.`, ts: Date.now() });
  await prStatus(t);
  touch(t, { status: t.status === 'running' ? t.status : 'done' });
  return { pr: t.pr };
}
async function prStatus(t) {
  if (t.setup !== 'ready') return { pr: t.pr };
  const ref = t.pr?.url || t.branch;
  const r = await run('/usr/bin/gh', ['pr', 'view', ref, '--json', 'url,number,isDraft,state,title,reviewDecision'], { cwd: t.worktree, timeout: 30000 });
  if (r.code === 0) {
    try { const j = JSON.parse(r.stdout); t.pr = { url: j.url, number: j.number, draft: j.isDraft, state: j.state, title: j.title, review: j.reviewDecision || '' }; save(); } catch { /* keep */ }
  }
  return { pr: t.pr };
}

setInterval(() => { monitor().catch((e) => log('monitor', e.message)); }, 2000).unref();
setInterval(() => { refreshStatus().catch((e) => log('status', e.message)); }, 10 * 60 * 1000).unref();

module.exports = {
  APP, DATA, TMUX_SOCK, TMUX_CONF, ENGINE_PATH, setLogger, engineStatus, refreshStatus, probeModel, listRepos, validateGithub,
  createTask, getTask, listTasks, publicTask, summary, conversation, message, stop, setStatus, setHelpers, changes, fileList,
  readFileSafe, windows, ensureSession, previewStart, previewStop, previewStatus, configurePreview,
  commitAll, push, openPr, prReady, mergeToMain, prStatus, reconcile,
};
