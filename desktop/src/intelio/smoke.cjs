'use strict';
/**
 * Packaged-app smoke check. Loads the main-process modules that must resolve
 * inside the asar and asserts a fresh Windows profile enters remote mode.
 */
const { signatureOf } = require('./orb-signature.cjs');
const { freshWindowPlan } = require('./preferences.cjs');
const { createRemoteMain, agentsFromKeys } = require('./remote-main-data.cjs');
const { keysFromImport } = require('./remote-hermes-main.cjs');

function runPackagedSmoke() {
  if (signatureOf('intelio') !== 'connecting' || signatureOf('hhp') !== 'weaving') return 1;
  if (typeof createRemoteMain !== 'function' || typeof keysFromImport !== 'function') return 1;
  const plan = freshWindowPlan({
    platform: 'win32',
    preferencesText: null,
    keyNames: ['intelio', 'prc', 'alignment', 'hhp'],
  });
  if (!plan.remote || plan.telegramSignIn || plan.agents.length !== 4) return 1;
  if (plan.host !== 'intelio-vps.tail9c1007.ts.net' || plan.port !== 8642 || plan.profile !== 'intelio') return 1;
  if (plan.desktop !== 'http://intelio-vps.tail9c1007.ts.net:6080/vnc.html') return 1;
  const orbs = plan.agents.map((agent) => agent.orb).join(',');
  if (orbs !== 'connecting,solving,searching,weaving') return 1;
  if (agentsFromKeys(['intelio'], 'intelio')[0].orb !== 'connecting') return 1;
  return 0;
}

module.exports = { runPackagedSmoke };
