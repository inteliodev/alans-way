/** Canonical Intelio fork URLs. Docs and scripts keep these strings in step with intelio/forks.json. */

const fs = require('node:fs');
const path = require('node:path');
const { resolveRepoRoot } = require('./paths.cjs');

const file = path.join(resolveRepoRoot(), 'intelio', 'forks.json');
const forks = JSON.parse(fs.readFileSync(file, 'utf8'));

function githubRepo(value, key) {
  if (typeof value !== 'string' || !/^https:\/\/github.com\/inteliodev\/[a-z0-9][a-z0-9.-]*$/.test(value)) {
    throw new Error(`intelio/forks.json ${key} must be an https://github.com/inteliodev/ repository URL`);
  }
  return value;
}

const app = githubRepo(forks.app, 'app');
const agents = githubRepo(forks.agents, 'agents');
const agentsRaw = agents.replace('https://github.com/', 'https://raw.githubusercontent.com/');

module.exports = {
  app,
  agents,
  agentsSetup: `${agentsRaw}/main/setup.sh`,
  agentsSetupPrompt: `${agents}/blob/main/docs/setup-prompt.md`,
  agentsProactivity: `${agents}/blob/main/docs/proactivity.md`,
  agentsLicense: `${agents}/blob/main/LICENSE`,
  appIssues: `${app}/issues`,
};
