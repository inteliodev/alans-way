/**
 * In-app call pills. Duration is local. Ending a call keeps the last length.
 */
(function intelioCalls(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioCalls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioCallsFactory() {
  function startCall(now = Date.now()) {
    return { active: true, startedAt: now, endedAt: 0, seconds: 0, speaker: true };
  }

  function tickCall(call, now = Date.now()) {
    if (!call?.active) return call;
    const seconds = Math.max(0, Math.round((now - call.startedAt) / 1000));
    return { ...call, seconds };
  }

  function endCall(call, now = Date.now()) {
    const seconds = call?.active
      ? Math.max(0, Math.round((now - call.startedAt) / 1000))
      : Math.max(0, Number(call?.seconds) || 0);
    return { active: false, startedAt: call?.startedAt || now, endedAt: now, seconds, speaker: false };
  }

  function callPill(call) {
    if (!call) return '';
    if (call.active) return `in call ${call.seconds}s`;
    if (call.endedAt) return `${call.seconds}s - Call ended`;
    return '';
  }

  return { startCall, tickCall, endCall, callPill };
});
