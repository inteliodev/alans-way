const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const link = require('../src/intelio/skill-link.cjs');
const { createSkillInstaller } = require('../../mobile/pwa/skills-install.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const SKILL_MD = '---\nname: PDF Tools\ndescription: SAMPLE DATA. Split and merge PDFs.\nversion: 1.2.0\nmetadata:\n  hermes:\n    category: productivity\n---\n# PDF Tools\nUse scripts/split.py.\n';

/** A fake GitHub: contents API listings plus raw downloads. Records every URL asked for. */
function fakeGithub(tree = {}, { calls = [] } = {}) {
  const files = {
    'skills/pdf-tools/SKILL.md': SKILL_MD,
    'skills/pdf-tools/scripts/split.py': 'print("SAMPLE DATA")\n',
    'skills/pdf-tools/README.md': 'SAMPLE DATA readme\n',
    ...tree,
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    const ok = (body, type = 'application/json') => ({ ok: true, status: 200, headers: { get: (name) => (name === 'content-length' ? String(Buffer.byteLength(body)) : type) }, text: async () => body, arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
    const missing = { ok: false, status: 404, headers: { get: () => '' }, text: async () => '{}' };
    if (parsed.hostname === 'api.github.com') {
      if (parsed.pathname === '/repos/sample-owner/sample-skills') return ok(JSON.stringify({ default_branch: 'main' }));
      const match = /^\/repos\/sample-owner\/sample-skills\/contents\/?(.*)$/.exec(parsed.pathname);
      if (!match) return missing;
      const dir = decodeURIComponent(match[1]);
      const prefix = dir ? `${dir}/` : '';
      const names = new Map();
      for (const [file, body] of Object.entries(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [head, ...tail] = rest.split('/');
        if (tail.length) names.set(head, { name: head, type: 'dir' });
        else names.set(head, { name: head, type: 'file', size: Buffer.byteLength(body), download_url: `https://raw.githubusercontent.com/sample-owner/sample-skills/main/${file}` });
      }
      if (!names.size) return missing;
      return ok(JSON.stringify([...names.values()]));
    }
    if (parsed.hostname === 'raw.githubusercontent.com') {
      const file = parsed.pathname.replace('/sample-owner/sample-skills/main/', '');
      return files[file] !== undefined ? ok(files[file], 'text/plain') : missing;
    }
    throw new Error(`unexpected host ${parsed.hostname}`);
  };
  return { fetchImpl, calls };
}

function profilesRoot(ids = ['intelio', 'prc']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-skill-'));
  for (const id of ids) {
    fs.mkdirSync(path.join(root, id, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'config.yaml'), 'model: sample\n');
  }
  return root;
}

const URL_OK = 'https://github.com/sample-owner/sample-skills/tree/main/skills/pdf-tools';

test('skill links: only https github.com folder links are accepted', () => {
  assert.equal(link.parseSkillUrl(URL_OK).ok, true);
  assert.equal(link.parseSkillUrl('https://github.com/sample-owner/sample-skills/blob/main/skills/pdf-tools/SKILL.md').dir, 'skills/pdf-tools');
  assert.equal(link.parseSkillUrl('https://github.com/sample-owner/sample-skills').ok, true);
  for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com.evil.example/a/b', 'https://user:pw@github.com/a/b', 'https://github.com:444/a/b', 'https://github.com/a/b/tree/main/../x', 'file:///etc/passwd', 'not a url']) {
    assert.equal(link.parseSkillUrl(bad).ok, false, bad);
  }
});

test('skill links: file kinds, unsafe paths and the target layout', () => {
  assert.equal(link.classifyFile('SKILL.md'), 'skill');
  assert.equal(link.classifyFile('scripts/run.sh'), 'script');
  assert.equal(link.classifyFile('bin/tool.exe'), 'blocked');
  assert.equal(link.safeRelPath('../x.md'), false);
  assert.equal(link.safeRelPath('.git/config'), false);
  assert.equal(link.checkFiles([{ path: 'README.md', size: 4 }]).ok, false);
  const plan = link.planTargets({ profiles: ['prc', 'Bad Name'], category: 'productivity', slug: 'pdf-tools' });
  assert.equal(plan[0].dir, '~/.hermes/profiles/prc/skills/productivity/pdf-tools/');
  assert.equal(plan[1].ok, false);
  assert.equal(link.describeSkill(SKILL_MD).slug, 'pdf-tools');
});

test('preview downloads into memory, writes nothing, and shows where files land', async () => {
  const root = profilesRoot();
  const { fetchImpl, calls } = fakeGithub();
  const installer = createSkillInstaller({ fetchImpl, profilesRoot: root });
  const preview = await installer.preview({ url: URL_OK, profiles: ['intelio', 'prc'] });
  assert.match(preview.token, /^[a-f0-9]{32}$/);
  assert.equal(preview.skill.slug, 'pdf-tools');
  assert.equal(preview.skill.category, 'productivity');
  assert.match(preview.skillMd, /Split and merge PDFs/);
  assert.deepEqual(preview.files.map((file) => file.path), ['SKILL.md', 'README.md', 'scripts/split.py']);
  assert.ok(preview.warnings.some((warning) => /not run/.test(warning)));
  assert.deepEqual(preview.targets.map((target) => target.dir), ['~/.hermes/profiles/intelio/skills/productivity/pdf-tools/', '~/.hermes/profiles/prc/skills/productivity/pdf-tools/']);
  assert.equal(fs.existsSync(path.join(root, 'intelio', 'skills', 'productivity')), false);
  assert.ok(calls.every((url) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(url)));
});

test('install writes the previewed files, refuses to clobber, backs up on replace, and logs', async () => {
  const root = profilesRoot();
  const { fetchImpl } = fakeGithub();
  const installer = createSkillInstaller({ fetchImpl, profilesRoot: root });
  const preview = await installer.preview({ url: URL_OK, profiles: ['prc'], category: 'docs' });
  const result = await installer.install({ token: preview.token, profile: 'prc' });
  assert.equal(result.ok, true);
  assert.equal(result.dir, '~/.hermes/profiles/prc/skills/docs/pdf-tools/');
  const dir = path.join(root, 'prc', 'skills', 'docs', 'pdf-tools');
  assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), SKILL_MD);
  assert.equal(fs.statSync(path.join(dir, 'scripts', 'split.py')).mode & 0o111, 0, 'scripts are not made executable');
  assert.equal(fs.existsSync(path.join(root, 'intelio', 'skills', 'docs')), false, 'other profiles are untouched');
  await assert.rejects(installer.install({ token: preview.token, profile: 'prc' }), (error) => error.status === 409);
  const replaced = await installer.install({ token: preview.token, profile: 'prc', overwrite: true });
  assert.equal(replaced.replaced, true);
  assert.equal(fs.readdirSync(path.join(root, 'prc', 'backups', 'skills')).length, 1);
  const log = fs.readFileSync(path.join(root, 'prc', 'logs', 'intelio-skill-installs.jsonl'), 'utf8').trim().split('\n');
  assert.equal(log.length, 2);
  assert.equal(JSON.parse(log[1]).replaced, true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'prc', 'cache')), [], 'staging is cleaned up');
  assert.equal(fs.readFileSync(path.join(root, 'prc', 'config.yaml'), 'utf8'), 'model: sample\n', 'config.yaml is never touched');
});

