'use strict';
// intelio node, computer side: WebSocket framing, elevation detection, executors
// on the host OS (temp dirs), output caps, and the real client against the relay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const ws = require('../src/intelio/node/ws.cjs');
const protocol = require('../src/intelio/node/protocol.cjs');
const { detectElevation, shellElevates } = require('../src/intelio/node/elevation.cjs');
const { createExecutors, globToRegExp } = require('../src/intelio/node/executors.cjs');
const { createNodeClient, createAuditLog, backoffDelay } = require('../src/intelio/node/client.cjs');
const { relayUrls, nodePrefs, deviceName, createIdentityStore } = require('../src/intelio/node/electron.cjs');
const { createNodeRegistry, createNodeHub } = require('../../mobile/pwa/nodes.cjs');
const { createNodesMcp } = require('../../mobile/pwa/nodes-mcp.cjs');

const WIN = process.platform === 'win32';

function tmpdir(prefix = 'intelio-node-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parse(result) {
  assert.equal(result.ok, true, result.error);
  return JSON.parse(result.content[0].text);
}

test('frames: masked and unmasked round trips at every length boundary', () => {
  for (const len of [0, 1, 125, 126, 127, 65535, 65536, 200000]) {
    const payload = crypto.randomBytes(len);
    for (const mask of [true, false]) {
      const parser = ws.createFrameParser({ requireMask: mask });
      const bytes = ws.encodeFrame(payload, { opcode: 0x2, mask });
      const frames = parser.push(bytes);
      assert.equal(frames.length, 1, `len ${len}`);
      assert.equal(frames[0].opcode, 0x2);
      assert.ok(frames[0].fin);
      assert.ok(frames[0].payload.equals(payload), `len ${len} mask ${mask}`);
    }
  }
  // Byte-at-a-time delivery still yields exactly one frame.
  const parser = ws.createFrameParser({ requireMask: true });
  const bytes = ws.encodeFrame('hello there', { mask: true });
  let got = [];
  for (const b of bytes) got = got.concat(parser.push(Buffer.from([b])));
  assert.equal(got.length, 1);
  assert.equal(got[0].payload.toString(), 'hello there');
  // Two frames in one chunk.
  const two = ws.createFrameParser({ requireMask: false }).push(Buffer.concat([ws.encodeFrame('a'), ws.encodeFrame('b')]));
  assert.deepEqual(two.map((f) => f.payload.toString()), ['a', 'b']);
});

