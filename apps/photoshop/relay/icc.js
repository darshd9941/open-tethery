'use strict';

// ICC profile handling for JPEG frames.
//
// Photoshop's UXP JPEG encoder gives us pixels in the requested profile but the
// JPEG it hands back is untagged (or tagged inconsistently). Browsers treat an
// untagged JPEG as sRGB, which is wrong for Display P3. We therefore inject the
// ICC profile ourselves, losslessly, as standard JPEG APP2 ICC_PROFILE segments.
//
// Profiles are CC0 (public domain) compact profiles from
// https://github.com/saucecontrol/Compact-ICC-Profiles
// See profiles/LICENSE-Compact-ICC-Profiles.txt.

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
  const data = fs.readFileSync(filePath);
  cache.set(file, data);
  return data;
}

// One ICC profile can span several APP2 segments (max 65519 bytes per segment).
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
    seg[16] = i + 1;       // sequence number, 1-based
    seg[17] = count;       // total segment count
    chunk.copy(seg, 18);
    segments.push(seg);
  }
  return Buffer.concat(segments);
}

function isIccPayload(jpeg, payloadStart, payloadEnd) {
  if (payloadEnd - payloadStart < 14) return false;
  return jpeg.toString('latin1', payloadStart, payloadStart + 12) === 'ICC_PROFILE\0';
}

// Replaces any existing ICC profile with `icc`, and inserts the new profile
// directly after the SOI marker. Returns a new Buffer.
function injectProfile(jpeg, icc) {
  if (!Buffer.isBuffer(jpeg) || jpeg.length < 4) return jpeg;
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return jpeg; // not a JPEG
  if (!Buffer.isBuffer(icc) || icc.length === 0) return jpeg;

  const parts = [jpeg.subarray(0, 2), buildIccSegments(icc)];
  let offset = 2;
  let removed = 0;
  let stopped = false;

  while (offset + 1 < jpeg.length) {
    if (jpeg[offset] !== 0xFF) break; // malformed: keep the rest as-is

    const segmentStart = offset;
    let markerAt = offset + 1;
    while (markerAt < jpeg.length && jpeg[markerAt] === 0xFF) markerAt++;
    if (markerAt >= jpeg.length) break;
    const marker = jpeg[markerAt];

    // Markers without a length field.
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

    // Start of scan: entropy-coded data follows, so stop parsing here.
    if (marker === 0xDA) {
      parts.push(jpeg.subarray(segmentStart));
      stopped = true;
      break;
    }

    const payloadStart = markerAt + 3;
    if (marker === 0xE2 && isIccPayload(jpeg, payloadStart, segmentEnd)) {
      removed++;
    } else {
      parts.push(jpeg.subarray(segmentStart, segmentEnd));
    }
    offset = segmentEnd;
  }

  if (!stopped && offset < jpeg.length) parts.push(jpeg.subarray(offset));

  return Buffer.concat(parts);
}

module.exports = { resolveProfile, injectProfile };
