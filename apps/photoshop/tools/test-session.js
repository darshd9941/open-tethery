'use strict';

// Development helper: verifies that stopping the preview ends paired viewers.
//
//   node tools\test-session.js [token]
//
// A viewer connects and waits for the first frame, then a plugin connection
// sends "stop". The viewer must close with code 4003.
//
// Afterwards the 4-letter code pairing is checked: the plugin's "registered"
// message carries a code, /api/join returns the token for the right code, a wrong
// code gets 404, the 6th wrong try gets 429, and the plugin is told how many
// phones are watching.
//
//   node tools\test-session.js --join-only   (only the code checks)
//
// Set OPEN_TETHERY_PORT to test against a relay on another port.

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
const token = process.argv[2] || 'testtoken0123456789abcdef0123456789';
const url = `ws://127.0.0.1:${port}/ws`;
const joinOnly = process.argv.includes('--join-only');

function fail(message) {
  console.error('FAIL: ' + message);
  process.exit(1);
}

async function getJoin(code) {
  const res = await fetch(`http://127.0.0.1:${port}/api/join?code=${encodeURIComponent(code)}`);
  return { status: res.status, body: await res.json() };
}

async function joinChecks() {
  const joinToken = 'jointoken0123456789abcdef0123456789';
  const plugin = new WebSocket(url);
  const statuses = [];
  const registered = await new Promise((resolve, reject) => {
    plugin.on('open', () => plugin.send(JSON.stringify({ type: 'register', token: joinToken, name: 'join test' })));
    plugin.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'registered') resolve(m);
      if (m.type === 'status' && typeof m.viewers === 'number') statuses.push(m.viewers);
    });
    plugin.on('error', reject);
  });
  if (!/^[A-HJ-NP-Z2-9]{4}$/.test(String(registered.code))) fail('registered.code is not a 4-character code: ' + registered.code);
  console.log('ok: registered carries code ' + registered.code);

  const info = await (await fetch(`http://127.0.0.1:${port}/info`)).json();
  if (info.code !== registered.code) fail('/info does not show the code to loopback');
  console.log('ok: /info shows the code on loopback');

  const good = await getJoin('  ' + registered.code.toLowerCase() + ' ');
  if (good.status !== 200 || good.body.token !== joinToken) fail('right code (lower case, padded) did not return the token: ' + JSON.stringify(good));
  console.log('ok: /api/join with the right code returns the token');

  // A viewer joining must be reported to the plugin.
  const viewerWs = new WebSocket(url);
  await new Promise((resolve) => {
    viewerWs.on('open', () => viewerWs.send(JSON.stringify({ type: 'hello', role: 'viewer', token: joinToken })));
    viewerWs.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'welcome') resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  if (!statuses.includes(1)) fail('plugin was not told a viewer joined: ' + JSON.stringify(statuses));
  viewerWs.close();
  await new Promise((r) => setTimeout(r, 300));
  if (statuses[statuses.length - 1] !== 0) fail('plugin was not told the viewer left: ' + JSON.stringify(statuses));
  console.log('ok: plugin receives viewer counts ' + JSON.stringify(statuses));

  const wrong = registered.code === 'AAAA' ? 'BBBB' : 'AAAA';
  for (let i = 1; i <= 5; i += 1) {
    const r = await getJoin(wrong);
    if (r.status !== 404 || r.body.error !== 'wrong-code') fail(`wrong try ${i} should be 404 wrong-code, got ` + JSON.stringify(r));
  }
  console.log('ok: wrong code gives 404 wrong-code (5 times)');
  const locked = await getJoin(wrong);
  if (locked.status !== 429 || locked.body.error !== 'locked' || !(locked.body.retryAfterSec > 0)) fail('6th wrong try should be 429 locked, got ' + JSON.stringify(locked));
  console.log('ok: 6th wrong try gives 429 locked (retryAfterSec=' + locked.body.retryAfterSec + ')');

  plugin.send(JSON.stringify({ type: 'stop' }));
  await new Promise((r) => setTimeout(r, 200));
  plugin.close();
}


if (joinOnly) {
  joinChecks().then(
    () => {
      console.log('PASS: join checks');
      process.exit(0);
    },
    (error) => fail(error.message)
  );
} else {
  runSessionTest();
}

function runSessionTest() {
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
  if (exitCode) {
    setTimeout(() => process.exit(exitCode), 200);
    return;
  }
  // Session ended correctly; now check the 4-letter code pairing on a clean relay.
  setTimeout(() => {
    joinChecks().then(
      () => {
        console.log('PASS: session end + join checks');
        process.exit(0);
      },
      (error) => fail(error.message)
    );
  }, 300);
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
}
