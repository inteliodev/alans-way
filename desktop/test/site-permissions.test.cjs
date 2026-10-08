const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSitePermissions, installAppMicrophone, appMediaPage, mediaTypesOf } = require('../src/site-permissions.cjs');

function fixture(initial = {}, answer = false) {
  let prefs = JSON.parse(JSON.stringify(initial)), prompts = 0, saved, eligible = true, url = 'https://www.google.com/';
  const wc = { getURL: () => url, isDestroyed: () => false };
  const session = { setPermissionRequestHandler(fn) { this.request = fn; }, setPermissionCheckHandler(fn) { this.check = fn; } };
  const manager = createSitePermissions({ getPreferences: () => prefs, savePreferences: () => { saved = JSON.stringify(prefs); }, canRequest: () => eligible, prompt: async (...args) => { prompts++; return typeof answer === 'function' ? answer(...args) : answer; } });
  manager.install(session, 'browser');
  return { manager, session, wc, get prompts() { return prompts; }, restart() { prefs = JSON.parse(saved); }, set eligible(value) { eligible = value; }, set url(value) { url = value; }, request(permission = 'geolocation', details = { requestingUrl: url }) { return new Promise(resolve => session.request(wc, permission, resolve, details)); } };
}
test('repeated Google location requests are blocked silently by default', async () => {
  const f = fixture();
  assert.equal(await f.request(), false);
  assert.equal(await f.request(), false);
  assert.equal(f.prompts, 0);
});
test('ask-once location denial survives reload and app restart', async () => {
  const f = fixture({locationDefault: 'ask'});
  assert.equal(await f.request(), false); f.restart();
  assert.equal(await f.request(), false); assert.equal(f.prompts, 1);
});
test('general-area mode grants only the explicit approximate permission', async () => {
  const f = fixture({locationDefault:'approximate'});
  assert.equal(await f.request('geolocation-approximate'), true);
  assert.equal(await f.request('geolocation'), false);
  assert.equal(f.session.check(f.wc, 'geolocation-approximate', 'https://www.google.com', {}), true);
  assert.equal(f.session.check(f.wc, 'geolocation', 'https://www.google.com', {}), false);
  assert.equal(f.prompts, 0);
});
test('saved allow applies to exactly one origin and can be revoked in Settings', async () => {
  const f = fixture({locationDefault:'ask'}, true);
  assert.equal(await f.request(), true); f.restart();
  assert.equal(f.session.check(f.wc, 'geolocation', 'https://www.google.com', {}), true);
  assert.equal(f.session.check(f.wc, 'geolocation', 'https://maps.google.com', {}), false);
  f.manager.set({ origin:'https://www.google.com', permission:'geolocation', decision:'block' });
  assert.equal(await f.request(), false); assert.equal(f.prompts, 1);
});
test('background or agent-owned tabs cannot use remembered human permission', async () => {
  const f = fixture();
  f.manager.set({ origin:'https://www.google.com', permission:'geolocation', decision:'allow' });
  f.eligible = false;
  assert.equal(await f.request(), false);
  assert.equal(f.session.check(f.wc, 'geolocation', 'https://www.google.com', {}), false);
});
test('permissions use the requesting iframe origin, not the top-level page', async () => {
  const f = fixture({locationDefault:'ask'}, true);
  assert.equal(await f.request('geolocation', {requestingUrl:'https://maps.example/embed'}), true);
  assert.equal(f.session.check(f.wc, 'geolocation', 'https://maps.example', {}), true);
  assert.equal(f.session.check(f.wc, 'geolocation', 'https://www.google.com', {}), false);
});
test('camera and microphone grants are independent', async () => {
  const f = fixture({}, true);
  assert.equal(await f.request('media', {requestingUrl:'https://www.google.com/', mediaTypes:['audio']}), true);
  assert.equal(f.session.check(f.wc, 'media', 'https://www.google.com', {mediaType:'audio'}), true);
  assert.equal(f.session.check(f.wc, 'media', 'https://www.google.com', {mediaType:'video'}), false);
});
test('takeover or navigation during an unanswered dialog cancels this request', async () => {
  for (const mutate of [f => { f.eligible = false; }, f => { f.url = 'https://example.org/'; }]) {
    let finish; const f = fixture({locationDefault:'ask'}, () => new Promise(resolve => { finish = resolve; }));
    const request = f.request(); await new Promise(resolve => setImmediate(resolve));
    mutate(f); finish(true); assert.equal(await request, false);
  }
});
test('simultaneous same-site requests share one dialog', async () => {
  let finish; const f = fixture({locationDefault:'ask'}, () => new Promise(resolve => { finish = resolve; }));
  const requests = [f.request(), f.request()]; await new Promise(resolve => setImmediate(resolve));
  finish(false); assert.deepEqual(await Promise.all(requests), [false, false]); assert.equal(f.prompts, 1);
});
test('the app microphone is granted only for intelio pages and audio', async () => {
  const root = path.resolve(__dirname, '../src');
  const page = pathToFileURL(path.join(root, 'index.html')).href;
  const session = { setPermissionRequestHandler(fn) { this.request = fn; }, setPermissionCheckHandler(fn) { this.check = fn; } };
  installAppMicrophone(session, (wc) => appMediaPage(wc?.getURL?.(), root));
  const own = { getURL: () => page, isDestroyed: () => false };
  const other = { getURL: () => 'https://example.com/', isDestroyed: () => false };
  const dead = { getURL: () => page, isDestroyed: () => true };
  assert.deepEqual(mediaTypesOf({}), ['audio']);
  assert.deepEqual(mediaTypesOf({ mediaType: 'video' }), ['video']);
  assert.equal(session.check(own, 'media', '', {}), true);
  assert.equal(session.check(own, 'media', '', { mediaTypes: ['audio'] }), true);
  assert.equal(session.check(own, 'media', '', { mediaTypes: ['video'] }), false);
  assert.equal(session.check(own, 'media', '', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(session.check(own, 'geolocation', '', {}), false);
  assert.equal(session.check(other, 'media', '', { mediaTypes: ['audio'] }), false);
  assert.equal(session.check(dead, 'media', '', { mediaTypes: ['audio'] }), false);
  assert.equal(appMediaPage(page, root), true);
  assert.equal(appMediaPage(pathToFileURL('/tmp/not-intelio.html').href, root), false);
  assert.equal(appMediaPage('https://app.intelio-ai.com/desktop/', root), false);
  assert.equal(appMediaPage('file://user:pass@localhost/tmp/a', root), false);
  assert.equal(await new Promise((resolve) => session.request(own, 'media', resolve, { mediaTypes: ['audio'] })), true);
  assert.equal(await new Promise((resolve) => session.request(own, 'media', resolve, { mediaTypes: ['video'] })), false);
  assert.equal(await new Promise((resolve) => session.request(other, 'media', resolve, { mediaTypes: ['audio'] })), false);
});
test('unsupported permissions and opaque/credential-bearing origins are denied', async () => {
  const f = fixture({locationDefault:'ask'}, true);
  for (const origin of ['data:text/html,a', 'file:///tmp/a', 'https://user:pass@example.com', 'null']) assert.equal(await f.request('geolocation', {requestingUrl:origin}), false);
  assert.equal(await f.request('midi'), false); assert.equal(f.prompts, 0);
  assert.equal(f.session.check(null, 'notifications', 'https://www.google.com', {}), false);
});
