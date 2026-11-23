'use strict';

// Development helper: pretends to be the Photoshop plugin, so the relay and
// viewer can be tested without opening Photoshop.
//
//   node tools\mock-plugin.js [token] [--loop]
//
// Run Start Live Preview.bat first.

const fs = require('fs');
const path = require('path');
let WebSocket;
try {
  WebSocket = require('../relay/node_modules/ws');
} catch {
  WebSocket = require('ws'); // e.g. via NODE_PATH
}

const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = Number(process.env.OPEN_TETHERY_PORT) || config.port || 47823;
const token = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : 'testtoken0123456789abcdef0123456789';
const loop = process.argv.includes('--loop');
const profile = process.argv.includes('--p3') ? 'Display P3' : 'sRGB IEC61966-2.1';
const image = fs.readFileSync(path.join(ROOT, 'build', 'test-frame.jpg'));
const base64 = image.toString('base64');

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', token, name: 'Mock Photoshop', version: 'test' }));
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'registered') {
    console.log('registered:', message.url, 'code:', message.code);
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(String(message.code || ''))) {
      console.error('FAIL: registered message has no valid 4-character code');
      process.exit(1);
    }
    sendFrame();
    if (loop) setInterval(sendFrame, 2500);
  }
  if (message.type === 'pong') console.log('pong');
  if (message.type === 'status' && typeof message.viewers === 'number') console.log('viewers:', message.viewers);
});

ws.on('close', (code, reason) => {
  console.log('closed', code, reason.toString());
  process.exit(0);
});

ws.on('error', (error) => {
  console.error('error:', error.message);
  process.exit(1);
});

let sent = 0;

function sendFrame() {
  if (ws.readyState !== WebSocket.OPEN) return;
  sent++;
  ws.send(JSON.stringify({
    type: 'frame',
    data: base64,
    meta: {
      name: 'Catalogue Test Frame.psd',
      width: 1400,
      height: 900,
      sourceWidth: 6000,
      sourceHeight: 3857,
      profile,
      timestamp: Date.now(),
      mock: sent,
    },
  }));
  console.log(`frame ${sent}: ${Math.round(image.length / 1024)} KB`);
}
