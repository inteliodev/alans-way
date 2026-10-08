'use strict';
// intelio node stage 2: persistent terminal sessions (desktop/src/intelio/node/sessions.cjs).
// Real shells on the host: PowerShell on Windows, the login shell (bash in Docker) elsewhere.
// Every scenario runs with node-pty and again with the piped fallback.
// Contract: docs/intelio-node.md ("Stage 2: persistent terminal sessions").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExecutors } = require('../src/intelio/node/executors.cjs');
const { createNodeClient } = require('../src/intelio/node/client.cjs');
const protocol = require('../src/intelio/node/protocol.cjs');
const {
  stripAnsi, keySequence, Ring, utf8Boundary, incompleteEscapeAt, defaultLoadPty, KEYS,
} = require('../src/intelio/node/sessions.cjs');

const WIN = process.platform === 'win32';
const ptyLoad = defaultLoadPty();
const MODES = [
  { name: 'pty', loadPty: () => ptyLoad, skip: ptyLoad.pty ? false : `node-pty unavailable here: ${ptyLoad.error}` },
  { name: 'pipe', loadPty: () => ({ error: 'disabled by the test' }), skip: false },
];

// Shell snippets whose OUTPUT differs from their echoed INPUT (so a match proves execution).
const sh = {
  print: (tag) => (WIN ? `Write-Output ('${tag}-' + (6*7))` : `echo "${tag}-$((6*7))"`),
  exit: (code) => `exit ${code}`,
  printThenExit: (tag, code) => (WIN ? `Write-Output ('${tag}-' + (6*7)); exit ${code}` : `echo "${tag}-$((6*7))"; exit ${code}`),
  flood: (n) => (WIN ? `Write-Output ('x' * ${n})` : `head -c ${n} /dev/zero | tr '\\0' x; echo`),
  sleep: () => (WIN ? 'Start-Sleep -Seconds 600' : 'sleep 600'),
};

function parse(result) {
  assert.ok(result.ok, result.error);
  return JSON.parse(result.content[0].text);
}

async function read(ex, sessionId, args = {}) {
  const r = await ex.run('read_output', { session_id: sessionId, ...args });
  assert.ok(r.ok, r.error);
  return { ...JSON.parse(r.content[0].text), output: r.content[1].text };
}

/** Reads until predicate(accumulated text, last meta) or the deadline. */
async function readUntil(ex, sessionId, predicate, ms = 30000) {
  const end = Date.now() + ms;
  let text = '';
  let last = null;
  while (Date.now() < end) {
    last = await read(ex, sessionId, { wait_ms: 1000 });
    text += last.output;
    if (predicate(text, last)) return { text, last };
    if (last.exited) break;
  }
  return { text, last };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
};

function makeExecutors(t, mode, extra = {}) {
  const ex = createExecutors({
    limits: { ...protocol.LIMITS, ...(extra.limits || {}) },
    confirmElevation: extra.confirmElevation || (async () => false),
    computerName: () => 'Test-PC',
    sessionOptions: { loadPty: mode.loadPty, ...(extra.sessionOptions || {}) },
  });
  t.after(() => ex.closeSessions());
  return ex;
}

test('protocol: the five session tools are node tools with schemas, timeouts and masked audit', () => {
  for (const name of ['start_session', 'send_input', 'read_output', 'stop_session', 'list_sessions']) {
    assert.ok(protocol.NODE_TOOLS.includes(name), name);
    const tool = protocol.TOOLS.find((x) => x.name === name);
    assert.ok(tool.inputSchema.required.includes('computer'), name);
  }
  assert.equal(protocol.callTimeoutMs('read_output', {}), 12000);
  assert.equal(protocol.callTimeoutMs('read_output', { wait_ms: 30000 }), 40000);
  assert.equal(protocol.callTimeoutMs('read_output', { wait_ms: 999999 }), 40000);
  assert.equal(protocol.callTimeoutMs('read_output', { wait_ms: 0 }), 10000);
  assert.equal(protocol.callTimeoutMs('start_session', {}), 130000);

  const GH = ['gh', 'p_'].join(''); // built at runtime for the publication scan
  const typed = `export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv && claude --token hunter2hunter2 Bearer abc.def ${GH}1234567890abcdefghij and then a lot more words to pass eighty chars`;
  const node = protocol.summarizeArgs('send_input', { session_id: 's_1', text: typed, keys: ['ctrl-c'] }, 'node');
  assert.equal(node.text_chars, typed.length);
  assert.ok(node.text_preview.length <= 80);
  for (const secret of ['sk-abcdefghijklmnopqrstuv', 'hunter2hunter2', `${GH}1234567890`, 'abc.def']) assert.ok(!node.text_preview.includes(secret), node.text_preview);
  assert.deepEqual(node.keys, ['ctrl-c']);
  const relay = protocol.summarizeArgs('send_input', { session_id: 's_1', text: typed }, 'relay');
  assert.equal(relay.text_preview, undefined, 'the relay never logs typed text');
  assert.equal(relay.text_chars, typed.length);
  const start = protocol.summarizeArgs('start_session', { command: 'claude --api-key=sk-zzzzzzzzzzzzzzzzzz', env: { ANTHROPIC_API_KEY: 'sk-secret-value-123456' } }, 'node');
  assert.equal(start.program, 'claude');
  assert.deepEqual(start.env_keys, ['ANTHROPIC_API_KEY']);
  assert.ok(!JSON.stringify(start).includes('sk-zzzz') && !JSON.stringify(start).includes('secret-value'));
  assert.equal(protocol.summarizeArgs('start_session', { command: 'claude --resume' }, 'relay').command_preview, undefined);
});

