'use strict';

/** Saved appearance. Anything other than light stays the current dark chrome. */
function normalizeTheme(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'light' ? 'light' : 'dark';
}

/** Inline variables so a dark brand token cannot paint over a saved light theme. */
function themeVars(theme) {
  if (normalizeTheme(theme) !== 'light') return null;
  return {
    '--bg': '#f6f6f8',
    '--text': '#1c1c21',
    '--muted': '#5e5e68',
    '--line': '#d5d5dc',
    '--panel': '#ffffff',
    '--intelio-surface': '#ffffff',
  };
}

module.exports = { normalizeTheme, themeVars };
