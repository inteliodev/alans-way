// The VPS broker must apply the same Intelio navigation policy as the Mac shell.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createStubCdp } = require('./stub-cdp.cjs');

const hostScript = path.join(__dirname, '../scripts/vps-browser-host.cjs');

function baseEnv(dataDir, extra = {}) {
  const env = { ...process.env, HERMES_VPS_BROWSER_DATA: dataDir, ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, 'INTELIO_SIDECAR')) delete env.INTELIO_SIDECAR;
  if (!Object.prototype.hasOwnProperty.call(extra, 'INTELIO_YOLO')) delete env.INTELIO_YOLO;
  return env;
}

async function waitForExit(child, stderr) {
  const code = await new Promise((resolve) => child.on('exit', resolve));
  return { code, stderr: stderr() };
}

function track(child) {
  let text = '';
  child.stderr.on('data', (chunk) => { text += chunk; });
  return () => text;
}

async function startHost({ config, envExtra = {} }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-policy-'));
  const server = createStubCdp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    port: 0,
    cdpUrl: `http://127.0.0.1:${server.address().port}`,
    ...config,
  }));
  const child = spawn(process.execPath, [hostScript, 'serve'], {
    env: baseEnv(dataDir, envExtra),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = track(child);
  const connectionFile = path.join(dataDir, 'connection.json');
  try {
    for (let i = 0; i < 100 && !fs.existsSync(connectionFile); i++) {
      assert.equal(child.exitCode, null, `VPS host exited early: ${stderr()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fs.existsSync(connectionFile), `VPS host never wrote connection.json: ${stderr()}`);
  } catch (error) {
    child.kill();
    server.close();
    throw error;
  }
  const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
  const api = async (route, method = 'GET', body, { bot = 'bot-a', human = false, epoch } = {}) => {
    const response = await fetch(connection.url + route, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'X-Hermes-Bot': bot,
        'X-Hermes-Human': human ? '1' : '0',
        'X-Control-Epoch': String(epoch ?? ''),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return {
    connection,
    api,
    stop() { child.kill(); server.close(); },
  };
}

async function expectRefusal(envExtra, pattern) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-refuse-'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: 0, cdpUrl: 'http://127.0.0.1:9' }));
  const child = spawn(process.execPath, [hostScript, 'serve'], {
    env: baseEnv(dataDir, envExtra),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = track(child);
  const result = await waitForExit(child, stderr);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, pattern);
  assert.equal(fs.existsSync(path.join(dataDir, 'connection.json')), false);
}

test('a missing sidecar still blocks payment paths and stays on loopback', async () => {
  const host = await startHost({ config: {} });
  try {
    assert.equal(new URL(host.connection.url).hostname, '127.0.0.1');
    const ordinary = await host.api('/v1/tabs', 'POST', { url: 'https://example.com/notes' });
    assert.equal(ordinary.status, 201, JSON.stringify(ordinary.data));
    const payment = await host.api('/v1/tabs', 'POST', { url: 'https://shop.example/payment' });
    assert.equal(payment.status, 409);
    assert.match(payment.data.error, /approval_required: purchase/);
    const billing = await host.api(`/v1/tabs/${ordinary.data.id}/actions`, 'POST', {
      action: 'navigate', url: 'https://shop.example/billing', epoch: ordinary.data.epoch, approved: true,
    });
    assert.equal(billing.status, 409);
    assert.match(billing.data.error, /approval_required: purchase/);
    assert.equal((await host.api(`/v1/tabs/${ordinary.data.id}`)).data.url, 'https://example.com/notes');
  } finally {
    host.stop();
  }
});

test('a sidecar allowlist and payment hosts are enforced for agents only', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-side-'));
  const sidecar = path.join(dataDir, 'alans-way.yaml');
  fs.writeFileSync(sidecar, [
    'hermes_profile: example',
    'browsing_origins:',
    '  - https://github.com',
    'safety:',
    '  yolo: false',
    '  consequential: ask',
    '',
  ].join('\n'));
  const host = await startHost({
    config: {},
    envExtra: { INTELIO_SIDECAR: sidecar, INTELIO_YOLO: '1' },
  });
  try {
    const allowed = await host.api('/v1/tabs', 'POST', { url: 'https://github.com/inteliodev/alans-way' });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.data));
    const outside = await host.api('/v1/tabs', 'POST', { url: 'https://example.com/' });
    assert.equal(outside.status, 403);
    assert.match(outside.data.error, /outside the intelio browsing zone/);
    for (const url of ['https://checkout.stripe.com/pay', 'https://www.paypal.com/', 'https://shop.example/checkout/start', 'https://shop.example/delete-account']) {
      const blocked = await host.api('/v1/tabs', 'POST', { url, approved: true });
      assert.equal(blocked.status, 409, url);
      assert.match(blocked.data.error, /approval_required/);
    }
    const moved = await host.api(`/v1/tabs/${allowed.data.id}/actions`, 'POST', {
      action: 'navigate', url: 'https://example.com/billing', epoch: allowed.data.epoch,
    });
    assert.equal(moved.status, 409);
    assert.equal((await host.api(`/v1/tabs/${allowed.data.id}`)).data.url, 'https://github.com/inteliodev/alans-way');
    const cdp = await host.api(`/v1/tabs/${allowed.data.id}/actions`, 'POST', {
      action: 'cdp', method: 'Page.navigate', params: { url: 'https://stripe.com/checkout' }, epoch: allowed.data.epoch,
    });
    assert.equal(cdp.status, 409);
    assert.match(cdp.data.error, /approval_required: purchase/);
    const human = await host.api('/v1/tabs', 'POST', { url: 'https://checkout.stripe.com/pay' }, { human: true });
    assert.equal(human.status, 201, 'a person can open a payment page');
    const claim = await host.api(`/v1/tabs/${human.data.id}/control`, 'POST', { controller: 'agent' }, { human: true });
    assert.equal(claim.status, 409);
    assert.match(claim.data.error, /approval_required: purchase/);
    assert.equal((await host.api(`/v1/tabs/${human.data.id}`, 'GET', undefined, { human: true })).data.controller, 'human');
  } finally {
    host.stop();
  }
});

test('config.json intelioSidecar is used when the env var is unset', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-cfg-'));
  const sidecar = path.join(dataDir, 'alans-way.yaml');
  fs.writeFileSync(sidecar, 'browsing_origins:\n  - https://example.com\nsafety:\n  yolo: false\n  consequential: ask\n');
  const host = await startHost({ config: { intelioSidecar: sidecar } });
  try {
    assert.equal((await host.api('/v1/tabs', 'POST', { url: 'https://example.com/a' })).status, 201);
    const blocked = await host.api('/v1/tabs', 'POST', { url: 'https://github.com/' });
    assert.equal(blocked.status, 403);
  } finally {
    host.stop();
  }
});

test('YOLO, auto-approval, and a public bind refuse to start', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-yolo-'));
  const sidecar = path.join(dataDir, 'alans-way.yaml');
  fs.writeFileSync(sidecar, 'safety:\n  yolo: true\n  consequential: ask\n');
  await expectRefusal({ INTELIO_SIDECAR: sidecar }, /YOLO is not allowed/);
  fs.writeFileSync(sidecar, 'safety:\n  consequential: auto\n');
  await expectRefusal({ INTELIO_SIDECAR: sidecar }, /ask-first/);
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-public-'));
  fs.writeFileSync(path.join(publicDir, 'config.json'), JSON.stringify({
    port: 0,
    cdpUrl: 'http://example.invalid:9223',
  }));
  const child = spawn(process.execPath, [hostScript, 'serve'], {
    env: baseEnv(publicDir),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = track(child);
  const result = await waitForExit(child, stderr);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /loopback/);
  assert.equal(fs.existsSync(path.join(publicDir, 'connection.json')), false);
  const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-vps-debug-'));
  fs.writeFileSync(path.join(debugDir, 'config.json'), JSON.stringify({
    port: 0,
    cdpUrl: 'http://127.0.0.1:9',
    browserArgs: ['--remote-debugging-address=example.invalid', '--remote-debugging-port=9223'],
  }));
  const debug = spawn(process.execPath, [hostScript, 'serve'], {
    env: baseEnv(debugDir),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const debugErr = track(debug);
  const debugResult = await waitForExit(debug, debugErr);
  assert.notEqual(debugResult.code, 0);
  assert.match(debugResult.stderr, /127\.0\.0\.1/);
  assert.equal(fs.existsSync(path.join(debugDir, 'connection.json')), false);
});
