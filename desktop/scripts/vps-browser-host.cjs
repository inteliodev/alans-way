#!/usr/bin/env node
// Add-on browser host. Stock Hermes connects through MCP; its runtime is unchanged.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { CDP } = require('../src/cdp.cjs');
const { normalizeUrl, requireActor, requireAgentRead, requireAgentClaim, reviewedHandoff, isAuthorized } = require('../src/core.cjs');
const { createAgentInput, tintScript, botAccent } = require('../src/agent-input.cjs');
const { snapshotExpression, settleSnapshot, checkpointExpression, restoreExpression } = require('../src/browser-page.cjs');
const { loadVpsPolicy, resolveSidecarPath, assertLoopbackBrowser, agentUrlDecision } = require('../src/intelio/sidecar.cjs');
const root =
  process.env.HERMES_VPS_BROWSER_DATA || path.join(os.homedir(), '.local', 'share', 'hermes-alans-way', 'browser');
const configFile = path.join(root, 'config.json'),
  connectionFile = path.join(root, 'connection.json'),
  registryFile = path.join(root, 'tabs.json');
function write(file, data) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const intParam = (url, key, min, max) => {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw fail(`${key} must be an integer.`);
  return Math.max(min, Math.min(max, value));
};
// Must stay below the request timeouts for /actions in request() and the
// Mac's SSH proxy, allowing a final 30s wait step to finish.
const BATCH_BUDGET_MS = 50000;
const overseerBots = new Set(
  String(process.env.HERMES_OVERSEER_BOT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id.length <= 100),
);
async function read(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 150000) throw fail('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
async function request(input) {
  const c = JSON.parse(fs.readFileSync(connectionFile));
  if (!/^\/v1\/(status|tabs)(\/|$)/.test(input.path)) throw new Error('Invalid browser operation.');
  const response = await fetch(c.url + input.path, {
    method: input.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + c.token,
      'X-Hermes-Bot': String(input.botId || ''),
      'X-Hermes-Bot-Name': encodeURIComponent(String(input.botName || '').slice(0, 80)),
      'X-Hermes-Human': input.human ? '1' : '0',
      'X-Control-Epoch': String(input.epoch || ''),
      'Content-Type': 'application/json',
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(/\/actions$/.test(input.path) ? 84000 : 25000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function serve() {
  const cfg = JSON.parse(fs.readFileSync(configFile));
  // INTELIO_YOLO is ignored. A sidecar that asks for YOLO or auto-approval refuses to start.
  const policy = loadVpsPolicy({ sidecarPath: resolveSidecarPath(cfg) });
  assertLoopbackBrowser(cfg);
  const assertAgentUrl = (url) => {
    const decision = agentUrlDecision(url, policy);
    if (!decision.ok) throw fail(decision.error, decision.status);
  };
  let cdp;
  try {
    cdp = await CDP.connect(cfg.cdpUrl);
  } catch (error) {
    if (!cfg.browserCommand) throw error;
    const child = spawn(cfg.browserCommand, cfg.browserArgs || [], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    for (let n = 0; n < 40; n++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        cdp = await CDP.connect(cfg.cdpUrl);
        break;
      } catch {}
    }
    if (!cdp) throw new Error('Configured VPS Chromium did not become available.');
  }
  const tabs = new Map();
  // The Mac shell forwards each bot's display name so the in-page agent cursor
  // shows it instead of a generic "Agent" inside the streamed desktop.
  const botNames = new Map();
  let persistQueue = Promise.resolve();
  const describe = (t) => ({
    id: t.id,
    targetId: t.targetId,
    title: t.title,
    url: t.url,
    botId: t.botId,
    allowedBots: t.allowedBots ?? [],
    favicon: t.favicon || '',
    agentHue: botAccent(t.botId).hue,
    controller: t.controller,
    epoch: t.epoch,
    host: 'vps',
    session: 'shared-vps',
    loading: false,
    viewport: t.viewport || null,
    agentCursor: t.agentCursor || null,
    agentBusy: input.isDispatching(t),
    handoff: t.handoff || null,
  });
  function persist() {
    const data = [...tabs.values()].map(describe);
    persistQueue = persistQueue.then(() => write(registryFile, data));
    return persistQueue;
  }
  const input = createAgentInput({
    requireActor: (tab, botId, epoch, mutate) =>
      requireActor(tab, botId, epoch, mutate, overseerBots.has(botId)),
    command: (tab, method, params) => tab.view.webContents.command(method, params),
    botName: (id) => botNames.get(id) || 'Agent',
  });
  async function attach(data) {
    const wc = await cdp.page(data.targetId);
    const t = { ...data, view: { webContents: wc }, refs: new Set(), generation: 0, queue: Promise.resolve() };
    tabs.set(t.id, t);
    return t;
  }
  const targets = (await cdp.send('Target.getTargets')).targetInfos;
  try {
    for (const saved of JSON.parse(fs.readFileSync(registryFile))) {
      const target = targets.find((t) => t.targetId === saved.targetId && t.type === 'page');
      if (target)
        await attach({ ...saved, url: target.url, title: target.title, controller: 'human', epoch: saved.epoch + 1 });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await persist();
  const agentIdleMs = Math.max(1, Number(process.env.HERMES_AGENT_IDLE_MINUTES) || 15) * 60000;
  setInterval(() => {
    const now = Date.now();
    for (const t of tabs.values()) {
      if (t.controller !== 'agent' || t.pendingActions > 0 || input.isDispatching(t)) continue;
      if (now - Math.max(t.agentSince || 0, t.lastAgentActivity || 0) <= agentIdleMs) continue;
      t.controller = 'human';
      t.epoch++;
      t.refs.clear();
      input.clear(t).catch(() => {});
      t.view.webContents.executeJavaScript(tintScript(false)).catch(() => {});
      persist();
    }
  }, 30000).unref();
  cdp.socket.addEventListener('close', () => {
    process.stderr.write('Chromium disconnected; restarting the broker through its service.\n');
    process.exit(1);
  });
  async function open(body, botId, human) {
    if (body.host !== undefined && body.host !== 'vps')
      throw fail('This connection serves only the VPS browser. Use the Mac connector for Mac tasks.', 503);
    if (!botId || botId.length > 100) throw fail('X-Hermes-Bot is required.');
    if (tabs.size >= 40) throw fail('Close a VPS browser tab before opening another.');
    const url = normalizeUrl(body.url);
    if (!human) assertAgentUrl(url);
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      background: true,
    });
    const tab = await attach({
      id: crypto.randomUUID(),
      targetId,
      title: 'New VPS tab',
      url: 'about:blank',
      botId,
      allowedBots: [],
      controller: human ? 'human' : 'agent',
      epoch: 1,
      agentSince: human ? undefined : Date.now(),
    });
    await persist();
    try {
      await tab.view.webContents.command('Page.enable');
      await tab.view.webContents.command('Page.navigate', { url });
      await loaded(tab, url);
      if (tab.controller === 'agent') assertAgentUrl(tab.url);
      if (tab.controller === 'agent') await tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
      await persist();
      return tab;
    } catch (e) {
      if (e.status === 403 || e.status === 409) {
        await tab.view.webContents.command('Page.navigate', { url: 'about:blank' }).catch(() => {});
        tab.url = 'about:blank';
        await persist().catch(() => {});
        throw e;
      }
      throw fail('VPS tab opened but navigation needs review. List its state before retrying.', 502);
    }
  }
  async function loaded(tab, url) {
    for (let i = 0; i < 80; i++) {
      const s = await tab.view.webContents
        .executeJavaScript('({url:location.href,title:document.title,ready:document.readyState})')
        .catch(() => null);
      if ((s && s.url !== 'about:blank' && s.ready === 'complete') || (s && url === 'about:blank')) {
        tab.url = s.url;
        tab.title = s.title;
        tab.favicon = await tab.view.webContents
          .executeJavaScript("document.querySelector('link[rel~=icon]')?.href || ''")
          .catch(() => '');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw fail('VPS page is still loading. Inspect it before continuing.', 504);
  }
  // Reload and history entries resolve on dispatch, not on load. Subscribe
  // before triggering so a cached or same-document navigation is not missed.
  async function settle(tab, trigger) {
    const wc = tab.view.webContents;
    await wc.command('Page.enable').catch(() => {});
    let listener, timer;
    const settled = new Promise((resolve) => {
      listener = (m) => {
        if (m.sessionId !== wc.sessionId) return;
        if (m.method === 'Page.loadEventFired' || m.method === 'Page.navigatedWithinDocument' ||
          (m.method === 'Page.frameNavigated' && m.params?.type === 'BackForwardCacheRestore')) resolve();
      };
      cdp.listeners.add(listener);
      timer = setTimeout(resolve, 15000);
    });
    try {
      await trigger();
      await settled;
    } finally {
      clearTimeout(timer);
      cdp.listeners.delete(listener);
    }
    const s = await wc.executeJavaScript('({url:location.href,title:document.title})').catch(() => null);
    if (s) Object.assign(tab, s);
  }
  async function history(tab, action, agent) {
    const wc = tab.view.webContents;
    if (action === 'reload') return settle(tab, () => wc.command('Page.reload'));
    const h = await wc.command('Page.getNavigationHistory');
    const e = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
    if (e) {
      if (agent && e.url) assertAgentUrl(e.url);
      await settle(tab, () => wc.command('Page.navigateToHistoryEntry', { entryId: e.id }));
      if (agent) assertAgentUrl(tab.url);
    }
  }
  async function vpsPerform(tab, body, botId, overseer, depth = 0) {
    const wc = tab.view.webContents;
    requireActor(tab, botId, body.epoch, true, overseer);
    if (body.action === 'batch') {
      if (depth > 0) throw fail('Batches cannot nest.');
      const steps = Array.isArray(body.steps) ? body.steps.slice(0, 25) : [];
      if (!steps.length) throw fail('batch needs a non-empty steps array (max 25).');
      const results = [], started = Date.now();
      for (const step of steps) {
        if (!step || typeof step !== 'object') { results.push({ error: 'Invalid step.' }); break; }
        if (Date.now() - started > BATCH_BUDGET_MS) { results.push({ error: `batch stopped after ${BATCH_BUDGET_MS / 1000}s; remaining steps were not run. Snapshot, then continue.` }); break; }
        try { results.push(await vpsPerform(tab, { ...step, epoch: body.epoch }, botId, overseer, 1)); }
        catch (error) { results.push({ error: error.message }); break; }
      }
      return { results, dispatched: true };
    }
    if (body.action === 'eval') {
      const code = String(body.code || '');
      if (!code || code.length > 16384) throw fail('eval needs a code string (max 16KB).');
      let value = await Promise.race([
        wc.executeJavaScript(code),
        new Promise((_, reject) => setTimeout(() => reject(fail('eval timed out after 15s.', 408)), 15000)),
      ]);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
      return { value, dispatched: true };
    }
    if (body.action === 'wait') {
      const selector = String(body.selector || '').slice(0, 2000);
      const text = String(body.text || '').slice(0, 2000);
      const urlPart = String(body.url || '').slice(0, 2000);
      const visible = body.visible === true;
      const timeout = Math.min(Math.max(Number(body.timeout) || 10000, 100), 30000);
      if (!selector && !text && !urlPart) throw fail('wait needs a selector, text, or url to wait for.');
      const waitCode = (ms) => `new Promise((resolve) => {
        const sel = ${JSON.stringify(selector)}, txt = ${JSON.stringify(text)}, urlP = ${JSON.stringify(urlPart)}, vis = ${visible};
        const deadline = Date.now() + ${ms};
        const check = () => {
          if (urlP && !location.href.includes(urlP)) return false;
          if (sel) {
            const el = document.querySelector(sel);
            if (!el) return false;
            if (vis) {
              const r = el.getBoundingClientRect();
              if (!r.width || !r.height) return false;
              if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
            }
          }
          if (txt && !(document.body && document.body.innerText.includes(txt))) return false;
          return true;
        };
        const t0 = Date.now();
        let mo, poll;
        const done = (found) => { clearInterval(poll); if (mo) mo.disconnect(); resolve({ found, waited: Date.now() - t0 }); };
        if (check()) return done(true);
        mo = new MutationObserver(() => { if (check()) done(true); });
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        poll = setInterval(() => { if (check() || Date.now() > deadline) done(check()); }, 100);
        setTimeout(() => done(check()), ${ms});
      })`;
      const hostStart = Date.now();
      let value = null;
      while (Date.now() - hostStart < timeout + 1000) {
        const remaining = Math.max(400, timeout - (Date.now() - hostStart));
        const attempt = await Promise.race([
          wc.executeJavaScript(waitCode(remaining)).catch(() => ({ navRetry: true })),
          new Promise((r) => setTimeout(() => r({ navRetry: true }), remaining + 1500)),
        ]);
        if (attempt && !attempt.navRetry) { value = attempt; break; }
        if (urlPart && tab.url.includes(urlPart)) { value = { found: true, waited: Date.now() - hostStart }; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!value || !value.found) throw fail(`wait timed out after ${value ? value.waited : Date.now() - hostStart}ms for ${[selector && `selector ${JSON.stringify(selector)}`, text && `text ${JSON.stringify(text.slice(0, 80))}`, urlPart && `url containing ${JSON.stringify(urlPart.slice(0, 80))}`].filter(Boolean).join(' and ')}. Snapshot the page to see its current state.`, 408);
      return { waited: value.waited, dispatched: true };
    }
    if (body.action === 'viewport') {
      if (body.clear === true) {
        await wc.command('Emulation.clearDeviceMetricsOverride');
        delete tab.viewport;
        return { viewport: null, dispatched: true };
      }
      const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
      const scale = Math.min(Math.max(Number(body.scale) || 1, 0.1), 5);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || width > 7680 || height < 100 || height > 4320)
        throw fail('viewport needs width 100-7680 and height 100-4320, or clear:true.');
      await wc.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      tab.viewport = { width, height, scale };
      return { viewport: tab.viewport, dispatched: true };
    }
    if (body.action === 'cdp') {
      const method = String(body.method || '');
      if (!/^(Page|Runtime|Input|Emulation|Network|DOM|DOMSnapshot|Accessibility|CSS|Log|Fetch|Storage)\.[a-zA-Z]+$/.test(method))
        throw fail('Unsupported CDP method. Allowed domains: Page, Runtime, Input, Emulation, Network, DOM, DOMSnapshot, Accessibility, CSS, Log, Fetch, Storage.');
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      if (JSON.stringify(params).length > 64000) throw fail('cdp params too large (max 64KB).');
      if (method === 'Page.navigate' && params.url != null) assertAgentUrl(String(params.url));
      let value = await Promise.race([
        wc.command(method, params),
        new Promise((_, reject) => setTimeout(() => reject(fail('cdp timed out after 20s.', 408)), 20000)),
      ]);
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      if (serialized && serialized.length > 48000) value = serialized.slice(0, 48000) + '…[truncated]';
      return { value, dispatched: true };
    }
    if (['click', 'type', 'press', 'move', 'scroll'].includes(body.action)) await input.perform(tab, body, botId);
    else if (body.action === 'navigate') {
      await input.clear(tab);
      requireActor(tab, botId, body.epoch, true, overseer);
      const target = normalizeUrl(body.url);
      assertAgentUrl(target);
      await wc.command('Page.navigate', { url: target });
      await loaded(tab, target);
      assertAgentUrl(tab.url);
    } else if (['back', 'forward', 'reload'].includes(body.action)) {
      await input.clear(tab);
      requireActor(tab, botId, body.epoch, true, overseer);
      await history(tab, body.action, true);
    } else throw fail('Unsupported VPS action.');
    if (body.action !== 'move') tab.refs.clear();
    return { dispatched: true };
  }
  cdp.listeners.add((event) => {
    if (event.method === 'Target.targetInfoChanged') {
      const info = event.params.targetInfo;
      const tab = [...tabs.values()].find((t) => t.targetId === info.targetId);
      if (tab) {
        const moved = info.url !== tab.url;
        if (moved && tab.controller === 'agent') {
          const decision = agentUrlDecision(info.url, policy);
          if (!decision.ok) {
            tab.error = decision.error;
            tab.url = 'about:blank';
            tab.refs.clear();
            if (!tab.intelioBouncing) {
              tab.intelioBouncing = true;
              tab.view.webContents.command('Page.navigate', { url: 'about:blank' })
                .finally(() => { tab.intelioBouncing = false; })
                .catch(() => {});
            }
            persist().catch(() => {});
            return;
          }
        }
        tab.url = info.url;
        tab.title = info.title;
        tab.refs.clear();
        if (moved && tab.controller === 'agent') tab.view.webContents.executeJavaScript(tintScript(true)).catch(() => {});
        persist().catch(() => {});
      }
    }
    if (event.method === 'Target.targetDestroyed') {
      const tab = [...tabs.values()].find((t) => t.targetId === event.params.targetId);
      if (tab) {
        tabs.delete(tab.id);
        persist().catch(() => {});
      }
    }
    if (event.method === 'Target.targetCreated') {
      const info = event.params.targetInfo;
      const parent = [...tabs.values()].find((t) => t.targetId === info.openerId);
      if (info.type === 'page' && parent && ![...tabs.values()].some((t) => t.targetId === info.targetId))
        attach({
          id: crypto.randomUUID(),
          targetId: info.targetId,
          title: info.title,
          url: info.url,
          botId: parent.botId,
          allowedBots: [],
          controller: parent.controller,
          epoch: 1,
        })
          .then(persist)
          .catch(() => {});
    }
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.origin || !isAuthorized(req.headers.authorization, token))
      return send(401, { error: 'Unauthorized' });
    if (cdp.socket.readyState !== 1)
      return send(503, { error: 'VPS Chromium disconnected. Inspect task state before retrying.' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1'),
        botId = String(req.headers['x-hermes-bot'] || ''),
        human = req.headers['x-hermes-human'] === '1',
        overseer = overseerBots.has(botId);
      try {
        const botName = decodeURIComponent(String(req.headers['x-hermes-bot-name'] || '')).slice(0, 80);
        if (botId && botName) botNames.set(botId, botName);
      } catch {}
      if (url.pathname === '/v1/status')
        return send(200, {
          name: 'Hermes VPS browser',
          version: '0.1.5',
          host: 'vps',
          protocol: 1,
          session: 'shared-vps',
          capabilities: ['tabs', 'snapshot', 'screenshot', 'background-input', 'control-epochs', 'checkpoint'],
          tabCount: tabs.size,
        });
      if (url.pathname === '/v1/tabs' && req.method === 'GET')
        return send(200, {
          tabs: [...tabs.values()]
            .filter((t) => human || overseer || t.botId === botId || (t.allowedBots ?? []).includes(botId))
            .map(describe),
        });
      if (url.pathname === '/v1/tabs' && req.method === 'POST')
        return send(201, describe(await open(await read(req), botId, human)));
      const m =
          /^\/v1\/tabs\/([\w-]+)(?:\/(snapshot|screenshot|actions|human-actions|control|activate|checkpoint|restore|grant))?$/.exec(
            url.pathname,
          ),
        tab = m && tabs.get(m[1]);
      if (!tab) throw fail('VPS tab not found.', 404);
      if (!human) requireActor(tab, botId, undefined, false, overseer);
      const wc = tab.view.webContents;
      if (req.method === 'GET' && !m[2]) return send(200, describe(tab));
      if (!human) tab.lastAgentActivity = Date.now();
      if (req.method === 'GET' && m[2] === 'snapshot') {
        if (!human) requireAgentRead(tab);
        const opts = {
          maxChars: intParam(url, 'maxChars', 0, 20000),
          maxElements: intParam(url, 'maxElements', 0, 300),
          since: intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER),
        };
        const work = tab.queue.then(async () => {
          const generation = ++tab.generation;
          let timer;
          const data = await Promise.race([
            wc.executeJavaScript(snapshotExpression(generation, { ...opts, keep: tab.snapshotStamp?.base })),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(fail('Snapshot timed out after 10s. The page may be unresponsive.', 503)), 10000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (!data || !Array.isArray(data.elements)) throw fail('Snapshot returned no page data.', 503);
          tab.url = data.url;
          tab.title = data.title;
          return { ...settleSnapshot(tab, data, generation, opts.since), tab: describe(tab) };
        });
        tab.queue = work.catch(() => {});
        return send(200, await work);
      }
      if (req.method === 'GET' && m[2] === 'screenshot') {
        if (!human) requireAgentRead(tab);
        const format = url.searchParams.get('format') ?? 'jpeg';
        if (!['jpeg', 'png', 'webp'].includes(format)) throw fail('format must be jpeg, png, or webp.');
        const quality = intParam(url, 'quality', 1, 100) ?? 70;
        const maxWidth = intParam(url, 'maxWidth', 1, 10000) ?? 1280;
        const capture = tab.queue.then(async () => {
          const viewport = await wc.executeJavaScript(
            '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})',
          );
          // No resize post-capture here: clip.scale is the downscale knob,
          // keeping the emitted image at maxWidth pixels when it would exceed it.
          const dsf = viewport.deviceScaleFactor || 1;
          const scale = viewport.width * dsf > maxWidth ? Math.max(0.01, maxWidth / viewport.width) : dsf;
          const params = { format, fromSurface: true, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } };
          if (format !== 'png') params.quality = quality;
          return { shot: await wc.command('Page.captureScreenshot', params), viewport };
        });
        tab.queue = capture.catch(() => {});
        const { shot, viewport } = await capture;
        return send(200, { base64: shot.data, mimeType: { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' }[format], viewport, tab: describe(tab) });
      }
      if (req.method === 'POST' && m[2] === 'actions') {
        const body = await read(req);
        tab.pendingActions = (tab.pendingActions || 0) + 1;
        const action = tab.queue.then(async () => {
          const result = await vpsPerform(tab, body, botId, overseer);
          await persist();
          return { ...result, tab: describe(tab) };
        }).finally(() => {
          tab.pendingActions--;
          if (!human) tab.lastAgentActivity = Date.now();
        });
        tab.queue = action.catch(() => {});
        return send(200, await action);
      }
      if ((human || overseer || botId === tab.botId) && req.method === 'POST' && m[2] === 'control') {
        const body = await read(req);
        if (body.controller === 'agent') assertAgentUrl(tab.url || 'about:blank');
        if (!human && body.controller === 'agent') { requireAgentClaim(tab); tab.handoff = reviewedHandoff(tab.handoff); }
        if (human && body.handoff?.phase === 'handed_off')
          tab.handoff = {
            id: String(body.handoff.id || '').slice(0, 100),
            phase: 'handed_off',
            sourceHost: 'vps',
            destinationHost: body.handoff.destinationHost === 'mac' ? 'mac' : 'vps',
            destinationTabId: String(body.handoff.destinationTabId || '').slice(0, 100),
            createdAt: Number(body.handoff.createdAt) || Date.now(),
          };
        else if (human && body.controller === 'agent') tab.handoff = reviewedHandoff(tab.handoff);
        tab.controller = body.controller === 'agent' ? 'agent' : 'human';
        if (tab.controller === 'agent') tab.agentSince = Date.now();
        tab.epoch++;
        tab.refs.clear();
        await input.clear(tab);
        await wc.executeJavaScript(tintScript(tab.controller === 'agent')).catch(() => {});
        await persist();
        return send(200, describe(tab));
      }
      if (human && req.method === 'POST' && m[2] === 'activate') {
        await cdp.send('Target.activateTarget', { targetId: tab.targetId });
        return send(200, describe(tab));
      }
      if (human && req.method === 'POST' && m[2] === 'human-actions') {
        if (tab.controller !== 'human') throw fail('Take control before navigating.', 409);
        const body = await read(req),
          epoch = tab.epoch;
        const operation = tab.queue.then(async () => {
          if (tab.controller !== 'human' || tab.epoch !== epoch) throw fail('Control changed. Inspect the tab.', 409);
          if (body.action === 'navigate') {
            const target = normalizeUrl(body.url);
            await wc.command('Page.navigate', { url: target });
            await loaded(tab, target);
          } else if (['back', 'forward', 'reload'].includes(body.action)) await history(tab, body.action);
          else throw fail('Unsupported human browser navigation.');
          tab.refs.clear();
          await persist();
          return { tab: describe(tab) };
        });
        tab.queue = operation.catch(() => {});
        return send(200, await operation);
      }
      if (human && req.method === 'POST' && m[2] === 'grant') {
        const body = await read(req);
        if (typeof body.botId === 'string' && body.botId.length && body.botId.length <= 100) tab.botId = body.botId;
        tab.allowedBots = [
          ...new Set(
            (body.botIds || []).filter(
              (id) => typeof id === 'string' && id.length && id.length <= 100 && id !== tab.botId,
            ),
          ),
        ];
        tab.epoch++;
        tab.refs.clear();
        await input.clear(tab);
        await persist();
        return send(200, describe(tab));
      }
      if (human && req.method === 'POST' && m[2] === 'checkpoint') {
        if (tab.controller !== 'human') throw fail('Take control before checkpointing.', 409);
        const body = await read(req);
        await tab.queue;
        return send(200, await wc.executeJavaScript(checkpointExpression(body.includeDrafts)));
      }
      if (human && req.method === 'POST' && m[2] === 'restore') {
        if (tab.controller !== 'human') throw fail('Destination must remain under human review.', 409);
        const body = await read(req);
        await tab.queue;
        const result = await wc.executeJavaScript(restoreExpression(body.checkpoint));
        tab.handoff = {
          ...body.handoff,
          destinationTabId: tab.id,
          verification: result.verification,
          restoredDrafts: result.restored,
          skippedDrafts: result.skipped,
        };
        await persist();
        return send(200, { ...result, tab: describe(tab) });
      }
      if (req.method === 'DELETE' && !m[2]) {
        if (!human) requireActor(tab, botId, Number(req.headers['x-control-epoch']), true, overseer);
        tab.epoch++;
        await input.clear(tab);
        await cdp.send('Target.closeTarget', { targetId: tab.targetId });
        tabs.delete(tab.id);
        await persist();
        return send(200, { closed: true });
      }
      throw fail('Unsupported VPS operation.', 405);
    } catch (e) {
      send(e.status || 400, { error: e.message });
    }
  });
  const port = Number.isInteger(cfg.port) ? cfg.port : 9465;
  server.on('error', (error) => {
    process.stderr.write(error.message + '\n');
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    write(connectionFile, { url: 'http://127.0.0.1:' + server.address().port, token, protocol: 1, host: 'vps' });
    process.stderr.write('VPS browser host ready on loopback.\n');
  });
}
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'serve')
    serve().catch((e) => {
      process.stderr.write(e.message + '\n');
      process.exit(1);
    });
  else if (mode === 'request') {
    let bytes = 0,
      text = '';
    process.stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 150000) process.exit(1);
      text += chunk;
    });
    process.stdin.on('end', () =>
      Promise.resolve()
        .then(() => JSON.parse(text))
        .then(request)
        .then((data) => process.stdout.write(JSON.stringify(data)))
        .catch(() => {
          process.stdout.write(
            JSON.stringify({
              status: 503,
              data: { error: 'VPS browser host unavailable. Check its service and Chromium.' },
            }),
          );
        }),
    );
  } else {
    process.stderr.write(
      'Usage: vps-browser-host.cjs serve | request\nConfiguration lives in HERMES_VPS_BROWSER_DATA/config.json or the default private browser data directory.\n',
    );
    process.exit(1);
  }
}
