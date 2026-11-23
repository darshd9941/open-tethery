'use strict';

// OTX1 ingest: accepts frames from the native Premiere "Transmit" plugin over a
// loopback TCP socket. Protocol: docs/transmit-protocol.md.
//
// This module only knows about the wire format. server.js decides what to do
// with the decoded frames (broadcast to viewers etc.).

const net = require('net');

const MAGIC = Buffer.from('OTXF', 'ascii');
const HEADER_SIZE = 16;
const FRAME_META_SIZE = 24;
const MAX_PAYLOAD = 32 * 1024 * 1024;
const TICKS_PER_SECOND = 254016000000n;

const TYPE_FRAME_JPEG = 1;
const TYPE_STATE = 2;
const TYPE_HEARTBEAT = 3;

const IDLE_TIMEOUT_MS = 15000; // heartbeat is sent every 1 s, so 15 s of silence = dead

class ProtocolError extends Error {}

// Streaming parser. push() accepts arbitrary TCP chunks (split frames, several
// frames per chunk) and calls onMessage({ type, seq, payload }) per message.
// Throws ProtocolError on bad magic or oversized payload; caller should drop
// the connection. Payloads are copied into one pre-sized buffer, so cost is
// linear even for large frames.
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

        // Reject bad magic as early as possible.
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

