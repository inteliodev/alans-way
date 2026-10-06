const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { signatureOf } = require('../../mobile/pwa/orbs.cjs');
const { createRemoteMain } = require('../src/intelio/remote-main-data.cjs');
const { signatureOf: uiSignature, switcherRows, SAMPLE } = require('../src/remote-main.js');

const KEYS = {
  intelio: 'i'.repeat(32),
  prc: 'p'.repeat(32),
  alignment: 'a'.repeat(32),
  hhp: 'h'.repeat(32),
};

function listen(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    handler(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function profiles(res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    profiles: [
      { id: 'intelio', name: 'Intelio' },
      { id: 'prc', name: 'PRC' },
      { id: 'alignment', name: 'Alignment' },
      { id: 'hhp', name: 'HHP' },
    ],
  }));
}

test('main window loads every profile from /api/home and tags every session source', async () => {
  const { server, seen, port } = await listen((req, res) => {
    const auth = req.headers.authorization || '';
    if (req.url === '/api/home') {
      if (auth !== `Bearer ${KEYS.intelio}`) { res.statusCode = 401; res.end('{}'); return; }
      profiles(res);
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/p/alignment/api/sessions')) {
      if (auth !== `Bearer ${KEYS.alignment}`) { res.statusCode = 401; res.end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [
        { id: 'ph', source: 'photon', title: 'iMessage' },
        { id: 'tg', source: 'telegram', title: 'Telegram' },
        { id: 'api', source: 'api_server', title: 'API' },
        { id: 'once', source: 'oneshot', title: 'Once' },
      ] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/p/alignment/api/sessions/ph/chat/stream') {
      if (auth !== `Bearer ${KEYS.alignment}`) { res.statusCode = 401; res.end('{}'); return; }
      res.setHeader('content-type', 'text/event-stream');
      res.end('event: assistant.delta\ndata: {"delta":"Hello"}\n\nevent: assistant.completed\ndata: {"content":"Hello"}\n\n');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  try {
    const main = createRemoteMain({
      getConfig: () => ({ enabled: true, host: '127.0.0.1', port, profile: 'intelio' }),
      getKey: async (profile) => KEYS[profile] || '',
      keyNames: () => Object.keys(KEYS),
    });
    const home = await main.listAgents();
    assert.deepEqual(home.agents.map((agent) => [agent.id, agent.orb]), [
      ['intelio', 'connecting'],
      ['prc', 'solving'],
      ['alignment', 'searching'],
      ['hhp', 'weaving'],
    ]);
    for (const agent of home.agents) assert.equal(agent.orb, signatureOf(agent.id));
    const sessions = await main.listSessions('alignment');
    assert.deepEqual(sessions.map((session) => session.sourceLabel), ['photon/iMessage', 'Telegram', 'API', 'One-shot']);
    assert.ok(sessions.every((session) => session.profileId === 'alignment'));
    const text = await main.chat('ph', 'hello', { profile: 'alignment' });
    assert.equal(text, 'Hello');
    const sessionHit = seen.find((hit) => hit.url.startsWith('/p/alignment/api/sessions'));
    assert.equal(sessionHit.auth, `Bearer ${KEYS.alignment}`);
    assert.equal(seen.some((hit) => hit.url.startsWith('/p/intelio/api/sessions')), false);
  } finally { server.close(); }
});

test('profiles endpoint and key names are the fallback when /api/home is missing', async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === '/api/home') { res.statusCode = 404; res.end('{}'); return; }
    if (req.url === '/api/profiles') { profiles(res); return; }
    res.statusCode = 404; res.end('{}');
  });
  try {
    const fromProfiles = createRemoteMain({
      getConfig: () => ({ enabled: true, host: '127.0.0.1', port, profile: 'intelio' }),
      getKey: async (profile) => KEYS[profile] || '',
      keyNames: () => ['hhp'],
    });
    const listed = await fromProfiles.listAgents();
    assert.deepEqual(listed.agents.map((agent) => agent.id), ['intelio', 'prc', 'alignment', 'hhp']);
  } finally { server.close(); }

  const { server: missing, seen, port: missingPort } = await listen((req, res) => { res.statusCode = 404; res.end('{}'); });
  try {
    const fromKeys = createRemoteMain({
      getConfig: () => ({ enabled: true, host: '127.0.0.1', port: missingPort, profile: 'intelio' }),
      getKey: async (profile) => KEYS[profile] || '',
      keyNames: () => ['intelio', 'hhp'],
    });
    const keyed = await fromKeys.listAgents();
    assert.deepEqual(keyed.agents.map((agent) => [agent.id, agent.orb]), [['intelio', 'connecting'], ['hhp', 'weaving']]);
    assert.ok(seen.some((hit) => hit.url === '/api/home'));
    assert.ok(seen.some((hit) => hit.url === '/api/profiles'));
  } finally { missing.close(); }
});

test('a missing key never calls fetch, and config is the last fallback', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('should not fetch'); };
  const main = createRemoteMain({
    getConfig: () => ({ enabled: true, host: '127.0.0.1', port: 9, profile: 'alignment' }),
    getKey: async () => '',
    keyNames: () => [],
    fetchImpl,
  });
  await assert.rejects(main.listSessions('alignment'), /No API key/);
  const home = await main.listAgents();
  assert.deepEqual(home.agents.map((agent) => [agent.id, agent.orb]), [['alignment', 'searching']]);
  assert.equal(calls, 0);
});

test('the profile switcher uses the PWA orb types', () => {
  for (const id of ['intelio', 'prc', 'alignment', 'hhp', 'kid-a', 'custom-agent']) {
    assert.equal(uiSignature(id), signatureOf(id));
  }
  const rows = switcherRows(SAMPLE.agents, { selected: 'alignment' });
  assert.deepEqual(rows.map((row) => [row.id, row.orb, row.subtitle, row.selected]), [
    ['intelio', 'connecting', 'connecting', false],
    ['prc', 'solving', 'solving', false],
    ['alignment', 'searching', 'searching', true],
    ['hhp', 'weaving', 'weaving', false],
  ]);
  assert.deepEqual(switcherRows(SAMPLE.agents, { query: 'weav', selected: 'hhp' }).map((row) => row.id), ['hhp']);
});
