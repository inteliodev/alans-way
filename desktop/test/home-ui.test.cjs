const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const NEW_FILES = [
  'desktop/src/home-ui.js',
  'desktop/src/intelio/commands.cjs',
  'desktop/src/intelio/missions.cjs',
  'desktop/src/intelio/home-feed.cjs',
  'desktop/src/intelio/skill-link.cjs',
  'mobile/pwa/skills-install.cjs',
  'mobile/pwa/public/home-tab.js',
];

test('home, missions, command bar and skill files parse', () => {
  for (const rel of NEW_FILES) execFileSync(process.execPath, ['--check', path.join(repo, rel)]);
});

test('desktop page loads the home modules before renderer.js, with their stylesheet', () => {
  const html = read('desktop/src/index.html');
  assert.match(html, /<link rel="stylesheet" href="home\.css">/);
  const order = ['intelio/commands.cjs', 'intelio/missions.cjs', 'intelio/home-feed.cjs', 'intelio/skill-link.cjs', 'home-ui.js', 'renderer.js'].map((name) => html.indexOf(`<script src="${name}"></script>`));
  assert.ok(order.every((at) => at > 0), 'every script is on the page');
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'in this order');
  assert.ok(html.indexOf('<script src="remote-main.js"></script>') < order[4], 'home-ui.js loads after remote-main.js');
});

test('the web desktop can load the shared modules', () => {
  const server = read('mobile/pwa/server.cjs');
  for (const name of ['commands', 'missions', 'home-feed', 'skill-link']) assert.match(server, new RegExp(`'intelio/${name}\\.cjs'`));
  assert.match(server, /UI_CJS = new Set\(\[[^\]]*\.\.\.HOME_CJS\]\)/);
  assert.match(server, /'\/home-tab\.js': 'home-tab\.js'/);
});

test('small hooks in shared files: overlays hide native views, Cmd+K reaches the page, settings section', () => {
  const renderer = read('desktop/src/renderer.js');
  assert.match(renderer, /obscured: modalOpen \|\| Boolean\(window\.IntelioHome\?\.covers\?\.\(\)\)/);
  assert.match(renderer, /window\.intelioLayout = scheduleLayout;/);
  assert.match(renderer, /window\.IntelioHome\?\.appendSettings\?\.\(body\);/);
  assert.match(read('desktop/src/preload.cjs'), /onCommandBar: \(callback\) => \{ ipcRenderer\.on\('workspace:command-bar'/);
  assert.match(read('desktop/src/main.cjs'), /label: 'Command Bar', accelerator: 'CmdOrCtrl\+K', registerAccelerator: false, click: \(\) => win\?\.webContents\.send\('workspace:command-bar'\)/, 'the menu shows Ctrl+K but does not grab it from web pages in browser tabs');
  const remote = read('desktop/src/remote-main.js');
  assert.match(remote, /homeState, openListed, newChat, loadAllSessions,/);
  assert.match(remote, /root\.onIntelioSessions\(\)/);
});

test('home-ui uses the registry for every action and never invents cards', () => {
  const source = read('desktop/src/home-ui.js');
  assert.match(source, /root\.IntelioCommandRegistry = registry/);
  assert.match(source, /covers: \(\) =>/);
  assert.doesNotMatch(source, /Needs you/i);
  assert.doesNotMatch(read('mobile/pwa/public/home-tab.js'), /Needs you/i);
  assert.match(source, /Feed\.continueCards\(/);
  assert.match(source, /openAgentComputer/, 'opening a mission focuses the agent screen');
  assert.match(source, /command\('settings', \{ activeScreen: 0 \}\)/);
});

test('home styles come from theme variables: no yellow or lime, Blue supported', () => {
  for (const rel of ['desktop/src/home.css', 'mobile/pwa/public/home-tab.css']) {
    const body = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(body, /yellow|lime|#ff0\b|#ffff00|#cddc39|#c6ff00|#a3e635|#facc15|#eab308|#fde047/i, rel);
    const hexes = body.match(/#[0-9a-f]{3,8}\b/gi) || [];
    assert.ok(hexes.length <= 8, `${rel} keeps literal colors to theme fallbacks (${hexes.join(', ')})`);
  }
  const desktop = read('desktop/src/home.css');
  assert.match(desktop, /html\[data-theme="blue"\] \{ --ih-fg: var\(--text/);
  assert.match(desktop, /html\[data-theme="light"\]/);
});

test('phone PWA gets a Home tab with a Settings toggle', () => {
  const app = read('mobile/pwa/public/app.js');
  assert.match(app, /items\.unshift\(\['home', 'Home', 'home'\]\)/);
  assert.match(app, /state\.tab === 'home' && window\.IntelioPhoneHome\?\.enabled\(\)/);
  assert.match(app, /IntelioPhoneHome\.settingsRow/);
  const html = read('mobile/pwa/public/index.html');
  assert.ok(html.indexOf('/home-tab.js') > 0 && html.indexOf('/home-tab.js') < html.indexOf('/app.js'));
  assert.ok(html.indexOf('/ui/intelio/home-feed.cjs') < html.indexOf('/home-tab.js'));
});

test('adapted Herald OS code keeps its MIT notice', () => {
  const notice = read('THIRD_PARTY.md');
  assert.match(notice, /Herald OS/);
  assert.match(notice, /MIT License/);
  assert.match(notice, /Luke The Dev/);
  for (const rel of ['desktop/src/home-ui.js', 'desktop/src/home.css', 'desktop/src/intelio/commands.cjs', 'desktop/src/intelio/missions.cjs', 'desktop/src/intelio/home-feed.cjs', 'mobile/pwa/public/home-tab.js']) {
    assert.match(read(rel).slice(0, 1200), /Herald OS/, rel);
  }
});

test('Ctrl/Cmd+K is only taken in the intelio UI, never from an embedded browser', () => {
  const source = read('desktop/src/home-ui.js');
  assert.match(source, /if \(!commandBarKey\(event\) \|\| inEmbeddedBrowser\(event\)\) return;/);
  for (const sel of ['webview', 'iframe', 'canvas', '#screen', '.remote-preview-slot', '.browser-slot']) assert.ok(source.includes(sel), `embedded browser selector ${sel}`);
  assert.match(source, /\['light', 'blue', 'dark'\]\.map\(/, 'theme command lists Light, Blue, Dark');
  assert.match(source, /enum: \['light', 'blue', 'dark'\]/);
});
