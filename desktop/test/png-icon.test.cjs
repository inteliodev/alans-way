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
  assert.equal(decoded.pixels[3], 0);
  let dark = 0;
  let light = 0;
  for (let i = 0; i < decoded.pixels.length; i += 4) {
    if (decoded.pixels[i + 3] < 200) continue;
    const r = decoded.pixels[i];
    const g = decoded.pixels[i + 1];
    const b = decoded.pixels[i + 2];
    if (r < 40 && g < 40 && b < 40) dark += 1;
    if (r > 220 && g > 220 && b > 220) light += 1;
  }
  assert.ok(dark > 10000, 'the mark is the black rounded icon');
  assert.ok(light > 400, 'the mark keeps the two light eyes');
  const icon = decodePng(scalePng(png, 192, 192));
  assert.equal(icon.width, 192);
  assert.equal(icon.pixels.length, 192 * 192 * 4);
  const root = path.resolve(__dirname, '..', '..');
  assert.equal(sourceRoot(), root);
});
