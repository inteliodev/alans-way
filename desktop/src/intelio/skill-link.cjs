/**
 * Install a skill by pasting a link: the pure half, shared by the desktop, the
 * web app and the VPS server. It checks the link (github.com only), reads the
 * SKILL.md front matter, sorts the files into kinds, and says where each one
 * will land in Hermes's normal layout:
 *   ~/.hermes/profiles/<profile>/skills/<category>/<skill>/SKILL.md
 * Nothing here downloads, writes or runs anything.
 */
(function intelioSkillLink(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioSkillLink = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioSkillLinkFactory() {
  const LIMITS = Object.freeze({
    maxFiles: 60,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 1536 * 1024,
    maxDepth: 4,
    maxUrlLength: 600,
  });
  const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
  const SEGMENT_RE = /^[A-Za-z0-9_.@+-][A-Za-z0-9 _.@+()-]{0,199}$/;
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  const PROFILE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
  const DEFAULT_CATEGORY = 'installed';
  const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'html', 'htm', 'css', 'xml', 'ini', 'cfg', 'conf', 'j2', 'jinja', 'tmpl', 'template', 'svg', 'sql', 'graphql', 'env.example']);
  const SCRIPT_EXT = new Set(['py', 'sh', 'bash', 'zsh', 'js', 'mjs', 'cjs', 'ts', 'rb', 'pl', 'ps1', 'bat', 'cmd', 'lua', 'go', 'rs', 'swift', 'applescript', 'scpt']);
  const ASSET_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf']);
  const RESERVED_DIRS = new Set(['.hub', '.git', '.github', 'node_modules', '__pycache__', '.curator_backups', '.locks']);

  function fail(message) { return { ok: false, error: message }; }

  function cleanSegment(raw) {
    let part;
    try { part = decodeURIComponent(raw); } catch { return null; }
    if (!part || part === '.' || part === '..' || !SEGMENT_RE.test(part)) return null;
    return part;
  }

  /**
   * Accepts:
   *   https://github.com/<owner>/<repo>                       (SKILL.md at the root)
   *   https://github.com/<owner>/<repo>/tree/<ref>/<path>     (a skill folder)
   *   https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md
   * The ref is one path segment (a branch, tag or commit without slashes).
   */
  function parseSkillUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return fail('Paste a GitHub link to a skill folder.');
    if (raw.length > LIMITS.maxUrlLength) return fail('That link is too long.');
    // URL() would quietly resolve ./ and ../, so refuse them before parsing.
    const pathPart = raw.replace(/^[a-z]+:\/\/[^/]*/i, '').split(/[?#]/)[0];
    if (/(^|\/)\.{1,2}(\/|$)|%2e|%2f|\\/i.test(pathPart)) return fail('That folder path looks wrong.');
    let url;
    try { url = new URL(raw); } catch { return fail('That is not a link. Paste a github.com address.'); }
    if (url.protocol !== 'https:') return fail('Use an https://github.com link.');
    const host = url.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return fail('Only github.com links can be installed.');
    if (url.username || url.password || url.port) return fail('Use a plain github.com link.');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return fail('Link to a repository or a skill folder in it.');
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || owner.startsWith('.') || repo.startsWith('.')) return fail('That GitHub owner or repository name looks wrong.');
    let ref = '';
    let rest = [];
    if (parts.length > 2) {
      const mode = parts[2];
      if (mode !== 'tree' && mode !== 'blob') return fail('Link to a folder (…/tree/…) or a SKILL.md (…/blob/…).');
      if (parts.length < 4) return fail('That link is missing the branch.');
      ref = cleanSegment(parts[3]);
      if (!ref) return fail('That branch name looks wrong.');
      rest = parts.slice(4).map(cleanSegment);
      if (rest.some((part) => !part)) return fail('That folder path looks wrong.');
      if (mode === 'blob') {
        const file = rest[rest.length - 1] || '';
        if (file.toLowerCase() !== 'skill.md') return fail('Link to the skill folder or to its SKILL.md.');
        rest = rest.slice(0, -1);
      }
    }
    if (rest.some((part) => RESERVED_DIRS.has(part.toLowerCase()))) return fail('That folder cannot be installed.');
    const dir = rest.join('/');
    const display = `github.com/${owner}/${repo}${ref ? `@${ref}` : ''}${dir ? `/${dir}` : ''}`;
    return { ok: true, owner, repo, ref, dir, display, url: `https://github.com/${owner}/${repo}${ref ? `/tree/${encodeURIComponent(ref)}` : ''}${dir ? `/${dir.split('/').map(encodeURIComponent).join('/')}` : ''}` };
  }

  function unquote(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
    return text;
  }

  /** The simple YAML front matter skills use: top-level `key: value`, folded `>`/`|` blocks, and metadata.hermes.category. */
  function parseFrontmatter(text) {
    const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source);
    if (!match) return { ok: false, fields: {}, body: source };
    const fields = {};
    const lines = match[1].split('\n');
    let category = '';
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const top = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (top) {
        const key = top[1].toLowerCase();
        let value = top[2];
        if (/^[>|][-+]?\s*$/.test(value)) {
          const block = [];
          while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) { i += 1; block.push(lines[i].trim()); }
          value = block.join(value.startsWith('>') ? ' ' : '\n').trim();
        }
        fields[key] = unquote(value);
        continue;
      }
      const nested = /^\s+category:\s*(.+)$/.exec(line);
      if (nested && !category) category = unquote(nested[1]);
    }
    if (category) fields['metadata.category'] = category;
    return { ok: true, fields, body: match[2] };
  }

  /** "My Skill!" -> "my-skill" */
  function slugify(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  }

  function validCategory(value) { return SLUG_RE.test(String(value || '')); }
  function validProfile(value) { return PROFILE_RE.test(String(value || '')) && value !== 'default'; }

  /** What a SKILL.md says about itself. */
  function describeSkill(text, { fallbackName = '' } = {}) {
    const parsed = parseFrontmatter(text);
    const name = String(parsed.fields.name || fallbackName || '').trim();
    const slug = slugify(name || fallbackName);
    const category = slugify(parsed.fields['metadata.category'] || parsed.fields.category || '');
    return {
      ok: Boolean(slug),
      name: name || slug,
      slug,
      description: String(parsed.fields.description || '').replace(/\s+/g, ' ').trim().slice(0, 400),
      version: String(parsed.fields.version || '').slice(0, 40),
      category: validCategory(category) ? category : '',
      hasFrontmatter: parsed.ok,
    };
  }

  function extOf(path) {
    const name = String(path || '').split('/').pop().toLowerCase();
    if (name.endsWith('.env.example')) return 'env.example';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1) : '';
  }

  /**
   * 'skill' | 'doc' | 'script' | 'asset' | 'blocked'. Scripts are copied as
   * plain files (never made executable, never run); they are flagged so you can
   * read them first. Anything else (archives, binaries) is refused.
   */
  function classifyFile(path) {
    const rel = String(path || '');
    const name = rel.split('/').pop();
    if (rel.toLowerCase() === 'skill.md') return 'skill';
    const ext = extOf(rel);
    if (!ext && /^(license|licence|readme|notice|changelog|authors)$/i.test(name)) return 'doc';
    if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'doc';
    if (SCRIPT_EXT.has(ext)) return 'script';
    if (TEXT_EXT.has(ext)) return 'doc';
    if (ASSET_EXT.has(ext)) return 'asset';
    return 'blocked';
  }

  /** A relative path inside the skill: forward slashes, no dot segments, no hidden files. */
  function safeRelPath(path) {
    const parts = String(path || '').split('/');
    if (!parts.length || parts.length > LIMITS.maxDepth + 1) return false;
    return parts.every((part) => SEGMENT_RE.test(part) && !part.startsWith('.') && !RESERVED_DIRS.has(part.toLowerCase()));
  }

  /**
   * Check a file list ({ path, size }) against the limits. Returns
   * { ok, files (with kind), warnings, error }.
   */
  function checkFiles(list) {
    const files = [];
    const warnings = [];
    let total = 0;
    for (const item of Array.isArray(list) ? list : []) {
      const path = String(item?.path || '');
      const size = Number(item?.size) || 0;
      if (!safeRelPath(path)) return fail(`"${path}" is not a path a skill can use.`);
      const kind = classifyFile(path);
      if (kind === 'blocked') return fail(`"${path}" is not a text, script or image file, so this skill can't be installed.`);
      if (size > LIMITS.maxFileBytes) return fail(`"${path}" is larger than ${Math.round(LIMITS.maxFileBytes / 1024)} KB.`);
      total += size;
      files.push({ path, size, kind });
    }
    if (!files.some((file) => file.kind === 'skill')) return fail('There is no SKILL.md in that folder.');
    if (files.length > LIMITS.maxFiles) return fail(`That skill has more than ${LIMITS.maxFiles} files.`);
    if (total > LIMITS.maxTotalBytes) return fail(`That skill is larger than ${Math.round(LIMITS.maxTotalBytes / 1024)} KB.`);
    const scripts = files.filter((file) => file.kind === 'script');
    if (scripts.length) warnings.push(`${scripts.length} script${scripts.length === 1 ? '' : 's'} included (${scripts.slice(0, 3).map((file) => file.path).join(', ')}${scripts.length > 3 ? '…' : ''}). They are copied as plain files and not run. The agent may run them later when it uses the skill, so read them first.`);
    files.sort((a, b) => (a.kind === 'skill' ? -1 : b.kind === 'skill' ? 1 : a.path.localeCompare(b.path)));
    return { ok: true, files, total, warnings };
  }

  /** Where the skill lands for each profile, shown before anything is written. */
  function planTargets({ profiles = [], category = DEFAULT_CATEGORY, slug = '', root = '~/.hermes/profiles' } = {}) {
    const cat = validCategory(category) ? category : DEFAULT_CATEGORY;
    return (Array.isArray(profiles) ? profiles : []).map((profile) => {
      const id = String(profile || '').trim().toLowerCase();
      if (!validProfile(id)) return { profile: id, ok: false, error: 'Unknown agent profile.' };
      if (!SLUG_RE.test(slug)) return { profile: id, ok: false, error: 'The skill has no usable name.' };
      return { profile: id, ok: true, category: cat, slug, dir: `${root}/${id}/skills/${cat}/${slug}/` };
    });
  }

  return {
    LIMITS, DEFAULT_CATEGORY, parseSkillUrl, parseFrontmatter, describeSkill, slugify, classifyFile,
    safeRelPath, checkFiles, planTargets, validCategory, validProfile,
  };
});
