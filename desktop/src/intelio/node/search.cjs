'use strict';
/**
 * search_files walker for the intelio node, run OFF the Electron main thread.
 *
 * Why a worker: a line regex runs synchronously. A pattern like `.*import.*from`
 * against one 2 MB minified bundle (a single line) backtracks for minutes, and
 * when that ran on the main thread it froze the whole app: the window, the
 * relay pings, every other tool call and the kill switch. In a worker the main
 * thread stays free, and the deadline / kill switch call worker.terminate(),
 * which stops even a regex that is mid-backtrack.
 *
 * This file is evaluated as source inside the worker (see runSearch), so it
 * may only require node: builtins. Matches stream back in batches, so a search
 * that is stopped still returns what it found.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CLOUD_ONLY_MIN_BYTES = 16 * 1024;

function globToRegExp(glob, caseless) {
  let re = '';
  for (const ch of String(glob)) {
    if (ch === '*') re += '[^/\\\\]*';
    else if (ch === '?') re += '[^/\\\\]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, caseless ? 'i' : '');
}

/** Parses an optional leading (?ims) group. Throws a readable Error on a bad pattern. */
function compilePattern(pattern) {
  let source = String(pattern);
  let flags = '';
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    flags = [...new Set(inline[1].split('').filter((f) => 'ims'.includes(f)))].join('');
  }
  try { return new RegExp(source, flags); } catch (error) {
    throw new Error(`pattern is not a valid regular expression: ${error.message}`);
  }
}

/**
 * Walks root and reports matches through emit(batch). Stops at maxResults,
 * at the deadline (checked per file and per 2000 lines) or when stopped() says so.
 * Cloud-only placeholders (OneDrive Files On-Demand, iCloud "dataless" files) are
 * skipped instead of read: reading one downloads the whole file first.
 */
async function walk({ root, pattern, nameGlob, caseless, maxResults, deadline, fileBytes, lineChars, platform }, emit = () => {}, stopped = () => false) {
  const regex = pattern ? compilePattern(pattern) : null;
  const nameRe = nameGlob ? globToRegExp(nameGlob, caseless) : null;
  const segments = root.split(/[\\/]+/).map((s) => (caseless ? s.toLowerCase() : s));
  const insideSkipped = segments.includes('node_modules') || segments.includes('.git');
  const skip = (name) => !insideSkipped && (name === 'node_modules' || name === '.git');
  const checkCloud = platform === 'win32' || platform === 'darwin';
  let found = 0;
  let filesScanned = 0;
  let skippedCloudOnly = 0;
  // Only trust blocks === 0 if this OS reports real block counts: probe our own executable (always local).
  let reportsBlocks = false;
  if (checkCloud) { try { reportsBlocks = (await fsp.stat(process.execPath)).blocks > 0; } catch { reportsBlocks = false; } }
  let timedOut = false;
  let pending = [];
  const flush = () => { if (pending.length) { emit(pending); pending = []; } };
  const add = (m) => { pending.push(m); found += 1; if (pending.length >= 50) flush(); };
  const over = () => {
    if (stopped()) return true;
    if (Date.now() > deadline) { timedOut = true; return true; }
    return false;
  };

  const visitFile = async (full) => {
    const base = path.basename(full);
    if (nameRe && !nameRe.test(base)) return;
    let st = null;
    if (regex || checkCloud) { try { st = await fsp.stat(full); } catch { return; } }
    if (st && checkCloud) {
      if (reportsBlocks && st.blocks === 0 && st.size >= CLOUD_ONLY_MIN_BYTES) { skippedCloudOnly += 1; return; }
    }
    filesScanned += 1;
    if (!regex) { add({ path: full, line: null, text: null }); return; }
    if (st.size > fileBytes) return;
    let buf;
    try { buf = await fsp.readFile(full); } catch { return; }
    if (buf.subarray(0, 4096).includes(0)) return;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (i % 2000 === 1999 && over()) return;
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        add({ path: full, line: i + 1, text: lines[i].slice(0, lineChars) });
        if (found >= maxResults) return;
      }
    }
  };

  let rootStat;
  try { rootStat = await fsp.stat(root); } catch (error) { const e = new Error(error.code || 'stat failed'); e.code = error.code; throw e; }
  if (!rootStat.isDirectory()) { await visitFile(root); flush(); }
  const stack = rootStat.isDirectory() ? [root] : [];
  while (stack.length && found < maxResults && !over()) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip(entry.name)) subdirs.push(full); continue; }
      if (!entry.isFile()) continue;
      if (over()) break;
      await visitFile(full);
      flush(); // stream per file, so a later file that hangs cannot swallow earlier matches
      if (found >= maxResults) break;
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]);
  }
  flush();
  return { files_scanned: filesScanned, skipped_cloud_only: skippedCloudOnly, timed_out: timedOut, found };
}

