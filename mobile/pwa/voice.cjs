'use strict';
/**
 * Sentence splitting and the local STT/TTS worker client.
 * The worker is a private stdin process. It does not listen on a port.
 * Audio bytes stay on this machine; nothing here calls a hosted speech API.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function splitSentences(text) {
  const sentences = [];
  let rest = String(text || '');
  const re = /^(.*?[.!?])(?:\s+|$)/s;
  while (rest) {
    const match = re.exec(rest);
    if (!match || !match[1]) break;
    sentences.push(match[1].trim());
    rest = rest.slice(match[0].length);
  }
  return { sentences, rest };
}

function micRms(bytes) {
  const samples = bytes || [];
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

function createVoiceRuntime({
  python = process.env.INTELIO_VOICE_PYTHON || '',
  script = path.join(__dirname, 'voice_engine.py'),
  spawnImpl = spawn,
  enabled = Boolean(process.env.INTELIO_VOICE_PYTHON || process.env.INTELIO_VOICE_PIPER_MODEL),
} = {}) {
  let child = null;
  let buf = '';
  let seq = 0;
  let failed = null;
  let chain = Promise.resolve();

  function failAll(error) {
    child = null;
    failed = error;
    buf = '';
  }

  function abandon(error) {
    if (!child) return;
    const pending = child.pending;
    failAll(error);
    if (pending) for (const waiter of pending.values()) waiter.reject(error);
  }

  function ensure() {
    if (child || !enabled) return;
    failed = null;
    const cmd = python || 'python3';
    try {
      child = spawnImpl(cmd, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      failed = error;
      return;
    }
    child.pending = new Map();
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const waiter = child && child.pending && child.pending.get(msg.id);
        if (!waiter) continue;
        child.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(String(msg.error)));
        else waiter.resolve(msg);
      }
    });
    child.on('error', (error) => abandon(error));
    child.on('exit', () => abandon(new Error('Voice engine stopped.')));
  }

  function request(op, extra, timeoutMs) {
    const run = chain.then(() => new Promise((resolve, reject) => {
      ensure();
      if (!child) {
        reject(new Error(failed?.message || 'Voice engine is not installed.'));
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        child.pending.delete(id);
        reject(new Error('Voice engine timed out.'));
      }, timeoutMs);
      child.pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`);
    }));
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function status() {
    if (!enabled) return { vps: false, whisper: false, piper: false };
    try {
      const msg = await request('status', {}, 20000);
      return { vps: Boolean(msg.whisper && msg.piper), whisper: Boolean(msg.whisper), piper: Boolean(msg.piper) };
    } catch {
      return { vps: false, whisper: false, piper: false };
    }
  }

  return {
    enabled,
    status,
    warm() { return request('warm', {}, 180000); },
    async transcribe(audio) {
      const file = path.join(os.tmpdir(), `intelio-stt-${crypto.randomBytes(8).toString('hex')}.wav`);
      await fs.promises.writeFile(file, audio);
      try {
        const msg = await request('transcribe', { path: file }, 120000);
        return { text: String(msg.text || '').trim(), seconds: msg.seconds, rssKb: msg.rss_kb };
      } finally {
        await fs.promises.unlink(file).catch(() => {});
      }
    },
    async synthesize(text) {
      const spoken = String(text || '').trim().slice(0, 2000);
      if (!spoken) throw new Error('Nothing to speak.');
      const file = path.join(os.tmpdir(), `intelio-tts-${crypto.randomBytes(8).toString('hex')}.wav`);
      try {
        const msg = await request('synthesize', { text: spoken, path: file }, 60000);
        const wav = await fs.promises.readFile(file);
        return { wav, seconds: msg.seconds, rssKb: msg.rss_kb };
      } finally {
        await fs.promises.unlink(file).catch(() => {});
      }
    },
    stop() {
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
      }
      child = null;
    },
  };
}

module.exports = { splitSentences, micRms, createVoiceRuntime };
