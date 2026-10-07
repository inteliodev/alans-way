const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('claude sign-in does not write auth.json', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/intelio/claude-signin.cjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.equal(src.includes('auth.json'), false);
  assert.equal(src.includes('.anthropic_oauth'), false);
  assert.equal(src.includes('writeFile'), false);
  assert.match(src, /auth', 'add', 'anthropic', '--type', 'oauth'/);
});
