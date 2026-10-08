'use strict';
// Fixture for tests/test_intelio_nodes_mcp.py: a relay hub + the loopback MCP
// server + one fake enrolled computer ("Py-Test-PC") on a real WebSocket.
// Prints one JSON line {"mcp_port": N} when ready; exits when stdin closes.
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { createNodeRegistry, createNodeHub } = require(path.join(root, 'mobile/pwa/nodes.cjs'));
const { createNodesMcp } = require(path.join(root, 'mobile/pwa/nodes-mcp.cjs'));
const { connectWebSocket } = require(path.join(root, 'desktop/src/intelio/node/ws.cjs'));
const protocol = require(path.join(root, 'desktop/src/intelio/node/protocol.cjs'));

async function main() {
  const token = process.env.INTELIO_TEST_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-py-nodes-'));
  const registry = createNodeRegistry({ file: path.join(dir, 'nodes.json') });
  const hub = createNodeHub({ registry, log: () => {} });
  const relay = http.createServer();
  relay.on('upgrade', (req, socket, head) => hub.accept(req, socket, head, { login: 'python-test' }));
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const mcp = createNodesMcp({ hub, port: 0, token, log: () => {}, approvalWait: Number(process.env.INTELIO_TEST_APPROVAL_WAIT_MS || 20000) });
  const address = await mcp.listen();

  const ws = await connectWebSocket(`ws://127.0.0.1:${relay.address().port}/node/connect`);
  ws.on('message', (text) => {
    const msg = JSON.parse(text);
    if (msg.type !== 'call') return;
    if (msg.tool === 'run_command') ws.send(JSON.stringify(protocol.frames.ok(msg.id, protocol.textContent({ ran: msg.args.command, push_approval: Boolean(msg.args.push_approval) }))));
    else if (msg.tool === 'computer_info') ws.send(JSON.stringify(protocol.frames.ok(msg.id, protocol.textContent({ hostname: 'PY-TEST-PC', os: 'Fixture OS', user: 'tester' }))));
    else ws.send(JSON.stringify(protocol.frames.fail(msg.id, `fixture does not run ${msg.tool}`)));
  });
  const welcomed = new Promise((resolve) => ws.once('message', resolve));
  ws.send(JSON.stringify(protocol.frames.hello({ name: 'Py-Test-PC', os: 'Fixture OS', arch: 'x64', user: 'tester', version: 'test' })));
  await welcomed;
  process.stdout.write(`${JSON.stringify({ mcp_port: address.port })}\n`);
  const stop = () => { try { ws.close(); hub.close(); mcp.close(); relay.close(); fs.rmSync(dir, { recursive: true, force: true }); } finally { process.exit(0); } };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
