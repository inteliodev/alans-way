'use strict';
// The inline approval answer reaches Hermes' POST /v1/runs/<id>/approval: from the
// desktop main process (remote-hermes.cjs) and through the phone server (server.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRemoteHermesClient } = require('../src/intelio/remote-hermes.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const KEY = 'sample-demo-key-not-real-0001';

function upstream(seen) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8'), auth: req.headers.authorization || '' });
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; res.end('{"error":"no"}'); return; }
      if (req.method === 'POST' && /\/v1\/runs\/run_[a-z0-9]+\/approval$/.test(req.url)) {
        if (req.url.includes('run_gone')) { res.statusCode = 409; res.end(JSON.stringify({ error: { message: 'Run has no pending approval: run_gone', code: 'approval_not_pending' } })); return; }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'hermes.run.approval_response', choice: body.choice, resolved: 1 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
}

function request(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('desktop client answers once or deny for the run, scoped to the profile', async () => {
  const seen = [];
  const server = upstream(seen);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createRemoteHermesClient({ getConfig: () => ({ host: '127.0.0.1', port: server.address().port, profile: 'intelio' }), getKey: async () => KEY });
    const ok = await client.runApproval('run_abc123', 'once', 'req-1', { profile: 'prc' });
    assert.equal(ok.choice, 'once');
    assert.equal(seen[0].url, '/p/prc/v1/runs/run_abc123/approval');
    assert.deepEqual(JSON.parse(seen[0].body), { choice: 'once', request_id: 'req-1' });
    await client.runApproval('run_abc123', 'always', '', { profile: 'prc' });
    assert.deepEqual(JSON.parse(seen[1].body), { choice: 'deny' }, 'anything but once is a no; never session/always');
    await assert.rejects(client.runApproval('run_gone', 'once', 'r', { profile: 'prc' }), (error) => error.status === 409);
  } finally { server.close(); }
});

test('phone server forwards the answer to the run and refuses odd ids and cross-origin posts', async () => {
  const seen = [];
  const hermes = upstream(seen);
  await new Promise((resolve) => hermes.listen(0, '127.0.0.1', resolve));
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-approval-vault-'));
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, localPort: 0,
    upstream: `http://127.0.0.1:${hermes.address().port}`,
    fetchImpl: globalThis.fetch, profileKey: KEY, vaultRoot,
    identify: (ip) => (String(ip).endsWith('127.0.0.1') ? { ok: true, login: 'owner@example' } : { ok: false }),
    accessMode: true, accessVerify: async () => ({ ok: false }),
    profileOps: { keyFor: () => KEY },
  });
  await app.listen();
  const access = app.local.address().port;
  const headers = { authorization: `Bearer ${KEY}`, 'x-intelio-profile': 'prc', 'content-type': 'application/json', origin: `http://127.0.0.1:${access}`, host: `127.0.0.1:${access}` };
  try {
    const ok = await request(access, 'POST', '/api/runs/run_abc123/approval', { headers, body: JSON.stringify({ choice: 'once', request_id: 'req-1', profile: 'prc' }) });
    assert.equal(ok.status, 200, ok.body);
    const forwarded = seen.find((row) => row.url === '/p/prc/v1/runs/run_abc123/approval');
    assert.ok(forwarded, JSON.stringify(seen));
    assert.deepEqual(JSON.parse(forwarded.body), { choice: 'once', request_id: 'req-1' });
    await request(access, 'POST', '/api/runs/run_abc123/approval', { headers, body: JSON.stringify({ choice: 'always', request_id: 'bad id!', profile: 'prc' }) });
    assert.deepEqual(JSON.parse(seen.at(-1).body), { choice: 'deny' });
    const gone = await request(access, 'POST', '/api/runs/run_gone/approval', { headers, body: JSON.stringify({ choice: 'once', profile: 'prc' }) });
    assert.equal(gone.status, 409);
    const noOrigin = { ...headers };
    delete noOrigin.origin;
    const before = seen.length;
    assert.equal((await request(access, 'POST', '/api/runs/run_abc123/approval', { headers: noOrigin, body: '{"choice":"once"}' })).status, 403, 'a post without Origin is refused (same rule as other changes)');
    const odd = await request(access, 'POST', '/api/runs/..%2Fsessions/approval', { headers, body: '{}' });
    assert.equal(odd.status, 404);
    const cross = await request(access, 'POST', '/api/runs/run_abc123/approval', { headers: { ...headers, origin: 'https://evil.example', host: `127.0.0.1:${access}` }, body: '{"choice":"once"}' });
    assert.equal(cross.status, 403);
    assert.equal(seen.length, before, 'nothing forwarded for refused requests');
  } finally {
    app.close?.();
    hermes.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});
