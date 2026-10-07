/** Call python -m intelio_harness. A non-zero exit is never treated as a loaded profile. */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { redact, safetyDefaults } = require('./safety.cjs');
const { resolveRepoRoot } = require('./paths.cjs');

const repoRoot = resolveRepoRoot();

function profileFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const index = args.indexOf('--profile');
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('-')) return path.resolve(args[index + 1]);
  const inline = args.find((item) => item.startsWith('--profile='));
  if (inline) return path.resolve(inline.slice('--profile='.length));
  return '';
}

function resolveProfileDir({ argv = process.argv, prefs, repo = repoRoot } = {}) {
  const fromArg = profileFromArgv(argv);
  if (fromArg) return { dir: fromArg, source: 'argv' };
  const saved = typeof prefs?.intelioProfile === 'string' ? prefs.intelioProfile.trim() : '';
  if (saved) return { dir: path.resolve(saved), source: 'settings' };
  if (process.env.INTELIO_PROFILE) return { dir: path.resolve(process.env.INTELIO_PROFILE), source: 'env' };
  return { dir: path.join(repo, 'intelio', 'profiles', 'example'), source: 'default' };
}

function failure(message, extra = {}) {
  return {
    ok: false,
    error: redact(message).slice(0, 300) || 'Intelio profile failed to load.',
    browsingOrigins: [],
    safety: safetyDefaults(null),
    public: {
      ok: false,
      error: redact(message).slice(0, 300) || 'Intelio profile failed to load.',
      source: extra.source || '',
      profileDir: extra.profileDir || '',
      profileName: '',
      panels: [],
      skills: [],
      allowedFolders: [],
      hermesProfile: '',
      launchArgv: [],
      browsingOrigins: [],
      safety: safetyDefaults(null),
      brand: fallbackBrand(),
      hermes: { present: false, commandOk: false, match: 'unavailable', version: null, commit: null, pinCommit: '', error: '', probeArgv: [], summary: 'profile not loaded' },
      attribution: "Alan's Way by Alex Hansen. Hermes Agent by Nous Research.",
      pinVerifiedOn: '',
      secretsFilePresent: false,
    },
  };
}

function displayTitle(raw) {
  const title = String(raw || '').trim();
  if (!title || title.toLowerCase() === 'intelio') return 'Intelio';
  return title;
}

function fallbackBrand() {
  const titlePath = path.join(repoRoot, 'intelio', 'vendor', 'intelio-harness', 'brand', 'window-title.txt');
  let windowTitle = 'Intelio';
  try {
    const title = fs.readFileSync(titlePath, 'utf8').trim();
    if (title && title.length <= 40) windowTitle = displayTitle(title);
  } catch { /* the loader error stays the source of truth */ }
  return { windowTitle, tokens: { background: '#0a0a0a', foreground: '#ffffff', surface: '#f5f5f5', line: '#e5e5e5', font: 'Geist' }, mark: '' };
}

function toSession(report, source) {
  const safety = report.safety || {};
  if (safety.yolo === true || safety.consequential !== 'ask' || safety.vault_blind !== true) {
    return failure('Intelio safety defaults were not intact.');
  }
  const brand = report.brand || {};
  const hermes = report.hermes || {};
  const profile = report.profile || {};
  const mark = typeof brand.icon_svg === 'string' && brand.icon_svg.startsWith('<svg') && !brand.icon_svg.toLowerCase().includes('<script')
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(brand.icon_svg)}` : '';
  const enforced = safetyDefaults({ yolo: safety.yolo, consequential: safety.consequential });
  const publicState = {
    ok: true,
    error: '',
    source,
    profileDir: report.profile_dir || '',
    profileName: profile.name || '',
    panels: profile.panels || [],
    skills: profile.skills || [],
    allowedFolders: profile.allowed_folders || [],
    hermesProfile: profile.hermes_profile || '',
    launchArgv: hermes.launch_argv || [],
    browsingOrigins: profile.browsing_origins || [],
    safety: enforced,
    brand: { windowTitle: displayTitle(brand.window_title || 'Intelio'), tokens: brand.tokens || fallbackBrand().tokens, mark },
    hermes: {
      present: hermes.present === true,
      commandOk: hermes.command_ok === true,
      match: hermes.match || 'unavailable',
      version: hermes.version || null,
      commit: hermes.commit || null,
      pinCommit: report.pin?.commit || '',
      error: redact(hermes.error || ''),
      probeArgv: hermes.probe_argv || [],
      summary: hermes.summary || 'unavailable',
      upstream: report.pin?.upstream || '',
    },
      attribution: report.attribution || "Alan's Way by Alex Hansen. Hermes Agent by Nous Research.",
      pinVerifiedOn: report.pin?.verified_on || '',
      secretsFilePresent: report.secrets_file_present === true,
    };
  return { ok: true, error: '', browsingOrigins: publicState.browsingOrigins, safety: enforced, public: publicState };
}

function loadIntelio({ argv = process.argv, prefs, profileDir, repo = repoRoot, python = process.env.INTELIO_PYTHON || 'python3' } = {}) {
  const resolved = profileDir ? { dir: path.resolve(profileDir), source: 'settings' } : resolveProfileDir({ argv, prefs, repo });
  const env = { ...process.env, PYTHONPATH: [
    path.join(repo, 'intelio', 'python'),
    path.join(repo, 'intelio', 'vendor', 'intelio-harness', 'src'),
    process.env.PYTHONPATH || '',
  ].filter(Boolean).join(path.delimiter), PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' };
  let result;
  try {
    // alans_way calls the real intelio_harness loader, then adds the fork sidecar.
    result = spawnSync(python, ['-m', 'alans_way', resolved.dir], {
      cwd: repo, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    return failure(`Intelio loader could not start. ${error.message}`, resolved);
  }
  if (!result || result.error) {
    const reason = result?.error?.code === 'ETIMEDOUT' ? 'Intelio loader timed out.' : 'Intelio loader could not start.';
    return failure(reason, resolved);
  }
  if (result.status !== 0) {
    const stderr = redact(result.stderr || '').trim();
    return failure(stderr || `Intelio loader exited ${result.status}.`, resolved);
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch { return failure('Intelio loader did not return a profile report.', resolved); }
  if (!report || report.ok !== true) return failure('Intelio loader did not return a profile report.', resolved);
  const session = toSession(report, resolved.source);
  if (!session.ok) return session;
  return session;
}

function publicIntelioState(session) {
  return session?.public || failure('Intelio profile has not been loaded.').public;
}

function pngIcon() {
  const svgPath = path.join(repoRoot, 'intelio', 'vendor', 'intelio-harness', 'brand', 'icon.svg');
  try {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const match = svg.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
    if (match && !/script|javascript:|onload=/i.test(svg)) {
      const embedded = Buffer.from(match[1], 'base64');
      if (embedded.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return embedded;
    }
  } catch { /* fall through to the generated mark */ }
  return generatedPng();
}

function generatedPng() {
  const zlib = require('node:zlib');
  const size = 64;
  const background = [0x0a, 0x0a, 0x0a, 0xff];
  const ink = [0xf5, 0xf5, 0xf5, 0xff];
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const bar = (y >= 14 && y < 19 && x >= 16 && x < 48) || (y >= 45 && y < 50 && x >= 16 && x < 48) || (x >= 30 && x < 35 && y >= 14 && y < 50);
      const pixel = bar ? ink : background;
      raw.set(pixel, row + 1 + x * 4);
    }
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

module.exports = { repoRoot, profileFromArgv, resolveProfileDir, loadIntelio, publicIntelioState, pngIcon, displayTitle };
