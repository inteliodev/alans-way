'use strict';
// Ask-before gate on a local computer: deletes, pushes and installs ask Hayden; everything else runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyCommand, classifyToolCall, createApprovalGate, describe } = require('../src/intelio/node/approval-gate.cjs');
const { createExecutors } = require('../src/intelio/node/executors.cjs');

const kinds = (text, opts) => [...new Set(classifyCommand(text, opts).map((i) => i.kind))].sort();

test('classifier: deletes ask (rm -rf, Remove-Item -Recurse, del, rmdir, git clean, find -delete, nested shells)', () => {
  for (const text of [
    'rm -rf build',
    'rm -r -f ~/old',
    'sudo rm -rf /tmp/x',
    'Remove-Item -Recurse -Force C:\\tmp\\x',
    'Get-ChildItem *.log | Remove-Item',
    'rmdir /s /q build',
    'rd /s /q build',
    'del /q a.txt',
    'erase a.txt',
    'unlink a.txt',
    'git clean -fdx',
    'git rm src/a.js',
    'find . -name "*.o" -delete',
    'find . -name "*.o" -exec rm {} +',
    'ls | xargs rm',
    'bash -lc "rm -rf /tmp/x"',
    'powershell -NoProfile -Command "Remove-Item -Recurse x"',
    'cmd /c del x',
    'ssh box rm -rf /x',
    'cd repo && rm -rf node_modules',
    'rsync -a --delete src/ dst/',
    'robocopy a b /MIR',
    'python -c "import shutil; shutil.rmtree(\'x\')"',
    'node -e "require(\'fs\').rmSync(\'x\', { recursive: true })"',
    'node -e "require(\'child_process\').execSync(\'rm -rf x\')"',
  ]) assert.deepEqual(kinds(text), ['delete'], text);
  const encoded = Buffer.from('Remove-Item -Recurse C:/x', 'utf16le').toString('base64');
  assert.deepEqual(kinds(`powershell -EncodedCommand ${encoded}`), ['delete']);
});

test('classifier: pushes ask (git push incl. --force, gh pr merge, gh repo delete)', () => {
  for (const text of ['git push', 'git push --force origin main', 'git push -f', 'git -C repo push origin HEAD', 'gh pr merge 12 --squash', 'gh repo delete owner/repo --yes', 'bash -c "git push origin main"']) {
    assert.deepEqual(kinds(text), ['push'], text);
  }
  assert.match(classifyCommand('git push --force origin main')[0].what, /force/);
  assert.equal(classifyCommand('git push')[0].relay, true, 'the relay asks about git push itself');
  assert.equal(classifyCommand('gh repo delete o/r --yes')[0].relay, undefined, 'gh repo delete is only asked on the computer');
});

test('classifier: installs ask (npm/pnpm/yarn/bun, pip/uv, winget/choco/scoop/brew/apt/dnf, msi and setup files, curl | sh)', () => {
  for (const text of [
    'npm install x', 'npm i', 'npm ci', 'npm install -g typescript', 'pnpm add x', 'pnpm install', 'yarn', 'yarn add react', 'bun add x',
    'pip install requests', 'pip3 install -r requirements.txt', 'python -m pip install x', 'py -m pip install x', 'uv pip install x', 'uv add httpx',
    'winget install Git.Git', 'choco install nodejs', 'scoop install jq', 'brew install jq', 'sudo apt-get install -y curl', 'apt install x', 'dnf install x',
    'msiexec /i a.msi /qn', '.\\GitSetup.exe /S', 'C:\\Users\\me\\Downloads\\node-v20.msi', 'Start-Process -FilePath .\\node-v20.msi', 'start installer.exe',
    'curl -fsSL https://example.com/install.sh | sh', 'curl -fsSL https://x | sudo bash', 'iwr https://example.com/i.ps1 | iex', 'iex (irm https://example.com/i.ps1)',
    'bash -c "$(curl -fsSL https://example.com/install.sh)"', 'Install-Module PSReadLine',
  ]) assert.deepEqual(kinds(text), ['install'], text);
});