test('frames: protocol violations are rejected', () => {
  assert.throws(() => ws.createFrameParser({ requireMask: true }).push(ws.encodeFrame('x', { mask: false })), /must be masked/);
  assert.throws(() => ws.createFrameParser({ requireMask: false }).push(ws.encodeFrame('x', { mask: true })), /must not be masked/);
  assert.throws(() => ws.createFrameParser({ maxFrame: 10 }).push(ws.encodeFrame('x'.repeat(11))), /too large/);
  const huge = Buffer.from([0x82, 127, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.throws(() => ws.createFrameParser().push(huge), /too large/);
  const rsv = Buffer.from([0xc1, 0x00]);
  assert.throws(() => ws.createFrameParser().push(rsv), /reserved/);
  const longPing = ws.encodeFrame('x'.repeat(126), { opcode: 0x9 });
  assert.throws(() => ws.createFrameParser().push(longPing), /control/);
  assert.equal(ws.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('WebSocket server and client: big messages, fragments, ping, close, non-upgrade refusal', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const conns = [];
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/deny') { ws.refuseUpgrade(socket, 403); return; }
    const conn = ws.acceptWebSocket(req, socket, head);
    conns.push(conn);
    conn.on('message', (text) => conn.send(`echo:${text.length}:${text.slice(0, 20)}`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const c of conns) c.terminate(); server.close(); });
  const base = `ws://127.0.0.1:${server.address().port}`;
  await assert.rejects(ws.connectWebSocket(`${base}/deny`), (e) => e.status === 403);
  const client = await ws.connectWebSocket(`${base}/node/connect`);
  const replies = [];
  const nextReply = () => new Promise((resolve) => client.once('message', (m) => { replies.push(m); resolve(m); }));
  const big = 'é'.repeat(600000);
  let wait = nextReply();
  client.send(big);
  assert.equal(await wait, `echo:${big.length}:${big.slice(0, 20)}`);
  wait = nextReply();
  client.socket.write(ws.encodeFrame('hel', { opcode: 0x1, fin: false, mask: true }));
  client.socket.write(ws.encodeFrame('', { opcode: 0x9, mask: true })); // ping between fragments is allowed
  client.socket.write(ws.encodeFrame('lo', { opcode: 0x0, fin: true, mask: true }));
  assert.equal(await wait, 'echo:5:hello');
  const pong = new Promise((resolve) => client.once('pong', resolve));
  client.ping();
  await pong;
  const closed = new Promise((resolve) => conns[0].once('close', (code) => resolve(code)));
  client.close(1000, 'done');
  assert.equal(await closed, 1000);
  assert.throws(() => client.send('late'), /closed/);
  // A plain HTTP request to the same server is not an upgrade.
  const plain = await new Promise((resolve) => http.get(`http://127.0.0.1:${server.address().port}/node/connect`, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(plain, 404);
});

test('elevation: sudo, runas, -Verb RunAs, osascript admin are detected; ordinary commands are not', () => {
  const yes = [
    'sudo apt update', 'ls; sudo rm -rf /tmp/x', 'true && sudo -n true', 'FOO=1 sudo env', '/usr/bin/sudo whoami',
    'doas ls', 'pkexec ls', 'su -c "id"', 'su', 'echo $(sudo whoami)', 'time sudo ls', 'xargs sudo rm', 'nohup sudo x &',
    'runas /user:Administrator cmd', 'RUNAS.exe /savecred x', 'gsudo winget install x', 'Start-Process powershell -Verb RunAs',
    'Start-Process cmd -Verb:RunAs -ArgumentList "/c dir"', "Start-Process -FilePath x -Verb 'runAs'",
    `osascript -e 'do shell script "id" with administrator privileges'`,
    '(New-Object -ComObject Shell.Application).ShellExecute("cmd", "", "", "runas")',
    'echo hi\nsudo reboot',
  ];
  const no = [
    'echo sudo is just a word', 'git status', 'cat /etc/sudoers.d/README', 'grep su notes.txt', 'npm run build',
    'Get-ChildItem C:\\Users', 'pseudo --help', 'resume', 'ls ~/subdir', 'python -c "print(1)"', 'echo "runasync"',
    'Start-Process notepad', 'dir /s', 'summary', 'sudoku --solve',
  ];
  for (const cmd of yes) assert.equal(detectElevation(cmd).elevates, true, cmd);
  for (const cmd of no) assert.equal(detectElevation(cmd).elevates, false, cmd);
  assert.ok(shellElevates('sudo'));
  assert.ok(!shellElevates('bash'));
});

test('executors: computer_info, list_dir, read_file, write_file on this OS', async () => {
  const home = tmpdir();
  const ex = createExecutors({ home, computerName: () => 'Test-PC' });
  const info = parse(await ex.run('computer_info', {}));
  for (const key of ['os', 'arch', 'hostname', 'user', 'home', 'drives', 'shell']) assert.ok(key in info, key);
  assert.equal(info.home, home);
  assert.ok(Array.isArray(info.drives) && info.drives.length >= 1);

  // write_file: overwrite (default), create refuses existing, append, make_dirs, base64.
  const w = parse(await ex.run('write_file', { path: '~/a.txt', content: 'line one\n' }));
  assert.equal(w.bytes_written, 9);
  assert.equal(w.path, path.join(home, 'a.txt'));
  const exists = await ex.run('write_file', { path: '~/a.txt', content: 'x', mode: 'create' });
  assert.equal(exists.ok, false);
  assert.match(exists.error, /Already exists/);
  parse(await ex.run('write_file', { path: '~/a.txt', content: 'line two\n', mode: 'append' }));
  assert.equal(fs.readFileSync(path.join(home, 'a.txt'), 'utf8'), 'line one\nline two\n');
  const noDir = await ex.run('write_file', { path: '~/deep/er/b.bin', content: 'AAEC', encoding: 'base64' });
  assert.equal(noDir.ok, false);
  parse(await ex.run('write_file', { path: '~/deep/er/b.bin', content: 'AAEC', encoding: 'base64', make_dirs: true }));
  assert.deepEqual([...fs.readFileSync(path.join(home, 'deep', 'er', 'b.bin'))], [0, 1, 2]);
  const absolute = path.join(home, 'abs.txt');
  parse(await ex.run('write_file', { path: absolute, content: 'abs' }));

  // read_file: whole, offset/limit, base64, binary hint, folders and relative paths refused.
  const r = await ex.run('read_file', { path: '~/a.txt' });
  assert.equal(r.ok, true);
  const meta = JSON.parse(r.content[0].text);
  assert.deepEqual({ total: meta.total_size, truncated: meta.truncated }, { total: 18, truncated: false });
  assert.equal(r.content[1].text, 'line one\nline two\n');
  const part = await ex.run('read_file', { path: '~/a.txt', offset: 5, limit: 3 });
  assert.equal(part.content[1].text, 'one');
  assert.equal(JSON.parse(part.content[0].text).truncated, true);
  const b64 = await ex.run('read_file', { path: '~/deep/er/b.bin', encoding: 'base64' });
  assert.equal(b64.content[1].text, 'AAEC');
  assert.match(JSON.parse((await ex.run('read_file', { path: '~/deep/er/b.bin' })).content[0].text).note, /base64/);
  assert.match((await ex.run('read_file', { path: '~/deep' })).error, /folder/);
  assert.match((await ex.run('read_file', { path: 'relative.txt' })).error, /absolute or start with ~/);
  assert.match((await ex.run('read_file', { path: '~/missing.txt' })).error, /Not found/);

  // list_dir: dirs first, hidden filtered, cap + truncated flag.
  fs.writeFileSync(path.join(home, '.hidden'), 'h');
  const listing = parse(await ex.run('list_dir', { path: '~' }));
  assert.equal(listing.entries[0].type, 'dir');
  assert.ok(!listing.entries.some((e) => e.name === '.hidden'));
  assert.ok(parse(await ex.run('list_dir', { path: '~', show_hidden: true })).entries.some((e) => e.name === '.hidden'));
  const file = listing.entries.find((e) => e.name === 'a.txt');
  assert.equal(file.size, 18);
  assert.match(file.mtime, /^\d{4}-/);
  const many = path.join(home, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(many, `f${i}`), '');
  const small = createExecutors({ home, limits: { ...protocol.LIMITS, listDirEntries: 10 } });
  const capped = parse(await small.run('list_dir', { path: '~/many' }));
  assert.equal(capped.entries.length, 10);
  assert.equal(capped.total, 30);
  assert.equal(capped.truncated, true);

  // read caps: text limit applies.
  fs.writeFileSync(path.join(home, 'big.txt'), 'x'.repeat(5000));
  const tiny = createExecutors({ home, limits: { ...protocol.LIMITS, readTextBytes: 1000 } });
  const bigRead = await tiny.run('read_file', { path: '~/big.txt', limit: 999999 });
  assert.equal(bigRead.content[1].text.length, 1000);
  assert.equal(JSON.parse(bigRead.content[0].text).truncated, true);
  assert.match((await ex.run('nonexistent_tool', {})).error, /does not support/);
});

test('executors: search_files walks in pure Node and skips node_modules/.git unless inside', async () => {
  const home = tmpdir();
  const ex = createExecutors({ home });
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('proj/readme.md', 'intro\nNEEDLE here\n');
  put('proj/src/a.js', 'const x = 1;\n// needle lower\n');
  put('proj/node_modules/lib/index.js', 'NEEDLE in deps\n');
  put('proj/.git/config', 'NEEDLE in git\n');
  put('proj/bin.dat', Buffer.from([0, 1, 2, 78, 69, 69, 68, 76, 69]));
  const hits = parse(await ex.run('search_files', { root: '~/proj', pattern: 'NEEDLE' }));
  assert.deepEqual(hits.matches.map((m) => [path.relative(home, m.path).split(path.sep).join('/'), m.line]), [['proj/readme.md', 2]]);
  const ci = parse(await ex.run('search_files', { root: '~/proj', pattern: '(?i)needle' }));
  assert.equal(ci.matches.length, 2);
  const inside = parse(await ex.run('search_files', { root: '~/proj/node_modules', pattern: 'NEEDLE' }));
  assert.equal(inside.matches.length, 1);
  const names = parse(await ex.run('search_files', { root: '~/proj', name_glob: '*.md' }));
  assert.deepEqual(names.matches.map((m) => path.basename(m.path)), ['readme.md']);
  assert.equal(names.matches[0].line, null);
  const both = parse(await ex.run('search_files', { root: '~/proj', name_glob: '*.js', pattern: 'const' }));
  assert.equal(both.matches.length, 1);
  const capped = parse(await ex.run('search_files', { root: '~/proj', pattern: '.', max_results: 2 }));
  assert.equal(capped.matches.length, 2);
  assert.equal(capped.truncated, true);
  assert.match((await ex.run('search_files', { root: '~/proj' })).error, /pattern/);
  assert.match((await ex.run('search_files', { root: '~/proj', pattern: '(' })).error, /regular expression/);
  assert.ok(globToRegExp('*.MD', true).test('readme.md'));
  assert.ok(!globToRegExp('*.md', false).test('dir/readme.md'));
});

test('executors: run_command in the platform shell with exit codes, cwd, caps, timeout kill and elevation refusal', { timeout: 120000 }, async () => {
  const home = tmpdir();
  const confirms = [];
  let approve = false;
  const ex = createExecutors({
    home,
    computerName: () => 'Test-PC',
    limits: { ...protocol.LIMITS, runOutputBytes: 1000 },
    confirmElevation: async (req) => { confirms.push(req); return approve; },
  });
  const ok = parse(await ex.run('run_command', { command: 'echo intelio-ok' }));
  assert.equal(ok.exit_code, 0);
  assert.match(ok.stdout, /intelio-ok/);
  assert.equal(ok.stdout_truncated, false);
  assert.ok(ok.duration_ms >= 0);
  const fail = parse(await ex.run('run_command', { command: 'exit 3' }));
  assert.equal(fail.exit_code, 3);
  fs.mkdirSync(path.join(home, 'work dir'));
  const where = parse(await ex.run('run_command', { command: WIN ? '(Get-Location).Path' : 'pwd', cwd: '~/work dir' }));
  assert.equal(fs.realpathSync(where.stdout.trim()), fs.realpathSync(path.join(home, 'work dir')));
  const quotes = parse(await ex.run('run_command', { command: WIN ? `Write-Output "a 'b' ""c"" $([char]36)HOME"` : `printf '%s\\n' "a 'b' \\"c\\" \\$HOME"` }));
  assert.equal(quotes.stdout.trim(), `a 'b' "c" $HOME`);
  const loud = parse(await ex.run('run_command', { command: WIN ? `[Console]::Out.Write('x' * 5000); [Console]::Error.Write('e' * 3000)` : `head -c 5000 /dev/zero | tr '\\0' x; head -c 3000 /dev/zero | tr '\\0' e >&2` }));
  assert.equal(loud.stdout.length, 1000);
  assert.equal(loud.stdout_truncated, true);
  assert.equal(loud.stderr.length, 1000);
  assert.equal(loud.stderr_truncated, true);
  const started = Date.now();
  const slow = parse(await ex.run('run_command', { command: WIN ? 'Start-Sleep -Seconds 60' : 'sleep 60 & sleep 60', timeout_s: 2 }));
  assert.equal(slow.timed_out, true);
  assert.ok(Date.now() - started < 20000, `took ${Date.now() - started} ms`);

  const refused = await ex.run('run_command', { command: 'sudo rm -rf /' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^Refused: sudo asks for administrator rights\. intelio never elevates/);
  assert.match(refused.error, /Test-PC did not approve/);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].command, 'sudo rm -rf /');
  assert.match((await ex.run('run_command', { command: 'echo x', shell: 'sudo' })).error, /administrator/);
  // Approval runs the command as the user (never elevated); a comment keeps it harmless on every shell.
  approve = true;
  const approved = parse(await ex.run('run_command', { command: 'echo approved # with administrator privileges' }));
  assert.match(approved.stdout, /approved/);
  assert.equal(confirms.length, 2);
  // Abort (kill switch) stops a running command.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1500);
  const aborted = parse(await ex.run('run_command', { command: WIN ? 'Start-Sleep -Seconds 60' : 'sleep 60' }, { signal: controller.signal }));
  assert.equal(aborted.aborted, true);
});

test('screenshot executor returns MCP image content, and explains an empty capture', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const ex = createExecutors({ screenshot: async (display) => ({ png, width: 1920, height: 1080, count: 2, display }) });
  const r = await ex.run('screenshot', { display: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.content[0], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  assert.match(r.content[1].text, /Display 2 of 2: 1920x1080/);
  const empty = createExecutors({ screenshot: async () => ({ png: Buffer.alloc(0), width: 0, height: 0 }) });
  assert.match((await empty.run('screenshot', {})).error, /Screen Recording/);
  assert.match((await createExecutors().run('screenshot', {})).error, /not available/);
});

test('backoff runs 2 s doubling to 60 s; electron helpers pick the relay URL and defaults', () => {
  const fixed = (n) => backoffDelay(n, { random: () => 0 });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(fixed), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(backoffDelay(0, { random: () => 1 }), 2000);
  assert.ok(backoffDelay(5, { random: () => 1 }) >= 48000);
  const cloud = relayUrls({ mode: 'cloud', origin: 'https://app.intelio-ai.com', cookie: 'CF_Authorization=abc' }, {});
  assert.deepEqual(cloud, { urls: ['wss://app.intelio-ai.com/node/connect'], headers: { Cookie: 'CF_Authorization=abc' }, mode: 'cloud' });
  assert.equal(relayUrls({ mode: 'cloud', origin: 'https://app.intelio-ai.com', cookie: '' }, {}), null);
  const tail = relayUrls({ mode: 'tailscale', host: 'vps.tail1234.ts.net' }, {});
  assert.deepEqual(tail.urls, ['wss://vps.tail1234.ts.net:8643/node/connect', 'ws://vps.tail1234.ts.net:8643/node/connect']);
  assert.equal(relayUrls({ mode: 'tailscale', host: 'fd7a:115c::1' }, {}).urls[1], 'ws://[fd7a:115c::1]:8643/node/connect');
  assert.equal(relayUrls(null, {}), null);
  assert.equal(relayUrls(null, { INTELIO_NODE_RELAY_URL: 'wss://evil.example/node/connect' }), null, 'override is loopback-only');
  assert.equal(relayUrls(null, { INTELIO_NODE_RELAY_URL: 'ws://127.0.0.1:9/node/connect' }).urls[0], 'ws://127.0.0.1:9/node/connect');
  assert.deepEqual(nodePrefs({}), { enabled: true, name: '', asked: false, cleared: false, hold: false, askBeforeRisky: true });
  assert.deepEqual(nodePrefs({ intelioNode: { enabled: false, name: ' Desk\u0007 ' } }), { enabled: false, name: 'Desk', asked: false, cleared: false, hold: false, askBeforeRisky: true });
  assert.equal(deviceName({}, 'HOST-1'), 'HOST-1');
  assert.equal(deviceName({ intelioNode: { name: 'Studio' } }, 'HOST-1'), 'Studio');
  // Identity is only ever written encrypted; without OS encryption nothing is stored.
  const dir = tmpdir();
  const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString() };
  const store = createIdentityStore(path.join(dir, 'identity.bin'), fakeSafe);
  store.save({ device_id: 'n_1', device_secret: 'secret-value' });
  assert.ok(!fs.readFileSync(path.join(dir, 'identity.bin'), 'utf8').includes('secret-value'));
  assert.deepEqual(store.load(), { device_id: 'n_1', device_secret: 'secret-value' });
  const locked = createIdentityStore(path.join(dir, 'identity.bin'), { isEncryptionAvailable: () => false });
  assert.equal(locked.available(), false);
  assert.throws(() => locked.save({ device_id: 'n', device_secret: 's' }), /encryption/);
});

test('real node client enrolls, serves MCP calls end to end, audits, honors the kill switch and re-enrolls when forgotten', { timeout: 60000 }, async (t) => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'notes.txt'), 'secret file body');
  const registry = createNodeRegistry({ file: path.join(dir, 'nodes.json') });
  const relayLogs = [];
  const hub = createNodeHub({ registry, log: (l) => relayLogs.push(l) });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => hub.accept(req, socket, head, { login: 'test' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const token = crypto.randomBytes(32).toString('hex');
  const mcp = createNodesMcp({ hub, port: 0, token, log: () => {} });
  await mcp.listen();
  t.after(() => { hub.close(); server.close(); mcp.close(); });

  let saved = null;
  const identity = { available: () => true, load: () => saved, save: (v) => { saved = v; }, clear: () => { saved = null; } };
  const auditFile = path.join(dir, 'audit', 'audit.jsonl');
  const states = [];
  const client = createNodeClient({
    getTarget: async () => ({ urls: [`ws://127.0.0.1:${server.address().port}/node/connect`], mode: 'test' }),
    getInfo: () => ({ name: 'Desk', os: 'Test OS', arch: process.arch, user: 'me', version: '0.0.1' }),
    identity,
    executors: createExecutors({ home, computerName: () => 'Desk' }),
    audit: createAuditLog(auditFile),
    onState: (s) => states.push(s.status),
    backoff: () => 50,
  });
  const mcpCall = async (name, args) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const res = await fetch(`http://127.0.0.1:${mcp.server.address().port}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    return (await res.json()).result;
  };
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

  client.start();
  assert.ok(await waitFor(() => client.state().status === 'online'), JSON.stringify(states));
  assert.ok(saved && saved.device_id && saved.device_secret);
  const firstId = saved.device_id;
  const read = await mcpCall('read_file', { computer: 'desk', path: '~/notes.txt' });
  assert.equal(read.isError, false);
  assert.equal(read.content[1].text, 'secret file body');
  const run = await mcpCall('run_command', { computer: 'Desk', command: 'echo from-node' });
  assert.equal(run.isError, false);
  assert.match(JSON.parse(run.content[0].text).stdout, /from-node/);

  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.tool), ['read_file', 'run_command']);
  assert.equal(lines[1].exit_code, 0);
  assert.equal(lines[1].args.command, 'echo from-node');
  assert.ok(lines[0].result_bytes > 0);
  assert.ok(!fs.readFileSync(auditFile, 'utf8').includes('secret file body'));
  assert.ok(!relayLogs.join('\n').includes('secret file body'));

  // Reconnect reuses the identity (no new device).
  client.reconnect();
  assert.ok(await waitFor(() => client.state().status !== 'online'));
  assert.ok(await waitFor(() => client.state().status === 'online'));
  assert.equal(saved.device_id, firstId);
  assert.equal(registry.list().length, 1);

  // Kill switch: off disconnects; the relay reports it offline.
  client.stop();
  assert.ok(await waitFor(() => hub.live.size === 0));
  const off = await mcpCall('list_dir', { computer: 'Desk', path: '~' });
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /^Desk is offline/);

  // Unknown device (registry wiped on the VPS): the node forgets its identity and re-enrolls.
  fs.writeFileSync(path.join(dir, 'nodes.json'), JSON.stringify({ version: 1, devices: [] }));
  client.start();
  assert.ok(await waitFor(() => client.state().status === 'online' && saved && saved.device_id !== firstId));

  // Revoked: the node stops dialing.
  registry.revoke('Desk');
  hub.recheck();
  assert.ok(await waitFor(() => client.state().status === 'revoked'));
  client.kick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.state().status, 'revoked');
  client.stop();
});
