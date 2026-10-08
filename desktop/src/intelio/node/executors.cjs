'use strict';
/**
 * intelio node executors: what an enrolled computer does for each tool call.
 * Runs as the signed-in OS user with that user's rights; never elevates.
 * Pure Node (no Electron) so tests drive it on any OS. Electron-only pieces
 * (screenshot, the elevation confirm dialog) are injected.
 *
 * Every handler returns MCP content ([{ type: 'text', text }] or image items)
 * plus a small `meta` for the audit line. Errors throw with a readable message.
 *
 * Stage 2 extension point (docs/intelio-node.md): persistent terminal sessions
 * (start_session, send_input, read_output, stop_session) are added as more
 * handlers on the object createExecutors returns, backed by a session map.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { LIMITS } = require('./protocol.cjs');
const { detectElevation, shellElevates } = require('./elevation.cjs');

class ToolError extends Error {}

function json(value) {
  return { type: 'text', text: JSON.stringify(value, null, 2) };
}

function osLabel(platform = process.platform) {
  if (platform === 'win32') return (os.version?.() || 'Windows').slice(0, 32);
  if (platform === 'darwin') return `macOS ${typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release()}`.slice(0, 32);
  return `${platform === 'linux' ? 'Linux' : platform} ${os.release()}`.slice(0, 32);
}

function intArg(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolError(`Expected a number, got ${String(value).slice(0, 40)}.`);
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function globToRegExp(glob, caseless) {
  let re = '';
  for (const ch of String(glob)) {
    if (ch === '*') re += '[^/\\\\]*';
    else if (ch === '?') re += '[^/\\\\]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseless ? 'i' : '');
}

function compilePattern(pattern) {
  let source = String(pattern);
  let flags = '';
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    flags = [...new Set(inline[1].split('').filter((f) => 'ims'.includes(f)))].join('');
  }
  try { return new RegExp(source, flags); } catch (error) {
    throw new ToolError(`pattern is not a valid regular expression: ${error.message}`);
  }
}

/** Kill a process and everything it started. */
function killTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch { /* gone */ }
    try { child.kill(); } catch { /* gone */ }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const hard = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  }, 2000);
  hard.unref?.();
}

