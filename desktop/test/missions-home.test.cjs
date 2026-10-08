const { test } = require('node:test');
const assert = require('node:assert/strict');
const Missions = require('../src/intelio/missions.cjs');
const Feed = require('../src/intelio/home-feed.cjs');

const NOW = Date.parse('2026-10-08T15:00:00Z');
const secs = (ms) => Math.floor(ms / 1000);
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A Hermes-shaped transcript (SAMPLE DATA): to-dos, a file written, one helper. */
function transcript({ open = true, last = 'SAMPLE DATA · Drafted the outline.' } = {}) {
  const t = secs(NOW - 30 * 60 * 1000);
  return [
    { role: 'user', content: Missions.missionPrompt('SAMPLE DATA launch checklist'), timestamp: t },
    { role: 'assistant', content: '', tool_calls: [call('c1', 'todo', { todos: [
      { id: '1', content: 'Collect requirements', status: 'completed' },
      { id: '2', content: 'Draft the checklist', status: open ? 'in_progress' : 'completed' },
      { id: '3', content: 'Share with the team', status: open ? 'pending' : 'completed' },
    ] })], timestamp: t + 1 },
    { role: 'tool', tool_call_id: 'c1', content: '{"todos":[],"revision":1}', timestamp: t + 2 },
    { role: 'assistant', content: '', tool_calls: [call('c2', 'write_file', { path: '/home/agent/work/checklist.md', content: 'x' }), call('c3', 'delegate_task', { tasks: [{ goal: 'SAMPLE DATA research competitors' }] })], timestamp: t + 3 },
    { role: 'tool', tool_call_id: 'c2', content: 'ok', timestamp: t + 4 },
    { role: 'tool', tool_call_id: 'c3', content: '{"status":"completed"}', timestamp: t + 5 },
    { role: 'assistant', content: last, timestamp: t + 6 },
  ];
}

test('a transcript becomes a mission: goal, to-dos, outputs, helpers', () => {
  const facts = Missions.readTranscript(transcript());
  assert.equal(facts.goal, 'SAMPLE DATA launch checklist');
  assert.equal(facts.missionPrompt, true);
  assert.equal(facts.todos.length, 3);
  assert.deepEqual(facts.outputs.map((item) => item.name), ['checklist.md']);
  assert.deepEqual(facts.helpers, [{ goal: 'SAMPLE DATA research competitors', status: 'done' }]);
  const mission = Missions.deriveMission({ id: 's1', profileId: 'prc', title: 'Launch', last_active: secs(NOW - 30 * 60 * 1000) }, transcript(), { now: NOW });
  assert.equal(mission.status, 'open');
  assert.equal(mission.statusLabel, 'Open to-dos');
  assert.equal(mission.todoDone, 1);
  assert.equal(mission.step, 'Draft the checklist');
  const done = Missions.deriveMission({ id: 's1', profileId: 'prc', title: 'Launch' }, transcript({ open: false }), { now: NOW });
  assert.equal(done.status, 'ready');
  assert.equal(done.statusLabel, 'Done, ready to look at');
});

test('status: working, stopped and replied come from the transcript, never guessed', () => {
  const row = { id: 's2', profileId: 'intelio', title: 'Chat' };
  const recentAsk = [{ role: 'user', content: 'SAMPLE DATA hi', timestamp: secs(NOW - 60 * 1000) }];
  assert.equal(Missions.deriveMission(row, recentAsk, { now: NOW }).status, 'working');
  const oldAsk = [{ role: 'user', content: 'SAMPLE DATA hi', timestamp: secs(NOW - 3 * 3600 * 1000) }];
  assert.equal(Missions.deriveMission(row, oldAsk, { now: NOW }).status, 'stopped');
  const interrupted = [...oldAsk, { role: 'assistant', content: 'Operation interrupted by user', timestamp: secs(NOW - 3 * 3600 * 1000) }];
  assert.equal(Missions.deriveMission(row, interrupted, { now: NOW }).status, 'stopped');
  const replied = [...oldAsk, { role: 'assistant', content: 'SAMPLE DATA hello', timestamp: secs(NOW - 3 * 3600 * 1000) }];
  assert.equal(Missions.deriveMission(row, replied, { now: NOW }).status, 'replied');
  assert.equal(Missions.deriveMission(row, null, { now: NOW }).status, 'recent');
  assert.equal(Missions.deriveMission(row, null, { now: NOW, live: true }).status, 'working');
  for (const value of Object.values(Missions.STATUS)) assert.notEqual(value.label, 'Needs you');
});

