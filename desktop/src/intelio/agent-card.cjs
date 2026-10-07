'use strict';
/**
 * Read-only agent profile card for the four VPS harness profiles.
 * Phone numbers and titles come from the profile config when it has them.
 * Known numbers are only the fallback. Secrets, tokens, and keys are dropped.
 */

const fs = require('node:fs');
const path = require('node:path');

const HARNESS = ['intelio', 'prc', 'alignment', 'hhp'];
const NAMES = { intelio: 'Intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
const KNOWN_PHONES = {
  intelio: '+16282679185',
  prc: '+16282647656',
  alignment: '+14152023198',
  hhp: '+14156056081',
};
const EFFORTS = ['auto', 'low', 'medium', 'high'];
const CHANNELS = [
  { id: 'telegram', label: 'Telegram', keys: ['telegram'] },
  { id: 'imessage', label: 'iMessage', keys: ['imessage', 'photon'] },
  { id: 'email', label: 'Email', keys: ['email', 'mail'] },
  { id: 'slack', label: 'Slack', keys: ['slack'] },
  { id: 'discord', label: 'Discord', keys: ['discord'] },
  { id: 'whatsapp', label: 'WhatsApp', keys: ['whatsapp'] },
];
const SECRET_KEY = /(^|[._-])(key|token|secret|password|passwd|api_key|apikey|authorization|private|credential)($|[._-])/i;
const SECRET_VALUE = /bearer\s+\S+|sk-[a-z0-9]{8,}|-----BEGIN |api[_-]?key\s*[:=]/i;

function harnessId(id) {
  const value = String(id || '').trim().toLowerCase();
  return HARNESS.includes(value) ? value : '';
}

function unquote(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '').trim();
}

function secretPath(keyPath) {
  return String(keyPath || '').split('.').some((part) => SECRET_KEY.test(part));
}

function looksSecret(value) {
  const text = String(value || '');
  if (!text || text.length > 400) return SECRET_VALUE.test(text);
  return SECRET_VALUE.test(text);
}

function parseConfig(text) {
  const scalars = [];
  const lists = {};
  const stack = [];
  let reasoningLine = false;
  let hasModel = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)?.[0].length || 0;
    const item = raw.match(/^(\s*)-\s+(.*)$/);
    if (item) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const keyPath = stack.map((row) => row.key).join('.');
      const value = unquote(item[2].replace(/\s+#.*$/, ''));
      if (keyPath && value && !secretPath(keyPath) && !looksSecret(value)) {
        if (!lists[keyPath]) lists[keyPath] = [];
        lists[keyPath].push(value.slice(0, 80));
      }
      continue;
    }
    const kv = raw.match(/^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = kv[2];
    const rest = kv[3].trim();
    const keyPath = [...stack.map((row) => row.key), key].join('.');
    if (key === 'model') hasModel = true;
    if (key === 'reasoning_effort' || key === 'reasoning') reasoningLine = true;
    if (!rest || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      stack.push({ indent, key });
      continue;
    }
    const value = unquote(rest.replace(/\s+#.*$/, ''));
    if (!secretPath(keyPath) && !looksSecret(value)) scalars.push({ path: keyPath, value: value.slice(0, 240) });
  }
  return { scalars, lists, reasoningLine, hasModel };
}

function findScalar(parsed, pattern) {
  return parsed.scalars.find((row) => pattern.test(row.path) && row.value) || null;
}

function phoneFrom(parsed, id) {
  const hit = findScalar(parsed, /phone|imessage|photon|sms|twilio|mobile/i);
  const raw = hit?.value || '';
  const match = String(raw).match(/\+\d{10,15}/);
  if (match) return match[0];
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return KNOWN_PHONES[id] || '';
}

function emailFrom(parsed) {
  const hit = findScalar(parsed, /(^|\.)email$|(^|\.)mail$/i);
  const value = hit?.value || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
}

function titleFrom(parsed) {
  const hit = findScalar(parsed, /(^|\.)(title|role|subtitle)$/i);
  return hit ? hit.value.slice(0, 80) : '';
}

function effortFrom(parsed) {
  const hit = findScalar(parsed, /reasoning_effort$|reasoning\.effort$|(^|\.)reasoning$/i);
  const value = String(hit?.value || '').trim().toLowerCase();
  return EFFORTS.includes(value) ? value : 'auto';
}

function usesFrom(parsed) {
  const names = [];
  for (const [keyPath, items] of Object.entries(parsed.lists)) {
    if (!/toolset|tools|skills/i.test(keyPath)) continue;
    for (const item of items) {
      const name = String(item || '').trim();
      if (!name || secretPath(name) || looksSecret(name) || names.includes(name)) continue;
      names.push(name.slice(0, 40));
    }
  }
  return names.slice(0, 12).map((name) => ({ name }));
}

function channelState(parsed, keys) {
  const paths = [
    ...parsed.scalars.map((row) => row.path),
    ...Object.keys(parsed.lists),
  ];
  return paths.some((keyPath) => keys.some((key) => keyPath === key || keyPath.startsWith(`${key}.`) || keyPath.includes(`.${key}.`) || keyPath.endsWith(`.${key}`)));
}

function channelsFrom(parsed, phone, email) {
  return CHANNELS.map((channel) => {
    const connected = channelState(parsed, channel.keys);
    let state = connected ? 'connected' : 'off';
    let detail = connected ? 'Connected' : 'Not connected';
    if (channel.id === 'imessage') {
      detail = phone || detail;
      if (phone) state = connected ? 'connected' : 'connected';
    }
    if (channel.id === 'email') detail = email || detail;
    if (channel.id === 'whatsapp' && !connected) {
      state = 'soon';
      detail = 'Coming soon';
    }
    return { id: channel.id, label: channel.label, state, detail };
  });
}

function redactMemory(text) {
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const key = line.split(/[:=]/, 1)[0].trim();
    if (looksSecret(line) || (SECRET_KEY.test(key) && /[:=]/.test(line))) continue;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, 60000);
}

function memoryFrom(userText, memoryText) {
  const user = redactMemory(userText);
  const memory = redactMemory(memoryText);
  const parts = [];
  if (user) parts.push(`USER\n${user}`);
  if (memory) parts.push(`MEMORY\n${memory}`);
  return parts.join('\n\n').slice(0, 60000);
}

function normalizeJobs(json) {
  const list = Array.isArray(json) ? json : (Array.isArray(json?.jobs) ? json.jobs : (Array.isArray(json?.data) ? json.data : []));
  return list.slice(0, 40).map((item) => ({
    name: String(item?.name || item?.title || 'Scheduled job').slice(0, 120),
    schedule: String(item?.schedule || item?.cron || item?.cadence || '').slice(0, 80),
    status: String(item?.state || item?.status || '').slice(0, 40),
  })).filter((item) => item.name);
}

function formatPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return String(raw || '');
}

