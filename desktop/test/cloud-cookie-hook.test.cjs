const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachCloudSessionCookies, cloudCookieFilter } = require('../src/intelio/remote-hermes-main.cjs');

function fakeSession() {
  const reads = [];
  const ses = {
    webRequest: {
      onBeforeSendHeaders(filter, handler) { ses.filter = filter; ses.handler = handler; },
    },
    cookies: {
      async get(query) { reads.push(query.url); return [{ name: 'CF_Authorization', value: 'jwt' }]; },
    },
  };
  return { ses, reads };
}

function send(ses, url) {
  return new Promise((resolve) => ses.handler({ url, requestHeaders: { Accept: '*/*' } }, ({ requestHeaders }) => resolve(requestHeaders)));
}

test('the cloud cookie hook only reads cookies for the intelio cloud origin', async () => {
  const { ses, reads } = fakeSession();
  attachCloudSessionCookies(ses, 'https://app.intelio-ai.com');
  assert.deepEqual(ses.filter.urls, ['https://app.intelio-ai.com/*', 'wss://app.intelio-ai.com/*']);
  const cloud = await send(ses, 'https://app.intelio-ai.com/api/agents');
  assert.match(cloud.Cookie, /CF_Authorization=jwt/);
  const socket = await send(ses, 'wss://app.intelio-ai.com/browser/websockify');
  assert.match(socket.Cookie, /CF_Authorization=jwt/);
  // A request that slips through the pattern (another port) is passed on untouched.
  const other = await send(ses, 'https://app.intelio-ai.com:8443/x');
  assert.equal(other.Cookie, undefined);
  assert.deepEqual(reads, ['https://app.intelio-ai.com', 'https://app.intelio-ai.com']);
  // Attaching twice does not stack a second hook.
  const first = ses.handler;
  attachCloudSessionCookies(ses, 'https://app.intelio-ai.com');
  assert.equal(ses.handler, first);
});

test('the e2e loopback cloud origin keeps its port in the origin check', () => {
  const filter = cloudCookieFilter('http://127.0.0.1:4555');
  assert.equal(filter.origin, 'http://127.0.0.1:4555');
  assert.deepEqual(filter.urls, ['http://127.0.0.1/*', 'ws://127.0.0.1/*']);
  assert.equal(cloudCookieFilter('not a url'), null);
});
