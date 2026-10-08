'use strict';
/**
 * intelio node client: dials OUT to the VPS relay, enrolls once, then answers
 * tool calls with the local executors. No listening ports on this computer.
 *
 * Electron-free so tests run it under plain Node; desktop/src/intelio/node/main.cjs
 * injects the target (cloud cookie / tailnet URL), identity storage (safeStorage),
 * executors and the audit path.
 *
 * States: off, waiting (no sign-in / no host yet), connecting, online,
 * retrying, revoked, error.
 */
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol.cjs');
const { connectWebSocket } = require('./ws.cjs');

const HELLO_TIMEOUT_MS = 15000;
const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;

/** 2 s doubling to 60 s, with up to 20% downward jitter (never below 2 s). */
function backoffDelay(attempt, { min = protocol.BACKOFF_MIN_MS, max = protocol.BACKOFF_MAX_MS, random = Math.random } = {}) {
  const base = Math.min(max, min * 2 ** Math.max(0, attempt));
  return Math.max(min, Math.round(base * (1 - 0.2 * random())));
}

function createAuditLog(file, { fsImpl = fs } = {}) {
  return function audit(entry) {
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      try { if (fsImpl.statSync(file).size > AUDIT_ROTATE_BYTES) fsImpl.renameSync(file, `${file}.1`); } catch { /* new file */ }
      fsImpl.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* auditing must never break a call */ }
  };
}

/**
 * @param {object} o
 * @param {() => Promise<null|{urls: string[], headers?: object, mode?: string}>} o.getTarget
 * @param {() => object} o.getInfo  hello fields: name, os, arch, user, version
 * @param {{ load(): object|null, save(identity): void, clear(): void, available(): boolean }} o.identity
 * @param {{ run(tool, args, ctx): Promise<object> }} o.executors
 */
