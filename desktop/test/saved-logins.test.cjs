'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createVaultStore } = require('../src/intelio/vault.cjs');
const { createLoginWatch, DISMISS_QUIET, RETRY_WINDOW } = require('../src/intelio/login-watch.cjs');
const { detectExpression, submitExpression, selectorsFrom, fillLogin } = require('../src/intelio/cdp-fill.cjs');
const { publicVaultBody } = require('../src/intelio/remote-vault.cjs');
const { createLoginCards, headline } = require('../src/intelio/login-prompt.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const POSIX = process.platform !== 'win32';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `intelio-${name}-`));
const mode = (file) => fs.statSync(file).mode & 0o777;

function fixture(profiles = ['intelio', 'prc']) {
  const root = tmp('hermes-profiles');
  for (const id of profiles) fs.mkdirSync(path.join(root, id));
  const home = tmp('vault-home');
  return { root, home, data: path.join(home, '.local', 'share', 'intelio', 'vault'), key: path.join(home, '.config', 'intelio', 'keys', 'vault.key') };
}

// ---- vault v2 -------------------------------------------------------------

test('the vault keeps data and key apart, outside ~/.hermes, with private modes', () => {
  const f = fixture();
  const store = createVaultStore({ root: f.root, home: f.home });
  const secret = 'gh-password-never-plain';
  store.saveLogin('intelio', { domain: 'https://github.com/login', username: 'hayden', password: secret });
  const file = path.join(f.data, 'intelio.vault');
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(f.key), true);
  assert.notEqual(path.dirname(file), path.dirname(f.key));
  assert.equal(fs.readdirSync(path.join(f.root, 'intelio')).length, 0, 'nothing is written into the Hermes profile');
  if (POSIX) {
    assert.equal(mode(file), 0o600);
    assert.equal(mode(f.key), 0o600);
    assert.equal(mode(f.data), 0o700);
    assert.equal(mode(path.dirname(f.key)), 0o700);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const envelope = JSON.parse(raw);
  assert.equal(envelope.v, 2);
  assert.equal(envelope.alg, 'A256GCM');
  assert.equal(envelope.kdf, 'HKDF-SHA256');
  for (const plain of [secret, 'hayden', 'github.com']) assert.equal(raw.includes(plain), false);
  assert.equal(store.fillerPayload('intelio', 'github.com').password, secret);
});

test('each agent has its own derived key: a copied file does not open for another agent', () => {
  const f = fixture();
  const store = createVaultStore({ root: f.root, home: f.home });
  store.saveLogin('intelio', { domain: 'github.com', username: 'hayden', password: 'only-intelio' });
  fs.copyFileSync(path.join(f.data, 'intelio.vault'), path.join(f.data, 'prc.vault'));
  assert.deepEqual(store.list('prc'), []);
  assert.equal(store.has('prc', 'github.com'), false);
  assert.throws(() => store.fillerPayload('prc', 'github.com'));
  assert.equal(store.toolResult('prc', 'github.com').filled, false);
});

test('a different master key cannot read the vault', () => {
  const f = fixture();
  createVaultStore({ root: f.root, home: f.home }).saveLogin('intelio', { domain: 'github.com', username: 'h', password: 'pw-1' });
  const other = createVaultStore({ root: f.root, home: f.home, masterKey: crypto.randomBytes(32) });
  assert.deepEqual(other.list('intelio'), []);
});

test('a loose key file is tightened to 0600 and the key may not sit with the data or in ~/.hermes', { skip: !POSIX }, () => {
  const f = fixture();
  const store = createVaultStore({ root: f.root, home: f.home });
  store.saveLogin('intelio', { domain: 'github.com', username: 'h', password: 'pw-2' });
  fs.chmodSync(f.key, 0o644);
  const again = createVaultStore({ root: f.root, home: f.home });
  assert.equal(again.list('intelio').length, 1);
  assert.equal(mode(f.key), 0o600);
  assert.throws(() => createVaultStore({ root: f.root, dataDir: f.data, keyFile: path.join(f.data, 'vault.key') }), /must not sit inside/);
  assert.throws(() => createVaultStore({ root: f.root, dataDir: path.join(f.root, '.vault'), keyFile: f.key }), /outside the Hermes/);
});

test('list, listAll and markUsed carry no secret; lastUsedAt moves on use', () => {
  const f = fixture(['intelio', 'prc', 'hhp']);
  let clock = 1_000;
  const store = createVaultStore({ root: f.root, home: f.home, now: () => clock });
  store.saveLogin('intelio', { domain: 'github.com', username: 'hayden', password: 'pw-a', otp: '123456' });
  store.saveLogin('prc', { domain: 'login.microsoftonline.com', username: 'ops@prc', password: 'pw-b' });
  assert.equal(store.list('intelio')[0].lastUsedAt, 0);
  clock = 5_000;
  assert.equal(store.markUsed('intelio', 'https://github.com/session'), true);
  const all = store.listAll();
  assert.deepEqual(all.map((row) => [row.profile, row.domain, row.username]), [['intelio', 'github.com', 'hayden'], ['prc', 'login.microsoftonline.com', 'ops@prc']]);
  assert.equal(all[0].lastUsedAt, 5_000);
  assert.equal(all[0].createdAt, 1_000);
  const text = JSON.stringify(all);
  for (const secret of ['pw-a', 'pw-b', '123456']) assert.equal(text.includes(secret), false);
});

test('a v1 vault file is migrated once and removed; Hermes core vault/ folder is never touched', () => {
  const f = fixture(['intelio', 'hhp']);
  // v1 layout: <root>/hhp/vault (base64 iv|tag|ct, AAD = profile) + <root>/hhp/vault.key
  const legacyKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
  cipher.setAAD(Buffer.from('hhp'));
  const body = Buffer.concat([cipher.update(JSON.stringify({ logins: [{ domain: 'bank.example', username: 'hhp-user', password: 'legacy-pw' }] })), cipher.final()]);
  fs.writeFileSync(path.join(f.root, 'hhp', 'vault'), Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'), { mode: 0o600 });
  fs.writeFileSync(path.join(f.root, 'hhp', 'vault.key'), legacyKey, { mode: 0o600 });
  // Hermes core: <root>/intelio/vault/ is a directory with its own files.
  fs.mkdirSync(path.join(f.root, 'intelio', 'vault'));
  fs.writeFileSync(path.join(f.root, 'intelio', 'vault', '.vault.lock'), '');
  const store = createVaultStore({ root: f.root, home: f.home });
  assert.equal(store.fillerPayload('hhp', 'bank.example').password, 'legacy-pw');
  assert.equal(fs.existsSync(path.join(f.root, 'hhp', 'vault')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'hhp', 'vault.key')), false);
  assert.equal(fs.existsSync(path.join(f.data, 'hhp.vault')), true);
  // intelio has Hermes's vault/ directory: saving works (no EISDIR) and it is left alone.
  store.saveLogin('intelio', { domain: 'github.com', username: 'hayden', password: 'pw' });
  assert.equal(fs.statSync(path.join(f.root, 'intelio', 'vault')).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'intelio', 'vault')), ['.vault.lock']);
});

