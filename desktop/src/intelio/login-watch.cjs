'use strict';
/**
 * Saved-login prompts for the intelio chat. Runs in the PWA server (the
 * intelio layer); Hermes core is not involved.
 *
 * Two ways a prompt starts:
 *  - the agent's browser shows a sign-in form (scanLoginPages, booleans only)
 *  - the agent calls request_login(site, reason) from the intelio-vault plugin
 * With a saved login for that site the form is filled and submitted from the
 * vault and the chat gets a notice. Without one the chat shows a card; the
 * typed values go from the card to POST /api/vault/login and never come back.
 * Nothing here returns, stores, or logs a password or one-time code.
 */
const crypto = require('node:crypto');
const { normalizeDomain, domainsMatch } = require('./vault.cjs');

const ASK_TTL = 15 * 60_000;
const NOTICE_TTL = 2 * 60_000;
const DISMISS_QUIET = 10 * 60_000;
const RETRY_WINDOW = 2 * 60_000;
const SCAN_GAP = 3_000;
const MAX_WAIT_S = 110;

function cleanText(text, max = 160) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function createLoginWatch({
  vault,
  fill,
  scan = null,
  now = () => Date.now(),
  scanGap = SCAN_GAP,
} = {}) {
  if (!vault || typeof fill !== 'function') throw new Error('Login watch needs the vault and a filler.');
  const books = new Map();
  const quiet = new Map();
  const tried = new Map();
  const scans = new Map();
  let timer = null;

  const key = (profile, domain) => `${profile}|${domain}`;
  function book(profile) {
    if (!books.has(profile)) books.set(profile, new Map());
    return books.get(profile);
  }
  function prune(profile) {
    const items = book(profile);
    const at = now();
    for (const [id, item] of items) {
      const ttl = item.state === 'ask' ? ASK_TTL : NOTICE_TTL;
      if (item.state === 'gone' || at - item.updatedAt > ttl) {
        settle(item, { ok: false, filled: false, domain: item.domain, status: item.state === 'ask' ? 'expired' : item.state });
        items.delete(id);
      }
    }
    return items;
  }
  function settle(item, result) {
    const waiters = item.waiters || [];
    item.waiters = [];
    for (const done of waiters) done(result);
  }
  function asking(profile, domain) {
    for (const item of prune(profile).values()) {
      if (item.state === 'ask' && (domainsMatch(item.domain, domain) || domainsMatch(domain, item.domain))) return item;
    }
    return null;
  }
  function add(profile, { domain, reason = '', source = 'browser', state = 'ask', username = '', message = '' }) {
    const at = now();
    const item = {
      id: crypto.randomBytes(9).toString('base64url'),
      profile,
      domain,
      reason: cleanText(reason),
      source,
      state,
      username: cleanText(username, 200),
      message: cleanText(message),
      misses: 0,
      createdAt: at,
      updatedAt: at,
      waiters: [],
    };
    prune(profile).set(item.id, item);
    return item;
  }
  function publicPrompt(item) {
    return {
      id: item.id,
      profile: item.profile,
      domain: item.domain,
      state: item.state,
      source: item.source,
      reason: item.reason,
      ...(item.message ? { message: item.message } : {}),
      ...(item.state !== 'ask' && item.username ? { username: item.username } : {}),
      at: item.updatedAt,
    };
  }
  function list(profile) {
    return [...prune(profile).values()].map(publicPrompt).sort((a, b) => a.at - b.at);
  }
  // stage: 'identifier' when only the username box was filled (two-step forms).
  function noteTried(profile, domain, stage) {
    tried.set(key(profile, domain), { at: now(), stage });
  }
  async function useSaved(profile, domain, stage) {
    const hit = vault.fillerPayload(profile, domain);
    if (!hit) return null;
    noteTried(profile, hit.domain, stage);
    let result;
    try { result = await fill(profile, hit, { submit: true }); } catch { result = null; }
    if (result?.filled === true) {
      vault.markUsed(profile, hit.domain);
      add(profile, { domain: hit.domain, state: 'saved', username: hit.username || '' });
      return { ok: true, filled: true, saved: true, domain: hit.domain, username: hit.username || '' };
    }
    return { ok: false, filled: false, saved: true, domain: hit.domain, error: 'No matching page. Open the sign-in page first.' };
  }
  async function consider(profile, page) {
    const domain = page.domain;
    if (!page.needsLogin || !domain) return;
    if (asking(profile, domain)) return;
    if ((quiet.get(key(profile, domain)) || 0) > now()) return;
    const stage = page.identifierFirst ? 'identifier' : 'password';
    const saved = vault.has(profile, domain);
    let last = null;
    for (const [k, v] of tried) if (k.startsWith(`${profile}|`) && domainsMatch(k.slice(profile.length + 1), domain)) last = v;
    const recent = last && now() - last.at < RETRY_WINDOW;
    const nextStep = recent && last.stage === 'identifier' && stage === 'password';
    if (saved && (!recent || nextStep)) {
      const done = await useSaved(profile, domain, stage);
      if (done?.filled) return;
    }
    const failed = recent && !nextStep;
    add(profile, {
      domain,
      source: 'browser',
      message: failed ? `That login did not work for ${domain}. Enter it again.` : '',
    });
  }
  async function refresh(profile) {
    if (typeof scan !== 'function') return;
    const state = scans.get(profile);
    if (state?.promise) return state.promise;
    if (state && now() - state.at < scanGap) return;
    const promise = (async () => {
      let pages;
      try { pages = await scan(profile); } catch { return; }
      if (!Array.isArray(pages)) return;
      for (const page of pages) {
        try { await consider(profile, page); } catch { /* next page */ }
      }
      // A browser card whose form is gone twice in a row (signed in on
      // screen, page closed) is cleared.
      for (const item of prune(profile).values()) {
        if (item.state !== 'ask' || item.source !== 'browser') continue;
        const still = pages.some((page) => page.needsLogin && domainsMatch(item.domain, page.domain));
        item.misses = still ? 0 : item.misses + 1;
        if (item.misses >= 2) { item.state = 'gone'; settle(item, { ok: false, filled: false, domain: item.domain, status: 'gone' }); }
      }
    })();
    scans.set(profile, { at: now(), promise });
    try { await promise; } finally { scans.set(profile, { at: now(), promise: null }); }
  }
  function wait(item, seconds) {
    const limit = Math.max(0, Math.min(MAX_WAIT_S, Number(seconds) || 0));
    if (!limit) return Promise.resolve({ ok: true, filled: false, pending: true, domain: item.domain, status: 'waiting' });
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        item.waiters = item.waiters.filter((fn) => fn !== done);
        resolve({ ok: true, filled: false, pending: true, domain: item.domain, status: 'waiting' });
      }, limit * 1000);
      if (t.unref) t.unref();
      function done(result) { clearTimeout(t); resolve(result); }
      item.waiters.push(done);
    });
  }

  return {
    list,
    refresh,
    // From the agent tool. Saved: fill now. Not saved: show the card and
    // optionally wait for the person.
    async request(profile, { site, reason, wait: seconds } = {}) {
      let domain;
      try { domain = normalizeDomain(site); } catch { return { ok: false, filled: false, error: 'Enter a site domain.' }; }
      if (vault.has(profile, domain)) {
        const done = await useSaved(profile, domain, 'password');
        if (done) return done;
      }
      const item = asking(profile, domain) || add(profile, { domain, reason, source: 'agent' });
      if (reason && !item.reason) item.reason = cleanText(reason);
      const result = await wait(item, seconds);
      return { ...result, promptId: item.id };
    },
    // After POST /api/vault/login. The result passed in is already public.
    resolved(profile, promptId, { filled = false, saved = false, domain = '', username = '', fields = [] } = {}) {
      const items = prune(profile);
      const item = promptId ? items.get(String(promptId)) : null;
      let host = '';
      try { host = normalizeDomain(domain || item?.domain); } catch { host = item?.domain || ''; }
      if (filled && host) noteTried(profile, host, Array.isArray(fields) && !fields.includes('password') ? 'identifier' : 'password');
      if (filled && saved && host) vault.markUsed(profile, host);
      if (!item) return null;
      if (!filled && !saved) {
        item.message = `Could not find the sign-in page for ${item.domain}. Open it in the agent's browser and try again.`;
        item.updatedAt = now();
        return publicPrompt(item);
      }
      item.state = filled ? 'filled' : 'stored';
      item.username = cleanText(username, 200);
      item.message = '';
      item.updatedAt = now();
      settle(item, { ok: true, filled, saved, domain: item.domain, ...(username ? { username: cleanText(username, 200) } : {}), status: item.state });
      return publicPrompt(item);
    },
    dismiss(profile, promptId) {
      const items = prune(profile);
      const item = items.get(String(promptId || ''));
      if (!item) return false;
      if (item.state === 'ask') quiet.set(key(profile, item.domain), now() + DISMISS_QUIET);
      settle(item, { ok: false, filled: false, domain: item.domain, status: 'cancelled' });
      items.delete(item.id);
      return true;
    },
    start(intervalMs, profiles) {
      if (timer || !(intervalMs > 0) || typeof scan !== 'function') return;
      timer = setInterval(async () => {
        let ids = [];
        try { ids = typeof profiles === 'function' ? await profiles() : profiles || []; } catch { ids = []; }
        for (const id of ids) await refresh(id);
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const items of books.values()) for (const item of items.values()) settle(item, { ok: false, filled: false, domain: item.domain, status: 'closed' });
    },
  };
}

module.exports = { createLoginWatch, cleanText, ASK_TTL, NOTICE_TTL, DISMISS_QUIET, RETRY_WINDOW };
