/** Linux-only demo switches. Production Mac launches leave the sandbox on. */

function linuxDemoEnabled(env = process.env, platform = process.platform) {
  return platform === 'linux' && env.INTELIO_LINUX_DEMO === '1';
}

function applyLinuxDemo(app, env = process.env, platform = process.platform) {
  if (!linuxDemoEnabled(env, platform)) return false;
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-gpu');
  return true;
}

module.exports = { linuxDemoEnabled, applyLinuxDemo };
