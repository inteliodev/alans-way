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

// Per-view sandbox stays on for Mac. On the Linux demo the Chromium zygote
// cannot map the renderer startup region (exit 5) unless sandbox is off here too.
function rendererSandbox(env = process.env, platform = process.platform) {
  return !linuxDemoEnabled(env, platform);
}

module.exports = { linuxDemoEnabled, applyLinuxDemo, rendererSandbox };
