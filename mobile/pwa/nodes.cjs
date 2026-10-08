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
const policy = require('../../desktop/src/intelio/node/policy.cjs');

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
    writeAtomic(file, `${JSON.stringify({ version: 1, devices: data.devices, ...(data.local && Object.keys(data.local).length ? { local: data.local } : {}) }, null, 2)}\n`);
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
    /** Kill-switch state of a built-in computer (the VPS itself), kept next to the devices. */
    localState(id) {
      const data = load();
      return { ...((data.local && data.local[id]) || {}) };
    },
    setLocalPaused(id, paused) {
      const data = load();
      data.local = data.local && typeof data.local === 'object' ? data.local : {};
      data.local[id] = { ...(data.local[id] || {}), paused_at: paused ? iso() : null };
      save(data);
      return { ...data.local[id] };
    },
    /** Relay-side kill switch: a paused computer stays connected but every agent call is refused. */
    setPaused(ref, paused) {
      const data = load();
      const hit = resolveIn(data, ref);
      if (!hit.device) throw new Error(hit.error);
      hit.device.paused_at = paused ? iso() : null;
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

function defaultAuditFile(env = process.env) {
  return String(env.INTELIO_NODES_AUDIT_FILE || '').trim() || path.join(configDir(env), 'nodes-audit.jsonl');
}

const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;

/** Relay audit: one JSON line per agent call (computer, tool, argument summary, result size). No contents, no secrets. */
function createRelayAudit(file) {
  if (!file) return () => {};
  return function append(entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try { if (fs.statSync(file).size > AUDIT_ROTATE_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* new file */ }
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* auditing never breaks a call */ }
  };
}

/** The last n audit entries, newest last. Reads at most the final 2 MB. */
function readAuditTail(file, n = 200) {
  let text = '';
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 2 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const rows = [];
  for (const line of text.split('\n').slice(-(n + 1))) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* partial first line */ }
  }
  return rows.slice(-n);
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
  auditFile = '',
  locals = [],
  // Activity hook: called with { kind: 'push_approval', computer, tool, pushes, outcome, time }.
  // server.cjs points it at desktop/src/intelio/activity-log.cjs appendActivity once that lands (PR #32).
  onActivity = null,
} = {}) {
  if (!registry) throw new Error('createNodeHub needs a registry.');
  const appendAudit = createRelayAudit(auditFile);
  const busy = new Map(); // device id -> { count, tool, since }
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

  /** Built-in computers (the VPS itself) first, then enrolled ones. */
  function localDevices() {
    return locals.map((l) => {
      let state = {};
      try { state = registry.localState(l.device.id); } catch { state = {}; }
      return { ...l.device, local: true, paused_at: state.paused_at || null, last_seen: new Date(now()).toISOString() };
    });
  }
  function resolveRef(ref) {
    const want = String(ref || '').trim().toLowerCase();
    if (want) {
      for (const d of localDevices()) {
        const names = [d.id, d.name, ...(d.aliases || [])].map((x) => String(x || '').toLowerCase());
        if (names.includes(want)) return { device: d };
      }
    }
    const hit = registry.resolve(ref);
    if (!hit.device && want && locals.length) {
      return { error: `${hit.error.replace(/\.$/, '')}. Built in: ${locals.map((l) => l.device.name).join(', ')}.` };
    }
    return hit;
  }

  function listComputers({ detail = false } = {}) {
    const builtIn = localDevices().map((d) => ({
      name: d.name,
      id: d.id,
      os: d.os,
      user: d.user,
      online: true,
      last_seen: d.last_seen,
      version: d.version,
      kind: 'cloud',
      note: d.note,
      ...(d.paused_at ? { paused: true } : {}),
      ...(detail ? { in_use: busy.has(d.id), current_tool: busy.get(d.id)?.tool || '' } : {}),
    }));
    return builtIn.concat(registry.list().map((d) => ({
      name: d.name,
      id: d.id,
      os: d.os,
      user: d.user,
      online: live.has(d.id),
      last_seen: live.has(d.id) ? new Date(now()).toISOString() : d.last_seen,
      version: d.version,
      ...(d.paused_at ? { paused: true } : {}),
      ...(detail ? { in_use: busy.has(d.id), current_tool: busy.get(d.id)?.tool || '', enrolled_at: d.enrolled_at } : {}),
    })));
  }

  /** Kill switch for one computer (enrolled or built-in). */
  function setPaused(ref, paused) {
    const hit = resolveRef(ref);
    if (!hit.device) throw new Error(hit.error);
    if (hit.device.local) registry.setLocalPaused(hit.device.id, paused);
    else registry.setPaused(hit.device.id, paused);
    log(`intelio-nodes ${paused ? 'paused' : 'resumed'} id=${hit.device.id} name=${hit.device.name}`);
    appendAudit({ time: new Date(now()).toISOString(), computer: hit.device.name, tool: paused ? 'kill_switch_off' : 'kill_switch_on', ok: true, by: 'person' });
    return { id: hit.device.id, name: hit.device.name, paused: Boolean(paused) };
  }

  function markBusy(id, tool) {
    const row = busy.get(id) || { count: 0, tool: '', since: now() };
    row.count += 1;
    row.tool = tool;
    busy.set(id, row);
    return () => { const r = busy.get(id); if (!r) return; r.count -= 1; if (r.count <= 0) busy.delete(id); };
  }

  const PUSH_TEXT = {
    unavailable: (what) => `Refused: this pushes (${what}). A push needs Hayden's approval, and this connection cannot ask him. Ask him in chat; he can run it himself.`,
    decline: (what) => `Hayden did not allow this push (${what}). Do not try it another way; tell him what you wanted to push and why.`,
    cancel: (what) => `Nobody answered the push approval in time (${what}), so nothing was pushed. Ask Hayden in chat first, then try once more when he is there.`,
  };

  /**
   * A push asks Hayden first (his rule: "anything push is an approval").
   * `approve({ title, message, computer, pushes })` comes from the MCP layer
   * (elicitation through Hermes) and resolves 'accept' | 'decline' | 'cancel'.
   * No approve function, an error, or anything but 'accept' refuses.
   */
  async function askPush(device, tool, args, pushes, approve) {
    const what = [...new Set(pushes)].join(', ');
    const text = policy.commandTextFor(tool, args).trim();
    const where = tool === 'send_input' ? `typed into terminal session ${String(args.session_id || '').slice(0, 40)}` : `in ${String(args.cwd || '~').slice(0, 200)}`;
    const message = `${device.name} wants to push: ${what}\n\n${text.length > 600 ? `${text.slice(0, 600)}…` : text}\n\n${where}`;
    let answer = 'unavailable';
    if (typeof approve === 'function') {
      try { answer = String(await approve({ title: 'Allow this push?', message, computer: device.name, pushes })); } catch { answer = 'cancel'; }
    }
    const outcome = answer === 'accept' ? 'allowed' : answer === 'decline' ? 'declined' : answer === 'unavailable' ? 'unavailable' : 'unanswered';
    const time = new Date(now()).toISOString();
    log(`intelio-nodes push-approval computer=${device.name} tool=${tool} pushes=${JSON.stringify(pushes)} outcome=${outcome}`);
    appendAudit({ time, computer: device.name, tool: 'push_approval', args: { for: tool, pushes }, ok: outcome === 'allowed', note: outcome, by: answer === 'accept' || answer === 'decline' ? 'person' : 'relay' });
    if (typeof onActivity === 'function') { try { onActivity({ kind: 'push_approval', time, computer: device.name, tool, pushes, outcome }); } catch { /* hook */ } }
    if (answer === 'accept') return { allowed: true, stamp: { id: crypto.randomBytes(12).toString('hex'), at: time } };
    const key = answer === 'decline' ? 'decline' : answer === 'unavailable' ? 'unavailable' : 'cancel';
    return { allowed: false, text: PUSH_TEXT[key](what) };
  }

  /** Returns { content, isError } — MCP tool result shape. Never throws. */
  async function call(ref, tool, args = {}, { timeoutMs, approve } = {}) {
    const started = now();
    const audit = (computer, ok, bytes, note = '') => {
      const summary = protocol.summarizeArgs(tool, args, 'relay');
      log(`intelio-nodes call computer=${computer} tool=${tool} args=${JSON.stringify(summary)} ok=${ok} bytes=${bytes} ms=${now() - started}${note ? ` note=${note}` : ''}`);
      appendAudit({ time: new Date(started).toISOString(), computer, tool, args: summary, ok, result_bytes: bytes, ms: now() - started, ...(note ? { note } : {}) });
    };
    const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });
    if (!protocol.NODE_TOOLS.includes(tool)) return errorResult(`Unknown tool ${tool}.`);
    // push_approval is the relay's own stamp: never taken from the agent.
    const { computer: _computer, push_approval: _forged, ...nodeArgs } = args || {};
    let device;
    const ready = () => {
      let found;
      try { found = resolveRef(args && args.computer); } catch (error) { return errorResult(String(error.message)); }
      if (!found.device) { audit(String(args && args.computer || '').slice(0, 64), false, 0, 'unknown'); return errorResult(found.error); }
      device = found.device;
      if (device.paused_at) {
        audit(device.name, false, 0, 'paused');
        return errorResult(`${device.name} is turned off for agents in the intelio app (its kill switch). Tell the person; do not retry until they turn it back on.`);
      }
      if (!device.local) {
        const conn = live.get(device.id);
        if (!conn || conn.ws.closed) { audit(device.name, false, 0, 'offline'); return errorResult(offlineText(device)); }
      }
      return null;
    };
    const notReady = ready();
    if (notReady) return notReady;
    const pushes = policy.findPushes(policy.commandTextFor(tool, nodeArgs));
    if (pushes.length) {
      const decision = await askPush(device, tool, nodeArgs, pushes, approve);
      if (!decision.allowed) { audit(device.name, false, 0, 'push_not_allowed'); return errorResult(decision.text); }
      // The wait can be minutes: the kill switch or the connection may have changed.
      const changed = ready();
      if (changed) return changed;
      nodeArgs.push_approval = decision.stamp;
    }
    if (device.local) {
      const local = locals.find((l) => l.device.id === device.id);
      const done = markBusy(device.id, tool);
      try {
        const out = await local.run(tool, nodeArgs);
        if (out.ok) { const content = Array.isArray(out.content) ? out.content : []; audit(device.name, true, protocol.contentSize(content)); return { content, isError: false }; }
        audit(device.name, false, 0);
        return errorResult(String(out.error || 'The computer reported an error.'));
      } catch (error) {
        audit(device.name, false, 0, 'error');
        return errorResult(String(error && error.message || error));
      } finally { done(); }
    }
    const conn = live.get(device.id);
    const id = `c${++seq}`;
    const wait = timeoutMs || protocol.callTimeoutMs(tool, nodeArgs);
    let timer;
    const done = markBusy(device.id, tool);
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
      done();
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

  function close2() { for (const l of locals) { try { l.close?.(); } catch { /* closing */ } } }
  return { accept, call, listComputers, setPaused, resolveRef, recheck, watch, close: () => { close(); close2(); }, live, registry, busy, auditFile, locals };
}

module.exports = {
  configDir,
  defaultRegistryFile,
  defaultAuditFile,
  createRelayAudit,
  readAuditTail,
  hashSecret,
  verifySecret,
  writeAtomic,
  createNodeRegistry,
  createNodeHub,
};
