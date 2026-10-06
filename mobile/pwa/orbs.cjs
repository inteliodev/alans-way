'use strict';
/**
 * Abstract luminous orbs. Named agents have fixed palettes.
 * Any other profile id gets a stable hue from a hash, so a new agent
 * does not need a new image file.
 */
const { encodePng } = require('../../desktop/src/intelio/png-icon.cjs');

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

function orbPalette(id) {
  const key = String(id || 'intelio').trim().toLowerCase();
  if (NAMED[key]) return { kind: 'named', stops: NAMED[key].map(hexRgb) };
  const hue = hashHue(key);
  return { kind: 'hash', hue, stops: [hsl(hue, 78, 52), hsl(hue + 36, 85, 68)] };
}

function mix(a, b, t) {
  const u = Math.min(1, Math.max(0, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

function renderOrbPng(id, size = 256) {
  const palette = orbPalette(id);
  const [inner, outer] = palette.stops;
  const pixels = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const radius = size * 0.34;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx;
      const dy = y - cx;
      const dist = Math.hypot(dx, dy);
      const unit = dist / radius;
      const offset = (y * size + x) * 4;
      pixels[offset] = 12;
      pixels[offset + 1] = 12;
      pixels[offset + 2] = 16;
      pixels[offset + 3] = 255;
      if (unit > 1.55) continue;
      const angle = Math.atan2(dy, dx);
      const swirl = (Math.sin(angle * 3 + unit * 5) + 1) / 2;
      let color = mix(inner, outer, unit * 0.75 + swirl * 0.25);
      const highlight = Math.hypot(dx + radius * 0.28, dy + radius * 0.32) / (radius * 0.55);
      if (highlight < 1) color = mix(color, [255, 255, 255], (1 - highlight) * 0.55);
      let alpha = 1;
      if (unit > 1) alpha = Math.max(0, 1 - (unit - 1) / 0.55);
      const base = mix([12, 12, 16], color, alpha);
      pixels[offset] = base[0];
      pixels[offset + 1] = base[1];
      pixels[offset + 2] = base[2];
      pixels[offset + 3] = 255;
    }
  }
  return encodePng(size, size, pixels);
}

module.exports = { NAMED, hashHue, orbPalette, renderOrbPng };
