'use strict';
/**
 * Verify a Cloudflare Access JWT (RS256) with Node's crypto. Failures are a
 * generic denial. This module never logs the token, the email, or key material.
 */
const crypto = require('node:crypto');

const TEAM = 'https://muddy-scene-4e1c.cloudflareaccess.com';
const CERTS_URL = `${TEAM}/cdn-cgi/access/certs`;
const AUD = '9244bb370c6284088828a165bb1f0b08f52f49e57f7df871c4b5b92c9ec32108';
const EMAIL = 'hayden@intelio.co';

function denied() {
  const error = new Error('denied');
  error.code = 'denied';
  throw error;
}

function b64url(segment) {
  const text = String(segment || '');
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function keyList(keys) {
  if (Array.isArray(keys)) return keys;
  if (Array.isArray(keys?.keys)) return keys.keys;
  if (Array.isArray(keys?.public_certs)) return keys.public_certs;
  return [];
}

function verifyAccessJwt(token, keys, { aud = AUD, email = EMAIL, now = Date.now(), team = TEAM } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) denied();
    const header = JSON.parse(b64url(parts[0]).toString('utf8'));
    const payload = JSON.parse(b64url(parts[1]).toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid) denied();
    const match = keyList(keys).find((item) => item && item.kid === header.kid);
    if (!match) denied();
    let publicKey;
    if (match.n && match.e) {
      publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: match.n, e: match.e }, format: 'jwk' });
    } else if (match.cert || match.pem) {
      publicKey = crypto.createPublicKey(match.cert || match.pem);
    } else denied();
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, b64url(parts[2]));
    if (!ok) denied();
    const iss = String(payload.iss || '').replace(/\/$/, '');
    if (iss !== String(team || '').replace(/\/$/, '')) denied();
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) denied();
    if (String(payload.email || '').toLowerCase() !== String(email || '').toLowerCase()) denied();
    const exp = Number(payload.exp);
    const expMs = exp > 1e12 ? exp : exp * 1000;
    if (!Number.isFinite(expMs) || expMs <= now) denied();
    return { ok: true };
  } catch (error) {
    if (error && error.code === 'denied') throw error;
    denied();
  }
}

module.exports = { TEAM, CERTS_URL, AUD, EMAIL, verifyAccessJwt };
