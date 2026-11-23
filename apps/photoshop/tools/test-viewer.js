'use strict';

// Development helper: connects to the relay exactly like the phone viewer.
//
//   node tools\test-viewer.js [token] [--bad]
//
// Saves the received frame to build\received.jpg and verifies that the embedded
// ICC profile is the one the relay was asked to inject.

const fs = require('fs');
const path = require('path');
const WebSocket = require('../relay/node_modules/ws');

const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = config.port || 47823;

const args = process.argv.slice(2);
const bad = args.includes('--bad');
const expectP3 = args.includes('--p3');
const token = bad
  ? 'wrongtoken0123456789abcdef0123456789'
  : args.find((arg) => !arg.startsWith('--')) || 'testtoken0123456789abcdef0123456789';

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let gotFrame = false;
let exitCode = 0;

const timeout = setTimeout(() => {
  console.error('FAIL: timed out waiting for a frame');
  process.exit(1);
}, 12000);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'viewer', token }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  if (message.type === 'welcome') {
    console.log('welcome: pluginOnline=' + message.pluginOnline + ' hasFrame=' + message.hasFrame);
    if (bad) {
      console.error('FAIL: a wrong token was accepted');
      exitCode = 1;
      ws.close();
    }
    return;
  }

  if (message.type === 'error' && bad) {
    console.log('expected rejection: ' + message.message);
    return;
  }

  if (message.type === 'frame') {
    gotFrame = true;
    const jpeg = Buffer.from(message.data, 'base64');
    const out = path.join(ROOT, 'build', 'received.jpg');
    fs.writeFileSync(out, jpeg);

    console.log(`frame: ${message.meta.name} ${message.meta.width}x${message.meta.height} profile=${message.meta.profile}`);
    console.log(`bytes=${jpeg.length} saved=${out}`);

    const icc = extractIcc(jpeg);
    if (!icc.length) {
      console.error('FAIL: no ICC profile in the received JPEG');
      exitCode = 1;
    } else {
      const expected = fs.readFileSync(
        path.join(ROOT, 'relay', 'profiles', expectP3 ? 'DisplayP3.icc' : 'sRGB.icc')
      );
      const matches = icc.equals(expected);
      console.log(`icc bytes=${icc.length} matches ${expectP3 ? 'DisplayP3.icc' : 'sRGB.icc'}=${matches}`);
      if (!matches) exitCode = 1;
    }

    clearTimeout(timeout);
    ws.close();
  }
});

ws.on('close', (code) => {
  clearTimeout(timeout);
  if (bad && code !== 4001) {
    console.error(`FAIL: expected close code 4001, got ${code}`);
    exitCode = 1;
  }
  if (!bad && !gotFrame) {
    console.error(`FAIL: closed without a frame (code ${code})`);
    exitCode = 1;
  }
  console.log('closed with code', code);
  process.exit(exitCode);
});

ws.on('error', (error) => {
  console.error('websocket error:', error.message);
  process.exit(1);
});

function extractIcc(jpeg) {
  if (jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return Buffer.alloc(0);
  let offset = 2;
  const chunks = [];
  while (offset + 1 < jpeg.length) {
    if (jpeg[offset] !== 0xFF) break;
    let markerAt = offset + 1;
    while (jpeg[markerAt] === 0xFF) markerAt++;
    const marker = jpeg[markerAt];
    if (marker === 0xD8 || marker === 0xD9) {
      offset = markerAt + 1;
      continue;
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      offset = markerAt + 1;
      continue;
    }
    const length = jpeg.readUInt16BE(markerAt + 1);
    const end = markerAt + 1 + length;
    if (marker === 0xE2 && jpeg.toString('latin1', markerAt + 3, markerAt + 15) === 'ICC_PROFILE\0') {
      chunks.push({
        seq: jpeg[markerAt + 15],
        data: jpeg.subarray(markerAt + 17, end),
      });
    }
    if (marker === 0xDA) break;
    offset = end;
  }
  chunks.sort((a, b) => a.seq - b.seq);
  return Buffer.concat(chunks.map((chunk) => chunk.data));
}
