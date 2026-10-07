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
const { excludedAgent, cleanColor } = require('../../desktop/src/intelio/agent-card.cjs');
const { ORB_IDS } = require('../../desktop/src/intelio/orb-signature.cjs');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const TEMPLATE = 'intelio';
const ORBS = ORB_IDS;
const GATEWAY_NOTE = 'Ready after the next agent restart';
const SIGN_IN_NOTE = 'Needs sign-in. This profile has no model credential of its own. The ChatGPT/Codex login stays in ~/.hermes/auth.json, which this app does not read, copy, or change, and it does not run hermes auth. Sign in on the VPS for this agent.';
const SHARED_PROVIDERS = new Set(['openai-codex', 'openai_codex', 'codex', 'chatgpt']);

function assertSlug(name) {
  const slug = String(name || '').trim().toLowerCase();
  if (!slug || slug.length > 32 || !SLUG.test(slug)) {
    throw Object.assign(new Error('Use a lowercase name: letters, numbers, and hyphens, up to 32 characters.'), { status: 400 });
  }
  if (slug === 'default') throw Object.assign(new Error('That name is reserved.'), { status: 400 });
  return slug;
}

const DISPLAY_NAMES = {
  intelio: 'intelio',
  prc: 'PRC',
  alignment: 'Alignment',
  hhp: 'HHP',
};

function displayName(slug) {
  const id = String(slug || '').trim().toLowerCase();
  if (DISPLAY_NAMES[id]) return DISPLAY_NAMES[id];
  return id.split('-').filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
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
    return [...names].filter((id) => !excludedAgent(id)).sort().map((id) => {
      const marker = readMarker(path.join(root, id), fsImpl);
      return {
        id,
        name: displayName(id),
        description: readDescription(path.join(root, id), fsImpl),
        status: 'online',
        orb: marker.orb,
        color: marker.color,
        title: marker.title,
        needsSignIn: marker.needsSignIn,
        gatewayNote: marker.gatewayNote,
      };
    });
  });
}

function readMarker(dir, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path.join(dir, 'intelio-card.json'), 'utf8'));
    const orb = ORBS.includes(parsed?.orb) ? parsed.orb : '';
    return {
      orb,
      color: cleanColor(parsed?.color),
      needsSignIn: parsed?.needsSignIn === true,
      gatewayNote: String(parsed?.gatewayNote || '').slice(0, 160),
      title: String(parsed?.title || '').slice(0, 80),
    };
  } catch {
    return { orb: '', color: '', needsSignIn: false, gatewayNote: '', title: '' };
  }
}

function cleanOrb(value, slug) {
  const orb = String(value || '').trim().toLowerCase();
  if (ORBS.includes(orb)) return orb;
  const { signatureOf } = require('../../desktop/src/intelio/orb-signature.cjs');
  const picked = signatureOf(slug);
  return ORBS.includes(picked) ? picked : 'working';
}

function modelFrom(text) {
  let provider = '';
  let model = '';
  let secret = false;
  let inModel = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*model\s*:/.test(raw) && !raw.startsWith(' ')) {
      inModel = true;
      continue;
    }
    if (!inModel) continue;
    if (raw.trim() && !/^\s/.test(raw)) { inModel = false; continue; }
    if (/(api[_-]?key|token|secret|password|credential)\s*:/i.test(raw)) secret = true;
    const providerLine = raw.match(/^\s*provider\s*:\s*(.+)$/);
    if (providerLine) provider = providerLine[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 80);
    const modelLine = raw.match(/^\s*(?:default|name|model)\s*:\s*(.+)$/);
    if (modelLine && !model) model = modelLine[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 80);
  }
  return { provider, model, secret };
}

function toolsetsFrom(text) {
  const found = [];
  let inTools = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (/^\s*platform_toolsets\s*:/.test(raw)) { inTools = true; continue; }
    if (!inTools) continue;
    if (raw.trim() && !/^\s/.test(raw)) break;
    if (/^\s*(telegram|photon|imessage|slack|discord|whatsapp|email|mail|sms|signal)\s*:/i.test(raw)) continue;
    const item = raw.match(/^\s*-\s+([A-Za-z0-9_-]+)\s*$/);
    if (!item) continue;
    const name = item[1].slice(0, 40);
    if (!found.includes(name)) found.push(name);
  }
  if (!found.includes('intelio')) found.push('intelio');
  return found.slice(0, 24);
}

function yamlQuote(value) {
  return `'${String(value || '').replace(/'/g, "''").slice(0, 80)}'`;
}

function safeConfig({ provider, model, toolsets }) {
  const lines = ['model:'];
  if (provider) lines.push(`  provider: ${yamlQuote(provider)}`);
  if (model) lines.push(`  default: ${yamlQuote(model)}`);
  lines.push('platform_toolsets:', '  cli:');
  for (const name of toolsets) lines.push(`    - ${name}`);
  lines.push('');
  return lines.join('\n');
}

