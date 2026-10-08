'use strict';
/**
 * Plaud meeting transcripts for the Transcripts page (GET /api/transcripts).
 *
 * Read-only. integrations/plaud/plaud-ingest writes one markdown file per recording into
 * ~/.hermes/profiles/<profile>/transcripts/ (intelio gets every recording, client profiles get
 * the ones tagged for them). This module lists those files, parses the front matter and the
 * `## Summary` section (same rules as integrations/plaud/intelio-transcripts-digest) and never
 * returns the full transcript text. Parsed files are cached by size + mtime.
 */
const fs = require('node:fs');
const path = require('node:path');

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.md$/;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 40;
const SUMMARY_CHARS = 6000;
const HEAD_BYTES = 256 * 1024;

function frontMatter(text) {
  const head = text.startsWith('---') ? text.split(/\n---\s*\n/, 1)[0] : '';
  const out = {};
  for (const line of head.split(/\r?\n/)) {
    const match = /^(\w+):\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

function unquote(value) {
  return String(value || '').trim().replace(/^"(.*)"$/, '$1');
}

function clientList(raw) {
  return String(raw || '').replace(/^\[|\]$/g, '').split(',').map((item) => item.trim().toLowerCase()).filter((item) => SLUG.test(item));
}

function cleanLine(line) {
  return line.replace(/\*\*/g, '').trim();
}

/** Summary prose, action items and the summary text, from one transcript file. */
function parseTranscript(text, fileName) {
  const fm = frontMatter(text);
  const afterSummary = text.includes('## Summary') ? text.split('## Summary').slice(1).join('## Summary') : '';
  const summaryRaw = afterSummary.split('## Transcript')[0] || '';
  const lines = summaryRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const prose = lines.filter((line) => !/^(#|-|\*|\||Date of)/.test(line)).join(' ').replace(/\*\*/g, '');
  const actions = [];
  let grab = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      grab = /action|next step|to-?do|follow/i.test(line);
      continue;
    }
    if ((grab && /^[-*]/.test(line)) || /^[-*]\s*\[ \]/.test(line)) {
      const item = cleanLine(line.replace(/^[-*]\s*(\[ \]\s*)?/, ''));
      if (item) actions.push(item.slice(0, 300));
    }
  }
  const summary = summaryRaw.trim().slice(0, SUMMARY_CHARS);
  return {
    id: String(fm.plaud_id || '').slice(0, 80),
    title: unquote(fm.title) || fileName.replace(/\.md$/, ''),
    date: String(fm.date || fileName.slice(0, 10)).slice(0, 32),
    duration: String(fm.duration || '').slice(0, 32),
    clients: clientList(fm.clients),
    excerpt: prose.slice(0, 280),
    summary,
    actions: actions.slice(0, 12),
    file: fileName,
    search: `${unquote(fm.title)}\n${clientList(fm.clients).join(' ')}\n${summaryRaw}`.toLowerCase(),
  };
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const cut = text.indexOf('\n## Transcript');
    return cut === -1 ? text : text.slice(0, cut + 1);
  } finally {
    fs.closeSync(fd);
  }
}

function createTranscripts({ root }) {
  const base = path.resolve(String(root || ''));
  const cache = new Map();

  function dirFor(profile) {
    const id = String(profile || 'intelio').trim().toLowerCase();
    if (!SLUG.test(id)) throw Object.assign(new Error('Unknown profile.'), { status: 400 });
    const dir = path.join(base, id, 'transcripts');
    let real;
    try { real = fs.realpathSync(dir); } catch { return { id, dir: '' }; }
    const realBase = fs.realpathSync(base);
    if (!real.startsWith(realBase + path.sep)) return { id, dir: '' };
    return { id, dir: real };
  }

  function entriesIn(dir) {
    if (!dir) return [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const rows = [];
    for (const name of names) {
      if (!FILE.test(name)) continue;
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      rows.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    rows.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : b.mtimeMs - a.mtimeMs));
    return rows;
  }

  function parsed(entry) {
    const key = entry.file;
    const hit = cache.get(key);
    if (hit && hit.size === entry.size && hit.mtimeMs === entry.mtimeMs) return hit.value;
    let value;
    try { value = parseTranscript(readHead(entry.file), entry.name); } catch { return null; }
    cache.set(key, { size: entry.size, mtimeMs: entry.mtimeMs, value });
    return value;
  }

  function profiles() {
    let names = [];
    try { names = fs.readdirSync(base); } catch { return []; }
    const out = [];
    for (const name of names.sort()) {
      if (!SLUG.test(name)) continue;
      const { dir } = dirFor(name);
      if (!dir) continue;
      const count = entriesIn(dir).length;
      if (count) out.push({ id: name, count });
    }
    const rank = { intelio: 0, prc: 1, alignment: 2, hhp: 3, arlp: 4 };
    out.sort((a, b) => ((rank[a.id] ?? 9) - (rank[b.id] ?? 9)) || a.id.localeCompare(b.id));
    return out;
  }

  function list({ profile = 'intelio', q = '', client = '', limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    const { id, dir } = dirFor(profile);
    const wantClient = String(client || '').trim().toLowerCase();
    if (wantClient && !SLUG.test(wantClient)) throw Object.assign(new Error('Unknown client.'), { status: 400 });
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).map((term) => term.slice(0, 80));
    const max = Math.max(1, Math.min(MAX_LIMIT, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
    const skip = Math.max(0, Math.min(100000, Number.parseInt(offset, 10) || 0));
    const entries = entriesIn(dir);
    const filtering = Boolean(terms.length || wantClient);
    const items = [];
    let matched = 0;
    for (const entry of entries) {
      if (!filtering && (matched < skip || items.length >= max)) { matched += 1; continue; }
      const row = parsed(entry);
      if (!row) continue;
      if (wantClient && !row.clients.includes(wantClient)) continue;
      if (terms.length && !terms.every((term) => row.search.includes(term))) continue;
      matched += 1;
      if (matched > skip && items.length < max) {
        const { search, ...pub } = row;
        items.push({ ...pub, profile: id });
      }
    }
    return { profile: id, total: entries.length, matched, offset: skip, limit: max, items, profiles: profiles() };
  }

  return { list, profiles, parseTranscript };
}

module.exports = { createTranscripts, parseTranscript };
