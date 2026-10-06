// Shared loopback CDP stub for the VPS broker tests. No Chromium is launched.
const http = require('node:http');
const crypto = require('node:crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsFrame(data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
function wsParse(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f,
      masked = buffer[offset + 1] & 0x80;
    let length = buffer[offset + 1] & 0x7f,
      cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    let mask;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    let payload = buffer.subarray(cursor, cursor + length);
    if (mask) {
      const clear = Buffer.alloc(length);
      for (let i = 0; i < length; i++) clear[i] = payload[i] ^ mask[i % 4];
      payload = clear;
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
function stubEvaluate(pages, sessionId, expression) {
  const page = pages.get(sessionId) || { url: 'about:blank', title: 'Stub page' };
  if (expression.includes('document.readyState')) return { url: page.url, title: page.title, ready: 'complete' };
  if (expression.includes('items.push'))
    return { title: page.title, url: page.url, text: 'stub page text',
      elements: [{ ref: 's1-1', role: 'button', name: 'Stub button', type: '', value: '', href: '', disabled: false }],
      viewport: { width: 900, height: 700, deviceScaleFactor: 1 }, iframes: [] };
  if (expression.includes('drafts.push')) return { url: page.url, title: page.title, scroll: { x: 0, y: 0 }, drafts: [] };
  if (expression.includes('c.drafts'))
    return { verification: expression.includes('needs-review.example') ? 'review_required' : 'ready', restored: 0, skipped: 0 };
  if (expression.includes('link[rel~=icon]')) return '';
  if (expression.includes('innerWidth')) return { width: 900, height: 700, deviceScaleFactor: 1 };
  return null;
}
function createStubCdp() {
  const pages = new Map();
  let created = 0;
  const dispatch = (message) => {
    const { method, params = {}, sessionId } = message;
    const page = pages.get(sessionId);
    switch (method) {
      case 'Target.getTargets': return { targetInfos: [] };
      case 'Target.createTarget': return { targetId: `stub-target-${++created}` };
      case 'Target.attachToTarget': {
        const id = `stub-session-${params.targetId}`;
        pages.set(id, { url: 'about:blank', title: 'Stub page' });
        return { sessionId: id };
      }
      case 'Page.navigate': if (page) page.url = params.url; return {};
      case 'Page.captureScreenshot': return { data: PNG };
      case 'Page.getNavigationHistory': return { currentIndex: 0, entries: [] };
      case 'Runtime.evaluate': return { result: { value: stubEvaluate(pages, sessionId, params.expression) } };
      default: return {};
    }
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version')
      return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/stub` }));
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = wsParse(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 8) { socket.end(); return; }
        if (frame.opcode === 9) continue;
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString());
        if (message.id) socket.write(wsFrame(JSON.stringify({ id: message.id, result: dispatch(message) })));
        if (message.method === 'Page.reload')
          setTimeout(() => socket.write(wsFrame(JSON.stringify({ method: 'Page.loadEventFired', sessionId: message.sessionId, params: {} }))), 300);
      }
    });
  });
  return server;
}


module.exports = { createStubCdp };
