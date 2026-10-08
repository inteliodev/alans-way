'use strict';
/**
 * Person-facing routes for the intelio computers (the app's Computers list and
 * activity log). Agents never reach these:
 * - Access listener: a Cloudflare Access session only; profile bearer keys
 *   (which agents hold) are refused.
 * - Tailnet listener: an allowed Tailscale login, and never a request from the
 *   VPS itself (agents run here, so a request from this machine is not a person).
 * - POSTs also need a same-origin Origin header.
 *
 * GET  /api/computers                 list with online / paused / in-use
 * POST /api/computers/pause           { computer, paused } kill switch for one computer
 * GET  /api/computers/audit?limit=N   the relay's audit log (no contents, no secrets)
 */
const { readAuditTail } = require('./nodes.cjs');

const ROUTE = /^\/api\/computers(?:\/(pause|audit))?$/;

function isComputersRoute(pathname) {
  return ROUTE.test(String(pathname || ''));
}

/** True when the request is from the person (see the header). */
async function personAllowed({ req, session, peerIsSelf, normalizeIp }) {
  if (!session || session.keyed || session.sample) return false;
  if (req.accessListener) return Boolean(session.access);
  if (await peerIsSelf(normalizeIp(req.socket.remoteAddress))) return false;
  return true;
}

/**
 * Returns true when it answered. extra.routes lets stage 2 add more
 * routes (terminal) behind the same person check.
 */
async function handleComputersApi({ req, res, url, session, relay, send, readBody, mutationOk, peerIsSelf, normalizeIp, log = () => {}, extra = null }) {
  const extraRoute = extra && typeof extra.matches === 'function' && extra.matches(url.pathname);
  if (!isComputersRoute(url.pathname) && !extraRoute) return false;
  if (!relay) { send(res, 404, { error: 'intelio computers are not enabled on this server.' }); return true; }
  if (!(await personAllowed({ req, session, peerIsSelf, normalizeIp }))) {
    log('intelio-nodes human-api denied');
    send(res, 403, { error: 'Only the person signed in to the intelio app can do this.' });
    return true;
  }
  if (req.method === 'POST' && !mutationOk(req)) { send(res, 403, { error: 'Cross-origin request refused.' }); return true; }
  if (extraRoute) return extra.handle({ req, res, url, session, relay, send, readBody });
  const action = ROUTE.exec(url.pathname)[1] || '';
  if (!action && req.method === 'GET') {
    send(res, 200, { ok: true, computers: relay.hub.listComputers({ detail: true }) });
    return true;
  }
  if (action === 'pause' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 4096); } catch { send(res, 400, { error: 'Bad request.' }); return true; }
    try {
      const out = relay.hub.setPaused(String(body.computer || ''), body.paused !== false);
      send(res, 200, { ok: true, ...out });
    } catch (error) {
      send(res, 404, { error: String(error.message || error).slice(0, 300) });
    }
    return true;
  }
  if (action === 'audit' && req.method === 'GET') {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    send(res, 200, { ok: true, entries: relay.hub.auditFile ? readAuditTail(relay.hub.auditFile, limit) : [] });
    return true;
  }
  send(res, 405, { error: 'Not found.' });
  return true;
}

module.exports = { handleComputersApi, isComputersRoute, personAllowed };
