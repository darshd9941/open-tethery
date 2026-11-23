// Headless smoke test: fake helper + real viewer in Chromium (iPhone 13 emulation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServer, defaultState } from './fake-server.mjs';

const require = createRequire(import.meta.url);
let playwright = null;
try { playwright = require('playwright'); } catch { /* skipped below */ }

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots');
const skip = playwright ? false : 'playwright is not installed';

async function makeJpeg(browser) {
  const page = await browser.newPage({ viewport: { width: 180, height: 320 } });
  await page.setContent(`<body style="margin:0;width:180px;height:320px;background:linear-gradient(160deg,#ff6a3d,#7b2ff7 55%,#13c2c2);
    font:700 22px sans-serif;color:#fff;display:grid;place-items:center">9:16<br>test frame</body>`);
  const buf = await page.screenshot({ type: 'jpeg', quality: 85 });
  await page.close();
  return buf;
}

const canvasHasPicture = (page) => page.evaluate(() => {
  const c = document.getElementById('canvas');
  const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
  return c.width === 180 && c.height === 320 && d[3] === 255 && d[0] + d[1] + d[2] > 60;
});

test('viewer connects, draws a frame, shows now-playing and sends control', { skip }, async (t) => {
  const browser = await playwright.chromium.launch();
  const jpeg = await makeJpeg(browser);
  const server = await startFakeServer({ code: 'ABCD', jpeg });
  const context = await browser.newContext({ ...playwright.devices['iPhone 13'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => { await browser.close(); await server.close(); });

  await page.goto(`${server.url}/c/abcd`);
  await page.waitForFunction(() => document.getElementById('npSeq').textContent === 'Main edit');
  await page.waitForFunction(() => document.getElementById('cover').hidden);
  assert.ok(await page.waitForFunction(() => {
    const c = document.getElementById('canvas');
    const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return c.width === 180 && d[3] === 255 && d[0] + d[1] + d[2] > 60;
  }).then(() => true));
  assert.ok(await canvasHasPicture(page), 'canvas shows the frame');

  assert.equal(await page.textContent('#liveBadge'), 'LIVE');
  assert.equal(await page.textContent('#npApp'), 'Premiere Pro');
  assert.equal(await page.textContent('#npAspect'), '9x16');
  assert.match(await page.textContent('#npRes'), /1080×1920 @ 29\.97/);
  assert.match(await page.textContent('#npTc'), /^00:00:12:1[45]$/); // frame time 12.5 s @ 29.97
  assert.match(await page.textContent('#npPlay'), /Paused/);

  // picture is letter-boxed to 9:16 inside the stage and the overlay stage matches it
  const geo = await page.evaluate(() => {
    const p = document.getElementById('pic').getBoundingClientRect();
    const o = document.getElementById('overlayStage').getBoundingClientRect();
    return { ratio: p.width / p.height, same: Math.abs(p.width - o.width) < 1 && Math.abs(p.height - o.height) < 1 };
  });
  assert.ok(Math.abs(geo.ratio - 9 / 16) < 0.01, `ratio ${geo.ratio}`);
  assert.ok(geo.same);

  // hello went out as protocol v1 and info with screen size
  const hello = server.received.find((m) => m.t === 'hello');
  assert.equal(hello.role, 'viewer');
  assert.equal(hello.code, 'ABCD');
  assert.deepEqual(hello.accept, ['jpeg', 'pcm']);
  assert.equal(hello.protocol, 1);
  assert.ok(server.received.find((m) => m.t === 'info' && m.w > 0));
  assert.ok(await page.evaluate(() => localStorage.getItem('ot.lastCode')) === 'ABCD');

  // transport
  await page.click('#tpPlay');
  await page.click('#tpBack1');
  await page.click('#tpEnd');
  await page.waitForFunction(() => true);
  await new Promise((r) => setTimeout(r, 200));
  const ctl = server.received.filter((m) => m.t === 'control');
  assert.deepEqual(ctl.map((m) => m.cmd), ['play', 'step', 'jump']);
  assert.equal(ctl[1].frames, -1);

  // stats sheet
  await page.click('#btnStats');
  assert.ok(await page.isVisible('#sheetStats'));
  assert.match(await page.textContent('#statsList'), /Frame rate/);
  await page.click('#sheetStats [data-close]');

  // overlays sheet opens with the tile grid (details in overlays.test.mjs)
  await page.click('#btnOverlays');
  assert.ok(await page.isVisible('#sheetOverlays'));
  assert.ok(await page.isVisible('[data-group="social"]'));
  await page.click('#sheetOverlays [data-close]');

  // tap the picture hides the controls
  await page.screenshot({ path: path.join(shots, 'viewer-live-iphone13.png') });
  await page.mouse.click(195, 300);
  await page.waitForFunction(() => document.getElementById('app').dataset.ui === 'hidden');
  await page.screenshot({ path: path.join(shots, 'viewer-fullpicture-iphone13.png') });

  assert.deepEqual(errors, []);
});

test('sound and control are blocked with clear notes (After Effects, control off)', { skip }, async (t) => {
  const browser = await playwright.chromium.launch();
  const jpeg = await makeJpeg(browser);
  const server = await startFakeServer({
    code: 'ABCD', jpeg, control: false,
    state: defaultState({ host: { app: 'aftereffects', appName: 'After Effects' }, audio: { available: false } }),
  });
  const page = await (await browser.newContext({ ...playwright.devices['iPhone 13'] })).newPage();
  t.after(async () => { await browser.close(); await server.close(); });
  await page.goto(`${server.url}/c/ABCD`);
  await page.waitForFunction(() => document.getElementById('npApp').textContent === 'After Effects');
  await page.click('#btnSound');
  await page.waitForFunction(() => document.getElementById('toast').textContent === 'No sound from After Effects');
  assert.ok(await page.isDisabled('#tpPlay'));
  assert.match(await page.textContent('#tpNote'), /Allow control from phones/);
  assert.equal(server.received.filter((m) => m.t === 'audio').length, 0);
});

test('code entry: waiting screen, wrong code, right code, paste', { skip }, async (t) => {
  const browser = await playwright.chromium.launch();
  const server = await startFakeServer({ code: 'K7M2', pcName: 'STUDIO-PC', state: defaultState({ status: 'idle' }), sendFrame: false });
  const context = await browser.newContext({ ...playwright.devices['iPhone 13'] });
  const page = await context.newPage();
  t.after(async () => { await browser.close(); await server.close(); });

  await page.goto(`${server.url}/`);
  assert.ok(await page.isVisible('#entry'));
  await page.waitForSelector('.code-box:focus');
  await page.keyboard.type('zzzz');
  await page.waitForFunction(() => !document.getElementById('entryError').hidden);
  assert.match(await page.textContent('#entryError'), /isn't right/);
  assert.ok(await page.isVisible('#entry'));
  await page.screenshot({ path: path.join(shots, 'viewer-code-entry-iphone13.png') });

  // paste a whole link into the first box
  await page.evaluate(() => {
    const box = document.querySelector('.code-box');
    box.focus();
    const dt = new DataTransfer();
    dt.setData('text', 'http://192.168.1.20:47825/c/k7m2');
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.getElementById('cover').textContent.includes('Connected, waiting for picture'));
  assert.match(await page.textContent('#coverTitle'), /STUDIO-PC/);
  assert.equal(await page.textContent('#liveBadge'), 'IDLE');
  assert.equal(new URL(page.url()).pathname, '/c/K7M2');
  await page.screenshot({ path: path.join(shots, 'viewer-waiting-iphone13.png') });
});
