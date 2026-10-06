const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '../..');
const forks = JSON.parse(fs.readFileSync(path.join(repo, 'intelio/forks.json'), 'utf8'));
const skip = new Set(['node_modules', '.git', 'dist']);

function files(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files(full, out);
    else if (stat.isFile() && stat.size < 1_000_000) out.push(full);
  }
  return out;
}

test('functional capthvnsen references point at the Intelio forks', () => {
  assert.equal(forks.app, 'https://github.com/inteliodev/alans-way');
  assert.equal(forks.agents, 'https://github.com/inteliodev/alans-way-agents');
  const credit = [];
  for (const file of files(repo)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const rel = path.relative(repo, file);
    const isTest = rel.startsWith('desktop/test/') || rel.startsWith('tests/');
    if (!isTest) text.split(/\r?\n/).forEach((line, index) => {
      if (!line.includes('capthvnsen')) return;
      credit.push(`${rel}:${index + 1}:${line.trim()}`);
    });
    const urls = text.match(/https:\/\/github.com\/inteliodev\/alans-way(?:-agents)?[A-Za-z0-9._~:/?#\[\]@!$&*+,;=%-]*/g) || [];
    for (const url of urls) {
      const ok = url === forks.app || url.startsWith(`${forks.app}/`) || url === forks.agents || url.startsWith(`${forks.agents}/`);
      assert.equal(ok, true, `${rel} has an unexpected fork URL ${url}`);
    }
  }
  assert.equal(credit.length, 1);
  assert.match(credit[0], /^INTELIO\.md:/);
  assert.match(credit[0], /Alex Hansen/);
  assert.match(credit[0], /github.com\/capthvnsen\/alans-way/);
  const installer = fs.readFileSync(path.join(repo, 'scripts/install-mac.sh'), 'utf8');
  assert.match(installer, new RegExp(forks.app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const pyproject = fs.readFileSync(path.join(repo, 'pyproject.toml'), 'utf8');
  assert.match(pyproject, new RegExp(`Homepage = "${forks.app}"`));
  assert.match(pyproject, new RegExp(`Issues = "${forks.app}/issues"`));
});