function createExecutors({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  limits = LIMITS,
  confirmElevation = async () => false,
  screenshot = null,
  computerName = () => os.hostname(),
} = {}) {
  const caseless = platform === 'win32' || platform === 'darwin';

  function resolvePath(raw, field = 'path') {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) throw new ToolError(`${field} is required.`);
    let full;
    if (text === '~') full = home;
    else if (text.startsWith('~/') || text.startsWith('~\\')) full = path.join(home, text.slice(2));
    else if (path.isAbsolute(text)) full = text;
    else throw new ToolError(`${field} must be absolute or start with ~ (got ${text.slice(0, 200)}).`);
    return path.resolve(full);
  }

  function fsError(error, target) {
    const code = error && error.code;
    const where = target ? ` ${target}` : '';
    if (code === 'ENOENT') return new ToolError(`Not found:${where}`);
    if (code === 'EACCES' || code === 'EPERM') return new ToolError(`Permission denied (this computer's user cannot access it):${where}`);
    if (code === 'EISDIR') return new ToolError(`Is a folder, not a file:${where}`);
    if (code === 'ENOTDIR') return new ToolError(`Not a folder:${where}`);
    if (code === 'EEXIST') return new ToolError(`Already exists (mode create):${where}`);
    return new ToolError(`${String(error && error.message || error).slice(0, 300)}`);
  }

  function shellFor(requested) {
    const want = String(requested || '').trim().toLowerCase();
    if (want && shellElevates(want)) throw new ToolError('Refused: that shell asks for administrator rights.');
    if (platform === 'win32') {
      if (!want || want === 'powershell' || want === 'powershell.exe') return { kind: 'powershell', file: 'powershell.exe' };
      if (want === 'pwsh' || want === 'pwsh.exe') return { kind: 'powershell', file: 'pwsh.exe' };
      if (want === 'cmd' || want === 'cmd.exe') return { kind: 'cmd', file: env.ComSpec || 'cmd.exe' };
      if (want === 'bash' || want === 'sh' || want === 'zsh') return { kind: 'posix', file: `${want}.exe`, login: true };
      throw new ToolError('shell must be powershell, pwsh, cmd, bash, zsh or sh.');
    }
    if (want === 'powershell' || want === 'pwsh') return { kind: 'powershell', file: 'pwsh' };
    if (want && !['bash', 'zsh', 'sh'].includes(want)) throw new ToolError('shell must be bash, zsh, sh or pwsh.');
    const candidates = want ? [`/bin/${want}`, `/usr/bin/${want}`] : [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
    const file = candidates.find((c) => c && path.isAbsolute(c) && fs.existsSync(c));
    if (!file) throw new ToolError(`No ${want || 'login'} shell found on this computer.`);
    return { kind: 'posix', file, login: true };
  }

  function spawnArgs(shell, command) {
    if (shell.kind === 'powershell') {
      const script = `$ProgressPreference='SilentlyContinue'; try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}`;
      return { file: shell.file, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
    }
    if (shell.kind === 'cmd') return { file: shell.file, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
    return { file: shell.file, args: [shell.login ? '-lc' : '-c', command] };
  }

  function capture(max) {
    const chunks = [];
    let kept = 0;
    let total = 0;
    return {
      push(chunk) {
        total += chunk.length;
        if (kept >= max) return;
        const take = chunk.subarray(0, max - kept);
        chunks.push(take);
        kept += take.length;
      },
      text() { return Buffer.concat(chunks).toString('utf8'); },
      get truncated() { return total > kept; },
      get total() { return total; },
    };
  }

  async function volumes() {
    const out = [];
    const statfs = async (p) => {
      if (typeof fsp.statfs !== 'function') return {};
      try { const s = await fsp.statfs(p); return { total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize }; } catch { return {}; }
    };
    if (platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = `${letter}:\\`;
        try { await fsp.access(root); out.push({ path: root, ...(await statfs(root)) }); } catch { /* absent */ }
      }
    } else if (platform === 'darwin') {
      out.push({ path: '/', ...(await statfs('/')) });
      try { for (const name of await fsp.readdir('/Volumes')) out.push({ path: `/Volumes/${name}` }); } catch { /* none */ }
    } else {
      try {
        const mounts = (await fsp.readFile('/proc/mounts', 'utf8')).split('\n').map((l) => l.split(' ')).filter((p) => p[0] && p[0].startsWith('/dev/'));
        for (const [, mount] of mounts) if (!mount.startsWith('/snap') && !mount.startsWith('/boot')) out.push({ path: mount.replace(/\\040/g, ' '), ...(await statfs(mount)) });
      } catch { out.push({ path: '/', ...(await statfs('/')) }); }
    }
    return out;
  }

  const handlers = {
    async computer_info() {
      let user = '';
      try { user = os.userInfo().username; } catch { user = env.USER || env.USERNAME || ''; }
      let shell = '';
      try { const s = shellFor(''); shell = s.file; } catch { shell = ''; }
      const info = {
        name: computerName(),
        os: osLabel(platform),
        platform,
        release: os.release(),
        arch: process.arch,
        hostname: os.hostname(),
        user,
        home,
        shell,
        drives: await volumes(),
        cpus: os.cpus().length,
        memory_bytes: os.totalmem(),
        uptime_s: Math.round(os.uptime()),
      };
      return { content: [json(info)] };
    },

    async list_dir(args) {
      const dir = resolvePath(args.path);
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (error) { throw fsError(error, dir); }
      const visible = entries.filter((e) => args.show_hidden || !e.name.startsWith('.'));
      visible.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name));
      const max = limits.listDirEntries;
      const rows = [];
      for (const entry of visible.slice(0, max)) {
        const full = path.join(dir, entry.name);
        const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
        let size = null;
        let mtime = null;
        try { const st = await fsp.lstat(full); size = st.isDirectory() ? null : st.size; mtime = st.mtime.toISOString(); } catch { /* vanished or locked */ }
        rows.push({ name: entry.name, type, size, mtime });
      }
      return { content: [json({ path: dir, entries: rows, total: visible.length, truncated: visible.length > max })], meta: { count: rows.length } };
    },

    async read_file(args) {
      const file = resolvePath(args.path);
      const encoding = args.encoding === 'base64' ? 'base64' : 'text';
      const cap = encoding === 'base64' ? limits.readBase64Bytes : limits.readTextBytes;
      const offset = intArg(args.offset, { min: 0, fallback: 0 });
      const limit = intArg(args.limit, { min: 1, max: cap, fallback: cap });
      let handle;
      try { handle = await fsp.open(file, 'r'); } catch (error) { throw fsError(error, file); }
      try {
        const st = await handle.stat();
        if (st.isDirectory()) throw new ToolError(`Is a folder, not a file: ${file}`);
        const want = Math.max(0, Math.min(limit, st.size - offset));
        const buf = Buffer.alloc(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await handle.read(buf, got, want - got, offset + got);
          if (!bytesRead) break;
          got += bytesRead;
        }
        const body = buf.subarray(0, got);
        const truncated = offset + got < st.size;
        const meta = { path: file, total_size: st.size, offset, bytes: got, truncated, encoding };
        if (encoding === 'text' && body.subarray(0, 8192).includes(0)) meta.note = 'Looks binary; use encoding base64.';
        const content = encoding === 'base64' ? body.toString('base64') : body.toString('utf8');
        return { content: [json(meta), { type: 'text', text: content }], meta: { bytes: got } };
      } catch (error) {
        throw error instanceof ToolError ? error : fsError(error, file);
      } finally {
        await handle.close().catch(() => {});
      }
    },

    async write_file(args) {
      const file = resolvePath(args.path);
      if (typeof args.content !== 'string') throw new ToolError('content must be a string.');
      const encoding = args.encoding === 'base64' ? 'base64' : 'text';
      const data = encoding === 'base64' ? Buffer.from(args.content, 'base64') : Buffer.from(args.content, 'utf8');
      if (data.length > limits.writeBytes) throw new ToolError(`content is ${data.length} bytes; the limit is ${limits.writeBytes}.`);
      const mode = args.mode || 'overwrite';
      const flag = { create: 'wx', overwrite: 'w', append: 'a' }[mode];
      if (!flag) throw new ToolError('mode must be create, overwrite or append.');
      try {
        if (args.make_dirs) await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, data, { flag });
      } catch (error) { throw fsError(error, file); }
      return { content: [json({ path: file, bytes_written: data.length, mode })], meta: { bytes: data.length } };
    },

    async search_files(args) {
      const root = resolvePath(args.root, 'root');
      if (!args.pattern && !args.name_glob) throw new ToolError('Give pattern (regular expression for file lines), name_glob, or both.');
      const regex = args.pattern ? compilePattern(args.pattern) : null;
      const nameRe = args.name_glob ? globToRegExp(args.name_glob, caseless) : null;
      const maxResults = intArg(args.max_results, { min: 1, max: limits.searchMax, fallback: limits.searchDefault });
      const segments = root.split(/[\\/]+/).map((s) => (caseless ? s.toLowerCase() : s));
      const insideSkipped = segments.includes('node_modules') || segments.includes('.git');
      const skip = (name) => !insideSkipped && (name === 'node_modules' || name === '.git');
      const deadline = Date.now() + 60000;
      const matches = [];
      let filesScanned = 0;
      let truncated = false;
      let rootStat;
      try { rootStat = await fsp.stat(root); } catch (error) { throw fsError(error, root); }
      const stack = rootStat.isDirectory() ? [root] : [];
      const files = rootStat.isDirectory() ? [] : [root];
      const visitFile = async (full) => {
        const base = path.basename(full);
        if (nameRe && !nameRe.test(base)) return;
        filesScanned += 1;
        if (!regex) { matches.push({ path: full, line: null, text: null }); return; }
        let st;
        try { st = await fsp.stat(full); } catch { return; }
        if (st.size > limits.searchFileBytes) return;
        let buf;
        try { buf = await fsp.readFile(full); } catch { return; }
        if (buf.subarray(0, 4096).includes(0)) return;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push({ path: full, line: i + 1, text: lines[i].slice(0, limits.searchLineChars) });
            if (matches.length >= maxResults) return;
          }
        }
      };
      for (const f of files) await visitFile(f);
      while (stack.length && matches.length < maxResults) {
        if (Date.now() > deadline) { truncated = true; break; }
        const dir = stack.pop();
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const subdirs = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { if (!skip(entry.name)) subdirs.push(full); continue; }
          if (!entry.isFile()) continue;
          await visitFile(full);
          if (matches.length >= maxResults) break;
        }
        stack.push(...subdirs.reverse());
      }
      if (matches.length >= maxResults) truncated = true;
      return { content: [json({ root, matches, truncated, files_scanned: filesScanned })], meta: { count: matches.length } };
    },

    async run_command(args, ctx = {}) {
      const command = String(args.command || '');
      if (!command.trim()) throw new ToolError('command is required.');
      const shell = shellFor(args.shell);
      const elevation = detectElevation(command);
      if (elevation.elevates) {
        let approved = false;
        try { approved = await confirmElevation({ command, reason: elevation.reason }); } catch { approved = false; }
        if (!approved) {
          throw new ToolError(`Refused: ${elevation.reason}. intelio never elevates on its own; the person at ${computerName()} did not approve it. Ask them to run it themselves, or to approve it when the prompt appears on that computer.`);
        }
      }
      const cwd = args.cwd ? resolvePath(args.cwd, 'cwd') : home;
      const timeoutS = intArg(args.timeout_s, { min: 1, max: limits.runMaxS, fallback: limits.runDefaultS });
      const { file, args: argv, verbatim } = spawnArgs(shell, command);
      const started = Date.now();
      const out = capture(limits.runOutputBytes);
      const err = capture(limits.runOutputBytes);
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(file, argv, {
            cwd, env, windowsHide: true, windowsVerbatimArguments: Boolean(verbatim),
            detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (error) { reject(new ToolError(`Could not start ${file}: ${error.message}`)); return; }
        let timedOut = false;
        let aborted = false;
        const unstick = () => setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 5000).unref?.();
        const timer = setTimeout(() => { timedOut = true; killTree(child, platform); unstick(); }, timeoutS * 1000);
        const onAbort = () => { aborted = true; killTree(child, platform); unstick(); };
        if (ctx.signal) {
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        child.stdout.on('data', (c) => out.push(c));
        child.stderr.on('data', (c) => err.push(c));
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error.code === 'ENOENT' ? new ToolError(`${file} was not found on this computer.`) : fsError(error, cwd));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener?.('abort', onAbort);
          const result = {
            exit_code: code,
            ...(signal ? { signal } : {}),
            ...(timedOut ? { timed_out: true, note: `Stopped after ${timeoutS} s (timeout_s).` } : {}),
            ...(aborted ? { aborted: true, note: 'Stopped: intelio access was turned off on this computer.' } : {}),
            duration_ms: Date.now() - started,
            stdout: out.text(),
            stdout_truncated: out.truncated,
            stderr: err.text(),
            stderr_truncated: err.truncated,
            ...(out.truncated || err.truncated ? { limit_bytes: limits.runOutputBytes } : {}),
          };
          resolve({ content: [json(result)], meta: { exit_code: code, bytes: out.total + err.total, ...(timedOut ? { timed_out: true } : {}) } });
        });
      });
    },

    async screenshot(args) {
      if (typeof screenshot !== 'function') throw new ToolError('Screenshots are not available on this computer.');
      const display = intArg(args.display, { min: 1, max: 64, fallback: 1 });
      const shot = await screenshot(display);
      const png = Buffer.isBuffer(shot.png) ? shot.png : Buffer.from(shot.png || []);
      if (!png.length) throw new ToolError('The screenshot came back empty. On macOS, allow intelio under System Settings → Privacy & Security → Screen Recording.');
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: `Display ${display} of ${shot.count || 1}: ${shot.width}x${shot.height} px${shot.scale && shot.scale !== 1 ? ` (scale ${shot.scale})` : ''}.` },
        ],
        meta: { bytes: png.length },
      };
    },
  };

  /** Runs one tool. Returns { ok: true, content, meta } or { ok: false, error, meta }. */
  async function run(tool, args = {}, ctx = {}) {
    const handler = Object.prototype.hasOwnProperty.call(handlers, tool) ? handlers[tool] : null;
    if (!handler) return { ok: false, error: `This computer does not support ${String(tool).slice(0, 60)}. Update intelio on it.`, meta: {} };
    try {
      const result = await handler(args && typeof args === 'object' ? args : {}, ctx);
      return { ok: true, content: result.content, meta: result.meta || {} };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error).slice(0, 2000), meta: {} };
    }
  }

  return { run, handlers, resolvePath, tools: Object.keys(handlers) };
}

module.exports = { createExecutors, killTree, globToRegExp, compilePattern, osLabel, ToolError };
