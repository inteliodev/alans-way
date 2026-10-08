'use strict';
/**
 * Per-agent encrypted login vault. intelio harness only; Hermes core is not
 * touched and Hermes's own <profile>/vault/ directory is never read or written.
 *
 * Layout (v2):
 *   data  <home>/.local/share/intelio/vault/<agent>.vault   dir 0700, file 0600
 *         (INTELIO_VAULT_DIR overrides the directory)
 *   key   one 32-byte master key kept apart from the data, first found of:
 *         $CREDENTIALS_DIRECTORY/intelio-vault.key   (systemd credential)
 *         INTELIO_VAULT_KEY_FILE
 *         <home>/.config/intelio/keys/vault.key      dir 0700, file 0600
 *         or an injected masterKey() (the desktop app wraps it with the OS keychain).
 * Each agent gets its own AES-256-GCM key: HKDF-SHA256(master, info=agent).
 * The agent id is also the GCM additional data, so a file copied to another
 * agent does not open. Writes are atomic (temp file + rename).
 * A v1 file at <root>/<agent>/vault (key beside it) is migrated once and removed.
 * list(), listAll() and toolResult() never include a password or one-time code.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;

const FILL_SAVED_LOGIN_TOOL = {
  name: 'fill_saved_login',
  description: 'Fill a saved login for a site by domain. The secret stays in the profile vault and is not returned.',
  parameters: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] },
};

function profileSlug(id) {
  const name = String(id || '').trim().toLowerCase();
  if (!name || name === 'default' || !SLUG.test(name)) throw new Error('Unknown profile.');
  return name;
}

function profileIdsFromList(stdout) {
  const found = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const token = line.replace(/[*★]/g, ' ').trim().split(/\s+/)[0] || '';
    const slug = token.toLowerCase();
    if (!slug || slug === 'default' || !SLUG.test(slug) || found.includes(slug)) continue;
    found.push(slug);
  }
  return found;
}

function directoryProfiles(root, fsImpl = fs) {
  const found = [];
  try {
    for (const entry of fsImpl.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const slug = entry.name.toLowerCase();
      if (slug === 'default' || !SLUG.test(slug)) continue;
      found.push(slug);
    }
  } catch { /* no profile directory yet */ }
  return found;
}

function assertProfile(id, known) {
  const name = profileSlug(id);
  if (known && !known.has(name)) throw new Error('Unknown profile.');
  return name;
}

function normalizeDomain(site) {
  const host = String(site || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').replace(/[.:]+$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.includes('..')) throw new Error('Enter a site domain.');
  return host;
}

function domainsMatch(saved, site) {
  return saved === site || site.endsWith(`.${saved}`);
}

const POSIX = process.platform !== 'win32';
const KDF_SALT = Buffer.from('intelio-vault/v2');

function ensurePrivateDir(dir, fsImpl = fs) {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!POSIX) return;
  const stat = fsImpl.statSync(dir);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Vault folder is not owned by this user.');
  if (stat.mode & 0o077) fsImpl.chmodSync(dir, 0o700);
}

function writePrivate(file, data, fsImpl = fs) {
  ensurePrivateDir(path.dirname(file), fsImpl);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fsImpl.openSync(tmp, 'wx', 0o600);
  try {
    fsImpl.writeSync(fd, data);
    try { fsImpl.fsyncSync(fd); } catch { /* best effort */ }
  } finally {
    fsImpl.closeSync(fd);
  }
  try { fsImpl.chmodSync(tmp, 0o600); } catch { /* Windows ignores the mode bit */ }
  fsImpl.renameSync(tmp, file);
}

// Read a private file. A group/world-readable file is tightened to 0600; a
// file owned by someone else is refused.
function readPrivate(file, fsImpl = fs) {
  if (POSIX) {
    const stat = fsImpl.statSync(file);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Vault key is not owned by this user.');
    if (stat.mode & 0o077) fsImpl.chmodSync(file, 0o600);
  }
  return fsImpl.readFileSync(file);
}