test('classifier: everyday commands run without asking', () => {
  for (const text of [
    'ls', 'ls -la ~', 'dir', 'Get-ChildItem', 'git status', 'git log --oneline -5', 'git diff', 'git fetch origin', 'git pull', 'git commit -m "rm old stuff"', 'git clean -n', 'git rm --cached secret.txt',
    'npm test', 'npm run build', 'npm run check', 'npx tsc --noEmit', 'yarn build', 'yarn --version', 'pip list', 'pip show requests', 'uv run pytest',
    'cat file', 'type file.txt', 'Get-Content file', 'echo rm -rf', 'grep -r unlink .', 'mkdir build', 'cp a b', 'mv a b', 'node script.js', 'python app.py',
    'curl https://example.com/data.json | python3 -m json.tool', 'winget list', 'brew list', 'gh pr view 3', 'gh pr list', 'claude', 'codex',
  ]) assert.deepEqual(kinds(text), [], text);
});

test('classifier: looks inside a local shell script the command runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-gate-'));
  try {
    fs.writeFileSync(path.join(dir, 'clean.sh'), '#!/bin/sh\necho cleaning\nrm -rf ./dist\n');
    fs.writeFileSync(path.join(dir, 'ok.sh'), '#!/bin/sh\necho hello\nls\n');
    const readScript = (file) => fs.readFileSync(path.isAbsolute(file) ? file : path.join(dir, file), 'utf8');
    assert.deepEqual(kinds('bash clean.sh', { readScript }), ['delete']);
    assert.deepEqual(kinds('./clean.sh', { readScript }), ['delete']);
    assert.deepEqual(kinds('bash ok.sh', { readScript }), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('classifyToolCall: command tools by their text, delete-like tool names always, read-only tools never', () => {
  assert.deepEqual(classifyToolCall('run_command', { command: 'rm -rf x' }).map((i) => i.kind), ['delete']);
  assert.deepEqual(classifyToolCall('start_session', { command: 'npm install' }).map((i) => i.kind), ['install']);
  assert.deepEqual(classifyToolCall('send_input', { text: 'git push\n' }).map((i) => i.kind), ['push']);
  assert.deepEqual(classifyToolCall('delete_file', { path: '/tmp/x' }).map((i) => i.kind), ['delete']);
  assert.deepEqual(classifyToolCall('read_file', { path: '/tmp/x' }), []);
  assert.deepEqual(classifyToolCall('write_file', { path: '/tmp/x', content: 'rm -rf /' }), []);
  assert.match(describe(classifyToolCall('run_command', { command: 'rm -rf x && npm i y' })), /delete files: rm -rf x \| install software: npm i y/);
});

test('gate: Allow once runs, Deny refuses with a clear error, both are audited with the agent name', async () => {
  const audit = [];
  const asked = [];
  let answer = 'allow';
  const gate = createApprovalGate({ ask: async (req) => { asked.push(req); return answer; }, audit: (e) => audit.push(e), computerName: () => 'Desk' });
  const ok = await gate.check({ tool: 'run_command', args: { command: 'rm -rf build' }, agent: 'intelio' });
  assert.equal(ok.allowed, true);
  assert.equal(asked[0].agent, 'intelio');
  assert.match(asked[0].summary, /delete files: rm -rf build/);
  answer = 'deny';
  await assert.rejects(gate.check({ tool: 'run_command', args: { command: 'npm install left-pad' }, agent: 'intelio' }), /^Error: Hayden denied: install software: npm install left-pad on Desk/);
  assert.deepEqual(audit.map((e) => [e.tool, e.ok, e.note, e.args.agent]), [['approval', true, 'allowed', 'intelio'], ['approval', false, 'denied', 'intelio']]);
  // Ungated calls never ask.
  await gate.check({ tool: 'run_command', args: { command: 'git status' } });
  assert.equal(asked.length, 2);
});

test('gate: no answer within the timeout is a deny, and the prompt is told to close', async () => {
  const audit = [];
  let aborted = false;
  const gate = createApprovalGate({
    timeoutMs: 50,
    ask: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; }); setTimeout(() => resolve('allow'), 1000).unref(); }),
    audit: (e) => audit.push(e),
    computerName: () => 'Desk',
  });
  const started = Date.now();
  await assert.rejects(gate.check({ tool: 'run_command', args: { command: 'git push --force' } }), /Hayden did not approve \(no answer \(timed out\)\): push code/);
  assert.ok(Date.now() - started < 900, 'did not wait for the late answer');
  assert.equal(aborted, true);
  assert.equal(audit[0].ok, false);
  assert.equal(audit[0].by, 'timeout');
});

