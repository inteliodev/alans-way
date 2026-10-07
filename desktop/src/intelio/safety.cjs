/** Intelio safety defaults used at the agent navigation boundary. */

const { originAllowed } = require('./origins.cjs');

const CONSEQUENTIAL_ACTIONS = Object.freeze([
  'external_message',
  'purchase',
  'credential_change',
  'permission_change',
  'production_change',
  'destructive',
]);

const SECRET = [
  /bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g,
];

function redact(text) {
  let cleaned = String(text || '');
  for (const pattern of SECRET) cleaned = cleaned.replace(pattern, '[redacted]');
  return cleaned;
}

function safetyDefaults(input) {
  if (input && input.yolo === true) {
    const error = new Error('YOLO is not allowed.');
    error.status = 403;
    throw error;
  }
  if (input && input.consequential && input.consequential !== 'ask') {
    const error = new Error('Consequential actions stay ask-first.');
    error.status = 403;
    throw error;
  }
  return {
    yolo: false,
    consequential: 'ask',
    vaultBlind: true,
    consequentialActions: [...CONSEQUENTIAL_ACTIONS],
  };
}

function classifyUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  if (host === 'paypal.com' || host.endsWith('.paypal.com') || host === 'stripe.com' || host.endsWith('.stripe.com')) return 'purchase';
  const path = parsed.pathname.toLowerCase();
  if (/(?:^|\/)(?:checkout|payment|billing)(?:\/|$)/.test(path)) return 'purchase';
  if (/(?:^|\/)(?:delete-account|destroy|drop-database)(?:\/|$)/.test(path)) return 'destructive';
  return null;
}

function agentNavigationDecision(url, options = {}) {
  // options.approved is intentionally ignored. There is no YOLO bypass.
  const appPages = options.appPages || [];
  if (appPages.includes(url)) return { ok: true };
  const kind = classifyUrl(url);
  if (kind) return { ok: false, status: 409, error: `approval_required: ${kind} stays ask-first.` };
  const origins = options.origins || [];
  if (!originAllowed(url, origins)) return { ok: false, status: 403, error: 'This origin is outside the intelio browsing zone.' };
  return { ok: true };
}

module.exports = { CONSEQUENTIAL_ACTIONS, redact, safetyDefaults, classifyUrl, agentNavigationDecision };
