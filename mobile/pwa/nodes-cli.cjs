#!/usr/bin/env node
'use strict';
/**
 * Operator CLI for enrolled intelio computers (VPS side).
 *
 *   node mobile/pwa/nodes-cli.cjs list [--all] [--json]
 *   node mobile/pwa/nodes-cli.cjs rename <name|id> <new name>
 *   node mobile/pwa/nodes-cli.cjs revoke <name|id>
 *
 * Edits ~/.config/intelio/nodes.json (INTELIO_NODES_FILE). The running relay
 * watches that file and disconnects a revoked computer within about a second.
 * Never prints device secrets (the registry only holds hashes).
 */
const { createNodeRegistry, defaultRegistryFile } = require('./nodes.cjs');

const USAGE = [
  'Usage:',
  '  nodes-cli.cjs list [--all] [--json]    enrolled computers (--all includes revoked)',
  '  nodes-cli.cjs rename <name|id> <name>  set the name agents use (pins it)',
  '  nodes-cli.cjs revoke <name|id>         disconnect and refuse this computer',
].join('\n');

function table(rows) {
  if (!rows.length) return 'No computers enrolled.';
  const cols = ['name', 'id', 'os', 'user', 'version', 'last_seen', 'state'];
  const cells = rows.map((d) => ({ ...d, state: d.revoked_at ? `revoked ${d.revoked_at}` : 'active' }));
  const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...cells.map((r) => String(r[c] || '').length))]));
  const line = (r) => cols.map((c) => String(r[c] || '').padEnd(width[c])).join('  ').trimEnd();
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), ...cells.map(line)].join('\n');
}

function run(argv, { env = process.env, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  const registry = createNodeRegistry({ file: defaultRegistryFile(env) });
  try {
    if (cmd === 'list') {
      const rows = registry.list({ includeRevoked: flags.has('--all') });
      out(flags.has('--json') ? JSON.stringify(rows, null, 2) : table(rows));
      return 0;
    }
    if (cmd === 'revoke' && args.length === 1) {
      const d = registry.revoke(args[0]);
      out(`Revoked ${d.name} (${d.id}). The relay disconnects it within a few seconds and refuses it from now on.`);
      return 0;
    }
    if (cmd === 'rename' && args.length >= 2) {
      const d = registry.rename(args[0], args.slice(1).join(' '));
      out(`Renamed ${d.id} to ${d.name}.`);
      return 0;
    }
  } catch (error) {
    err(String(error.message || error));
    return 1;
  }
  err(USAGE);
  return 2;
}

module.exports = { run, table };

if (require.main === module) process.exitCode = run(process.argv.slice(2));
