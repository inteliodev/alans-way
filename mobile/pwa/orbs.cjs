'use strict';
/**
 * Abstract luminous orbs. Named agents have fixed palettes.
 * Any other profile id gets a stable hue from a hash, so a new agent
 * does not need a new image file.
 */
const { encodePng } = require('../../desktop/src/intelio/png-icon.cjs');
const { frameOf, holdOf } = require('./thinking-orbs.cjs');

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

const NAMED = {
  intelio: ['#7a5cff', '#3de1ff'],
  prc: ['#059669', '#2dd4bf'],
  alignment: ['#1d4ed8', '#7dd3fc'],
  hhp: ['#d97706', '#fbbf24'],
  'kid-a': ['#e879f9', '#fb7185'],
  'kid a': ['#e879f9', '#fb7185'],
  kida: ['#e879f9', '#fb7185'],
};

function hashHue(id) {
  let hash = 2166136261;
  const text = String(id || 'intelio');
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0) % 360;
}

function hsl(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function hexRgb(hex) {
  const value = String(hex).replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function signatureOf(id) {
  const key = String(id || 'intelio').trim().toLowerCase();
  if (SIGNATURES[key]) return SIGNATURES[key];
  let hash = 2166136261;
  const text = key;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return OPEN_TYPES[(hash >>> 0) % OPEN_TYPES.length];
}

function orbPalette(id) {
  const key = String(id || 'intelio').trim().toLowerCase();
  if (NAMED[key]) return { kind: 'named', stops: NAMED[key].map(hexRgb) };
  const hue = hashHue(key);
  return { kind: 'hash', hue, stops: [hsl(hue, 78, 52), hsl(hue + 36, 85, 68)] };
}

function stamp(pixels, size, x0, y0, radius, color, alpha) {
  const rad = Math.max(0.6, radius);
  const coverA = alpha == null ? 1 : alpha;
  const minX = Math.max(0, Math.floor(x0 - rad));
  const maxX = Math.min(size - 1, Math.ceil(x0 + rad));
  const minY = Math.max(0, Math.floor(y0 - rad));
  const maxY = Math.min(size - 1, Math.ceil(y0 + rad));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dist = Math.hypot(x - x0, y - y0);
      if (dist > rad) continue;
      const cover = Math.min(1, ((rad - dist) / Math.max(0.5, rad * 0.45)) * coverA);
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(pixels[offset] * (1 - cover) + color[0] * cover);
      pixels[offset + 1] = Math.round(pixels[offset + 1] * (1 - cover) + color[1] * cover);
      pixels[offset + 2] = Math.round(pixels[offset + 2] * (1 - cover) + color[2] * cover);
      pixels[offset + 3] = 255;
    }
  }
}

function renderOrbPng(id, size = 256) {
  const accent = orbPalette(id).stops[0];
  const preset = 64;
  const kind = signatureOf(id);
  const frame = frameOf(kind, preset, holdOf(kind));
  const pixels = Buffer.alloc(size * size * 4);
  const bg = [16, 14, 40];
  const cx = (size - 1) / 2;
  const scale = size / preset;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const glow = Math.max(0, 1 - Math.hypot(x - cx, y - cx) / (size * 0.46));
      const mix = glow * glow * 0.62;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(bg[0] + (accent[0] - bg[0]) * mix);
      pixels[offset + 1] = Math.round(bg[1] + (accent[1] - bg[1]) * mix);
      pixels[offset + 2] = Math.round(bg[2] + (accent[2] - bg[2]) * mix);
      pixels[offset + 3] = 255;
    }
  }
  const ink = (white) => {
    const g = Math.round((1 - Math.min(1, Math.max(0, white))) * 255);
    return [
      Math.round(g * 0.78 + accent[0] * 0.22),
      Math.round(g * 0.78 + accent[1] * 0.22),
      Math.round(g * 0.78 + accent[2] * 0.22),
    ];
  };
  for (const line of frame.lines || []) {
    const steps = Math.max(2, Math.ceil(Math.hypot(line.x2 - line.x1, line.y2 - line.y1) * scale));
    for (let i = 0; i <= steps; i += 1) {
      const f = i / steps;
      stamp(pixels, size, (line.x1 + (line.x2 - line.x1) * f) * scale, (line.y1 + (line.y2 - line.y1) * f) * scale, Math.max(0.8, (line.w / 2) * scale), ink(line.white), line.a);
    }
  }
  for (const dot of frame.dots) stamp(pixels, size, dot.x * scale, dot.y * scale, dot.r * scale, ink(dot.white), dot.a);
  return encodePng(size, size, pixels);
}

module.exports = { NAMED, hashHue, orbPalette, signatureOf, renderOrbPng };
