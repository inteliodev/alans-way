const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src');

function resolveRequire(fromFile, spec) {
  let target = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    if (fs.existsSync(path.join(target, 'index.cjs'))) return path.join(target, 'index.cjs');
    if (fs.existsSync(path.join(target, 'index.js'))) return path.join(target, 'index.js');
  }
  if (!path.extname(target)) {
    if (fs.existsSync(`${target}.cjs`)) return `${target}.cjs`;
    if (fs.existsSync(`${target}.js`)) return `${target}.js`;
    if (fs.existsSync(`${target}.json`)) return `${target}.json`;
  }
  return target;
}

function walk(file, seen, outside) {
  const abs = path.resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);
  const text = fs.readFileSync(abs, 'utf8');
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(text))) {
    const target = resolveRequire(abs, match[1]);
    const rel = path.relative(src, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) outside.push(`${path.relative(src, abs)} → ${match[1]}`);
    else if (fs.existsSync(target) && fs.statSync(target).isFile() && !target.endsWith('.json')) walk(target, seen, outside);
  }
}

test('every relative require from the main process stays inside desktop/src', () => {
  const outside = [];
  walk(path.join(src, 'main.cjs'), new Set(), outside);
  assert.deepEqual(outside, []);
});
