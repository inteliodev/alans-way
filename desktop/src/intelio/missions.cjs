/**
 * Missions: a read-only view of a Hermes session. Nothing is stored; a mission
 * is the session seen through its goal (the first thing you asked), its to-do
 * list, the files it wrote, the helper agents it started, and a status.
 *
 * The idea and the transcript reading are adapted from Herald OS
 * apps/desktop/src/store/missions.ts and apps/desktop/src/lib/continuity.ts
 * (https://github.com/iamlukethedev/Herald-OS, MIT, Copyright (c) 2026 Luke The Dev).
 * See THIRD_PARTY.md. intelio reads the stored transcript
 * (GET /api/sessions/<id>/messages) instead of live gateway events, and it never
 * labels a mission "needs review": a finished mission is "Done, ready to look at".
 */
(function intelioMissions(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioMissions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioMissionsFactory() {
  /** The status words the UI shows. No "needs you", no "needs review". */
  const STATUS = {
    working: { label: 'Working', tone: 'live', order: 0 },
    open: { label: 'Open to-dos', tone: 'open', order: 1 },
    stopped: { label: 'Stopped', tone: 'quiet', order: 2 },
    ready: { label: 'Done, ready to look at', tone: 'done', order: 3 },
    replied: { label: 'Replied', tone: 'quiet', order: 4 },
    recent: { label: 'Recent', tone: 'quiet', order: 5 },
  };
  /** A session updated this recently with no reply yet is probably still running. */
  const WORKING_MS = 10 * 60 * 1000;
  const OUTPUT_TOOLS = new Set(['write_file', 'patch', 'create_file', 'edit_file', 'str_replace_editor']);
  const TODO_TOOLS = new Set(['todo', 'todo_write', 'todo_list', 'todowrite']);
  const HELPER_TOOLS = new Set(['delegate_task', 'delegate', 'spawn_agent']);
  const PATH_KEYS = ['path', 'file_path', 'filepath', 'target', 'output_path', 'destination'];
  /** Hermes's own note when a turn is stopped; it is not a reply. */
  const INTERRUPTED = /^\s*(operation interrupted|interrupted by user|\[interrupted\])/i;
  const MISSION_PREFIX = /^\s*mission:\s*/i;
  const MISSION_SUFFIX = /\s*[—–-]+\s*plan (it|this) as a mission[\s\S]*$/i;

  function toMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
    const text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) return toMs(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** The newest moment a session row knows about, in ms. */
  function sessionTime(session) {
    if (!session || typeof session !== 'object') return 0;
    const candidates = [session.last_active, session.lastActive, session.updated_at, session.updatedAt, session.ended_at, session.created_at, session.createdAt, session.started_at, session.startedAt, session.at];
    return candidates.reduce((best, value) => Math.max(best, toMs(value)), 0);
  }

  function textOf(message) {
    const content = message?.content != null ? message.content : message?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (/tool/i.test(String(part?.type || '')) ? '' : part?.text || ''))).filter(Boolean).join('\n');
    return '';
  }

  function oneLine(text, max) {
    const flat = String(text || '').replace(/<[^>]{1,40}>/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  }

  function parseJson(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** Tool calls on an assistant message, whatever shape Hermes stored them in. */
  function toolCalls(message) {
    let calls = message?.tool_calls;
    if (typeof calls === 'string') calls = parseJson(calls);
    if (!Array.isArray(calls)) return [];
    return calls.map((call) => {
      const fn = call?.function || call || {};
      const name = String(fn.name || call?.name || '').trim();
      const args = parseJson(fn.arguments ?? call?.arguments ?? call?.args ?? call?.input) || {};
      return { id: String(call?.id || call?.tool_call_id || ''), name, args };
    }).filter((call) => call.name);
  }

  function cleanTodos(list) {
    if (!Array.isArray(list)) return null;
    const rows = list
      .filter((todo) => todo && typeof todo.content === 'string' && todo.content.trim())
      .map((todo) => ({
        content: oneLine(todo.content, 160),
        status: ['pending', 'in_progress', 'completed', 'cancelled'].includes(todo.status) ? todo.status : 'pending',
      }))
      .filter((todo) => todo.status !== 'cancelled');
    return rows.length ? rows.slice(0, 30) : null;
  }

  function todosFromText(raw) {
    if (typeof raw !== 'string' || !raw.includes('"todos"')) return null;
    const parsed = parseJson(raw);
    return parsed ? cleanTodos(parsed.todos) : null;
  }

  /** Paths a patch body adds or updates ("*** Add File: x", "*** Update File: x"). */
  function patchPaths(body) {
    const out = [];
    const re = /^\*\*\*\s+(?:Add|Update)\s+File:\s*(.+)$/gim;
    let hit;
    while ((hit = re.exec(String(body || '')))) out.push(hit[1].trim());
    return out;
  }

  function outputPaths(call) {
    const out = [];
    for (const key of PATH_KEYS) {
      const value = call.args?.[key];
      if (typeof value === 'string' && value.trim() && value.length < 400) out.push(value.trim());
    }
    if (typeof call.args?.patch === 'string') out.push(...patchPaths(call.args.patch));
    return out;
  }

  function helperGoals(call) {
    const tasks = Array.isArray(call.args?.tasks) ? call.args.tasks : (call.args?.goal ? [{ goal: call.args.goal }] : []);
    return tasks.map((task) => oneLine(task?.goal || task?.description || '', 140)).filter(Boolean);
  }

  /** "Mission: x — plan it as a mission…" reads back as just "x". */
  function cleanGoal(text) {
    return oneLine(String(text || '').replace(MISSION_PREFIX, '').replace(MISSION_SUFFIX, ''), 220);
  }

  function isMissionPrompt(text) {
    return MISSION_PREFIX.test(String(text || ''));
  }

  /**
   * Read a stored transcript (oldest first). Returns what it says: the goal,
   * the latest to-do list, files written, helpers started, and how it ended.
   */
  function readTranscript(messages) {
    const rows = (Array.isArray(messages) ? messages : []).filter((message) => message && message.display_kind !== 'hidden');
    const firstUser = rows.find((message) => message.role === 'user' && textOf(message).trim());
    let todos = null;
    const outputs = [];
    const helpers = [];
    const results = new Map();
    for (const message of rows) {
      if (message.role === 'tool') {
        const id = String(message.tool_call_id || '');
        if (id) results.set(id, textOf(message));
        const plan = todosFromText(textOf(message));
        if (plan) todos = plan;
      }
      if (message.role !== 'assistant') continue;
      for (const call of toolCalls(message)) {
        const name = call.name.toLowerCase();
        if (TODO_TOOLS.has(name)) {
          const plan = cleanTodos(call.args?.todos);
          if (plan && !call.args?.merge) todos = plan;
        }
        if (OUTPUT_TOOLS.has(name)) {
          for (const target of outputPaths(call)) {
            if (outputs.some((item) => item.path === target)) continue;
            outputs.push({ path: target, name: target.split(/[\\/]/).filter(Boolean).pop() || target, tool: name });
          }
        }
        if (HELPER_TOOLS.has(name)) {
          for (const goal of helperGoals(call)) helpers.push({ goal, callId: call.id });
        }
      }
    }
    for (const helper of helpers) {
      const result = helper.callId ? results.get(helper.callId) : undefined;
      helper.status = result === undefined ? 'running' : (/"status"\s*:\s*"(failed|error)"|\berror\b/i.test(result.slice(0, 400)) ? 'failed' : 'done');
      delete helper.callId;
    }
    const newest = rows[rows.length - 1];
    const lastReply = [...rows].reverse().find((message) => message.role === 'assistant' && textOf(message).trim() && !INTERRUPTED.test(textOf(message)));
    const interrupted = Boolean(newest && newest.role === 'assistant' && INTERRUPTED.test(textOf(newest)));
    const awaitingReply = Boolean(newest && (newest.role === 'user' || newest.role === 'tool' || (newest.role === 'assistant' && toolCalls(newest).length && !textOf(newest).trim())));
    return {
      goal: firstUser ? cleanGoal(textOf(firstUser)) : '',
      missionPrompt: firstUser ? isMissionPrompt(textOf(firstUser)) : false,
      todos: todos || [],
      outputs: outputs.slice(-12).reverse(),
      helpers: helpers.slice(0, 8),
      last: lastReply ? oneLine(textOf(lastReply), 240) : '',
      at: newest ? toMs(newest.timestamp) : 0,
      interrupted,
      awaitingReply,
      count: rows.length,
    };
  }

  function statusFor({ facts, live, updatedAt, now }) {
    if (live) return 'working';
    if (!facts) return 'recent';
    if (facts.interrupted) return 'stopped';
    const open = facts.todos.filter((todo) => todo.status !== 'completed').length;
    if (facts.awaitingReply) return now - updatedAt < WORKING_MS ? 'working' : 'stopped';
    if (facts.helpers.some((helper) => helper.status === 'running') && now - updatedAt < WORKING_MS) return 'working';
    if (open) return 'open';
    if (facts.outputs.length || facts.todos.length) return 'ready';
    return 'replied';
  }

  /**
   * One mission from a session row and (optionally) its transcript.
   * `live` is true while this client is streaming a reply into it.
   */
  function deriveMission(session, messages, { now = Date.now(), live = false } = {}) {
    const row = session || {};
    const facts = Array.isArray(messages) ? readTranscript(messages) : null;
    const updatedAt = Math.max(sessionTime(row), facts?.at || 0);
    const status = statusFor({ facts, live, updatedAt, now });
    const title = oneLine(String(row.title || '').replace(/^\[[a-z0-9-]+\]\s*/i, ''), 120);
    const goal = facts?.goal || oneLine(row.preview || row.last_message || '', 220) || title;
    const todos = facts?.todos || [];
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const current = todos.find((todo) => todo.status === 'in_progress') || todos.find((todo) => todo.status === 'pending');
    return {
      id: String(row.id || ''),
      profileId: String(row.profileId || row.profile || '').toLowerCase(),
      title: title || oneLine(goal, 80) || 'Untitled',
      goal,
      status,
      statusLabel: STATUS[status].label,
      tone: STATUS[status].tone,
      todos,
      todoDone: done,
      todoTotal: todos.length,
      step: current ? current.content : '',
      outputs: facts?.outputs || [],
      helpers: facts?.helpers || [],
      last: facts?.last || '',
      updatedAt,
      source: String(row.source || ''),
      loaded: Boolean(facts),
      missionPrompt: Boolean(facts?.missionPrompt),
    };
  }

  /** Working first, then open to-dos, then the rest by time. */
  function sortMissions(list) {
    return (Array.isArray(list) ? list : []).slice().sort((a, b) => (STATUS[a.status].order - STATUS[b.status].order) || (b.updatedAt - a.updatedAt));
  }

  /** "Mission: <goal>" plus the plan-first ask. One line: the chat box is single-line. */
  function missionPrompt(goal = '') {
    const text = String(goal || '').trim();
    return `Mission: ${text} — plan it as a mission: make a to-do list of the steps with the todo tool first, keep it updated as you work, and finish with a short summary of what you made.`;
  }

  return { STATUS, WORKING_MS, toMs, sessionTime, readTranscript, deriveMission, sortMissions, missionPrompt, cleanGoal, toolCalls, patchPaths };
});
