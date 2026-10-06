const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { assertSlug, listProfiles, createProfile, writeFreshKey, restartGateway } = require('../../mobile/pwa/profiles.cjs');
const { hashHue, orbPalette } = require('../../mobile/pwa/orbs.cjs');
const { createPwaServer } = require('../../mobile/pwa/server.cjs');

const KEY = 'sample-demo-key-not-real-0001';
const OTHER = 'sample-other-key-not-real-0002';

function throwsStatus(fn, status) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.status, status);
    return;
  }
  assert.fail('expected a rejection');
}

test('profile names stay short slugs and skip default', async () => {
  throwsStatus(() => assertSlug('default'), 400);
  throwsStatus(() => assertSlug('Default'), 400);
  throwsStatus(() => assertSlug('PRC_team'), 400);
  throwsStatus(() => assertSlug(`${'a'.repeat(33)}`), 400);
  throwsStatus(() => assertSlug('ab-'), 400);
  assert.equal(assertSlug('Lumen'), 'lumen');
  const dirs = [
    { name: 'default', isDirectory: () => true },
    { name: '.hidden', isDirectory: () => true },
    { name: 'intelio', isDirectory: () => true },
  ];
  const listed = await listProfiles({
    home: os.tmpdir(),
    fsImpl: {
      readdirSync() { return dirs; },
      readFileSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    },
    run: async () => ({ code: 0, stdout: 'default\nprc\n', stderr: '' }),
  });
  assert.deepEqual(listed.map((item) => item.id), ['intelio', 'prc']);
});

