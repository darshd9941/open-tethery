#!/usr/bin/env node
'use strict';

// Fake Premiere Transmit plugin: speaks OTX1 (docs/transmit-protocol.md) to the helper.
//   node tools/fake-transmit.js [jpegPath] [--port 47826] [--seconds N] [--fps 15]
// Sends a state message, JPEG frames with a moving playhead, and heartbeats when idle.

const net = require('net');
const fs = require('fs');
const { message, frameMessage, TICKS_PER_SECOND, TYPE_STATE, TYPE_HEARTBEAT } = require('../lib/otx1');
const { JPEG } = require('./testcard');

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

// Returns a controller; resolves once connected.
function connectTransmit({ port = 47826, jpeg = JPEG, seqWidth = 1920, seqHeight = 1080, fpsNum = 25, fpsDen = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const size = jpegSize(jpeg);
    let seq = 0;
    const ctl = {
      socket,
      sendState: (obj) => socket.write(message(TYPE_STATE, seq++, Buffer.from(JSON.stringify(obj)))),
      sendHeartbeat: () => socket.write(message(TYPE_HEARTBEAT, seq++, Buffer.alloc(0))),
      // seconds = playhead position
      sendFrame: (seconds = 0) =>
        socket.write(
          frameMessage(seq++, jpeg, {
            ...size,
            seqWidth,
            seqHeight,
            ticks: BigInt(Math.round(seconds * 1000)) * (TICKS_PER_SECOND / 1000n),
            fpsNum,
            fpsDen,
          }),
        ),
      write: (buf) => socket.write(buf),
      close: () => socket.destroy(),
      size,
    };
    socket.once('connect', () => resolve(ctl));
    socket.once('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const jpegPath = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  const port = Number(opt('--port', 47826));
  const fps = Number(opt('--fps', 15));
  const seconds = Number(opt('--seconds', 0));
  const jpeg = jpegPath ? fs.readFileSync(jpegPath) : JPEG;
  const ctl = await connectTransmit({ port, jpeg });
  console.log(`fake-transmit: ${ctl.size.width}x${ctl.size.height} JPEG, ${jpeg.length} bytes, ${fps} fps -> 127.0.0.1:${port}`);
  ctl.sendState({ app: 'premiere', playing: true, sequence: 'Fake Sequence', pluginVersion: '0.0.0-fake' });
  let t = 0;
  let sent = 0;
  const timer = setInterval(() => {
    if (ctl.socket.writableLength > 4 * 1024 * 1024) return; // newest frame wins
    ctl.sendFrame(t);
    t += 1 / fps;
    sent += 1;
  }, Math.round(1000 / fps));
  ctl.socket.on('close', () => {
    console.log(`fake-transmit: closed after ${sent} frames`);
    process.exit(0);
  });
  ctl.socket.on('error', (e) => console.error(`fake-transmit: ${e.message}`));
  if (seconds > 0) setTimeout(() => ctl.close(), seconds * 1000);
  process.on('SIGINT', () => {
    clearInterval(timer);
    ctl.close();
  });
}

if (require.main === module) main().catch((e) => {
  console.error(`fake-transmit: ${e.message}`);
  process.exit(1);
});

module.exports = { connectTransmit, jpegSize };
