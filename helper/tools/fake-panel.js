#!/usr/bin/env node
'use strict';

// Fake Premiere panel (role "panel") and fake source (role "source").
//   node tools/fake-panel.js [--port 47825] [--app premiere] [--seconds N]
// Sends host-state, logs state / control messages and acks every control.

const { connectClient } = require('./wsclient');

const HOSTS = {
  premiere: { app: 'premiere', appName: 'Premiere Pro', version: '27.0' },
  aftereffects: { app: 'aftereffects', appName: 'After Effects', version: '27.0' },
  photoshop: { app: 'photoshop', appName: 'Photoshop', version: '27.0' },
};

const SEQUENCE = { name: 'Main edit', width: 3840, height: 2160, fpsNum: 24000, fpsDen: 1001, duration: 512.3 };

async function connectPanel({ port = 47825, host, app = 'premiere', autoAck = false } = {}) {
  const client = await connectClient({ port, host, hello: { t: 'hello', role: 'panel', app, protocol: 1 } });
  client.controls = [];
  client.ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(data.toString('utf8'));
    if (m.t === 'control') {
      client.controls.push(m);
      if (autoAck) client.send({ t: 'control-result', req: m.req, ok: true });
    }
  });
  client.sendHostState = (extra = {}) =>
    client.send({ t: 'host-state', host: HOSTS[app] || HOSTS.premiere, sequence: SEQUENCE, playing: false, time: 12.5, ...extra });
  return client;
}

// A source is the same socket with role "source" and source-state / binary frames.
async function connectSource({ port = 47825, host, app = 'photoshop' } = {}) {
  const client = await connectClient({ port, host, hello: { t: 'hello', role: 'source', protocol: 1 } });
  client.sendSourceState = (extra = {}) =>
    client.send({ t: 'source-state', host: HOSTS[app], sequence: { name: 'poster.psd', width: 1080, height: 1350 }, ...extra });
  return client;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const p = await connectPanel({ port: Number(opt('--port', 47825)), app: opt('--app', 'premiere'), autoAck: true });
  p.sendHostState();
  p.ws.on('message', (data, isBinary) => {
    if (!isBinary) console.log(data.toString('utf8'));
  });
  const seconds = Number(opt('--seconds', 0));
  if (seconds > 0) setTimeout(() => p.close(), seconds * 1000);
  p.ws.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { connectPanel, connectSource, HOSTS, SEQUENCE };
