'use strict';

// OTX1 wire format (Transmit plugin -> helper), see docs/transmit-protocol.md.
// Pure parsing only; lib/ingest.js owns the TCP socket.

const MAGIC = Buffer.from('OTXF', 'ascii');
const HEADER_SIZE = 16;
const FRAME_META_SIZE = 24;
const MAX_PAYLOAD = 32 * 1024 * 1024;
const TICKS_PER_SECOND = 254016000000n;

const TYPE_FRAME_JPEG = 1;
const TYPE_STATE = 2;
const TYPE_HEARTBEAT = 3;

class ProtocolError extends Error {}

// Streaming parser: push() takes arbitrary TCP chunks and calls
// onMessage({type, seq, payload}) per complete message. Throws ProtocolError
// on bad magic or an oversized payload (caller drops the connection).
class FrameParser {
  constructor(onMessage, maxPayload = MAX_PAYLOAD) {
    this.onMessage = onMessage;
    this.maxPayload = maxPayload;
    this.header = Buffer.alloc(HEADER_SIZE);
    this.headerFill = 0;
    this.payload = null;
    this.payloadFill = 0;
    this.type = 0;
    this.seq = 0;
  }

  push(chunk) {
    let pos = 0;
    while (pos < chunk.length) {
      if (!this.payload) {
        const take = Math.min(HEADER_SIZE - this.headerFill, chunk.length - pos);
        chunk.copy(this.header, this.headerFill, pos, pos + take);
        this.headerFill += take;
        pos += take;
        const check = Math.min(this.headerFill, 4);
        for (let i = 0; i < check; i += 1) {
          if (this.header[i] !== MAGIC[i]) throw new ProtocolError('bad magic');
        }
        if (this.headerFill < HEADER_SIZE) continue;

        const length = this.header.readUInt32LE(8);
        if (length > this.maxPayload) throw new ProtocolError(`payload too large (${length} bytes)`);
        this.type = this.header[4];
        this.seq = this.header.readUInt32LE(12);
        this.headerFill = 0;
        if (length === 0) {
          this.onMessage({ type: this.type, seq: this.seq, payload: Buffer.alloc(0) });
          continue;
        }
        this.payload = Buffer.allocUnsafe(length);
        this.payloadFill = 0;
      } else {
        const take = Math.min(this.payload.length - this.payloadFill, chunk.length - pos);
        chunk.copy(this.payload, this.payloadFill, pos, pos + take);
        this.payloadFill += take;
        pos += take;
        if (this.payloadFill === this.payload.length) {
          const payload = this.payload;
          this.payload = null;
          this.payloadFill = 0;
          this.onMessage({ type: this.type, seq: this.seq, payload });
        }
      }
    }
  }
}

// Decodes a type-1 payload; null when it is not a usable JPEG frame.
function parseFramePayload(payload) {
  if (payload.length < FRAME_META_SIZE + 4) return null;
  const jpeg = payload.subarray(FRAME_META_SIZE);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const ticks = payload.readBigInt64LE(8);
  const fpsNum = payload.readUInt32LE(16);
  const fpsDen = payload.readUInt32LE(20);
  return {
    width: payload.readUInt16LE(0),
    height: payload.readUInt16LE(2),
    seqWidth: payload.readUInt16LE(4),
    seqHeight: payload.readUInt16LE(6),
    ticks,
    time: Number(ticks) / Number(TICKS_PER_SECOND),
    fpsNum,
    fpsDen,
    jpeg,
  };
}

// Encoders (used by tools and tests; the helper itself only receives).
function message(type, seq, payload) {
  const head = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(head, 0);
  head[4] = type;
  head.writeUInt32LE(payload.length, 8);
  head.writeUInt32LE(seq >>> 0, 12);
  return Buffer.concat([head, payload]);
}

function frameMessage(seq, jpeg, { width, height, seqWidth = width, seqHeight = height, ticks = 0n, fpsNum = 25, fpsDen = 1 }) {
  const meta = Buffer.alloc(FRAME_META_SIZE);
  meta.writeUInt16LE(width, 0);
  meta.writeUInt16LE(height, 2);
  meta.writeUInt16LE(seqWidth, 4);
  meta.writeUInt16LE(seqHeight, 6);
  meta.writeBigInt64LE(BigInt(ticks), 8);
  meta.writeUInt32LE(fpsNum, 16);
  meta.writeUInt32LE(fpsDen, 20);
  return message(TYPE_FRAME_JPEG, seq, Buffer.concat([meta, jpeg]));
}

module.exports = {
  FrameParser,
  ProtocolError,
  parseFramePayload,
  message,
  frameMessage,
  MAX_PAYLOAD,
  HEADER_SIZE,
  FRAME_META_SIZE,
  TICKS_PER_SECOND,
  TYPE_FRAME_JPEG,
  TYPE_STATE,
  TYPE_HEARTBEAT,
};