test('install refuses unknown profiles, expired tokens, bucket folders and blocked files', async () => {
  const root = profilesRoot();
  const { fetchImpl } = fakeGithub();
  let clock = 1000;
  const installer = createSkillInstaller({ fetchImpl, profilesRoot: root, now: () => clock });
  const preview = await installer.preview({ url: URL_OK, profiles: ['prc'] });
  await assert.rejects(installer.install({ token: preview.token, profile: 'hhp' }), (error) => error.status === 404);
  await assert.rejects(installer.install({ token: 'nope', profile: 'prc' }), (error) => error.status === 410);
  fs.mkdirSync(path.join(root, 'prc', 'skills', 'productivity', 'pdf-tools', 'other-skill'), { recursive: true });
  await assert.rejects(installer.install({ token: preview.token, profile: 'prc' }), (error) => error.status === 409);
  clock += 11 * 60 * 1000;
  await assert.rejects(installer.install({ token: preview.token, profile: 'prc' }), (error) => error.status === 410);
  const blocked = fakeGithub({ 'skills/pdf-tools/tool.exe': 'MZ' });
  const strict = createSkillInstaller({ fetchImpl: blocked.fetchImpl, profilesRoot: root });
  await assert.rejects(strict.preview({ url: URL_OK, profiles: ['prc'] }), (error) => error.status === 400);
  await assert.rejects(strict.preview({ url: 'https://example.com/x', profiles: ['prc'] }), (error) => error.status === 400);
});