test('a systemd credential master key is used and no key file is written', () => {
  const f = fixture();
  const creds = tmp('creds');
  fs.writeFileSync(path.join(creds, 'intelio-vault.key'), crypto.randomBytes(32), { mode: 0o600 });
  const store = createVaultStore({ root: f.root, home: f.home, credentialsDir: creds });
  store.saveLogin('prc', { domain: 'portal.example', username: 'p', password: 'cred-pw' });
  assert.equal(fs.existsSync(f.key), false);
  assert.equal(createVaultStore({ root: f.root, home: f.home, credentialsDir: creds }).fillerPayload('prc', 'portal.example').password, 'cred-pw');
});

// ---- login watch ------------------------------------------------------------

function watchFixture({ pages = [], saved = null } = {}) {
  const f = fixture();
  let clock = 10_000;
  const vault = createVaultStore({ root: f.root, home: f.home, now: () => clock });
  if (saved) vault.saveLogin('intelio', saved);
  const fills = [];
  let fillResult = { ok: true, filled: true, fields: ['username', 'password'] };
  const watch = createLoginWatch({
    vault,
    now: () => clock,
    scanGap: 0,
    scan: async () => pages,
    fill: async (profile, hit, options) => { fills.push({ profile, hit, options }); return fillResult; },
  });
  return {
    vault, watch, fills,
    tick(ms) { clock += ms; },
    setPages(next) { pages = next; },
    setFill(next) { fillResult = next; },
  };
}

