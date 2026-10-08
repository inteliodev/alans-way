'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES, nextTheme } = require('../src/intelio/theme.cjs');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Last declaration of `prop` in a rule whose selector list contains `selector` exactly. */
function lastDecl(css, selector, prop) {
  let found = null;
  for (const part of strip(css).split('}')) {
    const at = part.indexOf('{');
    if (at < 0) continue;
    const heads = part.slice(0, at).split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!heads.includes(selector)) continue;
    for (const decl of part.slice(at + 1).split(';')) {
      const colon = decl.indexOf(':');
      if (colon > 0 && decl.slice(0, colon).trim() === prop) found = decl.slice(colon + 1).trim();
    }
  }
  return found;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const ch = (i) => { const s = parseInt(h.slice(i, i + 2), 16) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

test('themes are offered Light, Blue, Dark and the button cycles in that order', () => {
  assert.deepEqual(THEMES, ['light', 'blue', 'dark']);
  assert.deepEqual(['light', 'blue', 'dark'].map(nextTheme), ['blue', 'dark', 'light']);
  for (const file of ['desktop/src/renderer.js', 'mobile/pwa/public/app.js']) {
    assert.match(read(file), /const THEME_ORDER = \['light', 'blue', 'dark'\];/, file);
  }
});

test('the selected sidebar thread is a dark row in dark mode and a light row in light mode', () => {
  const dark = lastDecl(read('desktop/src/remote-main.css'), '.thread-line.active', 'background');
  assert.match(dark, /^#[0-9a-f]{6}$/i);
  assert.ok(luminance(dark) < 0.05, `dark selected row ${dark} must stay dark`);
  const light = lastDecl(read('desktop/src/theme-light.css'), 'html[data-theme="light"] .thread-line.active', 'background');
  assert.ok(light && luminance(light) > 0.7, 'light selected row stays light');
  assert.ok(lastDecl(read('desktop/src/theme-blue.css'), 'html[data-theme="blue"] .thread-line.active', 'background'));
});

test('the Sessions agent dropdown has Blue styling on desktop and phone', () => {
  const desk = read('desktop/src/theme-blue.css');
  assert.match(lastDecl(desk, 'html[data-theme="blue"] .session-tools .session-agent-select', 'background'), /^#0000c4 url\(/);
  assert.equal(lastDecl(desk, 'html[data-theme="blue"] .session-tools .session-agent-select', 'color'), '#ffffff');
  assert.equal(lastDecl(desk, 'html[data-theme="blue"] .session-tools .session-agent-select option', 'background'), '#0000e8');
  const phone = read('mobile/pwa/public/app.css');
  assert.match(lastDecl(phone, 'html[data-theme="blue"] .session-filter-select', 'background'), /^#0000c4 url\(/);
  assert.equal(lastDecl(phone, 'html[data-theme="blue"] .session-filter-select', 'color'), '#ffffff');
});
