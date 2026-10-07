const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const picker = require('../src/intelio/model-picker.cjs');

const CONFIG = [
  'model:',
  "  provider: 'openai-codex'",
  "  default: 'codex-live-a'",
  "  base_url: 'https://chatgpt.com/backend-api/codex'",
  'platform_toolsets:',
  '  cli:',
  '    - intelio',
  'other:',
  '  default: keep-me',
  '',
].join('\n');

test('the menu keeps signed-in ChatGPT and Claude subscription models and drops key providers', () => {
  const groups = picker.modelsFromHermes({
    providers: [
      { slug: 'openai-codex', authenticated: true, auth_type: 'oauth', models: ['codex-live-a', { id: 'codex-live-b' }, 'hermes-agent'] },
      { slug: 'anthropic', authenticated: true, auth_type: 'oauth', models: ['claude-live-a'] },
      { slug: 'anthropic', authenticated: true, auth_type: 'api_key', models: ['claude-key-only'], key_env: 'ANTHROPIC_API_KEY', warning: 'paste ANTHROPIC_API_KEY' },
      { slug: 'openai', authenticated: true, auth_type: 'api_key', models: ['gpt-key-only'] },
      { slug: 'openrouter', authenticated: false, auth_type: 'api_key', models: ['router-model'], source: 'canonical' },
    ],
  });
  assert.deepEqual(groups.map((group) => group.provider), ['openai-codex', 'anthropic']);
  assert.deepEqual(groups[0].models, ['codex-live-a', 'codex-live-b']);
  assert.deepEqual(groups[1].models, ['claude-live-a']);
  const planned = picker.planGroups([groups[0]]);
  assert.equal(planned[0].label, 'ChatGPT plan');
  assert.equal(planned[1].label, 'Claude plan');
  assert.equal(planned[1].signIn, true);
  assert.deepEqual(planned[1].models, []);
  assert.equal(picker.planGroups(groups)[1].signIn, false);
  const link = 'https://claude.ai/oauth/authorize?code=true&code_challenge=abc&state=xyz';
  assert.equal(picker.authorizeUrl(`open\n  ${link}\n`), link);
  assert.equal(picker.authorizeUrl('https://evil.example/oauth/authorize?code_challenge=abc'), '');
  assert.equal(picker.claudePaste('sk-ant-api03-secret'), false);
  assert.equal(picker.claudePaste('paste-code-1#state'), true);
  assert.equal(JSON.stringify(groups).includes('ANTHROPIC_API_KEY'), false);
  assert.equal(JSON.stringify(groups).includes('gpt-key-only'), false);
  assert.equal(JSON.stringify(groups).includes('hermes-agent'), false);
});

test('saving a default rewrites only the model provider and default', () => {
  const next = picker.applyModelDefault(CONFIG, 'claude-live-a', 'anthropic');
  assert.match(next, /provider: 'anthropic'/);
  assert.match(next, /default: 'claude-live-a'/);
  assert.match(next, /base_url: 'https:\/\/chatgpt.com\/backend-api\/codex'/);
  assert.match(next, /default: keep-me/);
  assert.equal(picker.applyModelDefault(CONFIG, 'bad\nprovider: nope', 'openai-codex'), null);
  assert.equal(picker.applyModelDefault('no model here\n', 'codex-live-a', 'openai-codex'), null);
});

test('a session switch sends the provider and the thinking effort', () => {
  const body = picker.sessionSwitchBody('anthropic', 'claude-live-a', 'high');
  assert.equal(body.provider, 'anthropic');
  assert.equal(body.model, 'claude-live-a');
  assert.equal(body.model_options.reasoning_effort, 'high');
  assert.deepEqual(body.model_options.reasoning, { enabled: true, effort: 'high' });
  assert.equal(picker.sessionSwitchBody('openai-codex', 'codex-live-a', 'auto').model_options, undefined);
});

test('the composer pill sits left of the mic and does not ship a model list', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  const phone = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/app.js'), 'utf8');
  const menu = fs.readFileSync(path.join(__dirname, '../src/intelio/model-picker.cjs'), 'utf8');
  assert.ok(html.indexOf('id="remote-model"') < html.indexOf('id="remote-mic"'));
  assert.match(phone, /form\.append\(plus, input, pill, mic, voice, send\)/);
  assert.match(html, /id="model-pill-label">Model</);
  const desktop = fs.readFileSync(path.join(__dirname, '../src/remote-main.js'), 'utf8');
  assert.match(desktop, /Sign in to Claude/);
  assert.match(desktop, /Use for all agents/);
  assert.match(phone, /Sign in to Claude/);
  assert.match(phone, /Use for all agents/);
  for (const file of [html, phone, menu]) assert.equal(file.includes('gpt-6-sol'), false);
});
