'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES, THEME_LABELS, BLUE, normalizeTheme, nextTheme, colorScheme, themeBackground, themeVars } = require('../src/intelio/theme.cjs');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rule blocks: [selector, body]. Nested @-rules are not used in these files. */
function rules(css) {
  return stripComments(css).split('}').map((part) => part.trim()).filter((part) => part.includes('{'))
    .map((part) => [part.slice(0, part.indexOf('{')).trim(), part.slice(part.indexOf('{') + 1)]);
}

/** The blue section the phone stylesheet appends at its end. */
function phoneBlue() {
  const css = read('mobile/pwa/public/app.css');
  const at = css.indexOf('/* Blue appearance');
  assert.ok(at > 0, 'app.css has a blue section');
  return css.slice(at);
}

function parseColor(text) {
  const c = text.trim().toLowerCase();
  if (c === 'white') return [255, 255, 255, 1];
  if (c === 'black') return [0, 0, 0, 1];
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  const nums = c.slice(c.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean).map(Number);
  return [nums[0], nums[1], nums[2], nums.length > 3 ? nums[3] : 1];
}
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;

function over([r, g, b, a], [br, bg, bb]) {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}
function luminance([r, g, b]) {
  const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(fg, bg) {
  const back = over(parseColor(bg), [0, 0, 232]);
  const front = over(parseColor(fg), back);
  const [hi, lo] = [luminance(front), luminance(back)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function hueSat([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B); const min = Math.min(R, G, B); const d = max - min;
  if (!d) return [0, 0];
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, d / (1 - Math.abs(max + min - 1))];
}

/** The last declaration of `prop` for an exact selector in the blue rules. */
function declared(css, selector, prop) {
  let found = null;
  for (const [head, body] of rules(css)) {
    if (!head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).includes(selector)) continue;
    for (const decl of body.split(';')) {
      const at = decl.indexOf(':');
      if (at > 0 && decl.slice(0, at).trim() === prop) found = decl.slice(at + 1).replace('!important', '').trim();
    }
  }
  return found;
}

test('blue is a saved theme next to light and dark, and the button cycles light, dark, blue', () => {
  assert.deepEqual(THEMES, ['light', 'dark', 'blue']);
  assert.equal(THEME_LABELS.blue, 'Blue');
  assert.equal(normalizeTheme('blue'), 'blue');
  assert.equal(normalizeTheme('BLUE'), 'blue');
  assert.equal(normalizeTheme('lime'), 'dark');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'blue');
  assert.equal(nextTheme('blue'), 'light');
  assert.equal(nextTheme('junk'), 'blue', 'junk reads as dark');
  assert.equal(colorScheme('blue'), 'dark');
  assert.equal(colorScheme('light'), 'light');
  assert.equal(themeBackground('blue'), '#0000e8');
  assert.equal(themeBackground('dark', '#123'), '#123');
  assert.equal(BLUE.bg, '#0000e8');
  const vars = themeVars('blue');
  assert.equal(vars['--bg'], '#0000e8');
  assert.equal(vars['--text'], '#ffffff');
  assert.equal(themeVars('dark'), null);
});

test('blue rules are scoped to html[data-theme="blue"] so light and dark stay untouched', () => {
  const blocks = rules(read('desktop/src/theme-blue.css'));
  assert.ok(blocks.length > 40);
  for (const [head] of blocks) {
    for (const selector of head.split(',')) assert.match(selector.trim(), /^html\[data-theme="blue"\]/, selector);
  }
  const shared = new Set(['.theme-blue-dot', '.theme-picker', '.theme-choice', '.theme-choice[aria-pressed="true"]']);
  for (const [head] of rules(phoneBlue())) {
    for (const selector of head.split(',').map((s) => s.trim())) {
      if (shared.has(selector)) continue;
      assert.match(selector, /^html\[data-theme="blue"\]/, selector);
    }
  }
});

