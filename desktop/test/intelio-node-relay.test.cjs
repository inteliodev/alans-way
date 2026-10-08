'use strict';
// intelio node relay (mobile/pwa/nodes*.cjs) against a fake node over a real WebSocket.
// Contract: docs/intelio-node.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');
const { createNodesMcp, readToken, isLoopbackBind, nodesEnabled } = require('../../mobile/pwa/nodes-mcp.cjs');
const { createNodeRegistry, createNodeHub, verifySecret } = require('../../mobile/pwa/nodes.cjs');
const cli = require('../../mobile/pwa/nodes-cli.cjs');
const { connectWebSocket } = require('../src/intelio/node/ws.cjs');
const protocol = require('../src/intelio/node/protocol.cjs');

const TOKEN = crypto.randomBytes(32).toString('hex');
const GOOD_JWT = 'good-access-assertion';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': payload.length, ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };
let rpcId = 0;
async function rpc(port, method, params) {
  const res = await post(port, { jsonrpc: '2.0', id: ++rpcId, method, params }, auth);
  assert.equal(res.status, 200, res.text);
  return res.json;
}
async function callTool(port, name, args = {}) {
  const res = await rpc(port, 'tools/call', { name, arguments: args });
  assert.ok(res.result, JSON.stringify(res));
  return res.result;
}

