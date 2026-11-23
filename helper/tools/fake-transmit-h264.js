#!/usr/bin/env node
'use strict';

// Fake Transmit plugin that sends H.264 (OTX1 type 4) like the real encoder will,
// answers helper -> plugin messages (type 64 keyframe request, type 65 JPEG wanted)
// and sends low-fps JPEG alongside only while the helper asks for it.
//   node tools/fake-transmit-h264.js [clip.h264] [--port 47826] [--fps 30] [--seconds N]
// Make a clip: ffmpeg -f lavfi -i testsrc=size=640x360:rate=30 -t 4 -pix_fmt yuv420p -c:v libx264 \
//   -profile:v baseline -g 30 -bf 0 -x264-params repeat-headers=1 -bsf:v h264_mp4toannexb -f h264 clip.h264

const net = require('net');
const fs = require('fs');
const path = require('path');
const otx1 = require('../lib/otx1');
const { splitAnnexB, nalType } = require('../lib/h264');
const { jpegSize } = require('./fake-transmit');
const { JPEG } = require('./testcard');

const DEFAULT_CLIP = path.join(__dirname, '..', 'test', 'fixtures', 'testsrc-640x360.h264');

// Splits an Annex B stream into access units: a new unit starts at the first
// non-slice NAL (SPS/PPS/SEI/AUD) that follows a slice, or at a slice with first_mb_in_slice == 0.
function splitAccessUnits(stream) {
  const nals = splitAnnexB(stream);
  const units = [];
  let cur = null;
  let hasSlice = false;
  for (const nal of nals) {
    const t = nalType(nal);
    const isSlice = t === 1 || t === 5;
    const firstSlice = isSlice && (nal[1] & 0x80) !== 0; // first_mb_in_slice == 0 (ue(v) "1")
    if (!cur || (hasSlice && (!isSlice || firstSlice))) {
      cur = [];
      units.push(cur);
      hasSlice = false;
    }
    cur.push(nal);
    if (isSlice) hasSlice = true;
  }
  const start = Buffer.from([0, 0, 0, 1]);
  return units.map((u) => ({
    keyframe: u.some((n) => nalType(n) === 5),
    data: Buffer.concat(u.flatMap((n) => [start, n])),
  }));
}

// SPS: width/height of a baseline stream (no cropping handling beyond frame_cropping).
function h264Size(stream) {
  const sps = splitAnnexB(stream).find((n) => nalType(n) === 7);
  if (!sps) throw new Error('no SPS in clip');
  // un-escape emulation prevention bytes
  const rbsp = [];
  for (let i = 1; i < sps.length; i += 1) {
    if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0) continue;
    rbsp.push(sps[i]);
  }
  let pos = 0;
  const bit = () => (rbsp[pos >> 3] >> (7 - (pos++ & 7))) & 1;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | bit();
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (!bit()) zeros += 1;
    return (1 << zeros) - 1 + bits(zeros);
  };
  const se = () => {
    const k = ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  };
  const profile = bits(8);
  bits(16);
  ue(); // sps id
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128].includes(profile)) throw new Error('only baseline/main SPS supported');
  ue(); // log2_max_frame_num
  const pocType = ue();
  if (pocType === 0) ue();
  else if (pocType === 1) {
    bit();
    se();
    se();
    const n = ue();
    for (let i = 0; i < n; i += 1) se();
  }
  ue(); // max_num_ref_frames
  bit();
  const wMbs = ue() + 1;
  const hMapUnits = ue() + 1;
  const frameMbsOnly = bit();
  if (!frameMbsOnly) bit();
  bit();
  let width = wMbs * 16;
  let height = (2 - frameMbsOnly) * hMapUnits * 16;
  if (bit()) {
    const l = ue();
    const r = ue();
    const t = ue();
    const b = ue();
    width -= (l + r) * 2;
    height -= (t + b) * 2 * (2 - frameMbsOnly);
  }
  return { width, height };
}

