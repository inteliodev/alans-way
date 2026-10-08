'use strict';
/**
 * The app's Terminal window: one tab for this computer, one for "cloud" (the
 * VPS). These are the PERSON's terminals: agents cannot see or type into them
 * and the agents' kill switch does not end them.
 * - This computer: a session manager in the main process (sessions.cjs: node-pty,
 *   script(1) on Linux, pipes as a last resort).
 * - cloud: the person-only /api/computers/terminal/* routes on the VPS relay
 *   (mobile/pwa/nodes-terminal.cjs), reached through the app's existing Access
 *   session or Tailscale login, never with a profile key.
 * The renderer long-polls read and sends raw keystrokes.
 */
const os = require('node:os');
const path = require('node:path');
const { createSessionManager } = require('../node/sessions.cjs');

const TARGETS = ['local', 'cloud'];

function createTerminalBackend({ remote, sessionOptions = {}, home = os.homedir() } = {}) {
  let local = null;
  const localManager = () => (local = local || createSessionManager({ home, limits: { sessionMax: 6, sessionIdleMs: 12 * 60 * 60 * 1000, sessionWaitMaxMs: 25000 }, ...sessionOptions }));
  const cloud = (op, body, timeoutMs = 15000) => {
    if (!remote || typeof remote.computersRequest !== 'function') throw new Error('Connect to the VPS (intelio cloud or Tailscale) to open its terminal.');
    return op === 'list'
      ? remote.computersRequest('/api/computers/terminal/list', { timeoutMs })
      : remote.computersRequest(`/api/computers/terminal/${op}`, { method: 'POST', body, timeoutMs });
  };

  async function run(target, op, value = {}) {
    if (!TARGETS.includes(target)) throw new Error('Unknown terminal.');
    const v = value && typeof value === 'object' ? value : {};
    const id = String(v.session_id || '').slice(0, 64);
    if (target === 'cloud') {
      if (op === 'start') return cloud('start', { cols: v.cols, rows: v.rows });
      if (op === 'input') return cloud('input', { session_id: id, data: String(v.data || '').slice(0, 65536) });
      if (op === 'read') return cloud('read', { session_id: id, since: v.since, wait_ms: Math.min(20000, Math.max(0, Number(v.wait_ms) || 0)) }, 30000);
      if (op === 'resize') return cloud('resize', { session_id: id, cols: v.cols, rows: v.rows });
      if (op === 'stop') return cloud('stop', { session_id: id });
      if (op === 'list') return cloud('list');
      throw new Error('Unknown terminal operation.');
    }
    const m = localManager();
    if (op === 'start') return { ok: true, ...m.start({ cols: v.cols, rows: v.rows }) };
    if (op === 'input') return m.writeRaw(id, String(v.data || '').slice(0, 65536));
    if (op === 'read') return { ok: true, ...(await m.read(id, { since: v.since, wait_ms: Math.min(20000, Math.max(0, Number(v.wait_ms) || 0)), max_bytes: 256 * 1024, raw: true })) };
    if (op === 'resize') return { ok: true, ...m.resize(id, { cols: v.cols, rows: v.rows }) };
    if (op === 'stop') return { ok: true, ...(await m.stop(id, { force: true })) };
    if (op === 'list') return { ok: true, sessions: m.list() };
    throw new Error('Unknown terminal operation.');
  }

  return { run, close: () => { if (local) local.closeAll(); }, get localManager() { return local; } };
}

function setupTerminalWindow({ BrowserWindow, ipcMain, getRemote = () => null, icon, rendererSandbox = () => true, backend: injected } = {}) {
  let win = null;
  const backend = injected || createTerminalBackend({ remote: { computersRequest: (...a) => { const r = getRemote(); if (!r || typeof r.computersRequest !== 'function') throw new Error('Connect to the VPS to open its terminal.'); return r.computersRequest(...a); } } });

  ipcMain.handle('intelio-terminal', async (event, target, op, value) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) throw new Error('Not allowed.');
    return backend.run(String(target), String(op), value);
  });

  function open(target = 'local') {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      win.webContents.send('intelio-terminal:open', TARGETS.includes(target) ? target : 'local');
      return;
    }
    win = new BrowserWindow({
      width: 980,
      height: 640,
      minWidth: 520,
      minHeight: 320,
      title: 'intelio terminal',
      backgroundColor: '#0d0d10',
      ...(icon ? { icon } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: rendererSandbox() },
    });
    win.removeMenu?.();
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.loadFile(path.join(__dirname, '..', '..', 'terminal.html'), { query: { target: TARGETS.includes(target) ? target : 'local' } });
    win.on('closed', () => { win = null; });
  }

  return { open, close: () => { backend.close(); if (win && !win.isDestroyed()) win.destroy(); }, backend, get window() { return win; } };
}

module.exports = { setupTerminalWindow, createTerminalBackend, TARGETS };
