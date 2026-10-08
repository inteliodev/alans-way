'use strict';
/**
 * Per-profile encrypted login vault. Intelio harness only.
 * Ciphertext lives at <root>/<profile>/vault (mode 0600). The key is a
 * separate 32-byte file. systemd user credentials win: when
 * CREDENTIALS_DIRECTORY is set, the key is vault.key.<profile> in that
 * directory (LoadCredentialEncrypted=vault.key.<profile>:...). Otherwise the
 * key is <root>/<profile>/vault.key, mode 0600.
 * AES-256-GCM uses the profile id as additional data, so a copied vault
 * does not open under another profile's key.
 * list() and toolResult() never include a password or one-time code.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
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

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows may ignore the mode bit */ }
}

function createVaultStore({ root, profiles, credentialsDir, fsImpl = fs } = {}) {
  if (!root) throw new Error('Vault root is required.');

  function knownIds() {
    const ids = new Set(directoryProfiles(root, fsImpl));
    const extra = typeof profiles === 'function' ? profiles() : profiles || [];
    for (const id of extra) {
      try { ids.add(profileSlug(id)); } catch { /* ignore a bad name from the lister */ }
    }
    return ids;
  }
  function dir(profile) {
    return path.join(root, assertProfile(profile, knownIds()));
  }
  function credentialKeyFile(profile) {
    const creds = credentialsDir || process.env.CREDENTIALS_DIRECTORY || '';
    if (!creds) return '';
    const file = path.join(creds, `vault.key.${profile}`);
    return fsImpl.existsSync(file) ? file : '';
  }
  function keyFile(profile) {
    return credentialKeyFile(profile) || path.join(dir(profile), 'vault.key');
  }
  function dataFile(profile) {
    return path.join(dir(profile), 'vault');
  }
  function loadKey(profile) {
    const fromCreds = credentialKeyFile(profile);
    const file = fromCreds || path.join(dir(profile), 'vault.key');
    if (fsImpl.existsSync(file)) {
      const key = fsImpl.readFileSync(file);
      if (key.length !== 32) throw new Error('Vault key is unusable.');
      return key;
    }
    if (fromCreds) throw new Error('Vault key is unusable.');
    const key = crypto.randomBytes(32);
    writePrivate(file, key);
    return key;
  }
  function open(profile) {
    const file = dataFile(profile);
    if (!fs.existsSync(file)) return { logins: [] };
    const raw = Buffer.from(String(fs.readFileSync(file, 'utf8')).trim(), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(profile), iv);
    decipher.setAAD(Buffer.from(assertProfile(profile, knownIds())));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json);
    return { logins: Array.isArray(parsed.logins) ? parsed.logins : [] };
  }
  function save(profile, data) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(profile), iv);
    cipher.setAAD(Buffer.from(assertProfile(profile, knownIds())));
    const body = Buffer.concat([cipher.update(JSON.stringify({ logins: data.logins }), 'utf8'), cipher.final()]);
    writePrivate(dataFile(profile), Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'));
  }
  function match(profile, site) {
    const domain = normalizeDomain(site);
    const data = open(profile);
    return data.logins.find((item) => domainsMatch(item.domain, domain)) || null;
  }

  return {
    saveLogin(profile, { domain, username, password, otp, selectors } = {}) {
      const id = assertProfile(profile, knownIds());
      const host = normalizeDomain(domain);
      const data = open(id);
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
      };
      data.logins = data.logins.filter((item) => item.domain !== host);
      data.logins.push(next);
      save(id, data);
      return { domain: host, username: next.username };
    },
    list(profile) {
      try {
        return open(profile).logins.map((item) => ({ domain: item.domain, username: item.username || '' }));
      } catch {
        return [];
      }
    },
    remove(profile, domain) {
      const id = assertProfile(profile, knownIds());
      const host = normalizeDomain(domain);
      const data = open(id);
      data.logins = data.logins.filter((item) => item.domain !== host);
      save(id, data);
      return this.list(id);
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
  };
}

module.exports = {
  FILL_SAVED_LOGIN_TOOL,
  createVaultStore,
  normalizeDomain,
  assertProfile,
  profileSlug,
  profileIdsFromList,
  directoryProfiles,
};
