const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeProfile, readProfileFiles } = require('../src/intelio/agent-card.cjs');

function element(tag) {
  const node = {
    tag,
    className: '',
    textContent: '',
    title: '',
    hidden: false,
    isConnected: true,
    tabIndex: 0,
    dataset: {},
    style: {},
    attrs: {},
    children: [],
    disabled: false,
    value: '',
    width: 0,
    height: 0,
    classList: {
      hidden: false,
      contains(name) { return name === 'hidden' && this.hidden; },
      toggle(name, force) { if (name === 'hidden') this.hidden = force === undefined ? !this.hidden : Boolean(force); },
      add() {},
      remove() {},
    },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() {
      for (const fn of this.listeners.click || []) fn({ target: this, stopPropagation() {}, preventDefault() {} });
    },
    querySelector() { return null; },
  };
  return node;
}

function walk(node, found = []) {
  found.push(node);
  for (const child of node.children || []) walk(child, found);
  return found;
}

function installDom() {
  const nodes = new Map();
  function byId(id) {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  }
  globalThis.document = {
    getElementById: byId,
    createElement: element,
    createTextNode(text) { return { textContent: text, children: [] }; },
  };
  globalThis.window = globalThis;
  return { byId };
}

test('clicking the orb, a color, and an orb style updates the screen and the saved profile', async () => {
  installDom();
  require('../src/agent-card-ui.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-orb-'));
  const dir = path.join(root, 'intelio');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'model:\n  default: demo\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'intelio-card.json'), '{}\n', { mode: 0o600 });

  const host = element('div');
  let card = { id: 'intelio', name: 'intelio', title: 'Guide', color: '', orb: 'connecting', soul: 'Be brief.', phone: '', phoneLabel: '', email: '', computer: { status: 'stopped', label: 'Stopped' }, uses: [], thinking: 'auto', thinkingWritable: false, worksOn: 'cloud', routines: [], channels: [], phoneSoon: true, memory: '', paused: false, needsSignIn: false, gatewayNote: '', contact: 'intelio' };
  const actions = { picking: false, tab: 'details', orb: 'connecting' };
  const paint = () => {
    globalThis.IntelioAgentCard.mount(host, card, {
      ...actions,
      onPickColor() { actions.picking = !actions.picking; paint(); },
      onColor(color) {
        const saved = writeProfile(root, 'intelio', { color });
        assert.equal(saved.ok, true);
        card = { ...card, color: readProfileFiles(root, 'intelio').color };
        actions.picking = true;
        actions.orb = card.orb;
        paint();
      },
      onOrb(orb) {
        const saved = writeProfile(root, 'intelio', { orb });
        assert.equal(saved.ok, true);
        card = { ...card, orb: readProfileFiles(root, 'intelio').orb };
        actions.orb = card.orb;
        actions.picking = true;
        paint();
      },
    });
  };
  paint();
  const hit = walk(host).find((node) => node.className === 'orb-hit');
  assert.equal(hit.attrs['aria-label'], 'Change orb and color');
  assert.equal(walk(host).some((node) => node.className === 'orb-choice'), false);
  hit.click();
  const swatch = walk(host).find((node) => node.dataset.color === '#1d4ed8');
  const style = walk(host).find((node) => node.dataset.orb === 'listening' && node.className === 'orb-choice');
  assert.ok(swatch);
  assert.equal(style.attrs['aria-label'], 'Listening');
  swatch.click();
  style.click();
  const marker = JSON.parse(fs.readFileSync(path.join(dir, 'intelio-card.json'), 'utf8'));
  assert.equal(marker.color, '#1d4ed8');
  assert.equal(marker.orb, 'listening');
  const shown = walk(host).find((node) => node.className === 'agent-orb');
  assert.equal(shown.dataset.accent, '#1d4ed8');
  assert.equal(shown.dataset.orb, 'listening');
  const pressed = walk(host).find((node) => node.dataset.orb === 'listening' && node.className === 'orb-choice');
  assert.equal(pressed.attrs['aria-pressed'], 'true');

  const remote = require('../src/remote-main.js');
  await remote.mountSample({ agent: 'intelio' });
  remote.applyLook({ id: 'intelio', color: marker.color, orb: marker.orb, title: 'Guide', name: 'intelio' });
  const lead = walk(document.getElementById('lead-card')).find((node) => node.tag === 'canvas');
  assert.equal(lead.dataset.orb, 'listening');
  assert.equal(lead.dataset.accent, '#1d4ed8');
  const row = walk(document.getElementById('bot-list')).find((node) => node.tag === 'canvas');
  assert.equal(row.dataset.accent.length > 0, true);
  fs.rmSync(root, { recursive: true, force: true });
});
