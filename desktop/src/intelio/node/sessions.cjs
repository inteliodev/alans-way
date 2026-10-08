'use strict';
/**
 * intelio node stage 2: persistent interactive terminal sessions
 * (docs/intelio-node.md, "Stage 2"). Lets the VPS agent run Claude Code,
 * Codex, a REPL or a shell on this computer and talk to it over many turns.
 *
 * - PTY via node-pty (N-API prebuilds for win32-x64/arm64 and darwin-arm64/x64,
 *   built from source on Linux). If node-pty cannot load or spawn, the session
 *   falls back to a piped child process and reports pty: false (no terminal:
 *   full-screen TUIs may misbehave or refuse to start).
 * - Output goes into a ring buffer (1 MB per session) addressed by a monotonic
 *   byte cursor; read() long-polls until new output, exit or wait_ms.
 * - At most 8 sessions per computer; sessions idle (no input and no read) for
 *   2 h are killed; closeAll() kills everything (kill switch off, revoke, quit).
 *
 * Pure Node (no Electron) so tests drive it on any OS. Elevation checks and the
 * audit live in executors.cjs / client.cjs like every other tool.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULTS = Object.freeze({
  sessionMax: 8,
  sessionIdleMs: 2 * 60 * 60 * 1000,
  sessionBufferBytes: 1024 * 1024,
  sessionReadDefaultBytes: 64 * 1024,
  sessionReadMaxBytes: 1024 * 1024,
  sessionWaitDefaultMs: 2000,
  sessionWaitMaxMs: 30000,
  sessionInputChars: 64 * 1024,
});

/** Named keys for send_input. ctrl-a … ctrl-z are accepted too. */
const KEYS = Object.freeze({
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  backspace: '\x7f',
});

class SessionError extends Error {}

function keySequence(name) {
  const key = String(name || '').trim().toLowerCase().replace(/[+_ ]/g, '-');
  if (Object.prototype.hasOwnProperty.call(KEYS, key)) return KEYS[key];
  const ctrl = /^(?:ctrl|control|c)-([a-z])$/.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  throw new SessionError(`Unknown key ${String(name).slice(0, 30)}. Use ${Object.keys(KEYS).filter((k) => k !== 'escape').join(', ')} or ctrl-a … ctrl-z.`);
}

// A complete escape sequence at the start of a string.
const ESC_COMPLETE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[P^_X][\s\S]*?\x1b\\|[ -/]*[0-~])/;

/**
 * Terminal output → plain text. Cursor-forward becomes spaces, cursor
 * positioning becomes a line break, everything else (colors, modes, titles)
 * is dropped. Good enough for an agent to read prompts and answers; it is not
 * a terminal emulator (full-screen redraws come out as a running log).
 */
function stripAnsi(text) {
  let out = String(text);
  out = out.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');
  out = out.replace(/\x1b[P^_X][\s\S]*?\x1b\\/g, '');
  out = out.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(200, Number(n || 1))));
  out = out.replace(/\x1b\[[0-9;]*[Hf]/g, '\n');
  out = out.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  out = out.replace(/\x1b[ -/]*[0-~]/g, '');
  out = out.replace(/\r+\n/g, '\n').replace(/\r/g, '\n');
  // Backspace erases the character before it.
  for (let i = 0; i < 64 && /[^\n\x08]\x08/.test(out); i += 1) out = out.replace(/[^\n\x08]\x08/g, '');
  out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out;
}

/** Where an unfinished escape sequence begins at the end of text, or -1. */
function incompleteEscapeAt(text) {
  const at = text.lastIndexOf('\x1b');
  if (at < 0 || text.length - at > 4096) return -1;
  return ESC_COMPLETE.test(text.slice(at)) ? -1 : at;
}

/** Fixed-size byte ring addressed by absolute offsets (the cursor). */
class Ring {
  constructor(capacity) {
    this.capacity = capacity;
    this.chunks = []; // { at, buf }
    this.start = 0; // oldest offset still held
    this.end = 0; // next offset to be written (the cursor after everything)
  }

  push(buf) {
    if (!buf.length) return;
    this.chunks.push({ at: this.end, buf });
    this.end += buf.length;
    while (this.end - this.start > this.capacity) {
      const first = this.chunks[0];
      const over = this.end - this.start - this.capacity;
      const firstEnd = first.at + first.buf.length;
      if (firstEnd - this.start <= over) {
        this.chunks.shift();
        this.start = firstEnd;
      } else {
        this.start += over;
        const keep = Buffer.from(first.buf.subarray(this.start - first.at));
        this.chunks[0] = { at: this.start, buf: keep };
      }
    }
  }

