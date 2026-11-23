'use strict';

// OTV1 kind-1 (JPEG frame) packer. Layout: docs/PROTOCOL.md section 5.
// 24-byte header + 8-byte frame meta + JPEG, all little-endian.

const HEADER_BYTES = 24;
const META_BYTES = 8;
const MAX_U16 = 65535;
const KIND_JPEG = 1;
const FLAG_STILL = 1;

// Keeps the aspect ratio when a dimension does not fit in 16 bits.
function fitU16(w, h) {
  w = Math.max(1, Math.round(w) || 1);
  h = Math.max(1, Math.round(h) || 1);
  const big = Math.max(w, h);
  if (big <= MAX_U16) return [w, h];
  const k = MAX_U16 / big;
  return [Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k))];
}

// opts: { jpeg, seq, time (seconds, default NaN), flags (default 1 = still),
//         width, height (JPEG), srcWidth, srcHeight }
function packFrame(opts) {
  const jpeg = opts.jpeg;
  const out = new Uint8Array(HEADER_BYTES + META_BYTES + jpeg.length);
  const view = new DataView(out.buffer);
  out[0] = 0x4f; // O
  out[1] = 0x54; // T
  out[2] = 0x56; // V
  out[3] = 0x31; // 1
  out[4] = KIND_JPEG;
  out[5] = opts.flags === undefined ? FLAG_STILL : opts.flags & 0xff;
  view.setUint32(8, opts.seq >>> 0, true);
  view.setFloat64(16, opts.time === undefined ? NaN : opts.time, true);
  const [w, h] = fitU16(opts.width, opts.height);
  const [sw, sh] = fitU16(opts.srcWidth, opts.srcHeight);
  view.setUint16(24, w, true);
  view.setUint16(26, h, true);
  view.setUint16(28, sw, true);
  view.setUint16(30, sh, true);
  out.set(jpeg, HEADER_BYTES + META_BYTES);
  return out;
}

module.exports = { packFrame, fitU16, HEADER_BYTES, META_BYTES, KIND_JPEG, FLAG_STILL };
