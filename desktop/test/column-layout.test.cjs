const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('each column stays inside the viewport and the details tab names the agent on screen', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/remote-main.css'), 'utf8');
  const card = fs.readFileSync(path.join(__dirname, '../src/agent-card.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const remote = fs.readFileSync(path.join(__dirname, '../src/remote-main.js'), 'utf8');
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
