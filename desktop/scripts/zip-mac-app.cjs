'use strict';
/**
 * Zip the unsigned Apple Silicon intelio.app. zip -y keeps the Electron
 * framework symlinks intact. Run from desktop/ after npm run package:mac.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const version = require('../package.json').version;
const root = path.resolve('dist/intelio-darwin-arm64');
const app = path.join(root, 'intelio.app');
const plist = path.join(app, 'Contents', 'Info.plist');
if (!fs.existsSync(plist)) {
  process.stderr.write(`missing ${app}\n`);
  process.exit(1);
}
// The packaged app throws on start without the intelio-repo resources (see stage-intelio-repo.cjs).
const forks = path.join(app, 'Contents', 'Resources', 'intelio-repo', 'intelio', 'forks.json');
if (!fs.existsSync(forks)) {
  process.stderr.write(`missing ${path.relative(root, forks)}: run npm run package:mac (it stages intelio-repo)\n`);
  process.exit(1);
}
const zip = path.resolve(`dist/Intelio-${version}-mac-arm64.zip`);
fs.rmSync(zip, { force: true });
const result = spawnSync('zip', ['-y', '-r', '-q', zip, 'intelio.app'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const size = fs.statSync(zip).size;
process.stdout.write(`mac zip ${zip} ${size} bytes\n`);