  /** Bytes [from, to) (clamped to what is held). */
  slice(from, to) {
    const lo = Math.max(from, this.start);
    const hi = Math.min(to, this.end);
    if (hi <= lo) return Buffer.alloc(0);
    const parts = [];
    for (const { at, buf } of this.chunks) {
      const cEnd = at + buf.length;
      if (cEnd <= lo) continue;
      if (at >= hi) break;
      parts.push(buf.subarray(Math.max(0, lo - at), Math.min(buf.length, hi - at)));
    }
    return Buffer.concat(parts);
  }
}

/** Length of a valid UTF-8 prefix of buf that does not end inside a character. */
function utf8Boundary(buf) {
  let i = buf.length;
  let back = 0;
  while (i > 0 && back < 4 && (buf[i - 1] & 0xc0) === 0x80) { i -= 1; back += 1; }
  if (i === 0) return buf.length;
  const lead = buf[i - 1];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return back + 1 >= need ? buf.length : i - 1;
}

/** Load node-pty once. Returns { pty } or { error }. */
function defaultLoadPty({ platform = process.platform, arch = process.arch } = {}) {
  let pty;
  try {
    // Packaged Windows build: electron-builder unpacks node-pty (asarUnpack). Load it from
    // app.asar.unpacked so its native addons, ConPTY worker script and helpers all live on
    // the real file system rather than behind Electron's asar shim.
    let id = 'node-pty';
    try {
      const main = require.resolve('node-pty');
      const unpacked = main.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      if (unpacked !== main && fs.existsSync(unpacked)) id = unpacked;
    } catch { /* not resolvable: the require below reports it */ }
    pty = require(id);
  } catch (error) {
    return { error: `node-pty did not load: ${String(error && error.message || error).split('\n')[0].slice(0, 300)}` };
  }
  if (platform !== 'win32') {
    // node-pty 1.1.0 ships spawn-helper without the execute bit; the posix
    // backend needs it executable (posix_spawnp failed otherwise).
    try {
      const root = path.dirname(require.resolve('node-pty/package.json')).replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
      for (const dir of ['build/Release', `prebuilds/${platform}-${arch}`]) {
        const helper = path.join(root, dir, 'spawn-helper');
        try { const st = fs.statSync(helper); if ((st.mode & 0o111) !== 0o111) fs.chmodSync(helper, 0o755); } catch { /* absent or read-only */ }
      }
    } catch { /* resolve failed: spawn reports it */ }
  }
  return { pty };
}

