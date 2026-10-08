'use strict';
/**
 * Turns a task's run log (data/runs/<id>.jsonl) into a conversation.
 * The log mixes our own marker lines ({ws:'user'|'end'|'error'|'note'}) with
 * the raw event stream of whichever engine ran:
 *   codex exec --json, claude -p stream-json, cursor-agent -p stream-json,
 *   hermes chat --format stream-json.
 * Session ids are recorded per engine (the engine of the current turn).
 */

function clip(s, n = 4000) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s;
}
function tail(s, n = 3000) {
  s = String(s ?? '');
  return s.length > n ? `… (${s.length - n} earlier chars)\n${s.slice(-n)}` : s;
}
function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}
function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return name;
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.globPattern;
  return v ? `${name}: ${v}` : name;
}
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
  if (content && typeof content === 'object') return JSON.stringify(content, null, 1);
  return '';
}
/** cursor-agent tool_call payloads look like {shellToolCall:{args:{command}, result:{success:{stdout,...}}}} */
function cursorTool(tc) {
  const key = Object.keys(tc || {})[0] || 'tool';
  const body = tc[key] || {};
  const name = key.replace(/ToolCall$/, '') || 'tool';
  const title = summarizeInput(name, body.args || {});
  let output = '';
  let failed = false;
  const res = body.result;
  if (res) {
    if (res.success) {
      const s = res.success;
      output = [s.stdout, s.stderr, s.content, s.output].filter((x) => typeof x === 'string' && x).join('\n') || (s.linesAdded != null ? `+${s.linesAdded} -${s.linesRemoved || 0}` : '');
      if (s.exitCode != null && s.exitCode !== 0) failed = true;
    } else if (res.error || res.failure || res.rejected) { failed = true; output = toolResultText(res.error || res.failure || res.rejected); }
  }
  return { name, title, output, failed };
}

