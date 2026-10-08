const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeTheme } = require('../src/intelio/theme.cjs');
const { loadPreferences } = require('../src/intelio/preferences.cjs');

test('theme normalizes to dark unless the saved value is light or blue', () => {
  assert.equal(normalizeTheme(undefined), 'dark');
  assert.equal(normalizeTheme(''), 'dark');
  assert.equal(normalizeTheme('blue'), 'blue');
  assert.equal(normalizeTheme(' Blue '), 'blue');
  assert.equal(normalizeTheme('navy'), 'dark');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('light'), 'light');
});

test('preferences keep a saved light or blue theme and drop junk', () => {
  assert.equal(loadPreferences({ text: null, platform: 'win32' }).prefs.theme, 'dark');
  assert.equal(loadPreferences({ text: JSON.stringify({ theme: 'light' }), platform: 'win32' }).prefs.theme, 'light');
  assert.equal(loadPreferences({ text: JSON.stringify({ theme: 'blue' }), platform: 'linux' }).prefs.theme, 'blue');
  assert.equal(loadPreferences({ text: JSON.stringify({ theme: 'sepia' }), platform: 'darwin' }).prefs.theme, 'dark');
});

test('light rules cannot restyle dark mode', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/theme-light.css'), 'utf8');
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((part) => part.trim()).filter(Boolean);
  assert.ok(blocks.length > 5);
  for (const block of blocks) {
    const head = block.slice(0, block.indexOf('{')).trim();
    assert.match(head, /^html\[data-theme="light"\]/);
  }
});