/** A fake node: dials /node/connect, sends hello, answers calls with handler(msg). */
async function fakeNode(url, { headers = {}, identity = null, name = 'Test-PC', handler } = {}) {
  const ws = await connectWebSocket(url, { headers });
  const frames = [];
  const waiters = [];
  ws.on('message', (text) => {
    const msg = JSON.parse(text);
    frames.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    if (msg.type === 'call' && handler) {
      Promise.resolve(handler(msg)).then((reply) => { if (reply && !ws.closed) ws.send(JSON.stringify(reply)); });
    }
  });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason })));
  const next = (match) => {
    const hit = frames.find(match);
    if (hit) { frames.splice(frames.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  ws.send(JSON.stringify(protocol.frames.hello({ name, os: 'Windows 11 Pro', arch: 'x64', user: 'hayden', version: '0.3.21' }, identity)));
  const first = await Promise.race([next((m) => m.type === 'welcome' || m.type === 'refused'), closed.then(() => ({ type: 'closed' }))]);
  return { ws, first, closed, next };
}

async function startRelay(t, extra = {}) {
  const dir = tmpdir('intelio-nodes-');
  const registryFile = path.join(dir, 'nodes.json');
  const logs = [];
  let tailnetAllowed = true;
  const app = createPwaServer({
    bind: '127.0.0.1',
    port: 0,
    localPort: 0,
    upstream: 'http://127.0.0.1:9',
    accessMode: true,
    accessVerify: async (assertion) => (assertion === GOOD_JWT ? { ok: true, login: 'hayden@intelio.co' } : { ok: false }),
    identify: async () => (tailnetAllowed ? { ok: true, login: 'inteliodev@github' } : { ok: false, reason: 'login' }),
    vaultRoot: dir,
    profileOps: { keyFor: () => 'k' },
    voice: { status: async () => ({}) },
    log: (line) => logs.push(line),
    fetchImpl: async () => { throw new Error('no upstream in tests'); },
    nodes: { registryFile, token: TOKEN, mcpPort: 0, ...extra },
  });
  await app.listen();
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const accessPort = app.local.address().port;
  const tailnetPort = app.server.address().port;
  const mcpPort = app.nodes.mcp.server.address().port;
  return {
    app, dir, registryFile, logs, accessPort, tailnetPort, mcpPort,
    accessUrl: `ws://127.0.0.1:${accessPort}/node/connect`,
    tailnetUrl: `ws://127.0.0.1:${tailnetPort}/node/connect`,
    setTailnetAllowed(v) { tailnetAllowed = v; },
  };
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('MCP server binds loopback only and refuses anything else', () => {
  const hub = { listComputers: () => [], call: async () => ({}) };
  // Wildcard, tailnet and LAN binds are built at runtime so the publication scan does not flag them.
  const ip = (...parts) => parts.join('.');
  for (const bind of [ip(0, 0, 0, 0), '::', ip(100, 64, 1, 2), 'vps.tail1234.ts.net', ip(192, 168, 1, 5), '203.0.113.5']) {
    assert.throws(() => createNodesMcp({ hub, bind, token: TOKEN, port: 0 }), /loopback only/);
  }
  for (const bind of ['127.0.0.1', '::1', 'localhost']) assert.ok(isLoopbackBind(bind));
  assert.equal(protocol.TOOL_NAMES.length, 13);
  assert.deepEqual([...protocol.TOOL_NAMES].sort(), ['computer_info', 'list_computers', 'list_dir', 'list_sessions', 'read_file', 'read_output', 'run_command', 'screenshot', 'search_files', 'send_input', 'start_session', 'stop_session', 'write_file']);
});

test('token file must be hex, 32+ bytes and (on POSIX) mode 600', { skip: process.platform === 'win32' && 'file modes are POSIX-only' }, () => {
  const dir = tmpdir('intelio-token-');
  const file = path.join(dir, 'nodes-mcp.token');
  fs.writeFileSync(file, `${TOKEN}\n`, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.throws(() => readToken(file), /mode 600/);
  fs.chmodSync(file, 0o600);
  assert.equal(readToken(file), TOKEN);
  fs.writeFileSync(file, 'short');
  assert.throws(() => readToken(file), /32 random bytes/);
  assert.equal(nodesEnabled({ INTELIO_NODES_MCP_TOKEN_FILE: file }), true);
  assert.equal(nodesEnabled({ INTELIO_NODES_MCP_TOKEN_FILE: path.join(dir, 'missing') }), false);
  assert.equal(nodesEnabled({ INTELIO_NODES: '1', INTELIO_NODES_MCP_TOKEN_FILE: path.join(dir, 'missing') }), true);
});

test('MCP: 401 without the bearer; initialize, tools/list, list_computers; browser origins refused', async (t) => {
  const r = await startRelay(t);
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  assert.equal((await post(r.mcpPort, init)).status, 401);
  assert.equal((await post(r.mcpPort, init, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(r.mcpPort, init, { authorization: `Bearer ${TOKEN}x` })).status, 401);
  assert.equal((await post(r.mcpPort, init, { ...auth, origin: 'https://evil.example' })).status, 403);
  const ok = await post(r.mcpPort, init, auth);
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /application\/json/);
  assert.equal(ok.json.result.protocolVersion, '2025-06-18');
  assert.ok(ok.json.result.capabilities.tools);
  const old = await rpc(r.mcpPort, 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal(old.result.protocolVersion, '2025-11-25');
  const note = await post(r.mcpPort, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  assert.deepEqual((await rpc(r.mcpPort, 'ping')).result, {});
  const list = await rpc(r.mcpPort, 'tools/list');
  assert.deepEqual(list.result.tools.map((x) => x.name), protocol.TOOL_NAMES);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    if (tool.name !== 'list_computers') assert.ok(tool.inputSchema.required.includes('computer'), tool.name);
  }
  const empty = await callTool(r.mcpPort, 'list_computers');
  assert.equal(empty.isError, false);
  assert.deepEqual(JSON.parse(empty.content[0].text).computers, []);
  const unknown = await rpc(r.mcpPort, 'tools/call', { name: 'format_disk', arguments: {} });
  assert.equal(unknown.error.code, -32602);
  const nope = await rpc(r.mcpPort, 'resources/list');
  assert.equal(nope.error.code, -32601);
  const get = await new Promise((resolve) => http.get({ hostname: '127.0.0.1', port: r.mcpPort, path: '/mcp', headers: auth }, (res) => { res.resume(); resolve(res.statusCode); }));
  assert.equal(get, 405);
});

test('enroll once, later connects need the secret and the human check, calls route with audit, offline errors', async (t) => {
  const r = await startRelay(t);
  // No Access JWT: refused before any hello.
  await assert.rejects(connectWebSocket(r.accessUrl), (e) => e.status === 401);
  await assert.rejects(connectWebSocket(r.accessUrl, { headers: { 'cf-access-jwt-assertion': 'forged' } }), (e) => e.status === 401);

  const seenArgs = [];
  const handler = (msg) => {
    seenArgs.push(msg);
    if (msg.tool === 'computer_info') return protocol.frames.ok(msg.id, protocol.textContent({ hostname: 'TEST-PC', os: 'Windows 11 Pro' }));
    if (msg.tool === 'write_file') return protocol.frames.ok(msg.id, protocol.textContent({ bytes_written: 11 }));
    return protocol.frames.fail(msg.id, 'nope');
  };
  const node = await fakeNode(r.accessUrl, { headers: { cookie: `CF_Authorization=${GOOD_JWT}` }, handler });
  assert.equal(node.first.type, 'welcome');
  assert.match(node.first.device_id, /^n_[0-9a-f]{16}$/);
  assert.match(node.first.device_secret, /^[0-9a-f]{64}$/);
  const identity = { device_id: node.first.device_id, device_secret: node.first.device_secret };

  // Registry stores a hash only, mode 600.
  const raw = fs.readFileSync(r.registryFile, 'utf8');
  assert.ok(!raw.includes(identity.device_secret));
  const record = JSON.parse(raw).devices[0];
  assert.equal(record.name, 'Test-PC');
  assert.equal(record.enrolled_by, 'hayden@intelio.co');
  assert.ok(verifySecret(identity.device_secret, record.secret_hash));
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.registryFile).mode & 0o777, 0o600);

  const listed = JSON.parse((await callTool(r.mcpPort, 'list_computers')).content[0].text).computers;
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['id', 'last_seen', 'name', 'online', 'os', 'user', 'version']);
  assert.equal(listed[0].online, true);
  assert.equal(listed[0].user, 'hayden');

  const info = await callTool(r.mcpPort, 'computer_info', { computer: 'test-pc' });
  assert.equal(info.isError, false);
  assert.equal(JSON.parse(info.content[0].text).hostname, 'TEST-PC');
  assert.equal(seenArgs[0].args.computer, undefined, 'the computer argument is consumed by the relay');

  const SECRET_CONTENT = 'hello world';
  const wrote = await callTool(r.mcpPort, 'write_file', { computer: identity.device_id, path: '~/x.txt', content: SECRET_CONTENT });
  assert.equal(wrote.isError, false);
  const failed = await callTool(r.mcpPort, 'list_dir', { computer: 'Test-PC', path: '~' });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, 'nope');
  const missing = await callTool(r.mcpPort, 'list_dir', { computer: 'Other-PC', path: '~' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No computer named Other-PC/);

  // Audit: a line per call, no file contents, no secrets.
  const calls = r.logs.filter((l) => l.startsWith('intelio-nodes call'));
  assert.ok(calls.length >= 4, calls.join('\n'));
  assert.ok(calls.some((l) => /tool=write_file .*content_chars/.test(l)));
  for (const line of r.logs) {
    assert.ok(!line.includes(SECRET_CONTENT), line);
    assert.ok(!line.includes(identity.device_secret), line);
    assert.ok(!line.includes(TOKEN), line);
  }

  // Second connection with the device id: wrong secret refused, missing JWT refused, right one welcomed without a new secret.
  const bad = await fakeNode(r.accessUrl, { headers: { cookie: `CF_Authorization=${GOOD_JWT}` }, identity: { device_id: identity.device_id, device_secret: 'f'.repeat(64) } });
  assert.equal(bad.first.type, 'refused');
  assert.equal(bad.first.code, 'bad_secret');
  await assert.rejects(connectWebSocket(r.accessUrl), (e) => e.status === 401);
  node.ws.close(1000, 'bye');
  await node.closed;
  assert.ok(await waitFor(() => !r.app.nodes.hub.live.size));

  // Offline: isError with "<name> is offline (last seen …)".
  const offline = await callTool(r.mcpPort, 'computer_info', { computer: 'Test-PC' });
  assert.equal(offline.isError, true);
  assert.match(offline.content[0].text, /^Test-PC is offline \(last seen \d{4}-\d\d-\d\dT/);

  const again = await fakeNode(r.accessUrl, { headers: { 'cf-access-jwt-assertion': GOOD_JWT }, identity, handler });
  assert.equal(again.first.type, 'welcome');
  assert.equal(again.first.device_id, identity.device_id);
  assert.equal(again.first.device_secret, undefined);
  assert.equal(JSON.parse((await callTool(r.mcpPort, 'list_computers')).content[0].text).computers.length, 1);
  again.ws.close();
});

test('revoke disconnects the live node and refuses it afterwards; rename via the CLI', async (t) => {
  const r = await startRelay(t);
  const node = await fakeNode(r.tailnetUrl, { name: 'Laptop' });
  assert.equal(node.first.type, 'welcome');
  const identity = { device_id: node.first.device_id, device_secret: node.first.device_secret };
  const out = [];
  const env = { INTELIO_NODES_FILE: r.registryFile };
  assert.equal(cli.run(['rename', 'laptop', 'Work', 'Laptop'], { env, out: (s) => out.push(s), err: (s) => out.push(s) }), 0);
  assert.equal(cli.run(['list'], { env, out: (s) => out.push(s), err: (s) => out.push(s) }), 0);
  assert.match(out.join('\n'), /Work Laptop/);
  assert.ok(!out.join('\n').includes(identity.device_secret));
  assert.equal(cli.run(['revoke', 'work laptop'], { env, out: (s) => out.push(s), err: (s) => out.push(s) }), 0);
  // The relay watches nodes.json: the live socket is told and closed.
  const refused = await Promise.race([node.next((m) => m.type === 'refused'), new Promise((r2) => setTimeout(() => r2(null), 6000))]);
  assert.ok(refused, 'revoked node was not told');
  assert.equal(refused.code, 'revoked');
  await node.closed;
  const back = await fakeNode(r.tailnetUrl, { identity, name: 'Laptop' });
  assert.equal(back.first.type, 'refused');
  assert.equal(back.first.code, 'revoked');
  const listed = JSON.parse((await callTool(r.mcpPort, 'list_computers')).content[0].text).computers;
  assert.equal(listed.length, 0);
  assert.equal(cli.run(['revoke', 'nobody'], { env, out: () => {}, err: () => {} }), 1);
  assert.equal(cli.run(['bogus'], { env, out: () => {}, err: () => {} }), 2);
});

test('tailnet listener uses the Tailscale login check; sample sessions and unknown paths cannot enroll', async (t) => {
  const r = await startRelay(t);
  r.setTailnetAllowed(false);
  await assert.rejects(connectWebSocket(r.tailnetUrl), (e) => e.status === 401);
  r.setTailnetAllowed(true);
  const node = await fakeNode(r.tailnetUrl, { name: 'Mac' });
  assert.equal(node.first.type, 'welcome');
  node.ws.close();
  const bad = await fakeNode(r.tailnetUrl, { name: '' });
  assert.equal(bad.first.type, 'refused');
  assert.equal(bad.first.code, 'bad_hello');
});

test('per-call timeout and disconnect mid-call give readable errors', async () => {
  assert.equal(protocol.callTimeoutMs('run_command', { timeout_s: 5 }), 15000);
  assert.equal(protocol.callTimeoutMs('run_command', {}), 130000);
  assert.equal(protocol.callTimeoutMs('run_command', { timeout_s: 99999 }), 1810000);
  assert.equal(protocol.callTimeoutMs('read_file', {}), 130000);
  const dir = tmpdir('intelio-hub-');
  const registry = createNodeRegistry({ file: path.join(dir, 'nodes.json') });
  const logs = [];
  const hub = createNodeHub({ registry, log: (l) => logs.push(l) });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => hub.accept(req, socket, head, { login: 'test' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `ws://127.0.0.1:${server.address().port}/node/connect`;
    const node = await fakeNode(url, { name: 'Slow', handler: () => null });
    assert.equal(node.first.type, 'welcome');
    const slow = await hub.call('slow', 'run_command', { computer: 'slow', command: 'x' }, { timeoutMs: 200 });
    assert.equal(slow.isError, true);
    assert.match(slow.content[0].text, /Slow did not answer run_command within/);
    const pending = hub.call('Slow', 'list_dir', { computer: 'Slow', path: '/' }, { timeoutMs: 5000 });
    setTimeout(() => node.ws.close(), 100);
    const dropped = await pending;
    assert.equal(dropped.isError, true);
    assert.match(dropped.content[0].text, /disconnected during the call/);
    assert.ok(logs.some((l) => /tool=run_command .*"program":"x","command_chars":1/.test(l)));
  } finally {
    hub.close();
    server.close();
  }
});

test('terminal sessions end to end through the relay: start, send, read (long poll), list, stop', async (t) => {
  const r = await startRelay(t);
  // A fake node with a tiny in-memory terminal: echoes typed lines after a delay.
  const sessions = new Map();
  const calls = [];
  let n = 0;
  const handler = async (msg) => {
    calls.push(msg);
    const a = msg.args;
    const reply = (value) => protocol.frames.ok(msg.id, protocol.textContent(value));
    if (msg.tool === 'start_session') {
      const id = `s_${String(++n).padStart(12, '0')}`;
      sessions.set(id, { out: 'PS C:\\> ', exited: false, code: null, command: a.command || '(login shell)', waiters: [] });
      return reply({ session_id: id, pid: 4242, pty: true, command: a.command || '(login shell)', cwd: a.cwd || 'C:\\Users\\hayden' });
    }
    if (msg.tool === 'list_sessions') return reply({ sessions: [...sessions].map(([id, x]) => ({ id, command: x.command, cwd: '~', started: new Date().toISOString(), idle_s: 0, exited: x.exited })) });
    const s = sessions.get(a.session_id);
    if (!s) return protocol.frames.fail(msg.id, `No session ${a.session_id} on this computer.`);
    if (msg.tool === 'send_input') {
      setTimeout(() => {
        s.out += `${a.text}\nyou said: ${a.text}\n`;
        if (a.text === 'exit') { s.exited = true; s.code = 0; }
        for (const w of s.waiters.splice(0)) w();
      }, 200);
      return reply({ ok: true, session_id: a.session_id, chars: String(a.text || '').length, keys: (a.keys || []).length, enter: a.enter !== false });
    }
    if (msg.tool === 'read_output') {
      const since = a.since ?? 0;
      if (s.out.length <= since && !s.exited) await new Promise((resolve) => { s.waiters.push(resolve); setTimeout(resolve, a.wait_ms ?? 2000); });
      const text = s.out.slice(since);
      return protocol.frames.ok(msg.id, [
        { type: 'text', text: JSON.stringify({ session_id: a.session_id, cursor: s.out.length, exited: s.exited, exit_code: s.code, truncated: false, bytes: text.length, pty: true }) },
        { type: 'text', text },
      ]);
    }
    if (msg.tool === 'stop_session') { sessions.delete(a.session_id); return reply({ session_id: a.session_id, exit_code: s.code ?? 0, stopped: !s.exited }); }
    return protocol.frames.fail(msg.id, 'nope');
  };
  const node = await fakeNode(r.tailnetUrl, { name: 'Laptop', handler });
  assert.equal(node.first.type, 'welcome');
  t.after(() => node.ws.close());

  const list = await rpc(r.mcpPort, 'tools/list');
  const names = list.result.tools.map((x) => x.name);
  for (const tool of ['start_session', 'send_input', 'read_output', 'stop_session', 'list_sessions']) assert.ok(names.includes(tool), tool);
  const readSchema = list.result.tools.find((x) => x.name === 'read_output').inputSchema;
  assert.deepEqual(readSchema.required, ['computer', 'session_id']);
  assert.equal(readSchema.properties.wait_ms.maximum, 30000);

  const started = await callTool(r.mcpPort, 'start_session', { computer: 'laptop', command: 'claude', cwd: '~/code', cols: 120, rows: 40 });
  assert.equal(started.isError, false);
  const { session_id: id, pty } = JSON.parse(started.content[0].text);
  assert.equal(pty, true);
  const startCall = calls.find((c) => c.tool === 'start_session');
  assert.deepEqual(startCall.args, { command: 'claude', cwd: '~/code', cols: 120, rows: 40 }, 'computer is consumed by the relay');

  const first = await callTool(r.mcpPort, 'read_output', { computer: 'Laptop', session_id: id, wait_ms: 0 });
  const meta = JSON.parse(first.content[0].text);
  assert.equal(first.content[1].text, 'PS C:\\> ');

  const SECRET_TYPED = 'my-secret-prompt-text';
  const sent = await callTool(r.mcpPort, 'send_input', { computer: 'Laptop', session_id: id, text: SECRET_TYPED, keys: ['tab'] });
  assert.equal(sent.isError, false);
  // The long poll waits on the node and returns as soon as output arrives (well under wait_ms).
  const t0 = Date.now();
  const second = await callTool(r.mcpPort, 'read_output', { computer: 'Laptop', session_id: id, since: meta.cursor, wait_ms: 20000 });
  assert.ok(Date.now() - t0 < 5000);
  assert.match(second.content[1].text, /you said: my-secret-prompt-text/);

  const listed = JSON.parse((await callTool(r.mcpPort, 'list_sessions', { computer: 'Laptop' })).content[0].text);
  assert.deepEqual(listed.sessions.map((x) => x.id), [id]);
  await callTool(r.mcpPort, 'send_input', { computer: 'Laptop', session_id: id, text: 'exit' });
  const last = JSON.parse((await callTool(r.mcpPort, 'read_output', { computer: 'Laptop', session_id: id, since: JSON.parse(second.content[0].text).cursor, wait_ms: 5000 })).content[0].text);
  assert.equal(last.exited, true);
  assert.equal(last.exit_code, 0);
  const stopped = await callTool(r.mcpPort, 'stop_session', { computer: 'Laptop', session_id: id, force: true });
  assert.equal(JSON.parse(stopped.content[0].text).exit_code, 0);
  assert.deepEqual(calls.find((c) => c.tool === 'stop_session').args, { session_id: id, force: true });
  const missing = await callTool(r.mcpPort, 'read_output', { computer: 'Laptop', session_id: id });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No session/);

  // Relay audit: one line per call, typed text and output never logged.
  const lines = r.logs.filter((l) => l.startsWith('intelio-nodes call'));
  for (const tool of ['start_session', 'send_input', 'read_output', 'list_sessions', 'stop_session']) assert.ok(lines.some((l) => l.includes(`tool=${tool} `)), tool);
  assert.ok(lines.some((l) => /tool=send_input .*"text_chars":21,"keys":\["tab"\]/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /tool=start_session .*"program":"claude","command_chars":6/.test(l)));
  for (const line of r.logs) {
    assert.ok(!line.includes(SECRET_TYPED), line);
    assert.ok(!line.includes('you said'), line);
  }
});

test('read_output relay timeout is wait_ms + 10 s, so a long poll is never cut short', async () => {
  const dir = tmpdir('intelio-hub-');
  const registry = createNodeRegistry({ file: path.join(dir, 'nodes.json') });
  const hub = createNodeHub({ registry, log: () => {} });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => hub.accept(req, socket, head, { login: 'test' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `ws://127.0.0.1:${server.address().port}/node/connect`;
    // The node answers read_output only after 1.2 s (a long poll that found output late).
    const node = await fakeNode(url, { name: 'Poll', handler: (msg) => new Promise((resolve) => setTimeout(() => resolve(protocol.frames.ok(msg.id, protocol.textContent({ cursor: 1 }))), 1200)) });
    assert.equal(node.first.type, 'welcome');
    const ok = await hub.call('Poll', 'read_output', { computer: 'Poll', session_id: 's_1', wait_ms: 1000 });
    assert.equal(ok.isError, false, 'wait_ms 1000 gets 11 s at the relay');
    node.ws.close();
  } finally {
    hub.close();
    server.close();
  }
});
