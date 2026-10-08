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
 * - commands carry INTELIO_AGENT=intelio-cloud, so the VPS push guard
 *   (alans-way-agents push-approval) treats them as an agent's. A push the
 *   relay got Hayden's OK for runs with a one-time guard grant (mintPushGrant).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExecutors, osLabel } = require('../../desktop/src/intelio/node/executors.cjs');

const SECRETISH = /(?:^INTELIO_|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;

function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRETISH.test(k)) out[k] = v;
  return out;
}

/** Same layout as push_guard.py (guard_dir / grants_dir). */
function pushGuardPaths(env = process.env, home = os.homedir()) {
  const config = String(env.XDG_CONFIG_HOME || '').trim() || path.join(home, '.config');
  const state = String(env.XDG_STATE_HOME || '').trim() || path.join(home, '.local', 'state');
  return { guard: path.join(config, 'intelio', 'push-guard'), grants: path.join(state, 'intelio', 'push-grants') };
}

/**
 * One-time grant for the VPS push guard, written after Hayden allowed this
 * command through the relay. Same record push_guard.py mint_grant writes
 * (0600 file, 15 minutes, uses = pushes in the command). Returns the id, or ''
 * when the guard is not installed (nothing to satisfy).
 */
function mintPushGrant(command, { uses = 1, env = process.env, home = os.homedir(), now = Date.now() } = {}) {
  const { guard, grants } = pushGuardPaths(env, home);
  if (!fs.existsSync(path.join(guard, 'push_guard.py'))) return '';
  fs.mkdirSync(grants, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(grants, 0o700); } catch { /* not ours to fix */ }
  const id = crypto.randomBytes(16).toString('hex');
  const t = now / 1000;
  const record = {
    id, created: t, expires: t + 900, uses: Math.max(1, Math.min(Number(uses) || 1, 20)),
    command_sha256: crypto.createHash('sha256').update(String(command)).digest('hex'), by: 'intelio-relay',
  };
  const fd = fs.openSync(path.join(grants, `${id}.json`), 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
  return id;
}

function cloudEnabled(env = process.env) {
  return String(env.INTELIO_NODES_CLOUD || '').trim() !== '0';
}

function createCloudComputer({ env = process.env, home = os.homedir(), name = String(env.INTELIO_NODES_CLOUD_NAME || '').trim() || 'cloud', version = '' } = {}) {
  const clean = { ...childEnv(env), INTELIO_AGENT: 'intelio-cloud' };
  const executors = createExecutors({
    home,
    env: clean,
    approvedPushEnv: ({ command, pushes }) => {
      const grant = mintPushGrant(command, { uses: pushes.length, env, home });
      return grant ? { INTELIO_PUSH_GRANT: grant } : {};
    },
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

module.exports = { createCloudComputer, cloudEnabled, childEnv, SECRETISH, mintPushGrant, pushGuardPaths };