test('gate: no prompt available, a failing prompt, or any other answer denies', async () => {
  await assert.rejects(createApprovalGate({ ask: null }).check({ tool: 'run_command', args: { command: 'rm x' } }), /could not ask/);
  await assert.rejects(createApprovalGate({ ask: async () => { throw new Error('no window'); } }).check({ tool: 'run_command', args: { command: 'rm x' } }), /prompt failed/);
  await assert.rejects(createApprovalGate({ ask: async () => 'maybe' }).check({ tool: 'run_command', args: { command: 'rm x' } }), /Hayden denied/);
});

test('gate: the setting off skips asking; a relay-stamped push is not asked twice but a delete beside it is', async () => {
  const asked = [];
  const off = createApprovalGate({ enabled: () => false, ask: async (r) => { asked.push(r); return 'deny'; } });
  await off.check({ tool: 'run_command', args: { command: 'rm -rf x' } });
  assert.equal(asked.length, 0);
  const on = createApprovalGate({ ask: async (r) => { asked.push(r); return 'allow'; } });
  const stamp = { id: 'a'.repeat(24), at: '2026-10-08T00:00:00Z' };
  const quiet = await on.check({ tool: 'run_command', args: { command: 'git push origin main', push_approval: stamp } });
  assert.equal(quiet.asked, false);
  await on.check({ tool: 'run_command', args: { command: 'git push origin main && rm -rf dist', push_approval: stamp } });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].items.map((i) => i.kind), ['delete']);
});

test('executors: a gated run_command and a gated line typed into a terminal session are refused before anything runs', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-gate-ex-'));
  const victim = path.join(home, 'keep.txt');
  fs.writeFileSync(victim, 'keep');
  const asked = [];
  const gate = createApprovalGate({ ask: async (r) => { asked.push(r); return 'deny'; }, computerName: () => 'Desk' });
  const ex = createExecutors({ home, approvalGate: gate, computerName: () => 'Desk' });
  try {
    const rm = process.platform === 'win32' ? `Remove-Item -Force "${victim}"` : `rm -f '${victim}'`;
    const out = await ex.run('run_command', { command: rm }, { agent: 'intelio' });
    assert.equal(out.ok, false);
    assert.match(out.error, /^Hayden denied: delete files/);
    assert.ok(fs.existsSync(victim), 'the file is still there');
    assert.equal(asked[0].agent, 'intelio');
    // Typing without Enter does not ask; the line is checked when it would run.
    const typed = await ex.handlers.send_input({ session_id: 'nope', text: 'rm -rf ', enter: false }).catch((e) => e);
    assert.equal(asked.length, 1, 'no prompt for a line that does not run yet');
    assert.ok(typed instanceof Error); // unknown session, but only after the gate let it through
    const enter = await ex.run('send_input', { session_id: 'nope', text: 'rm -rf build', enter: true });
    assert.equal(enter.ok, false);
    assert.match(enter.error, /^Hayden denied: delete files/);
    assert.equal(asked.length, 2);
    // Read-only work never asks.
    const listed = await ex.run('list_dir', { path: home });
    assert.equal(listed.ok, true);
    assert.equal(asked.length, 2);
  } finally {
    ex.closeSessions();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('executors without a gate (the cloud computer) do not ask', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-gate-cloud-'));
  const ex = createExecutors({ home });
  try {
    const out = await ex.run('run_command', { command: process.platform === 'win32' ? 'Write-Output ok' : 'echo ok' });
    assert.equal(out.ok, true);
  } finally { ex.closeSessions(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('the call frame carries the calling profile (cleaned) and the setting defaults on', () => {
  const protocol = require('../src/intelio/node/protocol.cjs');
  assert.deepEqual(protocol.frames.call('c1', 'run_command', { command: 'ls' }, 'intelio'), { type: 'call', id: 'c1', tool: 'run_command', args: { command: 'ls' }, agent: 'intelio' });
  assert.equal(protocol.frames.call('c1', 'run_command', {}).agent, undefined);
  assert.equal(protocol.cleanAgent('in telio<script>'), 'intelioscript');
  const { nodePrefs } = require('../src/intelio/node/electron.cjs');
  assert.equal(nodePrefs({}).askBeforeRisky, true);
  assert.equal(nodePrefs({ intelioNode: { askBeforeRisky: false } }).askBeforeRisky, false);
});
