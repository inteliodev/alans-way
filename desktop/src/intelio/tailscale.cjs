'use strict';
/** First-run Tailscale check. The download link is the only URL this module opens. */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INSTALL = {
  win32: 'https://tailscale.com/download/windows',
  darwin: 'https://tailscale.com/download/mac',
  linux: 'https://tailscale.com/download/linux',
};

function installUrl(platform = process.platform) {
  return INSTALL[platform] || INSTALL.linux;
}

function assertInstallUrl(url) {
  if (!/^https:\/\/tailscale\.com\/download(?:\/[a-z]+)?$/.test(String(url || ''))) {
    throw new Error('Unexpected Tailscale download URL.');
  }
  return url;
}

function defaultBins(platform, env = process.env) {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, 'Tailscale', 'tailscale.exe'),
      path.join(programFilesX86, 'Tailscale', 'tailscale.exe'),
      'tailscale',
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale'];
  }
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'];
}

function parseStatus(stdout) {
  let data;
  try { data = JSON.parse(String(stdout || '')); } catch {
    return { connected: false, detail: 'Tailscale is installed but its status was not readable.' };
  }
  const state = String(data.BackendState || '');
  const connected = state === 'Running';
  const dns = String(data.Self?.DNSName || '').replace(/\.$/, '');
  if (connected) return { connected: true, detail: dns ? `Tailscale is connected (${dns}).` : 'Tailscale is connected.' };
  return { connected: false, detail: `Tailscale is installed but not connected${state ? ` (${state})` : ''}. Open Tailscale and sign in.` };
}

function firstRunMessage(status) {
  const where = 'Remote Hermes starts pointed at intelio-vps.tail9c1007.ts.net port 8642, profile intelio. Paste that profile’s API key once in Settings. Windows stores it with DPAPI.';
  if (!status?.installed) {
    return { message: 'Install Tailscale to reach Hermes.', detail: `Intelio talks to the VPS Hermes over Tailscale only. ${where}`, install: true };
  }
  if (!status.connected) {
    return { message: 'Connect Tailscale to reach Hermes.', detail: `${status.detail} ${where}`, install: false };
  }
  return null;
}

function runCommand(bin, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: 127, stdout: '', stderr: '' });
      return;
    }
    const out = [];
    const err = [];
    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', () => resolve({ code: 127, stdout: '', stderr: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

async function checkTailscale({ platform = process.platform, env = process.env, bins, run = runCommand, exists = fs.existsSync } = {}) {
  const candidates = bins || defaultBins(platform, env);
  let bin = '';
  for (const candidate of candidates) {
    if ((candidate.includes('\\') || candidate.startsWith('/')) && !exists(candidate)) continue;
    const version = await run(candidate, ['version']);
    if (version.code === 0) { bin = candidate; break; }
  }
  const link = installUrl(platform);
  if (!bin) return { installed: false, connected: false, detail: 'Tailscale is not installed.', installUrl: link };
  const status = await run(bin, ['status', '--json']);
  if (status.code !== 0) {
    return { installed: true, connected: false, detail: 'Tailscale is installed but not connected. Open Tailscale and sign in.', installUrl: link };
  }
  return { installed: true, installUrl: link, ...parseStatus(status.stdout) };
}

module.exports = { installUrl, assertInstallUrl, defaultBins, parseStatus, firstRunMessage, checkTailscale };
