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

  return { NOT_READY, LISTENING, voiceReady, appendDictation, splitSentences };
});
