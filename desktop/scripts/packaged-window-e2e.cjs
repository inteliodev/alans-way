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
const { chromium } = require('playwright-core');

const KEYS = {
  intelio: 'i'.repeat(32),
  prc: 'p'.repeat(32),
  alignment: 'a'.repeat(32),
  hhp: 'h'.repeat(32),
};

function listen() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization || '';
    const json = (body) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
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
  let browser;
  let page;
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
    const deadline = Date.now() + 60000;
    let pageUrl = '';
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const hit = list.find((item) => item.type === 'page' && /index\.html/.test(item.url || ''));
        if (hit) { pageUrl = hit.url; break; }
      } catch { /* port is up before the window */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!pageUrl) throw new Error('main window did not open');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    page = pages.find((item) => item.url().includes('index.html')) || pages[0];
    if (!page) throw new Error('CDP connected without a page');
    await page.waitForFunction(() => document.querySelectorAll('#bot-list .bot-row').length === 4, null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelectorAll('#remote-sessions .session-item').length >= 1, null, { timeout: 20000 });
    await page.screenshot({ path: shot });
    const status = (await page.locator('#remote-status').innerText()).trim();
    const profile = (await page.locator('#intelio-profile').innerText()).trim();
    const agents = await page.locator('#bot-list .bot-row').count();
    const sessions = await page.locator('#remote-sessions .session-item').count();
    process.stdout.write(`e2e agents=${agents} sessions=${sessions} status=${JSON.stringify(status)} profile=${JSON.stringify(profile)}\n`);
    if (agents !== 4) throw new Error(`expected 4 agents, saw ${agents}`);
    if (sessions < 1) throw new Error(`expected a session, saw ${sessions}`);
    if (/not defined|unreachable|HTTP |No key|No API|failed|error/i.test(status)) throw new Error(`status line: ${status}`);
    if (/not defined|Loading/i.test(profile)) throw new Error(`profile line: ${profile}`);
    process.stdout.write(`screenshot ${shot}\n`);
  } catch (error) {
    if (page) await page.screenshot({ path: shot }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill();
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
