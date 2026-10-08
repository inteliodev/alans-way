const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stageIntelioRepo, entries } = require('../scripts/stage-intelio-repo.cjs');

const desktop = path.resolve(__dirname, '..');
const pkg = require('../package.json');

test('the Mac build stages the same intelio-repo resources as the Windows build', () => {
  const windows = pkg.build.extraResources.filter((item) => String(item.to).startsWith('intelio-repo/'));
  assert.ok(windows.length >= 3);
  assert.deepEqual(entries().map((item) => item.to), windows.map((item) => item.to));
  const dir = stageIntelioRepo();
  for (const item of windows) {
    assert.ok(fs.existsSync(path.join(path.dirname(dir), item.to)), `${item.to} staged`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'intelio', 'forks.json')));
  const walk = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? [entry.name, ...walk(path.join(folder, entry.name))] : [entry.name]));
  assert.equal(walk(dir).includes('__pycache__'), false);
});

test('package:mac passes the staged folder and the zip step refuses an app without it', () => {
  assert.match(pkg.scripts['prepackage:mac'], /node scripts\/stage-intelio-repo\.cjs/);
  assert.match(pkg.scripts['package:mac'], /--extra-resource=dist\/mac-resources\/intelio-repo(\s|$)/);
  assert.match(pkg.scripts['package:mac'], /--ignore='\^\/\(test\|dist\|screenshots\)/);
  const zip = fs.readFileSync(path.join(desktop, 'scripts/zip-mac-app.cjs'), 'utf8');
  assert.match(zip, /'intelio-repo', 'intelio', 'forks\.json'/);
});

test('the installer workflow checks the zip and starts the app on macOS before attaching it', () => {
  const flow = fs.readFileSync(path.join(desktop, '../.github/workflows/windows-installer.yml'), 'utf8');
  assert.match(flow, /grep -q 'intelio\.app\/Contents\/Resources\/intelio-repo\/intelio\/forks\.json'/);
  const smoke = flow.slice(flow.indexOf('  mac-smoke:'));
  assert.ok(flow.includes('  mac-smoke:'));
  assert.match(smoke, /runs-on: macos-latest/);
  assert.match(smoke, /--smoke-test/);
  assert.ok(smoke.indexOf('--smoke-test') < smoke.indexOf('Attach the macOS zip to the private draft'));
});
