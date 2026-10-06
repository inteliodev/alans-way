'use strict';
/**
 * Launch the packaged Windows app against a fake Hermes and assert the main
 * window actually renders agents. Run from desktop/ on windows-latest.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

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

  let app;
  let page;
  try {
    app = await electron.launch({
      executablePath: exe,
      cwd: path.dirname(exe),
      args: ['--disable-gpu'],
      timeout: 90000,
      env: {
        ...process.env,
        HERMES_WORKSPACE_DATA: userData,
        INTELIO_PYTHON: 'intelio-no-python',
      },
    });
    page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelectorAll('#bot-list .bot-row').length === 4, null, { timeout: 60000 });
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
    if (app) await app.close().catch(() => {});
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exit(1);
});
