const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { importRemoteHermesKey, keyFromImport, keysFromImport } = require('../src/intelio/remote-hermes-main.cjs');

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

test('multi-line import stores each profile key and keeps API_SERVER_KEY as intelio', () => {
  const intelio = 'a'.repeat(32);
  const prc = 'b'.repeat(32);
  const alignment = 'c'.repeat(24);
  const text = `# keys\n\nAPI_SERVER_KEY="${intelio}"\nprc=${prc}\nalignment='${alignment}'\nshort=abcd\nNot A Profile=${'d'.repeat(20)}\n`;
  const parsed = keysFromImport(text);
  assert.equal(digest(parsed.intelio), digest(intelio));
  assert.equal(digest(parsed.prc), digest(prc));
  assert.equal(digest(parsed.alignment), digest(alignment));
  assert.equal(parsed.short, undefined);
  assert.equal(Object.keys(parsed).length, 3);
  let present = true;
  let wiped = 0;
  const stored = {};
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(digest(value), 'hex') };
  const fsImpl = {
    existsSync: () => present,
    statSync: () => ({ size: Buffer.byteLength(text) }),
    readFileSync: () => text,
    openSync: () => 4,
    writeSync: (_fd, buf) => { wiped = buf.length; assert.equal(buf.every((byte) => byte === 0), true); },
    fsyncSync: () => {},
    closeSync: () => {},
    unlinkSync: () => { present = false; },
  };
  const result = importRemoteHermesKey({
    file: '/tmp/remote-hermes-key.import',
    profile: 'intelio',
    safeStorage,
    readKeys: () => stored,
    writeKeys: (keys) => Object.assign(stored, keys),
    fsImpl,
  });
  assert.equal(result.imported, true);
  assert.deepEqual([...result.profiles].sort(), ['alignment', 'intelio', 'prc']);
  assert.equal(result.notice, 'Connected to VPS Hermes');
  assert.equal(JSON.stringify(result).includes(intelio), false);
  assert.equal(present, false);
  assert.equal(wiped, Buffer.byteLength(text));
  assert.equal(stored.intelio, Buffer.from(digest(intelio), 'hex').toString('base64'));
  assert.equal(stored.prc, Buffer.from(digest(prc), 'hex').toString('base64'));
  assert.equal(stored.alignment, Buffer.from(digest(alignment), 'hex').toString('base64'));
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
