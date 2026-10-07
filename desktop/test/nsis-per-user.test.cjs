const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the Windows installer is per-user and lands in LocalAppData Programs', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.build.nsis.oneClick, true);
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.allowElevation, false);
  assert.equal(pkg.productName, 'intelio');
  const root = path.join(__dirname, '../node_modules/app-builder-lib/templates/nsis');
  const installer = fs.readFileSync(path.join(root, 'installer.nsi'), 'utf8');
  const multi = fs.readFileSync(path.join(root, 'multiUser.nsh'), 'utf8');
  assert.match(installer, /!else\s+RequestExecutionLevel user/);
  assert.match(multi, /\$LocalAppData\\Programs/);
  assert.match(multi, /\$INSTDIR "\$0\\\$\{APP_FILENAME\}"/);
});