/** Worker entry: workerData holds the walk options; posts {type:'matches'} batches then {type:'done'}. */
function runWorker() {
  const { parentPort, workerData } = require('node:worker_threads');
  walk(workerData, (batch) => parentPort.postMessage({ type: 'matches', batch }))
    .then((summary) => parentPort.postMessage({ type: 'done', summary }))
    .catch((error) => parentPort.postMessage({ type: 'error', message: String(error && error.message || error), code: error && error.code }));
}

let workerSource = null;
function sourceForWorker() {
  if (workerSource === null) {
    // fs here is Electron's asar-aware fs on the main thread; the worker gets plain source text.
    const text = fs.readFileSync(__filename, 'utf8');
    workerSource = `const module = { exports: {} };\n(function (exports, require, module, __filename, __dirname) {\n${text}\n})(module.exports, require, module, ${JSON.stringify(__filename)}, ${JSON.stringify(__dirname)});\nmodule.exports.runWorker();\n`;
  }
  return workerSource;
}

/**
 * Runs the walk in a worker thread with a hard stop: at the deadline (+1 s grace)
 * or when signal aborts, the worker is terminated and the matches so far are returned.
 * Falls back to the walk on this thread (still deadline-checked) if a worker cannot start.
 */
function runSearch(options, { signal, Worker = null, graceMs = 1000 } = {}) {
  let WorkerImpl = Worker;
  if (!WorkerImpl) { try { WorkerImpl = require('node:worker_threads').Worker; } catch { WorkerImpl = null; } }
  const matches = [];
  if (!WorkerImpl) {
    return walk(options, (batch) => matches.push(...batch), () => Boolean(signal && signal.aborted))
      .then((summary) => ({ matches: matches.slice(0, options.maxResults), ...summary, aborted: Boolean(signal && signal.aborted), in_thread: true }));
  }
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new WorkerImpl(sourceForWorker(), { eval: true, workerData: options, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    } catch {
      walk(options, (batch) => matches.push(...batch), () => Boolean(signal && signal.aborted))
        .then((summary) => resolve({ matches: matches.slice(0, options.maxResults), ...summary, aborted: Boolean(signal && signal.aborted), in_thread: true }), reject);
      return;
    }
    let settled = false;
    let summary = null;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate().catch(() => {});
      resolve({ matches: matches.slice(0, options.maxResults), files_scanned: 0, skipped_cloud_only: 0, timed_out: false, ...(summary || {}), ...extra });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate().catch(() => {});
      reject(error);
    };
    const onAbort = () => finish({ aborted: true });
    const timer = setTimeout(() => finish({ timed_out: true, stopped_by: 'deadline' }), Math.max(0, options.deadline - Date.now()) + graceMs);
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'matches' && Array.isArray(msg.batch)) matches.push(...msg.batch);
      else if (msg.type === 'done') { summary = msg.summary; finish({}); }
      else if (msg.type === 'error') { const e = new Error(msg.message); e.code = msg.code; fail(e); }
    });
    worker.on('error', (error) => fail(error));
    worker.on('exit', () => { if (!settled) finish({ timed_out: Boolean(summary && summary.timed_out) }); });
  });
}

module.exports = { walk, runSearch, runWorker, globToRegExp, compilePattern, CLOUD_ONLY_MIN_BYTES };
