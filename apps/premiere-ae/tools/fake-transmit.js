#!/usr/bin/env node
'use strict';

// Fake Premiere Transmit plugin: speaks OTX1 (docs/transmit-protocol.md) to the relay.
//   node tools/fake-transmit.js [jpegPath] [--port 47826] [--seconds N] [--fps 15]
// Sends a state message on connect, 15 fps JPEG frames with a moving playhead,
// and a heartbeat every second while no frame was sent (see --pause-after).

const net = require('net');
const fs = require('fs');

// 320x180 gradient test card (baseline JPEG).
const BUILTIN_JPEG_B64 = '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';

const TICKS_PER_SECOND = 254016000000n;

function parseArgs(argv) {
  const opts = { jpeg: null, port: 47826, seconds: 0, fps: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--seconds') opts.seconds = Number(argv[++i]);
    else if (a === '--fps') opts.fps = Number(argv[++i]);
    else if (!a.startsWith('--')) opts.jpeg = a;
  }
  return opts;
}

// Reads width/height from the first SOFn marker.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker found; not a JPEG?');
}

function message(type, seq, payload) {
  const head = Buffer.alloc(16);
  head.write('OTXF', 0, 'ascii');
  head[4] = type;
  head.writeUInt32LE(payload.length, 8);
  head.writeUInt32LE(seq >>> 0, 12);
  return Buffer.concat([head, payload]);
}

function frameMessage(seq, jpeg, size, ticks, fpsNum, fpsDen) {
  const meta = Buffer.alloc(24);
  meta.writeUInt16LE(size.width, 0);
  meta.writeUInt16LE(size.height, 2);
  meta.writeUInt16LE(1920, 4);
  meta.writeUInt16LE(1080, 6);
  meta.writeBigInt64LE(ticks, 8);
  meta.writeUInt32LE(fpsNum, 16);
  meta.writeUInt32LE(fpsDen, 20);
  return message(1, seq, Buffer.concat([meta, jpeg]));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jpeg = opts.jpeg ? fs.readFileSync(opts.jpeg) : Buffer.from(BUILTIN_JPEG_B64, 'base64');
  const size = jpegSize(jpeg);
  console.log(`fake-transmit: ${size.width}x${size.height} JPEG, ${jpeg.length} bytes, ${opts.fps} fps -> 127.0.0.1:${opts.port}`);

  const FPS_NUM = 25;
  const FPS_DEN = 1;
  const ticksPerFrame = TICKS_PER_SECOND / BigInt(Math.round(opts.fps)); // real-time playhead

  const socket = net.connect(opts.port, '127.0.0.1');
  let seq = 0;
  let playhead = 0n;
  let sent = 0;
  let lastSend = Date.now();

  socket.on('error', (err) => {
    console.error(`fake-transmit: ${err.message}`);
    process.exit(1);
  });
  socket.on('close', () => {
    console.log(`fake-transmit: closed after ${sent} frames`);
    process.exit(0);
  });

  socket.on('connect', () => {
    const state = { app: 'premiere', playing: true, sequence: 'Fake Sequence', pluginVersion: '0.0.0-fake' };
    socket.write(message(2, seq++, Buffer.from(JSON.stringify(state))));

    const frameTimer = setInterval(() => {
      if (socket.writableLength > 4 * 1024 * 1024) return; // drop: newest frame wins
      socket.write(frameMessage(seq++, jpeg, size, playhead, FPS_NUM, FPS_DEN));
      playhead += ticksPerFrame;
      sent += 1;
      lastSend = Date.now();
    }, Math.round(1000 / opts.fps));

    const hbTimer = setInterval(() => {
      if (Date.now() - lastSend >= 1000) socket.write(message(3, seq++, Buffer.alloc(0)));
    }, 1000);

    const stop = () => {
      clearInterval(frameTimer);
      clearInterval(hbTimer);
      socket.end();
    };
    if (opts.seconds > 0) setTimeout(stop, opts.seconds * 1000);
    process.on('SIGINT', stop);
  });
}

if (require.main === module) main();

module.exports = { message, frameMessage, jpegSize };
