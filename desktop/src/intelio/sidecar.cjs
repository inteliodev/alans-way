/** Read alans-way.yaml for the VPS host. Decisions stay in safety.cjs. */

const fs = require('node:fs');
const { agentNavigationDecision, safetyDefaults } = require('./safety.cjs');

const TOP_LEVEL = new Set(['hermes_profile', 'browsing_origins', 'safety']);
const SAFETY_KEYS = new Set(['yolo', 'consequential']);

function invalid(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~' || value === '') throw invalid('alans-way.yaml is not valid');
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.length < 2) throw invalid('alans-way.yaml is not valid');
    return value.slice(1, -1);
  }
  if (/[[\]{}#]/.test(value) || value.startsWith('&') || value.startsWith('*') || value.startsWith('!')) {
    throw invalid('alans-way.yaml is not valid');
  }
  return value;
}

function parseSidecar(text) {
  if (typeof text !== 'string' || text.includes('\0') || text.includes('\t')) throw invalid('alans-way.yaml is not valid');
  const doc = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (section === 'origins' && line.startsWith('  - ')) {
      doc.browsing_origins.push(parseScalar(line.slice(4)));
      continue;
    }
    if (section === 'safety' && /^  [a-z_]+:\s+\S/.test(line)) {
      const match = /^  ([a-z_]+):\s+(\S.*)$/.exec(line);
      if (!SAFETY_KEYS.has(match[1]) || Object.prototype.hasOwnProperty.call(doc.safety, match[1])) {
        throw invalid('alans-way.yaml is not valid');
      }
      doc.safety[match[1]] = parseScalar(match[2]);
      continue;
    }
    section = '';
    const top = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!top || line.startsWith(' ')) throw invalid('alans-way.yaml is not valid');
    if (!TOP_LEVEL.has(top[1])) throw invalid('alans-way.yaml has unknown fields');
    if (Object.prototype.hasOwnProperty.call(doc, top[1])) throw invalid('alans-way.yaml is not valid');
    if (top[1] === 'browsing_origins') {
      if (top[2] === '[]') doc.browsing_origins = [];
      else if (top[2] === '') {
        doc.browsing_origins = [];
        section = 'origins';
      } else throw invalid('browsing_origins is invalid');
      continue;
    }
    if (top[1] === 'safety') {
      if (top[2] !== '') throw invalid('alans-way.yaml is not valid');
      doc.safety = {};
      section = 'safety';
      continue;
    }
    doc.hermes_profile = parseScalar(top[2]);
  }
  return doc;
}

function normalizeOrigins(raw) {
  if (!Array.isArray(raw)) throw invalid('browsing_origins is invalid');
  return raw.map((item) => {
    if (typeof item !== 'string') throw invalid('browsing_origins is invalid');
    let url;
    try { url = new URL(item.trim()); } catch { throw invalid('browsing_origins must be http(s) origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
      throw invalid('browsing_origins must be http(s) origins');
    }
    return url.origin;
  });
}

function loadVpsPolicy({ sidecarPath = '' } = {}) {
  const selected = typeof sidecarPath === 'string' ? sidecarPath.trim() : '';
  if (!selected) return { origins: [], safety: safetyDefaults(null), source: 'defaults' };
  let stat;
  try { stat = fs.lstatSync(selected); } catch { throw invalid('alans-way.yaml is missing'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw invalid('alans-way.yaml is missing');
  let text;
  try { text = fs.readFileSync(selected, 'utf8'); } catch { throw invalid('alans-way.yaml is not valid'); }
  const parsed = parseSidecar(text);
  return {
    origins: normalizeOrigins(parsed.browsing_origins || []),
    safety: safetyDefaults(parsed.safety || {}),
    source: selected,
  };
}

function resolveSidecarPath(cfg = {}, env = process.env) {
  const fromEnv = typeof env.INTELIO_SIDECAR === 'string' ? env.INTELIO_SIDECAR.trim() : '';
  if (fromEnv) return fromEnv;
  return typeof cfg.intelioSidecar === 'string' ? cfg.intelioSidecar.trim() : '';
}

function assertLoopbackBrowser(cfg = {}) {
  if (cfg.cdpUrl) {
    let endpoint;
    try { endpoint = new URL(cfg.cdpUrl); } catch { throw new Error('CDP must use a loopback http endpoint.'); }
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
      throw new Error('CDP must use a loopback http endpoint.');
    }
  }
  if (cfg.host && cfg.host !== '127.0.0.1') throw new Error('The VPS broker listens on 127.0.0.1 only.');
  for (const arg of cfg.browserArgs || []) {
    const match = /^--remote-debugging-address=(.*)$/.exec(String(arg));
    if (match && match[1] !== '127.0.0.1') throw new Error('Chromium remote debugging must stay on 127.0.0.1.');
  }
}

function agentUrlDecision(url, policy) {
  return agentNavigationDecision(url, {
    origins: policy?.origins || [],
    appPages: ['about:blank', ''],
  });
}

module.exports = {
  parseSidecar,
  loadVpsPolicy,
  resolveSidecarPath,
  assertLoopbackBrowser,
  agentUrlDecision,
};
