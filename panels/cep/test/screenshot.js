'use strict';
// Headless layout check: node test/screenshot.js
// Serves a fake helper on a free port, stubs CSInterface, screenshots the panel at 320x560.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const OUT = path.join(__dirname, 'screenshots');
const INDEX = 'file://' + path.join(__dirname, '../client/index.html');

// Simple deterministic checkerboard standing in for the helper's real QR SVG.
function fakeQr() {
  let r = '';
  let seed = 7;
  for (let y = 0; y < 29; y++) for (let x = 0; x < 29; x++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    if (seed % 3 === 0) r += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/><g fill="#000">${r}</g></svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const live = { engine: true };
  const server = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ ok: true, name: 'open-tethery', version: '0.2.0', protocol: 1 }));
    if (req.url.startsWith('/api/qr.svg')) { res.setHeader('content-type', 'image/svg+xml'); return res.end(fakeQr()); }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      if (JSON.parse(d).t !== 'hello') return;
      ws.send(JSON.stringify({ t: 'welcome', id: 'p1', role: 'panel', protocol: 1 }));
      ws.send(JSON.stringify({
        t: 'state', status: live.engine ? 'live' : 'idle', code: 'CL7G',
        primaryUrl: 'http://192.168.1.20:47825/c/CL7G',
        host: { app: 'premiere', appName: 'Premiere Pro', version: '27.0' },
        sequence: { name: 'Main edit', width: 3840, height: 2160, fpsNum: 24000, fpsDen: 1001 },
        engine: { transmit: live.engine, sending: live.engine }, viewers: 2,
        viewerList: [{ id: 'v1', name: 'Pixel 8', ip: '192.168.1.31', delayMs: 140 }, { id: 'v2', name: 'iPhone 15', ip: '192.168.1.44', delayMs: 95 }]
      }));
      ws.send(JSON.stringify({ t: 'stats', fps: 23.9, kbps: 8400 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = '127.0.0.1:' + server.address().port;

  const browser = await chromium.launch();
  const shots = [['panel-live', true], ['panel-engine-off', false]];
  for (const [name, engine] of shots) {
    live.engine = engine;
    const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
    await page.addInitScript((h) => {
      window.__OT_CONFIG = { helperHost: h, devHelperPath: '' };
      window.CSInterface = function () { this.evalScript = (s, cb) => cb('{"ok":true}'); };
    }, host);
    await page.goto(INDEX);
    await page.waitForFunction(() => document.getElementById('code').textContent === 'CL7G');
    await page.waitForFunction(() => document.getElementById('qr').complete && document.getElementById('qr').naturalWidth > 0);
    const m = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { qr: r('qr'), code: r('code'), scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
    });
    console.log(name, 'qr', Math.round(m.qr.width) + 'x' + Math.round(m.qr.height), 'centreX', Math.round(m.qr.x + m.qr.width / 2),
      'scroll', m.scrollW + 'x' + m.scrollH);
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    await page.close();
  }

  // Helper-down card
  const page = await browser.newPage({ viewport: { width: 320, height: 560 } });
  await page.addInitScript(() => {
    window.__OT_CONFIG = { helperHost: '127.0.0.1:1', devHelperPath: '' };
    window.CSInterface = function () { this.evalScript = (s, cb) => cb('{"ok":true}'); };
  });
  await page.goto(INDEX);
  await page.waitForSelector('#helperCard:not([hidden])');
  await page.screenshot({ path: path.join(OUT, 'panel-helper-down.png') });
  await browser.close();
  wss.clients.forEach((c) => c.terminate());
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
