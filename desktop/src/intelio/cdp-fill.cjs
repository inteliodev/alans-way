'use strict';
/**
 * VPS filler. Types Secure Sign-in values into the profile's agent browser
 * or Bot Desktop Chromium over loopback CDP. The return value never includes
 * a password or one-time code.
 */
const fs = require('node:fs');
const path = require('node:path');
const { CDP } = require('../cdp.cjs');

const FIELD_SELECTORS = {
  username: 'input[autocomplete="username"], input[type="email"], input[name="username"], input[name="email"]',
  password: 'input[autocomplete="current-password"], input[name="password"], input[type="password"]:not([autocomplete="one-time-code"])',
  otp: 'input[autocomplete="one-time-code"], input[name="otp"], input[name="code"]',
};

function cleanSelector(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 300 || /[\r\n]/.test(text)) return '';
  return text;
}

function selectorsFrom(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    username: cleanSelector(raw.username) || FIELD_SELECTORS.username,
    password: cleanSelector(raw.password) || FIELD_SELECTORS.password,
    otp: cleanSelector(raw.otp) || FIELD_SELECTORS.otp,
  };
}

function assertLoopbackCdp(endpoint) {
  let url;
  try { url = new URL(String(endpoint || '').trim()); } catch { throw new Error('CDP must use a loopback http endpoint.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('CDP must use a loopback http endpoint.');
  }
  return url.origin;
}

const SHARED_CDP = 'http://127.0.0.1:9223';
const NO_PROFILE_BROWSER = 'No per-profile browser. Write bot-desktop/cdp.url for this profile.';

function resolveCdpUrl({ profile, root, explicit, fsImpl = fs } = {}) {
  // INTELIO_CDP_URL is process-wide. The multiplexed gateway must not point
  // every profile at that one browser. Only this profile's cdp.url counts.
  const id = String(profile || '').trim().toLowerCase();
  if (root && id) {
    const desktop = path.join(root, id, 'bot-desktop');
    let stored = '';
    try { stored = fsImpl.readFileSync(path.join(desktop, 'cdp.url'), 'utf8').trim(); } catch { stored = ''; }
    if (stored) return assertLoopbackCdp(stored);
    if (fsImpl.existsSync(path.join(desktop, 'allow-shared-browser'))) return SHARED_CDP;
    throw new Error(NO_PROFILE_BROWSER);
  }
  if (explicit) return assertLoopbackCdp(explicit);
  throw new Error(NO_PROFILE_BROWSER);
}

function scrub(message, values) {
  let out = String(message || 'Could not type into the browser.');
  for (const value of Object.values(values || {})) {
    const secret = String(value || '');
    if (secret.length >= 3) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 160);
}

function fillExpression(selectors, values) {
  const spec = {
    username: { selector: selectors.username, value: String(values.username || '') },
    password: { selector: selectors.password, value: String(values.password || '') },
    otp: { selector: selectors.otp, value: String(values.otp || '') },
  };
  const fn = function fill(fields) {
    function setField(selector, value) {
      if (!selector || !value) return false;
      const el = document.querySelector(selector);
      if (!el) return false;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const filled = ['username', 'password', 'otp'].filter((name) => setField(fields[name].selector, fields[name].value));
    return { filled: filled.length > 0, fields: filled };
  };
  return `(${fn.toString()})(${JSON.stringify(spec)})`;
}

function pageHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function savedHost(domain) {
  const raw = String(domain || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) return pageHost(raw);
  return raw.replace(/^www\./, '').split('/')[0].split(':')[0].toLowerCase();
}

function hostMatches(url, domain) {
  const host = savedHost(domain);
  const page = pageHost(url);
  if (!host || !page) return false;
  return page === host || page.endsWith(`.${host}`);
}

function pickTarget(targets, domain) {
  const pages = (targets || []).filter((target) => target && target.type === 'page' && target.targetId);
  const host = savedHost(domain);
  if (!host) return null;
  return pages.find((target) => hostMatches(target.url, host)) || null;
}

async function pageUrl(cdp, page, targetId) {
  try {
    const info = await cdp.send('Target.getTargetInfo', { targetId });
    const url = info?.targetInfo?.url || info?.url || '';
    if (url) return url;
  } catch { /* the page location is the second check */ }
  try {
    const href = await page.executeJavaScript('location.href');
    if (typeof href === 'string' && href) return href;
  } catch { /* refuse to type when the host cannot be read */ }
  return '';
}

// Submits the form that holds the typed field: its submit button, else
// requestSubmit(). Returns booleans only.
function submitExpression(selectors) {
  const fn = function submit(sel) {
    const el = document.querySelector(sel.password) || document.querySelector(sel.username);
    if (!el) return { submitted: false };
    const form = el.form || el.closest('form');
    const button = form
      ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
      : null;
    if (button && !button.disabled) { button.click(); return { submitted: true }; }
    if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return { submitted: true }; }
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return { submitted: true };
  };
  return `(${fn.toString()})(${JSON.stringify({ username: selectors.username, password: selectors.password })})`;
}

// Looks for a visible sign-in form. Reads no field values: only whether a
// password box is empty. Returns booleans.
function detectExpression() {
  const fn = function detect(userSel) {
    function shown(el) {
      if (!el || el.disabled || el.readOnly) return false;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05;
    }
    const pw = Array.from(document.querySelectorAll('input[type="password"]')).filter(shown);
    const fresh = pw.filter((el) => /new-password/i.test(el.getAttribute('autocomplete') || ''));
    const login = pw.filter((el) => !fresh.includes(el));
    const user = Array.from(document.querySelectorAll(userSel)).filter(shown);
    const words = `${location.pathname} ${document.title}`;
    const loginish = /(log[-_ ]?in|sign[-_ ]?in|signin|auth|session|identifier)/i.test(words);
    return {
      password: login.length > 0,
      signup: fresh.length > 0 && login.length === 0,
      username: user.length > 0,
      identifierFirst: pw.length === 0 && user.length > 0 && loginish,
      empty: login.length > 0 && login.every((el) => !el.value),
    };
  };
  return `(${fn.toString()})(${JSON.stringify(FIELD_SELECTORS.username)})`;
}

function webPage(target) {
  return target && target.type === 'page' && target.targetId && /^https?:\/\//i.test(String(target.url || ''));
}

// One pass over the profile browser's tabs. Each result names the page host
// and what kind of sign-in form is showing; nothing typed is read back.
async function scanLoginPages({ profile, root, cdpUrl, fsImpl, CDPImpl = CDP, limit = 6 } = {}) {
  const endpoint = resolveCdpUrl({ profile, root, explicit: cdpUrl, fsImpl });
  const cdp = await CDPImpl.connect(endpoint);
  const found = [];
  try {
    const listed = await cdp.send('Target.getTargets');
    const pages = (listed?.targetInfos || []).filter(webPage).slice(0, limit);
    for (const target of pages) {
      let page;
      try {
        page = await cdp.page(target.targetId);
        const seen = await page.executeJavaScript(detectExpression());
        const host = pageHost(target.url);
        if (!host || !seen) continue;
        const needsLogin = seen.signup !== true && ((seen.password === true && seen.empty === true) || seen.identifierFirst === true);
        found.push({ targetId: target.targetId, domain: host, needsLogin, password: seen.password === true, identifierFirst: seen.identifierFirst === true });
      } catch { /* a page that cannot be read is skipped */ }
      finally {
        if (page?.sessionId) { try { await cdp.send('Target.detachFromTarget', { sessionId: page.sessionId }); } catch { /* gone */ } }
      }
    }
  } finally {
    try { cdp.socket.close(); } catch { /* already closed */ }
  }
  return found;
}

async function fillLogin({
  profile,
  root,
  cdpUrl,
  domain,
  selectors,
  values,
  submit = false,
  fsImpl,
  CDPImpl = CDP,
} = {}) {
  const fields = {
    username: String(values?.username || ''),
    password: String(values?.password || ''),
    otp: String(values?.otp || ''),
  };
  const chosen = selectorsFrom(selectors);
  const site = String(domain || '');
  if (!savedHost(site)) return { ok: false, filled: false, domain: site, error: 'No matching page.' };
  let endpoint = '';
  try {
    endpoint = resolveCdpUrl({ profile, root, explicit: cdpUrl, fsImpl });
    const cdp = await CDPImpl.connect(endpoint);
    try {
      const listed = await cdp.send('Target.getTargets');
      const target = pickTarget(listed?.targetInfos, site);
      if (!target) return { ok: false, filled: false, domain: site, error: 'No matching page.' };
      const page = await cdp.page(target.targetId);
      const typed = [];
      for (const name of ['username', 'password', 'otp']) {
        if (!fields[name]) continue;
        const url = await pageUrl(cdp, page, target.targetId);
        if (!hostMatches(url, site)) {
          const error = typed.length ? 'Page left the saved site.' : 'No matching page.';
          return { ok: false, filled: false, domain: site, error, fields: typed };
        }
        const one = { username: '', password: '', otp: '', [name]: fields[name] };
        const result = await page.executeJavaScript(fillExpression(chosen, one));
        const names = Array.isArray(result?.fields) ? result.fields : [];
        if (result?.filled === true && names.includes(name)) typed.push(name);
      }
      let submitted = false;
      if (submit === true && typed.length) {
        const url = await pageUrl(cdp, page, target.targetId);
        if (hostMatches(url, site)) {
          try { submitted = (await page.executeJavaScript(submitExpression(chosen)))?.submitted === true; } catch { submitted = false; }
        }
      }
      return { ok: typed.length > 0, filled: typed.length > 0, domain: site, fields: typed, ...(submit === true ? { submitted } : {}) };
    } finally {
      try { cdp.socket.close(); } catch { /* already closed */ }
    }
  } catch (error) {
    return { ok: false, filled: false, domain: site, error: scrub(error?.message, fields) };
  }
}

module.exports = {
  FIELD_SELECTORS,
  selectorsFrom,
  assertLoopbackCdp,
  resolveCdpUrl,
  fillExpression,
  submitExpression,
  detectExpression,
  scanLoginPages,
  hostMatches,
  pickTarget,
  fillLogin,
  scrub,
};
