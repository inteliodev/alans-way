const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readBrandPng, decodePng, scalePng } = require('../src/intelio/png-icon.cjs');
const { sourceRoot } = require('../src/intelio/paths.cjs');

test('the brand icon scales to the phone and installer sizes', () => {
  const png = readBrandPng(sourceRoot());
  const decoded = decodePng(png);
  assert.equal(decoded.width, 180);
  assert.equal(decoded.height, 180);
  const icon = decodePng(scalePng(png, 192, 192));
  assert.equal(icon.width, 192);
  assert.equal(icon.pixels.length, 192 * 192 * 4);
  const root = path.resolve(__dirname, '..', '..');
  assert.equal(sourceRoot(), root);
});
