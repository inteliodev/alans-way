'use strict';
/**
 * "An intelio agent is using this computer" pill: a small always-on-top window
 * at the top of the screen while any agent call runs here (and a few seconds
 * after), with Stop (this computer's kill switch). Visible even when the app
 * is minimised or behind other windows. Electron is injected so tests can run
 * the state logic under plain Node.
 */
const path = require('node:path');

const LINGER_MS = 3000;
const WIDTH = 440;
const HEIGHT = 46;

const WORDS = {
  list_dir: 'looking at files',
  stat: 'looking at files',
  read_file: 'reading a file',
  search_files: 'searching files',
  write_file: 'changing a file',
  run_command: 'running a command',
  start_session: 'using the terminal',
  send_input: 'using the terminal',
  read_output: 'using the terminal',
  stop_session: 'using the terminal',
  list_sessions: 'using the terminal',
  screenshot: 'taking a screenshot',
  computer_info: 'checking this computer',
};

function describeActivity(tools) {
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  if (!list.length) return '';
  const words = [...new Set(list.map((t) => WORDS[t] || 'working'))];
  return words.slice(0, 2).join(', ');
}

function createIndicator({ BrowserWindow, ipcMain, screen, onStop = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, enabled = true } = {}) {
  let win = null;
  let hideTimer = null;
  let last = { text: '', stopped: false };

  function position() {
    try {
      const area = screen.getPrimaryDisplay().workArea;
      return { x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + 10 };
    } catch { return { x: 40, y: 10 }; }
  }

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    const at = position();
    win = new BrowserWindow({
      ...at,
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      backgroundColor: '#17171b',
      title: 'intelio',
      webPreferences: { preload: path.join(__dirname, 'indicator-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try { win.setAlwaysOnTop(true, 'floating'); win.setVisibleOnAllWorkspaces?.(true); } catch { /* platform */ }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.loadFile(path.join(__dirname, 'indicator.html'));
    win.webContents.on('did-finish-load', () => send());
    win.on('closed', () => { win = null; });
    return win;
  }

  function send() {
    if (win && !win.isDestroyed()) win.webContents.send('intelio-node-indicator:state', last);
  }

  if (ipcMain) {
    ipcMain.on('intelio-node-indicator:stop', (event) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      try { onStop(); } catch { /* ignore */ }
    });
  }

  function hideSoon(ms = LINGER_MS) {
    clearTimer(hideTimer);
    hideTimer = setTimer(() => { hideTimer = null; if (win && !win.isDestroyed()) win.hide(); }, ms);
  }

  return {
    /** active: tool names running now. */
    update(active) {
      if (!enabled) return;
      const text = describeActivity(active);
      if (text) {
        clearTimer(hideTimer);
        hideTimer = null;
        last = { text, stopped: false };
        const w = ensure();
        send();
        if (!w.isVisible()) w.showInactive();
      } else if (win && !win.isDestroyed() && win.isVisible()) hideSoon();
    },
    stopped() {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      last = { text: '', stopped: true };
      send();
      hideSoon(4000);
    },
    close() { clearTimer(hideTimer); if (win && !win.isDestroyed()) win.destroy(); win = null; },
    get window() { return win; },
  };
}

module.exports = { createIndicator, describeActivity, WORDS };