function cleanSoul(value) {
  return String(value || '').split(/\r?\n/).filter((line) => {
    if (/(api[_-]?key|token|secret|password)\s*[:=]/i.test(line)) return false;
    if (/bearer\s+\S+|sk-[a-z0-9]{8,}|-----BEGIN /i.test(line)) return false;
    return true;
  }).join('\n').trim().slice(0, 8000);
}

function existsDir(fsImpl, dir) {
  if (typeof fsImpl.statSync !== 'function') return false;
  try { return Boolean(fsImpl.statSync(dir).isDirectory()); } catch { return false; }
}

function dropFile(fsImpl, file) {
  if (path.basename(file) === 'auth.json' && !file.includes(`${path.sep}profiles${path.sep}`)) return;
  if (typeof fsImpl.unlinkSync !== 'function') return;
  try { fsImpl.unlinkSync(file); } catch { /* absent */ }
}

function shapeProfile({ home, slug, title, soul, orb, color = '', fsImpl }) {
  const root = path.join(home, '.hermes', 'profiles');
  const dir = path.join(root, slug);
  const templateFile = path.join(root, TEMPLATE, 'config.yaml');
  let templateText = '';
  try { templateText = fsImpl.readFileSync(templateFile, 'utf8'); } catch { templateText = ''; }
  const model = modelFrom(templateText);
  const provider = model.provider || 'openai-codex';
  const toolsets = toolsetsFrom(templateText);
  const needsSignIn = !templateText || model.secret || !SHARED_PROVIDERS.has(provider);
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(path.join(dir, 'config.yaml'), safeConfig({
    provider: SHARED_PROVIDERS.has(provider) ? provider : '',
    model: model.secret ? '' : model.model,
    toolsets,
  }), { mode: 0o600 });
  const instructions = cleanSoul(soul);
  if (instructions) fsImpl.writeFileSync(path.join(dir, 'SOUL.md'), `${instructions}\n`, { mode: 0o600 });
  const role = cleanDescription(title);
  const chosen = cleanOrb(orb, slug);
  const tint = cleanColor(color);
  const marker = {
    title: role,
    orb: chosen,
    ...(tint ? { color: tint } : {}),
    needsSignIn,
    gatewayNote: GATEWAY_NOTE,
  };
  fsImpl.writeFileSync(path.join(dir, 'intelio-card.json'), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  if (role) {
    fsImpl.writeFileSync(path.join(dir, 'profile.yaml'), `description: ${yamlQuote(role)}\ntitle: ${yamlQuote(role)}\norb: ${chosen}\n`, { mode: 0o600 });
  }
  dropFile(fsImpl, path.join(dir, 'auth.json'));
  dropFile(fsImpl, path.join(dir, 'bot-desktop', 'allow-shared-browser'));
  const envFile = path.join(dir, '.env');
  try {
    const scrubbed = String(fsImpl.readFileSync(envFile, 'utf8')).split(/\r?\n/).filter((line) => line && !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(line.split('=')[0] || '')).join('\n');
    fsImpl.writeFileSync(envFile, scrubbed ? `${scrubbed}\n` : '', { mode: 0o600 });
  } catch { /* no env yet */ }
  return { needsSignIn, orb: chosen, title: role, provider };
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
  title = '',
  soul = '',
  orb = '',
  color = '',
  home = os.homedir(),
  run = runCommand,
  fsImpl = fs,
} = {}) {
  const slug = assertSlug(name);
  if (excludedAgent(slug)) throw Object.assign(new Error('That name is reserved.'), { status: 400 });
  const summary = cleanDescription(title || description);
  const dir = path.join(home, '.hermes', 'profiles', slug);
  if (existsDir(fsImpl, dir)) throw Object.assign(new Error('That agent already exists.'), { status: 409 });
  const args = ['profile', 'create', slug, '--no-alias'];
  if (summary) args.push('--description', summary);
  args.push('--clone-from', TEMPLATE);
  const created = await run('hermes', args);
  if (!created || created.code !== 0) {
    const detail = `${created?.stderr || ''} ${created?.stdout || ''}`;
    if (/exist/i.test(detail)) throw Object.assign(new Error('That agent already exists.'), { status: 409 });
    throw Object.assign(new Error('Could not create that agent.'), { status: 502 });
  }
  const describeArgs = ['profile', 'describe', slug];
  if (summary) describeArgs.push('--text', summary);
  await run('hermes', describeArgs);
  const shaped = shapeProfile({ home, slug, title: summary, soul, orb, color, fsImpl });
  writeFreshKey(path.join(dir, '.env'), fsImpl);
  return {
    id: slug,
    name: displayName(slug),
    description: summary,
    title: shaped.title,
    orb: shaped.orb,
    needsSignIn: shaped.needsSignIn,
    signInNote: shaped.needsSignIn ? SIGN_IN_NOTE : '',
    gatewayNote: GATEWAY_NOTE,
    needsGatewayRestart: true,
  };
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
  shapeProfile,
  GATEWAY_NOTE,
  SIGN_IN_NOTE,
};