test('mission prompt is one line, so it fits the single-line chat box', () => {
  const prompt = Missions.missionPrompt('ship the deck');
  assert.equal(prompt.includes('\n'), false);
  assert.match(prompt, /^Mission: ship the deck/);
  assert.equal(Missions.cleanGoal(prompt), 'ship the deck');
});

test('greeting, date and agent names', () => {
  const morning = new Date(2026, 9, 8, 8, 30);
  assert.equal(Feed.greeting(morning, 'Hayden Ashley'), 'Good morning, Hayden.');
  assert.equal(Feed.greeting(new Date(2026, 9, 8, 14), ''), 'Good afternoon.');
  assert.equal(Feed.greeting(new Date(2026, 9, 8, 20), 'Hayden'), 'Good evening, Hayden.');
  assert.equal(Feed.dateLine(morning), 'Thursday, October 8');
  const agents = [{ id: 'intelio', name: 'intelio' }, { id: 'prc', name: 'prc' }, { id: 'alignment', name: 'alignment' }];
  assert.equal(Feed.agentName(agents, 'intelio'), 'intelio');
  assert.equal(Feed.agentName(agents, 'prc'), 'PRC');
  assert.equal(Feed.agentName(agents, 'alignment'), 'Alignment');
  assert.deepEqual(Feed.orderAgents([{ id: 'arlp' }, { id: 'hhp' }, { id: 'intelio' }, { id: 'prc' }]).map((agent) => agent.id), ['intelio', 'prc', 'hhp', 'arlp']);
});

test('home feed: recent work across agents, active missions, continue cards from evidence only', () => {
  const agents = [{ id: 'intelio' }, { id: 'prc' }, { id: 'hhp' }];
  const sessions = [
    { id: 'a', profileId: 'prc', title: 'SAMPLE DATA Launch', last_active: secs(NOW - 30 * 60 * 1000) },
    { id: 'b', profileId: 'hhp', title: 'SAMPLE DATA Renewal', last_active: secs(NOW - 2 * 3600 * 1000), preview: 'Drafted a note.' },
    { id: 'c', profileId: 'intelio', title: 'SAMPLE DATA Old', last_active: secs(NOW - 9 * 86400 * 1000) },
    { id: 'a', profileId: 'prc', title: 'duplicate row' },
  ];
  const recent = Feed.recentWork(sessions, { agents, now: NOW });
  assert.deepEqual(recent.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(recent[0].agent, 'PRC');
  assert.equal(recent[0].when, '30m ago');

  const byId = { a: Missions.deriveMission(sessions[0], transcript(), { now: NOW }) };
  const active = Feed.activeMissions(sessions, { byId, now: NOW });
  assert.deepEqual(active.map((mission) => mission.id), ['a', 'b']);
  assert.equal(active[0].status, 'open');

  const cards = Feed.continueCards({ sessions, byId, agents, now: NOW });
  assert.equal(cards.length, 1, 'only the session with real open to-dos is a card');
  assert.match(cards[0].reason, /1 of 3 to-dos done · next: Draft the checklist/);

  const fallback = Feed.continueCards({ sessions, byId: {}, agents, now: NOW });
  assert.deepEqual(fallback.map((card) => card.reason), ['Your last conversation']);
  assert.deepEqual(Feed.continueCards({ sessions: [sessions[2]], agents, now: NOW }), [], 'nothing older than three days is offered');
});

test('continue: connector items need a machine and a path, and the stub offers nothing', async () => {
  const connector = {
    files: [{ machine: 'Mac', path: '/Users/sample/deck.key', modifiedAt: new Date(NOW - 60000).toISOString() }, { path: '/no/machine.txt' }],
    repos: [{ machine: 'Mac', path: '/Users/sample/alans-way', branch: 'main', changed: 3, modifiedAt: NOW - 120000 }, { machine: 'Mac', path: '/clean', changed: 0 }],
  };
  const cards = Feed.continueCards({ sessions: [], connector, now: NOW });
  assert.deepEqual(cards.map((card) => card.kind), ['file', 'repo']);
  assert.match(cards[1].reason, /3 uncommitted changes on Mac/);
  const sources = Feed.createContinueSources();
  assert.equal(sources.has('computer'), false);
  assert.deepEqual(await sources.collect(), { files: [], repos: [] });
  sources.register('computer', { recentFiles: async () => connector.files, gitStatus: async () => { throw new Error('offline'); } });
  assert.equal(sources.has('computer'), true);
  const got = await sources.collect({ timeoutMs: 200 });
  assert.equal(got.files.length, 2);
  assert.deepEqual(got.repos, []);
});
