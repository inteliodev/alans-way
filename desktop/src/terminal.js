// intelio Terminal window: "This computer" and "cloud" (the VPS) tabs. See intelio/terminal/main.cjs.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';

const api = window.intelioTerminal;
const statusEl = document.getElementById('status');
const tabs = {};

function createTab(target) {
  const pane = document.getElementById(`pane-${target}`);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#17171c', foreground: '#e5e5ee', cursor: '#e5e5ee', selectionBackground: '#3a3a48', scrollbarSliderBackground: '#ffffff1f', scrollbarSliderHoverBackground: '#ffffff33', scrollbarSliderActiveBackground: '#ffffff44', overviewRulerBorder: '#17171c' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const tab = { target, pane, term, fit, id: '', cursor: 0, alive: false, opened: false, status: '', gen: 0, queue: '', sending: false };

  term.onData((data) => {
    if (!tab.alive) { if (data === '\r') start(tab); return; }
    tab.queue += data;
    flush(tab);
  });
  term.onResize(({ cols, rows }) => { if (tab.alive) api.run(target, 'resize', { session_id: tab.id, cols, rows }).catch(() => {}); });
  return tab;
}

async function flush(tab) {
  if (tab.sending || !tab.queue) return;
  tab.sending = true;
  try {
    while (tab.queue && tab.alive) {
      const data = tab.queue;
      tab.queue = '';
      await api.run(tab.target, 'input', { session_id: tab.id, data });
    }
  } catch (error) {
    setStatus(tab, `Typing failed: ${clean(error)}`);
  } finally { tab.sending = false; }
}

const clean = (error) => String(error && error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

function setStatus(tab, text) {
  tab.status = text;
  if (current === tab.target) statusEl.textContent = text;
}

async function start(tab) {
  const gen = ++tab.gen;
  tab.alive = false;
  tab.cursor = 0;
  tab.term.reset();
  setStatus(tab, 'Starting…');
  try {
    tab.fit.fit();
    const started = await api.run(tab.target, 'start', { cols: tab.term.cols, rows: tab.term.rows });
    if (gen !== tab.gen) return;
    tab.id = started.session_id;
    tab.alive = true;
    const where = tab.target === 'cloud' ? 'the intelio VPS' : 'this computer';
    setStatus(tab, `${where}${started.pty ? '' : ' · basic mode (no full terminal here)'}`);
    tab.term.focus();
    pump(tab, gen);
  } catch (error) {
    if (gen !== tab.gen) return;
    tab.term.write(`\r\n\x1b[2m${clean(error)}\x1b[0m\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n`);
    setStatus(tab, 'Not connected.');
  }
}

async function pump(tab, gen) {
  let failures = 0;
  while (tab.alive && gen === tab.gen) {
    try {
      const out = await api.run(tab.target, 'read', { session_id: tab.id, since: tab.cursor, wait_ms: 15000 });
      if (gen !== tab.gen) return;
      failures = 0;
      if (out.output) tab.term.write(out.output);
      tab.cursor = out.cursor;
      if (out.exited) {
        tab.alive = false;
        tab.term.write(`\r\n\x1b[2m[ended${out.exit_code !== null && out.exit_code !== undefined ? `, exit ${out.exit_code}` : ''}] Press Enter for a new session.\x1b[0m\r\n`);
        setStatus(tab, 'Ended.');
        return;
      }
    } catch (error) {
      failures += 1;
      if (failures >= 3) {
        tab.alive = false;
        tab.term.write(`\r\n\x1b[2m${clean(error)}\r\nPress Enter for a new session.\x1b[0m\r\n`);
        setStatus(tab, 'Disconnected.');
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 * failures));
    }
  }
}

let current = '';
function show(target) {
  if (!tabs[target]) tabs[target] = createTab(target);
  current = target;
  for (const t of ['local', 'cloud']) {
    document.getElementById(`tab-${t}`).setAttribute('aria-selected', String(t === target));
    document.getElementById(`pane-${t}`).classList.toggle('active', t === target);
  }
  const tab = tabs[target];
  if (!tab.opened) { tab.term.open(tab.pane); tab.opened = true; start(tab); }
  requestAnimationFrame(() => { try { tab.fit.fit(); } catch { /* hidden */ } tab.term.focus(); });
  statusEl.textContent = tab.status;
}

for (const button of document.querySelectorAll('.term-tab')) button.addEventListener('click', () => show(button.dataset.target));
document.getElementById('restart').addEventListener('click', async () => {
  const tab = tabs[current];
  if (!tab) return;
  const old = tab.id;
  tab.alive = false;
  if (old) api.run(tab.target, 'stop', { session_id: old }).catch(() => {});
  start(tab);
});
window.addEventListener('resize', () => { const tab = tabs[current]; if (tab) { try { tab.fit.fit(); } catch { /* hidden */ } } });
window.addEventListener('beforeunload', () => {
  for (const tab of Object.values(tabs)) if (tab.alive && tab.id) api.run(tab.target, 'stop', { session_id: tab.id }).catch(() => {});
});
api.onOpen((target) => show(target));
show(new URLSearchParams(location.search).get('target') === 'cloud' ? 'cloud' : 'local');