function isFile(file, fsImpl = fs) {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function createVaultStore({
  root,
  profiles,
  credentialsDir,
  home,
  dataDir,
  keyFile,
  masterKey,
  env = process.env,
  now = () => Date.now(),
  fsImpl = fs,
} = {}) {
  if (!root) throw new Error('Vault root is required.');
  const homeDir = home || os.homedir();
  const dataRoot = path.resolve(dataDir || env.INTELIO_VAULT_DIR || path.join(homeDir, '.local', 'share', 'intelio', 'vault'));
  const keyPath = path.resolve(keyFile || env.INTELIO_VAULT_KEY_FILE || path.join(homeDir, '.config', 'intelio', 'keys', 'vault.key'));
  const credsDir = credentialsDir || env.CREDENTIALS_DIRECTORY || '';
  if (isInside(keyPath, dataRoot)) throw new Error('The vault key must not sit inside the vault data folder.');
  if (isInside(dataRoot, root) || isInside(keyPath, root)) throw new Error('The intelio vault must live outside the Hermes profiles folder.');
  let master = null;

  function knownIds() {
    const ids = new Set(directoryProfiles(root, fsImpl));
    const extra = typeof profiles === 'function' ? profiles() : profiles || [];
    for (const id of extra) {
      try { ids.add(profileSlug(id)); } catch { /* ignore a bad name from the lister */ }
    }
    return ids;
  }
  function id(profile) {
    return assertProfile(profile, knownIds());
  }
  function loadMaster() {
    if (master) return master;
    let key = null;
    if (typeof masterKey === 'function') key = masterKey();
    else if (masterKey) key = masterKey;
    if (!key && credsDir && isFile(path.join(credsDir, 'intelio-vault.key'), fsImpl)) {
      key = fsImpl.readFileSync(path.join(credsDir, 'intelio-vault.key'));
    }
    if (!key && isFile(keyPath, fsImpl)) key = readPrivate(keyPath, fsImpl);
    if (!key) {
      key = crypto.randomBytes(32);
      writePrivate(keyPath, key, fsImpl);
    }
    key = Buffer.from(key);
    if (key.length !== 32) throw new Error('Vault key is unusable.');
    master = key;
    return master;
  }
  function agentKey(profile) {
    return Buffer.from(crypto.hkdfSync('sha256', loadMaster(), KDF_SALT, Buffer.from(`login-vault:${profile}`), 32));
  }
  function aad(profile) {
    return Buffer.from(`intelio-vault:v2:${profile}`);
  }
  function dataFile(profile) {
    return path.join(dataRoot, `${profile}.vault`);
  }
  function decryptV2(profile, text) {
    const env2 = JSON.parse(text);
    if (!env2 || env2.v !== 2) throw new Error('Vault file is unreadable.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', agentKey(profile), Buffer.from(env2.iv, 'base64'));
    decipher.setAAD(aad(profile));
    decipher.setAuthTag(Buffer.from(env2.tag, 'base64'));
    const json = Buffer.concat([decipher.update(Buffer.from(env2.ct, 'base64')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json);
    return { logins: Array.isArray(parsed.logins) ? parsed.logins : [] };
  }
  function encryptV2(profile, data) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', agentKey(profile), iv);
    cipher.setAAD(aad(profile));
    const ct = Buffer.concat([cipher.update(JSON.stringify({ logins: data.logins }), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 2, alg: 'A256GCM', kdf: 'HKDF-SHA256', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') });
  }

  // v1: base64(iv|tag|ct) in a FILE at <root>/<agent>/vault, key beside it or
  // in $CREDENTIALS_DIRECTORY/vault.key.<agent>. A DIRECTORY at that path is
  // Hermes's own vault and is left alone.
  function legacyFiles(profile) {
    const file = path.join(root, profile, 'vault');
    if (!isFile(file, fsImpl)) return null;
    const cred = credsDir ? path.join(credsDir, `vault.key.${profile}`) : '';
    const key = cred && isFile(cred, fsImpl) ? cred : path.join(root, profile, 'vault.key');
    return { file, key, keyIsCredential: key === cred };
  }
  function readLegacy(legacy, profile) {
    const raw = Buffer.from(String(fsImpl.readFileSync(legacy.file, 'utf8')).trim(), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', fsImpl.readFileSync(legacy.key), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(profile));
    decipher.setAuthTag(raw.subarray(12, 28));
    const parsed = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    return Array.isArray(parsed.logins) ? parsed.logins : [];
  }
  function migrate(profile, data) {
    const legacy = legacyFiles(profile);
    if (!legacy || !isFile(legacy.key, fsImpl)) return data;
    let old;
    try { old = readLegacy(legacy, profile); } catch { return data; }
    const at = now();
    const have = new Set(data.logins.map((item) => item.domain));
    for (const item of old) {
      if (!item || !item.domain || have.has(item.domain)) continue;
      data.logins.push({ ...item, createdAt: item.createdAt || at, updatedAt: item.updatedAt || at, lastUsedAt: item.lastUsedAt || 0 });
    }
    save(profile, data);
    const check = decryptV2(profile, String(fsImpl.readFileSync(dataFile(profile), 'utf8')));
    if (check.logins.length >= data.logins.length) {
      try { fsImpl.rmSync(legacy.file, { force: true }); } catch { /* left for a later run */ }
      if (!legacy.keyIsCredential) { try { fsImpl.rmSync(legacy.key, { force: true }); } catch { /* left */ } }
    }
    return data;
  }
  function open(profile) {
    const file = dataFile(profile);
    let data = { logins: [] };
    if (isFile(file, fsImpl)) {
      readPrivate(file, fsImpl);
      data = decryptV2(profile, String(fsImpl.readFileSync(file, 'utf8')));
    }
    return migrate(profile, data);
  }
  function save(profile, data) {
    ensurePrivateDir(dataRoot, fsImpl);
    writePrivate(dataFile(profile), encryptV2(profile, data), fsImpl);
  }
  function match(profile, site) {
    const domain = normalizeDomain(site);
    const data = open(id(profile));
    return data.logins.find((item) => domainsMatch(item.domain, domain)) || null;
  }
  function publicRow(item) {
    return {
      domain: item.domain,
      username: item.username || '',
      createdAt: Number(item.createdAt) || 0,
      lastUsedAt: Number(item.lastUsedAt) || 0,
    };
  }

  return {
    saveLogin(profile, { domain, username, password, otp, selectors } = {}) {
      const agent = id(profile);
      const host = normalizeDomain(domain);
      const data = open(agent);
      const at = now();
      const prior = data.logins.find((item) => item.domain === host);
      const next = {
        domain: host,
        username: String(username || '').slice(0, 200),
        password: String(password || ''),
        otp: String(otp || ''),
        selectors: selectors && typeof selectors === 'object' ? {
          username: String(selectors.username || '').slice(0, 300),
          password: String(selectors.password || '').slice(0, 300),
          otp: String(selectors.otp || '').slice(0, 300),
        } : undefined,
        createdAt: prior?.createdAt || at,
        updatedAt: at,
        lastUsedAt: prior?.lastUsedAt || 0,
      };
      data.logins = data.logins.filter((item) => item.domain !== host);
      data.logins.push(next);
      save(agent, data);
      return { domain: host, username: next.username };
    },
    list(profile) {
      try {
        return open(id(profile)).logins.map(publicRow);
      } catch {
        return [];
      }
    },
    listAll() {
      const rows = [];
      for (const agent of [...knownIds()].sort()) {
        for (const row of this.list(agent)) rows.push({ ...row, profile: agent });
      }
      return rows;
    },
    has(profile, site) {
      try { return Boolean(match(profile, site)); } catch { return false; }
    },
    markUsed(profile, site) {
      try {
        const agent = id(profile);
        const domain = normalizeDomain(site);
        const data = open(agent);
        const hit = data.logins.find((item) => domainsMatch(item.domain, domain));
        if (!hit) return false;
        hit.lastUsedAt = now();
        save(agent, data);
        return true;
      } catch {
        return false;
      }
    },
    remove(profile, domain) {
      const agent = id(profile);
      const host = normalizeDomain(domain);
      const data = open(agent);
      data.logins = data.logins.filter((item) => item.domain !== host);
      save(agent, data);
      return this.list(agent);
    },
    toolResult(profile, site) {
      try {
        const hit = match(profile, site);
        if (!hit) return { ok: false, filled: false, domain: normalizeDomain(site) };
        return { ok: true, filled: true, domain: hit.domain, username: hit.username || '' };
      } catch {
        return { ok: false, filled: false };
      }
    },
    fillerPayload(profile, site) {
      const hit = match(profile, site);
      if (!hit) return null;
      return {
        domain: hit.domain,
        username: hit.username || '',
        password: hit.password || '',
        otp: hit.otp || '',
        selectors: hit.selectors || null,
      };
    },
    knownProfiles() {
      return [...knownIds()].sort();
    },
    // Where things live, for docs and the self-check. No secret material.
    describe() {
      return { dataDir: dataRoot, keyFile: credsDir && isFile(path.join(credsDir, 'intelio-vault.key'), fsImpl) ? 'systemd-credential' : (masterKey ? 'injected' : keyPath) };
    },
  };
}

module.exports = {
  FILL_SAVED_LOGIN_TOOL,
  createVaultStore,
  normalizeDomain,
  domainsMatch,
  assertProfile,
  profileSlug,
  profileIdsFromList,
  directoryProfiles,
};