function normalize(lines) {
  const turns = [];
  let turn = null;
  const sessions = {};
  const stepIndex = new Map();

  function ensureTurn(ts) {
    if (!turn) {
      turn = { engine: 'unknown', user: null, start: ts || null, end: null, items: [], code: null, final: null };
      turns.push(turn);
    }
    return turn;
  }
  function setSession(id) { if (id && turn && turn.engine && turn.engine !== 'unknown') sessions[turn.engine] = String(id); }
  function addMsg(text) {
    if (!text || !String(text).trim()) return;
    ensureTurn().items.push({ kind: 'assistant', text: clip(String(text).trim(), 20000) });
  }
  function addStep(key, step) {
    const item = { kind: 'step', ...step };
    ensureTurn().items.push(item);
    if (key) stepIndex.set(key, item);
    return item;
  }

  for (const raw of lines) {
    if (!raw || raw[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }

    // ---- our markers
    if (ev.ws === 'user') { turn = { engine: ev.engine || 'unknown', user: ev.text || '', start: ev.ts, end: null, items: [], code: null, final: null }; turns.push(turn); continue; }
    if (ev.ws === 'end') { const t = ensureTurn(ev.ts); t.end = ev.ts; t.code = ev.code; turn = null; continue; }
    if (ev.ws === 'error' || ev.ws === 'note') { ensureTurn(ev.ts).items.push({ kind: ev.ws, text: String(ev.text || '') }); continue; }

    // ---- codex
    if (ev.type === 'thread.started') { setSession(ev.thread_id); continue; }
    if (ev.type && ev.type.startsWith('item.') && ev.item) {
      const it = ev.item;
      const done = ev.type === 'item.completed';
      if (it.type === 'agent_message') { if (done) addMsg(it.text); continue; }
      if (it.type === 'reasoning') { if (done && it.text) addStep(null, { tool: 'thinking', title: clip(it.text.split('\n')[0], 140), output: clip(it.text, 4000) }); continue; }
      const title = it.type === 'command_execution' ? it.command
        : it.type === 'file_change' ? `Edited ${(it.changes || []).map((c) => `${c.path}${c.kind ? ` (${c.kind})` : ''}`).join(', ')}`
          : it.type === 'mcp_tool_call' ? `${it.server || 'mcp'}.${it.tool || ''}`
            : it.type === 'web_search' ? `Web search: ${it.query || ''}`
              : it.type === 'todo_list' ? `Plan: ${(it.items || []).map((x) => `${x.completed ? '✓' : '○'} ${x.text}`).join(' · ')}`
                : it.type === 'error' ? `Error: ${it.message || ''}` : it.type;
      let step = stepIndex.get(`codex:${it.id}`);
      if (!step) step = addStep(`codex:${it.id}`, { tool: it.type === 'command_execution' ? 'shell' : it.type });
      step.title = clip(title, 400);
      step.running = !done;
      if (it.aggregated_output != null) step.output = tail(it.aggregated_output);
      if (it.exit_code != null) step.exit = it.exit_code;
      if (it.status === 'failed' || (it.exit_code != null && it.exit_code !== 0)) step.failed = true;
      continue;
    }
    if (ev.type === 'turn.failed') { ensureTurn().items.push({ kind: 'error', text: ev.error?.message || 'Turn failed' }); continue; }
    if (ev.type === 'error' && ev.message) { ensureTurn().items.push({ kind: 'error', text: ev.message }); continue; }
    if (ev.type === 'turn.completed' || ev.type === 'turn.started') continue;

    // ---- claude / cursor (shared envelope)
    if (ev.type === 'system') { setSession(ev.session_id); continue; }
    if (ev.type === 'assistant' && ev.message?.content) {
      setSession(ev.session_id);
      const content = Array.isArray(ev.message.content) ? ev.message.content : [{ type: 'text', text: String(ev.message.content) }];
      for (const c of content) {
        if (c.type === 'text') addMsg(c.text);
        else if (c.type === 'tool_use') addStep(`tu:${c.id}`, { tool: c.name, title: clip(summarizeInput(c.name, c.input), 400), running: true });
      }
      continue;
    }
    if (ev.type === 'user' && ev.message) {
      for (const c of (Array.isArray(ev.message.content) ? ev.message.content : [])) {
        if (c.type !== 'tool_result') continue;
        const step = stepIndex.get(`tu:${c.tool_use_id}`);
        if (step) { step.running = false; step.output = tail(toolResultText(c.content)); if (c.is_error) step.failed = true; }
      }
      continue;
    }
    if (ev.type === 'tool_call' && ev.tool_call) { // cursor-agent
      const info = cursorTool(ev.tool_call);
      let step = stepIndex.get(`cc:${ev.call_id}`);
      if (!step) step = addStep(`cc:${ev.call_id}`, { tool: info.name, title: clip(info.title, 400) });
      step.running = ev.subtype !== 'completed';
      if (ev.subtype === 'completed') { step.output = tail(info.output); if (info.failed) step.failed = true; }
      continue;
    }

    // ---- hermes
    if (ev.type === 'tool_use' && ev.name) { addStep(null, { tool: ev.name, title: clip(summarizeInput(ev.name, ev.input), 400), running: true, hermes: true }); continue; }
    if (ev.type === 'tool_result' && ev.name) {
      const t = ensureTurn();
      for (let i = t.items.length - 1; i >= 0; i--) {
        const s = t.items[i];
        if (s.kind === 'step' && s.hermes && s.running && s.tool === ev.name) {
          s.running = false;
          let out = ev.output;
          try { const j = JSON.parse(out); out = j.output ?? out; if (j.exit_code != null) s.exit = j.exit_code; } catch { /* plain */ }
          s.output = tail(toolResultText(out));
          if (ev.is_error) s.failed = true;
          break;
        }
      }
      continue;
    }
    if (ev.type === 'text' && typeof ev.text === 'string') { // hermes streams text deltas
      const t = ensureTurn();
      const last = t.items[t.items.length - 1];
      if (last && last.kind === 'assistant' && last.stream) last.text += ev.text;
      else t.items.push({ kind: 'assistant', text: ev.text, stream: true });
      continue;
    }

    // ---- shared result line (claude, cursor, hermes)
    if (ev.type === 'result') {
      setSession(ev.session_id);
      const t = ensureTurn();
      if (ev.is_error || ev.error) t.items.push({ kind: 'error', text: clip(ev.error || ev.result || ev.subtype || 'error') });
      else if (!t.items.some((x) => x.kind === 'assistant') && (ev.result || ev.text)) addMsg(ev.result || ev.text);
      if (ev.total_cost_usd != null) t.cost = ev.total_cost_usd;
      continue;
    }
  }

  for (const t of turns) {
    t.items = t.items.filter((x) => { if (x.stream) { x.text = clip(x.text.trim(), 20000); delete x.stream; return !!x.text; } return true; });
    for (let i = t.items.length - 1; i >= 0; i--) { if (t.items[i].kind === 'assistant') { t.final = i; break; } }
    if (t.start && t.end) t.elapsed = `Worked for ${elapsed(t.end - t.start)}`;
    t.running = t.end == null && t.user != null;
  }
  return { turns, sessions };
}

module.exports = { normalize, elapsed };
