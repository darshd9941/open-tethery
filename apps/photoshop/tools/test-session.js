'use strict';

// Development helper: verifies that stopping the preview ends paired viewers.
//
//   node tools\test-session.js [token]
//
// A viewer connects and waits for the first frame, then a plugin connection
// sends "stop". The viewer must close with code 4003.

const fs = require('fs');
const path = require('path');
const WebSocket = require('../relay/node_modules/ws');

const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = config.port || 47823;
const token = process.argv[2] || 'testtoken0123456789abcdef0123456789';
const url = `ws://127.0.0.1:${port}/ws`;

const viewer = new WebSocket(url);
let sawFrame = false;
let exitCode = 0;

const timeout = setTimeout(() => {
  console.error('FAIL: timed out');
  process.exit(1);
}, 12000);

viewer.on('open', () => {
  viewer.send(JSON.stringify({ type: 'hello', role: 'viewer', token }));
});

viewer.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'welcome') {
    console.log('viewer welcome, pluginOnline=' + message.pluginOnline);
  }
  if (message.type === 'frame') {
    sawFrame = true;
    console.log('viewer got a frame; asking the plugin to stop');
    stopViaPlugin();
  }
});

viewer.on('close', (code, reason) => {
  console.log(`viewer closed code=${code} reason=${reason.toString()}`);
  if (code !== 4003) exitCode = 1;
  clearTimeout(timeout);
  setTimeout(() => process.exit(exitCode), 200);
});

function stopViaPlugin() {
  const plugin = new WebSocket(url);
  plugin.on('open', () => {
    plugin.send(JSON.stringify({ type: 'register', token, name: 'stop test' }));
  });
  plugin.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === 'registered') {
      plugin.send(JSON.stringify({ type: 'stop' }));
    }
  });
  plugin.on('error', (error) => {
    console.error('plugin error:', error.message);
    process.exit(1);
  });
}

viewer.on('error', (error) => {
  console.error('viewer error:', error.message);
  process.exit(1);
});
