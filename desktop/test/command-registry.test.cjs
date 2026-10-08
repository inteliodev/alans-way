const { test } = require('node:test');
const assert = require('node:assert/strict');
const Commands = require('../src/intelio/commands.cjs');

function registry() {
  const ran = [];
  const reg = Commands.createRegistry();
  reg.define([
    { id: 'home.open', title: 'Go home', group: 'Go to', tier: 'read', order: 1, phrases: ['go home'], run: () => { ran.push('home'); return Commands.ok('Home.'); } },
    {
      id: 'agent.switch', title: 'Switch agent', group: 'Agents', args: [{ name: 'agent', type: 'string', required: true }],
      phrases: ['switch to {agent}', 'talk to {agent}'],
      entries: () => ['intelio', 'prc'].map((id) => ({ key: id, title: `Switch to ${id === 'prc' ? 'PRC' : id}`, args: { agent: id } })),
      run: ({ agent }) => { ran.push(agent); return Commands.ok(`Switched to ${agent}.`); },
    },
    { id: 'screen.open', title: 'Open screen', args: [{ name: 'n', type: 'number', required: true, min: 1, max: 4 }], phrases: ['open screen {n}'], run: ({ n }) => Commands.ok(`Screen ${n}.`) },
    { id: 'theme.set', title: 'Set theme', args: [{ name: 'theme', type: 'string', required: true, enum: ['light', 'dark', 'blue'] }], run: ({ theme }) => Commands.ok(theme) },
    { id: 'agent.only', title: 'Agent-callable', sources: ['agent'], run: () => Commands.ok('agent') },
    { id: 'boom.now', title: 'Throws', run: () => { throw new Error('kaboom'); } },
  ]);
  return { reg, ran };
}

test('command ids must be dotted and runnable', () => {
  const reg = Commands.createRegistry();
  assert.throws(() => reg.define({ id: 'Bad', title: 'x', run: () => {} }), /invalid command/);
  assert.throws(() => reg.define({ id: 'ok.id', title: 'x' }), /invalid command/);
  assert.equal(Commands.ID_RE.test('session.search'), true);
});

test('the bar lists one row per entry and plain commands, and searches by words', () => {
  const { reg } = registry();
  const titles = reg.entries().map((row) => row.title);
  assert.ok(titles.includes('Go home'));
  assert.ok(titles.includes('Switch to PRC'));
  assert.ok(!titles.includes('Switch agent'), 'a command with required args only shows its entries');
  assert.ok(!titles.includes('Agent-callable'), 'agent-only commands stay out of the bar');
  assert.equal(reg.search('prc')[0].title, 'Switch to PRC');
  assert.equal(reg.search('go ho')[0].id, 'home.open');
  assert.deepEqual(reg.search('zzz'), []);
});

test('run validates args, never throws, and respects sources', async () => {
  const { reg, ran } = registry();
  assert.equal((await reg.run('agent.switch', { agent: 'prc' }, { source: 'palette' })).ok, true);
  assert.deepEqual(ran, ['prc']);
  assert.match((await reg.run('agent.switch', {}, { source: 'palette' })).error, /needs "agent"/);
  assert.match((await reg.run('screen.open', { n: 9 })).error, /at most 4/);
  assert.equal((await reg.run('screen.open', { n: '2' })).summary, 'Screen 2.');
  assert.equal((await reg.run('theme.set', { theme: 'BLUE' })).summary, 'blue');
  assert.match((await reg.run('theme.set', { theme: 'yellow' })).error, /one of light, dark, blue/);
  assert.match((await reg.run('home.open', { extra: 1 })).error, /unknown argument/);
  assert.match((await reg.run('boom.now')).error, /kaboom/);
  assert.match((await reg.run('nope.cmd')).error, /Unknown command/);
  assert.equal((await reg.run('agent.only', {}, { source: 'voice' })).ok, false, 'voice cannot run an agent-only command');
  assert.equal((await reg.run('home.open', {}, { source: 'agent' })).ok, false, 'agents need an explicit opt-in');
  assert.equal((await reg.run('agent.only', {}, { source: 'agent' })).ok, true);
  assert.equal(reg.log()[0].id, 'agent.only');
});

test('voice phrases map to the same commands and args', () => {
  const { reg } = registry();
  assert.deepEqual(reg.match('Switch to PRC'), { id: 'agent.switch', args: { agent: 'prc' } });
  assert.deepEqual(reg.match('open screen 3'), { id: 'screen.open', args: { n: '3' } });
  assert.deepEqual(reg.match('go home!'), { id: 'home.open', args: {} });
  assert.equal(reg.match('make me a sandwich'), null);
  assert.ok(reg.list({ source: 'voice' }).some((command) => command.id === 'screen.open'));
  assert.ok(!reg.list({ source: 'voice' }).some((command) => command.id === 'agent.only'));
});

test('the app registry has every command the bar promises', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/home-ui.js'), 'utf8');
  for (const id of ['agent.switch', 'chat.new', 'session.open', 'screen.open', 'theme.toggle', 'settings.open', 'skill.install', 'session.search', 'voice.start', 'home.open', 'missions.open', 'day.plan', 'mission.start']) {
    assert.match(source, new RegExp(`id: '${id.replace('.', '\\.')}'`), id);
  }
  assert.doesNotMatch(source, /sources: \[[^\]]*'agent'/, 'no app command is agent-callable yet');
});
