const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

// /api/home and /api/screens answer the desktop app over Cloudflare Access, which gives
// up after a few seconds. A slow `hermes profile list`, one stuck profile, a hung
// browser, or a 500 from /v1/skills must not hold either endpoint up.

const KEYS = { intelio: 'intelio-key-not-real-0101', prc: 'prc-key-not-real-0102', hhp: 'hhp-key-not-real-0103' };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - started, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function allowLocal(ip) {
  return String(ip).endsWith('127.0.0.1') ? { ok: true, login: 'owner@example' } : { ok: false, reason: 'not a tailnet peer' };
}

function profileHome(ids) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-fast-home-'));
  for (const id of ids) fs.mkdirSync(path.join(home, '.hermes', 'profiles', id, 'bot-desktop'), { recursive: true });
  return home;
}

function mockHermes(hits) {
  return http.createServer((req, res) => {
    hits.push(req.url);
    const profile = /^\/p\/([a-z0-9-]+)\//.exec(req.url)?.[1] || '';
    if (req.headers.authorization !== `Bearer ${KEYS[profile]}`) { res.statusCode = 401; res.end('{}'); return; }
    if (profile === 'prc') return; // this profile never answers
    if (req.url.startsWith(`/p/${profile}/api/sessions?`)) {
      res.end(JSON.stringify({ data: [{ id: `${profile}-thread`, source: 'api_server', title: `${profile} thread` }] }));
      return;
    }
    if (req.url === `/p/${profile}/v1/skills`) { res.statusCode = 500; res.end('{"error":"TypeError"}'); return; }
    if (req.url === `/p/${profile}/api/jobs`) { res.end('[]'); return; }
    if (req.url === `/p/${profile}/v1/capabilities`) { res.end('{"features":{}}'); return; }
    res.statusCode = 404;
    res.end('{}');
  });
}

test('/api/home stays fast with a slow profile list, a stuck profile, and a failing /v1/skills', async () => {
  const hits = [];
  const upstream = mockHermes(hits);
  const upstreamPort = await listen(upstream);
  const home = profileHome(['intelio', 'prc', 'hhp']);
  let listRuns = 0;
  const slowList = () => new Promise((resolve) => {
    listRuns += 1;
    setTimeout(() => resolve({ code: 0, stdout: 'intelio\nprc\nhhp\n' }), 2500);
  });
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`, fetchImpl: globalThis.fetch,
    profileKey: KEYS.intelio, identify: allowLocal, profileHome: home, profileRun: slowList,
    profileOps: { keyFor: (id) => KEYS[id] },
    probeTimeoutMs: 400,
  });
  const address = await app.listen();
  try {
    const cold = await request(address.port, '/api/home');
    assert.equal(cold.status, 200, cold.body);
    assert.ok(cold.ms < 1500, `cold /api/home took ${cold.ms}ms`);
    const body = JSON.parse(cold.body);
    assert.deepEqual(body.profiles.map((row) => row.id).sort(), ['hhp', 'intelio', 'prc']);
    assert.deepEqual(body.conversations.map((row) => row.id).sort(), ['hhp-thread', 'intelio-thread']);
    assert.equal(body.skillsOk, false);
    assert.deepEqual(body.skills, []);
    assert.equal(body.jobsOk, true);
    for (const key of Object.values(KEYS)) assert.equal(cold.body.includes(key), false);

    const warm = await request(address.port, '/api/home');
    assert.equal(warm.status, 200);
    assert.ok(warm.ms < 1000, `warm /api/home took ${warm.ms}ms`);
    assert.equal(listRuns, 1, 'the profile list is cached, not re-run per request');
  } finally {
    await closeServer(app.server);
    await closeServer(upstream);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/api/screens probes browsers in parallel, caps a hung one, and serves a cached snapshot', async () => {
  const hits = [];
  const upstream = mockHermes(hits);
  const upstreamPort = await listen(upstream);
  let cdpCalls = 0;
  const cdp = http.createServer((req, res) => {
    cdpCalls += 1;
    res.end(JSON.stringify([{ type: 'page', url: 'https://www.example.com/x' }, { type: 'page', url: 'https://docs.example.org/' }]));
  });
  const hung = http.createServer(() => { /* never answers */ });
  const cdpPort = await listen(cdp);
  const hungPort = await listen(hung);
  const home = profileHome(['intelio', 'prc', 'hhp']);
  const root = path.join(home, '.hermes', 'profiles');
  fs.writeFileSync(path.join(root, 'intelio', 'bot-desktop', 'cdp.url'), `http://127.0.0.1:${cdpPort}`);
  fs.writeFileSync(path.join(root, 'prc', 'bot-desktop', 'cdp.url'), `http://127.0.0.1:${hungPort}`);
  fs.writeFileSync(path.join(root, 'hhp', 'bot-desktop', 'cdp.url'), `http://127.0.0.1:${hungPort}`);
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstreamPort}`, fetchImpl: globalThis.fetch,
    profileKey: KEYS.intelio, identify: allowLocal, profileHome: home,
    profileRun: async () => ({ code: 0, stdout: 'intelio\nprc\nhhp\n' }),
    profileOps: { keyFor: (id) => KEYS[id] },
    probeTimeoutMs: 400,
  });
  const address = await app.listen();
  try {
    const cold = await request(address.port, '/api/screens');
    assert.equal(cold.status, 200, cold.body);
    assert.ok(cold.ms < 1500, `cold /api/screens took ${cold.ms}ms (two hung browsers probed in parallel)`);
    assert.deepEqual(JSON.parse(cold.body).data, [
      { profileId: 'intelio', name: 'intelio', host: 'example.com', screen: 1 },
      { profileId: 'intelio', name: 'intelio', host: 'docs.example.org', screen: 2 },
    ]);
    const calls = cdpCalls;
    const warm = await request(address.port, '/api/screens');
    assert.equal(warm.status, 200);
    assert.ok(warm.ms < 300, `warm /api/screens took ${warm.ms}ms`);
    assert.equal(JSON.parse(warm.body).data.length, 2);
    assert.equal(cdpCalls, calls, 'a fresh snapshot is served from cache');
  } finally {
    await closeServer(app.server);
    await closeServer(upstream);
    await closeServer(cdp);
    await closeServer(hung);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('listProfiles can skip the hermes CLI and list profile folders only', async () => {
  const { listProfiles } = require('../../mobile/pwa/profiles.cjs');
  const home = profileHome(['intelio', 'prc']);
  let runs = 0;
  try {
    const rows = await listProfiles({ home, cli: false, run: async () => { runs += 1; return { code: 0, stdout: 'extra\n' }; } });
    assert.deepEqual(rows.map((row) => row.id), ['intelio', 'prc']);
    assert.equal(runs, 0);
    const full = await listProfiles({ home, run: async () => { runs += 1; return { code: 0, stdout: 'extra\n' }; } });
    assert.deepEqual(full.map((row) => row.id), ['extra', 'intelio', 'prc']);
    assert.equal(runs, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
