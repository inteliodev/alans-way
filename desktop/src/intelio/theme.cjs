'use strict';

/**
 * Saved appearance: dark (default), light, or blue. Blue is an electric-blue
 * dark scheme (white text on #0000E8). Anything else stays the dark chrome.
 * UI layer only; Hermes never reads this.
 */
const THEMES = ['light', 'dark', 'blue'];
const THEME_LABELS = { light: 'Light', dark: 'Dark', blue: 'Blue' };

/** Blue palette. No yellow or lime anywhere. */
const BLUE = {
  bg: '#0000e8',
  deep: '#0000c4',
  surface: '#1414ee',
  raised: '#2a2af2',
  input: '#0000cc',
  text: '#ffffff',
  muted: 'rgba(255, 255, 255, 0.74)',
  line: 'rgba(255, 255, 255, 0.24)',
  accent: '#cfdcff',
};

function normalizeTheme(value) {
  const name = String(value == null ? '' : value).trim().toLowerCase();
  return name === 'light' || name === 'blue' ? name : 'dark';
}

/** The order the bottom-left theme button walks through. */
function nextTheme(value) {
  const order = ['light', 'dark', 'blue'];
  return order[(order.indexOf(normalizeTheme(value)) + 1) % order.length];
}

/** Native widgets (scrollbars, form controls) follow light or dark. */
function colorScheme(value) {
  return normalizeTheme(value) === 'light' ? 'light' : 'dark';
}

/** Window background before the page paints. */
function themeBackground(value, darkFallback = '#0a0a0a') {
  const theme = normalizeTheme(value);
  if (theme === 'light') return '#f6f6f8';
  if (theme === 'blue') return BLUE.bg;
  return darkFallback;
}

/** Inline variables so a dark brand token cannot paint over a saved light or blue theme. */
function themeVars(theme) {
  const name = normalizeTheme(theme);
  if (name === 'light') {
    return {
      '--bg': '#f6f6f8',
      '--text': '#1c1c21',
      '--muted': '#5e5e68',
      '--line': '#d5d5dc',
      '--panel': '#ffffff',
      '--intelio-surface': '#ffffff',
    };
  }
  if (name === 'blue') {
    return {
      '--bg': BLUE.bg,
      '--text': BLUE.text,
      '--muted': BLUE.muted,
      '--line': BLUE.line,
      '--panel': BLUE.surface,
      '--intelio-surface': BLUE.surface,
    };
  }
  return null;
}

module.exports = { THEMES, THEME_LABELS, BLUE, normalizeTheme, nextTheme, colorScheme, themeBackground, themeVars };
