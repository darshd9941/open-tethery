'use strict';

// Photoshop's JPEG encoder returns pixels in the requested profile but the
// file is not reliably tagged. Browsers treat an untagged JPEG as sRGB, which
// is wrong for Display P3, so the profile is injected as APP2 ICC_PROFILE
// segments (lossless, no re-encode). Ported from the old relay.

const profiles = require('./icc-profiles');
const { base64ToBytes } = require('./format');

const NAMES = {
  'srgb': 'srgb',
  'srgb iec61966-2.1': 'srgb',
  'iec61966-2.1': 'srgb',
  'display p3': 'displayp3',
  'displayp3': 'displayp3',
  'p3': 'displayp3',
};
const cache = {};

function resolveProfile(name) {
  if (!name) return null;
  const key = NAMES[String(name).trim().toLowerCase()];
  if (!key) return null;
  if (!cache[key]) cache[key] = base64ToBytes(profiles[key]);
  return cache[key];
}

const SIG = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]; // "ICC_PROFILE\0"

function buildIccSegments(icc) {
  const MAX_CHUNK = 65533 - 14;
  const count = Math.max(1, Math.ceil(icc.length / MAX_CHUNK));
  const segs = [];
  for (let i = 0; i < count; i++) {
    const chunk = icc.subarray(i * MAX_CHUNK, Math.min(icc.length, (i + 1) * MAX_CHUNK));
    const seg = new Uint8Array(4 + 14 + chunk.length);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    const len = 2 + 14 + chunk.length;
    seg[2] = len >> 8;
    seg[3] = len & 0xff;
    seg.set(SIG, 4);
    seg[16] = i + 1;
    seg[17] = count;
    seg.set(chunk, 18);
    segs.push(seg);
  }
  return segs;
}

function isIccPayload(jpeg, start, end) {
  if (end - start < 14) return false;
  for (let i = 0; i < SIG.length; i++) if (jpeg[start + i] !== SIG[i]) return false;
  return true;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Replaces any existing ICC profile; the new one goes right after SOI.
function injectProfile(jpeg, icc) {
  if (!jpeg || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  if (!icc || !icc.length) return jpeg;

  const parts = [jpeg.subarray(0, 2), ...buildIccSegments(icc)];
  let offset = 2;
  let stopped = false;

  while (offset + 1 < jpeg.length) {
    if (jpeg[offset] !== 0xff) break;
    const segStart = offset;
    let m = offset + 1;
    while (m < jpeg.length && jpeg[m] === 0xff) m++;
    if (m >= jpeg.length) break;
    const marker = jpeg[m];

    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(jpeg.subarray(segStart, m + 1));
      offset = m + 1;
      continue;
    }
    if (m + 2 >= jpeg.length) {
      parts.push(jpeg.subarray(segStart));
      stopped = true;
      break;
    }
    const length = (jpeg[m + 1] << 8) | jpeg[m + 2];
    const segEnd = m + 1 + length;
    if (length < 2 || segEnd > jpeg.length || marker === 0xda) {
      parts.push(jpeg.subarray(segStart)); // bad segment or start of scan: keep the rest
      stopped = true;
      break;
    }
    if (!(marker === 0xe2 && isIccPayload(jpeg, m + 3, segEnd))) {
      parts.push(jpeg.subarray(segStart, segEnd));
    }
    offset = segEnd;
  }
  if (!stopped && offset < jpeg.length) parts.push(jpeg.subarray(offset));
  return concat(parts);
}

module.exports = { resolveProfile, injectProfile };