function connectH264Transmit({ port = 47826, clip = DEFAULT_CLIP, fps = 30, jpeg = JPEG, jpegFps = 5, seqWidth, seqHeight, sendJpegAlways = false, size: sizeOverride } = {}) {
  return new Promise((resolve, reject) => {
    const stream = Buffer.isBuffer(clip) ? clip : fs.readFileSync(clip);
    const units = splitAccessUnits(stream);
    const size = sizeOverride || h264Size(stream);
    const jsize = jpegSize(jpeg);
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);
    let seq = 0;
    let index = 0;
    let t = 0;
    let timer = null;
    let jpegTimer = null;
    const ctl = {
      socket,
      units: units.length,
      size,
      keyframeRequests: 0,
      jpegWanted: true, // until the helper says otherwise
      sentH264: 0,
      sentJpeg: 0,
      paused: false, // true: stop sending H.264 (stall test)
      sendState: (obj) => socket.write(otx1.message(otx1.TYPE_STATE, seq++, Buffer.from(JSON.stringify(obj)))),
      sendHeartbeat: () => socket.write(otx1.message(otx1.TYPE_HEARTBEAT, seq++, Buffer.alloc(0))),
      sendUnit() {
        const u = units[index];
        index = (index + 1) % units.length; // loops; the clip starts on an IDR
        socket.write(otx1.h264Message(seq++, u.data, { keyframe: u.keyframe, ...size, ticks: BigInt(Math.round(t * 1000)) * (otx1.TICKS_PER_SECOND / 1000n) }));
        t += 1 / fps;
        ctl.sentH264 += 1;
      },
      sendJpeg() {
        socket.write(otx1.frameMessage(seq++, jpeg, { ...jsize, seqWidth: seqWidth || size.width, seqHeight: seqHeight || size.height, ticks: BigInt(Math.round(t * 1000)) * (otx1.TICKS_PER_SECOND / 1000n) }));
        ctl.sentJpeg += 1;
      },
      write: (buf) => socket.write(buf),
      close() {
        clearInterval(timer);
        clearInterval(jpegTimer);
        socket.destroy();
      },
    };
    const parser = new otx1.FrameParser((m) => {
      if (m.type === otx1.TYPE_REQUEST_KEYFRAME) {
        ctl.keyframeRequests += 1;
        index = 0; // the clip's first unit is an IDR
      } else if (m.type === otx1.TYPE_JPEG_WANTED) {
        const w = otx1.parseJpegWanted(m.payload);
        if (w !== null) ctl.jpegWanted = w;
      }
    });
    socket.on('data', (d) => {
      try {
        parser.push(d);
      } catch {
        socket.destroy();
      }
    });
    socket.once('connect', () => {
      ctl.sendState({ app: 'premiere', playing: true, sequence: 'Fake Sequence', pluginVersion: '0.0.0-fake-h264' });
      timer = setInterval(() => {
        if (ctl.paused || socket.writableLength > 4 * 1024 * 1024) return;
        ctl.sendUnit();
      }, Math.round(1000 / fps));
      jpegTimer = setInterval(() => {
        if ((ctl.jpegWanted || sendJpegAlways) && socket.writableLength < 1024 * 1024) ctl.sendJpeg();
      }, Math.round(1000 / jpegFps));
      resolve(ctl);
    });
    socket.once('error', reject);
    socket.on('close', () => {
      clearInterval(timer);
      clearInterval(jpegTimer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const clip = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || DEFAULT_CLIP;
  const ctl = await connectH264Transmit({ port: Number(opt('--port', 47826)), clip, fps: Number(opt('--fps', 30)) });
  console.log(`fake-transmit-h264: ${ctl.size.width}x${ctl.size.height}, ${ctl.units} units per loop -> 127.0.0.1`);
  const seconds = Number(opt('--seconds', 0));
  if (seconds > 0) setTimeout(() => ctl.close(), seconds * 1000);
  ctl.socket.on('close', () => process.exit(0));
  process.on('SIGINT', () => ctl.close());
}

if (require.main === module) main().catch((e) => {
  console.error(`fake-transmit-h264: ${e.message}`);
  process.exit(1);
});

module.exports = { connectH264Transmit, splitAccessUnits, h264Size, DEFAULT_CLIP };
