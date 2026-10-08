'use strict';
/**
 * The VPS itself as a computer agents can pick ("cloud"), served in-process by
 * the relay with the same executors a desktop node uses. It adds no authority:
 * Hermes agents already have a shell on this VPS as the same user. It lets an
 * agent address "cloud" with the same tools as a laptop, and gives the person
 * the same kill switch and audit trail for it.
 *
 * - runs as the relay's user; never elevates (no one is at the VPS to approve)
 * - commands get the relay's environment minus intelio settings and anything
 *   that looks like a credential
 * - INTELIO_NODES_CLOUD=0 turns it off; INTELIO_NODES_CLOUD_NAME renames it
 */
const os = require('node:os');
const { createExecutors, osLabel } = require('../../desktop/src/intelio/node/executors.cjs');

const SECRETISH = /(?:^INTELIO_|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;

function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRETISH.test(k)) out[k] = v;
  return out;
}

function cloudEnabled(env = process.env) {
  return String(env.INTELIO_NODES_CLOUD || '').trim() !== '0';
}

function createCloudComputer({ env = process.env, home = os.homedir(), name = String(env.INTELIO_NODES_CLOUD_NAME || '').trim() || 'cloud', version = '' } = {}) {
  const clean = childEnv(env);
  const executors = createExecutors({
    home,
    env: clean,
    confirmElevation: async () => false,
    screenshot: null,
    computerName: () => name,
  });
  let user = '';
  try { user = os.userInfo().username; } catch { user = ''; }
  const device = {
    id: 'cloud',
    name: name.slice(0, 64),
    aliases: ['cloud', 'vps', 'intelio-vps', os.hostname().toLowerCase()],
    os: osLabel(process.platform),
    arch: process.arch,
    user,
    version,
    note: 'The intelio VPS itself (same machine and user as your own terminal tool).',
  };
  return {
    device,
    executors,
    run: (tool, args, ctx) => executors.run(tool, args, ctx),
    close() {},
  };
}

module.exports = { createCloudComputer, cloudEnabled, childEnv, SECRETISH };
