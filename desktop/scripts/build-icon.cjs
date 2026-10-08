'use strict';
/** Write the Windows installer icon from the harness brand PNG. */
const fs = require('node:fs');
const path = require('node:path');
const { sourceRoot } = require('../src/intelio/paths.cjs');
const { readBrandPng, scalePng, pngToIco } = require('../src/intelio/png-icon.cjs');

const png = scalePng(readBrandPng(sourceRoot()), 256, 256);
const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), pngToIco(png));
process.stdout.write(`wrote ${dir}/icon.ico\n`);
