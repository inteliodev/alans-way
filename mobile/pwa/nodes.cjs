'use strict';
/**
 * intelio node registry and live-connection hub (VPS relay side).
 *
 * Registry: ~/.config/intelio/nodes.json (mode 600, atomic writes). Holds one
 * record per enrolled computer: id, name, os, arch, user, version, enrolled_at,
 * last_seen, revoked_at and a salted scrypt hash of the device secret. The
 * secret itself is shown to the node once, at enrollment, and never stored here.
 *
 * Hub: accepts node WebSockets (after server.cjs has done the human check),
 * runs the hello/welcome handshake, routes tool calls with a per-call
 * timeout, keeps an audit line per call (no file contents, no secrets) and
 * disconnects revoked devices. Stdlib only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { acceptWebSocket } = require('../../desktop/src/intelio/node/ws.cjs');
const protocol = require('../../desktop/src/intelio/node/protocol.cjs');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const HELLO_TIMEOUT_MS = 10000;

function configDir(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'intelio');
}

function defaultRegistryFile(env = process.env) {
  return String(env.INTELIO_NODES_FILE || '').trim() || path.join(configDir(env), 'nodes.json');
}

function hashSecret(secret, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifySecret(secret, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || !secret) return false;
  const [, N, r, p, salt, expected] = parts;
  let got;
  try {
    got = crypto.scryptSync(String(secret), Buffer.from(salt, 'base64'), SCRYPT.keylen, { N: Number(N), r: Number(r), p: Number(p) });
  } catch { return false; }
  const want = Buffer.from(expected, 'base64');
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

function writeAtomic(file, text, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fsImpl.writeFileSync(tmp, text, { mode: 0o600 });
  try { fsImpl.chmodSync(tmp, 0o600); } catch { /* Windows */ }
  fsImpl.renameSync(tmp, file);
}

function publicDevice(device) {
  if (!device) return null;
  const { secret_hash: _hash, ...rest } = device;
  return { ...rest };
}

function createNodeRegistry({ file = defaultRegistryFile(), now = () => Date.now() } = {}) {
  function load() {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      if (error && error.code === 'ENOENT') return { version: 1, devices: [] };
      throw new Error(`nodes registry unreadable: ${file}`);
    }
    if (!data || !Array.isArray(data.devices)) return { version: 1, devices: [] };
    return data;
  }
  function save(data) {
    writeAtomic(file, `${JSON.stringify({ version: 1, devices: data.devices }, null, 2)}\n`);
  }
  const iso = () => new Date(now()).toISOString();

  function resolveIn(data, ref, { includeRevoked = false } = {}) {
    const want = String(ref || '').trim().toLowerCase();
    if (!want) return { error: 'Name a computer (see list_computers).' };
    const pool = data.devices.filter((d) => includeRevoked || !d.revoked_at);
    const byId = pool.find((d) => d.id.toLowerCase() === want);
    if (byId) return { device: byId };
    const byName = pool.filter((d) => String(d.name).toLowerCase() === want);
    if (byName.length === 1) return { device: byName[0] };
    if (byName.length > 1) return { error: `More than one computer is named ${ref}: use an id (${byName.map((d) => d.id).join(', ')}).` };
    const known = pool.map((d) => d.name).join(', ') || 'none enrolled';
    return { error: `No computer named ${ref}. Known computers: ${known}.` };
  }

  return {
    file,
    load,
    list({ includeRevoked = false } = {}) {
      return load().devices.filter((d) => includeRevoked || !d.revoked_at).map(publicDevice);
    },
    get(id) {
      return publicDevice(load().devices.find((d) => d.id === id) || null);
    },
    resolve(ref, opts) {
      const hit = resolveIn(load(), ref, opts);
      return hit.device ? { device: publicDevice(hit.device) } : hit;
    },
    /** New device: returns the record and the secret, which is never stored. */
    enroll(hello, login = '') {
      const data = load();
      const id = `n_${crypto.randomBytes(8).toString('hex')}`;
      const secret = crypto.randomBytes(32).toString('hex');
      const device = {
        id,
        name: hello.name,
        os: hello.os || '',
        arch: hello.arch || '',
        user: hello.user || '',
        version: hello.version || '',
        enrolled_at: iso(),
        enrolled_by: String(login || '').slice(0, 200),
        last_seen: iso(),
        revoked_at: null,
        secret_hash: hashSecret(secret),
      };
      data.devices.push(device);
      save(data);
      return { device: publicDevice(device), secret };
    },
    authenticate(id, secret) {
      const device = load().devices.find((d) => d.id === id);
      if (!device) return { ok: false, code: 'unknown_device', reason: 'This computer is not enrolled on the VPS.' };
      if (device.revoked_at) return { ok: false, code: 'revoked', reason: 'This computer was revoked on the VPS.' };
      if (!verifySecret(secret, device.secret_hash)) return { ok: false, code: 'bad_secret', reason: 'Device secret did not match.' };
      return { ok: true, device: publicDevice(device) };
    },
    /** Record a hello: os/user/version always; the name unless the VPS pinned it with nodes-cli rename. */
    seen(id, hello = null) {
      const data = load();
      const device = data.devices.find((d) => d.id === id);
      if (!device) return null;
      device.last_seen = iso();
      if (hello) {
        for (const key of ['os', 'arch', 'user', 'version']) if (hello[key]) device[key] = hello[key];
        if (hello.name && !device.name_pinned) device.name = hello.name;
      }
      save(data);
      return publicDevice(device);
    },
    revoke(ref) {
      const data = load();
      const hit = resolveIn(data, ref);
      if (!hit.device) throw new Error(hit.error);
      hit.device.revoked_at = iso();
      save(data);
      return publicDevice(hit.device);
    },
    rename(ref, name) {
      const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
      if (!clean) throw new Error('Give a new name.');
      const data = load();
      const hit = resolveIn(data, ref);
      if (!hit.device) throw new Error(hit.error);
      hit.device.name = clean;
      hit.device.name_pinned = true;
      save(data);
      return publicDevice(hit.device);
    },
  };
}

