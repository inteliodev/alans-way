#!/usr/bin/env node
// Keep the configured Chromium available independently of the tab broker.
// Some Linux launchers return immediately when Chromium is already running.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertLoopbackBrowser } = require('../src/intelio/sidecar.cjs');
const root =
  process.env.HERMES_VPS_BROWSER_DATA || path.join(os.homedir(), '.local', 'share', 'hermes-alans-way', 'browser');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
assertLoopbackBrowser(config);
const endpoint = new URL(config.cdpUrl);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')
  throw new Error('Use loopback Chromium debugging.');
async function available() {
  try {
    const r = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}
async function ensure() {
  if (await available()) return;
  if (!config.browserCommand) throw new Error('Configure browserCommand and browserArgs for the managed Chromium.');
  const child = spawn(config.browserCommand, config.browserArgs || [], { stdio: 'ignore' });
  let launchError = false;
  child.on('error', () => {
    launchError = true;
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await available()) return;
    if (launchError) break;
  }
  throw new Error('Configured Chromium did not become available.');
}
async function run() {
  await ensure();
  process.stderr.write('Managed Chromium available on loopback.\n');
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await ensure();
    } catch (error) {
      process.stderr.write(error.message + '\n');
      process.exit(1);
    } finally {
      busy = false;
    }
  }, 3000);
}
run().catch((error) => {
  process.stderr.write(error.message + '\n');
  process.exit(1);
});
