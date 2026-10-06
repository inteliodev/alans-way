'use strict';
/**
 * Hermes profiles for the phone client.
 * API keys are written into the new profile's .env (mode 600) and never returned.
 * This module does not read, copy, or rewrite auth.json, and it never runs
 * a `hermes auth` command. Codex sign-in stays on the shared default profile;
 * the new profile only points at it from config.yaml.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function assertSlug(name) {
  const slug = String(name || '').trim().toLowerCase();
  if (!slug || slug.length > 32 || !SLUG.test(slug)) {
    throw Object.assign(new Error('Use a lowercase name: letters, numbers, and hyphens, up to 32 characters.'), { status: 400 });
  }
  if (slug === 'default') throw Object.assign(new Error('That name is reserved.'), { status: 400 });
  return slug;
}

function displayName(slug) {
  return String(slug || '').split('-').filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

function runCommand(bin, args, timeoutMs = 20000) {
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

function slugsFromList(stdout) {
  const found = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const token = line.replace(/[*★]/g, ' ').trim().split(/\s+/)[0] || '';
    const slug = token.toLowerCase();
    if (!slug || slug === 'default' || !SLUG.test(slug) || found.includes(slug)) continue;
    found.push(slug);
  }
  return found;
}

function readDescription(dir, fsImpl) {
  const file = path.join(dir, 'profile.yaml');
  try {
    const text = fsImpl.readFileSync(file, 'utf8');
    const match = text.match(/^description:\s*(.*)$/m);
    if (!match) return '';
    return match[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 240);
  } catch {
    return '';
  }
}

function listProfiles({ home = os.homedir(), run = runCommand, fsImpl = fs } = {}) {
  const root = path.join(home, '.hermes', 'profiles');
  const names = new Set();
  try {
    for (const entry of fsImpl.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const slug = entry.name.toLowerCase();
      if (slug === 'default' || !SLUG.test(slug)) continue;
      names.add(slug);
    }
  } catch { /* no profile directory yet */ }
  return run('hermes', ['profile', 'list']).then((result) => {
    if (result && result.code === 0) for (const slug of slugsFromList(result.stdout)) names.add(slug);
    return [...names].sort().map((id) => ({
      id,
      name: displayName(id),
      description: readDescription(path.join(root, id), fsImpl),
      status: 'online',
    }));
  });
}

function cleanDescription(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 240);
}

function writeFreshKey(file, fsImpl, randomBytes = (n) => crypto.randomBytes(n)) {
  let text = '';
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch { text = ''; }
  const kept = text.split(/\r?\n/).filter((line) => line && !/^\s*(?:export\s+)?API_SERVER_KEY\s*=/.test(line));
  const key = randomBytes(32).toString('hex');
  kept.push(`API_SERVER_KEY=${key}`);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${kept.join('\n')}\n`, { mode: 0o600 });
  fsImpl.chmodSync(file, 0o600);
}

async function createProfile({
  name,
  description = '',
  cloneFrom = '',
  home = os.homedir(),
  run = runCommand,
  fsImpl = fs,
} = {}) {
  const slug = assertSlug(name);
  const summary = cleanDescription(description);
  let source = '';
  if (String(cloneFrom || '').trim()) {
    source = assertSlug(cloneFrom);
    if (source === slug) throw Object.assign(new Error('Choose a different agent to start from.'), { status: 400 });
  }
  const args = ['profile', 'create', slug, '--no-alias'];
  if (summary) args.push('--description', summary);
  if (source) args.push('--clone-from', source);
  const created = await run('hermes', args);
  if (!created || created.code !== 0) {
    throw Object.assign(new Error('Could not create that agent.'), { status: 502 });
  }
  const describeArgs = ['profile', 'describe', slug];
  if (summary) describeArgs.push('--text', summary);
  await run('hermes', describeArgs);
  const provider = await run('hermes', ['-p', slug, 'config', 'set', 'model.provider', 'openai-codex']);
  const model = await run('hermes', ['-p', slug, 'config', 'set', 'model.default', 'gpt-6-sol']);
  if (!provider || provider.code !== 0 || !model || model.code !== 0) {
    throw Object.assign(new Error('Could not set the Codex model on the new agent.'), { status: 502 });
  }
  writeFreshKey(path.join(home, '.hermes', 'profiles', slug, '.env'), fsImpl);
  return { id: slug, name: displayName(slug), description: summary, needsGatewayRestart: true };
}

async function restartGateway({ run = runCommand } = {}) {
  const result = await run('systemctl', ['--user', 'restart', 'hermes-gateway']);
  if (!result || result.code !== 0) throw Object.assign(new Error('The gateway did not restart.'), { status: 502 });
  return { ok: true };
}

module.exports = {
  assertSlug,
  displayName,
  slugsFromList,
  listProfiles,
  createProfile,
  restartGateway,
  writeFreshKey,
};
