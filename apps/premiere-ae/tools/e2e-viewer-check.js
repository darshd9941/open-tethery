#!/usr/bin/env node
'use strict';
// End-to-end check (relay must already be running):
//   node tools/e2e-viewer-check.js
// Starts fake-transmit, pairs like a phone (token from /info on loopback, then
// {type:'hello', role:'viewer', token} on /ws) and checks the binary frames.

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'relay', 'node_modules', 'ws'));

const HTTP_PORT = Number(process.env.RELAY_PORT || 47825);

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: HTTP_PORT, path: p }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve(JSON.parse(s)));
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

(async () => {
  const fake = spawn(process.execPath, [path.join(__dirname, 'fake-transmit.js'), '--seconds', '6'], { stdio: 'inherit' });
  let info;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    info = await getJson('/info').catch(() => null);
    if (info && info.pairUrl) break;
  }
  if (!info || !info.pairUrl) fail('no pairUrl in /info');
  const token = /pair=([A-Za-z0-9_-]+)/.exec(info.pairUrl)[1];

  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`);
  const frames = [];
  const statuses = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'viewer', token })));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const m = JSON.parse(data.toString());
      if (m.type === 'welcome' || m.type === 'status') statuses.push(m);
      return;
    }
    const metaLen = data.readUInt32LE(0);
    const meta = JSON.parse(data.subarray(4, 4 + metaLen).toString('utf8'));
    const jpeg = data.subarray(4 + metaLen);
    frames.push({ meta, jpegOk: jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[jpeg.length - 1] === 0xd9, bytes: jpeg.length });
  });

  await sleep(3000);
  const tx = await getJson('/info').then((i) => i.transmit);
  ws.close();
  fake.kill();

  const tcs = new Set(frames.map((f) => f.meta.timecode));
  console.log(`frames received: ${frames.length}`);
  console.log(`first: ${JSON.stringify(frames[0] && frames[0].meta)}`);
  console.log(`last timecode: ${frames.length && frames[frames.length - 1].meta.timecode}, distinct timecodes: ${tcs.size}`);
  console.log(`/info transmit: ${JSON.stringify(tx)}`);
  console.log(`status msgs with transmit.connected: ${statuses.filter((s) => s.transmit && s.transmit.connected).length}`);

  if (frames.length < 20) fail('expected >= 20 frames in 3 s at 15 fps');
  if (!frames.every((f) => f.jpegOk)) fail('a frame was not a complete JPEG');
  if (!frames.every((f) => f.meta.width === 320 && f.meta.height === 180)) fail('wrong width/height');
  if (tcs.size < frames.length * 0.9) fail('timecode is not changing');
  if (!tx.connected || tx.fps < 10) fail('transmit status/fps wrong');
  console.log('PASS');
  process.exit(0);
})().catch((e) => fail(e.message));
