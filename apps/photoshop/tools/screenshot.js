'use strict';

// Development helper: true mobile-emulated screenshot of the viewer.
//
//   node tools\screenshot.js <url> <out.png> [--tips]
//
// Spawns headless Chrome, sets a 390x844 mobile viewport at DPR 2, waits for
// the first frame, optionally keeps the tips dialog open, and captures a PNG.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('../relay/node_modules/ws');

const url = process.argv[2] || 'http://127.0.0.1:47823/';
const out = process.argv[3] || path.join(__dirname, '..', 'build', 'screenshot.png');
const keepTips = process.argv.includes('--tips');
const chromePath =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9333;
const profileDir = path.join(os.tmpdir(), `lpp-cdp-${Date.now()}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let pageSocket = null;

async function main() {
  await waitForChrome();

  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: 'PUT',
  }).then((response) => response.json());

  pageSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    pageSocket.once('open', resolve);
    pageSocket.once('error', reject);
  });

  const send = makeSender(pageSocket);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await send('Page.navigate', { url });
  await sleep(1200);

  // Wait for the first decoded frame.
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await send('Runtime.evaluate', {
      expression:
        "(() => { const img = document.querySelector('.frame.active'); return img ? img.naturalWidth : 0; })()",
      returnByValue: true,
    });
    if (result.result && result.result.value > 0) break;
    await sleep(250);
  }

  await sleep(700);

  if (process.argv.includes('--zoom')) {
    await send('Runtime.evaluate', {
      expression: "document.getElementById('zoomBtn').click()",
      returnByValue: true,
    });
    await sleep(450);
  }

  if (!keepTips) {
    await send('Runtime.evaluate', {
      expression:
        "(() => { const tips = document.getElementById('tips'); if (tips && !tips.hidden) { document.getElementById('tipsClose').click(); return true; } return false; })()",
      returnByValue: true,
    });
    await sleep(300);
  }

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('wrote', out);
}

function makeSender(ws) {
  let nextId = 1;
  const pending = new Map();

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 15000);
    });
}

async function waitForChrome() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('Chrome did not open the debugging port');
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (pageSocket) pageSocket.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
    await sleep(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
