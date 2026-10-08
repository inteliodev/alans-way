'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const apps = require('../src/intelio/client-apps.cjs');

test('every client has its suite: Google for intelio and PRC, Microsoft 365 for Alignment, HHP and ARLP', () => {
  const suites = Object.fromEntries(apps.CLIENTS.map((client) => [client.id, client.suite]));
  assert.deepEqual(suites, { intelio: 'google', prc: 'google', alignment: 'microsoft', hhp: 'microsoft', arlp: 'microsoft' });
  for (const client of apps.CLIENTS) {
    const ids = apps.appsFor(client.id).filter((app) => app.primary).map((app) => app.id);
    assert.ok(ids.includes('mail') && ids.includes('calendar'), client.id);
    assert.equal(new Set(apps.appsFor(client.id).map((app) => app.id)).size, apps.appsFor(client.id).length, `${client.id} ids are unique`);
  }
  assert.ok(apps.appsFor('alignment').some((app) => app.id === 'teams'));
  assert.ok(apps.appsFor('prc').some((app) => app.id === 'box'));
});

test('each client gets its own browser partition, and unknown clients are refused', () => {
  const partitions = apps.CLIENTS.map((client) => apps.partitionFor(client.id));
  assert.equal(new Set(partitions).size, apps.CLIENTS.length);
  assert.ok(partitions.every((name) => /^persist:client-[a-z]+$/.test(name)));
  assert.ok(!partitions.includes('persist:browser'));
  assert.throws(() => apps.partitionFor('../evil'));
  assert.throws(() => apps.urlFor('hhp', 'nope'));
});

test('the account hint picks the right login on each suite, and only valid emails are used', () => {
  const google = new URL(apps.urlFor('intelio', 'mail', 'hayden@intelio.co'));
  assert.equal(google.hostname, 'mail.google.com');
  assert.equal(google.searchParams.get('authuser'), 'hayden@intelio.co');
  const microsoft = new URL(apps.urlFor('hhp', 'calendar', 'hayden@hhpasset.com'));
  assert.equal(microsoft.hostname, 'outlook.office.com');
  assert.equal(microsoft.searchParams.get('login_hint'), 'hayden@hhpasset.com');
  assert.equal(new URL(apps.urlFor('arlp', 'mail', 'not an email')).search, '');
  assert.equal(new URL(apps.urlFor('alignment', 'platform', 'me@alignmentpa.com')).search, '', 'client sites open as they are');
  assert.equal(new URL(apps.urlFor('hhp', 'mail')).searchParams.get('login_hint'), 'hayden@hhpasset.com', 'catalog default');
  assert.equal(new URL(apps.urlFor('hhp', 'mail', '')).search, '', 'cleared account means no hint');
});

test('signed in means the client jar holds the suite sign-in cookie', async () => {
  const jar = (cookies) => ({ get: async ({ url }) => cookies[url] || [] });
  assert.equal(await apps.signedIn(jar({ 'https://accounts.google.com': [{ name: 'SID', value: 'x' }] }), 'prc'), true);
  assert.equal(await apps.signedIn(jar({ 'https://accounts.google.com': [{ name: 'NID', value: 'x' }] }), 'prc'), false);
  assert.equal(await apps.signedIn(jar({ 'https://login.microsoftonline.com': [{ name: 'ESTSAUTHPERSISTENT', value: 'x' }] }), 'arlp'), true);
  assert.equal(await apps.signedIn(jar({ 'https://accounts.google.com': [{ name: 'SID', value: 'x' }] }), 'arlp'), false);
  assert.equal(await apps.signedIn({ get: async () => { throw new Error('gone'); } }, 'hhp'), false);
});

test('main process opens client apps from the catalog in that client\'s partition', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  assert.match(source, /case 'open-client-app':[\s\S]{0,400}clientApps\.urlFor\(client\.id, value\.app/);
  assert.match(source, /const partition = clientId \? clientApps\.partitionFor\(clientId\) : 'persist:browser';/);
  assert.match(source, /webPreferences: \{ \.\.\.options\?\.webPreferences, preload: undefined, partition,/);
  assert.match(source, /client: parent\?\.client \|\| ''/, 'popups stay in the client jar');
  assert.match(source, /if \(!clientId\) extensionHost\?\.addTab/);
});
