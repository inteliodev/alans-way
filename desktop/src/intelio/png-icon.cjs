'use strict';
/** Decode the brand PNG embedded in icon.svg, scale it, and wrap a 256px ICO. No npm deps. */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function brandSvgPath(root) {
  return path.join(root, 'intelio', 'vendor', 'intelio-harness', 'brand', 'icon.svg');
}

function extractBrandPng(svg) {
  const match = String(svg).match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  if (!match || /script|javascript:|onload=/i.test(svg)) throw new Error('Brand icon SVG has no embedded PNG.');
  const png = Buffer.from(match[1], 'base64');
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Brand icon PNG signature mismatch.');
  return png;
}

function readBrandPng(root) {
  return extractBrandPng(fs.readFileSync(brandSvgPath(root), 'utf8'));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(png) {
  const chunks = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Brand PNG must be 8-bit non-interlaced RGBA.');
      }
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const inflated = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[cursor];
    cursor += 1;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[cursor];
      cursor += 1;
      const left = x >= 4 ? row[x - 4] : 0;
      const up = prior ? prior[x] : 0;
      const upLeft = prior && x >= 4 ? prior[x - 4] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error('Unsupported PNG filter.');
      row[x] = value & 255;
    }
  }
  return { width, height, pixels };
}

function scaleRgba(decoded, width, height) {
  const dst = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(decoded.height - 1, Math.floor((y * decoded.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(decoded.width - 1, Math.floor((x * decoded.width) / width));
      decoded.pixels.copy(dst, (y * width + x) * 4, (sy * decoded.width + sx) * 4, (sy * decoded.width + sx) * 4 + 4);
    }
  }
  return dst;
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function scalePng(png, width, height) {
  const decoded = decodePng(png);
  return encodePng(width, height, scaleRgba(decoded, width, height));
}

function pngToIco(png) {
  const decoded = decodePng(png);
  if (decoded.width > 256 || decoded.height > 256) throw new Error('ICO PNG must be 256px or smaller.');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = decoded.width === 256 ? 0 : decoded.width;
  entry[1] = decoded.height === 256 ? 0 : decoded.height;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

module.exports = { extractBrandPng, readBrandPng, decodePng, scalePng, encodePng, pngToIco };
