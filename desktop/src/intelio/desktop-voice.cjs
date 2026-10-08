/**
 * Desktop voice stays on the VPS. Hermes audio wins when /v1/capabilities
 * advertises it. Otherwise faster-whisper and Piper on the phone server.
 * There is no cloud speech provider.
 */
(function intelioDesktopVoice(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioDesktopVoice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioDesktopVoiceFactory() {
  const NOT_READY = "Voice isn't set up on the server yet";
  const LISTENING = 'Listening…';

  function voiceReady(status) {
    if (!status || typeof status !== 'object') return false;
    if (status.hermesAudio === true || status.vps === true) return true;
    return status.recommended === 'hermes' || status.recommended === 'vps';
  }

  function appendDictation(current, text) {
    const next = String(text || '').trim();
    if (!next) return String(current || '');
    const base = String(current || '').trim();
    return base ? `${base} ${next}` : next;
  }

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

  /** Milliseconds between microphone level checks in a voice conversation. */
  const VAD_TICK_MS = 30;

  const TURN_DEFAULTS = {
    // A turn ends after this much quiet: long enough for a breath or a thinking pause.
    endSilenceMs: 1200,
    // Speech must last this long (above the start level) before it counts as a turn.
    minSpeechMs: 180,
    // Shorter bursts (a cough, a click, one syllable of echo) are dropped.
    minTurnMs: 300,
    maxTurnMs: 60000,
    // While the agent talks, its own voice reaches the mic. Talking over it must be
    // clearly louder than that echo and last this long.
    bargeMs: 350,
    // Echo tail after the agent stops talking.
    holdoffMs: 300,
    minStart: 0.02,
    minKeep: 0.012,
    minBarge: 0.08,
  };

  /**
   * Turn-taking for a hands-free voice conversation. Feed it the mic level (RMS,
   * 0..1) every few tens of milliseconds and whether the agent is speaking. It
   * returns one of: '' (nothing new), 'start' (the user began a turn), 'barge'
   * (the user is talking over the agent: stop its speech, then a turn starts),
   * 'end' (the user finished: send this turn), 'cancel' (it was only noise).
   * The thresholds follow the room: a noise floor is learned while nobody talks.
   */
  function createTurnDetector(options = {}) {
    const o = { ...TURN_DEFAULTS, ...options };
    let floor = 0.008;
    let echo = 0;
    let phase = 'idle'; // idle | onset | speech
    let onsetAt = 0;
    let voicedMs = 0;
    let gapMs = 0;
    let speechAt = 0;
    let quietAt = 0;
    let lastAt = 0;
    let agentUntil = 0;

    function thresholds(agentSpeaking, now) {
      const start = Math.max(o.minStart, floor * 3);
      const keep = Math.max(o.minKeep, floor * 1.8);
      if (agentSpeaking) return { start: Math.max(o.minBarge, start, echo * 1.8), keep, need: o.bargeMs, barge: true };
      if (now < agentUntil) return { start: Math.max(start, echo * 1.5), keep, need: o.minSpeechMs, barge: false };
      return { start, keep, need: o.minSpeechMs, barge: false };
    }

    function feed(level, now, { agentSpeaking = false } = {}) {
      const value = Number.isFinite(level) && level > 0 ? Math.min(level, 1) : 0;
      const step = lastAt ? Math.min(Math.max(now - lastAt, 0), 200) : 0;
      lastAt = now;
      const t = thresholds(agentSpeaking, now);
      if (agentSpeaking) agentUntil = now + o.holdoffMs;
      if (phase === 'idle') {
        if (value >= t.start) {
          phase = 'onset';
          onsetAt = now;
          voicedMs = 0;
          gapMs = 0;
          return '';
        }
        // Learn the agent's echo level, and the room's floor from quiet moments without it.
        if (agentSpeaking) echo = echo * 0.95 + value * 0.05;
        else if (now >= agentUntil) {
          echo *= 0.98;
          floor = Math.min(0.05, Math.max(0.002, floor * 0.97 + value * 0.03));
        }
        return '';
      }
      if (phase === 'onset') {
        // Over the agent's voice only clearly loud speech counts, with almost no gaps.
        const voiced = value >= (t.barge ? t.start : t.keep);
        if (voiced) { voicedMs += step; gapMs = 0; } else gapMs += step;
        if (gapMs > (t.barge ? 150 : 250) || now - onsetAt > Math.max(t.need * 3, 900)) {
          phase = 'idle';
          voicedMs = 0;
          gapMs = 0;
          return '';
        }
        if (voicedMs >= t.need) {
          phase = 'speech';
          speechAt = onsetAt;
          quietAt = 0;
          return agentSpeaking ? 'barge' : 'start';
        }
        return '';
      }
      // phase === 'speech'
      if (value >= t.keep) {
        voicedMs += step;
        quietAt = 0;
      } else if (!quietAt) {
        quietAt = now;
      }
      if (now - speechAt >= o.maxTurnMs || (quietAt && now - quietAt >= o.endSilenceMs)) {
        const enough = voicedMs >= o.minTurnMs;
        phase = 'idle';
        voicedMs = 0;
        quietAt = 0;
        return enough ? 'end' : 'cancel';
      }
      return '';
    }

    function reset() {
      phase = 'idle';
      voicedMs = 0;
      gapMs = 0;
      quietAt = 0;
      onsetAt = 0;
    }

    return {
      feed,
      reset,
      get phase() { return phase; },
      get floor() { return floor; },
      get inTurn() { return phase === 'speech'; },
    };
  }

  /** RMS of an 8-bit time-domain analyser frame (AnalyserNode.getByteTimeDomainData). */
  function levelOf(bytes) {
    if (!bytes || !bytes.length) return 0;
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
      const v = (bytes[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / bytes.length);
  }

  return { NOT_READY, LISTENING, VAD_TICK_MS, TURN_DEFAULTS, voiceReady, appendDictation, splitSentences, createTurnDetector, levelOf };
});
