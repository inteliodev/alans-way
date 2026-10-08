'use strict';
/**
 * Packaging prep for node-pty (intelio node terminal sessions, docs/intelio-node.md).
 * Run from desktop/ before electron-builder / electron-packager.
 *
 * - node-pty 1.1.0 ships prebuilds/darwin-* /spawn-helper without the execute
 *   bit; the macOS PTY backend cannot start a process without it. zip -y in
 *   scripts/zip-mac-app.cjs keeps the mode.
 * - Fails loudly when the prebuilt binaries the installers rely on are missing
 *   (win32-x64 for the NSIS build, darwin-arm64 for the mac zip).
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const required = {
  'win32-x64': ['pty.node', 'conpty.node', 'conpty_console_list.node'],
  'darwin-arm64': ['pty.node', 'spawn-helper'],
};

let missing = [];
for (const [dir, files] of Object.entries(required)) {
  for (const file of files) {
    const full = path.join(root, 'prebuilds', dir, file);
    if (!fs.existsSync(full)) missing.push(path.relative(process.cwd(), full));
  }
}
if (missing.length) {
  process.stderr.write(`node-pty prebuilds missing (npm ci first?):\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}
for (const dir of ['darwin-arm64', 'darwin-x64']) {
  const helper = path.join(root, 'prebuilds', dir, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
missing = null;
process.stdout.write('node-pty prebuilds ok (win32-x64, darwin-arm64); spawn-helper is executable\n');
