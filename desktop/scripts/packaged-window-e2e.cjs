'use strict';
/**
 * Launch the packaged Windows app against a fake Hermes and assert the main
 * window actually renders agents. Run from desktop/ on windows-latest.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const KEYS = {
  intelio: 'i'.repeat(32),
  prc: 'p'.repeat(32),
  alignment: 'a'.repeat(32),
  hhp: 'h'.repeat(32),
};

function openCdp(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`CDP socket failed for ${url}`)));
  });
  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString();
    const msg = JSON.parse(raw);
    if (!msg.id || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message || 'CDP error'));
    else waiter.resolve(msg.result);
  });
  return {
    async send(method, params, ms = 10000) {
      await opened;
      const id = ++seq;
      const result = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`${method} timed out after ${ms}ms`));
        }, ms);
      });
      ws.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

function listen() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    const json = (body) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') {
      json({ status: 'ok', platform: 'hermes-agent', version: '0.21.5' });
      return;
    }
    if (url.pathname === '/api/home' || url.pathname === '/api/profiles') {
      if (auth !== `Bearer ${KEYS.intelio}`) { res.statusCode = 401; json({}); return; }
      json({ profiles: [
        { id: 'intelio', name: 'Intelio' },
        { id: 'prc', name: 'PRC' },
        { id: 'alignment', name: 'Alignment' },
        { id: 'hhp', name: 'HHP' },
      ] });
      return;
    }
    const sessions = url.pathname.match(/^\/p\/([a-z0-9_-]+)\/api\/sessions$/);
    if (req.method === 'GET' && sessions) {
      const profile = sessions[1];
      if (auth !== `Bearer ${KEYS[profile] || ''}`) { res.statusCode = 401; json({}); return; }
      json({ data: [{ id: 's1', source: 'telegram', title: 'Friday notes', preview: 'Need your yes.' }] });
      return;
    }
    const messages = url.pathname.match(/^\/p\/([a-z0-9_-]+)\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === 'GET' && messages) {
      const profile = messages[1];
      if (auth !== `Bearer ${KEYS[profile] || ''}`) { res.statusCode = 401; json({}); return; }
      json({ data: [{ role: 'user', content: 'Pull the Friday notes.' }, { role: 'assistant', content: 'Three takeaways.' }] });
      return;
    }
    res.statusCode = 404;
    json({});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const exe = path.resolve('dist/win-unpacked/Intelio.exe');
  if (!fs.existsSync(exe)) throw new Error(`packaged exe missing: ${exe}`);
  const shot = path.resolve('dist/e2e-main-window.png');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-e2e-'));
  const server = await listen();
  const port = server.address().port;
  fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({
    preview: false,
    savedTabs: [],
    remoteHermes: { enabled: true, host: '127.0.0.1', port, profile: 'intelio' },
  }));
  fs.writeFileSync(path.join(userData, 'remote-hermes-key.import'), Object.entries(KEYS).map(([name, key]) => `${name}=${key}`).join('\n'));

  const child = spawn(exe, ['--remote-debugging-port=0', '--disable-gpu'], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      HERMES_WORKSPACE_DATA: userData,
      INTELIO_E2E: '1',
      INTELIO_PYTHON: 'intelio-no-python',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  let cdp;
  let errBuf = '';
  const waitForDevtools = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DevTools port did not open\n${errBuf.slice(-2000)}`)), 60000);
    const take = (chunk) => {
      const text = chunk.toString();
      errBuf += text;
      process.stderr.write(text);
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/.exec(errBuf);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stderr.on('data', take);
    child.on('exit', (code) => reject(new Error(`Intelio exited ${code} before DevTools opened\n${errBuf.slice(-2000)}`)));
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  try {
    const ws = await waitForDevtools;
    const port = new URL(ws).port;
    const deadline = Date.now() + 30000;
    let target = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((item) => item.type === 'page' && /index\.html/.test(item.url || '') && item.webSocketDebuggerUrl);
        if (target) break;
      } catch { /* port is up before the window */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!target) throw new Error('main window did not open');
    cdp = openCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const read = async () => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => ({
          agents: document.querySelectorAll('#bot-list .bot-row').length,
          sessions: document.querySelectorAll('#remote-sessions .session-item').length,
          status: (document.getElementById('remote-status') || {}).textContent || '',
          pin: (document.getElementById('hermes-pin') || {}).textContent || '',
          profile: (document.getElementById('intelio-profile') || {}).textContent || '',
        }))()`,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description
          || result.exceptionDetails.text
          || 'page evaluate failed';
        throw new Error(detail);
      }
      return result.result.value;
    };
    let view = { agents: 0, sessions: 0, status: '', pin: '', profile: '' };
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      view = await read();
      const pin = String(view.pin || '');
      if (view.agents === 4 && view.sessions >= 1 && /hermes-agent 0\.21\.5/.test(pin) && !/unavailable/i.test(pin)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
    const status = String(view.status || '').trim();
    const pin = String(view.pin || '').trim();
    const profile = String(view.profile || '').trim();
    const bad = /unavailable|not defined|unreachable|HTTP |No key|No API|failed|error/i;
    process.stdout.write(`e2e agents=${view.agents} sessions=${view.sessions} status=${JSON.stringify(status)} pin=${JSON.stringify(pin)} profile=${JSON.stringify(profile)}\n`);
    if (view.agents !== 4) throw new Error(`expected 4 agents, saw ${view.agents}`);
    if (view.sessions < 1) throw new Error(`expected a session, saw ${view.sessions}`);
    if (bad.test(status)) throw new Error(`status line: ${status}`);
    if (bad.test(pin) || !/hermes-agent 0\.21\.5/.test(pin)) throw new Error(`status line: ${pin}`);
    if (/not defined|Loading/i.test(profile)) throw new Error(`profile line: ${profile}`);
    process.stdout.write(`screenshot ${shot}\n`);
  } catch (error) {
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill();
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
