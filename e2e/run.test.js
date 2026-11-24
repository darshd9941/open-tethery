'use strict';
// End-to-end: real helper process, fake Transmit, CEP panel + phone viewer in Chromium,
// Photoshop source client in Node. Run: cd e2e && npm install && npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { chromium, devices } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');
const { connectTransmit } = require('../helper/tools/fake-transmit');
const { JPEG } = require('../helper/tools/testcard');
const { SourceClient } = require('../panels/uxp-photoshop/js/source-client');

let helper, helperLog = '', tmp, port, ingestPort, base, browser, transmit, frameTimer;
let session, panelPage, phone;
const calls = () => panelPage.evaluate(() => window.__calls || []); // scripts the stubbed CSInterface.evalScript received
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function json(p, init) {
  return (await fetch(base + p, init)).json();
}

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error('timeout waiting for ' + what + (last instanceof Error ? ': ' + last.message : '') + '\nhelper log:\n' + helperLog.slice(-1500));
}

// Counts canvas pixels that are not (near) black.
const litPixels = (page) => page.evaluate(() => {
  const c = document.getElementById('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
  return n;
});

// A raw viewer socket that records the JSON it receives.
async function rawViewer(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (d, isBin) => { if (!isBin) msgs.push(JSON.parse(d.toString())); });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', role: 'viewer', code: session.code, name, protocol: 1, accept: ['jpeg'] }));
  await waitFor(() => msgs.find((m) => m.t === 'welcome'), 'raw welcome');
  return { ws, msgs };
}

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-e2e-'));
  port = await freePort();
  ingestPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  const cfgDir = path.join(tmp, 'open-tethery');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ port, ingestPort }));
  helper = spawn(process.execPath, [path.join(ROOT, 'helper/bin/open-tethery-helper.js')], {
    env: { ...process.env, XDG_CONFIG_HOME: tmp, OT_VIEWER_DIR: path.join(ROOT, 'viewer') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  helper.stdout.on('data', (d) => { helperLog += d; });
  helper.stderr.on('data', (d) => { helperLog += d; });
  await waitFor(async () => (await json('/health')).ok, 'helper /health');
  browser = await chromium.launch();
});

after(async () => {
  clearInterval(frameTimer);
  try { transmit && transmit.close(); } catch { /* already gone */ }
  if (browser) await browser.close();
  if (helper) helper.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('helper serves health, session and viewer', async () => {
  assert.deepEqual(await json('/health'), { ok: true, name: 'open-tethery', product: 'Pocket Monitor', version: require('../helper/package.json').version, protocol: 1 });
  session = await json('/api/session');
  assert.match(session.code, /^[A-HJ-NP-Z2-9]{4}$/);
  const html = await (await fetch(`${base}/c/${session.code}`)).text();
  assert.match(html, /<canvas id="canvas"/);
});

test('panel shows code and QR, and the engine warning while Transmit is absent', async () => {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 } });
  panelPage = await ctx.newPage();
  panelPage.on('pageerror', (e) => console.log('panel pageerror:', e.message));
  await panelPage.addInitScript((host) => { window.__OT_CONFIG = { helperHost: host, devHelperPath: '' }; }, `127.0.0.1:${port}`);
  // Replace Adobe's CSInterface.js with a stub that records every evalScript call.
  await panelPage.route('**/lib/CSInterface.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `function CSInterface() {
      this.evalScript = function (s, cb) {
        (window.__calls = window.__calls || []).push(s);
        if (s.indexOf('otGetHostState') === 0) {
          cb(JSON.stringify({ ok: true, host: { app: 'premiere', appName: 'Premiere Pro', version: '27.0' },
            sequence: { name: 'Main edit', width: 1920, height: 1080, fpsNum: 25, fpsDen: 1, duration: 120 }, playing: false, time: 1.5 }));
        } else cb('{"ok":true}');
      };
    }`,
  }));
  await panelPage.addInitScript(() => { try { localStorage.setItem('ot.guide.seen', '1'); } catch (e) {} });
  await panelPage.goto('file://' + path.join(ROOT, 'panels/cep/client/index.html'));
  await panelPage.waitForFunction((c) => document.getElementById('code').textContent === c, session.code);
  await panelPage.waitForFunction(() => { const q = document.getElementById('qr'); return q.complete && q.naturalWidth > 0; });
  assert.equal(await panelPage.locator('#engineCard').isVisible(), true, 'engine warning shown with no Transmit');
  assert.match(await panelPage.locator('#engineSteps').textContent(), /Preferences/);
  await panelPage.screenshot({ path: path.join(SHOTS, 'panel-engine-off.png') });
});

test('Transmit connects: panel LIVE with sequence info, engine warning hides', async () => {
  transmit = await connectTransmit({ port: ingestPort, seqWidth: 1920, seqHeight: 1080 });
  transmit.sendState({ app: 'premiere', playing: false, sequence: 'Main edit', pluginVersion: '0.0.0-e2e' });
  let t = 0;
  frameTimer = setInterval(() => { transmit.sendFrame(t); t += 0.04; }, 66);
  await panelPage.waitForFunction(() => document.getElementById('pill').textContent === 'LIVE');
  await panelPage.waitForFunction(() => document.getElementById('engineCard').hidden);
  await panelPage.waitForFunction(() => document.getElementById('seqName').textContent === 'Main edit');
  assert.match(await panelPage.locator('#seqInfo').textContent(), /1920/);
  assert.equal(await panelPage.locator('#code').textContent(), session.code);
  assert.match(await panelPage.locator('#hostApp').textContent(), /Premiere/);
});

test('iPhone 13 viewer: picture, now-playing text, LIVE', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  phone = await ctx.newPage();
  phone.on('pageerror', (e) => console.log('phone pageerror:', e.message));
  await phone.goto(`${base}/c/${session.code}`);
  await phone.waitForFunction(() => document.getElementById('liveBadge').textContent === 'LIVE');
  await phone.waitForFunction(() => document.getElementById('cover').hidden);
  await waitFor(async () => (await litPixels(phone)) > 100, 'non-black canvas pixels');
  await waitFor(async () => /Main edit/.test(await phone.locator('#npSeq').textContent()), 'sequence name on phone');
  assert.match(await phone.locator('#npApp').textContent(), /Premiere/);
  assert.equal(await phone.locator('#tpPlay').isDisabled(), false);
  await panelPage.waitForFunction(() => document.querySelectorAll('#phoneList li:not(.empty)').length === 1);
  await panelPage.screenshot({ path: path.join(SHOTS, 'panel-live.png') });
  await phone.screenshot({ path: path.join(SHOTS, 'phone-live.png') });
});

test('play on the phone reaches the panel; Allow control off disables the phone transport', async () => {
  const raw = await rawViewer('raw-viewer');

  // Real phone tap -> panel evalScript
  const mark = (await calls()).length;
  await phone.locator('#tpPlay').tap();
  await waitFor(async () => (await calls()).slice(mark).find((s) => /^otControl\("(play|pause|toggle)"/.test(s)), 'evalScript play/toggle; calls so far: ' + 'see calls()');

  // Protocol level: control -> panel -> control-result -> control-ack
  raw.ws.send(JSON.stringify({ t: 'control', cmd: 'play' }));
  const ack = await waitFor(() => raw.msgs.find((m) => m.t === 'control-ack'), 'control-ack');
  assert.equal(ack.cmd, 'play');
  assert.equal(ack.ok, true);
  assert.ok((await calls()).some((s) => s.startsWith('otControl("play"')), 'panel ran play');
  assert.equal(await phone.locator('#toast').isVisible(), false, 'no error toast on the phone');

  await panelPage.locator('.switch').click();
  assert.equal(await panelPage.locator('#allowControl').isChecked(), false);
  await waitFor(() => phone.locator('#tpPlay').isDisabled(), 'phone transport disabled');
  assert.match(await phone.locator('#tpNote').textContent(), /control is off/i);
  await waitFor(() => raw.msgs.find((m) => m.t === 'perm' && m.control === false), 'perm false');
  raw.ws.send(JSON.stringify({ t: 'control', cmd: 'pause' }));
  const err = await waitFor(() => raw.msgs.find((m) => m.t === 'error' && m.code === 'control-off'), 'control-off');
  assert.equal(err.cmd, 'pause');
  await phone.screenshot({ path: path.join(SHOTS, 'phone-control-off.png') });
  await panelPage.screenshot({ path: path.join(SHOTS, 'panel-control-off.png') });
  raw.ws.close();

  await panelPage.locator('.switch').click();
  await waitFor(() => phone.locator('#tpPlay').isEnabled(), 'phone transport re-enabled');
});

test('Photoshop source client: another phone sees the frame, host Photoshop, transport hidden', async () => {
  clearInterval(frameTimer);
  transmit.close();
  const client = new SourceClient({
    url: `ws://127.0.0.1:${port}/ws`,
    WebSocketImpl: WebSocket,
    host: { app: 'photoshop', appName: 'Photoshop', version: '26.0' },
    reconnectMs: 500,
  });
  client.start();
  await waitFor(() => client.connected, 'source connected');
  client.setSequence({ name: 'poster.psd', width: 1080, height: 1350, aspect: '4x5' });
  assert.equal(client.sendFrame(JPEG, { width: 320, height: 180, srcWidth: 1080, srcHeight: 1350 }), true);

  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => console.log('phone2 pageerror:', e.message));
  await p2.goto(`${base}/c/${session.code}`);
  await p2.waitForFunction(() => document.getElementById('liveBadge').textContent === 'LIVE');
  await p2.waitForFunction(() => document.getElementById('cover').hidden);
  assert.match(await p2.locator('#npApp').textContent(), /Photoshop/);
  assert.match(await p2.locator('#npSeq').textContent(), /poster\.psd/);
  assert.ok((await litPixels(p2)) > 100, 'frame drawn');
  assert.equal(await p2.locator('#transport').isVisible(), false, 'transport hidden for Photoshop');
  await p2.screenshot({ path: path.join(SHOTS, 'phone-photoshop.png') });
  await ctx.close();
  client.stop();
});

test('five wrong codes -> locked message', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  await p.goto(`${base}/`);
  await p.waitForSelector('#entry:not([hidden])');
  const wrong = session.code === 'AAAA' ? 'BBBB' : 'AAAA';
  let text = '';
  for (let i = 0; i < 6; i++) {
    await p.waitForSelector('#entry:not([hidden])');
    await p.locator('.code-box').first().click();
    await p.keyboard.type(wrong, { delay: 20 }); // the 4th character submits
    text = await waitFor(async () => (await p.locator('#entryError').isVisible()) && (await p.locator('#entryError').textContent()), 'entry error');
    if (/lock|too many/i.test(text)) break;
    assert.match(text, /isn't right/, 'attempt ' + (i + 1));
  }
  assert.match(text, /lock|too many/i);
  await p.screenshot({ path: path.join(SHOTS, 'phone-locked.png') });
  await ctx.close();
});
