/**
 * Chat display. User lines and the assistant's final reply stay as bubbles.
 * Tool calls, tool results, and untrusted-data wrappers become one status chip
 * per run. The chip can open the plain detail. Raw JSON is not the bubble.
 */
(function intelioTranscript(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioTranscript = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioTranscriptFactory() {
  const WRAPPER = /<untrusted_tool_result\b([^>]*)>([\s\S]*?)<\/untrusted_tool_result>/gi;
  const BOILER = /The following content was retrieved from an external source\.[\s\S]*?can issue instructions\./gi;

  function textOf(message) {
    if (typeof message === 'string') return message;
    const content = message?.content != null ? message.content : message?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        if (typeof part === 'string') return part;
        const type = String(part?.type || '');
        if (/tool/i.test(type)) return '';
        return part?.text || part?.content || '';
      }).filter(Boolean).join('\n');
    }
    if (content && typeof content === 'object') return content.text || content.content || '';
    return '';
  }

  function human(name) {
    const raw = String(name || '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (!raw || raw.length > 48) return '';
    return raw.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  }

  function subjectFor(name, detail) {
    const blob = `${name || ''}\n${detail || ''}`.toLowerCase();
    if (/imessage|messaging\.imessage|platforms\.imessage/.test(blob)) return 'iMessage setup';
    if (/telegram/.test(blob)) return 'Telegram';
    if (/slack/.test(blob)) return 'Slack';
    if (/discord/.test(blob)) return 'Discord';
    if (/whatsapp/.test(blob)) return 'WhatsApp';
    if (/web[_\s-]?extract|web[_\s-]?search|browse/.test(blob)) return 'a page';
    if (/^(exec|terminal|shell|bash|command)$/i.test(String(name || '').trim())) return 'a command';
    return human(name) || 'a tool';
  }

  function labelFor({ name, detail, running, failed, summary }) {
    const phrase = String(summary || '').trim();
    if (phrase && !looksDump(phrase)) {
      if (running) return `Checking ${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`;
      if (failed) return phrase;
      return phrase;
    }
    const subject = subjectFor(name, detail);
    if (failed) return `Could not check ${subject}`;
    return `${running ? 'Checking' : 'Checked'} ${subject}`;
  }

  function looksDump(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (/<untrusted_tool_result\b/i.test(value)) return true;
    if (/^\s*[\[{]/.test(value)) return true;
    if (/"exit_code"\s*:|"tool_name"\s*:|"untrusted_tool_result"/.test(value)) return true;
    return false;
  }

  function unescapeOutput(value) {
    try { return JSON.parse(`"${value}"`); } catch { return value.replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
  }

  function plainDetail(blob) {
    const source = String(blob || '').trim();
    if (source.startsWith('{') || source.startsWith('[')) {
      try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (typeof parsed.description === 'string' && parsed.description.trim()) return parsed.description.trim().slice(0, 500);
          if (typeof parsed.output === 'string') return parsed.output.trim().slice(0, 2000);
          if (Array.isArray(parsed.results)) {
            return parsed.results.map((row) => row?.output || row?.url || '').filter(Boolean).join('\n\n').slice(0, 2000);
          }
        }
      } catch { /* fall through to the text scan */ }
    }
    const outputs = [];
    const re = /"output"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    while ((match = re.exec(source))) outputs.push(unescapeOutput(match[1]));
    const text = (outputs.length ? outputs.join('\n\n') : source)
      .replace(BOILER, '')
      .replace(/<\/?untrusted_tool_result\b[^>]*>/gi, '')
      .replace(/\r/g, '')
      .trim();
    if (/^\s*[\[{]/.test(text)) return '';
    const lines = text.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^[\[\]{},]+$/.test(trimmed)) return false;
      if (/^<\/?[a-z_]+/.test(trimmed)) return false;
      if (/^"(success|results|output|exit_code|error|url)"\s*:/.test(trimmed)) return false;
      return true;
    });
    return lines.join('\n').slice(0, 2000);
  }

  function looksLikeToolPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if ('exit_code' in value || 'tool_name' in value || 'tool_call_id' in value) return true;
    if (Array.isArray(value.results)) return true;
    if ('output' in value && ('error' in value || 'success' in value)) return true;
    if ('success' in value && ('name' in value || 'content' in value || 'output' in value)) return true;
    if (value.name && value.description && (value.tags || value.content)) return true;
    return false;
  }

  function stripLoose(text, chips) {
    const kept = [];
    let buf = [];
    let dumping = false;
    const flush = () => {
      const blob = buf.join('\n').trim();
      buf = [];
      dumping = false;
      if (blob) chips.push({ name: /web_extract/i.test(blob) ? 'web_extract' : '', detail: plainDetail(blob) });
    };
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      const starts = trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<untrusted') || /^"(success|results|output|exit_code|error)"\s*:/.test(trimmed);
      if (!dumping && starts) { dumping = true; buf.push(line); continue; }
      if (dumping) {
        const prose = /^[A-Za-z]/.test(trimmed) && trimmed.length > 24 && !trimmed.includes('":') && !trimmed.startsWith('http');
        if (prose) { flush(); kept.push(line); continue; }
        buf.push(line);
        continue;
      }
      kept.push(line);
    }
    if (dumping) flush();
    return kept.join('\n');
  }

  function jsonSpan(source, start) {
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let j = start; j < source.length; j += 1) {
      const ch = source[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quote = false;
        continue;
      }
      if (ch === '"') { quote = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return -1;
  }

  function peel(text) {
    const source = String(text || '');
    const spans = [];
    const wrapper = new RegExp(WRAPPER.source, 'gi');
    let match;
    while ((match = wrapper.exec(source))) {
      const name = /source\s*=\s*["']([^"']+)["']/i.exec(match[1] || '')?.[1] || 'tool';
      spans.push({ start: match.index, end: match.index + match[0].length, name, detail: plainDetail(match[2]) });
    }
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] !== '{') continue;
      if (spans.some((span) => i >= span.start && i < span.end)) continue;
      const end = jsonSpan(source, i);
      if (end < 0) continue;
      const slice = source.slice(i, end);
      let parsed = null;
      try { parsed = JSON.parse(slice); } catch { parsed = null; }
      if (!parsed || !looksLikeToolPayload(parsed)) continue;
      const name = typeof parsed.name === 'string' ? parsed.name : (parsed.tool_name || parsed.tool || '');
      spans.push({ start: i, end, name, detail: plainDetail(slice) });
      i = end - 1;
    }
    spans.sort((a, b) => a.start - b.start);
    let cursor = 0;
    let rest = '';
    const chips = [];
    for (const span of spans) {
      if (span.start < cursor) continue;
      rest += source.slice(cursor, span.start);
      chips.push({ name: span.name, detail: span.detail });
      cursor = span.end;
    }
    rest += source.slice(cursor);
    rest = stripLoose(rest.replace(BOILER, '\n'), chips);
    const prose = rest.replace(BOILER, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { prose: looksDump(prose) ? '' : prose, chips };
  }

  function chipFrom(part) {
    const rawDetail = String(part.detail || '');
    const summary = part.summary || (rawDetail.includes(' · ') ? rawDetail.split(' · ').slice(1).join(' · ') : '');
    const name = part.name || (rawDetail.includes(' · ') ? rawDetail.split(' · ')[0] : '');
    let detail = plainDetail(rawDetail);
    if (rawDetail.includes(' · ') && detail === rawDetail.trim()) detail = '';
    return {
      kind: 'chip',
      label: labelFor({ name, detail: rawDetail, running: part.running, failed: part.failed, summary }),
      detail,
      running: Boolean(part.running),
      failed: Boolean(part.failed),
    };
  }

  function push(items, item) {
    const prev = items[items.length - 1];
    if (item.kind === 'chip' && prev?.kind === 'chip' && prev.label === item.label && prev.running === item.running) {
      if (item.detail && !prev.detail.includes(item.detail)) prev.detail = [prev.detail, item.detail].filter(Boolean).join('\n\n').slice(0, 2000);
      return;
    }
    items.push(item);
  }

  function present(messages) {
    const items = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      const role = String(message?.role || 'assistant').toLowerCase();
      if (!message || role === 'system') continue;
      if (role === 'time') { items.push({ kind: 'time', text: textOf(message) }); continue; }
      if (role === 'choice') { items.push({ kind: 'choice', text: textOf(message) }); continue; }
      if (role === 'chip') { push(items, message); continue; }
      if (role === 'tool' || role === 'activity') {
        push(items, chipFrom({
          name: message.tool_name || message.name || message.title || '',
          detail: textOf(message),
          running: message.status === 'Running' || message.running === true,
          failed: message.status === 'Failed' || message.failed === true,
          summary: message.summary || '',
        }));
        continue;
      }
      const raw = textOf(message);
      if (role === 'user') {
        if (raw.trim()) items.push({ kind: 'bubble', role: 'user', text: raw.trim() });
        continue;
      }
      const peeled = peel(raw);
      for (const part of peeled.chips) push(items, chipFrom(part));
      for (const call of message.tool_calls || message.toolCalls || []) {
        const name = call?.function?.name || call?.name || '';
        if (name) push(items, chipFrom({ name, detail: '' }));
      }
      if (peeled.prose) items.push({ kind: 'bubble', role: 'assistant', text: peeled.prose });
    }
    return items;
  }

  function preview(text) {
    const items = present([{ role: 'assistant', content: text }]);
    const bubble = items.find((item) => item.kind === 'bubble');
    if (bubble) return bubble.text;
    return items.find((item) => item.kind === 'chip')?.label || '';
  }

  return { textOf, peel, present, preview, labelFor, plainDetail };
});
