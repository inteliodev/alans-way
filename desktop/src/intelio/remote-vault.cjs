'use strict';
/**
 * Remote-mode vault client. Sign-in posts to the VPS filler. It does not
 * write ~/.hermes on the laptop.
 */
const { isTailnetOrLoopbackHost } = require('./remote-hermes.cjs');

function usesRemoteVault(prefs) {
  return Boolean(prefs?.remoteHermes?.enabled && prefs?.remoteHermes?.host);
}

function vaultOrigin(config = {}, env = process.env) {
  const explicit = String(config.vaultOrigin || env.INTELIO_VAULT_ORIGIN || '').trim();
  if (explicit) {
    let url;
    try { url = new URL(explicit); } catch { throw new Error('Vault origin must be an http(s) URL.'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Vault origin must be http or https.');
    const host = url.hostname.toLowerCase();
    if (host !== 'app.intelio-ai.com' && !isTailnetOrLoopbackHost(host)) {
      throw new Error('Vault origin must be the VPS tailnet, loopback, or app.intelio-ai.com.');
    }
    return url.origin;
  }
  if (!config.host) throw new Error('Set the Remote Hermes host first.');
  const port = Number(config.vaultPort || env.INTELIO_VAULT_PORT || 8643);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Vault port must be 1-65535.');
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
  return `http://${host}:${port}`;
}

function publicVaultBody(json = {}) {
  const logins = Array.isArray(json.logins)
    ? json.logins.map((item) => ({ domain: String(item?.domain || ''), username: String(item?.username || '') }))
    : undefined;
  return {
    ok: json.ok === true,
    filled: json.filled === true,
    saved: json.saved === true,
    domain: String(json.domain || ''),
    username: String(json.username || ''),
    ...(logins ? { logins } : {}),
    ...(json.ok === true ? {} : { error: String(json.error || 'Vault request failed.').slice(0, 160) }),
  };
}

function scrub(text, secrets) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (secret && String(secret).length >= 3) out = out.split(String(secret)).join('[redacted]');
  }
  return out.slice(0, 180);
}

async function postProfileVault({
  origin,
  profile,
  key,
  method = 'POST',
  path,
  body,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!key) throw new Error('No API key saved for this Hermes profile.');
  const url = new URL(path, origin.endsWith('/') ? origin : `${origin}/`);
  const secrets = [key, body?.password, body?.otp];
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'x-intelio-profile': profile,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
    });
  } catch (error) {
    throw new Error(scrub(error?.message || 'Vault host unreachable.', secrets));
  }
  const text = await response.text();
  if (text.includes(String(key))) throw new Error('Vault response was discarded.');
  let json = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  const pub = publicVaultBody(json);
  if (!response.ok) {
    pub.ok = false;
    if (!pub.error) pub.error = 'Vault request failed.';
  }
  return pub;
}

module.exports = { usesRemoteVault, vaultOrigin, publicVaultBody, postProfileVault };
