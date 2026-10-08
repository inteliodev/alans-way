'use strict';
/**
 * HTTP routes for the Accounts page and the Settings > Activity list. Mounted by server.cjs
 * after its normal sign-in check (Access JWT or keyed bearer on the cloud listener, Tailscale
 * identity on the tailnet listener), so these routes have exactly the same auth as the rest
 * of /api. Read-only except: starting or cancelling a sign-in the user asked for, sending a
 * paste-back code, and writing the intelio-owned account assignment map.
 *
 *   GET  /api/accounts?profile=X[&fresh=1]  status rows (cached ~60 s, never secrets)
 *   POST /api/accounts/signin               { profile, tool: claude|codex|github, name }
 *   GET  /api/accounts/signin?id=...        sign-in progress (URL, device code, result)
 *   POST /api/accounts/signin/code          { id, code } paste-back code, never logged or stored
 *   POST /api/accounts/signin/cancel        { id }
 *   POST /api/accounts/assign               { profile, tool, account }
 *   GET  /api/activity?agent=&kind=&q=&limit=   (agent filters; profile= only picks the auth key)
 */

const fs = require('node:fs');
const path = require('node:path');
const { createAccounts, sampleStatus } = require('./accounts.cjs');
const { readHermesActivity, profileUsage } = require('./hermes-activity.cjs');
const { activityFile: defaultActivityFile, readActivity, filterActivity, KINDS } = require('../../desktop/src/intelio/activity-log.cjs');

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DAY = 24 * 60 * 60 * 1000;

function createAccountsApi({
  sample = false,
  home,
  profilesRoot,
  vaultCount = () => null,
  accounts = null,
  activityFile = defaultActivityFile(home),
  now = Date.now,
  ttlMs = 60000,
  historyDays = 14,
  readHermes = readHermesActivity,
  usage = profileUsage,
  fsImpl = fs,
} = {}) {
  const activityCache = { at: 0, rows: null };
  // The loopback sample server shows fixed rows unless a test or demo injects its own service.
  const demo = sample && !accounts;

  function profilesOnDisk() {
    try {
      return fsImpl.readdirSync(profilesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SLUG.test(entry.name) && entry.name !== 'default')
        .map((entry) => entry.name)
        .slice(0, 40);
    } catch {
      return [];
    }
  }

  function activityRows({ fresh = false } = {}) {
    if (!fresh && activityCache.rows && now() - activityCache.at < ttlMs) return activityCache.rows;
    const own = readActivity({ file: activityFile, limit: 2000 });
    const hermes = demo ? [] : readHermes({ root: profilesRoot, profiles: profilesOnDisk(), sinceMs: now() - historyDays * DAY });
    const rows = [...own, ...hermes].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, 4000);
    activityCache.rows = rows;
    activityCache.at = now();
    return rows;
  }

  /** Newest activity time per kind for one agent, for the Accounts page "last used" column. */
  function lastUsed(profile) {
    const out = {};
    for (const row of activityRows()) {
      if (row.profile !== profile) continue;
      if (!out[row.kind]) out[row.kind] = row.ts;
    }
    return out;
  }

  const service = accounts || createAccounts({
    home,
    profilesRoot,
    hermesRoot: path.dirname(profilesRoot),
    vaultCount: (id) => {
      const count = vaultCount(id);
      return Number.isInteger(count) ? count : null;
    },
    usage: (id) => usage({ root: profilesRoot, profile: id }),
    lastUsed,
    now,
    ttlMs,
  });

  function fail(send, res, error) {
    const status = Number(error?.status) || 500;
    // Messages are our own fixed strings; anything else becomes a generic line.
    const message = error?.status ? String(error.message || 'That did not work.') : 'That did not work.';
    return send(res, status, { error: message.slice(0, 200) });
  }

  async function handle(req, res, url, { send, readBody, chosenProfile, presentedBearer, mutationOk }) {
    const writing = req.method === 'POST';
    if (writing && !presentedBearer(req).present && !mutationOk(req)) return send(res, 403, { error: 'Cross-origin request refused.' });
    try {
      const body = writing ? await readBody(req, 4096) : {};
      if (req.method === 'GET' && url.pathname === '/api/accounts') {
        const profile = chosenProfile(req, {});
        if (demo) return send(res, 200, sampleStatus(profile, now));
        return send(res, 200, await service.status(profile, { fresh: url.searchParams.get('fresh') === '1' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const profile = String(url.searchParams.get('agent') || '').toLowerCase();
        const rows = filterActivity(activityRows({ fresh: url.searchParams.get('fresh') === '1' }), {
          profile: SLUG.test(profile) ? profile : '',
          kind: url.searchParams.get('kind') || '',
          query: String(url.searchParams.get('q') || '').slice(0, 120),
          limit: Number(url.searchParams.get('limit')) || 200,
        });
        return send(res, 200, { kinds: KINDS, data: rows, sample: demo || undefined });
      }
      if (demo && url.pathname.startsWith('/api/accounts/')) return send(res, 409, { error: 'Sign-in is off in sample mode.' });
      if (req.method === 'POST' && url.pathname === '/api/accounts/signin') {
        return send(res, 200, await service.startSignIn({ profile: chosenProfile(req, body), tool: String(body.tool || ''), name: String(body.name || '') }));
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts/signin') {
        return send(res, 200, await service.signInState(url.searchParams.get('id') || ''));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/signin/code') {
        const result = await service.submitCode({ id: String(body.id || ''), code: body.code });
        body.code = '';
        return send(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/signin/cancel') {
        return send(res, 200, await service.cancelSignIn(String(body.id || '')));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/assign') {
        return send(res, 200, { assigned: service.assign({ profile: chosenProfile(req, body), tool: String(body.tool || ''), account: String(body.account || '') }) });
      }
      return send(res, 404, { error: 'Not found.' });
    } catch (error) {
      return fail(send, res, error);
    }
  }

  return { handle, service, activityRows, lastUsed };
}

module.exports = { createAccountsApi };
