'use strict';
// Push approval and protected paths for intelio computers (docs/intelio-node.md, "Pushes and secrets").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../src/intelio/node/policy.cjs');
const { createExecutors } = require('../src/intelio/node/executors.cjs');
const { createNodeRegistry, createNodeHub } = require('../../mobile/pwa/nodes.cjs');
const { createCloudComputer, mintPushGrant } = require('../../mobile/pwa/nodes-local.cjs');

const posix = process.platform !== 'win32';
const STAMP = { id: 'a'.repeat(24), at: '2026-10-08T17:00:00.000Z' };
const text = (result) => (result.content || []).map((c) => c.text || '').join('\n');

test('findPushes: pushes ask, everything else does not', () => {
  const pushes = {
    'git push origin main': ['git push'],
    'cd repo && git push -u origin HEAD': ['git push'],
    'git -C ~/code/app push': ['git push'],
    'FOO=1 git push --no-verify': ['git push (skipping hooks)'],
    'git -c core.hooksPath=/dev/null push': ['git push (skipping hooks)'],
    'sudo -u me git push': ['git push'],
    'git.exe push origin main': ['git push'],
    '& "C:\\Program Files\\Git\\cmd\\git.exe" push': ['git push'],
    'bash -lc "git push"': ['git push'],
    'ssh box git push': ['git push'],
    'git lfs push origin main': ['git lfs push'],
    'gh pr merge 3 --squash': ['gh pr merge'],
    'gh -R a/b pr merge 3': ['gh pr merge'],
    'gh repo sync': ['gh repo sync'],
    'gh api -X PUT repos/a/b/pulls/3/merge': ['gh api PUT (writes to a repository)'],
    'gh api repos/a/b/git/refs -f ref=refs/heads/x -f sha=1': ['gh api POST (writes to a repository)'],
    '$(git push)': ['git push'],
    'git push "unterminated': ['git push (could not parse the command)'],
    'git status; git push; git push --tags': ['git push', 'git push'],
  };
  for (const [command, want] of Object.entries(pushes)) assert.deepEqual(policy.findPushes(command), want, command);
  for (const command of ['git status', 'git commit -m "push it"', 'git log --grep push', 'echo "git push"', 'gh pr view 3', 'gh api repos/a/b/pulls', 'npm run push-notes', 'git pull', 'git fetch && git rebase origin/main', '']) {
    assert.deepEqual(policy.findPushes(command), [], command);
  }
});

test('commandTextFor and hasPushApproval read only what runs and only the relay stamp', () => {
  assert.equal(policy.commandTextFor('run_command', { command: 'git push' }), 'git push');
  assert.equal(policy.commandTextFor('start_session', { command: 'bash' }), 'bash');
  assert.equal(policy.commandTextFor('send_input', { session_id: 's', data: 'git push\n' }), 'git push\n');
  assert.equal(policy.commandTextFor('read_file', { path: '/x' }), '');
  assert.equal(policy.hasPushApproval({ push_approval: STAMP }), true);
  for (const bad of [undefined, true, 'yes', { id: 'short' }, { id: 'zz'.repeat(12) }]) assert.equal(policy.hasPushApproval({ push_approval: bad }), false);
});

