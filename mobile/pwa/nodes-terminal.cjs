'use strict';
/**
 * The person's own terminal on the VPS ("cloud" tab in the app's Terminal
 * window). Separate from the agents' sessions: agents cannot see, type into or
 * stop these, and the agents' kill switch does not end them. Served only
 * behind the person-only checks in nodes-human.cjs (Access session or allowed
 * Tailscale login, never a profile key, never the VPS itself, same-origin POSTs).
 *
 * POST /api/computers/terminal/start  { cols?, rows?, cwd? }      -> { session_id, pty }
 * POST /api/computers/terminal/input  { session_id, data }         -> { ok }
 * POST /api/computers/terminal/read   { session_id, since?, wait_ms? } -> { output (raw), cursor, exited, exit_code }
 * POST /api/computers/terminal/resize { session_id, cols, rows }
 * POST /api/computers/terminal/stop   { session_id }
 * GET  /api/computers/terminal/list
 *
 * INTELIO_CLOUD_TERMINAL=0 turns these routes off.
 */
const os = require('node:os');
const { createSessionManager } = require('../../desktop/src/intelio/node/sessions.cjs');
const { childEnv } = require('./nodes-local.cjs');

const ROUTE = /^\/api\/computers\/terminal\/(start|input|read|resize|stop|list)$/;

function terminalEnabled(env = process.env) {
  return String(env.INTELIO_CLOUD_TERMINAL || '').trim() !== '0';
}

function createCloudTerminal({ env = process.env, home = os.homedir(), sessionOptions = {}, log = () => {} } = {}) {
  const manager = createSessionManager({ home, env: childEnv(env), limits: { sessionMax: 4, sessionIdleMs: 60 * 60 * 1000, sessionWaitMaxMs: 25000 }, ...sessionOptions });
  const json = (res, send, code, value) => { send(res, code, value); return true; };

  async function handle({ req, res, url, send, readBody }) {
    const action = ROUTE.exec(url.pathname)[1];
    if (action === 'list') {
      if (req.method !== 'GET') return json(res, send, 405, { error: 'Use GET.' });
      return json(res, send, 200, { ok: true, sessions: manager.list() });
    }
    if (req.method !== 'POST') return json(res, send, 405, { error: 'Use POST.' });
    let body;
    try { body = await readBody(req, 128 * 1024); } catch { return json(res, send, 400, { error: 'Bad request.' }); }
    body = body && typeof body === 'object' ? body : {};
    try {
      if (action === 'start') {
        const started = manager.start({ cols: body.cols, rows: body.rows, cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined });
        log(`intelio-terminal start id=${started.session_id} pty=${started.pty}`);
        return json(res, send, 200, { ok: true, ...started });
      }
      if (action === 'input') return json(res, send, 200, manager.writeRaw(body.session_id, typeof body.data === 'string' ? body.data : ''));
      if (action === 'read') {
        const out = await manager.read(body.session_id, { since: body.since, wait_ms: Math.min(25000, Math.max(0, Number(body.wait_ms) || 0)), max_bytes: 256 * 1024, raw: true });
        return json(res, send, 200, { ok: true, ...out });
      }
      if (action === 'resize') return json(res, send, 200, { ok: true, ...manager.resize(body.session_id, { cols: body.cols, rows: body.rows }) });
      if (action === 'stop') {
        const stopped = await manager.stop(body.session_id, { force: true });
        log(`intelio-terminal stop id=${stopped.session_id}`);
        return json(res, send, 200, { ok: true, ...stopped });
      }
    } catch (error) {
      return json(res, send, 404, { error: String(error && error.message || error).slice(0, 300) });
    }
    return json(res, send, 404, { error: 'Not found.' });
  }

  return {
    matches: (pathname) => ROUTE.test(String(pathname || '')),
    handle,
    manager,
    close: () => manager.closeAll(),
  };
}

module.exports = { createCloudTerminal, terminalEnabled };
