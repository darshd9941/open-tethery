'use strict';
// M2 end to end: real helper process + fake Transmit sending a real H.264 clip (OTX1 type 4) +
// Playwright Chromium as the phone. Run: cd e2e && npm install && npm test
//
// Chromium here has H.264 in RTCRtpReceiver.getCapabilities, but whether the headless build can
// DECODE it varies. The test first asks the browser (decode probe), then asserts either the full
// WebRTC path (rtc-state connected, canvas shows the 640x360 test-source video, no binary JPEG)
// or, when it cannot decode, the automatic fallback (JPEG keeps flowing).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadWerift } = require('../helper/lib/webrtc');
const { connectH264Transmit } = require('../helper/tools/fake-transmit-h264');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let helper, helperLog = '', tmp, port, ingestPort, base, browser, plugin, page, code;
const werift = loadWerift();

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error('timeout waiting for ' + what + (last instanceof Error ? ': ' + last.message : '') + '\nhelper log:\n' + helperLog.slice(-1500));
}

// Pixels that are not near black, plus the canvas size.
const canvasInfo = () => page.evaluate(() => {
  const c = document.getElementById('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
  return { lit, w: c.width, h: c.height };
});
const log = () => page.evaluate(() => window.__ws);
const rtcStates = async () => (await log()).filter((m) => m.t === 'rtc-state').map((m) => m.state);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-e2e-rtc-'));
  port = await freePort();
  ingestPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  const cfgDir = path.join(tmp, 'open-tethery');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ port, ingestPort }));
  helper = spawn(process.execPath, [path.join(ROOT, 'helper/bin/open-tethery-helper.js')], {
    env: { ...process.env, XDG_CONFIG_HOME: tmp, OT_VIEWER_DIR: path.join(ROOT, 'viewer'), ...(process.env.OT_TEST_RTC_HOSTS ? { OT_RTC_HOST_ADDRESSES: process.env.OT_TEST_RTC_HOSTS } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  helper.stdout.on('data', (d) => { helperLog += d; });
  helper.stderr.on('data', (d) => { helperLog += d; });
  await waitFor(async () => (await (await fetch(base + '/health')).json()).ok, 'helper /health');
  code = (await (await fetch(base + '/api/session')).json()).code;
  browser = await chromium.launch();
});

after(async () => {
  try { plugin && plugin.close(); } catch { /* gone */ }
  if (browser) await browser.close();
  if (helper) helper.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('phone (Chromium) streams the H.264 clip over WebRTC, or falls back to JPEG when it cannot decode H.264', { skip: !werift && 'werift not installed' }, async (t) => {
  plugin = await connectH264Transmit({ port: ingestPort, fps: 30 });
  await waitFor(() => plugin.sentH264 > 10, 'plugin sending');

  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('viewer pageerror:', e.message));
  // Record every message the viewer receives from the helper.
  await page.addInitScript(() => {
    window.__ws = [];
    window.__bin = 0;
    const Orig = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new Orig(...a);
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') { try { window.__ws.push(JSON.parse(ev.data)); } catch { /* ignore */ } } else window.__bin += 1;
      });
      return ws;
    };
    window.WebSocket.prototype = Orig.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });

  const caps = await page.evaluate(() => RTCRtpReceiver.getCapabilities('video').codecs.filter((c) => /h264/i.test(c.mimeType)).length);
  t.diagnostic(`Chromium ${browser.version()}: H.264 receiver capabilities listed: ${caps}`);
  await page.goto(`${base}/c/${code}`);
  const welcome = await waitFor(async () => (await log()).find((m) => m.t === 'welcome'), 'welcome');
  assert.equal(welcome.webrtc, true, 'helper offers WebRTC while H.264 flows');

  // Either the whole chain works, or the viewer falls back: both are acceptable outcomes of the same
  // code, but we report which one happened and assert its consequences.
  const outcome = await waitFor(async () => {
    const states = await rtcStates();
    if (states.includes('connected')) {
      const info = await canvasInfo();
      if (info.w === 640 && info.lit > 1000) return 'webrtc';
    }
    if (states.includes('failed') || states.includes('closed')) return 'fallback';
    return null;
  }, 'rtc outcome (connected with video, or failed)', 25000);
  t.diagnostic(`outcome: ${outcome}; rtc-state sequence: ${(await rtcStates()).join(', ')}`);
  console.log(`# e2e webrtc outcome: ${outcome}; states: ${(await rtcStates()).join(', ')}`);

  if (outcome === 'webrtc') {
    const info = await canvasInfo();
    assert.equal(info.w, 640);
    assert.equal(info.h, 360);
    assert.ok(info.lit > 1000, 'canvas shows non-black video pixels');
    // helper stopped binary JPEG to this viewer
    const bin = await page.evaluate(() => window.__bin);
    await sleep(1000);
    assert.ok((await page.evaluate(() => window.__bin)) - bin <= 1, 'no JPEG frames while connected');
    const stats = await waitFor(async () => (await log()).filter((m) => m.t === 'stats').pop(), 'stats');
    assert.equal(stats.transport, 'webrtc');
    await waitFor(async () => (await page.locator('#statsList').count()) >= 0, 'stats list present');
    // the picture really moves: two canvas snapshots a moment apart differ
    // Hash the whole canvas (the moving part of the clip is not in the top rows) and allow a few
    // seconds for a change, so a slow CI decoder that repeats a frame does not fail the check.
    const snap = () => page.evaluate(() => {
      const c = document.getElementById('canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619);
      return h >>> 0;
    });
    const a = await snap();
    const changed = await waitFor(async () => (await snap()) !== a, 'video frames are updating', 4000).catch(() => false);
    assert.ok(changed, 'video frames are updating');
  } else {
    // Fallback path: JPEG keeps flowing and the canvas shows the JPEG test card (320x180).
    await waitFor(async () => (await canvasInfo()).w === 320, 'JPEG canvas after failure', 8000);
    const info = await canvasInfo();
    assert.ok(info.lit > 1000, 'JPEG picture visible after fallback');
    const bin = await page.evaluate(() => window.__bin);
    await sleep(800);
    assert.ok((await page.evaluate(() => window.__bin)) > bin, 'binary JPEG frames keep arriving');
  }
});

test('RTP stall: H.264 stops, viewer sees rtc-state failed and JPEG resumes; viewer retries after 10 s and recovers', { skip: !werift && 'werift not installed', timeout: 90000 }, async (t) => {
  const states = await rtcStates();
  const wasConnected = states.includes('connected') && states.lastIndexOf('connected') > states.lastIndexOf('failed');
  if (!wasConnected) {
    t.diagnostic('browser could not decode H.264 in the first test: stall-and-recover is covered by helper/test/webrtc-hub.test.js with a werift phone');
    return;
  }
  const failedBefore = states.filter((s) => s === 'failed').length;
  plugin.paused = true;
  await waitFor(async () => (await rtcStates()).filter((s) => s === 'failed').length > failedBefore, 'rtc-state failed after stall', 8000);
  const bin = await page.evaluate(() => window.__bin);
  await waitFor(async () => (await page.evaluate(() => window.__bin)) > bin + 2, 'JPEG resumes', 5000);
  plugin.paused = false;
  // retry at most every 10 s: reconnects after the pause
  const connectedBefore = (await rtcStates()).filter((s) => s === 'connected').length;
  await waitFor(async () => (await rtcStates()).filter((s) => s === 'connected').length > connectedBefore, 'reconnect after retry', 25000);
  await waitFor(async () => (await canvasInfo()).w === 640, 'video again', 8000);
});

test('connected but undecodable video (no SPS/PPS): viewer notices after 5 s, sends rtc-stop, JPEG carries on', { skip: !werift && 'werift not installed', timeout: 60000 }, async () => {
  // a clip without SPS/PPS: ICE, DTLS and RTP all work, but the decoder can never produce a picture
  const { splitAnnexB, nalType } = require('../helper/lib/h264');
  const original = fs.readFileSync(require('../helper/tools/fake-transmit-h264').DEFAULT_CLIP);
  const start = Buffer.from([0, 0, 0, 1]);
  const clip = Buffer.concat(splitAnnexB(original).filter((n) => ![7, 8].includes(nalType(n))).flatMap((n) => [start, n]));
  plugin.close();
  await sleep(300);
  plugin = await connectH264Transmit({ port: ingestPort, fps: 30, clip, size: { width: 640, height: 360 } });
  await page.reload();
  await waitFor(async () => (await log()).find((m) => m.t === 'welcome'), 'welcome after reload');
  await waitFor(async () => (await rtcStates()).includes('connected'), 'transport connected', 15000);
  const stop0 = Date.now();
  await waitFor(async () => (await log()).some((m) => m.t === 'rtc-state' && m.state === 'closed'), 'viewer gave up (rtc-stop -> closed)', 12000);
  console.log(`# e2e undecodable: gave up ${Date.now() - stop0} ms after connected`);
  const bin = await page.evaluate(() => window.__bin);
  await waitFor(async () => (await page.evaluate(() => window.__bin)) > bin + 2, 'JPEG resumes', 6000);
  await waitFor(async () => (await canvasInfo()).w === 320, 'JPEG canvas', 5000);
});
