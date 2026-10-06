const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listen, vncCipher } = require('../scripts/packaged-window-e2e.cjs');

const PASSWORD = 'e2e-vnc';

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer());
  return Buffer.from(data);
}

function connect(url) {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const queue = [];
  let waiter = null;
  ws.addEventListener('message', (event) => {
    Promise.resolve(toBuffer(event.data)).then((buf) => {
      if (waiter) { const next = waiter; waiter = null; next(buf); }
      else queue.push(buf);
    });
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('desktop socket failed')));
  });
  return {
    ready,
    send(data) { ws.send(data); },
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { waiter = resolve; });
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

async function handshake(port, password, respond) {
  const client = connect(`ws://127.0.0.1:${port}/websockify`);
  await client.ready;
  const version = await client.next();
  assert.equal(version.toString(), 'RFB 003.008\n');
  client.send(Buffer.from('RFB 003.008\n'));
  const types = await client.next();
  assert.deepEqual([...types], [1, 2]);
  client.send(Buffer.from([2]));
  const challenge = await client.next();
  assert.equal(challenge.length, 16);
  const response = await respond(password, challenge);
  client.send(response);
  const result = await client.next();
  client.close();
  return result;
}

test('the fake desktop accepts a noVNC DES response and rejects a query password', async () => {
  const sample = await vncCipher(PASSWORD, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
  assert.equal(sample.length, 16);

  const good = await listen(PASSWORD);
  try {
    const result = await handshake(good.server.address().port, PASSWORD, vncCipher);
    assert.deepEqual([...result], [0, 0, 0, 0]);
    assert.equal(good.vnc.ok, true);
    assert.equal(good.vnc.rejected, false);
    assert.equal(good.vnc.cipherError, false);
    assert.equal(good.vnc.leaked, false);
  } finally {
    good.server.close();
  }

  const bad = await listen(PASSWORD);
  try {
    const result = await handshake(bad.server.address().port, 'other-pw', vncCipher);
    assert.equal(result[3], 1);
    assert.equal(bad.vnc.ok, false);
    assert.equal(bad.vnc.rejected, true);
  } finally {
    bad.server.close();
  }

  const leaked = await listen(PASSWORD);
  const client = connect(`ws://127.0.0.1:${leaked.server.address().port}/websockify?password=1`);
  try {
    await client.ready;
    assert.equal(leaked.vnc.leaked, true);
  } finally {
    client.close();
    leaked.server.close();
  }
});

function chromePath() {
  for (const candidate of ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

test('a real noVNC page supplies the password through the credentials callback', async (t) => {
  const bin = chromePath();
  if (!bin) { t.skip('chrome is not installed'); return; }
  const desktop = await listen(PASSWORD);
  const vncPort = desktop.server.address().port;
  const novnc = path.resolve(__dirname, '../node_modules/@novnc/novnc');
  const page = `<!doctype html><div id="s"></div><script type="module">
import RFB from '/novnc/core/rfb.js';
const rfb = new RFB(document.getElementById('s'), ${JSON.stringify(`ws://127.0.0.1:${vncPort}/websockify`)});
rfb.scaleViewport = true;
rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: ${JSON.stringify(PASSWORD)} }));
rfb.addEventListener('connect', () => { document.documentElement.dataset.state = 'connected'; });
rfb.addEventListener('securityfailure', () => { document.documentElement.dataset.state = 'rejected'; });
</script>`;
  const web = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/page.html') {
      res.setHeader('content-type', 'text/html');
      res.end(page);
      return;
    }
    if (url.pathname.startsWith('/novnc/')) {
      const file = path.normalize(path.join(novnc, url.pathname.slice('/novnc/'.length)));
      if (!file.startsWith(novnc) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (file.endsWith('.js')) res.setHeader('content-type', 'text/javascript');
      res.end(fs.readFileSync(file));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vnc-chrome-'));
  const chrome = spawn(bin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    `--user-data-dir=${userData}`,
    '--remote-debugging-port=0',
    `http://127.0.0.1:${web.address().port}/page.html`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const devtools = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome devtools did not open')), 15000);
    chrome.stderr.on('data', (chunk) => {
      err += chunk.toString();
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/.exec(err);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });
  try {
    const browserWs = await devtools;
    const listPort = new URL(browserWs).port;
    const deadline = Date.now() + 15000;
    let state = '';
    while (Date.now() < deadline && state !== 'connected') {
      if (desktop.vnc.cipherError) break;
      if (desktop.vnc.rejected) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pages = await (await fetch(`http://127.0.0.1:${listPort}/json/list`)).json();
      const target = pages.find((item) => item.type === 'page' && /page\.html/.test(item.url || ''));
      if (!target) continue;
      const cdp = new WebSocket(target.webSocketDebuggerUrl);
      const opened = new Promise((resolve, reject) => {
        cdp.addEventListener('open', () => resolve());
        cdp.addEventListener('error', () => reject(new Error('page socket failed')));
      });
      const result = new Promise((resolve) => {
        cdp.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id === 1) resolve(msg.result && msg.result.result && msg.result.result.value || '');
        });
      });
      await opened;
      cdp.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.documentElement.dataset.state || ""', returnByValue: true } }));
      state = await result;
      cdp.close();
      if (desktop.vnc.ok && state === 'connected') break;
    }
    assert.equal(desktop.vnc.cipherError, false);
    assert.equal(desktop.vnc.leaked, false);
    assert.equal(desktop.vnc.rejected, false);
    assert.equal(desktop.vnc.ok, true);
    assert.equal(state, 'connected');
  } finally {
    try { chrome.kill(); } catch { /* already exited */ }
    web.close();
    desktop.server.close();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(userData, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
});
