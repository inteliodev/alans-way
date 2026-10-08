'use strict';
/**
 * Orb type for an agent id. Same mapping as mobile/pwa/orbs.cjs signatureOf.
 * Vendored so the packaged main process never requires a file outside desktop/src.
 */
const SIGNATURES = {
  intelio: 'connecting',
  prc: 'solving',
  alignment: 'searching',
  hhp: 'weaving',
  'kid-a': 'composing',
  'kid a': 'composing',
  kida: 'composing',
};
const OPEN_TYPES = ['working', 'listening', 'breathing', 'shaping'];
const ORB_IDS = ['connecting', 'solving', 'searching', 'weaving', 'working', 'listening', 'breathing', 'shaping', 'composing'];
const ORB_LABELS = {
  connecting: 'Connecting',
  solving: 'Solving',
  searching: 'Searching',
  weaving: 'Weaving',
  working: 'Working',
  listening: 'Listening',
  breathing: 'Breathing',
  shaping: 'Shaping',
  composing: 'Composing',
};

function signatureOf(id) {
  const key = String(id || 'intelio').trim().toLowerCase();
  if (SIGNATURES[key]) return SIGNATURES[key];
  let hash = 2166136261;
  const text = key;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return OPEN_TYPES[(hash >>> 0) % OPEN_TYPES.length];
}

module.exports = { signatureOf, ORB_IDS, ORB_LABELS };
