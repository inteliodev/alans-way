'use strict';
/**
 * Install a skill from a pasted GitHub link into one Hermes profile, on the VPS.
 *
 * - Fetches only from api.github.com and raw.githubusercontent.com, with size,
 *   file-count and depth limits (desktop/src/intelio/skill-link.cjs LIMITS).
 * - preview() downloads into memory and returns the SKILL.md, the file list and
 *   the target folders. install() writes exactly what was previewed (by token).
 * - Writes go to ~/.hermes/profiles/<profile>/skills/<category>/<skill>/, the
 *   normal Hermes layout. It does not touch Hermes core, config.yaml, .env,
 *   auth.json, the skills hub lock file, or any other profile. Files are written
 *   0644 and nothing is executed. Hermes finds the new SKILL.md by itself (its
 *   skills manifest is rebuilt from SKILL.md signatures) on the agent's next session.
 * - Each install appends one line to <profile>/logs/intelio-skill-installs.jsonl.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const link = require('../../desktop/src/intelio/skill-link.cjs');

const API = 'https://api.github.com';
const RAW_HOST = 'raw.githubusercontent.com';
const TOKEN_RE = /^[a-f0-9]{32}$/;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PREVIEWS = 20;
const SKILL_MD_PREVIEW = 64 * 1024;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function createSkillInstaller({ fetchImpl = globalThis.fetch, profilesRoot, now = () => Date.now(), timeoutMs = 15000, randomToken = () => crypto.randomBytes(16).toString('hex') } = {}) {
  if (!profilesRoot) throw new Error('profilesRoot is required');
  const previews = new Map();

  function signal() {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  }

  async function githubJson(pathname) {
    let response;
    try {
      response = await fetchImpl(`${API}${pathname}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'intelio-skill-installer', 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error',
        signal: signal(),
      });
    } catch {
      throw httpError('Could not reach GitHub.', 502);
    }
    if (response.status === 404) throw httpError('GitHub has no public folder at that link.', 404);
    if (response.status === 403 || response.status === 429) throw httpError('GitHub is rate-limiting this server. Try again in a few minutes.', 429);
    if (!response.ok) throw httpError('GitHub did not answer that request.', 502);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw httpError('That folder listing is too large.', 413);
    try { return JSON.parse(text); } catch { throw httpError('GitHub sent something unexpected.', 502); }
  }

  async function rawBytes(downloadUrl) {
    let url;
    try { url = new URL(String(downloadUrl || '')); } catch { throw httpError('GitHub sent a bad download link.', 502); }
    if (url.protocol !== 'https:' || url.hostname !== RAW_HOST) throw httpError('GitHub sent a download link this installer does not use.', 502);
    let response;
    try {
      response = await fetchImpl(url.toString(), { headers: { 'User-Agent': 'intelio-skill-installer' }, redirect: 'error', signal: signal() });
    } catch {
      throw httpError('Could not download a file from GitHub.', 502);
    }
    if (!response.ok) throw httpError('Could not download a file from GitHub.', 502);
    const declared = Number(response.headers?.get?.('content-length')) || 0;
    if (declared > link.LIMITS.maxFileBytes) throw httpError('A file in that skill is too large.', 413);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > link.LIMITS.maxFileBytes) throw httpError('A file in that skill is too large.', 413);
    return bytes;
  }

  function contentsPath(parsed, dir, ref) {
    const encoded = dir ? `/${dir.split('/').map(encodeURIComponent).join('/')}` : '';
    return `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents${encoded}?ref=${encodeURIComponent(ref)}`;
  }

  /** Walk the folder through the contents API: files only, bounded depth and count. */
  async function listFiles(parsed, ref) {
    const out = [];
    const skipped = [];
    async function walk(dir, rel, depth) {
      const listing = await githubJson(contentsPath(parsed, dir, ref));
      if (!Array.isArray(listing)) throw httpError(depth === 0 ? 'That link points at a file, not a skill folder.' : 'That folder listing looked wrong.', 400);
      for (const entry of listing) {
        const name = String(entry?.name || '');
        const relPath = rel ? `${rel}/${name}` : name;
        if (!name || name.startsWith('.')) { if (name) skipped.push(relPath); continue; }
        if (entry.type === 'dir') {
          if (depth + 1 >= link.LIMITS.maxDepth) throw httpError('That skill folder is nested too deeply.', 400);
          await walk(dir ? `${dir}/${name}` : name, relPath, depth + 1);
        } else if (entry.type === 'file') {
          out.push({ path: relPath, size: Number(entry.size) || 0, downloadUrl: entry.download_url });
        } else {
          skipped.push(relPath);
        }
        if (out.length > link.LIMITS.maxFiles) throw httpError(`That skill has more than ${link.LIMITS.maxFiles} files.`, 413);
      }
    }
    await walk(parsed.dir, '', 0);
    return { files: out, skipped };
  }

  function profileDir(profile) {
    if (!link.validProfile(profile)) throw httpError('Unknown agent profile.', 404);
    const dir = path.join(profilesRoot, profile);
    if (!fs.existsSync(path.join(dir, 'config.yaml'))) throw httpError(`There is no "${profile}" agent on this server.`, 404);
    return dir;
  }

  function targetFor(profile, category, slug) {
    const home = profileDir(profile);
    const skillsRoot = path.join(home, 'skills');
    const realHome = fs.realpathSync(home);
    if (fs.existsSync(skillsRoot) && !fs.realpathSync(skillsRoot).startsWith(realHome + path.sep)) throw httpError('That agent\'s skills folder is not inside its profile.', 409);
    const categoryDir = path.join(skillsRoot, category);
    const dir = path.join(categoryDir, slug);
    const display = `~/.hermes/profiles/${profile}/skills/${category}/${slug}/`;
    if (fs.existsSync(path.join(categoryDir, 'SKILL.md'))) throw httpError(`"${category}" is a skill, not a category. Pick another category.`, 409);
    if (fs.existsSync(categoryDir) && fs.lstatSync(categoryDir).isSymbolicLink()) throw httpError(`"${category}" is a link. Pick another category.`, 409);
    let exists = false;
    if (fs.existsSync(dir)) {
      if (fs.lstatSync(dir).isSymbolicLink()) throw httpError('That skill folder is a link; it will not be replaced.', 409);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw httpError(`${display} already holds other skills. Pick another name or category.`, 409);
      exists = true;
    }
    return { home, skillsRoot, categoryDir, dir, display, exists };
  }

  function sweep() {
    const at = now();
    for (const [token, item] of previews) if (at - item.at > PREVIEW_TTL_MS) previews.delete(token);
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
  }

  /** Download into memory and describe what would be installed. Writes nothing. */
  async function preview({ url, profiles = [], category = '' } = {}) {
    const parsed = link.parseSkillUrl(url);
    if (!parsed.ok) throw httpError(parsed.error, 400);
    let ref = parsed.ref;
    if (!ref) {
      const repo = await githubJson(`/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`);
      ref = String(repo?.default_branch || '');
      if (!ref) throw httpError('Could not find that repository\'s default branch.', 502);
    }
    const { files: listed, skipped } = await listFiles(parsed, ref);
    const checked = link.checkFiles(listed);
    if (!checked.ok) throw httpError(checked.error, 400);
    const bytes = new Map();
    let total = 0;
    for (const file of listed) {
      const body = await rawBytes(file.downloadUrl);
      total += body.length;
      if (total > link.LIMITS.maxTotalBytes) throw httpError('That skill is too large.', 413);
      bytes.set(file.path, body);
    }
    const skillFile = checked.files.find((file) => file.kind === 'skill');
    const skillText = bytes.get(skillFile.path).toString('utf8');
    const fallbackName = parsed.dir ? parsed.dir.split('/').pop() : parsed.repo;
    const skill = link.describeSkill(skillText, { fallbackName });
    if (!skill.ok) throw httpError('That SKILL.md has no usable name.', 400);
    const chosen = link.validCategory(category) ? category : (skill.category || link.DEFAULT_CATEGORY);
    const targets = link.planTargets({ profiles, category: chosen, slug: skill.slug }).map((plan) => {
      if (!plan.ok) return plan;
      try {
        const target = targetFor(plan.profile, chosen, skill.slug);
        return { ...plan, dir: target.display, exists: target.exists };
      } catch (error) {
        return { ...plan, ok: false, error: error.message };
      }
    });
    sweep();
    const token = randomToken();
    const digest = crypto.createHash('sha256');
    for (const file of checked.files) digest.update(file.path).update('\0').update(bytes.get(file.path));
    previews.set(token, { at: now(), parsed, ref, skill, category: chosen, files: checked.files, bytes, hash: digest.digest('hex').slice(0, 16) });
    return {
      token,
      source: { display: `github.com/${parsed.owner}/${parsed.repo}@${ref}${parsed.dir ? `/${parsed.dir}` : ''}`, owner: parsed.owner, repo: parsed.repo, ref, dir: parsed.dir },
      skill: { name: skill.name, slug: skill.slug, description: skill.description, version: skill.version, category: chosen },
      skillMd: skillText.length > SKILL_MD_PREVIEW ? `${skillText.slice(0, SKILL_MD_PREVIEW)}\n…` : skillText,
      files: checked.files,
      totalBytes: checked.total,
      warnings: [...checked.warnings, ...(skipped.length ? [`Skipped ${skipped.length} hidden or linked item${skipped.length === 1 ? '' : 's'} (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''}).`] : [])],
      targets,
      hash: previews.get(token).hash,
      expiresInSec: Math.round(PREVIEW_TTL_MS / 1000),
    };
  }

  function writeTree(dest, item) {
    fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
    const realDest = fs.realpathSync(dest);
    for (const file of item.files) {
      if (!link.safeRelPath(file.path)) throw httpError(`"${file.path}" is not a path a skill can use.`, 400);
      const target = path.resolve(dest, ...file.path.split('/'));
      if (!target.startsWith(realDest + path.sep) && !target.startsWith(dest + path.sep)) throw httpError('A file tried to leave the skill folder.', 400);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, item.bytes.get(file.path), { mode: 0o644, flag: 'wx' });
    }
  }

  function logInstall(home, entry) {
    try {
      const dir = path.join(home, 'logs');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, 'intelio-skill-installs.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* the install stands even if the log line could not be written */ }
  }

  /** Write a previewed skill into one profile. `overwrite` moves the old copy to <profile>/backups/skills/. */
  async function install({ token, profile, overwrite = false } = {}) {
    sweep();
    const key = String(token || '');
    const item = TOKEN_RE.test(key) ? previews.get(key) : null;
    if (!item) throw httpError('That preview expired. Paste the link again.', 410);
    const id = String(profile || '').trim().toLowerCase();
    const target = targetFor(id, item.category, item.skill.slug);
    if (target.exists && overwrite !== true) throw httpError(`${item.skill.slug} is already installed for ${id}. Choose Replace to update it.`, 409);
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const staging = path.join(target.home, 'cache', `intelio-skill-${stamp}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      writeTree(staging, item);
      fs.mkdirSync(target.categoryDir, { recursive: true, mode: 0o755 });
      let backup = '';
      if (target.exists) {
        const backups = path.join(target.home, 'backups', 'skills');
        fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
        backup = path.join(backups, `${item.skill.slug}-${stamp}`);
        fs.renameSync(target.dir, backup);
      }
      try {
        fs.renameSync(staging, target.dir);
      } catch (error) {
        if (backup) fs.renameSync(backup, target.dir);
        throw error;
      }
      logInstall(target.home, { at: new Date(now()).toISOString(), profile: id, skill: item.skill.slug, category: item.category, source: `github.com/${item.parsed.owner}/${item.parsed.repo}@${item.ref}${item.parsed.dir ? `/${item.parsed.dir}` : ''}`, hash: item.hash, files: item.files.length, replaced: Boolean(backup) });
      return { ok: true, profile: id, skill: item.skill.slug, dir: target.display, files: item.files.map((file) => file.path), replaced: Boolean(backup), note: 'The agent picks it up in its next new session.' };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  return { preview, install, _previews: previews };
}

module.exports = { createSkillInstaller, PREVIEW_TTL_MS };