test('a sign-in form with no saved login shows one card; Cancel keeps it quiet for a while', async () => {
  const w = watchFixture({ pages: [{ targetId: 't1', domain: 'github.com', needsLogin: true, password: true }] });
  await w.watch.refresh('intelio');
  await w.watch.refresh('intelio');
  const prompts = w.watch.list('intelio');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].state, 'ask');
  assert.equal(prompts[0].domain, 'github.com');
  assert.equal(w.fills.length, 0);
  assert.equal(w.watch.dismiss('intelio', prompts[0].id), true);
  await w.watch.refresh('intelio');
  assert.equal(w.watch.list('intelio').length, 0);
  w.tick(DISMISS_QUIET + 1);
  await w.watch.refresh('intelio');
  assert.equal(w.watch.list('intelio').length, 1);
});

test('a saved login fills and submits by itself and the chat says so', async () => {
  const w = watchFixture({
    pages: [{ targetId: 't1', domain: 'github.com', needsLogin: true, password: true }],
    saved: { domain: 'github.com', username: 'hayden', password: 'gh-saved-pw' },
  });
  await w.watch.refresh('intelio');
  assert.equal(w.fills.length, 1);
  assert.equal(w.fills[0].options.submit, true);
  const [notice] = w.watch.list('intelio');
  assert.equal(notice.state, 'saved');
  assert.equal(notice.username, 'hayden');
  assert.equal(headline(notice, 'intelio'), 'Signed in with saved login for github.com');
  assert.equal(JSON.stringify(w.watch.list('intelio')).includes('gh-saved-pw'), false);
  assert.ok(w.vault.list('intelio')[0].lastUsedAt > 0);
  // Same form back right away: the saved login did not work. Ask, do not retry.
  w.setPages([{ targetId: 't1', domain: 'github.com', needsLogin: true, password: true }]);
  w.tick(5_000);
  await w.watch.refresh('intelio');
  assert.equal(w.fills.length, 1);
  const ask = w.watch.list('intelio').find((p) => p.state === 'ask');
  assert.match(ask.message, /did not work/);
  assert.ok(RETRY_WINDOW > 5_000);
});

test('a two-step form fills the username page, then the password page', async () => {
  const w = watchFixture({
    pages: [{ targetId: 't1', domain: 'accounts.google.com', needsLogin: true, identifierFirst: true }],
    saved: { domain: 'google.com', username: 'hayden@intelio.co', password: 'g-pw' },
  });
  await w.watch.refresh('intelio');
  w.setPages([{ targetId: 't1', domain: 'accounts.google.com', needsLogin: true, password: true }]);
  w.tick(3_000);
  await w.watch.refresh('intelio');
  assert.equal(w.fills.length, 2);
  assert.equal(w.watch.list('intelio').some((p) => p.state === 'ask'), false);
});

test('request_login waits for the card and gets only filled/domain/username back', async () => {
  const w = watchFixture();
  const pending = w.watch.request('intelio', { site: 'https://github.com/login', reason: 'Push the release branch', wait: 5 });
  await new Promise((r) => setImmediate(r));
  const [card] = w.watch.list('intelio');
  assert.equal(card.source, 'agent');
  assert.equal(card.reason, 'Push the release branch');
  w.watch.resolved('intelio', card.id, { filled: true, saved: true, domain: 'github.com', username: 'hayden', fields: ['username', 'password'] });
  const result = await pending;
  assert.deepEqual({ ok: result.ok, filled: result.filled, domain: result.domain, username: result.username }, { ok: true, filled: true, domain: 'github.com', username: 'hayden' });
  assert.equal(w.watch.list('intelio')[0].state, 'filled');
});

test('request_login with a saved login fills now; Cancel answers a waiting tool', async () => {
  const w = watchFixture({ saved: { domain: 'github.com', username: 'hayden', password: 'pw' } });
  const now = await w.watch.request('intelio', { site: 'github.com' });
  assert.equal(now.filled, true);
  assert.equal(now.saved, true);
  assert.equal(JSON.stringify(now).includes('pw"'), false);
  const waiting = w.watch.request('intelio', { site: 'gitlab.com', wait: 5 });
  await new Promise((r) => setImmediate(r));
  const card = w.watch.list('intelio').find((p) => p.state === 'ask');
  w.watch.dismiss('intelio', card.id);
  assert.equal((await waiting).status, 'cancelled');
});

// ---- filler scripts ---------------------------------------------------------

