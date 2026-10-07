const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { originAllowed } = require('../src/intelio/origins.cjs');
const { safetyDefaults, classifyUrl, agentNavigationDecision, redact } = require('../src/intelio/safety.cjs');
const { loadIntelio, pngIcon, displayTitle } = require('../src/intelio/bridge.cjs');
const { linuxDemoEnabled, rendererSandbox } = require('../src/intelio/linux-demo.cjs');
const { loadVpsPolicy, assertLoopbackBrowser } = require('../src/intelio/sidecar.cjs');
const { app, agents, agentsSetup } = require('../src/intelio/forks.cjs');

const repo = path.resolve(__dirname, '../..');
const example = path.join(repo, 'intelio', 'profiles', 'example');

test('safety defaults stay ask-first and reject YOLO', () => {
  const defaults = safetyDefaults(null);
  assert.equal(defaults.yolo, false);
  assert.equal(defaults.consequential, 'ask');
  assert.equal(defaults.vaultBlind, true);
  for (const kind of ['external_message', 'purchase', 'credential_change', 'permission_change', 'production_change', 'destructive']) {
    assert.ok(defaults.consequentialActions.includes(kind));
  }
  assert.throws(() => safetyDefaults({ yolo: true }), /YOLO/);
  assert.throws(() => safetyDefaults({ consequential: 'auto' }), /ask-first/);
});

test('browsing zones deny outside origins and consequential urls stay ask-first', () => {
  assert.equal(originAllowed('https://github.com/intelio', []), true);
  assert.equal(originAllowed('https://github.com/intelio', ['https://github.com']), true);
  assert.equal(originAllowed('https://example.com/', ['https://github.com']), false);
  assert.equal(originAllowed('https://user:pw@github.com/', ['https://github.com']), false);
  assert.equal(classifyUrl('https://checkout.stripe.com/c/pay'), 'purchase');
  assert.equal(classifyUrl('https://shop.example/checkout/start'), 'purchase');
  assert.equal(classifyUrl('https://github.com/login'), null);
  const blocked = agentNavigationDecision('https://paypal.com/checkout', { origins: ['https://paypal.com'], approved: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.match(blocked.error, /approval_required: purchase/);
  const outside = agentNavigationDecision('https://example.com/', { origins: ['https://github.com'], approved: true });
  assert.equal(outside.ok, false);
  assert.equal(outside.status, 403);
  assert.equal(agentNavigationDecision('file:///tmp/newtab.html', { appPages: ['file:///tmp/newtab.html'], origins: ['https://github.com'] }).ok, true);
});

test('redaction removes credential shapes from loader errors', () => {
  const secret = 'super-secret-vault-value';
  assert.equal(redact(`password=${secret}`).includes(secret), false);
  assert.match(redact(`token=${secret}`), /\[redacted\]/);
});

test('the example profile loads through the Python loader and does not echo .env', () => {
  const envFile = path.join(example, '.env');
  fs.writeFileSync(envFile, 'API_TOKEN=super-secret-vault-value\n', { mode: 0o600 });
  try {
    const session = loadIntelio({ profileDir: example, repo });
    assert.equal(session.ok, true, session.error);
    assert.equal(session.public.profileName, 'Example');
    assert.equal(session.public.safety.yolo, false);
    assert.equal(session.public.safety.consequential, 'ask');
    assert.deepEqual(session.public.launchArgv, ['hermes', '-p', 'example']);
    assert.equal(session.public.hermes.pinCommit, '5d3c05977bb3c8b7cfd6b3e39d96f6e35a9e0662');
    assert.equal(session.public.pinVerifiedOn, '2026-10-03');
    if (session.public.hermes.commandOk) assert.ok(['commit', 'differs', 'unverified'].includes(session.public.hermes.match));
    else {
      assert.equal(session.public.hermes.match, 'unavailable');
      assert.notEqual(session.public.hermes.summary, 'installed commit matches the pin');
    }
    assert.match(session.public.brand.windowTitle, /^intelio$/);
    assert.equal(JSON.stringify(session.public).includes('super-secret-vault-value'), false);
  } finally {
    fs.rmSync(envFile, { force: true });
  }
});

test('a missing profile is a refusal, not a successful report', () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-missing-'));
  const session = loadIntelio({ profileDir: missing, repo });
  assert.equal(session.ok, false);
  assert.match(session.error, /refused to start/);
  assert.equal(session.public.ok, false);
});

test('linux demo sandbox switch is opt-in', () => {
  assert.equal(linuxDemoEnabled({ INTELIO_LINUX_DEMO: '1' }, 'linux'), true);
  assert.equal(linuxDemoEnabled({ INTELIO_LINUX_DEMO: '1' }, 'darwin'), false);
  assert.equal(linuxDemoEnabled({}, 'linux'), false);
  assert.equal(rendererSandbox({ INTELIO_LINUX_DEMO: '1' }, 'linux'), false);
  assert.equal(rendererSandbox({ INTELIO_LINUX_DEMO: '1' }, 'darwin'), true);
  assert.equal(rendererSandbox({}, 'linux'), true);
});

test('window icon is a real PNG', () => {
  const png = pngIcon();
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.length > 32);
  assert.equal(displayTitle('intelio'), 'intelio');
  assert.equal(displayTitle('Intelio'), 'intelio');
  assert.equal(displayTitle(''), 'intelio');
  assert.equal(displayTitle('Notes'), 'Notes');
  const main = fs.readFileSync(path.join(repo, 'desktop/src/main.cjs'), 'utf8');
  assert.match(main, /function intelioTitle\(\) \{\n  return 'intelio';\n\}/);
  assert.match(main, /label: 'intelio'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'desktop/package.json'), 'utf8'));
  assert.equal(pkg.productName, 'intelio');
  assert.equal(pkg.build.productName, 'intelio');
  assert.equal(pkg.build.executableName, 'intelio');
  assert.equal(pkg.build.win.executableName, 'intelio');
  assert.equal(pkg.build.win.signExecutable, false);
  assert.equal(pkg.build.win.signAndEditExecutable, undefined);
  assert.equal(pkg.build.nsis.shortcutName, 'intelio');
  assert.equal(pkg.build.nsis.uninstallDisplayName, 'intelio');
  assert.equal(pkg.build.nsis.include, 'nsis/installer.nsh');
  const installer = fs.readFileSync(path.join(repo, 'desktop/nsis/installer.nsh'), 'utf8');
  assert.match(installer, /Delete "\$\{dir\}\\Intelio\.lnk"/);
  assert.match(installer, /CreateShortCut "\$\{dir\}\\intelio\.lnk" "\$appExe"/);
  assert.match(installer, /Delete "\$SMPROGRAMS\\Intelio\\Intelio\.lnk"/);
});

