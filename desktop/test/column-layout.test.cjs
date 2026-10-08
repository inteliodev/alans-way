const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A Windows checkout with core.autocrlf=true has CRLF line endings; the
// multi-line patterns below are written with \n.
function source(name) {
  return fs.readFileSync(path.join(__dirname, '../src', name), 'utf8').replace(/\r\n/g, '\n');
}

test('each column stays inside the viewport and the details tab names the agent on screen', () => {
  const css = source('remote-main.css');
  const card = source('agent-card.css');
  const renderer = source('renderer.js');
  const remote = source('remote-main.js');
  assert.match(css, /html, body \{ height: 100dvh; max-height: 100dvh; overflow: hidden; \}/);
  assert.match(css, /#shell \{ height: 100dvh; max-height: 100dvh; min-height: 0; overflow: hidden; grid-template-rows: minmax\(0, 1fr\); \}/);
  assert.match(css, /#shell > \.sidebar,\n#shell > \.chat-pane,\n#shell > \.workspace-pane \{ min-height: 0; max-height: 100%; overflow: hidden; \}/);
  assert.match(css, /#shell > \.sidebar \{ overflow-x: hidden; overflow-y: auto; \}/);
  assert.match(css, /\.remote-messages \{ flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto;/);
  assert.match(css, /\.remote-composer \{ display: flex; flex-shrink: 0;/);
  assert.match(card, /\.workspace-pane\.agent-open \.agent-card \{ display: block; flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; \}/);
  assert.match(renderer, /const shown = agentPane \? \(paneAgentName\(agentUi\.id\) \|\| chatName\) : chatName/);
  assert.match(renderer, /pinTab\(shown, agentPane/);
  assert.match(remote, /pane\.scrollTop = pane\.scrollHeight/);
  assert.equal(css.includes('#ffff00'), false);
  assert.equal(card.includes('#ffff00'), false);
});
