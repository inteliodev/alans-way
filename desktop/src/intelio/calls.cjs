'use strict';
/**
 * In-app call pills. Duration is local. Ending a call keeps the last length.
 */

function startCall(now = Date.now()) {
  return { active: true, startedAt: now, endedAt: 0, seconds: 0 };
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
  return { active: false, startedAt: call?.startedAt || now, endedAt: now, seconds };
}

function callPill(call) {
  if (!call) return '';
  if (call.active) return `in call ${call.seconds}s`;
  if (call.endedAt) return `${call.seconds}s - Call ended`;
  return '';
}

module.exports = { startCall, tickCall, endCall, callPill };
