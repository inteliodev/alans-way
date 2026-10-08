'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bridge = require('../../mobile/phone/bridge.cjs');

const BASE = 'https://2-24-110-12.sslip.io/twilio';
const TOKEN = 'test-token-12345';
const KEY = 'profile-key-0123456789';

function env(extra = {}) {
  return {
    TWILIO_ACCOUNT_SID: 'ACexampleexampleexampleexample',
    TWILIO_AUTH_TOKEN: TOKEN,
    PHONE_PUBLIC_BASE: BASE,
    PHONE_ALLOWED_CALLERS: '+19188991650',
    PHONE_NUMBER_PROFILES: '+19185550100=intelio,+19185550101=prc,+19185550102=alignment,+19185550103=hhp',
    PHONE_BRIDGE_PORT: '0',
    INTELIO_HERMES_URL: 'http://127.0.0.1:9',
    ...extra,
  };
}

function timers() {
  const items = [];
  return {
    items,
    set(fn) { const item = { fn, cleared: false }; items.push(item); return item; },
    clear(id) { if (id) id.cleared = true; },
    fire() { for (const item of items) if (!item.cleared) item.fn(); },
  };
}

function jsonResponse(status, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : '') },
    text: async () => text,
  };
}

function sseResponse(chunks, { hang = false } = {}) {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = () => {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      };
      if (hang) release(send);
      else send();
    },
  });
  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      body: stream,
      text: async () => '',
    },
    ready,
  };
}

function mockHermes(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), method: init.method, headers: init.headers, body: String(init.body || ''), signal: init.signal };
    calls.push(call);
    const hit = routes(call);
    if (!hit) throw new Error('unexpected hermes call');
    return hit;
  };
  return { calls, fetchImpl };
}

async function withBridge(options, fn) {
  const logs = [];
  const clock = options.timers || timers();
  const bridgeServer = bridge.createBridge({
    env: options.env || env(),
    fetchImpl: options.fetchImpl,
    readKey: async () => KEY,
    log: (line) => logs.push(line),
    timers: clock,
    limits: options.limits,
  });
  const address = await bridgeServer.listen();
  try {
    await fn({ port: address.port, logs, timers: clock, server: bridgeServer });
  } finally {
    bridgeServer.server.closeAllConnections?.();
    await new Promise((resolve) => {
      bridgeServer.server.close(() => resolve());
      setTimeout(resolve, 50);
    });
  }
}

function post(port, pathname, fields, signature, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        host: 'evil.example',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'x-twilio-signature': signature,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function clientFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const head = payload.length < 126 ? Buffer.alloc(6) : Buffer.alloc(8);
  head[0] = 0x81;
  if (payload.length < 126) {
    head[1] = 0x80 | payload.length;
    mask.copy(head, 2);
  } else {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
    mask.copy(head, 4);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, masked]);
}

function connectRelay(port, signature) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const key = crypto.randomBytes(16).toString('base64');
    const messages = [];
    let buf = Buffer.alloc(0);
    let headerDone = false;
    const fail = (error) => { socket.destroy(); reject(error); };
    const pump = () => {
      if (!headerDone) {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const head = buf.slice(0, sep).toString('utf8');
        buf = buf.slice(sep + 4);
        headerDone = true;
        if (!head.startsWith('HTTP/1.1 101')) return fail(new Error(head.split('\r\n')[0] || 'upgrade failed'));
        resolve({
          messages,
          send(obj) { socket.write(clientFrame(JSON.stringify(obj))); },
          closeFrame(code) {
            const mask = crypto.randomBytes(4);
            const payload = Buffer.alloc(2);
            payload.writeUInt16BE(code, 0);
            const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
            socket.write(Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, masked]));
          },
          close() { socket.destroy(); },
        });
      }
      while (buf.length >= 2) {
        let length = buf[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buf.length < 4) return;
          length = buf.readUInt16BE(2);
          offset = 4;
        }
        if (buf.length < offset + length) return;
        const opcode = buf[0] & 0x0f;
        const payload = buf.slice(offset, offset + length).toString('utf8');
        buf = buf.slice(offset + length);
        if (opcode === 0x1) {
          try { messages.push(JSON.parse(payload)); } catch { messages.push(payload); }
        }
      }
    };
    socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); try { pump(); } catch (error) { fail(error); } });
    socket.on('error', (error) => { if (!headerDone) fail(error); });
    socket.on('connect', () => {
      socket.write([
        'GET /twilio/relay HTTP/1.1',
        'Host: evil.example',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `X-Twilio-Signature: ${signature}`,
        '',
        '',
      ].join('\r\n'));
    });
  });
}