test('install refuses download links off raw.githubusercontent.com and oversized files', async () => {
  const root = profilesRoot();
  const evil = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/contents/skills/x')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ name: 'SKILL.md', type: 'file', size: 10, download_url: 'https://evil.example/SKILL.md' }]) };
    }
    throw new Error('should not fetch');
  };
  const installer = createSkillInstaller({ fetchImpl: evil, profilesRoot: root });
  await assert.rejects(installer.preview({ url: 'https://github.com/sample-owner/sample-skills/tree/main/skills/x', profiles: ['prc'] }), (error) => error.status === 502);
  const big = fakeGithub({ 'skills/pdf-tools/notes.md': 'x'.repeat(link.LIMITS.maxFileBytes + 1) });
  const sized = createSkillInstaller({ fetchImpl: big.fetchImpl, profilesRoot: root });
  await assert.rejects(sized.preview({ url: URL_OK, profiles: ['prc'] }), (error) => error.status === 400 || error.status === 413);
});

function request(port, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathname, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('PWA server: /api/skills/preview and /install need the right profile key and install only there', async () => {
  const root = profilesRoot(['intelio', 'prc']);
  const keys = { intelio: 'intelio-sample-key-00000001', prc: 'prc-sample-key-000000000001' };
  const { fetchImpl } = fakeGithub();
  const logs = [];
  const app = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: 'http://127.0.0.1:9', fetchImpl: globalThis.fetch,
    vaultRoot: root,
    githubFetch: fetchImpl,
    profileOps: { keyFor: (id) => keys[id] || '' },
    identify: async () => ({ ok: true, login: 'owner@example' }),
    log: (line) => logs.push(line),
  });
  const address = await app.listen();
  try {
    const as = (id) => ({ authorization: `Bearer ${keys[id]}`, 'x-intelio-profile': id });
    const noAuth = await request(address.port, 'POST', '/api/skills/preview', { body: JSON.stringify({ url: URL_OK, profiles: ['prc'] }) });
    assert.ok(noAuth.status === 401 || noAuth.status === 403, `no key: ${noAuth.status}`);
    const preview = await request(address.port, 'POST', '/api/skills/preview', { headers: as('prc'), body: JSON.stringify({ url: URL_OK, profiles: ['prc'] }) });
    assert.equal(preview.status, 200, preview.body);
    const token = JSON.parse(preview.body).token;
    const badUrl = await request(address.port, 'POST', '/api/skills/preview', { headers: as('prc'), body: JSON.stringify({ url: 'https://example.com/a/b', profiles: ['prc'] }) });
    assert.equal(badUrl.status, 400);
    const wrongKey = await request(address.port, 'POST', '/api/skills/install', { headers: { authorization: `Bearer ${keys.intelio}`, 'x-intelio-profile': 'prc' }, body: JSON.stringify({ token, profile: 'prc' }) });
    assert.equal(wrongKey.status, 401);
    assert.equal(fs.existsSync(path.join(root, 'prc', 'skills', 'productivity')), false);
    const crossProfile = await request(address.port, 'POST', '/api/skills/install', { headers: as('intelio'), body: JSON.stringify({ token, profile: 'prc' }) });
    assert.equal(crossProfile.status, 401, 'an intelio key cannot install into prc');
    const installed = await request(address.port, 'POST', '/api/skills/install', { headers: as('prc'), body: JSON.stringify({ token, profile: 'prc' }) });
    assert.equal(installed.status, 200, installed.body);
    assert.equal(JSON.parse(installed.body).dir, '~/.hermes/profiles/prc/skills/productivity/pdf-tools/');
    assert.ok(fs.existsSync(path.join(root, 'prc', 'skills', 'productivity', 'pdf-tools', 'SKILL.md')));
    const spilled = [...logs, preview.body, installed.body, wrongKey.body].join('\n');
    assert.equal(spilled.includes(keys.prc), false);
    assert.equal(spilled.includes(keys.intelio), false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('desktop and web clients ask the PWA server for skill-preview and skill-install', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/intelio/remote-hermes-main.cjs'), 'utf8');
  assert.match(main, /case 'skill-preview':[\s\S]*?\/api\/skills\/preview/);
  assert.match(main, /case 'skill-install':[\s\S]*?\/api\/skills\/install/);
  const transport = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/public/desktop-transport.js'), 'utf8');
  assert.match(transport, /name === 'skill-preview'[\s\S]*?\/api\/skills\/preview/);
  assert.match(transport, /name === 'skill-install'[\s\S]*?\/api\/skills\/install/);
  const installer = fs.readFileSync(path.join(__dirname, '../../mobile/pwa/skills-install.cjs'), 'utf8');
  assert.doesNotMatch(installer, /child_process|execFile|spawn\(/, 'the installer never runs anything');
  assert.doesNotMatch(installer, /auth\.json['"]\)|config\.yaml['"],\s*['"]w/, 'the installer never writes Hermes config or auth');
});