function lastSeenLabel(device) {
  return device && device.last_seen ? `last seen ${device.last_seen}` : 'never seen';
}

function createNodeHub({
  registry,
  log = (line) => process.stderr.write(`${line}\n`),
  now = () => Date.now(),
  pingMs = protocol.PING_MS,
  staleMs = protocol.STALE_MS,
  helloTimeoutMs = HELLO_TIMEOUT_MS,
} = {}) {
  if (!registry) throw new Error('createNodeHub needs a registry.');
  const live = new Map(); // device id -> conn
  const pending = new Set(); // sockets before hello
  let seq = 0;
  let watching = false;

  function drop(conn, why) {
    if (live.get(conn.id) === conn) live.delete(conn.id);
    for (const [, call] of conn.calls) call.reject(new Error(`${conn.name} disconnected during the call${why ? ` (${why})` : ''}.`));
    conn.calls.clear();
    if (conn.id) { try { registry.seen(conn.id); } catch { /* registry unreadable */ } }
  }

  function attachConn(ws, device) {
    const conn = { id: device.id, name: device.name, ws, calls: new Map(), lastSeen: now(), device };
    const old = live.get(device.id);
    if (old) { try { old.ws.close(4000, 'replaced by a newer connection'); } catch { /* closed */ } drop(old, 'replaced'); }
    live.set(device.id, conn);
    ws.on('message', (text) => {
      conn.lastSeen = now();
      const msg = protocol.parseFrame(text);
      if (!msg) return;
      if (msg.type === 'ping') { try { ws.send(JSON.stringify(protocol.frames.pong(msg.t))); } catch { /* closed */ } return; }
      if (msg.type === 'pong') return;
      if (msg.type === 'result' && conn.calls.has(msg.id)) {
        const call = conn.calls.get(msg.id);
        conn.calls.delete(msg.id);
        call.resolve(msg);
      }
    });
    ws.on('pong', () => { conn.lastSeen = now(); });
    ws.on('ping', () => { conn.lastSeen = now(); });
    ws.on('close', () => drop(conn, ''));
    return conn;
  }

  /** server.cjs has already checked the human (Access JWT or tailnet login). */
  function accept(req, socket, head, human = {}) {
    const ws = acceptWebSocket(req, socket, head, { maxMessage: protocol.MAX_FRAME_BYTES });
    if (!ws) return null;
    pending.add(ws);
    const timer = setTimeout(() => { ws.close(4001, 'hello timeout'); }, helloTimeoutMs);
    const refuse = (reason, code) => {
      try { ws.send(JSON.stringify(protocol.frames.refused(reason, code))); } catch { /* closed */ }
      log(`intelio-nodes refused code=${code} login=${String(human.login || '').slice(0, 80)}`);
      ws.close(4003, code);
    };
    ws.once('close', () => { clearTimeout(timer); pending.delete(ws); });
    ws.once('message', (text) => {
      clearTimeout(timer);
      pending.delete(ws);
      const hello = protocol.normalizeHello(protocol.parseFrame(text));
      if (!hello) { refuse('First frame must be a hello with a name.', 'bad_hello'); return; }
      let device;
      let secret = '';
      try {
        if (hello.device_id) {
          const auth = registry.authenticate(hello.device_id, hello.device_secret);
          if (!auth.ok) { refuse(auth.reason, auth.code); return; }
          device = registry.seen(auth.device.id, hello) || auth.device;
        } else {
          const made = registry.enroll(hello, human.login);
          device = made.device;
          secret = made.secret;
          log(`intelio-nodes enrolled id=${device.id} name=${device.name} os=${device.os} login=${String(human.login || '').slice(0, 80)}`);
        }
      } catch (error) {
        refuse(String(error.message || 'Registry error.').slice(0, 200), 'registry');
        return;
      }
      if (ws.closed) return;
      attachConn(ws, device);
      ws.send(JSON.stringify(protocol.frames.welcome(device.id, secret)));
      log(`intelio-nodes online id=${device.id} name=${device.name}`);
    });
    return ws;
  }

  function offlineText(device) {
    return `${device.name} is offline (${lastSeenLabel(device)}).`;
  }

  function listComputers() {
    return registry.list().map((d) => ({
      name: d.name,
      id: d.id,
      os: d.os,
      user: d.user,
      online: live.has(d.id),
      last_seen: live.has(d.id) ? new Date(now()).toISOString() : d.last_seen,
      version: d.version,
    }));
  }

  /** Returns { content, isError } — MCP tool result shape. Never throws. */
  async function call(ref, tool, args = {}, { timeoutMs } = {}) {
    const started = now();
    const audit = (computer, ok, bytes, note = '') => {
      log(`intelio-nodes call computer=${computer} tool=${tool} args=${JSON.stringify(protocol.summarizeArgs(tool, args, 'relay'))} ok=${ok} bytes=${bytes} ms=${now() - started}${note ? ` note=${note}` : ''}`);
    };
    const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
    if (!protocol.NODE_TOOLS.includes(tool)) return errorResult(`Unknown tool ${tool}.`);
    let found;
    try { found = registry.resolve(args && args.computer); } catch (error) { return errorResult(String(error.message)); }
    if (!found.device) { audit(String(args && args.computer || '').slice(0, 64), false, 0, 'unknown'); return errorResult(found.error); }
    const device = found.device;
    const conn = live.get(device.id);
    if (!conn || conn.ws.closed) { audit(device.name, false, 0, 'offline'); return errorResult(offlineText(device)); }
    const id = `c${++seq}`;
    const { computer: _computer, ...nodeArgs } = args || {};
    const wait = timeoutMs || protocol.callTimeoutMs(tool, nodeArgs);
    let timer;
    try {
      const msg = await new Promise((resolve, reject) => {
        conn.calls.set(id, { resolve, reject });
        timer = setTimeout(() => {
          conn.calls.delete(id);
          reject(new Error(`${device.name} did not answer ${tool} within ${Math.round(wait / 1000)} s.`));
        }, wait);
        try { conn.ws.send(JSON.stringify(protocol.frames.call(id, tool, nodeArgs))); } catch (error) { conn.calls.delete(id); reject(error); }
      });
      if (msg.ok) {
        const content = Array.isArray(msg.content) ? msg.content : [];
        audit(device.name, true, protocol.contentSize(content));
        return { content, isError: false };
      }
      audit(device.name, false, 0);
      return errorResult(String(msg.error || 'The computer reported an error.'));
    } catch (error) {
      audit(device.name, false, 0, 'error');
      return errorResult(String(error.message || error));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Disconnect live devices that were revoked or removed (nodes-cli writes the registry). */
  function recheck() {
    let devices;
    try { devices = registry.load().devices; } catch { return; }
    for (const conn of [...live.values()]) {
      const record = devices.find((d) => d.id === conn.id);
      if (!record || record.revoked_at) {
        try { conn.ws.send(JSON.stringify(protocol.frames.refused('This computer was revoked on the VPS.', 'revoked'))); } catch { /* closed */ }
        try { conn.ws.close(4003, 'revoked'); } catch { /* closed */ }
        drop(conn, 'revoked');
        log(`intelio-nodes revoked-disconnect id=${conn.id}`);
      } else {
        conn.name = record.name;
      }
    }
  }

  const ticker = setInterval(() => {
    const t = now();
    for (const conn of [...live.values()]) {
      if (t - conn.lastSeen > staleMs) {
        log(`intelio-nodes stale id=${conn.id}`);
        conn.ws.terminate();
        drop(conn, 'no ping');
        continue;
      }
      try { conn.ws.send(JSON.stringify(protocol.frames.ping())); } catch { /* closed */ }
    }
  }, pingMs);
  ticker.unref?.();

  function onRegistryChange() { recheck(); }
  function watch() {
    if (watching) return;
    watching = true;
    fs.watchFile(registry.file, { interval: 1000, persistent: false }, onRegistryChange);
  }

  function close() {
    clearInterval(ticker);
    if (watching) fs.unwatchFile(registry.file, onRegistryChange);
    watching = false;
    for (const ws of [...pending]) ws.terminate();
    for (const conn of [...live.values()]) { try { conn.ws.close(1001, 'relay stopping'); } catch { /* closed */ } drop(conn, 'relay stopping'); }
  }

  return { accept, call, listComputers, recheck, watch, close, live, registry };
}

module.exports = {
  configDir,
  defaultRegistryFile,
  hashSecret,
  verifySecret,
  writeAtomic,
  createNodeRegistry,
  createNodeHub,
};