function killProcessTree(pid, platform, signal = 'SIGKILL') {
  if (!pid) return;
  if (platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}

function createSessionManager({
  platform = process.platform,
  home,
  env = process.env,
  limits = {},
  loadPty = () => defaultLoadPty({ platform }),
  now = () => Date.now(),
  sweepMs = 60000,
  onReap = () => {},
} = {}) {
  const L = { ...DEFAULTS, ...limits };
  const sessions = new Map();
  let ptyCache = null;
  let sweeper = null;

  function getPty() {
    if (!ptyCache) ptyCache = loadPty() || { error: 'node-pty is not available.' };
    return ptyCache;
  }

  function defaultShell() {
    if (platform === 'win32') return { kind: 'powershell', file: 'powershell.exe' };
    const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
    const file = candidates.find((c) => c && path.isAbsolute(c) && fs.existsSync(c));
    if (!file) throw new SessionError('No login shell found on this computer.');
    return { kind: 'posix', file };
  }

  /** argv for the session: the login shell, or the command run through it. */
  function argvFor(command, usePty) {
    const shell = defaultShell();
    if (shell.kind === 'powershell') {
      if (!command) return { file: shell.file, args: usePty ? ['-NoLogo'] : ['-NoLogo', '-NoProfile', '-Command', '-'] };
      const script = `$ProgressPreference='SilentlyContinue'\n${command}`;
      return { file: shell.file, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
    }
    if (!command) return { file: shell.file, args: ['-l'] };
    // With a terminal, -i also reads the interactive rc files (nvm, PATH tweaks in ~/.zshrc).
    return { file: shell.file, args: usePty ? ['-l', '-i', '-c', command] : ['-l', '-c', command] };
  }

  function cleanEnv(extra) {
    const out = { ...env };
    if (extra === undefined || extra === null) return out;
    if (typeof extra !== 'object' || Array.isArray(extra)) throw new SessionError('env must be an object of NAME: value strings.');
    const entries = Object.entries(extra);
    if (entries.length > 64) throw new SessionError('env: at most 64 variables.');
    for (const [key, value] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new SessionError(`env: bad variable name ${key.slice(0, 40)}.`);
      if (value === null) { delete out[key]; continue; }
      out[key] = String(value).slice(0, 32768);
    }
    return out;
  }

  function live() { return [...sessions.values()].filter((s) => !s.exited); }

  function ensureSweeper() {
    if (sweeper || !sessions.size) return;
    sweeper = setInterval(sweep, sweepMs);
    sweeper.unref?.();
  }

  function stopSweeperIfIdle() {
    if (sweeper && !sessions.size) { clearInterval(sweeper); sweeper = null; }
  }

  function sweep() {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (t - s.lastActive > L.sessionIdleMs) {
        kill(s, true);
        sessions.delete(s.id);
        try { onReap({ id: s.id, reason: 'idle', idle_s: Math.round((t - s.lastActive) / 1000) }); } catch { /* listener */ }
      }
    }
    stopSweeperIfIdle();
  }

  function wake(s) {
    const waiters = [...s.waiters];
    s.waiters.clear();
    for (const fn of waiters) fn();
  }

  function markExited(s, code, signal) {
    if (s.exitSeen) return;
    s.exitSeen = true;
    s.exitCode = Number.isInteger(code) ? code : null;
    s.signal = signal || null;
    // Let trailing output land before readers see exited (ConPTY flushes after exit).
    setTimeout(() => {
      s.exited = true;
      s.endedAt = now();
      if (s.term && platform === 'win32') {
        // Releases node-pty's ConPTY output worker thread (kill() would fork a helper).
        try { s.term._agent?._conoutSocketWorker?.dispose?.(); } catch { /* already gone */ }
      }
      wake(s);
      for (const fn of s.exitWaiters) fn();
      s.exitWaiters.clear();
    }, s.term ? 150 : 0).unref?.();
  }

  function append(s, text) {
    if (!text) return;
    s.ring.push(Buffer.from(text, 'utf8'));
    s.lastOutput = now();
    wake(s);
  }

  function start({ command = '', cwd, cols = 120, rows = 40, env: extraEnv } = {}) {
    for (const s of [...sessions.values()]) {
      if (sessions.size < L.sessionMax) break;
      if (s.exited) sessions.delete(s.id); // make room by forgetting the oldest finished session
    }
    if (live().length >= L.sessionMax || sessions.size >= L.sessionMax) {
      throw new SessionError(`This computer already has ${L.sessionMax} sessions; stop one first (list_sessions, stop_session).`);
    }
    const workdir = cwd || home;
    let st;
    try { st = fs.statSync(workdir); } catch { throw new SessionError(`cwd not found: ${workdir}`); }
    if (!st.isDirectory()) throw new SessionError(`cwd is not a folder: ${workdir}`);
    const c = Math.min(500, Math.max(20, Math.floor(Number(cols) || 120)));
    const r = Math.min(200, Math.max(5, Math.floor(Number(rows) || 40)));
    const childEnv = cleanEnv(extraEnv);
    const cmd = String(command || '').trim();
    const s = {
      id: `s_${crypto.randomBytes(6).toString('hex')}`,
      command: cmd || '(login shell)',
      cwd: workdir,
      cols: c,
      rows: r,
      started: now(),
      lastActive: now(),
      lastOutput: 0,
      ring: new Ring(L.sessionBufferBytes),
      readCursor: 0,
      waiters: new Set(),
      exitWaiters: new Set(),
      exited: false,
      exitSeen: false,
      exitCode: null,
      signal: null,
      term: null,
      child: null,
      pty: false,
      note: '',
      pid: null,
    };
    const loaded = getPty();
    if (loaded.pty) {
      const { file, args } = argvFor(cmd, true);
      const ptyEnv = platform === 'win32' ? childEnv : { ...childEnv, TERM: childEnv.TERM && childEnv.TERM !== 'dumb' ? childEnv.TERM : 'xterm-256color' };
      try {
        s.term = loaded.pty.spawn(file, args, { name: 'xterm-256color', cols: c, rows: r, cwd: workdir, env: ptyEnv, useConpty: true });
        s.pty = true;
        s.pid = s.term.pid;
        s.term.onData((data) => append(s, data));
        s.term.onExit(({ exitCode, signal }) => markExited(s, exitCode, signal ? String(signal) : null));
      } catch (error) {
        s.term = null;
        s.note = `PTY failed (${String(error && error.message || error).slice(0, 200)}); using pipes.`;
      }
    } else {
      s.note = `${loaded.error || 'node-pty unavailable'}; using pipes.`;
    }
    if (!s.term) {
      const { file, args } = argvFor(cmd, false);
      const pipedEnv = { ...childEnv, COLUMNS: String(c), LINES: String(r) };
      let child;
      try {
        child = spawn(file, args, { cwd: workdir, env: pipedEnv, windowsHide: true, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        throw new SessionError(`Could not start ${file}: ${error.message}`);
      }
      s.child = child;
      s.pid = child.pid || null;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => append(s, d));
      child.stderr.on('data', (d) => append(s, d));
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        append(s, `\n[intelio] ${error.code === 'ENOENT' ? `${file} was not found on this computer.` : String(error.message).slice(0, 300)}\n`);
        markExited(s, null, null);
      });
      child.on('close', (code, signal) => markExited(s, code, signal));
    }
    sessions.set(s.id, s);
    ensureSweeper();
    return describe(s, { pid: s.pid, ...(s.note ? { note: s.note } : {}) });
  }

  function describe(s, extra = {}) {
    return {
      session_id: s.id,
      command: s.command,
      cwd: s.cwd,
      pty: s.pty,
      ...extra,
    };
  }

  function get(id) {
    const s = sessions.get(String(id || ''));
    if (!s) throw new SessionError(`No session ${String(id || '').slice(0, 40)} on this computer (it was stopped, timed out after ${Math.round(L.sessionIdleMs / 60000)} min idle, or intelio restarted). See list_sessions.`);
    return s;
  }

  function write(s, data) {
    if (s.term) { s.term.write(data); return; }
    if (s.child && s.child.stdin.writable) s.child.stdin.write(data);
  }

  function send(id, { text = '', enter, keys } = {}) {
    const s = get(id);
    s.lastActive = now();
    if (s.exited || s.exitSeen) throw new SessionError(`Session ${s.id} has exited (exit code ${s.exitCode}); read_output for the last output, stop_session to clear it.`);
    const body = text === undefined || text === null ? '' : String(text);
    if (body.length > L.sessionInputChars) throw new SessionError(`text is ${body.length} characters; the limit is ${L.sessionInputChars}.`);
    const names = keys === undefined || keys === null ? [] : Array.isArray(keys) ? keys : [keys];
    if (names.length > 64) throw new SessionError('keys: at most 64 per call.');
    const sequences = names.map(keySequence);
    // enter defaults to true when there is text, false for keys-only calls.
    const pressEnter = enter === undefined || enter === null ? body.length > 0 : Boolean(enter);
    if (!body && !sequences.length && !pressEnter) throw new SessionError('Give text, keys, or enter: true.');
    const lineEnd = s.term ? '\r' : '\n';
    if (body) write(s, s.term ? body.replace(/\r?\n/g, '\r') : body);
    for (let i = 0; i < sequences.length; i += 1) {
      const seq = sequences[i];
      if (!s.term) {
        // Pipes have no terminal: ctrl-c becomes SIGINT, ctrl-d closes stdin.
        if (seq === '\x03' && s.child) { killProcessTree(s.child.pid, platform, 'SIGINT'); continue; }
        if (seq === '\x04' && s.child) { try { s.child.stdin.end(); } catch { /* closed */ } continue; }
        if (seq === '\r') { write(s, '\n'); continue; }
      }
      write(s, seq);
    }
    if (pressEnter) write(s, lineEnd);
    return { ok: true, session_id: s.id, chars: body.length, keys: names.length, enter: pressEnter };
  }

  function waitForChange(s, from, ms, signal) {
    if (s.ring.end > from || s.exited || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        s.waiters.delete(finish);
        signal?.removeEventListener?.('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      s.waiters.add(finish);
      if (signal) { if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true }); }
    });
  }

  const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  async function read(id, { since, wait_ms: waitMs, max_bytes: maxBytes, raw = false } = {}, { signal } = {}) {
    const s = get(id);
    s.lastActive = now();
    let from = since === undefined || since === null || since === '' ? s.readCursor : Math.floor(Number(since));
    if (!Number.isFinite(from) || from < 0) throw new SessionError('since must be a cursor returned by read_output (a number ≥ 0).');
    if (from > s.ring.end) from = s.ring.end;
    const wait = Math.min(L.sessionWaitMaxMs, Math.max(0, Math.floor(Number(waitMs ?? L.sessionWaitDefaultMs)) || 0));
    const max = Math.min(L.sessionReadMaxBytes, Math.max(1, Math.floor(Number(maxBytes ?? L.sessionReadDefaultBytes)) || L.sessionReadDefaultBytes));
    const deadline = Date.now() + wait; // wall clock: now() may be injected for idle tests
    let result;
    let target = from;
    for (;;) {
      if (s.ring.end <= target && !s.exited) {
        await waitForChange(s, target, deadline - Date.now(), signal);
        // Output usually comes in bursts: give the rest of the burst a moment.
        const settle = Math.min(150, deadline - Date.now());
        if (s.ring.end > target && !s.exited && settle > 0 && !signal?.aborted) await pause(settle);
      }
      result = collect(s, from, max, raw);
      // Escape-only output (cursor moves, colors) is not news: keep waiting for text.
      if (raw || result.output.trim() || result.exited || result.more || signal?.aborted || Date.now() >= deadline || s.ring.end <= target) break;
      target = s.ring.end;
    }
    s.readCursor = Math.max(s.readCursor, result.cursor);
    s.lastActive = now();
    return result;
  }

  function collect(s, from, max, raw) {
    const dropped = from < s.ring.start ? s.ring.start - from : 0;
    const begin = Math.max(from, s.ring.start);
    let buf = s.ring.slice(begin, begin + max);
    const capped = begin + buf.length < s.ring.end;
    if (capped) buf = buf.subarray(0, utf8Boundary(buf));
    let text = buf.toString('utf8');
    let used = buf.length;
    if (!raw) {
      const cut = incompleteEscapeAt(text);
      if (cut > 0) { text = text.slice(0, cut); used = Buffer.byteLength(text); }
    }
    const cursor = begin + used;
    const exited = s.exited && cursor >= s.ring.end;
    return {
      session_id: s.id,
      output: raw ? text : stripAnsi(text),
      cursor,
      exited,
      exit_code: exited ? s.exitCode : null,
      ...(exited && s.signal ? { signal: s.signal } : {}),
      truncated: dropped > 0 || cursor < s.ring.end,
      ...(dropped > 0 ? { dropped_bytes: dropped } : {}),
      ...(cursor < s.ring.end ? { more: true } : {}),
      bytes: used,
      pty: s.pty,
    };
  }

  function kill(s, force) {
    if (s.exited || s.exitSeen) return;
    if (platform === 'win32' || force) {
      killProcessTree(s.pid, platform, 'SIGKILL');
      if (s.term && platform !== 'win32') { try { s.term.kill('SIGKILL'); } catch { /* gone */ } }
      return;
    }
    killProcessTree(s.pid, platform, 'SIGHUP');
    if (s.term) { try { s.term.kill('SIGHUP'); } catch { /* gone */ } }
  }

  function waitExit(s, ms) {
    if (s.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { s.exitWaiters.delete(done); resolve(false); }, ms);
      const done = () => { clearTimeout(timer); resolve(true); };
      s.exitWaiters.add(done);
    });
  }

  async function stop(id, { force = false } = {}) {
    const s = get(id);
    const wasRunning = !s.exited && !s.exitSeen;
    if (wasRunning) {
      kill(s, Boolean(force));
      if (!(await waitExit(s, 3000))) {
        kill(s, true);
        await waitExit(s, 3000);
      }
    } else if (!s.exited) await waitExit(s, 1000);
    sessions.delete(s.id);
    stopSweeperIfIdle();
    return {
      session_id: s.id,
      exit_code: s.exitCode,
      ...(s.signal ? { signal: s.signal } : {}),
      stopped: wasRunning,
      ...(s.exited ? {} : { note: 'The process did not confirm its exit; it was force-killed.' }),
    };
  }

  function list() {
    const t = now();
    return [...sessions.values()].map((s) => ({
      id: s.id,
      command: s.command,
      cwd: s.cwd,
      started: new Date(s.started).toISOString(),
      idle_s: Math.round((t - s.lastActive) / 1000),
      exited: s.exited,
      exit_code: s.exited ? s.exitCode : null,
      pty: s.pty,
      pid: s.pid,
      cursor: s.ring.end,
    }));
  }

  /** Kill every session now (kill switch off, revoke, app quit). Returns how many were running. */
  function closeAll() {
    let n = 0;
    for (const s of sessions.values()) {
      if (!s.exited && !s.exitSeen) n += 1;
      kill(s, true);
      wake(s);
    }
    sessions.clear();
    stopSweeperIfIdle();
    return n;
  }

  return { start, send, read, stop, list, closeAll, sweep, get size() { return sessions.size; }, ptyStatus: () => { const p = getPty(); return p.pty ? { pty: true } : { pty: false, error: p.error }; } };
}

module.exports = { createSessionManager, defaultLoadPty, stripAnsi, keySequence, incompleteEscapeAt, utf8Boundary, Ring, KEYS, DEFAULTS, SessionError };
