'use strict';
/**
 * Aggregated MCP server for Hermes: one streamable-HTTP endpoint at
 * http://127.0.0.1:8645/mcp (INTELIO_NODES_MCP_PORT). JSON responses, with
 * one exception: a tools/call that pushes (git push, gh pr merge ...) answers
 * as an SSE stream that first carries an `elicitation/create` request, so
 * Hermes asks Hayden on the surface he is using (inline prompt in the intelio
 * app, Telegram buttons). Hermes POSTs the answer back as a JSON-RPC response;
 * no answer within INTELIO_PUSH_APPROVAL_WAIT_S (150 s) refuses the push.
 * No standalone GET stream; no sessions. Bearer token from ~/.config/intelio/nodes-mcp.token
 * (INTELIO_NODES_MCP_TOKEN_FILE) — mode 600, 32+ random bytes as hex.
 * Loopback bind only: anything else is refused at construction.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const protocol = require('../../desktop/src/intelio/node/protocol.cjs');
const { configDir } = require('./nodes.cjs');

const DEFAULT_PORT = 8645;
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];
const BODY_LIMIT = 16 * 1024 * 1024;
const SERVER_INFO = { name: 'intelio-computers', version: '1.1.0' };
const DEFAULT_APPROVAL_WAIT_S = 150;

function approvalWaitMs(env = process.env) {
  const n = Number(env.INTELIO_PUSH_APPROVAL_WAIT_S);
  return (Number.isFinite(n) && n >= 5 && n <= 900 ? n : DEFAULT_APPROVAL_WAIT_S) * 1000;
}

function defaultTokenFile(env = process.env) {
  return String(env.INTELIO_NODES_MCP_TOKEN_FILE || '').trim() || path.join(configDir(env), 'nodes-mcp.token');
}

/**
 * Literal loopback addresses only. 'localhost' is refused: it goes through the
 * resolver (hosts file, NSS), so it is a name we would have to trust, not an address.
 */