test('the page scan returns booleans only and the submit script reads no values', () => {
  const detect = detectExpression();
  // The only read of a field value is a negated emptiness check.
  assert.equal(detect.split('.value').length, detect.split('!el.value').length);
  assert.match(detect, /empty:/);
  assert.match(detect, /new-password/);
  const submit = submitExpression(selectorsFrom({}));
  assert.equal(submit.includes('.value'), false);
  new Function(detect);
  new Function(submit);
});

test('fillLogin submits only after typing on the matching host', async () => {
  const calls = [];
  const fake = {
    async connect() {
      return {
        socket: { close() {} },
        async send(method) {
          if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'a', url: 'https://github.com/login' }] };
          if (method === 'Target.getTargetInfo') return { targetInfo: { url: 'https://github.com/login' } };
          return {};
        },
        async page() {
          return { executeJavaScript: async (expr) => { calls.push(expr.includes('submit(') ? 'submit' : 'fill'); return expr.includes('submit(') ? { submitted: true } : { filled: true, fields: ['username', 'password'].filter((n) => expr.includes(`"${n}":{"selector"`) && !expr.includes(`"${n}":{"selector":${JSON.stringify(selectorsFrom({})[n])},"value":""`)) }; } };
        },
      };
    },
  };
  const result = await fillLogin({ cdpUrl: 'http://127.0.0.1:9223', domain: 'github.com', values: { username: 'h', password: 'secret-pw' }, submit: true, CDPImpl: fake });
  assert.equal(result.submitted, true);
  assert.deepEqual(calls, ['fill', 'fill', 'submit']);
  assert.equal(JSON.stringify(result).includes('secret-pw'), false);
});

test('the desktop vault bridge passes prompts and last used but nothing secret', () => {
  const body = publicVaultBody({
    ok: true,
    prompts: [{ id: 'p1', profile: 'intelio', domain: 'github.com', state: 'ask', reason: 'r', password: 'leak' }],
    logins: [{ domain: 'github.com', username: 'h', profile: 'intelio', lastUsedAt: 7, password: 'leak', otp: '1' }],
    prompt: { id: 'p1', state: 'filled', password: 'leak' },
    password: 'leak',
  });
  assert.equal(JSON.stringify(body).includes('leak'), false);
  assert.equal(body.prompts[0].domain, 'github.com');
  assert.equal(body.logins[0].lastUsedAt, 7);
  assert.equal(body.prompt.state, 'filled');
});

// ---- server routes ----------------------------------------------------------

