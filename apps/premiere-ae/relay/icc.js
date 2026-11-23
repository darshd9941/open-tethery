'use strict';

// ICC profile handling for preview frames.
// Injects ICC profile segments (sRGB or Display P3) losslessly into JPEG frames.

const fs = require('fs');
const path = require('path');

const PROFILE_FILES = {
  'srgb': 'sRGB.icc',
  'srgb iec61966-2.1': 'sRGB.icc',
  'iec61966-2.1': 'sRGB.icc',
  'display p3': 'DisplayP3.icc',
  'displayp3': 'DisplayP3.icc',
  'p3': 'DisplayP3.icc',
};

const cache = new Map();

function resolveProfile(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase();
  const file = PROFILE_FILES[key];
  if (!file) return null;
  if (cache.has(file)) return cache.get(file);
  const filePath = path.join(__dirname, 'profiles', file);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  cache.set(file, data);
  return data;
}

function buildIccSegments(icc) {
  const MAX_CHUNK = 65533 - 14;
  const count = Math.max(1, Math.ceil(icc.length / MAX_CHUNK));
  const segments = [];
  for (let i = 0; i < count; i++) {
    const chunk = icc.subarray(i * MAX_CHUNK, Math.min(icc.length, (i + 1) * MAX_CHUNK));
    const seg = Buffer.alloc(2 + 2 + 14 + chunk.length);
    seg[0] = 0xFF;
    seg[1] = 0xE2;
    seg.writeUInt16BE(2 + 14 + chunk.length, 2);
    seg.write('ICC_PROFILE\0', 4, 'latin1');
    seg[16] = i + 1;
    seg[17] = count;
    chunk.copy(seg, 18);
    segments.push(seg);
  }
  return Buffer.concat(segments);
}

function isIccPayload(jpeg, payloadStart, payloadEnd) {
  if (payloadEnd - payloadStart < 14) return false;
  return jpeg.toString('latin1', payloadStart, payloadStart + 12) === 'ICC_PROFILE\0';
}

function injectProfile(jpeg, icc) {
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4) return jpeg;
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return jpeg; // not a JPEG
  if (!Buffer.isBuffer(icc) || icc.length === 0) return jpeg;

  const parts = [jpeg.subarray(0, 2), buildIccSegments(icc)];
  let offset = 2;
  let stopped = false;

  while (offset + 1 < jpeg.length) {
    if (jpeg[offset] !== 0xFF) break;

    const segmentStart = offset;
    let markerAt = offset + 1;
    while (markerAt < jpeg.length && jpeg[markerAt] === 0xFF) markerAt++;
    if (markerAt >= jpeg.length) break;
    const marker = jpeg[markerAt];

    if (marker === 0xD8 || marker === 0xD9) {
      parts.push(jpeg.subarray(segmentStart, markerAt + 1));
      offset = markerAt + 1;
      continue;
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      parts.push(jpeg.subarray(segmentStart, markerAt + 1));
      offset = markerAt + 1;
      continue;
    }

    if (markerAt + 2 >= jpeg.length) {
      parts.push(jpeg.subarray(segmentStart));
      stopped = true;
      break;
    }
    const length = jpeg.readUInt16BE(markerAt + 1);
    const segmentEnd = markerAt + 1 + length;
    if (length < 2 || segmentEnd > jpeg.length) {
      parts.push(jpeg.subarray(segmentStart));
      stopped = true;
      break;
    }

    if (marker === 0xDA) {
      parts.push(jpeg.subarray(segmentStart));
      stopped = true;
      break;
    }

    const payloadStart = markerAt + 3;
    if (marker === 0xE2 && isIccPayload(jpeg, payloadStart, segmentEnd)) {
      // replace existing
    } else {
      parts.push(jpeg.subarray(segmentStart, segmentEnd));
    }
    offset = segmentEnd;
  }

  if (!stopped && offset < jpeg.length) parts.push(jpeg.subarray(offset));
  return Buffer.concat(parts);
}

module.exports = { resolveProfile, injectProfile };
