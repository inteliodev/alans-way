'use strict';
/** Repo root for source checkouts and for the Windows package (extraResources). */

const fs = require('node:fs');
const path = require('node:path');

function sourceRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolveRepoRoot() {
  const source = sourceRoot();
  try {
    const electron = require('electron');
    if (electron && typeof electron !== 'string' && electron.app?.isPackaged && process.resourcesPath) {
      const packed = path.join(process.resourcesPath, 'intelio-repo');
      if (fs.existsSync(path.join(packed, 'intelio', 'forks.json'))) return packed;
    }
  } catch { /* node --test has no Electron app object */ }
  return source;
}

module.exports = { sourceRoot, resolveRepoRoot };