function createNodeClient({
  getTarget,
  getInfo,
  identity,
  executors,
  audit = () => {},
  log = () => {},
  connect = connectWebSocket,
  onState = () => {},
  now = () => Date.now(),
  pingMs = protocol.PING_MS,
  staleMs = protocol.STALE_MS,
  backoff = backoffDelay,
  helloTimeoutMs = HELLO_TIMEOUT_MS,
} = {}) {
  let enabled = false;
  let running = false;
  let ws = null;
  let attempt = 0;
  let wake = null;
  let sleepTimer = null;
  let state = { status: 'off', detail: '', device_id: '', since: now() };
  const inflight = new Map();

  function setState(status, detail = '') {
    const id = (() => { try { return identity.load()?.device_id || ''; } catch { return ''; } })();
    state = { status, detail: String(detail || ''), device_id: id, since: now() };
    try { onState({ ...state }); } catch { /* listener */ }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      wake = () => { clearTimeout(sleepTimer); wake = null; resolve(); };
      sleepTimer = setTimeout(() => { wake = null; resolve(); }, ms);
      sleepTimer.unref?.();
    });
  }

  function abortCalls(reason) {
    for (const [, call] of inflight) call.controller.abort(reason);
    inflight.clear();
  }

  /** Terminal sessions die with access: kill switch off, revoke, app quit (docs/intelio-node.md). */
  function closeSessions(reason) {
    let n = 0;
    try { n = typeof executors.closeSessions === 'function' ? executors.closeSessions() : 0; } catch { n = 0; }
    if (n) {
      log(`intelio node: stopped ${n} terminal session(s): ${reason}`);
      audit({ time: new Date(now()).toISOString(), tool: 'stop_session', args: { all: true, reason: String(reason).slice(0, 60) }, ok: true, result_bytes: 0, ms: 0 });
    }
  }

  async function handleCall(conn, msg) {
    const id = String(msg.id || '');
    const tool = String(msg.tool || '');
    const args = msg.args && typeof msg.args === 'object' ? msg.args : {};
    const started = now();
    const controller = new AbortController();
    inflight.set(id, { controller });
    let result;
    if (!enabled) result = { ok: false, error: 'intelio access is turned off on this computer.', meta: {} };
    else {
      try { result = await executors.run(tool, args, { signal: controller.signal }); } catch (error) {
        result = { ok: false, error: String(error && error.message || error), meta: {} };
      }
    }
    inflight.delete(id);
    const bytes = result.ok ? protocol.contentSize(result.content) : 0;
    audit({
      time: new Date(started).toISOString(),
      tool,
      args: protocol.summarizeArgs(tool, args, 'node'),
      ok: Boolean(result.ok),
      result_bytes: bytes,
      ...(result.meta && result.meta.exit_code !== undefined ? { exit_code: result.meta.exit_code } : {}),
      ...(result.ok ? {} : { error: String(result.error || '').slice(0, 200) }),
      ms: now() - started,
    });
    if (conn.closed) return;
    try {
      conn.send(JSON.stringify(result.ok ? protocol.frames.ok(id, result.content) : protocol.frames.fail(id, result.error)));
    } catch { /* connection went away; the relay times the call out */ }
  }

  /** One connection attempt through to close. Returns 'revoked' | 'reset' | 'closed' | 'unauthorized' | 'no-target' | 'error'. */
  async function session() {
    let target;
    try { target = await getTarget(); } catch { target = null; }
    if (!target || !Array.isArray(target.urls) || !target.urls.length) return 'no-target';
    if (!identity.available()) { setState('error', 'This computer cannot encrypt the device secret (OS keychain unavailable), so it was not enrolled.'); return 'error'; }
    setState('connecting', target.mode || '');
    let conn = null;
    let lastError = null;
    for (const url of target.urls) {
      try { conn = await connect(url, { headers: target.headers || {}, maxMessage: protocol.MAX_FRAME_BYTES }); break; } catch (error) { lastError = error; }
    }
    if (!conn) {
      if (lastError && (lastError.status === 401 || lastError.status === 403 || (lastError.status >= 300 && lastError.status < 400))) return 'unauthorized';
      log(`intelio node: connect failed: ${String(lastError && lastError.message || lastError).slice(0, 200)}`);
      return 'error';
    }
    if (!enabled) { conn.close(1000, 'disabled'); return 'closed'; }
    ws = conn;
    const saved = identity.load();
    return new Promise((resolve) => {
      let welcomed = false;
      let outcome = 'closed';
      let lastFrame = now();
      const helloTimer = setTimeout(() => { if (!welcomed) { outcome = 'error'; conn.close(4001, 'no welcome'); } }, helloTimeoutMs);
      const pinger = setInterval(() => {
        if (now() - lastFrame > staleMs) { log('intelio node: relay silent, reconnecting'); conn.terminate(); return; }
        conn.ping();
      }, pingMs);
      pinger.unref?.();
      conn.on('pong', () => { lastFrame = now(); });
      conn.on('ping', () => { lastFrame = now(); });
      conn.on('error', () => {});
      conn.on('message', (text) => {
        lastFrame = now();
        const msg = protocol.parseFrame(text);
        if (!msg) return;
        if (msg.type === 'welcome' && !welcomed) {
          welcomed = true;
          clearTimeout(helloTimer);
          if (msg.device_secret) {
            try { identity.save({ device_id: String(msg.device_id), device_secret: String(msg.device_secret) }); } catch (error) {
              log(`intelio node: could not store the device secret: ${error.message}`);
              conn.close(1000, 'cannot store secret');
              outcome = 'error';
              return;
            }
          }
          attempt = 0;
          setState('online', target.mode || '');
          return;
        }
        if (msg.type === 'refused') {
          const code = String(msg.code || '');
          if (code === 'revoked') outcome = 'revoked';
          else if (code === 'unknown_device' || code === 'bad_secret') { try { identity.clear(); } catch { /* ignore */ } outcome = 'reset'; }
          else outcome = 'error';
          setState(outcome === 'revoked' ? 'revoked' : 'retrying', String(msg.reason || code));
          return;
        }
        if (msg.type === 'ping') { try { conn.send(JSON.stringify(protocol.frames.pong(msg.t))); } catch { /* closed */ } return; }
        if (msg.type === 'call' && welcomed) { handleCall(conn, msg); }
      });
      conn.on('close', () => {
        clearTimeout(helloTimer);
        clearInterval(pinger);
        abortCalls('disconnected');
        if (ws === conn) ws = null;
        resolve(outcome);
      });
      try {
        const info = getInfo();
        conn.send(JSON.stringify(protocol.frames.hello(info, saved)));
      } catch { conn.terminate(); }
    });
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      while (enabled) {
        const outcome = await session();
        if (!enabled) break;
        if (outcome === 'revoked') { log('intelio node: this computer was revoked on the VPS'); closeSessions('revoked'); break; }
        if (outcome === 'reset') { attempt = 0; continue; }
        if (outcome === 'no-target') setState('waiting', 'Sign in to intelio cloud or set the Tailscale host to connect this computer.');
        else if (outcome === 'unauthorized') setState('waiting', 'intelio cloud sign-in is needed (or this Tailscale login is not allowed).');
        else if (state.status !== 'error') setState('retrying', outcome === 'closed' ? 'Disconnected; reconnecting.' : 'Could not reach the VPS; retrying.');
        const delay = backoff(attempt);
        attempt += 1;
        await sleep(delay);
      }
    } finally {
      running = false;
      if (!enabled) setState('off', '');
    }
  }

  return {
    start() {
      if (enabled) return;
      enabled = true;
      attempt = 0;
      loop();
    },
    stop(reason = 'turned off') {
      enabled = false;
      abortCalls(reason);
      closeSessions(reason);
      if (ws) { try { ws.close(1000, reason); } catch { /* closed */ } }
      if (wake) wake();
      setState('off', '');
    },
    /** Sign-in finished or settings changed: retry now instead of waiting out the backoff. */
    kick() {
      attempt = 0;
      if (state.status === 'revoked') return;
      if (wake) wake();
      else if (enabled && !running) loop();
    },
    /** Reconnect (e.g. after a rename) so the relay gets a fresh hello. */
    reconnect() {
      attempt = 0;
      if (ws) { try { ws.close(1000, 'reconnect'); } catch { /* closed */ } } else if (wake) wake();
    },
    forgetIdentity() { try { identity.clear(); } catch { /* ignore */ } },
    state: () => ({ ...state, enabled }),
    get connection() { return ws; },
  };
}

module.exports = { createNodeClient, createAuditLog, backoffDelay, HELLO_TIMEOUT_MS };
