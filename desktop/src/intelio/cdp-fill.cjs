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

function resolveCdpUrl({ profile, root, explicit, env = process.env, fsImpl = fs } = {}) {
  const named = explicit || env.INTELIO_CDP_URL || '';
  if (named) return assertLoopbackCdp(named);
  const id = String(profile || '').trim().toLowerCase();
  if (root && id) {
    const file = path.join(root, id, 'bot-desktop', 'cdp.url');
    try {
      const stored = fsImpl.readFileSync(file, 'utf8').trim();
      if (stored) return assertLoopbackCdp(stored);
    } catch { /* profile has no Bot Desktop CDP file */ }
  }
  return 'http://127.0.0.1:9223';
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

function pickTarget(targets, domain) {
  const pages = (targets || []).filter((target) => target && target.type === 'page' && target.targetId);
  const host = String(domain || '').replace(/^www\./, '').toLowerCase();
  if (host) {
    const match = pages.find((target) => {
      const page = pageHost(target.url);
      return page === host || page.endsWith(`.${host}`);
    });
    if (match) return match;
  }
  return pages[0] || null;
}

async function fillLogin({
  profile,
  root,
  cdpUrl,
  domain,
  selectors,
  values,
  env,
  fsImpl,
  CDPImpl = CDP,
} = {}) {
  const fields = {
    username: String(values?.username || ''),
    password: String(values?.password || ''),
    otp: String(values?.otp || ''),
  };
  const chosen = selectorsFrom(selectors);
  let endpoint = '';
  try {
    endpoint = resolveCdpUrl({ profile, root, explicit: cdpUrl, env, fsImpl });
    const cdp = await CDPImpl.connect(endpoint);
    try {
      const listed = await cdp.send('Target.getTargets');
      const target = pickTarget(listed?.targetInfos, domain);
      if (!target) return { ok: false, filled: false, domain: String(domain || ''), error: 'No browser page.' };
      const page = await cdp.page(target.targetId);
      const result = await page.executeJavaScript(fillExpression(chosen, fields));
      const names = Array.isArray(result?.fields) ? result.fields.filter((name) => ['username', 'password', 'otp'].includes(name)) : [];
      return { ok: result?.filled === true, filled: result?.filled === true, domain: String(domain || ''), fields: names };
    } finally {
      try { cdp.socket.close(); } catch { /* already closed */ }
    }
  } catch (error) {
    return { ok: false, filled: false, domain: String(domain || ''), error: scrub(error?.message, fields) };
  }
}

module.exports = {
  FIELD_SELECTORS,
  selectorsFrom,
  assertLoopbackCdp,
  resolveCdpUrl,
  fillExpression,
  pickTarget,
  fillLogin,
  scrub,
};
