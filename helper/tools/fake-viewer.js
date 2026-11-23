#!/usr/bin/env node
'use strict';

// Fake phone viewer.
//   node tools/fake-viewer.js CODE [--port 47825] [--seconds 10] [--audio] [--name "Fake phone"]
// Prints state changes and frame/stats summaries. Also exported for tests.

const { connectClient } = require('./wsclient');

async function connectViewer({ port = 47825, host, code, name = 'Fake viewer', accept = ['jpeg', 'pcm'] }) {
  const client = await connectClient({ port, host, hello: { t: 'hello', role: 'viewer', code, name, protocol: 1, accept } });
  client.welcome = () => client.waitFor('welcome');
  return client;
}

async function main() {
  const args = process.argv.slice(2);
  const code = args.find((a) => !a.startsWith('--') && /^[A-Za-z0-9]{4}$/.test(a));
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  if (!code) {
    console.error('usage: fake-viewer.js CODE [--port N] [--seconds N] [--audio] [--name NAME]');
    process.exit(2);
  }
  const port = Number(opt('--port', 47825));
  const v = await connectViewer({ port, code, name: opt('--name', 'Fake viewer') });
  let frames = 0;
  let bytes = 0;
  v.ws.on('message', (data, isBinary) => {
    if (isBinary) {
      frames += 1;
      bytes += data.length;
      return;
    }
    const m = JSON.parse(data.toString('utf8'));
    if (m.t === 'stats') console.log(`stats fps=${m.fps} kbps=${m.kbps} dropped=${m.dropped} | received ${frames} binary msgs, ${bytes} bytes`);
    else console.log(JSON.stringify(m));
  });
  if (args.includes('--audio')) v.send({ t: 'audio', on: true });
  const seconds = Number(opt('--seconds', 0));
  if (seconds > 0) setTimeout(() => v.close(), seconds * 1000);
  v.ws.on('close', () => process.exit(0));
}

if (require.main === module) main();

module.exports = { connectViewer };