async function waitFor(list, pred, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const index = list.findIndex(pred);
    if (index !== -1) return list[index];
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('timed out waiting for a relay message');
}

test('signature matches the published Twilio vector and drops duplicate values', () => {
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675309',
    Digits: '1234',
    From: '+14158675309',
    To: '+18005551212',
  };
  assert.equal(bridge.computeSignature('12345', url, params), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=');
  const repeated = new Map([['Digits', ['1234', '1234', '5678']], ['Sid', ['CA123']], ['SidAccount', ['AC123']]]);
  assert.equal(bridge.computeSignature('12345', url, repeated), 'IK+Dwps556ElfBT0I3Rgjkr1wJU=');
  assert.equal(bridge.signaturesMatch('RSOYDt4T1cUTdK1PDd93/VVr8B8=', 'RSOYDt4T1cUTdK1PDd93/VVr8B8='), true);
  assert.equal(bridge.signaturesMatch('RSOYDt4T1cUTdK1PDd93/VVr8B8=', 'not-the-signature'), false);
});

test('config rejects a public Hermes host and does not echo the token', () => {
  assert.throws(() => bridge.loadConfig(env({ INTELIO_HERMES_URL: 'https://example.com' })), /INTELIO_HERMES_URL/);
  assert.throws(() => bridge.loadConfig(env({ TWILIO_AUTH_TOKEN: '' })), (error) => {
    assert.match(error.message, /TWILIO_AUTH_TOKEN/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
  const profiles = bridge.parseNumberMap('+19185550100=intelio,+19185550101=prc,+19185550102=alignment,+19185550103=hhp');
  assert.deepEqual([...profiles.values()], ['intelio', 'prc', 'alignment', 'hhp']);
  assert.equal(bridge.callerAllowed(['+19188991650'], '+1 (918) 899-1650'), true);
  assert.equal(bridge.callerAllowed(['+19188991650'], '+15550001111'), false);
  assert.equal(bridge.maskNumber('call from +19188991650'), 'call from +*****1650');
  assert.equal(bridge.relayUrl(BASE), 'wss://2-24-110-12.sslip.io/twilio/relay');
});

test('sms is forwarded only with a valid signature for the public base', async () => {
  const hermes = mockHermes((call) => {
    assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
    assert.match(call.url, /\/p\/prc\/webhooks\/twilio$/);
    return jsonResponse(200, '<Response></Response>', 'text/xml');
  });
  await withBridge({ fetchImpl: hermes.fetchImpl }, async ({ port, logs }) => {
    const fields = { From: '+19188991650', To: '+19185550101', Body: 'hello there' };
    const bad = await post(port, '/twilio/sms', fields, bridge.computeSignature(TOKEN, 'https://evil.example/twilio/sms', fields));
    assert.equal(bad.status, 403);
    assert.equal(hermes.calls.length, 0);
    const good = await post(port, '/twilio/sms', fields, bridge.computeSignature(TOKEN, `${BASE}/sms`, fields));
    assert.equal(good.status, 200);
    assert.equal(good.body, '<Response></Response>');
    assert.equal(hermes.calls.length, 1);
    assert.equal(hermes.calls[0].headers['X-Twilio-Signature'], bridge.computeSignature(TOKEN, `${BASE}/sms`, fields));
    assert.equal(hermes.calls[0].body, new URLSearchParams(fields).toString());
    assert.equal(logs.some((line) => line.includes(TOKEN) || line.includes(KEY) || line.includes('hello there') || line.includes('+19188991650')), false);
  });
});

test('voice allowlist, profile routing, and one-use relay nonce', async () => {
  const hermes = mockHermes(() => { throw new Error('hermes should stay idle'); });
  await withBridge({ fetchImpl: hermes.fetchImpl }, async ({ port, logs }) => {
    const denied = { CallSid: 'CA111', From: '+15550001111', To: '+19185550100' };
    const deniedRes = await post(port, '/twilio/voice', denied, bridge.computeSignature(TOKEN, `${BASE}/voice`, denied));
    assert.equal(deniedRes.status, 200);
    assert.match(deniedRes.body, /<Reject reason="rejected"\/>/);
    assert.equal(deniedRes.body.includes('ConversationRelay'), false);

    const allowed = { CallSid: 'CA222', From: '+19188991650', To: '+19185550102' };
    const evil = await post(port, '/twilio/voice', allowed, bridge.computeSignature(TOKEN, 'https://evil.example/twilio/voice', allowed));
    assert.equal(evil.status, 403);
    const ok = await post(port, '/twilio/voice', allowed, bridge.computeSignature(TOKEN, `${BASE}/voice`, allowed));
    assert.equal(ok.status, 200);
    assert.match(ok.body, /<ConversationRelay url="wss:\/\/2-24-110-12\.sslip\.io\/twilio\/relay"/);
    const nonce = ok.body.match(/name="nonce" value="([^"]+)"/)[1];
    assert.equal(nonce.length > 8, true);
    assert.equal(hermes.calls.length, 0);
    assert.equal(logs.some((line) => line.includes('profile alignment') && line.includes('+*****1650') && !line.includes('+19188991650')), true);

    const unknown = { CallSid: 'CA333', From: '+19188991650', To: '+15559990000' };
    const missing = await post(port, '/twilio/voice', unknown, bridge.computeSignature(TOKEN, `${BASE}/voice`, unknown));
    assert.equal(missing.status, 404);
    await assert.rejects(() => connectRelay(port, 'bad-signature'));
    assert.equal(hermes.calls.length, 0);
  });
});

test('relay streams spoken sentences and stops on interrupt', async () => {
  let hold = null;
  const hermes = mockHermes((call) => {
    if (call.url.endsWith('/api/sessions')) return jsonResponse(200, { id: 'sess-1' });
    if (call.url.includes('/chat/stream')) {
      const input = JSON.parse(call.body).input;
      assert.equal(input.startsWith('spoken reply, no markdown\n\n'), true);
      assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
      assert.match(call.url, /\/p\/intelio\/api\/sessions\/sess-1\/chat\/stream$/);
      if (input.includes('hang')) {
        const hanging = sseResponse(['event: assistant.delta\ndata: {"delta":"This should not be spoken."}\n\n'], { hang: true });
        hold = hanging.ready;
        return hanging.response;
      }
      if (input.includes('wait')) {
        const hanging = sseResponse(['event: assistant.delta\ndata: {"delta":"Ready now."}\n\n'], { hang: true });
        hold = hanging.ready;
        return hanging.response;
      }
      if (input.includes('tool')) {
        return sseResponse(['event: tool.started\ndata: {}\n\nevent: assistant.delta\ndata: {"delta":"Noted. Next sentence."}\n\n']).response;
      }
      return sseResponse(['event: assistant.delta\ndata: {"delta":"Hello there. How are you?"}\n\n']).response;
    }
    return null;
  });
  async function takeHold() {
    const start = Date.now();
    while (!hold && Date.now() - start < 2000) await new Promise((resolve) => setTimeout(resolve, 15));
    if (!hold) throw new Error('stream did not start');
    const send = await hold;
    hold = null;
    return send;
  }
  await withBridge({ fetchImpl: hermes.fetchImpl }, async ({ port, logs, timers: clock }) => {
    const fields = { CallSid: 'CA777', From: '+1 (918) 899-1650', To: '+19185550100' };
    const voice = await post(port, '/twilio/voice', fields, bridge.computeSignature(TOKEN, `${BASE}/voice`, fields));
    const nonce = voice.body.match(/name="nonce" value="([^"]+)"/)[1];
    const replay = await connectRelay(port, bridge.computeSignature(TOKEN, bridge.relayUrl(BASE), {}));
    replay.send({ type: 'setup', callSid: 'CA777', from: '+19188991650', customParameters: { nonce: 'not-issued' } });
    const socket = await connectRelay(port, bridge.computeSignature(TOKEN, bridge.relayUrl(BASE), {}));
    socket.send({ type: 'setup', callSid: 'CA777', from: '+19188991650', customParameters: { nonce } });
    await waitFor(hermes.calls, (call) => call.url.endsWith('/api/sessions'));
    replay.send({ type: 'setup', callSid: 'CA777', from: '+19188991650', customParameters: { nonce } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(hermes.calls.filter((call) => call.url.endsWith('/api/sessions')).length, 1);
    socket.send({ type: 'prompt', voicePrompt: 'what time is it', last: false });
    socket.send({ type: 'prompt', voicePrompt: 'what time is it', last: true });
    const done = await waitFor(socket.messages, (message) => message.type === 'text' && message.last === true);
    const spoken = socket.messages.filter((message) => message.type === 'text').map((message) => message.token).join('');
    assert.match(spoken, /Hello there\./);
    assert.match(spoken, /How are you\?/);
    assert.equal(done.last, true);
    assert.equal(socket.messages.every((message) => message.interruptible === true), true);
    const stream = hermes.calls.find((call) => call.url.includes('/chat/stream'));
    assert.equal(JSON.parse(stream.body).input.includes('what time is it'), true);
    assert.equal(JSON.parse(hermes.calls.find((call) => call.url.endsWith('/api/sessions')).body).title, 'Phone call');

    socket.send({ type: 'prompt', voicePrompt: 'tool please', last: true });
    await waitFor(socket.messages, (message) => message.token === 'one sec');
    await waitFor(socket.messages, (message) => String(message.token || '').includes('Noted.'));

    socket.send({ type: 'prompt', voicePrompt: 'hang please', last: true });
    const releaseHang = await takeHold();
    socket.send({ type: 'interrupt' });
    await waitFor(logs, (line) => String(line).includes('relay interrupt'));
    const before = socket.messages.length;
    releaseHang();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(socket.messages.slice(before).some((message) => String(message.token || '').includes('should not be spoken')), false);

    const quiet = socket.messages.length;
    socket.send({ type: 'prompt', voicePrompt: 'wait please', last: true });
    const releaseWait = await takeHold();
    clock.fire();
    await waitFor(socket.messages, (message, index) => index >= quiet && message.token === 'one sec');
    releaseWait();
    assert.equal(logs.some((line) => line.includes(TOKEN) || line.includes(KEY) || line.includes('what time is it') || line.includes('+19188991650')), false);
    socket.close();
    replay.close();
  });
});

test('voice greets clearly, reports relay status, and logs relay closes without full numbers', async () => {
  const hermes = mockHermes((call) => {
    if (call.url.endsWith('/api/sessions')) return jsonResponse(200, { id: 'sess-9' });
    return null;
  });
  await withBridge({ fetchImpl: hermes.fetchImpl }, async ({ port, logs }) => {
    const fields = { CallSid: 'CA0000000000000000000000000000abcdef', From: '+19188991650', To: '+19185550100' };
    const voice = await post(port, '/twilio/voice', fields, bridge.computeSignature(TOKEN, `${BASE}/voice`, fields));
    assert.equal(voice.status, 200);
    assert.equal(bridge.GREETING, "Hi, it's intelio. What do you need?");
    assert.match(voice.body, /welcomeGreeting="Hi, it&apos;s intelio\. What do you need\?"/);
    assert.match(voice.body, /<Connect action="https:\/\/2-24-110-12\.sslip\.io\/twilio\/status" method="POST">/);
    const nonce = voice.body.match(/name="nonce" value="([^"]+)"/)[1];

    const socket = await connectRelay(port, bridge.computeSignature(TOKEN, bridge.relayUrl(BASE), {}));
    socket.send({ type: 'setup', callSid: fields.CallSid, from: '+19188991650', customParameters: { nonce } });
    await waitFor(logs, (line) => String(line).includes('relay session ready'));
    socket.closeFrame(1000);
    await waitFor(logs, (line) => String(line).includes('relay closed'));
    const closedLine = logs.find((line) => String(line).includes('relay closed'));
    assert.match(closedLine, /call …abcdef profile intelio after \d+\.\ds \(close frame 1000\)/);
    socket.close();

    const done = { CallSid: fields.CallSid, CallStatus: 'completed', SessionStatus: 'completed', SessionDuration: '35' };
    const forged = await post(port, '/twilio/status', done, bridge.computeSignature(TOKEN, 'https://evil.example/twilio/status', done));
    assert.equal(forged.status, 403);
    const ok = await post(port, '/twilio/status', done, bridge.computeSignature(TOKEN, `${BASE}/status`, done));
    assert.equal(ok.status, 200);
    assert.match(ok.body, /<Response><Hangup\/><\/Response>/);

    const failed = {
      CallSid: fields.CallSid,
      CallStatus: 'in-progress',
      SessionStatus: 'failed',
      SessionDuration: '10',
      ErrorCode: '64105',
      ErrorMessage: 'Websocket ended for +19188991650 <script>',
    };
    const failedRes = await post(port, '/twilio/status', failed, bridge.computeSignature(TOKEN, `${BASE}/status`, failed));
    assert.equal(failedRes.status, 200);
    assert.match(failedRes.body, /<Say>Sorry, intelio could not stay on the line\. Try again in a minute\.<\/Say><Hangup\/>/);
    const statusLine = logs.find((line) => String(line).includes('session failed'));
    assert.match(statusLine, /relay status call …abcdef session failed call in-progress duration 10s error 64105 Websocket ended for \+\*\*\*\*\*1650/);
    assert.equal(logs.some((line) => line.includes('+19188991650') || line.includes('19188991650') || line.includes('<script>') || line.includes(TOKEN) || line.includes(KEY)), false);
  });
});

test('oversized bodies and request floods are refused before Hermes', async () => {
  const hermes = mockHermes(() => { throw new Error('hermes should stay idle'); });
  await withBridge({ fetchImpl: hermes.fetchImpl, limits: { windowMs: 10000, max: 2, fromWindowMs: 60000, fromMax: 12 } }, async ({ port }) => {
    const fields = { From: '+19188991650', To: '+19185550100', Body: 'x' };
    const signature = bridge.computeSignature(TOKEN, `${BASE}/sms`, fields);
    const first = await post(port, '/twilio/sms', fields, 'nope');
    const second = await post(port, '/twilio/sms', fields, 'nope');
    const third = await post(port, '/twilio/sms', fields, signature);
    assert.equal(first.status, 403);
    assert.equal(second.status, 403);
    assert.equal(third.status, 429);
    assert.equal(hermes.calls.length, 0);
  });
  await withBridge({ fetchImpl: hermes.fetchImpl }, async ({ port }) => {
    const huge = Buffer.alloc(70 * 1024, 0x61);
    const oversized = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/twilio/sms', method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': huge.length },
      }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end(huge);
    });
    assert.equal(oversized, 413);
    assert.equal(hermes.calls.length, 0);
  });
});

test('installer dry run describes Caddy and changes nothing', () => {
  const script = path.join(__dirname, '../../mobile/deploy/install-phone-bridge.sh');
  const text = fs.readFileSync(script, 'utf8');
  assert.equal(text.includes('funnel'), false);
  assert.equal(text.includes('ufw allow'), false);
  assert.equal(/systemctl[^\n]*hermes-gateway/.test(text), false);
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phone-bridge-'));
  const result = spawnSync('bash', [script, '--dry-run'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /127\.0\.0\.1:8650/);
  assert.match(result.stdout, /https:\/\/2-24-110-12\.sslip\.io\/twilio\/voice/);
  assert.match(result.stdout, /Caddy/);
  assert.match(result.stdout, /does not restart hermes-gateway/);
  assert.equal(fs.existsSync(path.join(home, '.config', 'intelio-phone', 'env')), false);
});
