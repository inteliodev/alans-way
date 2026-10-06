'use strict';

/** Saved appearance. Anything other than light stays the current dark chrome. */
function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

module.exports = { normalizeTheme };
