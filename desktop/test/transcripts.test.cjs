const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createTranscripts, parseTranscript } = require('../../mobile/pwa/transcripts.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');
const pages = require('../src/intelio/pages.cjs');

function recording({ id, title, date, clients = [], summary, transcript = 'Speaker 1: SECRET-TRANSCRIPT-LINE' }) {
  return [
    '---', 'source: plaud', `plaud_id: ${id}`, `title: "${title}"`, `date: ${date}`, 'duration: 12m3s',
    `clients: [${clients.join(', ')}]`, 'ingested: 2026-10-08T00:00:00+00:00', '---', '',
    `# ${title}`, '', '## Summary', '', summary, '', '## Transcript', '', transcript, '',
  ].join('\n');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-transcripts-'));
  const intelio = path.join(root, 'intelio', 'transcripts');
  const prc = path.join(root, 'prc', 'transcripts');
  fs.mkdirSync(intelio, { recursive: true });
  fs.mkdirSync(prc, { recursive: true });
  fs.mkdirSync(path.join(root, 'hhp'), { recursive: true });
  const a = recording({
    id: 'of_aaa', title: '10-01 Meeting: Drive migration for PRC', date: '2026-10-01', clients: ['prc'],
    summary: 'We moved the **Big Swing** folders.\n\n### Action Items\n- [ ] Transfer ownership to Meredith\n- Send the Takeout plan\n\n### Notes\n- not an action',
  });
  const b = recording({ id: 'of_bbb', title: '09-12 Solar landowner call', date: '2026-09-12', summary: 'Terrajen solar lease terms.\n## Next steps\n* Draft the lease' });
  fs.writeFileSync(path.join(intelio, '2026-10-01-drive-migration-aaa.md'), a);
  fs.writeFileSync(path.join(intelio, '2026-09-12-solar-bbb.md'), b);
  fs.writeFileSync(path.join(intelio, 'index.jsonl'), '{}\n');
  fs.writeFileSync(path.join(prc, '2026-10-01-drive-migration-aaa.md'), a);
  return root;
}

test('transcripts: summary, action items and newest first, never the transcript body', () => {
  const root = fixture();
  const reader = createTranscripts({ root });
  const all = reader.list({});
  assert.equal(all.profile, 'intelio');
  assert.equal(all.total, 2);
  assert.deepEqual(all.items.map((item) => item.id), ['of_aaa', 'of_bbb']);
  const [first, second] = all.items;
  assert.equal(first.title, '10-01 Meeting: Drive migration for PRC');
  assert.deepEqual(first.clients, ['prc']);
  assert.deepEqual(first.actions, ['Transfer ownership to Meredith', 'Send the Takeout plan']);
  assert.match(first.excerpt, /Big Swing/);
  assert.deepEqual(second.actions, ['Draft the lease']);
  assert.equal(JSON.stringify(all).includes('SECRET-TRANSCRIPT-LINE'), false);
  assert.deepEqual(all.profiles, [{ id: 'intelio', count: 2 }, { id: 'prc', count: 1 }]);
});

test('transcripts: profile folder, client tag, search terms and limits', () => {
  const root = fixture();
  const reader = createTranscripts({ root });
  assert.deepEqual(reader.list({ profile: 'prc' }).items.map((item) => item.id), ['of_aaa']);
  assert.deepEqual(reader.list({ client: 'prc' }).items.map((item) => item.id), ['of_aaa']);
  assert.deepEqual(reader.list({ q: 'terrajen lease' }).items.map((item) => item.id), ['of_bbb']);
  assert.equal(reader.list({ q: 'terrajen nothing-like-this' }).items.length, 0);
  const one = reader.list({ limit: 1 });
  assert.equal(one.items.length, 1);
  assert.equal(one.matched, 2);
  assert.deepEqual(reader.list({ limit: 1, offset: 1 }).items.map((item) => item.id), ['of_bbb']);
  assert.equal(reader.list({ profile: 'hhp' }).total, 0);
  assert.equal(reader.list({ profile: 'nobody' }).total, 0);
  assert.throws(() => reader.list({ profile: '../intelio' }), /Unknown profile/);
  assert.throws(() => reader.list({ client: '../x' }), /Unknown client/);
});

test('transcripts: a symlinked folder outside the profiles root is not read', { skip: process.platform === 'win32' }, () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-outside-'));
  fs.writeFileSync(path.join(outside, '2026-01-01-x.md'), recording({ id: 'of_out', title: 'outside', date: '2026-01-01', summary: 'x' }));
  fs.mkdirSync(path.join(root, 'evil'));
  fs.symlinkSync(outside, path.join(root, 'evil', 'transcripts'));
  assert.equal(createTranscripts({ root }).list({ profile: 'evil' }).total, 0);
});

test('parseTranscript copes with a file that has no summary', () => {
  const row = parseTranscript('---\ntitle: "Just a title"\ndate: 2026-01-02\n---\n# Just a title\n', '2026-01-02-x.md');
  assert.equal(row.title, 'Just a title');
  assert.deepEqual(row.actions, []);
  assert.equal(row.excerpt, '');
});

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/transcripts needs a signed-in identity and reads the profiles root', async () => {
  const root = fixture();
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, sample: true, upstream: 'http://127.0.0.1:9', vaultRoot: root,
    identify: async () => ({ ok: true, login: 'owner@example' }),
  });
  const address = await app.listen();
  try {
    const ok = await request(address.port, '/api/transcripts?limit=1');
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.items.length, 1);
    assert.equal(body.total, 2);
    const prc = JSON.parse((await request(address.port, '/api/transcripts?profile=prc')).body);
    assert.deepEqual(prc.items.map((item) => item.id), ['of_aaa']);
    const bad = await request(address.port, '/api/transcripts?profile=..%2Fetc');
    assert.equal(bad.status, 400);
    const shell = await request(address.port, '/desktop/');
    assert.match(shell.body, /intelio\/pages\.cjs/);
    assert.match(shell.body, /frame-src https:\/\/intelio-vps\.tail9c1007\.ts\.net:8670/);
    const script = await request(address.port, '/ui/intelio/pages.cjs');
    assert.equal(script.status, 200);
    assert.match(script.body, /IntelioPages/);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
  // A caller whose Tailscale identity is not allowed gets nothing.
  const closed = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', vaultRoot: root,
    identify: async () => ({ ok: false, reason: 'not on the allowlist' }),
  });
  const other = await closed.listen();
  try {
    const denied = await request(other.port, '/api/transcripts');
    assert.equal(denied.status, 401);
    assert.equal(denied.body.includes('Drive migration'), false);
  } finally {
    await new Promise((resolve) => closed.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pages: Workspace URL follows the theme and the transcript query is bounded', () => {
  assert.equal(pages.workspaceUrl('light'), 'https://intelio-vps.tail9c1007.ts.net:8670/?embed=intelio&theme=light');
  assert.equal(pages.workspaceUrl('blue'), 'https://intelio-vps.tail9c1007.ts.net:8670/?embed=intelio&theme=dark');
  assert.equal(pages.workspaceUrl('dark'), 'https://intelio-vps.tail9c1007.ts.net:8670/?embed=intelio&theme=dark');
  assert.equal(pages.transcriptQuery({ profile: 'prc', q: 'lease', limit: 10 }), 'profile=prc&q=lease&limit=10');
  assert.equal(pages.clientLabel('hhp'), 'HHP');
});