function buildCard({ id, name, configText = '', userText = '', memoryText = '', jobs = null, computer = null, paused = false } = {}) {
  const profile = harnessId(id);
  if (!profile) return null;
  const parsed = parseConfig(configText);
  const phone = phoneFrom(parsed, profile);
  const email = emailFrom(parsed);
  const display = NAMES[profile];
  const label = String(name || '').trim() || display;
  const status = computer?.status === 'running' ? 'running' : 'stopped';
  const contact = [label, formatPhone(phone), email].filter(Boolean).join('\n');
  return {
    id: profile,
    name: display,
    title: titleFrom(parsed),
    phone,
    phoneLabel: formatPhone(phone),
    email,
    computer: { status, label: status === 'running' ? 'Running' : 'Stopped' },
    uses: usesFrom(parsed),
    thinking: effortFrom(parsed),
    thinkingWritable: Boolean(parsed.reasoningLine || parsed.hasModel),
    worksOn: 'cloud',
    worksOnWritable: false,
    routines: normalizeJobs(jobs),
    channels: channelsFrom(parsed, formatPhone(phone), email),
    phoneSoon: !channelState(parsed, ['twilio', 'voice']),
    memory: memoryFrom(userText, memoryText),
    paused: paused === true,
    contact,
  };
}

function applyReasoning(configText, effort) {
  const next = EFFORTS.includes(effort) ? effort : '';
  if (!next) return null;
  const text = String(configText || '');
  if (/^\s*reasoning_effort\s*:/m.test(text)) {
    return text.replace(/^(\s*)reasoning_effort\s*:.*/m, `$1reasoning_effort: ${next}`);
  }
  if (/^\s*reasoning\s*:/m.test(text) && !/reasoning_effort/.test(text)) {
    return text.replace(/^(\s*)reasoning\s*:.*/m, `$1reasoning_effort: ${next}`);
  }
  const model = /^([ \t]*)model\s*:\s*$/m.exec(text);
  if (!model) return null;
  const pad = `${model[1]}  `;
  const line = `${model[0]}\n${pad}reasoning_effort: ${next}`;
  return text.replace(model[0], line);
}

function readProfileFiles(root, id, fsImpl = fs) {
  const profile = harnessId(id);
  if (!profile) return null;
  const dir = path.join(root, profile);
  const read = (name) => {
    try {
      const file = path.join(dir, name);
      const st = fsImpl.statSync(file);
      if (!st.isFile() || st.size > 200000) return '';
      return fsImpl.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  let paused = false;
  try { paused = fsImpl.readFileSync(path.join(dir, 'intelio-paused'), 'utf8').trim() === '1'; } catch { paused = false; }
  let computer = 'stopped';
  try {
    const cdp = fsImpl.readFileSync(path.join(dir, 'bot-desktop', 'cdp.url'), 'utf8').trim();
    if (cdp) computer = 'running';
  } catch { computer = 'stopped'; }
  return {
    configText: read('config.yaml'),
    userText: read('USER.md'),
    memoryText: read('MEMORY.md'),
    paused,
    computer: { status: computer },
  };
}

function writePaused(root, id, paused, fsImpl = fs) {
  const profile = harnessId(id);
  if (!profile) return false;
  const dir = path.join(root, profile);
  fsImpl.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'intelio-paused');
  if (paused) fsImpl.writeFileSync(file, '1\n', { mode: 0o600 });
  else {
    try { fsImpl.unlinkSync(file); } catch { /* already clear */ }
  }
  return true;
}

function writeReasoning(root, id, effort, fsImpl = fs) {
  const profile = harnessId(id);
  if (!profile) return { ok: false, readOnly: true };
  const file = path.join(root, profile, 'config.yaml');
  let text = '';
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch { return { ok: false, readOnly: true }; }
  const next = applyReasoning(text, effort);
  if (next == null) return { ok: false, readOnly: true };
  fsImpl.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
  return { ok: true, readOnly: false, thinking: effort };
}

module.exports = {
  HARNESS,
  NAMES,
  KNOWN_PHONES,
  EFFORTS,
  harnessId,
  parseConfig,
  buildCard,
  applyReasoning,
  readProfileFiles,
  writePaused,
  writeReasoning,
  redactMemory,
  formatPhone,
};