test('the phone blue section comes after the light media query so it wins', () => {
  const css = read('mobile/pwa/public/app.css');
  assert.ok(css.lastIndexOf('prefers-color-scheme: light') < css.indexOf('/* Blue appearance'));
  const vars = phoneBlue();
  assert.match(vars, /--bg: #0000e8;/);
  assert.match(vars, /--text: #ffffff;/);
  assert.match(vars, /--line: rgba\(255, 255, 255, 0\.24\);/);
});

test('blue never uses yellow or lime', () => {
  const sources = [read('desktop/src/theme-blue.css'), phoneBlue()];
  for (const css of sources) {
    for (const match of stripComments(css).match(COLOR) || []) {
      const [r, g, b, a] = parseColor(match);
      const [hue, sat] = hueSat([r, g, b]);
      const yellowish = a > 0.05 && sat > 0.25 && hue >= 45 && hue < 100;
      assert.equal(yellowish, false, `${match} is yellow or lime`);
    }
    assert.doesNotMatch(stripComments(css), /\b(yellow|lime|gold|chartreuse|greenyellow)\b/i);
  }
});

test('text stays readable on blue: bubbles, typing bubble, sidebar, inputs and code', () => {
  const css = read('desktop/src/theme-blue.css');
  const pairs = [
    ['.msg.user', declared(css, 'html[data-theme="blue"] .msg.user', 'color'), declared(css, 'html[data-theme="blue"] .msg.user', 'background')],
    ['.msg.assistant', declared(css, 'html[data-theme="blue"] .msg.assistant', 'color'), declared(css, 'html[data-theme="blue"] .msg.assistant', 'background')],
    ['typing bubble', declared(css, 'html[data-theme="blue"] .msg.assistant.typing-bubble', 'color'), declared(css, 'html[data-theme="blue"] .msg.assistant.typing-bubble', 'background')],
    ['code', declared(css, 'html[data-theme="blue"] pre', 'color'), declared(css, 'html[data-theme="blue"] pre', 'background')],
    ['sidebar', '#ffffff', declared(css, 'html[data-theme="blue"] .sidebar', 'background')],
    ['sidebar caption', declared(css, 'html[data-theme="blue"] .side-caption', 'color'), declared(css, 'html[data-theme="blue"] .sidebar', 'background')],
    ['active thread', '#ffffff', 'rgb(51, 51, 237)'],
    ['lead card', declared(css, 'html[data-theme="blue"] .lead-card', 'color'), declared(css, 'html[data-theme="blue"] .lead-card', 'background')],
    ['composer', '#ffffff', declared(css, 'html[data-theme="blue"] .remote-composer input', 'background')],
    ['send', declared(css, 'html[data-theme="blue"] body.remote-main #remote-send', 'color'), declared(css, 'html[data-theme="blue"] body.remote-main #remote-send', 'background')],
    ['modal', declared(css, 'html[data-theme="blue"] .modal-card', 'color'), declared(css, 'html[data-theme="blue"] .modal-card', 'background')],
  ];
  const phone = phoneBlue();
  pairs.push(
    ['phone user bubble', declared(phone, 'html[data-theme="blue"] .bubble.user', 'color'), declared(phone, 'html[data-theme="blue"] .bubble.user', 'background')],
    ['phone bot bubble', declared(phone, 'html[data-theme="blue"] .bubble.bot', 'color'), declared(phone, 'html[data-theme="blue"] .bubble.bot', 'background')],
    ['phone typing', declared(phone, 'html[data-theme="blue"] .bubble.bot.typing', 'color'), declared(phone, 'html[data-theme="blue"] .bubble.bot', 'background')],
    ['phone code', declared(phone, 'html[data-theme="blue"] pre', 'color'), declared(phone, 'html[data-theme="blue"] pre', 'background')],
    ['phone muted', 'rgba(255, 255, 255, 0.74)', '#0000e8'],
    ['phone card muted', 'rgba(255, 255, 255, 0.74)', '#1414ee'],
    ['phone send', declared(phone, 'html[data-theme="blue"] .composer .send', 'color'), '#ffffff'],
  );
  for (const [name, fg, bg] of pairs) {
    assert.ok(fg && bg, `${name} has colours`);
    const ratio = contrast(fg, bg.match(COLOR)?.[0] || bg);
    assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test('blue is offered by the bottom-left button and the Settings picker on desktop and phone', () => {
  const html = read('desktop/src/index.html');
  assert.match(html, /<svg class="theme-blue hidden"/);
  assert.ok(html.indexOf('theme-light.css') < html.indexOf('theme-blue.css'), 'blue loads after light');
  assert.match(read('desktop/src/remote.html'), /theme-blue\.css/);
  const renderer = read('desktop/src/renderer.js');
  assert.match(renderer, /const THEME_ORDER = \['light', 'dark', 'blue'\];/);
  assert.match(renderer, /data-theme-choice|dataset\.themeChoice/);
  assert.match(renderer, /chooseTheme\(followingTheme\(/);
  assert.match(read('desktop/src/preload.cjs'), /theme === 'blue'/);
  assert.match(read('desktop/src/main.cjs'), /themeBackground/);
  const app = read('mobile/pwa/public/app.js');
  assert.match(app, /const THEME_ORDER = \['light', 'dark', 'blue'\];/);
  assert.match(app, /function themePicker\(/);
  assert.match(app, /theme-blue-dot/);
  assert.match(read('mobile/pwa/public/index.html'), /saved === 'blue'/);
  assert.match(read('mobile/pwa/public/desktop-boot.js'), /saved === 'blue'/);
  assert.match(read('mobile/pwa/public/desktop-transport.js'), /value\.theme === 'blue'/);
});

test('the Watching section is gone from the agents sidebar on desktop and phone', () => {
  const html = read('desktop/src/index.html');
  assert.doesNotMatch(html, /sidebar-watching/);
  assert.doesNotMatch(html, />\s*Watching\s*</);
  const remote = read('desktop/src/remote-main.js');
  assert.doesNotMatch(remote, /paintWatching|sidebar-watching|watch-row/);
  assert.doesNotMatch(read('desktop/src/remote-main.css'), /sidebar-watching|watching-caption|\.watch-row/);
  const app = read('mobile/pwa/public/app.js');
  assert.doesNotMatch(app, /watchingBlock|'WATCHING'|'Watching'/);
  // Screens are still loaded for the top-right screen grid.
  assert.match(remote, /loadScreens/);
});
