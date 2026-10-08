'use strict';
/**
 * Detects commands that ask the OS for administrator rights. The node never
 * elevates; such commands are refused unless the person at the computer
 * approves a native dialog (and even then the OS shows its own UAC/sudo prompt).
 *
 * Checked on every OS: Windows 11 has sudo, macOS/Linux can call pwsh, etc.
 * Detection is deliberately broad and errs toward asking.
 */

// A word in command position: start, after a separator, after `$(`/backtick,
// or after a wrapper such as env/exec/nohup/xargs/time/command/nice.
const CMD_START = String.raw`(?:^|[;&|\n\r({\x60]|\$\()\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|env|exec|nohup|xargs|time|command|nice|builtin|-\S+)\s+)*`;

const PROGRAMS = [
  ['sudo', 'sudo'],
  ['doas', 'doas'],
  ['pkexec', 'pkexec'],
  ['su', 'su'],
  ['gksudo', 'gksudo'],
  ['kdesudo', 'kdesudo'],
  ['runuser', 'runuser'],
  ['gsudo', 'gsudo'],
  ['runas', 'runas'],
];

const RULES = [
  ...PROGRAMS.map(([prog, label]) => ({
    re: new RegExp(`${CMD_START}(?:\\S*[\\\\/])?${prog}(?:\\.exe)?(?=\\s|$|[;&|)])`, 'i'),
    reason: `${label} asks for administrator rights`,
  })),
  { re: /-Verb\s*:?\s*['"]?RunAs\b/i, reason: 'Start-Process -Verb RunAs asks for administrator rights' },
  { re: /\bShellExecute(?:Ex)?\b[^\n]*['"]runas['"]/i, reason: 'ShellExecute "runas" asks for administrator rights' },
  { re: /\bwith\s+administrator\s+privileges\b/i, reason: 'osascript "with administrator privileges" asks for an administrator password' },
  { re: /\bAuthorizationExecuteWithPrivileges\b/, reason: 'AuthorizationExecuteWithPrivileges asks for an administrator password' },
  { re: /\bStart-Process\b[^\n]*['"]runas['"]/i, reason: 'Start-Process runas asks for administrator rights' },
];

/** Returns { elevates: false } or { elevates: true, reason }. */
function detectElevation(command) {
  const text = String(command || '');
  for (const rule of RULES) {
    if (rule.re.test(text)) return { elevates: true, reason: rule.reason };
  }
  return { elevates: false };
}

/** Shell names that themselves are elevation tools (run_command's shell argument). */
function shellElevates(shell) {
  return /^(?:sudo|doas|pkexec|su|gsudo|runas)(?:\.exe)?$/i.test(String(shell || '').trim());
}

module.exports = { detectElevation, shellElevates };