test('named keys map to terminal bytes; unknown keys are refused', () => {
  assert.equal(keySequence('ctrl-c'), '\x03');
  assert.equal(keySequence('ctrl-d'), '\x04');
  assert.equal(keySequence('esc'), '\x1b');
  assert.equal(keySequence('tab'), '\t');
  assert.equal(keySequence('up'), '\x1b[A');
  assert.equal(keySequence('down'), '\x1b[B');
  assert.equal(keySequence('right'), '\x1b[C');
  assert.equal(keySequence('left'), '\x1b[D');
  assert.equal(keySequence('enter'), '\r');
  assert.equal(keySequence('backspace'), '\x7f');
  assert.equal(keySequence('Ctrl+C'), '\x03');
  assert.equal(keySequence('ctrl-z'), '\x1a');
  assert.equal(keySequence('ctrl-a'), '\x01');
  assert.throws(() => keySequence('f13'), /Unknown key f13/);
  assert.ok(Object.keys(KEYS).length >= 10);
});

test('ANSI stripping, escape and UTF-8 boundaries, ring buffer offsets', () => {
  assert.equal(stripAnsi('\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b[93mhello\x1b[0m\x1b[3Cworld\x1b]0;title\x07\r\n'), '\nhello   world\n');
  assert.equal(stripAnsi('abc\x08\x08x\r\n'), 'ax\n');
  assert.equal(stripAnsi('\x1b(B\x1b=ok\x1bP1;2q\x1b\\'), 'ok');
  assert.equal(incompleteEscapeAt('text\x1b[3'), 4);
  assert.equal(incompleteEscapeAt('text\x1b[31m'), -1);
  assert.equal(incompleteEscapeAt('text\x1b]0;title'), 4);
  const euro = Buffer.from('a€', 'utf8'); // 1 + 3 bytes
  assert.equal(utf8Boundary(euro.subarray(0, 3)), 1);
  assert.equal(utf8Boundary(euro), 4);

  const ring = new Ring(10);
  ring.push(Buffer.from('0123456'));
  ring.push(Buffer.from('789abcdef'));
  assert.equal(ring.end, 16);
  assert.equal(ring.start, 6);
  assert.equal(ring.slice(0, 100).toString(), '6789abcdef');
  assert.equal(ring.slice(8, 11).toString(), '89a');
  ring.push(Buffer.from('ghijklmnopqrstuvwxyz'));
  assert.equal(ring.start, 26);
  assert.equal(ring.slice(0, 1000).toString(), 'qrstuvwxyz');
});

