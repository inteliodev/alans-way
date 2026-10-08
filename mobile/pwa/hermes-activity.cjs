'use strict';
/**
 * Read-only view of what each Hermes agent did, taken from its own state.db
 * (~/.hermes/profiles/<profile>/state.db). The database is opened read-only; nothing is
 * written, locked for writing, or migrated, so the Hermes runtime is untouched.
 *
 * Only tool calls that matter for the activity list are kept: shell commands (classified as
 * GitHub, Claude Code, Codex or plain terminal), browser actions and computer-use actions.
 * Every summary goes through the activity-log redactor.
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeEvent, classifyCommand } = require('../../desktop/src/intelio/activity-log.cjs');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function defaultOpen(file) {
  // node:sqlite ships with Node 22.5+. Older runtimes simply show no Hermes rows.
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  return new DatabaseSync(file, { readOnly: true });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Flatten one assistant message's tool_calls (including the batching tool_call tool). */
function toolCallsOf(raw) {
  const list = parseJson(raw);
  if (!Array.isArray(list)) return [];
  const out = [];
  const push = (name, args) => {
    if (!name) return;
    const parsed = typeof args === 'string' ? parseJson(args) : args;
    out.push({ name: String(name), args: parsed && typeof parsed === 'object' ? parsed : {} });
  };
  for (const item of list) {
    const fn = item && (item.function || item);
    push(fn?.name, fn?.arguments);
    const last = out[out.length - 1];
    if (last && last.name === 'tool_call' && Array.isArray(last.args.calls)) {
      out.pop();
      for (const call of last.args.calls) push(call?.name || call?.tool, call?.arguments || call?.args || call?.input);
    }
  }
  return out;
}

/** One tool call -> an activity event, or null for calls the list does not show. */
function eventFromCall(call, { profile, ts, session }) {
  const { name, args } = call;
  if (name === 'terminal' || name === 'shell' || name === 'bash' || name === 'run_command') {
    const command = String(args.command || args.cmd || '').trim();
    if (!command) return null;
    const { kind, action } = classifyCommand(command);
    return { kind, action, summary: command, tool: name };
  }
  if (/^browser_vault_/.test(name)) {
    const what = name.replace(/^browser_vault_/, '');
    const label = args.label || args.site || args.domain || '';
    return { kind: 'vault', action: what.replace(/_/g, '-'), summary: `Vault ${what.replace(/_/g, ' ')}${label ? ` · ${label}` : ''}`, tool: name };
  }
  if (/^browser_/.test(name)) {
    const target = args.url || args.site || args.domain || '';
    const action = name.replace(/^browser_/, '').replace(/_/g, '-');
    const signin = /login|sign.?in|auth/i.test(`${name} ${target}`);
    return { kind: 'browser', action: signin ? 'sign-in' : action, summary: `${signin ? 'Browser sign-in' : `Browser ${action.replace(/-/g, ' ')}`}${target ? ` · ${target}` : ''}`, tool: name };
  }
  if (/^computer(_use)?/.test(name) || /^desktop_/.test(name)) {
    const action = String(args.action || name.replace(/^(computer_use_|computer_|desktop_)/, '') || 'action').replace(/_/g, '-');
    return { kind: 'connector', action, summary: `Computer ${action.replace(/-/g, ' ')}${args.app ? ` · ${args.app}` : ''}`, tool: name };
  }
  return null;
}

/**
 * Activity for the given profiles, newest first.
 * @param {{ root: string, profiles: string[], sinceMs?: number, perProfile?: number, open?: Function, fsImpl?: object }} options
 */
function readHermesActivity({ root, profiles, sinceMs = 0, perProfile = 400, open = defaultOpen, fsImpl = fs } = {}) {
  const rows = [];
  for (const profile of profiles || []) {
    if (!SLUG.test(String(profile || ''))) continue;
    const file = path.join(root, profile, 'state.db');
    if (!fsImpl.existsSync(file)) continue;
    let db = null;
    try {
      db = open(file);
      if (!db) continue;
      const query = db.prepare(`SELECT m.session_id AS session, m.tool_calls AS calls, m.timestamp AS ts
        FROM messages m WHERE m.tool_calls IS NOT NULL AND m.tool_calls <> '' AND m.timestamp >= ?
        ORDER BY m.id DESC LIMIT ?`);
      for (const row of query.all(sinceMs / 1000, perProfile)) {
        const when = Number(row.ts) * 1000;
        for (const call of toolCallsOf(row.calls)) {
          const base = eventFromCall(call, { profile, ts: when, session: row.session });
          if (!base) continue;
          const event = normalizeEvent({ ...base, profile, ts: new Date(when).toISOString(), session: row.session, actor: 'agent', source: 'hermes' });
          if (event) rows.push(event);
        }
      }
    } catch {
      /* unreadable or locked database: show what the other profiles have */
    } finally {
      try { db?.close(); } catch { /* closed */ }
    }
  }
  rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return rows;
}

/**
 * What Hermes itself recorded for this profile: when each model provider last answered
 * (a successful API call) and when each message source (telegram, photon, sms, api...) was
 * last active. e.g. { models: { 'openai-codex': { model, lastOkAt } }, sources: { telegram: ms } }.
 */
function profileUsage({ root, profile, open = defaultOpen, fsImpl = fs } = {}) {
  const out = { models: {}, sources: {} };
  if (!SLUG.test(String(profile || ''))) return out;
  const file = path.join(root, profile, 'state.db');
  if (!fsImpl.existsSync(file)) return out;
  let db = null;
  try {
    db = open(file);
    if (!db) return out;
    try {
      const models = db.prepare(`SELECT billing_provider AS provider, model, MAX(last_seen) AS seen
        FROM session_model_usage WHERE api_call_count > 0 GROUP BY billing_provider, model`);
      for (const row of models.all()) {
        const provider = String(row.provider || '');
        const at = Number(row.seen) * 1000;
        if (!provider || !Number.isFinite(at) || at <= 0) continue;
        if (!out.models[provider] || out.models[provider].lastOkAt < at) out.models[provider] = { model: String(row.model || '').slice(0, 80), lastOkAt: at };
      }
    } catch { /* older schema */ }
    try {
      const sources = db.prepare('SELECT source, MAX(COALESCE(last_activity_at, started_at)) AS seen FROM sessions GROUP BY source');
      for (const row of sources.all()) {
        const source = String(row.source || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
        const at = Number(row.seen) * 1000;
        if (source && Number.isFinite(at) && at > 0) out.sources[source] = at;
      }
    } catch { /* older schema */ }
  } catch {
    /* locked or unreadable: no usage info */
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
  return out;
}

module.exports = { readHermesActivity, profileUsage, toolCallsOf, eventFromCall };
