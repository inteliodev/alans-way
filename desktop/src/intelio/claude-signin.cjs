'use strict';
/**
 * Starts Hermes's own Claude Pro/Max login for one profile.
 * Hermes d9ef91e prints an authorize link and reads the code from stdin
 * (`hermes --profile <name> auth add anthropic --type oauth`).
 * This module does not write auth.json, does not read it, and does not
 * keep the pasted code.
 */
const { spawn } = require('node:child_process');
const picker = require('./model-picker.cjs');

const URL_WAIT_MS = 20000;
const FINISH_WAIT_MS = 45000;
const EXPIRE_MS = 10 * 60 * 1000;

function createClaudeSignIn({ spawnImpl = spawn, bin = 'hermes', home = '', env = process.env } = {}) {
  const sessions = new Map();

  function scopeKey(profile, allAgents) {
    return allAgents ? '*' : profile;
  }

  function argsFor(profile, allAgents) {
    const tail = ['auth', 'add', 'anthropic', '--type', 'oauth'];
    return allAgents ? tail : ['--profile', profile, ...tail];
  }

  function drop(key) {
    const session = sessions.get(key);
    if (!session) return;
    if (session.expire) clearTimeout(session.expire);
    sessions.delete(key);
  }

  function finishWaiters(session, exitCode) {
    session.phase = exitCode === 0 ? 'done' : 'error';
    session.exitCode = exitCode;
    const waiters = session.waiters || [];
    session.waiters = [];
    for (const waiter of waiters) waiter(exitCode);
  }

  function start({ profile, allAgents = false } = {}) {
    const key = scopeKey(profile, allAgents);
    const existing = sessions.get(key);
    if (existing && existing.phase === 'waiting' && existing.url) {
      return Promise.resolve({ ok: true, waiting: true, url: existing.url, scope: allAgents ? 'all' : 'profile', restartRequired: false });
    }
    if (existing) {
      try { existing.child.kill(); } catch { /* already gone */ }
      drop(key);
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      let child;
      try {
        child = spawnImpl(bin, argsFor(profile, allAgents), {
          env: { ...env, BROWSER: 'true', ...(home ? { HOME: home } : {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        done({ ok: false, status: 502, error: 'Hermes is not available for Claude sign-in.' });
        return;
      }
      const session = { child, phase: 'waiting', url: '', buffer: '', waiters: [], codeSent: false };
      sessions.set(key, session);
      const urlTimer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        drop(key);
        done({ ok: false, status: 502, error: 'Claude sign-in did not start.' });
      }, URL_WAIT_MS);
      session.expire = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        drop(key);
      }, EXPIRE_MS);
      if (session.expire.unref) session.expire.unref();
      const takeUrl = (chunk) => {
        if (session.url) return;
        session.buffer = `${session.buffer}${chunk}`.slice(-8000);
        const url = picker.authorizeUrl(session.buffer);
        if (!url) return;
        session.url = url;
        session.buffer = '';
        clearTimeout(urlTimer);
        done({ ok: true, waiting: true, url, scope: allAgents ? 'all' : 'profile', restartRequired: false });
      };
      child.stdout?.on('data', (chunk) => takeUrl(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')));
      child.stderr?.on('data', () => {});
      child.on('error', () => {
        clearTimeout(urlTimer);
        drop(key);
        done({ ok: false, status: 502, error: 'Hermes is not available for Claude sign-in.' });
      });
      child.on('close', (code) => {
        clearTimeout(urlTimer);
        if (!session.url) {
          drop(key);
          done({ ok: false, status: 502, error: 'Claude sign-in did not start.' });
          return;
        }
        finishWaiters(session, code ?? 1);
        drop(key);
      });
    });
  }

  function submit({ profile, allAgents = false, code = '' } = {}) {
    const key = scopeKey(profile, allAgents);
    const session = sessions.get(key);
    if (!session || session.phase !== 'waiting' || !session.url) {
      return Promise.resolve({ ok: false, status: 409, error: 'Start Claude sign-in first.' });
    }
    const pasted = String(code || '').trim();
    if (!picker.claudePaste(pasted)) {
      return Promise.resolve({ ok: false, status: 400, error: 'Paste the code Claude showed.' });
    }
    if (session.codeSent) {
      return Promise.resolve({ ok: false, status: 409, error: 'That sign-in is already finishing.' });
    }
    session.codeSent = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { session.child.kill(); } catch { /* already gone */ }
        drop(key);
        resolve({ ok: false, status: 502, error: 'Claude sign-in did not finish.' });
      }, FINISH_WAIT_MS);
      session.waiters.push((exitCode) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve({ ok: true, waiting: false, signedIn: true, scope: allAgents ? 'all' : 'profile', restartRequired: false });
        else resolve({ ok: false, status: 502, error: 'Claude sign-in did not finish.' });
      });
      try {
        session.child.stdin.write(`${pasted}\n`);
        session.child.stdin.end();
      } catch {
        clearTimeout(timer);
        drop(key);
        resolve({ ok: false, status: 502, error: 'Claude sign-in did not finish.' });
      }
    });
  }

  function stop() {
    for (const [key, session] of [...sessions]) {
      try { session.child.kill(); } catch { /* already gone */ }
      drop(key);
    }
  }

  return { start, submit, stop };
}

module.exports = { createClaudeSignIn };
