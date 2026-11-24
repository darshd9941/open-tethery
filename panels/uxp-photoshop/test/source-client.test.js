'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer, WebSocket } = require('ws');
const { SourceClient } = require('../js/source-client');

const HOST = { app: 'photoshop', appName: 'Photoshop', version: '27.1' };
const SEQ = { name: 'poster.psd', width: 4000, height: 2000, aspect: '2x1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error('timeout');
}

// Fake helper: answers hello with welcome, records everything.
function fakeHelper() {
  const wss = new WebSocketServer({ port: 0, path: '/ws' });
  const h = { wss, hellos: [], texts: [], binaries: [], sockets: [] };
  wss.on('connection', (ws) => {
    h.sockets.push(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return h.binaries.push(Buffer.from(data));
      const msg = JSON.parse(data.toString());
      if (msg.t === 'hello') {
        h.hellos.push(msg);
        ws.send(JSON.stringify({ t: 'welcome', id: 's1', role: 'source', protocol: 1, control: false }));
        ws.send(JSON.stringify({ t: 'state', status: 'idle', viewers: 2 }));
      } else h.texts.push(msg);
    });
  });
  return new Promise((resolve) => wss.on('listening', () => {
    h.url = 'ws://127.0.0.1:' + wss.address().port + '/ws';
    resolve(h);
  }));
}

function makeClient(h, extra) {
  const events = { status: [], states: [], errors: [] };
  const client = new SourceClient({
    url: h.url,
    WebSocketImpl: WebSocket,
    host: HOST,
    reconnectMs: 20,
    onStatus: (s) => events.status.push(s),
    onState: (s) => events.states.push(s),
    onError: (e) => events.errors.push(e),
    ...extra,
  });
  return { client, events };
}

const META = { width: 1600, height: 800, srcWidth: 4000, srcHeight: 2000 };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

test('hello, source-state and binary frame', async () => {
  const h = await fakeHelper();
  const { client, events } = makeClient(h);
  client.setSequence(SEQ); // before connecting: sent after welcome
  assert.equal(makeClient(h).client.sendFrame(JPEG, META), false); // not connected: dropped
  client.start();
  await until(() => client.connected);

  assert.deepEqual(h.hellos[0], { t: 'hello', role: 'source', protocol: 1, name: 'Pocket Monitor (Photoshop)' });
  await until(() => h.texts.length === 1);
  assert.deepEqual(h.texts[0], { t: 'source-state', host: HOST, sequence: SEQ });
  assert.equal(events.states[0].viewers, 2);

  assert.equal(client.sendFrame(JPEG, META), true);
  await until(() => h.binaries.length === 1);
  const b = h.binaries[0];
  assert.equal(b.toString('latin1', 0, 4), 'OTV1');
  assert.equal(b[4], 1);
  assert.equal(b.readUInt32LE(8), 1);
  assert.equal(b.readUInt16LE(24), 1600);
  assert.equal(b.readUInt16LE(30), 2000);
  assert.deepEqual(Array.from(b.subarray(32)), Array.from(JPEG));

  client.sendFrame(JPEG, META);
  await until(() => h.binaries.length === 2);
  assert.equal(h.binaries[1].readUInt32LE(8), 2);

  client.stop();
  h.wss.close();
});

test('setSequence while connected sends a new source-state', async () => {
  const h = await fakeHelper();
  const { client } = makeClient(h);
  client.start();
  await until(() => client.connected);
  client.setSequence({ ...SEQ, name: 'b.psd' });
  await until(() => h.texts.length === 1);
  assert.equal(h.texts[0].sequence.name, 'b.psd');
  client.stop();
  h.wss.close();
});

test('reconnects after the helper drops the socket and re-sends state and frame', async () => {
  const h = await fakeHelper();
  const { client, events } = makeClient(h);
  client.setSequence(SEQ);
  client.start();
  await until(() => client.connected);
  client.sendFrame(JPEG, META);
  await until(() => h.binaries.length === 1);

  h.sockets[0].terminate();
  await until(() => events.status.includes('disconnected'));
  await until(() => h.hellos.length === 2 && client.connected);
  await until(() => h.texts.filter((m) => m.t === 'source-state').length === 2);
  await until(() => h.binaries.length === 2); // last frame replayed on welcome

  client.stop();
  h.wss.close();
});

test('keeps retrying while the helper is down', async () => {
  const h = await fakeHelper();
  const url = h.url;
  const port = h.wss.address().port;
  await new Promise((r) => h.wss.close(r));
  const { client } = makeClient({ url });
  client.start();
  await sleep(80);
  assert.equal(client.connected, false);
  const wss = new WebSocketServer({ port, path: '/ws' });
  wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ t: 'welcome' }))));
  await until(() => client.connected);
  client.stop();
  wss.close();
});
