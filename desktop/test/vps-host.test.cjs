// Runs the real scripts/vps-browser-host.cjs broker against a stub CDP socket.
// No Chromium launches; the fixture answers just enough DevTools protocol to
// exercise the overseer role and the human-controlled read gate end to end.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createStubCdp } = require('./stub-cdp.cjs');

let server, dataDir, child, connection;
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

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vps-host-'));
  server = createStubCdp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${server.address().port}` }));
  child = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], {
    env: { ...process.env, HERMES_VPS_BROWSER_DATA: dataDir, HERMES_OVERSEER_BOT_IDS: 'overseer-1, overseer-2' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const connectionFile = path.join(dataDir, 'connection.json');
  for (let i = 0; i < 100 && !fs.existsSync(connectionFile); i++) {
    assert.equal(child.exitCode, null, `VPS host exited early: ${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(connectionFile), `VPS host never wrote connection.json: ${stderr}`);
  connection = JSON.parse(fs.readFileSync(connectionFile));
});
after(() => {
  child?.kill();
  server?.close();
});

test('an overseer lists every tab while regular bots see only their own', async () => {
  const a = (await api('/v1/tabs', 'POST', { url: 'http://alpha.example/' })).data;
  const b = (await api('/v1/tabs', 'POST', { url: 'http://beta.example/' }, { bot: 'bot-b' })).data;
  const aList = (await api('/v1/tabs')).data.tabs.map((t) => t.id);
  const bList = (await api('/v1/tabs', 'GET', undefined, { bot: 'bot-b' })).data.tabs.map((t) => t.id);
  const overseerList = (await api('/v1/tabs', 'GET', undefined, { bot: 'overseer-1' })).data.tabs.map((t) => t.id);
  assert.ok(aList.includes(a.id) && !aList.includes(b.id), 'bot-a sees only its tabs');
  assert.ok(bList.includes(b.id) && !bList.includes(a.id), 'bot-b sees only its tabs');
  assert.ok(overseerList.includes(a.id) && overseerList.includes(b.id), 'overseer sees every tab');
});

test('bots cannot read a human-controlled tab until control is taken', async () => {
  const held = (await api('/v1/tabs', 'POST', { url: 'http://review.example/' }, { human: true })).data;
  assert.equal(held.controller, 'human');
  assert.equal((await api(`/v1/tabs/${held.id}/snapshot`, 'GET', undefined, { bot: 'bot-b' })).status, 403);
  for (const bot of ['bot-a', 'overseer-1']) {
    for (const read of ['snapshot', 'screenshot']) {
      const blocked = await api(`/v1/tabs/${held.id}/${read}`, 'GET', undefined, { bot });
      assert.equal(blocked.status, 409, `${bot} ${read} on a human tab`);
      assert.equal(blocked.data.error, 'Tab is under human control.');
    }
  }
  const meta = await api(`/v1/tabs/${held.id}`, 'GET', undefined, { bot: 'overseer-1' });
  assert.equal(meta.status, 200);
  assert.equal(meta.data.controller, 'human', 'metadata still reports who holds the tab');
  assert.equal((await api(`/v1/tabs/${held.id}/snapshot`, 'GET', undefined, { human: true })).status, 200);
  const checkpoint = await api(`/v1/tabs/${held.id}/checkpoint`, 'POST', { includeDrafts: true }, { human: true });
  assert.equal(checkpoint.status, 200);
  assert.equal(checkpoint.data.url, 'http://review.example/');
  const seized = await api(`/v1/tabs/${held.id}/control`, 'POST', { controller: 'agent' }, { bot: 'overseer-1' });
  assert.equal(seized.status, 200);
  assert.equal(seized.data.controller, 'agent');
  assert.equal((await api(`/v1/tabs/${held.id}/snapshot`, 'GET', undefined, { bot: 'overseer-1' })).status, 200);
});

test('snapshot bounds, since-dedupe and screenshot format params round-trip', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://bounds.example/' })).data;
  const first = await api(`/v1/tabs/${tab.id}/snapshot?maxChars=100&maxElements=10`);
  assert.equal(first.status, 200);
  assert.equal(first.data.text, 'stub page text');
  assert.ok(Number.isInteger(first.data.generation), 'snapshot reports its generation');
  const repeat = await api(`/v1/tabs/${tab.id}/snapshot?since=${first.data.generation}`);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.unchanged, true, 'identical content with the last generation dedupes');
  assert.ok(repeat.data.generation > first.data.generation, 'dedupe still advances generation');
  assert.equal(repeat.data.text, undefined, 'an unchanged snapshot carries no payload');
  const chained = await api(`/v1/tabs/${tab.id}/snapshot?since=${repeat.data.generation}`);
  assert.equal(chained.data.unchanged, true, 'dedupe chains across consecutive generations');
  const nav = await api(`/v1/tabs/${tab.id}/actions`, 'POST',
    { action: 'navigate', url: 'http://bounds.example/moved', epoch: tab.epoch });
  assert.equal(nav.status, 200);
  const moved = await api(`/v1/tabs/${tab.id}/snapshot?since=${chained.data.generation}`);
  assert.notEqual(moved.data.unchanged, true, 'a url change breaks the hash and returns a full snapshot');
  assert.equal(moved.data.url, 'http://bounds.example/moved');
  const jpeg = await api(`/v1/tabs/${tab.id}/screenshot?format=jpeg&quality=50&maxWidth=400`);
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.data.mimeType, 'image/jpeg');
  assert.equal((await api(`/v1/tabs/${tab.id}/screenshot?format=png`)).data.mimeType, 'image/png');
  assert.equal((await api(`/v1/tabs/${tab.id}/screenshot?format=tiff`)).status, 400, 'unknown formats are rejected');
  assert.equal((await api(`/v1/tabs/${tab.id}/snapshot?maxChars=abc`)).status, 400, 'non-integer bounds are rejected');
});

