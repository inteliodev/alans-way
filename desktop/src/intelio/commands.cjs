/**
 * One command registry for intelio: the Cmd+K command bar runs from it today,
 * and voice and the agents can call the same commands later.
 *
 * Adapted from Herald OS apps/desktop/src/store/os-commands.ts
 * (https://github.com/iamlukethedev/Herald-OS, MIT, Copyright (c) 2026 Luke The Dev).
 * See THIRD_PARTY.md. intelio keeps the shape (dotted ids, typed args, a tier,
 * a result that can be shown or spoken, run() never throws) and adds:
 *   - entries(): one command can offer many bar rows (one per agent, session, screen);
 *   - sources: which callers may run it. 'agent' is off unless a command opts in,
 *     so nothing here becomes an agent tool by accident;
 *   - match(): a small phrase matcher for the voice fast path.
 */
(function intelioCommands(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioCommands = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioCommandsFactory() {
  /** `area.verb`: a lowercase area, then camelCase words (`agent.switch`, `screen.open`). */
  const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
  const SOURCES = ['palette', 'shortcut', 'ui', 'voice', 'agent'];
  const TIERS = ['read', 'act', 'mutate'];
  /** Who may run a command when it does not say. Agents must be listed explicitly. */
  const DEFAULT_SOURCES = ['palette', 'shortcut', 'ui', 'voice'];
  const MAX_LOG = 50;

  const ok = (summary, extra = {}) => ({ ok: true, summary: String(summary || ''), ...extra });
  const fail = (error, extra = {}) => ({ ok: false, summary: String(error || 'That did not work.'), error: String(error || 'That did not work.'), ...extra });

  function normalize(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9#]+/g, ' ').trim();
  }

  /** Coerce and check arguments against the declaration. Returns { args } or { error }. */
  function validateArgs(command, raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const specs = Array.isArray(command.args) ? command.args : [];
    const clean = {};
    for (const spec of specs) {
      let value = input[spec.name];
      if (value === undefined || value === null || value === '') {
        if (spec.required) return { error: `${command.id} needs "${spec.name}"` };
        if (spec.enum && spec.enum.length) clean[spec.name] = spec.enum[0];
        continue;
      }
      if (spec.type === 'number') {
        const number = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(number)) return { error: `${command.id}: "${spec.name}" must be a number` };
        if (Number.isFinite(spec.min) && number < spec.min) return { error: `${command.id}: "${spec.name}" is at least ${spec.min}` };
        if (Number.isFinite(spec.max) && number > spec.max) return { error: `${command.id}: "${spec.name}" is at most ${spec.max}` };
        value = number;
      } else if (spec.type === 'boolean') {
        value = typeof value === 'boolean' ? value : /^(true|yes|on|1)$/i.test(String(value).trim());
      } else {
        value = String(value).trim().slice(0, spec.maxLength || 2000);
      }
      if (spec.enum) {
        const match = spec.enum.find((option) => String(option).toLowerCase() === String(value).toLowerCase());
        if (match === undefined) return { error: `${command.id}: "${spec.name}" must be one of ${spec.enum.join(', ')}` };
        value = match;
      }
      clean[spec.name] = value;
    }
    const unknown = Object.keys(input).filter((key) => !specs.some((spec) => spec.name === key));
    if (unknown.length) return { error: `${command.id}: unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}` };
    return { args: clean };
  }

  /** Score how well `query` matches a row's words. 0 means no match. */
  function rank(query, row) {
    const q = normalize(query);
    if (!q) return 1;
    const title = normalize(row.title);
    const hay = normalize([row.title, row.subtitle, row.group, ...(row.keywords || [])].join(' '));
    if (title === q) return 100;
    if (title.startsWith(q)) return 80;
    const words = q.split(' ').filter(Boolean);
    if (!words.every((word) => hay.includes(word))) return 0;
    let score = 20;
    for (const word of words) {
      if (title.split(' ').some((part) => part.startsWith(word))) score += 10;
      else if (title.includes(word)) score += 5;
    }
    return score;
  }

  function compilePhrase(phrase) {
    const text = typeof phrase === 'string' ? phrase : String(phrase?.phrase || '');
    const pinned = typeof phrase === 'object' && phrase && phrase.args ? phrase.args : {};
    const names = [];
    const parts = text.split(/(\{[a-zA-Z]+\})/).filter(Boolean).map((part) => {
      const slot = /^\{([a-zA-Z]+)\}$/.exec(part);
      if (slot) { names.push(slot[1]); return '(.+?)'; }
      return normalize(part).split(' ').filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(' ');
    }).filter(Boolean);
    return { re: new RegExp(`^${parts.join(' ')}$`), names, pinned };
  }

  function createRegistry() {
    const commands = new Map();
    const log = [];
    const listeners = new Set();

    function define(list) {
      const invalid = [];
      for (const command of Array.isArray(list) ? list : [list]) {
        if (!command || !ID_RE.test(String(command.id || '')) || typeof command.run !== 'function') { invalid.push(String(command?.id || '?')); continue; }
        const tier = TIERS.includes(command.tier) ? command.tier : 'act';
        const sources = Array.isArray(command.sources) ? command.sources.filter((source) => SOURCES.includes(source)) : DEFAULT_SOURCES.slice();
        commands.set(command.id, { ...command, tier, sources, args: Array.isArray(command.args) ? command.args : [] });
      }
      if (invalid.length) throw new Error(`invalid command${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`);
    }

    function get(id) { return commands.get(id); }

    /** Summaries for a caller: what it may run, with args and phrases. */
    function list({ source = 'palette', includeHidden = false } = {}) {
      return [...commands.values()]
        .filter((command) => command.sources.includes(source) && (includeHidden || !command.hidden))
        .map(({ id, title, description, tier, args, phrases, keywords, group, hidden }) => ({
          id, title, description: description || '', tier, args, phrases: phrases || [], keywords: keywords || [], group: group || '', hidden: Boolean(hidden),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * Command bar rows. A command without required args is one row; a command
     * with entries(context) adds one row per entry (agents, sessions, screens).
     */
    function entries(context = {}) {
      const rows = [];
      for (const command of commands.values()) {
        if (command.hidden || !command.sources.includes('palette')) continue;
        if (typeof command.entries === 'function') {
          let extra = [];
          try { extra = command.entries(context) || []; } catch { extra = []; }
          for (const entry of extra) {
            if (!entry || !entry.title) continue;
            rows.push({ key: `${command.id}:${entry.key || JSON.stringify(entry.args || {})}`, id: command.id, args: entry.args || {}, title: String(entry.title), subtitle: entry.subtitle || '', group: entry.group || command.group || '', keywords: [...(command.keywords || []), ...(entry.keywords || [])], hint: entry.hint || '', order: entry.order ?? command.order ?? 50 });
          }
        }
        const needs = command.args.some((spec) => spec.required);
        if (!needs && command.palette !== false) {
          rows.push({ key: command.id, id: command.id, args: {}, title: command.title, subtitle: command.description || '', group: command.group || '', keywords: command.keywords || [], hint: command.hint || '', order: command.order ?? 50 });
        }
      }
      return rows;
    }

    /** Rows matching `query`, best first. `limit` caps the list. */
    function search(query, context = {}, { limit = 40 } = {}) {
      return entries(context)
        .map((row) => ({ row, score: rank(query, row) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.row.order - b.row.order || a.row.title.localeCompare(b.row.title))
        .slice(0, limit)
        .map((item) => item.row);
    }

    /** The first command whose phrase matches an utterance: { id, args } or null. */
    function match(utterance, { source = 'voice' } = {}) {
      const text = normalize(utterance);
      if (!text) return null;
      for (const command of commands.values()) {
        if (!command.sources.includes(source)) continue;
        for (const phrase of command.phrases || []) {
          const compiled = compilePhrase(phrase);
          const hit = compiled.re.exec(text);
          if (!hit) continue;
          const args = { ...compiled.pinned };
          compiled.names.forEach((name, index) => { args[name] = hit[index + 1]; });
          return { id: command.id, args };
        }
      }
      return null;
    }

    function record(entry) {
      log.unshift(entry);
      if (log.length > MAX_LOG) log.length = MAX_LOG;
      for (const listener of listeners) { try { listener(entry); } catch { /* a listener never breaks a command */ } }
    }

    /** Run by id. Never throws: failures come back as { ok: false, error }. */
    async function run(id, rawArgs, { source = 'ui' } = {}) {
      const command = commands.get(id);
      const at = Date.now();
      if (!command) { const result = fail(`Unknown command "${id}"`); record({ id, args: rawArgs || {}, source, result, at }); return result; }
      if (!command.sources.includes(source)) {
        const result = fail(`${command.title} can't be run from ${source}.`);
        record({ id, args: rawArgs || {}, source, result, at });
        return result;
      }
      const checked = validateArgs(command, rawArgs);
      if (checked.error) { const result = fail(checked.error); record({ id, args: rawArgs || {}, source, result, at }); return result; }
      let result;
      try {
        result = await command.run(checked.args, { source, run });
        if (!result || typeof result !== 'object') result = ok(command.title);
      } catch (error) {
        result = fail(error?.message || String(error));
      }
      record({ id, args: checked.args, source, result, at });
      return result;
    }

    return {
      define, get, list, entries, search, match, run,
      log: () => log.slice(),
      onRun: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      size: () => commands.size,
    };
  }

  return { createRegistry, validateArgs, rank, normalize, compilePhrase, ok, fail, ID_RE, SOURCES, TIERS, DEFAULT_SOURCES };
});