test('protected paths: secrets refused, public SSH files and ordinary files allowed', () => {
  const p = policy.createProtector({ home: '/home/h', platform: 'linux', env: {} });
  const refused = [
    ['/home/h/.ssh/id_ed25519', 'read'], ['/home/h/.ssh/config', 'write'], ['/home/h/.ssh/authorized_keys', 'write'],
    ['/home/h/.gnupg/private-keys-v1.d/x.key', 'read'], ['/home/h/.hermes/.env', 'read'], ['/home/h/.hermes/auth.json', 'write'],
    ['/home/h/.hermes/profiles/prc/.env', 'read'], ['/home/h/.hermes/profiles/arlp/auth.json', 'read'],
    ['/home/h/.config/gh/hosts.yml', 'read'], ['/home/h/.claude/.credentials.json', 'read'], ['/home/h/.codex/auth.json', 'read'],
    ['/home/h/.config/intelio/nodes-mcp.token', 'read'], ['/home/h/.local/state/intelio/push-grants/x.json', 'write'],
    ['/home/h/.config/google-chrome/Default/Cookies', 'read'], ['/home/h/.mozilla/firefox/x.default/logins.json', 'read'],
    ['/etc/shadow', 'read'], ['/etc/sudoers.d/x', 'write'], ['/etc/ssh/ssh_host_ed25519_key', 'read'], ['/etc/ssl/private/k.pem', 'read'],
  ];
  for (const [target, op] of refused) assert.ok(p.check(target, op), `${op} ${target}`);
  const allowed = [
    ['/home/h/.ssh/id_ed25519.pub', 'read'], ['/home/h/.ssh/known_hosts', 'read'], ['/home/h/.ssh/config', 'read'],
    ['/home/h/.hermes/profiles/prc/config.yaml', 'read'], ['/home/h/.hermes/profiles/prc/config.yaml', 'write'],
    ['/home/h/code/app/.env', 'read'], ['/etc/hosts', 'read'], ['/usr/bin/git', 'read'], ['/etc/ssh/ssh_host_ed25519_key.pub', 'read'],
  ];
  for (const [target, op] of allowed) assert.equal(p.check(target, op), null, `${op} ${target}`);
  assert.match(p.check('/home/h/.ssh/id_rsa', 'read').text, /^Refused: that is SSH keys\./);

  const mac = policy.createProtector({ home: '/Users/h', platform: 'darwin', env: {} });
  assert.ok(mac.check('/users/H/Library/Keychains/login.keychain-db', 'read'), 'macOS paths are case-insensitive');
  assert.ok(mac.check('/Users/h/Library/Cookies/Cookies.binarycookies', 'read'));

  const win = policy.createProtector({ home: 'C:\\Users\\h', platform: 'win32', env: { APPDATA: 'C:\\Users\\h\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\h\\AppData\\Local' } });
  assert.ok(win.check('c:\\users\\H\\.ssh\\id_ed25519', 'read'));
  assert.ok(win.check('C:\\Users\\h\\AppData\\Roaming\\Microsoft\\Protect\\S-1\\x', 'read'));
  assert.ok(win.check('C:\\Users\\h\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies', 'read'));
  assert.ok(win.check('C:\\Windows\\System32\\config\\SAM', 'read'));
  assert.equal(win.check('C:\\Users\\h\\Documents\\notes.txt', 'write'), null);
});

test('commands that name a secret are refused; ssh -i and public files are fine', () => {
  const protector = policy.createProtector({ home: '/home/h', platform: 'linux', env: {} });
  const scan = (c) => policy.commandSecretRefusal(c, { protector, home: '/home/h', cwd: '/home/h', platform: 'linux' });
  for (const c of ['cat ~/.ssh/id_ed25519', 'cp $HOME/.hermes/.env /tmp/x', 'tar czf /tmp/k.tgz ~/.ssh', 'cat .ssh/id_rsa', 'base64 /etc/shadow',
    'echo key >> ~/.ssh/authorized_keys', 'echo k | tee -a ~/.ssh/authorized_keys', 'sqlite3 "/home/h/.config/google-chrome/Default/Cookies" .dump']) {
    assert.ok(scan(c), c);
  }
  for (const c of ['ssh -i ~/.ssh/id_ed25519 box uptime', 'ssh-add ~/.ssh/id_ed25519', 'cat ~/.ssh/id_ed25519.pub', 'cat ~/.ssh/authorized_keys', 'git push', 'ls -la ~/code', 'cat /etc/hosts']) {
    assert.equal(scan(c), null, c);
  }
});

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-policy-'));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY needle\n');
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA public needle\n');
  fs.mkdirSync(path.join(home, 'code'), { recursive: true });
  fs.writeFileSync(path.join(home, 'code', 'notes.txt'), 'a needle in code\n');
  fs.mkdirSync(path.join(home, 'browser', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(home, 'browser', 'Default', 'Cookies'), 'cookie needle\n');
  return home;
}