test('an overseer releases and retakes another bot tab; a stranger cannot', async () => {
  const runaway = (await api('/v1/tabs', 'POST', { url: 'http://runaway.example/' }, { bot: 'bot-a' })).data;
  assert.equal(runaway.controller, 'agent');
  assert.equal((await api(`/v1/tabs/${runaway.id}/control`, 'POST', { controller: 'human' }, { bot: 'bot-b' })).status, 403);
  const released = await api(`/v1/tabs/${runaway.id}/control`, 'POST', { controller: 'human' }, { bot: 'overseer-2' });
  assert.equal(released.status, 200);
  assert.equal(released.data.controller, 'human');
  assert.equal((await api(`/v1/tabs/${runaway.id}/snapshot`, 'GET', undefined, { bot: 'bot-a' })).status, 409,
    'the read gate binds the owner too once the tab is human-controlled');
  assert.equal((await api(`/v1/tabs/${runaway.id}/checkpoint`, 'POST', {}, { human: true })).status, 200,
    'human checkpoint still works on a human-controlled tab');
  const retaken = await api(`/v1/tabs/${runaway.id}/control`, 'POST', { controller: 'agent' }, { bot: 'overseer-2' });
  const nav = await api(`/v1/tabs/${runaway.id}/actions`, 'POST',
    { action: 'navigate', url: 'http://halt.example/', epoch: retaken.data.epoch }, { bot: 'overseer-2' });
  assert.equal(nav.status, 200, 'overseer may act on the tab it controls');
  assert.equal((await api(`/v1/tabs/${runaway.id}/checkpoint`, 'POST', {}, { human: true })).status, 409,
    'checkpoint still requires human control');
  const foreign = await api(`/v1/tabs/${runaway.id}/actions`, 'POST',
    { action: 'reload', epoch: retaken.data.epoch + 1 }, { bot: 'bot-b' });
  assert.equal(foreign.status, 403, 'a stranger bot still cannot act');
});

test('reload answers only after the page load event arrives', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://reload.example/' })).data;
  const started = Date.now();
  const reload = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'reload', epoch: tab.epoch });
  assert.equal(reload.status, 200);
  assert.ok(Date.now() - started >= 280, 'the action waited for Page.loadEventFired');
});

test('handed-off tabs refuse agent claims until the human gives them over', async () => {
  const source = (await api('/v1/tabs', 'POST', { url: 'http://source.example/' }, { human: true })).data;
  const retired = await api(`/v1/tabs/${source.id}/control`, 'POST',
    { controller: 'human', handoff: { id: 'h1', phase: 'handed_off', destinationHost: 'mac', destinationTabId: 'mac-tab' } }, { human: true });
  assert.equal(retired.data.handoff.phase, 'handed_off');
  const blocked = await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /handoff_source.*mac tab mac-tab/);
  assert.equal((await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' }, { bot: 'overseer-1' })).status, 409,
    'an overseer cannot reopen a handed-off source either');
  const given = await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' }, { human: true });
  assert.equal(given.data.handoff.phase, 'reviewed');
  assert.equal(given.data.controller, 'agent');
  await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'human' }, { human: true });
  assert.equal((await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' })).status, 200);

  const restore = async (url) => {
    const tab = (await api('/v1/tabs', 'POST', { url }, { human: true })).data;
    const checkpoint = { url, title: '', scroll: { x: 0, y: 0 }, drafts: [] };
    await api(`/v1/tabs/${tab.id}/restore`, 'POST', { checkpoint, handoff: { id: tab.id, phase: 'review_required' } }, { human: true });
    return tab;
  };
  const unverified = await restore('http://needs-review.example/');
  const waiting = await api(`/v1/tabs/${unverified.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(waiting.status, 409);
  assert.match(waiting.data.error, /handoff_review_required/);
  await api(`/v1/tabs/${unverified.id}/control`, 'POST', { controller: 'agent' }, { human: true });
  const verified = await restore('http://destination.example/');
  assert.equal((await api(`/v1/tabs/${verified.id}/control`, 'POST', { controller: 'agent' })).status, 200,
    'a verified destination continues without a human step');
});