// Premiere ticks + frame rate -> "HH:MM:SS:FF" (";" before FF for drop-frame
// 29.97 / 59.94). Unknown fps falls back to 24.
function ticksToTimecode(ticks, fpsNum, fpsDen) {
  let t = typeof ticks === 'bigint' ? ticks : BigInt(Math.trunc(Number(ticks) || 0));
  if (t < 0n) t = 0n;
  let num = Number(fpsNum) || 0;
  let den = Number(fpsDen) || 0;
  if (num <= 0 || den <= 0) {
    num = 24;
    den = 1;
  }
  // Absolute frame number at this playhead position.
  let frame = Number((t * BigInt(num)) / (TICKS_PER_SECOND * BigInt(den)));

  const nominal = Math.round(num / den);
  const dropFrame = den === 1001 && (nominal === 30 || nominal === 60);
  if (dropFrame) {
    const drop = nominal === 30 ? 2 : 4;
    const perMin = nominal * 60 - drop;
    const per10Min = nominal * 600 - drop * 9;
    const tenMins = Math.floor(frame / per10Min);
    const rem = frame % per10Min;
    frame += drop * 9 * tenMins;
    if (rem > drop) frame += drop * Math.floor((rem - drop) / perMin);
  }

  const ff = frame % nominal;
  const totalSeconds = Math.floor(frame / nominal);
  const pad = (n) => String(n).padStart(2, '0');
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${dropFrame ? ';' : ':'}${pad(ff)}`;
}

// Decodes a type-1 payload. Returns null if it is not a usable JPEG frame.
function parseFramePayload(payload) {
  if (payload.length < FRAME_META_SIZE + 4) return null;
  const jpeg = payload.subarray(FRAME_META_SIZE);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const fpsNum = payload.readUInt32LE(16);
  const fpsDen = payload.readUInt32LE(20);
  const ticks = payload.readBigInt64LE(8);
  return {
    width: payload.readUInt16LE(0),
    height: payload.readUInt16LE(2),
    seqWidth: payload.readUInt16LE(4),
    seqHeight: payload.readUInt16LE(6),
    ticks,
    fpsNum,
    fpsDen,
    fps: fpsNum > 0 && fpsDen > 0 ? fpsNum / fpsDen : 0,
    timecode: ticksToTimecode(ticks, fpsNum, fpsDen),
    jpeg,
  };
}

// Starts the TCP listener. Callbacks (all optional):
//   onFrame(frame, status)   decoded type-1 message (see parseFramePayload)
//   onChange(status)         connect / disconnect / state change
// Returns { server, status(), close() }.
function startTransmitIngest({ port, host = '127.0.0.1', onFrame, onChange, log = () => {} }) {
  let current = null; // the one live socket
  let state = {};
  let playing = false;
  let framesTotal = 0;
  let lastFrameAt = 0;
  let lastMessageAt = 0;
  let recent = []; // frame arrival times for the fps estimate

  function measuredFps() {
    const now = Date.now();
    recent = recent.filter((t) => now - t <= 2000);
    if (recent.length < 2) return 0;
    const span = (recent[recent.length - 1] - recent[0]) / 1000;
    return span > 0 ? Math.round(((recent.length - 1) / span) * 10) / 10 : 0;
  }

  function status() {
    return {
      connected: Boolean(current),
      playing: Boolean(current) && playing,
      fps: current ? measuredFps() : 0,
      sequence: typeof state.sequence === 'string' ? state.sequence : null,
      app: typeof state.app === 'string' ? state.app : null,
      pluginVersion: typeof state.pluginVersion === 'string' ? state.pluginVersion : null,
      framesTotal,
      lastFrameAt,
      lastMessageAt,
    };
  }

  function changed() {
    if (onChange) {
      try {
        onChange(status());
      } catch (err) {
        log(`transmit onChange error: ${err.message}`);
      }
    }
  }

  const server = net.createServer((socket) => {
    // Newest connection wins.
    if (current) {
      log('transmit: newer plugin connection replaces the old one');
      const old = current;
      current = null;
      old.replaced = true;
      old.destroy();
    }
    current = socket;
    state = {};
    playing = false;
    recent = [];
    lastMessageAt = Date.now();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setTimeout(IDLE_TIMEOUT_MS);
    log(`transmit: plugin connected from ${socket.remoteAddress}:${socket.remotePort}`);

    const parser = new FrameParser((msg) => {
      if (current !== socket) return;
      lastMessageAt = Date.now();
      if (msg.type === TYPE_FRAME_JPEG) {
        const frame = parseFramePayload(msg.payload);
        if (!frame) {
          log('transmit: dropped malformed frame message');
          return;
        }
        framesTotal += 1;
        lastFrameAt = lastMessageAt;
        recent.push(lastFrameAt);
        if (recent.length > 120) recent.shift();
        if (onFrame) {
          try {
            onFrame(frame, status(), state);
          } catch (err) {
            log(`transmit onFrame error: ${err.message}`);
          }
        }
      } else if (msg.type === TYPE_STATE) {
        try {
          const parsed = JSON.parse(msg.payload.toString('utf8'));
          if (parsed && typeof parsed === 'object') {
            state = { ...state, ...parsed };
            if (typeof parsed.playing === 'boolean') playing = parsed.playing;
            changed();
          }
        } catch {
          log('transmit: ignored invalid state JSON');
        }
      } else if (msg.type === TYPE_HEARTBEAT) {
        // lastMessageAt already updated
      }
      // Unknown types (e.g. future H.264) are ignored.
    });

    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (err) {
        log(`transmit: protocol error (${err.message}); dropping connection`);
        socket.destroy();
      }
    });
    socket.on('timeout', () => {
      log('transmit: plugin silent too long; dropping connection');
      socket.destroy();
    });
    socket.on('error', (err) => {
      log(`transmit: socket error: ${err.message}`);
    });
    socket.on('close', () => {
      if (socket.replaced) return;
      if (current === socket) {
        current = null;
        playing = false;
        log('transmit: plugin disconnected');
        changed();
      }
    });

    changed();
  });

  server.on('error', (err) => {
    log(`transmit: listener error on ${host}:${port}: ${err.message}`);
  });
  server.listen(port, host, () => {
    log(`transmit: listening on ${host}:${port}`);
  });

  return {
    server,
    status,
    close() {
      if (current) current.destroy();
      server.close();
    },
  };
}

module.exports = {
  startTransmitIngest,
  FrameParser,
  ProtocolError,
  ticksToTimecode,
  parseFramePayload,
  MAX_PAYLOAD,
  HEADER_SIZE,
  FRAME_META_SIZE,
  TICKS_PER_SECOND,
};
