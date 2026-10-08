'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { slugsFromList, listProfiles } = require('../../mobile/pwa/profiles.cjs');

// The real `hermes profile list` layout (hermes_cli/profile_cmd.py _profile_list).
const LIST = [
  '',
  ' Profile          Model                        Gateway      Alias        Distribution',
  ' ───────────────    ───────────────────────────    ───────────    ───────────    ────────────────────',
  ' ◆default         gpt-6-sol                    running      —            —',
  '  intelio         gpt-6-sol                    running      intelio      —',
  '  prc             gpt-6-sol                    running      prc          —',
  '  alignment       gpt-6-sol                    running      alignment    —',
  '  hhp             gpt-6-sol                    stopped      hhp          —',
  '',
].join('\n');

test('the hermes profile list header is not an agent called "profile"', () => {
  assert.deepEqual(slugsFromList(LIST), ['intelio', 'prc', 'alignment', 'hhp']);
  assert.ok(!slugsFromList(LIST).includes('profile'));
});

test('the active marker and an empty list do not add or hide agents', () => {
  assert.deepEqual(slugsFromList(' Profile   Model   Gateway\n ◆prc   gpt   running\n  hhp   gpt   running\n'), ['prc', 'hhp']);
  assert.deepEqual(slugsFromList('No profiles found.\n'), []);
  assert.deepEqual(slugsFromList('* intelio\nprc\ndefault\n'), ['intelio', 'prc'], 'the older bare list still works');
});

test('/api/home profiles from the CLI list stay exactly the four agents', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-profile-list-'));
  try {
    for (const id of ['intelio', 'prc', 'alignment', 'hhp']) fs.mkdirSync(path.join(home, '.hermes', 'profiles', id), { recursive: true });
    const rows = await listProfiles({ home, run: async () => ({ code: 0, stdout: LIST }) });
    assert.deepEqual(rows.map((row) => row.id), ['alignment', 'hhp', 'intelio', 'prc']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