function isLoopbackBind(bind) {
  const host = String(bind || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1';
}

/** What the socket actually bound to must be loopback too (defense in depth). */
function isLoopbackAddress(address) {
  const host = String(address || '').toLowerCase().replace(/^::ffff:/, '');
  return host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Reads the token file. Refuses group/world-readable files on POSIX and short tokens. */
function readToken(file, { platform = process.platform } = {}) {
  const st = fs.statSync(file);
  if (platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error(`${file} must be mode 600.`);
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64,}$/i.test(token)) throw new Error(`${file} must hold at least 32 random bytes as hex.`);
  return token;
}

function bearerOk(req, token) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!match) return false;
  const left = Buffer.from(match[1]);
  const right = Buffer.from(token);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createNodesMcp({
  hub,
  port = Number(process.env.INTELIO_NODES_MCP_PORT || DEFAULT_PORT),
  bind = '127.0.0.1',
  token = '',
  tokenFile = defaultTokenFile(),
  log = (line) => process.stderr.write(`${line}\n`),
  approvalWait = approvalWaitMs(),
} = {}) {
  if (!hub) throw new Error('createNodesMcp needs a hub.');
  const elicits = new Map(); // our elicitation/create id -> settle(response message)
  if (!isLoopbackBind(bind)) throw new Error('Refusing to listen: the intelio computers MCP server binds loopback only (127.0.0.1 or ::1).');
  const host = String(bind).trim().replace(/^\[|\]$/g, '');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INTELIO_NODES_MCP_PORT must be 0-65535.');
  const secret = token || readToken(tokenFile);

  function reply(res, status, body, headers = {}) {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    res.writeHead(status, {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      'cache-control': 'no-store',
      'content-length': payload.length,
      ...headers,
    });
    res.end(payload);
  }
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

  async function toolsCall(params = {}, ctx = {}) {
    const name = String(params.name || '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (name === 'list_computers') {
      const rows = hub.listComputers();
      log(`intelio-nodes call computer=- tool=list_computers ok=true count=${rows.length}`);
      const enrolled = rows.filter((r) => r.kind !== 'cloud').length;
      return { content: protocol.textContent(enrolled ? { computers: rows } : { computers: rows, note: 'No personal computers are enrolled yet. Sign in to the intelio app on a computer to enroll it.' }), isError: false };
    }
    if (!protocol.TOOL_NAMES.includes(name)) return null;
    return hub.call(args.computer, name, args, { approve: ctx.approve, agent: ctx.agent });
  }

  /** A JSON-RPC response from the client: the answer to one of our elicitation requests. */
  function settleElicitation(msg) {
    const settle = elicits.get(String(msg.id));
    if (settle) settle(msg);
  }

  async function dispatch(msg, ctx = {}) {
    if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.method === undefined && msg.id !== undefined && msg.id !== null
      && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
      settleElicitation(msg);
      return undefined;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return undefined;
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion || '');
        return rpcResult(msg.id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : LATEST_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Use the person\'s computers: their enrolled laptops/desktops and "cloud" (this VPS). Call list_computers first; every other tool takes computer (name or id). A computer that is offline or turned off for agents returns an error: tell the person, do not retry.',
        });
      }
      case 'ping': return rpcResult(msg.id, {});
      case 'tools/list': return rpcResult(msg.id, { tools: protocol.TOOLS });
      case 'tools/call': {
        const result = await toolsCall(msg.params, ctx);
        if (!result) return rpcError(msg.id, -32602, `Unknown tool: ${String(msg.params?.name || '').slice(0, 80)}`);
        return rpcResult(msg.id, result);
      }
      default: return rpcError(msg.id, -32601, `Method not found: ${msg.method.slice(0, 80)}`);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') return reply(res, 404, { error: 'Not found.' });
    if (!bearerOk(req, secret)) {
      log('intelio-nodes mcp denied bearer');
      return reply(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });
    }
    if (req.headers.origin) return reply(res, 403, { error: 'Browser origins are refused.' });
    if (req.method === 'GET') return reply(res, 405, { error: 'This server answers POST with JSON; no SSE stream.' }, { allow: 'POST, DELETE' });
    if (req.method === 'DELETE') return reply(res, 405, { error: 'Stateless server: nothing to terminate.' }, { allow: 'POST' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' }, { allow: 'POST' });
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > BODY_LIMIT) return reply(res, 413, rpcError(null, -32600, 'Request too large'));
        chunks.push(chunk);
      }
    } catch { return undefined; }
    // Which Hermes profile is calling (Hermes MCP config: headers X-Intelio-Agent, or /mcp?agent=).
    // Shown in the ask-before prompt on a computer; never used for access decisions.
    const agent = protocol.cleanAgent(req.headers['x-intelio-agent'] || url.searchParams.get('agent') || '');
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, rpcError(null, -32700, 'Parse error')); }
    if (Array.isArray(msg)) {
      const out = [];
      for (const item of msg) { const r = await dispatch(item, { agent }); if (r) out.push(r); }
      return out.length ? reply(res, 200, out) : reply(res, 202);
    }
    const stream = sseStream(req, res);
    const answer = await dispatch(msg, { agent, approve: stream.canStream && msg && msg.method === 'tools/call' ? (ask) => elicit(stream, ask) : null });
    if (stream.open) { stream.end(answer); return undefined; }
    if (answer === undefined) return reply(res, 202);
    return reply(res, 200, answer);
  }

  /** Lazily turns this POST's response into an SSE stream (only when we must ask Hayden). */
  function sseStream(req, res) {
    const accept = String(req.headers.accept || '').toLowerCase();
    let open = false;
    let gone = false;
    res.on('close', () => { gone = true; });
    const start = () => {
      if (open) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      open = true;
    };
    return {
      canStream: accept.includes('text/event-stream'),
      get open() { return open; },
      get gone() { return gone; },
      res,
      send(obj) { start(); if (!gone) res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`); },
      end(obj) { if (obj !== undefined) this.send(obj); res.end(); },
    };
  }

  /**
   * Asks through the client (Hermes routes it to Hayden). Resolves 'accept',
   * 'decline', 'cancel' (no answer in time / stream closed) or 'unavailable'
   * (the client cannot elicit). Never rejects.
   */
  function elicit(stream, { title, message }) {
    const id = `intelio-approval-${crypto.randomBytes(8).toString('hex')}`;
    return new Promise((resolve) => {
      let timer = null;
      const onClose = () => finish('cancel');
      function finish(answer) {
        if (!elicits.has(id)) return;
        elicits.delete(id);
        clearTimeout(timer);
        stream.res.off('close', onClose);
        resolve(answer);
      }
      elicits.set(id, (response) => {
        if (response.error) { finish('unavailable'); return; } // e.g. "Elicitation not supported"
        const action = response.result && response.result.action;
        finish(action === 'accept' ? 'accept' : action === 'decline' ? 'decline' : 'cancel');
      });
      timer = setTimeout(() => finish('cancel'), approvalWait);
      timer.unref?.();
      stream.res.once('close', onClose);
      try {
        stream.send({
          jsonrpc: '2.0',
          id,
          method: 'elicitation/create',
          params: { message: String(message || title || 'Allow this?').slice(0, 2000), requestedSchema: { type: 'object', properties: {} } },
        });
      } catch { finish('cancel'); }
      if (stream.gone) finish('cancel');
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { if (!res.headersSent) reply(res, 500, rpcError(null, -32603, 'Internal error')); else { try { res.end(); } catch { /* gone */ } } });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;

  return {
    server,
    handle,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          if (!address || !isLoopbackAddress(address.address)) {
            server.close();
            reject(new Error('Refusing to serve: the intelio computers MCP server did not bind a loopback address.'));
            return;
          }
          resolve(address);
        });
      });
    },
    close(done) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => { if (typeof done === 'function') done(); });
    },
  };
}

const PUSH_OUTCOME_WORDS = { allowed: 'allowed by Hayden', declined: 'Hayden did not allow it', unanswered: 'nobody answered', unavailable: 'could not ask' };

/**
 * Push approvals go to the intelio activity log (desktop/src/intelio/activity-log.cjs,
 * appendActivity) when that module is present; otherwise only the relay audit has them.
 */
function pushActivityHook({ requireImpl = require } = {}) {
  let activity = null;
  try { activity = requireImpl('../../desktop/src/intelio/activity-log.cjs'); } catch { return null; }
  if (!activity || typeof activity.appendActivity !== 'function') return null;
  return (event) => activity.appendActivity({
    kind: 'connector',
    action: 'push',
    ok: event.outcome === 'allowed',
    actor: event.outcome === 'allowed' || event.outcome === 'declined' ? 'user' : 'intelio',
    tool: event.tool,
    ts: event.time,
    summary: `Push on ${event.computer}: ${(event.pushes || []).join(', ')} (${PUSH_OUTCOME_WORDS[event.outcome] || event.outcome})`,
  });
}

/** server.cjs starts the relay when INTELIO_NODES=1 or the token file exists. */
function nodesEnabled(env = process.env) {
  if (String(env.INTELIO_NODES || '').trim() === '1') return true;
  if (String(env.INTELIO_NODES || '').trim() === '0') return false;
  try { return fs.statSync(defaultTokenFile(env)).isFile(); } catch { return false; }
}

/**
 * Registry + hub + MCP server as one unit for server.cjs. A missing/unsafe token
 * or a busy port disables only the MCP side (logged); the phone app keeps running.
 */
function createNodesRelay({
  env = process.env,
  log = (line) => process.stderr.write(`${line}\n`),
  registryFile,
  token = '',
  tokenFile = defaultTokenFile(env),
  mcpPort = Number(env.INTELIO_NODES_MCP_PORT || DEFAULT_PORT),
  mcpBind = '127.0.0.1',
  hubOptions = {},
  auditFile,
  cloud,
  appVersion = '',
} = {}) {
  const { createNodeRegistry, createNodeHub, defaultRegistryFile, defaultAuditFile } = require('./nodes.cjs');
  const { createCloudComputer, cloudEnabled } = require('./nodes-local.cjs');
  const registry = createNodeRegistry({ file: registryFile || defaultRegistryFile(env) });
  let locals = [];
  if (cloud === true || (cloud !== false && cloudEnabled(env))) {
    try { locals = [createCloudComputer({ env, version: appVersion })]; } catch (error) { log(`intelio-nodes cloud computer disabled: ${String(error.message || error).slice(0, 200)}`); }
  }
  const hub = createNodeHub({ registry, log, auditFile: auditFile === undefined ? defaultAuditFile(env) : auditFile, locals, onActivity: pushActivityHook(), ...hubOptions });
  let mcp = null;
  try {
    mcp = createNodesMcp({ hub, port: mcpPort, bind: mcpBind, token, tokenFile, log });
  } catch (error) {
    log(`intelio-nodes mcp disabled: ${String(error.message || error).slice(0, 200)}`);
  }
  return {
    registry,
    hub,
    get mcp() { return mcp; },
    async listen() {
      hub.watch();
      if (!mcp) return null;
      try {
        const address = await mcp.listen();
        log(`intelio-nodes mcp listening on ${address.address}:${address.port}`);
        return address;
      } catch (error) {
        log(`intelio-nodes mcp did not start: ${String(error.code || error.message || error).slice(0, 200)}`);
        mcp = null;
        return null;
      }
    },
    close() {
      hub.close();
      if (mcp) mcp.close();
    },
  };
}

module.exports = { DEFAULT_PORT, DEFAULT_APPROVAL_WAIT_S, approvalWaitMs, pushActivityHook, SUPPORTED_VERSIONS, LATEST_VERSION, defaultTokenFile, isLoopbackBind, isLoopbackAddress, readToken, createNodesMcp, nodesEnabled, createNodesRelay };