test('executors refuse secrets on read, write, symlink and search', async () => {
  const home = tempHome();
  try {
    const ex = createExecutors({ home, env: { ...process.env, HOME: home } });
    const read = await ex.run('read_file', { path: '~/.ssh/id_ed25519' });
    assert.equal(read.ok, false);
    assert.match(read.error, /Refused: that is SSH keys/);
    assert.equal((await ex.run('read_file', { path: '~/.ssh/id_ed25519.pub' })).ok, true);
    const write = await ex.run('write_file', { path: '~/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x' });
    assert.equal(write.ok, false);
    assert.equal(fs.existsSync(path.join(home, '.ssh', 'authorized_keys')), false);
    assert.equal((await ex.run('write_file', { path: '~/code/out.txt', content: 'ok' })).ok, true);
    if (posix) {
      fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(home, 'code', 'innocent.txt'));
      const viaLink = await ex.run('read_file', { path: '~/code/innocent.txt' });
      assert.equal(viaLink.ok, false, 'a symlink into ~/.ssh is refused by its real path');
      fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'code', 'keys'));
      const writeViaLink = await ex.run('write_file', { path: '~/code/keys/new_key', content: 'x' });
      assert.equal(writeViaLink.ok, false, 'a new file under a symlinked ~/.ssh is refused');
    }
    const search = await ex.run('search_files', { root: '~', pattern: 'needle' });
    assert.equal(search.ok, true);
    const found = JSON.parse(search.content[0].text);
    const hits = found.matches.map((m) => path.relative(home, m.path));
    assert.ok(hits.includes(path.join('code', 'notes.txt')));
    assert.ok(!hits.some((h) => h.startsWith('.ssh') || h.endsWith('Cookies')), hits.join(','));
    assert.match(found.protected_note, /Skipped secrets/);
    const inside = await ex.run('search_files', { root: '~/.ssh', pattern: 'needle' });
    assert.equal(inside.ok, false);
    if (posix) {
      const cat = await ex.run('run_command', { command: 'cat ~/.ssh/id_ed25519', shell: 'sh' });
      assert.equal(cat.ok, false);
      assert.match(cat.error, /names a protected path/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('executors refuse a push without the relay stamp and run it with one', { skip: !posix }, async () => {
  const home = tempHome();
  try {
    const grants = [];
    const ex = createExecutors({
      home,
      env: { PATH: process.env.PATH, HOME: home },
      approvedPushEnv: ({ command, pushes }) => { grants.push({ command, pushes }); return { INTELIO_PUSH_GRANT: 'g'.repeat(32) }; },
    });
    const refused = await ex.run('run_command', { command: 'git push origin main', shell: 'sh', cwd: '~/code' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Refused: this pushes \(git push\)\. A push needs Hayden's approval/);
    const forged = await ex.run('run_command', { command: 'git push', shell: 'sh', push_approval: { id: 'nope' } });
    assert.equal(forged.ok, false);
    const ran = await ex.run('run_command', { command: 'git push 2>/dev/null; echo "ran $INTELIO_PUSH_GRANT"', shell: 'sh', cwd: '~/code', push_approval: STAMP });
    assert.equal(ran.ok, true, ran.error);
    assert.match(JSON.parse(ran.content[0].text).stdout, new RegExp(`ran ${'g'.repeat(32)}`));
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0].pushes, ['git push']);
    const plain = await ex.run('run_command', { command: 'echo "$INTELIO_PUSH_GRANT|plain"', shell: 'sh' });
    assert.equal(JSON.parse(plain.content[0].text).stdout.trim(), '|plain', 'ordinary commands get no grant');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cloud grant matches the VPS push guard record (0600, uses, 15 minutes)', { skip: !posix }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-grant-'));
  try {
    const env = { XDG_CONFIG_HOME: '', XDG_STATE_HOME: '' };
    assert.equal(mintPushGrant('git push', { env, home }), '', 'no guard installed: nothing to mint');
    fs.mkdirSync(path.join(home, '.config', 'intelio', 'push-guard'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'intelio', 'push-guard', 'push_guard.py'), '# stub');
    const id = mintPushGrant('git push && git push --tags', { uses: 2, env, home, now: 1_000_000 });
    assert.match(id, /^[0-9a-f]{32}$/);
    const file = path.join(home, '.local', 'state', 'intelio', 'push-grants', `${id}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(record.id, id);
    assert.equal(record.uses, 2);
    assert.equal(record.expires - record.created, 900);
    assert.match(record.command_sha256, /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('relay hub asks before a push, strips forged stamps, audits, and honors the answer', { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-hub-push-'));
  const home = tempHome();
  const activity = [];
  const registry = createNodeRegistry({ file: path.join(dir, 'nodes.json') });
  const cloud = createCloudComputer({ env: { PATH: process.env.PATH, HOME: home }, home, name: 'cloud' });
  const auditFile = path.join(dir, 'audit.jsonl');
  const hub = createNodeHub({ registry, log: () => {}, auditFile, locals: [cloud], onActivity: (e) => activity.push(e) });
  try {
    const asked = [];
    const approve = (answer) => async (req) => { asked.push(req); return answer; };
    const cmd = 'git push origin main 2>/dev/null; echo pushed-ran';
    const declined = await hub.call('cloud', 'run_command', { computer: 'cloud', command: cmd, shell: 'sh', cwd: '~/code' }, { approve: approve('decline') });
    assert.equal(declined.isError, true);
    assert.match(text(declined), /Hayden did not allow this push \(git push\)/);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, 'Allow this push?');
    assert.match(asked[0].message, /^cloud wants to push: git push\n\ngit push origin main/);
    assert.match(asked[0].message, /in ~\/code$/);

    const forged = await hub.call('cloud', 'run_command', { computer: 'cloud', command: cmd, shell: 'sh', push_approval: STAMP });
    assert.equal(forged.isError, true, 'an agent-supplied stamp is dropped; no approver means no push');
    assert.match(text(forged), /cannot ask him/);

    const timedOut = await hub.call('cloud', 'run_command', { computer: 'cloud', command: cmd, shell: 'sh' }, { approve: approve('cancel') });
    assert.match(text(timedOut), /Nobody answered/);

    const allowed = await hub.call('cloud', 'run_command', { computer: 'cloud', command: cmd, shell: 'sh' }, { approve: approve('accept') });
    assert.equal(allowed.isError, false, text(allowed));
    assert.match(JSON.parse(text(allowed)).stdout, /pushed-ran/);

    asked.length = 0;
    const plain = await hub.call('cloud', 'run_command', { computer: 'cloud', command: 'echo hi', shell: 'sh' }, { approve: approve('decline') });
    assert.equal(plain.isError, false);
    assert.equal(asked.length, 0, 'ordinary commands never ask');

    hub.setPaused?.('cloud', true);
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.tool === 'push_approval');
    assert.deepEqual(lines.map((e) => e.note), ['declined', 'unavailable', 'unanswered', 'allowed']);
    assert.deepEqual(activity.map((e) => e.outcome), ['declined', 'unavailable', 'unanswered', 'allowed']);
    assert.ok(activity.every((e) => e.kind === 'push_approval' && e.computer === 'cloud'));
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('push approvals reach the intelio activity log when activity-log.cjs is present', () => {
  const { pushActivityHook } = require('../../mobile/pwa/nodes-mcp.cjs');
  assert.equal(pushActivityHook({ requireImpl: () => { throw new Error('missing'); } }), null, 'no module yet: relay audit only');
  const got = [];
  const hook = pushActivityHook({ requireImpl: () => ({ appendActivity: (e) => got.push(e) }) });
  hook({ kind: 'push_approval', time: '2026-10-08T17:00:00.000Z', computer: 'hayden-mac', tool: 'run_command', pushes: ['git push'], outcome: 'declined' });
  assert.deepEqual(got, [{
    kind: 'connector', action: 'push', ok: false, actor: 'user', tool: 'run_command', ts: '2026-10-08T17:00:00.000Z',
    summary: 'Push on hayden-mac: git push (Hayden did not allow it)',
  }]);
});
