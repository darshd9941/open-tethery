'use strict';

// OTV1 binary media framing (helper <-> viewer / source), docs/PROTOCOL.md section 5.
// 24-byte little-endian header, then an 8-byte kind-specific block, then data.

const MAGIC = Buffer.from('OTV1', 'ascii');
const HEADER_SIZE = 24;
const KIND_JPEG = 1;
const KIND_PCM = 2;
const FLAG_KEYFRAME = 1;
const MAX_MESSAGE = 32 * 1024 * 1024;

function writeHeader(buf, kind, flags, seq, time) {
  MAGIC.copy(buf, 0);
  buf[4] = kind;
  buf[5] = flags & 0xff;
  buf.writeUInt16LE(0, 6);
  buf.writeUInt32LE(seq >>> 0, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeDoubleLE(Number.isFinite(time) ? time : NaN, 16);
}

function encodeFrame({ seq, flags = FLAG_KEYFRAME, time = NaN, width, height, srcWidth, srcHeight, jpeg }) {
  const buf = Buffer.alloc(HEADER_SIZE + 8 + jpeg.length);
  writeHeader(buf, KIND_JPEG, flags, seq, time);
  buf.writeUInt16LE(width & 0xffff, 24);
  buf.writeUInt16LE(height & 0xffff, 26);
  buf.writeUInt16LE((srcWidth || width) & 0xffff, 28);
  buf.writeUInt16LE((srcHeight || height) & 0xffff, 30);
  jpeg.copy(buf, 32);
  return buf;
}

function encodeAudio({ seq, flags = 0, time = NaN, sampleRate = 48000, channels = 2, format = 1, frames, samples }) {
  const buf = Buffer.alloc(HEADER_SIZE + 8 + samples.length);
  writeHeader(buf, KIND_PCM, flags, seq, time);
  buf.writeUInt32LE(sampleRate, 24);
  buf[28] = channels;
  buf[29] = format;
  buf.writeUInt16LE(frames & 0xffff, 30);
  samples.copy(buf, 32);
  return buf;
}

// Parses any OTV1 message. Returns null when it is not valid.
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE + 8 || buf.length > MAX_MESSAGE) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  const head = { kind: buf[4], flags: buf[5], seq: buf.readUInt32LE(8), time: buf.readDoubleLE(16) };
  if (head.kind === KIND_JPEG) {
    const jpeg = buf.subarray(32);
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
    return {
      ...head,
      width: buf.readUInt16LE(24),
      height: buf.readUInt16LE(26),
      srcWidth: buf.readUInt16LE(28),
      srcHeight: buf.readUInt16LE(30),
      jpeg,
    };
  }
  if (head.kind === KIND_PCM) {
    return {
      ...head,
      sampleRate: buf.readUInt32LE(24),
      channels: buf[28],
      format: buf[29],
      frames: buf.readUInt16LE(30),
      samples: buf.subarray(32),
    };
  }
  return null;
}

module.exports = { encodeFrame, encodeAudio, decode, HEADER_SIZE, KIND_JPEG, KIND_PCM, FLAG_KEYFRAME, MAX_MESSAGE };