function request(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('prompt routes: card submit saves, fills, and no response or log carries the password', async () => {
  const KEY = 'intelio-key-test-0001';
  const vaultRoot = tmp('route-vault');
  fs.mkdirSync(path.join(vaultRoot, 'intelio'));
  fs.mkdirSync(path.join(vaultRoot, 'prc'));
  const secret = 'card-typed-password';
  const logs = [];
  const fills = [];
  let pages = [{ targetId: 't1', domain: 'github.com', needsLogin: true, password: true }];
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch,
    vaultRoot,
    profileOps: { keyFor: (id) => (id === 'intelio' ? KEY : 'prc-key-test-000001') },
    loginScan: async () => pages,
    filler: async ({ values, submit }) => { fills.push({ submit, hasPassword: Boolean(values.password) }); return { ok: true, filled: true, domain: 'github.com', fields: ['username', 'password'], password: values.password }; },
    log: (line) => logs.push(line),
  });
  const address = await app.listen();
  const auth = { authorization: `Bearer ${KEY}`, 'x-intelio-profile': 'intelio' };
  try {
    const first = await request(address.port, 'GET', '/api/vault/prompts?profile=intelio', { headers: auth });
    assert.equal(first.status, 200);
    const [card] = JSON.parse(first.body).prompts;
    assert.equal(card.state, 'ask');
    assert.equal(card.domain, 'github.com');
    const submit = await request(address.port, 'POST', '/api/vault/login', {
      headers: auth,
      body: JSON.stringify({ profile: 'intelio', promptId: card.id, domain: 'github.com', username: 'hayden', password: secret, save: true, submit: true }),
    });
    assert.equal(submit.status, 200);
    const done = JSON.parse(submit.body);
    assert.equal(done.filled, true);
    assert.equal(done.saved, true);
    assert.equal(done.prompt.state, 'filled');
    assert.deepEqual(fills[0], { submit: true, hasPassword: true });
    pages = [];
    const after = await request(address.port, 'GET', '/api/vault/prompts?profile=intelio', { headers: auth });
    assert.equal(JSON.parse(after.body).prompts[0].state, 'filled');
    const own = await request(address.port, 'GET', '/api/vault/logins?all=1', { headers: auth });
    const rows = JSON.parse(own.body).logins;
    assert.deepEqual(rows.map((r) => [r.domain, r.username]), [['github.com', 'hayden']]);
    assert.ok(rows[0].lastUsedAt > 0);
    assert.equal(rows[0].profile, undefined, 'a profile key never gets the all-agents list');
    const agentAsk = await request(address.port, 'POST', '/api/vault/prompt', { headers: auth, body: JSON.stringify({ profile: 'intelio', site: 'github.com' }) });
    assert.equal(JSON.parse(agentAsk.body).filled, true, 'the saved login is used for the agent tool');
    const wrongKey = await request(address.port, 'GET', '/api/vault/prompts?profile=prc', { headers: { authorization: `Bearer ${KEY}`, 'x-intelio-profile': 'prc' } });
    assert.equal(wrongKey.status, 401);
    const spilled = [first.body, submit.body, after.body, own.body, agentAsk.body, ...logs].join('\n');
    assert.equal(spilled.includes(secret), false);
    assert.equal(spilled.includes(KEY), false);
    // The vault file is outside the Hermes profile tree and holds no plaintext.
    const vaultFile = path.join(`${path.resolve(vaultRoot)}.intelio-home`, '.local', 'share', 'intelio', 'vault', 'intelio.vault');
    assert.equal(fs.readFileSync(vaultFile, 'utf8').includes(secret), false);
    assert.equal(fs.readdirSync(path.join(vaultRoot, 'intelio')).length, 0);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

// ---- card UI ----------------------------------------------------------------

function fakeDoc() {
  let focused = null;
  function node(tag) {
    const n = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, dataset: {}, attrs: {}, listeners: {}, className: '', textContent: '', hidden: false, value: '', type: '', checked: false, disabled: false,
      classList: {
        toggle(name, force) { const set = new Set(n.className.split(' ').filter(Boolean)); const on = force === undefined ? !set.has(name) : force; on ? set.add(name) : set.delete(name); n.className = [...set].join(' '); },
        contains(name) { return n.className.split(' ').includes(name); },
      },
      setAttribute(k, v) { n.attrs[k] = String(v); },
      getAttribute(k) { return n.attrs[k]; },
      append(...kids) { for (const kid of kids) { if (kid.parentNode) kid.remove(); kid.parentNode = n; n.children.push(kid); } },
      remove() { if (n.parentNode) { n.parentNode.children = n.parentNode.children.filter((c) => c !== n); n.parentNode = null; } },
      addEventListener(type, fn) { (n.listeners[type] ||= []).push(fn); },
      fire(type) { for (const fn of n.listeners[type] || []) fn({ preventDefault() {} }); },
      click() { n.fire('click'); },
      focus() { focused = n; },
      contains(other) { for (let c = other; c; c = c.parentNode) if (c === n) return true; return false; },
      all() { return n.children.flatMap((c) => [c, ...c.all()]); },
      querySelector(sel) {
        const [cls, attr] = sel.replace(/^\./, '').split('[');
        return n.all().find((c) => c.className.split(' ').includes(cls) && (!attr || c[attr.replace(']', '')])) || null;
      },
    };
    return n;
  }
  return { createElement: node, get activeElement() { return focused; } };
}

test('the card asks with a masked password, remembers by default, and clears the field on Sign in', async () => {
  const doc = fakeDoc();
  const sent = [];
  const cards = createLoginCards({ doc, agentName: (id) => (id === 'intelio' ? 'intelio' : id.toUpperCase()), send: async (action, payload) => { sent.push({ action, payload: { ...payload } }); return { ok: true, filled: true, saved: true, prompt: { id: payload.promptId, profile: 'intelio', domain: 'github.com', state: 'filled', username: payload.username } }; } });
  cards.update([{ id: 'p1', profile: 'intelio', domain: 'github.com', state: 'ask', reason: '' }]);
  const card = cards.cards.get('p1');
  assert.equal(card.querySelector('.login-card-title').textContent, 'intelio is trying to sign in to github.com');
  const inputs = card.all().filter((n) => n.tagName === 'INPUT');
  const user = inputs.find((n) => n.name === 'username');
  const pass = inputs.find((n) => n.name === 'password');
  const remember = inputs.find((n) => n.name === 'remember');
  assert.equal(pass.type, 'password');
  assert.equal(remember.checked, true);
  assert.equal(card.all().some((n) => /needs you/i.test(n.textContent)), false);
  const reveal = card.querySelector('.login-card-reveal');
  reveal.click();
  assert.equal(pass.type, 'text');
  reveal.click();
  assert.equal(pass.type, 'password');
  // A repaint keeps the same nodes, so typing survives.
  user.value = 'hayden';
  pass.value = 'typed-secret';
  cards.update([{ id: 'p1', profile: 'intelio', domain: 'github.com', state: 'ask' }]);
  assert.equal(cards.cards.get('p1'), card);
  assert.equal(pass.value, 'typed-secret');
  card.querySelector('.login-card-form').fire('submit');
  assert.equal(pass.value, '', 'the field is cleared as soon as it is read');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[0].action, 'submit');
  assert.deepEqual({ ...sent[0].payload, password: sent[0].payload.password ? 'set' : '' }, { promptId: 'p1', profile: 'intelio', domain: 'github.com', username: 'hayden', password: 'set', save: true, submit: true });
  assert.equal(card.dataset.state, 'filled');
  assert.equal(card.querySelector('.login-card-title').textContent, 'Signed in to github.com');
  assert.equal(card.querySelector('.login-card-form'), null);
  assert.equal(card.all().some((n) => n.textContent.includes('typed-secret')), false);
});

