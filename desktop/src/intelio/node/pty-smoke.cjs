'use strict';
/**
 * Packaged-app proof that terminal sessions get a real PTY (node-pty) on this
 * platform: `intelio --smoke-test --node-pty` (windows-installer.yml runs it on
 * the NSIS build and the macOS zip). Goes through the same executor path the
 * agents use (start_session / read_output / list_sessions / stop_session) and
 * checks the shell really ran (it prints the result of arithmetic, not an echo).
 * Prints one line: `node-pty smoke {json}`; exit code 0 only when pty is true.
 */
const fs = require('node:fs');
const os = require('node:os');
const { createExecutors } = require('./executors.cjs');

async function runPtySmoke({ platform = process.platform, out = process.env.INTELIO_PTY_SMOKE_OUT || '', write = (line) => process.stdout.write(line), timeoutMs = 30000 } = {}) {
  const report = { platform, arch: process.arch, electron: process.versions.electron || '', pty: false, ran: false, module: '', note: '' };
  const ex = createExecutors({ platform, home: os.homedir() });
  try {
    try {
      const main = require.resolve('node-pty');
      report.module = main.replace(/\\/g, '/');
      const unpacked = main.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      report.asar_unpacked = unpacked !== main && fs.existsSync(unpacked);
    } catch (error) { report.note = `resolve: ${error.message}`; }
    const command = platform === 'win32' ? 'Write-Output ("intelio-pty-" + (6*7))' : 'echo "intelio-pty-$((6*7))"; tty';
    const started = await ex.run('start_session', { command, cols: 100, rows: 30 });
    if (!started.ok) throw new Error(started.error);
    const info = JSON.parse(started.content[0].text);
    report.pty = info.pty === true;
    if (info.note) report.note = info.note;
    let cursor = 0;
    let text = '';
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const read = await ex.run('read_output', { session_id: info.session_id, since: cursor, wait_ms: 2000 });
      if (!read.ok) throw new Error(read.error);
      const meta = JSON.parse(read.content[0].text);
      text += read.content[1].text;
      cursor = meta.cursor;
      if (/intelio-pty-42/.test(text) && (meta.exited || platform === 'win32' || /\/dev\//.test(text))) break;
      if (meta.exited) break;
    }
    report.ran = /intelio-pty-42/.test(text);
    if (platform !== 'win32') report.tty = (/(\/dev\/\S+)/.exec(text) || [])[1] || '';
    const listed = await ex.run('list_sessions', {});
    report.listed = listed.ok ? JSON.parse(listed.content[0].text).sessions.length : -1;
    await ex.run('stop_session', { session_id: info.session_id, force: true });
  } catch (error) {
    report.note = `${report.note ? `${report.note}; ` : ''}${String(error && error.message || error).slice(0, 300)}`;
  } finally {
    try { ex.closeSessions(); } catch { /* closing */ }
  }
  const line = `node-pty smoke ${JSON.stringify(report)}\n`;
  write(line);
  if (out) { try { fs.writeFileSync(out, line); } catch { /* best effort */ } }
  return report.pty && report.ran ? 0 : 1;
}

module.exports = { runPtySmoke };