test('creating an agent sets Codex config, writes a fresh key, and never calls auth', async () => {
  const calls = [];
  const files = {};
  const fsImpl = {
    readFileSync(file) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file];
    },
    writeFileSync(file, data, options) {
      files[file] = data;
      files[`${file}:mode`] = options && options.mode;
    },
    chmodSync(file, mode) { files[`${file}:chmod`] = mode; },
    mkdirSync() {},
  };
  const created = await createProfile({
    name: 'lumen',
    description: 'soft glow',
    cloneFrom: 'prc',
    home: path.join(os.tmpdir(), 'intelio-profiles'),
    run: async (bin, args) => {
      calls.push([bin, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    },
    fsImpl,
  });
  const flat = calls.map((parts) => parts.join(' '));
  assert.equal(flat.some((line) => line.includes(' auth')), false);
  assert.equal(flat.some((line) => line.includes('--clone-all') || line.includes('--clone-channels')), false);
  assert.equal(flat.includes('hermes profile create lumen --no-alias --description soft glow --clone-from prc'), true);
  assert.equal(flat.includes('hermes profile describe lumen --text soft glow'), true);
  assert.equal(flat.includes('hermes -p lumen config set model.provider openai-codex'), true);
  assert.equal(flat.includes('hermes -p lumen config set model.default gpt-6-sol'), true);
  const envPath = Object.keys(files).find((name) => name.endsWith(`${path.sep}.env`));
  const secret = String(files[envPath] || '').split('\n').find((line) => line.startsWith('API_SERVER_KEY=')) || '';
  assert.equal(secret.length === 'API_SERVER_KEY='.length + 64, true);
  assert.equal(/^[0-9a-f]+$/.test(secret.slice('API_SERVER_KEY='.length)), true);
  assert.equal(files[`${envPath}:mode`], 0o600);
  assert.equal(files[`${envPath}:chmod`], 0o600);
  assert.equal(JSON.stringify(created).includes('API_SERVER_KEY'), false);
  assert.equal(created.needsGatewayRestart, true);
  const blank = [];
  await createProfile({
    name: 'nimbus',
    home: path.join(os.tmpdir(), 'intelio-profiles'),
    run: async (bin, args) => { blank.push(args.join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    fsImpl,
  });
  assert.equal(blank[0].includes('--clone-from'), false);
  await assert.rejects(() => createProfile({
    name: 'quartz',
    home: path.join(os.tmpdir(), 'intelio-profiles'),
    run: async (bin, args) => ({ code: args.includes('model.provider') ? 1 : 0, stdout: '', stderr: '' }),
    fsImpl,
  }), /Codex model/);
});

test('a fresh key replaces a cloned one and the gateway restart is explicit', () => {
  const files = { '/tmp/cloned.env': 'API_SERVER_KEY=cloned-value-not-used\nOTHER=1\n' };
  const fsImpl = {
    readFileSync(file) { return files[file]; },
    writeFileSync(file, data, options) { files[file] = data; files.mode = options.mode; },
    chmodSync(file, mode) { files.chmod = mode; },
    mkdirSync() {},
  };
  writeFreshKey('/tmp/cloned.env', fsImpl, () => Buffer.alloc(32, 7));
  assert.equal(files['/tmp/cloned.env'].includes('cloned-value-not-used'), false);
  assert.equal(files['/tmp/cloned.env'].includes('OTHER=1'), true);
  assert.equal(files.mode, 0o600);
  assert.equal(files.chmod, 0o600);
  return restartGateway({
    run: async (bin, args) => {
      assert.deepEqual([bin, ...args], ['systemctl', '--user', 'restart', 'hermes-gateway']);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
});

test('named orbs stay distinct from hashed ones', () => {
  const { frameOf, holdOf } = require('../../mobile/pwa/thinking-orbs.cjs');
  const { renderOrbPng, signatureOf } = require('../../mobile/pwa/orbs.cjs');
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../mobile/pwa/public/app.js'), 'utf8');
  assert.notEqual(hashHue('lumen'), hashHue('nimbus'));
  assert.equal(orbPalette('intelio').kind, 'named');
  assert.equal(orbPalette('lumen').kind, 'hash');
  assert.equal(orbPalette('Lumen').hue, hashHue('lumen'));
  assert.equal(signatureOf('intelio'), 'connecting');
  assert.equal(signatureOf('prc'), 'solving');
  assert.equal(signatureOf('alignment'), 'searching');
  assert.equal(signatureOf('hhp'), 'weaving');
  assert.equal(signatureOf('kid-a'), 'composing');
  assert.equal(signatureOf('Kid A'), 'composing');
  const open = ['working', 'listening', 'breathing', 'shaping'];
  assert.equal(open.includes(signatureOf('lumen')), true);
  assert.equal(open.includes(signatureOf('nimbus')), true);
  assert.notEqual(signatureOf('lumen'), signatureOf('nimbus'));
  assert.match(app, /intelio: 'connecting'/);
  assert.match(app, /prc: 'solving'/);
  const connecting = frameOf('connecting', 64, holdOf('connecting'));
  const solving = frameOf('solving', 64, holdOf('solving'));
  assert.equal(connecting.lines.length > 20, true);
  assert.equal(solving.dots.length > 20, true);
  assert.equal(connecting.dots[0].x === solving.dots[0].x && connecting.dots.length === solving.dots.length, false);
  const png = renderOrbPng('intelio', 64);
  assert.equal(png[0], 0x89);
  assert.equal(png.length > 200, true);
});

function request(port, method, pathname, { cookie = '', body, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        ...headers,
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin, host: `127.0.0.1:${port}` } : {}),
        ...(body && !headers['content-type'] ? { 'content-type': 'application/json' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('profile routes stay on the server and a missing origin cannot create or restart', async () => {
  let restarted = 0;
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url || '', auth: req.headers.authorization || '' });
    if ((req.url || '').startsWith('/p/prc/api/sessions')) {
      res.end(JSON.stringify({ data: [{ id: 'prc-chat', title: 'PRC', source: 'chat' }] }));
      return;
    }
    res.end(req.url && req.url.includes('capabilities') ? '{"features":{}}' : '{"data":[]}');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const sample = createPwaServer({
    bind: '127.0.0.1', port: 0, sample: true, upstream: 'http://127.0.0.1:9',
    fetchImpl: async () => { throw new Error('upstream'); },
    profileOps: { async restart() { restarted += 1; } },
  });
  const live = createPwaServer({
    bind: '127.0.0.1', port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`,
    fetchImpl: globalThis.fetch, identify: async () => ({ ok: true, login: 'owner@example' }),
    profileOps: {
      async list() { return [{ id: 'intelio', name: 'Intelio', description: '' }, { id: 'prc', name: 'PRC', description: '' }]; },
      keyFor(id) { return id === 'prc' ? OTHER : KEY; },
      async create() { return { id: 'lumen', name: 'Lumen', description: '', needsGatewayRestart: true }; },
      async restart() { restarted += 1; },
    },
  });
  const sampleAddress = await sample.listen();
  const liveAddress = await live.listen();
  try {
    const blocked = await request(sampleAddress.port, 'POST', '/api/profiles', { body: JSON.stringify({ name: 'lumen' }) });
    assert.equal(blocked.status, 403);
    const made = await request(sampleAddress.port, 'POST', '/api/profiles', {
      origin: `http://127.0.0.1:${sampleAddress.port}`,
      body: JSON.stringify({ name: 'lumen', description: 'glow' }),
    });
    const created = JSON.parse(made.body);
    assert.equal(created.id, 'lumen');
    assert.equal(created.needsGatewayRestart, true);
    assert.equal(created.label, 'SAMPLE DATA');
    assert.equal(made.body.includes(KEY) || made.body.includes(OTHER), false);
    const sampleRestart = await request(sampleAddress.port, 'POST', '/api/gateway/restart', {
      origin: `http://127.0.0.1:${sampleAddress.port}`,
      body: '{}',
    });
    assert.equal(sampleRestart.status, 200);
    assert.match(sampleRestart.body, /SAMPLE DATA/);
    assert.equal(restarted, 0);
    const login = await request(liveAddress.port, 'GET', '/session');
    const cookie = login.body && '';
    const session = await request(liveAddress.port, 'GET', '/session');
    const setCookie = session.status === 200 ? (await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: liveAddress.port, method: 'GET', path: '/session' }, (res) => {
        res.resume();
        res.on('end', () => resolve(String(res.headers['set-cookie'] || '').split(';')[0]));
      });
      req.on('error', reject);
      req.end();
    })) : cookie;
    const home = await request(liveAddress.port, 'GET', '/api/home', { cookie: setCookie });
    const homeJson = JSON.parse(home.body);
    assert.deepEqual(homeJson.profiles.map((item) => item.id), ['intelio', 'prc']);
    assert.equal(home.body.includes(KEY) || home.body.includes(OTHER), false);
    const prcHit = seen.some((row) => row.url.startsWith('/p/prc/api/sessions') && row.auth === `Bearer ${OTHER}`);
    const intelioHit = seen.some((row) => row.url.startsWith('/p/intelio/') && row.auth === `Bearer ${KEY}`);
    assert.equal(prcHit, true);
    assert.equal(intelioHit, true);
    const before = restarted;
    const liveCreate = await request(liveAddress.port, 'POST', '/api/profiles', {
      cookie: setCookie,
      origin: `http://127.0.0.1:${liveAddress.port}`,
      body: JSON.stringify({ name: 'nimbus' }),
    });
    assert.equal(JSON.parse(liveCreate.body).needsGatewayRestart, true);
    assert.equal(restarted, before);
    const liveRestart = await request(liveAddress.port, 'POST', '/api/gateway/restart', {
      cookie: setCookie,
      origin: `http://127.0.0.1:${liveAddress.port}`,
      body: '{}',
    });
    assert.equal(liveRestart.status, 200);
    assert.equal(restarted, before + 1);
  } finally {
    await new Promise((resolve) => sample.server.close(resolve));
    await new Promise((resolve) => live.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
