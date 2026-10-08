/**
 * Chat model menu. Model ids come from Hermes at runtime.
 * ChatGPT/Codex and Claude subscription rows are the only providers offered.
 * API-key providers are dropped. This file does not read auth.json.
 */
(function intelioModelPicker(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioModelPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioModelPickerFactory() {
  const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,119}$/;
  const EFFORTS = ['auto', 'low', 'medium', 'high'];
  const EFFORT_LABELS = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };
  const CODEX = new Set(['openai-codex', 'openai_codex', 'codex', 'chatgpt']);
  const VIRTUAL = new Set(['hermes-agent']);

  function canonicalProvider(value) {
    const slug = String(value || '').trim().toLowerCase();
    if (CODEX.has(slug) || CODEX.has(slug.replace(/_/g, '-'))) return 'openai-codex';
    if (slug === 'anthropic' || slug === 'claude') return 'anthropic';
    return slug.replace(/_/g, '-').slice(0, 40);
  }

  function subscriptionProvider(value) {
    const canon = canonicalProvider(value);
    return canon === 'openai-codex' || canon === 'anthropic';
  }

  function providerLabel(value) {
    return canonicalProvider(value) === 'anthropic' ? 'Claude plan' : 'ChatGPT plan';
  }

  function modelIdOf(entry) {
    if (typeof entry === 'string') return entry.trim();
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.id || entry.slug || entry.model || entry.name || '').trim();
  }

  function keepId(id) {
    if (!MODEL_ID.test(id) || /[\r\n]/.test(id)) return false;
    return !VIRTUAL.has(id.toLowerCase());
  }

  function oauthRow(row) {
    if (!row || typeof row !== 'object') return false;
    if (row.authenticated === false) return false;
    const auth = String(row.auth_type || row.authType || '').toLowerCase();
    if (auth === 'api_key' || auth === 'apikey') return false;
    const canon = canonicalProvider(row.slug || row.id || row.provider || '');
    if (!subscriptionProvider(canon)) return false;
    if (canon === 'anthropic' && auth && !/oauth|subscription|claude/.test(auth)) return false;
    if (canon === 'anthropic' && !auth) return false;
    if (row.source === 'canonical' && (!Array.isArray(row.models) || !row.models.length)) return false;
    return true;
  }

  function modelsFromHermes(payload) {
    const rows = Array.isArray(payload?.providers) ? payload.providers : [];
    const groups = [];
    for (const row of rows) {
      if (!oauthRow(row)) continue;
      const provider = canonicalProvider(row.slug || row.id || row.provider || '');
      const models = [];
      for (const entry of row.models || []) {
        const id = modelIdOf(entry);
        if (!keepId(id) || models.includes(id)) continue;
        models.push(id);
      }
      if (!models.length) continue;
      const existing = groups.find((group) => group.provider === provider);
      if (existing) {
        for (const id of models) if (!existing.models.includes(id)) existing.models.push(id);
      } else groups.push({ provider, label: providerLabel(provider), models });
    }
    return groups;
  }

  function modelsFromList(payload) {
    const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    const models = [];
    for (const entry of rows) {
      const id = modelIdOf(entry);
      if (!keepId(id) || models.includes(id)) continue;
      models.push(id);
    }
    return models;
  }

  function configModel(text) {
    let provider = '';
    let model = '';
    let secret = false;
    let inModel = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (/^model\s*:/.test(raw) && !/^\s/.test(raw)) { inModel = true; continue; }
      if (!inModel) continue;
      if (raw.trim() && !/^\s/.test(raw)) break;
      if (/(api[_-]?key|token|secret|password|credential)\s*:/i.test(raw)) secret = true;
      const providerLine = raw.match(/^\s*provider\s*:\s*(.+)$/);
      if (providerLine) provider = providerLine[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 80);
      const modelLine = raw.match(/^\s*default\s*:\s*(.+)$/);
      if (modelLine && !model) model = modelLine[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 120);
    }
    return { provider, model, secret };
  }

  function effortFromConfig(text) {
    let inModel = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
      if (/^model\s*:/.test(raw) && !/^\s/.test(raw)) { inModel = true; continue; }
      if (inModel && raw.trim() && !/^\s/.test(raw)) break;
      const hit = raw.match(/^\s*reasoning_effort\s*:\s*(.+)$/);
      if (!hit) continue;
      const value = hit[1].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (EFFORTS.includes(value)) return value;
    }
    return 'auto';
  }

  function yamlQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function applyModelDefault(text, model, provider) {
    if (!keepId(model)) return null;
    const nextProvider = provider ? canonicalProvider(provider) : '';
    if (provider && !subscriptionProvider(nextProvider)) return null;
    const lines = String(text || '').split(/\r?\n/);
    let inModel = false;
    let modelAt = -1;
    let replacedDefault = false;
    let replacedProvider = !nextProvider;
    const next = [];
    for (const raw of lines) {
      if (/^model\s*:/.test(raw) && !/^\s/.test(raw)) {
        inModel = true;
        modelAt = next.length;
        next.push(raw);
        continue;
      }
      if (inModel && raw.trim() && !/^\s/.test(raw)) inModel = false;
      if (inModel && nextProvider && /^[ \t]+provider\s*:/.test(raw)) {
        next.push(`${raw.match(/^[ \t]*/)[0]}provider: ${yamlQuote(nextProvider)}`);
        replacedProvider = true;
        continue;
      }
      if (inModel && /^[ \t]+default\s*:/.test(raw)) {
        next.push(`${raw.match(/^[ \t]*/)[0]}default: ${yamlQuote(model)}`);
        replacedDefault = true;
        continue;
      }
      next.push(raw);
    }
    if (modelAt < 0) return null;
    const insert = [];
    if (!replacedProvider && nextProvider) insert.push(`  provider: ${yamlQuote(nextProvider)}`);
    if (!replacedDefault) insert.push(`  default: ${yamlQuote(model)}`);
    if (insert.length) next.splice(modelAt + 1, 0, ...insert);
    const out = next.join('\n');
    return String(text || '').endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out;
  }

  function sessionSwitchBody(provider, model, effort) {
    const body = { provider: canonicalProvider(provider), model: String(model || '').trim() };
    const level = String(effort || 'auto').toLowerCase();
    if (level === 'low' || level === 'medium' || level === 'high') {
      body.model_options = {
        reasoning_effort: level,
        reasoning: { enabled: true, effort: level },
      };
    }
    return body;
  }

  function chatFields(body, allowed) {
    const model = String(body?.model || '').trim();
    const provider = canonicalProvider(body?.provider || '');
    if (!keepId(model) || !subscriptionProvider(provider)) return {};
    const known = (allowed || []).some((group) => group.provider === provider && group.models.includes(model));
    const current = body?.profileModel && body.profileProvider
      && canonicalProvider(body.profileProvider) === provider
      && body.profileModel === model;
    if (!known && !current) return {};
    const packed = sessionSwitchBody(provider, model, body?.effort);
    const fields = { model: packed.model, provider: packed.provider };
    if (packed.model_options) fields.model_options = packed.model_options;
    return fields;
  }

  function planGroups(groups) {
    const by = new Map();
    for (const group of groups || []) {
      const provider = canonicalProvider(group.provider);
      if (provider !== 'openai-codex' && provider !== 'anthropic') continue;
      const models = [];
      for (const id of group.models || []) if (keepId(id) && !models.includes(id)) models.push(id);
      const existing = by.get(provider);
      if (existing) {
        for (const id of models) if (!existing.includes(id)) existing.push(id);
      } else by.set(provider, models);
    }
    const planned = [];
    const codex = by.get('openai-codex') || [];
    if (codex.length) planned.push({ provider: 'openai-codex', label: 'ChatGPT plan', models: codex, signIn: false });
    const claude = by.get('anthropic') || [];
    planned.push({ provider: 'anthropic', label: 'Claude plan', models: claude, signIn: claude.length === 0 });
    return planned;
  }

  function authorizeUrl(text) {
    const match = String(text || '').match(/https:\/\/claude\.ai\/oauth\/authorize\?[^\s<>"']+/);
    if (!match) return '';
    try {
      const url = new URL(match[0]);
      if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.pathname !== '/oauth/authorize') return '';
      if (!url.searchParams.get('code_challenge')) return '';
      return url.toString();
    } catch {
      return '';
    }
  }

  function claudePaste(value) {
    const text = String(value || '').trim();
    if (text.length < 8 || text.length > 2048 || /\s/.test(text)) return false;
    if (/sk-ant-api/i.test(text)) return false;
    return true;
  }

  function pillLabel(model) {
    const id = String(model || '').trim();
    return id || 'Model';
  }

  function defaultNote(agentName) {
    const name = String(agentName || 'this agent').replace(/[\r\n]+/g, ' ').trim().slice(0, 40) || 'this agent';
    return `New threads for ${name} use this model. This thread keeps its own model.`;
  }

  return {
    MODEL_ID,
    EFFORTS,
    EFFORT_LABELS,
    canonicalProvider,
    subscriptionProvider,
    providerLabel,
    modelsFromHermes,
    modelsFromList,
    planGroups,
    authorizeUrl,
    claudePaste,
    configModel,
    effortFromConfig,
    applyModelDefault,
    sessionSwitchBody,
    chatFields,
    pillLabel,
    defaultNote,
    keepId,
  };
});