for (const mode of MODES) {
  test(`[${mode.name}] login shell: start, send, read with cursors, long-poll, list, exit code, stop`, { skip: mode.skip, timeout: 120000 }, async (t) => {
    const ex = makeExecutors(t, mode);
    const started = parse(await ex.run('start_session', { cwd: os.tmpdir(), cols: 100, rows: 30 }));
    assert.match(started.session_id, /^s_[0-9a-f]{12}$/);
    assert.equal(started.pty, mode.name === 'pty');
    assert.ok(Number.isInteger(started.pid) && started.pid > 0);
    const id = started.session_id;

    // A long poll with nothing to say waits wait_ms, then returns empty.
    if (mode.name === 'pipe') {
      const t0 = Date.now();
      const quiet = await read(ex, id, { wait_ms: 400 });
      assert.ok(Date.now() - t0 >= 350, `returned after ${Date.now() - t0} ms`);
      assert.equal(quiet.output, '');
      assert.equal(quiet.exited, false);
    } else {
      await readUntil(ex, id, (text) => />\s*$|\$\s*$|#\s*$|%\s*$/.test(text), 20000); // prompt
    }

    // The long poll returns early when output arrives.
    const t1 = Date.now();
    const pending = read(ex, id, { wait_ms: 25000 });
    setTimeout(() => { ex.run('send_input', { session_id: id, text: sh.print('mk') }); }, 300);
    let got = await pending;
    let text = got.output;
    if (!/mk-42/.test(text)) text += (await readUntil(ex, id, (s) => /mk-42/.test(s), 20000)).text;
    assert.match(text, /mk-42/);
    assert.ok(Date.now() - t1 < 22000, 'long poll did not return early');
    assert.ok(!/\x1b/.test(text), 'ANSI escapes are stripped by default');

    // Cursor semantics: since=0 replays everything; since=cursor with wait 0 is empty; no since continues.
    const now = await read(ex, id, { wait_ms: 0 });
    const replay = await read(ex, id, { since: 0, wait_ms: 0 });
    assert.match(replay.output, /mk-42/);
    assert.equal(replay.cursor, now.cursor);
    const empty = await read(ex, id, { since: now.cursor, wait_ms: 0 });
    assert.equal(empty.output, '');
    assert.equal(empty.cursor, now.cursor);
    const ahead = await read(ex, id, { since: now.cursor + 999999, wait_ms: 0 });
    assert.equal(ahead.cursor, now.cursor, 'a cursor past the end clamps to the end');
    if (mode.name === 'pty') {
      const raw = await read(ex, id, { since: 0, wait_ms: 0, raw: true });
      assert.match(raw.output, /mk-42/);
    }

    parse(await ex.run('send_input', { session_id: id, text: sh.print('second') }));
    const after = await readUntil(ex, id, (s) => /second-42/.test(s));
    assert.match(after.text, /second-42/);
    assert.ok(!/mk-42/.test(after.text), 'reads without since continue after the last read');
    assert.ok(after.last.cursor > now.cursor);

    const listed = parse(await ex.run('list_sessions', {}));
    assert.equal(listed.sessions.length, 1);
    const row = listed.sessions[0];
    assert.equal(row.id, id);
    assert.equal(row.command, '(login shell)');
    assert.equal(row.cwd, os.tmpdir());
    assert.equal(row.exited, false);
    assert.ok(row.idle_s >= 0 && !Number.isNaN(Date.parse(row.started)));

    // Exit detection with the exit code.
    parse(await ex.run('send_input', { session_id: id, text: sh.exit(3) }));
    const done = await readUntil(ex, id, (_, m) => m.exited);
    assert.equal(done.last.exited, true);
    assert.equal(done.last.exit_code, 3);
    const late = await ex.run('send_input', { session_id: id, text: 'echo nope' });
    assert.equal(late.ok, false);
    assert.match(late.error, /has exited/);
    assert.equal(parse(await ex.run('list_sessions', {})).sessions[0].exited, true);
    const stopped = parse(await ex.run('stop_session', { session_id: id }));
    assert.equal(stopped.exit_code, 3);
    assert.equal(stopped.stopped, false);
    assert.equal(parse(await ex.run('list_sessions', {})).sessions.length, 0);
    const gone = await ex.run('read_output', { session_id: id });
    assert.equal(gone.ok, false);
    assert.match(gone.error, /No session/);
  });

  test(`[${mode.name}] command sessions exit by themselves; stop kills a running one; keys reach the program`, { skip: mode.skip, timeout: 120000 }, async (t) => {
    const ex = makeExecutors(t, mode);
    const quick = parse(await ex.run('start_session', { command: sh.printThenExit('cmd', 5) }));
    assert.notEqual(quick.command, '(login shell)');
    const q = await readUntil(ex, quick.session_id, (_, m) => m.exited);
    assert.match(q.text, /cmd-42/);
    assert.equal(q.last.exit_code, 5);

    const envRun = parse(await ex.run('start_session', { command: WIN ? 'Write-Output "env=$env:INTELIO_TEST_VAR"' : 'echo "env=$INTELIO_TEST_VAR"', env: { INTELIO_TEST_VAR: 'v123' } }));
    assert.match((await readUntil(ex, envRun.session_id, (s) => /env=v123/.test(s))).text, /env=v123/);
    const badEnv = await ex.run('start_session', { env: { 'BAD NAME': 'x' } });
    assert.equal(badEnv.ok, false);

    const long = parse(await ex.run('start_session', { command: mode.name === 'pty' && !WIN ? 'echo sleeping-now; sleep 600' : sh.sleep() }));
    assert.ok(alive(long.pid));
    if (mode.name === 'pty' && !WIN) {
      // ctrl-c reaches the foreground program through the terminal. Wait until the shell is
      // past its start-up (an interactive shell ignores SIGINT while it reads rc files).
      await readUntil(ex, long.session_id, (text) => /sleeping-now/.test(text), 15000);
      await new Promise((r) => setTimeout(r, 300));
      parse(await ex.run('send_input', { session_id: long.session_id, keys: ['ctrl-c'] }));
      const c = await readUntil(ex, long.session_id, (_, m) => m.exited, 15000);
      assert.equal(c.last.exited, true, 'ctrl-c did not stop sleep');
    } else {
      const killed = parse(await ex.run('stop_session', { session_id: long.session_id, force: true }));
      assert.equal(killed.stopped, true);
      assert.ok(await waitFor(() => !alive(long.pid)), 'process survived stop_session');
    }
    const keysOnly = await ex.run('send_input', { session_id: 'missing', keys: ['tab'] });
    assert.equal(keysOnly.ok, false);
    assert.match(keysOnly.error, /No session missing/);
    const missingCwd = await ex.run('start_session', { cwd: path.join(os.tmpdir(), 'no-such-dir-intelio') });
    assert.equal(missingCwd.ok, false);
    assert.match(missingCwd.error, /cwd not found/);
    const relative = await ex.run('start_session', { cwd: 'relative/dir' });
    assert.equal(relative.ok, false);
  });

  test(`[${mode.name}] max sessions, ring-buffer truncation and max_bytes`, { skip: mode.skip, timeout: 120000 }, async (t) => {
    const ex = makeExecutors(t, mode, { limits: { sessionMax: 2, sessionBufferBytes: 4096 } });
    const a = parse(await ex.run('start_session', { command: sh.sleep() }));
    const b = parse(await ex.run('start_session', { command: sh.sleep() }));
    const c = await ex.run('start_session', {});
    assert.equal(c.ok, false);
    assert.match(c.error, /already has 2 sessions/);
    parse(await ex.run('stop_session', { session_id: a.session_id, force: true }));

    const flood = parse(await ex.run('start_session', { command: sh.flood(20000), cols: 200 }));
    let last;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      last = parse(await ex.run('list_sessions', {})).sessions.find((s) => s.id === flood.session_id);
      if (last.exited) break;
    }
    assert.ok(last.exited, 'flood command did not finish');
    assert.ok(last.cursor >= 20000, `cursor ${last.cursor}`);
    const first = await read(ex, flood.session_id, { since: 0, wait_ms: 0, max_bytes: 100 });
    assert.equal(first.truncated, true);
    assert.ok(first.dropped_bytes >= last.cursor - 4096);
    assert.equal(first.more, true);
    assert.ok(first.bytes <= 100);
    const rest = await read(ex, flood.session_id, { since: first.cursor, wait_ms: 0, max_bytes: 1024 * 1024 });
    assert.equal(rest.cursor, last.cursor);
    assert.ok(rest.bytes <= 4096);
    assert.equal(rest.exited, true);
    assert.equal(rest.truncated, false);
    assert.match(rest.output, /x{100}/);

    // A finished session is forgotten to make room for a new one.
    const d = await ex.run('start_session', { command: sh.sleep() });
    assert.ok(d.ok, d.error);
    assert.equal(parse(await ex.run('list_sessions', {})).sessions.length, 2);
    parse(await ex.run('stop_session', { session_id: b.session_id, force: true }));
  });

  test(`[${mode.name}] elevation is refused on the start command and on typed text`, { skip: mode.skip, timeout: 60000 }, async (t) => {
    const asked = [];
    const ex = makeExecutors(t, mode, { confirmElevation: async (req) => { asked.push(req); return false; } });
    const start = await ex.run('start_session', { command: 'sudo -s' });
    assert.equal(start.ok, false);
    assert.match(start.error, /Refused: sudo asks for administrator rights.*Test-PC did not approve/);
    assert.equal(parse(await ex.run('list_sessions', {})).sessions.length, 0);
    const s = parse(await ex.run('start_session', {}));
    for (const text of ['sudo rm -rf /tmp/x', 'Start-Process powershell -Verb RunAs']) {
      const typed = await ex.run('send_input', { session_id: s.session_id, text });
      assert.equal(typed.ok, false);
      assert.match(typed.error, /^Refused:/);
    }
    assert.deepEqual(asked.map((r) => r.command), ['sudo -s', 'sudo rm -rf /tmp/x', 'Start-Process powershell -Verb RunAs']);
    const replay = await read(ex, s.session_id, { since: 0, wait_ms: 300 });
    assert.ok(!/sudo|RunAs/.test(replay.output), 'refused text must never reach the terminal');
  });

  test(`[${mode.name}] kill switch off / quit kills every session; idle sessions are reaped`, { skip: mode.skip, timeout: 60000 }, async (t) => {
    let clock = Date.now();
    const reaped = [];
    const ex = makeExecutors(t, mode, { sessionOptions: { now: () => clock, onReap: (r) => reaped.push(r) }, limits: { sessionIdleMs: 60000 } });
    const one = parse(await ex.run('start_session', { command: sh.sleep() }));
    const two = parse(await ex.run('start_session', {}));
    const pending = read(ex, two.session_id, { wait_ms: 25000, since: 1e9 });
    // The kill switch path: client.stop() calls executors.closeSessions().
    const client = createNodeClient({
      getTarget: async () => null,
      getInfo: () => ({ name: 'Test-PC' }),
      identity: { available: () => true, load: () => null, save() {}, clear() {} },
      executors: ex,
      backoff: () => 60000,
    });
    client.start();
    client.stop('turned off');
    const woke = await pending;
    assert.ok(woke.cursor >= 0, 'a pending long poll returns when its session is killed');
    assert.equal(parse(await ex.run('list_sessions', {})).sessions.length, 0);
    assert.ok(await waitFor(() => !alive(one.pid) && !alive(two.pid)), 'sessions survived the kill switch');

    const idle = parse(await ex.run('start_session', { command: sh.sleep() }));
    clock += 30000;
    ex.sessions.sweep();
    assert.equal(parse(await ex.run('list_sessions', {})).sessions.length, 1);
    clock += 61000;
    ex.sessions.sweep();
    assert.equal(parse(await ex.run('list_sessions', {})).sessions.length, 0);
    assert.deepEqual(reaped.map((r) => [r.id, r.reason]), [[idle.session_id, 'idle']]);
    assert.ok(await waitFor(() => !alive(idle.pid)), 'idle session survived the reaper');
  });
}

