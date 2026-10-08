'use strict';
// Tailscale mode: the phone listener serves TLS for its *.ts.net name. A node
// configured with the bare Tailscale IP used to fail the certificate name
// check on wss and then fail ws:// against TLS. It now dials the IP but
// verifies the certificate against the peer's MagicDNS name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { connectWebSocket, acceptWebSocket } = require('../src/intelio/node/ws.cjs');
const { relayUrls, withTlsName, isTailnetIp } = require('../src/intelio/node/electron.cjs');
const { peerDnsName, tailnetNameFor } = require('../src/intelio/tailscale.cjs');

const NAME = 'vps.tail1234.ts.net';
const ip = (...p) => p.join('.');

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intelio-tls-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

const pem = (() => { try { return makeCert(); } catch { return null; } })();

test('wss to an address verifies the certificate against servername; without it the name check fails', { skip: !pem && 'openssl not available' }, async (t) => {
  const server = https.createServer({ key: pem.key, cert: pem.cert });
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptWebSocket(req, socket, head, {});
    conn.on('message', (text) => conn.send(`echo:${text}`));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const url = `wss://127.0.0.1:${server.address().port}/node/connect`;
  await assert.rejects(connectWebSocket(url, { ca: pem.cert }), (e) => /altname|Hostname\/IP does not match|ERR_TLS_CERT_ALTNAME_INVALID/i.test(`${e.code} ${e.message}`));
  await assert.rejects(connectWebSocket(url, { servername: 'other.tail1234.ts.net', ca: pem.cert }), (e) => /altname|does not match/i.test(`${e.code} ${e.message}`), 'a wrong name is still refused');
  await assert.rejects(connectWebSocket(url, { servername: NAME }), (e) => /self.signed|unable to verify|SELF_SIGNED/i.test(`${e.code} ${e.message}`), 'verification stays on');
  const conn = await connectWebSocket(url, { servername: NAME, ca: pem.cert });
  const reply = new Promise((r) => conn.on('message', r));
  conn.send('hi');
  assert.equal(await reply, 'echo:hi');
  conn.close();
});

test('relay URLs for a Tailscale IP try the MagicDNS name first, then the old URLs', () => {
  const host = ip(100, 111, 128, 12);
  const urls = relayUrls({ mode: 'tailscale', host, tlsName: NAME }, {}).urls;
  assert.deepEqual(urls[0], { url: `wss://${host}:8643/node/connect`, servername: NAME });
  assert.deepEqual(urls.slice(1), [`wss://${host}:8643/node/connect`, `ws://${host}:8643/node/connect`]);
  // A MagicDNS host needs no override; a non-ts.net name is never used as servername.
  assert.ok(relayUrls({ mode: 'tailscale', host: NAME, tlsName: NAME }, {}).urls.every((u) => typeof u === 'string'));
  assert.ok(relayUrls({ mode: 'tailscale', host, tlsName: 'evil.example' }, {}).urls.every((u) => typeof u === 'string'));
  assert.ok(isTailnetIp(host) && isTailnetIp('fd7a:115c:a1e0::1') && !isTailnetIp(ip(10, 0, 0, 1)) && !isTailnetIp(NAME));
});

test('withTlsName asks Tailscale for the peer name and falls back to the VPS name', async () => {
  const host = ip(100, 111, 128, 12);
  assert.equal((await withTlsName({ mode: 'tailscale', host }, { nameFor: async () => NAME })).tlsName, NAME);
  assert.equal((await withTlsName({ mode: 'tailscale', host }, { nameFor: async () => '', fallback: 'intelio-vps.tail9c1007.ts.net' })).tlsName, 'intelio-vps.tail9c1007.ts.net');
  assert.equal((await withTlsName({ mode: 'tailscale', host: NAME }, { nameFor: async () => { throw new Error('not called'); } })).tlsName, undefined);
  assert.equal(await withTlsName(null), null);
  const status = { Self: { TailscaleIPs: [ip(100, 73, 1, 1)], DNSName: 'laptop.tail1234.ts.net.' }, Peer: { a: { TailscaleIPs: [host, 'fd7a:115c:a1e0::5'], DNSName: `${NAME}.` }, b: { TailscaleIPs: [ip(100, 64, 0, 9)], DNSName: 'bad name' } } };
  assert.equal(peerDnsName(status, host), NAME);
  assert.equal(peerDnsName(status, '[fd7a:115c:a1e0::5]'), NAME);
  assert.equal(peerDnsName(status, ip(100, 64, 0, 9)), '');
  assert.equal(peerDnsName(status, ip(100, 64, 0, 10)), '');
  const name = await tailnetNameFor(host, { bins: ['tailscale'], run: async (_bin, args) => ({ code: 0, stdout: args[0] === 'status' ? JSON.stringify(status) : '' }) });
  assert.equal(name, NAME);
});
