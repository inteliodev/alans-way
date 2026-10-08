'use strict';
/**
 * intelio activity log: a small append-only JSONL file the intelio plugin layer owns
 * (default ~/.config/intelio/activity.jsonl, chmod 600). Nothing here touches Hermes.
 *
 * Any intelio feature (account sign-ins, vault fills, the computer connector, terminals)
 * can record what it did:
 *
 *   const { appendActivity } = require('./activity-log.cjs');
 *   appendActivity({ profile: 'prc', kind: 'vault', action: 'fill', summary: 'Filled login on app.box.com' });
 *
 * Event schema (version 1), one JSON object per line:
 *   v        1
 *   ts       ISO-8601 UTC time the event happened (filled in when missing)
 *   profile  Hermes profile slug the event belongs to ('' when it is not agent-specific)
 *   kind     one of KINDS: github, claude, codex, terminal, browser, connector, vault, signin, account, other
 *   action   short verb, [a-z0-9-], e.g. push, pr, gh, run, command, fill, started, signed-in, assign
 *   summary  one line for people, at most 300 chars; secrets are redacted before writing
 *   account  optional account label, e.g. 'claude:work' or 'github:inteliodev'
 *   ok       optional boolean outcome
 *   actor    optional 'agent' | 'user' | 'intelio'
 *   session  optional Hermes session id ([A-Za-z0-9_-], 80 chars max)
 *   source   'intelio' for this file; events read from Hermes transcripts carry 'hermes'
 *
 * Redaction runs on every string field when writing and again when reading, so a token
 * pasted into a command line never lands in the file or on screen.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KINDS = ['github', 'claude', 'codex', 'terminal', 'browser', 'connector', 'vault', 'signin', 'account', 'other'];
const ACTORS = ['agent', 'user', 'intelio'];
const SUMMARY_MAX = 300;
const ROTATE_BYTES = 8 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;

function activityFile(home = os.homedir()) {
  return process.env.INTELIO_ACTIVITY_FILE || path.join(home, '.config', 'intelio', 'activity.jsonl');
}

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passphrase|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|session[_-]?key|auth[_-]?token|otp|cookie)[A-Za-z0-9_.-]*';
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]'],
  [/(authorization\s*[:=]\s*)(?:bearer|token|basic)?\s*[^\s"']+/gi, '$1[redacted]'],
  [/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [new RegExp(`(--?${SECRET_NAME})(\\s*=\\s*|\\s+)("[^"]*"|'[^']*'|[^\\s&;|]+)`, 'gi'), '$1$2[redacted]'],
  [new RegExp(`(\\b${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s&;|,}]+)`, 'gi'), '$1$2[redacted]'],
  [/([?&](?:code|token|access_token|refresh_token|id_token|key|sig|signature|password)=)[^&\s"']+/gi, '$1[redacted]'],
];

/** Mixed-case-and-digit runs of 32+ chars look like keys; plain hex (git SHAs) and paths are kept. */
function looksLikeKey(run) {
  return run.length >= 32 && /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

function redact(value) {
  let text = String(value == null ? '' : value);
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement);
  text = text.replace(/[A-Za-z0-9+_=-]{32,}/g, (run) => (looksLikeKey(run) ? '[redacted]' : run));
  return text;
}

function oneLine(value, max = SUMMARY_MAX) {
  const text = redact(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cleanAction(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event';
}

/** Validate and redact one event. Returns null when it cannot be stored. */
function normalizeEvent(raw = {}, { now = Date.now, source = 'intelio' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'other';
  const summary = oneLine(raw.summary || '');
  if (!summary) return null;
  const when = raw.ts ? Date.parse(raw.ts) : now();
  const ts = new Date(Number.isFinite(when) ? when : now()).toISOString();
  const profile = SLUG.test(String(raw.profile || '')) ? String(raw.profile) : '';
  const event = { v: 1, ts, profile, kind, action: cleanAction(raw.action), summary, source: raw.source === 'hermes' ? 'hermes' : source };
  if (raw.account) event.account = oneLine(raw.account, 120);
  if (typeof raw.ok === 'boolean') event.ok = raw.ok;
  if (ACTORS.includes(raw.actor)) event.actor = raw.actor;
  if (raw.session && SESSION.test(String(raw.session))) event.session = String(raw.session);
  if (raw.tool) event.tool = oneLine(raw.tool, 60);
  return event;
}

function ensurePrivateFile(file, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const stat = fsImpl.statSync(file);
    if (stat.size > ROTATE_BYTES) fsImpl.renameSync(file, `${file}.1`);
  } catch { /* new file */ }
}

/**
 * Append one event. Never throws: the log is best effort and must not break the feature
 * that writes it. Returns the stored event or null.
 */
function appendActivity(raw, { file = activityFile(), now = Date.now, fsImpl = fs } = {}) {
  const event = normalizeEvent(raw, { now });
  if (!event) return null;
  try {
    ensurePrivateFile(file, fsImpl);
    fsImpl.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: 'a' });
    try { fsImpl.chmodSync(file, 0o600); } catch { /* best effort */ }
    return event;
  } catch {
    return null;
  }
}

function tailText(file, fsImpl) {
  let fd = null;
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || !stat.size) return '';
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    fd = fsImpl.openSync(file, 'r');
    fsImpl.readSync(fd, buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== null) try { fsImpl.closeSync(fd); } catch { /* closed */ }
  }
}

/** Newest first. Each event is re-validated and re-redacted on the way out. */
function readActivity({ file = activityFile(), limit = 500, fsImpl = fs } = {}) {
  const rows = [];
  for (const line of tailText(file, fsImpl).split('\n')) {
    if (!line.trim()) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    const event = normalizeEvent(parsed, { now: () => 0 });
    if (event && event.ts !== new Date(0).toISOString()) rows.push({ ...event, source: 'intelio' });
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows.slice(0, Math.max(1, Math.min(Number(limit) || 500, 5000)));
}

/** What a shell command line is, for the activity list. */
function classifyCommand(command) {
  const text = String(command || '');
  const at = (word) => new RegExp(`(^|[\\s;&|(\`])${word}(?=\\s|$)`).test(text);
  if (/(^|[\s;&|(])git\s+push\b/.test(text)) return { kind: 'github', action: 'push' };
  if (/(^|[\s;&|(])gh\s+pr\b/.test(text)) return { kind: 'github', action: 'pr' };
  if (/(^|[\s;&|(])gh\s+/.test(text)) return { kind: 'github', action: 'gh' };
  if (/(^|[\s;&|(])git\s+(clone|pull|fetch)\b/.test(text) && /github\.com|origin/.test(text)) return { kind: 'github', action: 'git' };
  if (at('claude')) return { kind: 'claude', action: 'run' };
  if (at('codex')) return { kind: 'codex', action: 'run' };
  return { kind: 'terminal', action: 'command' };
}

/** Filter a merged list for the Settings > Activity view. */
function filterActivity(rows, { profile = '', kind = '', query = '', limit = 200 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const kinds = String(kind || '').split(',').map((k) => k.trim()).filter((k) => KINDS.includes(k));
  return rows.filter((row) => (!profile || row.profile === profile)
    && (!kinds.length || kinds.includes(row.kind))
    && (!q || `${row.summary} ${row.action} ${row.account || ''} ${row.profile}`.toLowerCase().includes(q)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

module.exports = { KINDS, activityFile, redact, oneLine, normalizeEvent, appendActivity, readActivity, classifyCommand, filterActivity };