test('node-pty fallback is reported, not fatal', async (t) => {
  const ex = makeExecutors(t, { loadPty: () => ({ error: 'node-pty did not load: test' }) });
  const s = parse(await ex.run('start_session', { command: sh.printThenExit('fb', 0) }));
  assert.equal(s.pty, false);
  assert.match(s.note, /node-pty did not load: test; using pipes/);
  assert.match(s.hint, /full-screen programs may misbehave/);
  assert.match((await readUntil(ex, s.session_id, (_, m) => m.exited)).text, /fb-42/);
});

test('the audit file gets a masked preview of typed text and never the output', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-sess-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createAuditLog } = require('../src/intelio/node/client.cjs');
  const file = path.join(dir, 'audit.jsonl');
  const audit = createAuditLog(file);
  const ex = makeExecutors(t, MODES[1]);
  const s = parse(await ex.run('start_session', {}));
  const typed = WIN ? 'Write-Output ("out-" + "put-" + "marker") # token=abcdef1234567890abcdef' : 'echo "out-""put-""marker" # token=abcdef1234567890abcdef';
  const sent = await ex.run('send_input', { session_id: s.session_id, text: typed });
  audit({ tool: 'send_input', args: protocol.summarizeArgs('send_input', { session_id: s.session_id, text: typed }, 'node'), ok: sent.ok });
  const out = await readUntil(ex, s.session_id, (x) => /out-put-marker/.test(x));
  assert.match(out.text, /out-put-marker/);
  audit({ tool: 'read_output', args: protocol.summarizeArgs('read_output', { session_id: s.session_id, wait_ms: 1000 }, 'node'), ok: true, result_bytes: out.text.length });
  const lines = fs.readFileSync(file, 'utf8');
  assert.ok(!lines.includes('out-put-marker'), 'output must never be audited');
  assert.ok(!lines.includes('abcdef1234567890abcdef'), 'secrets are masked');
  const previews = lines.trim().split('\n').map((l) => JSON.parse(l).args.text_preview).filter(Boolean);
  assert.equal(previews.length, 1);
  assert.match(previews[0], /token=\*\*\*/);
  assert.ok(previews[0].length <= 80);
});
