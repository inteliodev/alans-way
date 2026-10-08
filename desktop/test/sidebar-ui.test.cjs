'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src');
const read = (name) => fs.readFileSync(path.join(src, name), 'utf8').replace(/\r\n/g, '\n');

test('hiding the agent list drops its column in the remote window instead of squeezing the chat', () => {
  const css = read('remote-main.css');
  // body.remote-main #shell out-ranks style.css's #shell.bots-hidden, so the remote window
  // needs its own bots-hidden grids, with and without the browser pane.
  assert.match(css, /body\.remote-main #shell\.bots-hidden \{ grid-template-columns: var\(--chat-width\) 5px minmax\(280px, 1fr\); \}/);
  assert.match(css, /body\.remote-main #shell\.bots-hidden\.browser-hidden \{ grid-template-columns: minmax\(0, 1fr\) 0 0 !important; \}/);
  // They must come after the rules they override.
  assert.ok(css.indexOf('body.remote-main #shell.bots-hidden {') > css.indexOf('body.remote-main #shell.browser-hidden {'));
});

test('the sidebar switch shows SESSIONS on the left and AGENTS on the right', () => {
  const html = read('index.html');
  const sessions = html.indexOf('id="tab-sessions"');
  const agents = html.indexOf('id="tab-agents"');
  assert.ok(sessions > 0 && agents > 0);
  assert.ok(sessions < agents, 'SESSIONS comes first');
});

test('the lead agent card orb has a fixed on-screen size', () => {
  const css = read('remote-main.css');
  assert.match(css, /\.lead-orb canvas\.orb \{[^}]*width: 56px; height: 56px;/);
  assert.match(read('remote-main.js'), /mountOrb\(canvas, lead\.id, lead\.orb, 56, true, lead\.color\)/);
});
