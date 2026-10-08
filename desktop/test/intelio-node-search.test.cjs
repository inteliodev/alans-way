'use strict';
// search_files must never freeze the app. Regression for the search freeze: a
// pathological (or merely O(n^2)) pattern on one long line used to block the
// Electron main thread for minutes, ignoring the 60 s deadline and the kill switch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExecutors } = require('../src/intelio/node/executors.cjs');
const { walk, runSearch, CLOUD_ONLY_MIN_BYTES } = require('../src/intelio/node/search.cjs');
const protocol = require('../src/intelio/node/protocol.cjs');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-search-')); }
function parse(result) { assert.equal(result.ok, true, result.error); return JSON.parse(result.content[0].text); }

/** Largest gap between 20 ms ticks while fn runs: how long the event loop was blocked. */
async function maxStall(fn) {
  let last = Date.now();
  let worst = 0;
  const tick = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 20); last = n; }, 20);
  try { const value = await fn(); return { value, stall: worst }; } finally { clearInterval(tick); }
}

function minifiedTree() {
  const home = tmpdir();
  fs.mkdirSync(path.join(home, 'proj', 'dist'), { recursive: true });
  // One 1.5 MB line: `.*import.*from` backtracks quadratically on it (minutes).
  fs.writeFileSync(path.join(home, 'proj', 'dist', 'bundle.min.js'), 'x'.repeat(1500000));
  fs.writeFileSync(path.join(home, 'proj', 'a.txt'), 'import x from y\n');
  return home;
}

test('a catastrophic pattern does not block the event loop and stops at the time budget', { timeout: 30000 }, async () => {
  const home = minifiedTree();
  const ex = createExecutors({ home });
  const started = Date.now();
  const { value, stall } = await maxStall(() => ex.run('search_files', { root: '~/proj', pattern: '.*import.*from', timeout_s: 2 }));
  const out = parse(value);
  const took = Date.now() - started;
  assert.ok(took < 6000, `search should stop near its 2 s budget, took ${took} ms`);
  assert.ok(stall < 500, `event loop blocked for ${stall} ms`);
  assert.equal(out.truncated, true);
  assert.match(out.note, /Stopped after 2 s/);
  // a.txt sorts before dist/: its match was found before the stuck file and survives the stop.
  assert.deepEqual(out.matches.map((m) => path.basename(m.path)), ['a.txt']);
});

test('the kill switch (abort) stops a stuck search within a second', { timeout: 30000 }, async () => {
  const home = minifiedTree();
  const ex = createExecutors({ home });
  const controller = new AbortController();
  setTimeout(() => controller.abort('turned off'), 300);
  const started = Date.now();
  const out = parse(await ex.run('search_files', { root: '~/proj', pattern: '.*import.*from' }, { signal: controller.signal }));
  assert.ok(Date.now() - started < 2000, `abort took ${Date.now() - started} ms`);
  assert.match(out.note, /turned off/);
});

test('relay timeout follows the search budget', () => {
  assert.equal(protocol.callTimeoutMs('search_files', {}), (protocol.LIMITS.searchDefaultS + 10) * 1000);
  assert.equal(protocol.callTimeoutMs('search_files', { timeout_s: 5 }), 15000);
  assert.equal(protocol.callTimeoutMs('search_files', { timeout_s: 99999 }), (protocol.LIMITS.searchMaxS + 10) * 1000);
  const schema = protocol.TOOLS.find((t) => t.name === 'search_files').inputSchema;
  assert.equal(schema.properties.timeout_s.maximum, protocol.LIMITS.searchMaxS);
});

test('online-only placeholders (blocks 0) are skipped on Windows/macOS once the OS reports real blocks', async () => {
  const home = tmpdir();
  const real = path.join(home, 'real.txt');
  const cloud = path.join(home, 'cloud.txt');
  const small = path.join(home, 'small.txt');
  fs.writeFileSync(real, 'NEEDLE real\n');
  fs.writeFileSync(cloud, `NEEDLE cloud\n${'y'.repeat(CLOUD_ONLY_MIN_BYTES)}`);
  fs.writeFileSync(small, 'NEEDLE small\n');
  const fsp = require('node:fs/promises');
  const original = fsp.stat;
  // Simulate OneDrive Files On-Demand: the placeholder reports its size but no allocated blocks.
  fsp.stat = async (p, ...rest) => {
    const st = await original(p, ...rest);
    if (p === cloud) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 });
    if (p === small) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 });
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: Math.max(1, st.blocks || 8) });
  };
  try {
    const opts = { root: home, pattern: 'NEEDLE', caseless: false, maxResults: 50, deadline: Date.now() + 10000, fileBytes: 1 << 22, lineChars: 300 };
    const found = [];
    const summary = await walk({ ...opts, platform: 'win32' }, (b) => found.push(...b));
    assert.deepEqual(found.map((m) => path.basename(m.path)).sort(), ['real.txt', 'small.txt'], 'small resident files are never treated as placeholders');
    assert.equal(summary.skipped_cloud_only, 1);
    const linux = [];
    await walk({ ...opts, platform: 'linux' }, (b) => linux.push(...b));
    assert.equal(linux.length, 3, 'Linux has no placeholders: everything is read');
  } finally {
    fsp.stat = original;
  }
});

test('an OS that never reports blocks does not skip anything', async () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, 'big.txt'), `NEEDLE\n${'z'.repeat(CLOUD_ONLY_MIN_BYTES * 2)}`);
  const fsp = require('node:fs/promises');
  const original = fsp.stat;
  fsp.stat = async (p, ...rest) => { const st = await original(p, ...rest); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 }); };
  try {
    const found = [];
    await walk({ root: home, pattern: 'NEEDLE', caseless: true, maxResults: 5, deadline: Date.now() + 5000, fileBytes: 1 << 22, lineChars: 300, platform: 'darwin' }, (b) => found.push(...b));
    assert.equal(found.length, 1);
  } finally { fsp.stat = original; }
});

test('runSearch falls back to this thread when no worker can start, and still honors the deadline', { timeout: 20000 }, async () => {
  const home = tmpdir();
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(home, `f${i}.txt`), 'hit\n');
  class NoWorker { constructor() { throw new Error('workers unavailable'); } }
  const out = await runSearch({ root: home, pattern: 'hit', caseless: false, maxResults: 10, deadline: Date.now() + 5000, fileBytes: 1 << 20, lineChars: 100, platform: process.platform }, { Worker: NoWorker });
  assert.equal(out.in_thread, true);
  assert.equal(out.matches.length, 10);
});

test('computer nodes open no listening ports: nothing under src/intelio/node listens', () => {
  const dir = path.join(__dirname, '..', 'src', 'intelio', 'node');
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.cjs')) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.ok(!/\.listen\s*\(/.test(text), `${name} must not listen`);
    assert.ok(!/\bcreate(?:Secure)?Server\s*\(/.test(text), `${name} must not create a server`);
  }
});