test('the VPS sidecar uses strict defaults and refuses YOLO', () => {
  const defaults = loadVpsPolicy({ sidecarPath: '' });
  assert.deepEqual(defaults.origins, []);
  assert.equal(defaults.safety.yolo, false);
  assert.equal(defaults.safety.consequential, 'ask');
  const examplePolicy = loadVpsPolicy({ sidecarPath: path.join(example, 'alans-way.yaml') });
  assert.deepEqual(examplePolicy.origins, []);
  assert.equal(examplePolicy.safety.consequential, 'ask');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-sidecar-'));
  const file = path.join(dir, 'alans-way.yaml');
  fs.writeFileSync(file, 'browsing_origins:\n  - https://github.com/\n  - https://example.com:8443\nsafety:\n  yolo: false\n  consequential: ask\n');
  assert.deepEqual(loadVpsPolicy({ sidecarPath: file }).origins, ['https://github.com', 'https://example.com:8443']);
  fs.writeFileSync(file, 'safety:\n  yolo: true\n');
  assert.throws(() => loadVpsPolicy({ sidecarPath: file }), /YOLO is not allowed/);
  fs.writeFileSync(file, 'safety:\n  consequential: auto\n');
  assert.throws(() => loadVpsPolicy({ sidecarPath: file }), /ask-first/);
  fs.writeFileSync(file, 'api_token: nope\n');
  assert.throws(() => loadVpsPolicy({ sidecarPath: file }), /unknown fields/);
  fs.symlinkSync(file, path.join(dir, 'link.yaml'));
  assert.throws(() => loadVpsPolicy({ sidecarPath: path.join(dir, 'link.yaml') }), /missing/);
  assert.throws(() => loadVpsPolicy({ sidecarPath: path.join(dir, 'absent.yaml') }), /missing/);
  assert.throws(() => assertLoopbackBrowser({ cdpUrl: 'http://example.invalid:9223' }), /loopback/);
  assert.throws(() => assertLoopbackBrowser({ cdpUrl: 'http://127.0.0.1:9223', browserArgs: ['--remote-debugging-address=example.invalid'] }), /127\.0\.0\.1/);
  assert.throws(() => assertLoopbackBrowser({ cdpUrl: 'http://127.0.0.1:9223', host: 'example.invalid' }), /127\.0\.0\.1 only/);
});

test('setup URLs come from intelio/forks.json', () => {
  assert.equal(app, 'https://github.com/inteliodev/alans-way');
  assert.equal(agents, 'https://github.com/inteliodev/alans-way-agents');
  assert.equal(agentsSetup, 'https://raw.githubusercontent.com/inteliodev/alans-way-agents/main/setup.sh');
  const main = fs.readFileSync(path.join(repo, 'desktop/src/main.cjs'), 'utf8');
  assert.equal(main.includes('capthvnsen'), false);
  assert.match(main, /agentsSetup/);
  assert.match(main, /require\('\.\/intelio\/forks\.cjs'\)/);
});
