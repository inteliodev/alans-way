const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { importRemoteHermesKey, keyFromImport } = require('../src/intelio/remote-hermes-main.cjs');

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

test('import text accepts a raw key or an env assignment', () => {
  const secret = 'k'.repeat(64);
  assert.equal(digest(keyFromImport(`${secret}\n`)), digest(secret));
  assert.equal(digest(keyFromImport(`API_SERVER_KEY="${secret}"\n`)), digest(secret));
  assert.equal(keyFromImport(''), '');
});

test('startup import encrypts the key, deletes the file, and names the toast', () => {
  const secret = 'k'.repeat(64);
  const file = '/tmp/remote-hermes-key.import';
  let present = true;
  let wiped = 0;
  const stored = {};
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(digest(value), 'hex'),
  };
  const fsImpl = {
    existsSync: () => present,
    statSync: () => ({ size: Buffer.byteLength(secret) }),
    readFileSync: () => secret,
    openSync: () => 4,
    writeSync: (_fd, buf) => { wiped = buf.length; assert.equal(buf.every((byte) => byte === 0), true); },
    fsyncSync: () => {},
    closeSync: () => {},
    unlinkSync: () => { present = false; },
  };
  const result = importRemoteHermesKey({
    file,
    profile: 'intelio',
    safeStorage,
    readKeys: () => stored,
    writeKeys: (keys) => Object.assign(stored, keys),
    fsImpl,
  });
  assert.equal(result.imported, true);
  assert.equal(result.notice, 'Connected to VPS Hermes');
  assert.equal(present, false);
  assert.equal(wiped, secret.length);
  assert.equal(stored.intelio, Buffer.from(digest(secret), 'hex').toString('base64'));
  const again = importRemoteHermesKey({ file, profile: 'intelio', safeStorage, readKeys: () => stored, writeKeys: () => {}, fsImpl });
  assert.equal(again.imported, false);
});

test('a missing keychain leaves the import file in place', () => {
  let unlinked = false;
  const fsImpl = {
    existsSync: () => true,
    statSync: () => ({ size: 32 }),
    readFileSync: () => 'k'.repeat(32),
    unlinkSync: () => { unlinked = true; },
  };
  const result = importRemoteHermesKey({
    file: '/tmp/remote-hermes-key.import',
    profile: 'intelio',
    safeStorage: { isEncryptionAvailable: () => false },
    readKeys: () => ({}),
    writeKeys: () => { throw new Error('should not store'); },
    fsImpl,
  });
  assert.equal(result.unavailable, true);
  assert.equal(unlinked, false);
});
