'use strict';
/**
 * Stage the intelio-repo resources for the Mac build. The Windows build gets
 * them from electron-builder's build.extraResources; electron-packager (the
 * Mac zip) does not read that list, so this copies the same entries into
 * dist/mac-resources/intelio-repo and package:mac passes that folder with
 * --extra-resource. Without them the packaged app throws on start because
 * src/intelio/forks.cjs cannot find intelio/forks.json.
 * Run from desktop/.
 */
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const stage = path.join(desktop, 'dist', 'mac-resources');
const PREFIX = 'intelio-repo/';

function entries() {
  const pkg = require(path.join(desktop, 'package.json'));
  return (pkg.build?.extraResources || []).filter((item) => typeof item?.to === 'string' && item.to.startsWith(PREFIX));
}

function skip(rel, item) {
  // Mirrors the "!**/__pycache__/**" filter in build.extraResources.
  const excludes = (item.filter || []).filter((rule) => rule.startsWith('!'));
  if (excludes.some((rule) => rule.includes('__pycache__'))) return rel.split(path.sep).includes('__pycache__');
  return false;
}

function copy(from, to, item, base = from) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name), item, base);
    return;
  }
  if (skip(path.relative(base, from), item)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function stageIntelioRepo() {
  const list = entries();
  if (!list.length) throw new Error('package.json build.extraResources has no intelio-repo/ entries');
  fs.rmSync(stage, { recursive: true, force: true });
  for (const item of list) {
    const from = path.resolve(desktop, item.from);
    if (!fs.existsSync(from)) throw new Error(`missing ${item.from}`);
    copy(from, path.join(stage, item.to), item);
  }
  const forks = path.join(stage, 'intelio-repo', 'intelio', 'forks.json');
  if (!fs.existsSync(forks)) throw new Error(`staging did not produce ${path.relative(desktop, forks)}`);
  return path.join(stage, 'intelio-repo');
}

if (require.main === module) {
  try {
    const dir = stageIntelioRepo();
    process.stdout.write(`staged ${path.relative(desktop, dir)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { stageIntelioRepo, entries };