test('Cancel dismisses, and a saved-login notice reads plainly', async () => {
  const doc = fakeDoc();
  const sent = [];
  const cards = createLoginCards({ doc, send: async (action, payload) => { sent.push(action); return { ok: true }; } });
  cards.update([{ id: 'a', profile: 'prc', domain: 'portal.example', state: 'ask' }, { id: 'n', profile: 'intelio', domain: 'github.com', state: 'saved', username: 'hayden' }]);
  assert.equal(cards.cards.get('n').querySelector('.login-card-title').textContent, 'Signed in with saved login for github.com');
  cards.cards.get('a').querySelector('.login-card-cancel').click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ['dismiss']);
  assert.equal(cards.size(), 1);
});

test('desktop and phone load the card, Settings lists every agent, and the styles avoid yellow and lime', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  assert.match(read('src/index.html'), /<script src="intelio\/login-prompt\.cjs"><\/script>/);
  assert.match(read('src/index.html'), /id="login-prompts"/);
  assert.match(read('../mobile/pwa/public/index.html'), /\/ui\/intelio\/login-prompt\.cjs/);
  assert.match(read('../mobile/pwa/server.cjs'), /'intelio\/login-prompt\.cjs'/);
  const renderer = read('src/renderer.js');
  assert.match(renderer, /paintSavedLogins/);
  assert.match(renderer, /savedLoginWhen\(row\.lastUsedAt\)/);
  assert.match(read('../mobile/pwa/public/app.js'), /\/api\/vault\/logins\?all=1/);
  const css = [read('src/remote-main.css'), read('src/theme-light.css'), read('../mobile/pwa/public/app.css')].join('\n');
  const rules = css.split('}').filter((rule) => /login-card|saved-login/.test(rule)).join('}');
  assert.ok(rules.length > 500);
  assert.doesNotMatch(rules, /yellow|lime|#ff0|#ffff00|#cddc39|#c6ff00|#d4ff00|#e6ff00|#ffd60a|#ffcc00/i);
  const prompt = read('src/intelio/login-prompt.cjs');
  assert.doesNotMatch(prompt, /Needs you/i);
  assert.doesNotMatch(prompt, /'[^'\n]*Intelio[^'\n]*'|`[^`\n]*Intelio/);
  assert.doesNotMatch(prompt, /localStorage|sessionStorage|console\./);
});

test('the Hermes plugin adds request_login without returning secrets', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '../../plugins/intelio-vault', rel), 'utf8');
  assert.match(read('__init__.py'), /name="request_login"/);
  assert.match(read('plugin.yaml'), /- request_login/);
  const fill = read('fill.py');
  assert.match(fill, /\/api\/vault\/prompt/);
  assert.match(fill, /PUBLIC_KEYS = \("ok", "filled", "saved", "pending", "status", "domain", "username", "error"\)/);
});
