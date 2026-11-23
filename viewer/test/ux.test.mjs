// UX checks on phone-sized screens with both a 9:16 and a 16:9 test frame (the 16:9 case is what most
// Premiere sequences look like). Screenshots go to test/screenshots/ux/ for a human look.
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
const skip = playwright ? false : 'playwright is not installed';
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots', 'ux');
fs.mkdirSync(shots, { recursive: true });

const PLATFORMS = ['instagram-reels', 'instagram-feed', 'instagram-story', 'youtube', 'youtube-shorts', 'tiktok', 'x', 'facebook', 'snapchat', 'pinterest', 'reddit'];
const FRAMES = {
  '9x16': { w: 180, h: 320, srcW: 1080, srcH: 1920, aspect: '9x16', seq: { width: 1080, height: 1920 } },
  '16x9': { w: 320, h: 180, srcW: 1920, srcH: 1080, aspect: '16x9', seq: { width: 1920, height: 1080 } },
};

// Colour bars, grey ramp, a skin-tone patch and a blown-out highlight, at the given size.
async function makeFrame(browser, w, h, text) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const bars = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf', '#000'].map((c) => `<i style="background:${c}"></i>`).join('');
  const k = h / 320 > 0.9 ? 1 : h / 320; // scale features with the frame height
  await page.setContent(`<body style="margin:0;width:${w}px;height:${h}px;background:#305a78;position:relative;font:700 ${Math.round(14 * (h > 200 ? 1 : 0.9))}px sans-serif;color:#fff;overflow:hidden">
    <div style="display:flex;height:${h * 0.22}px">${bars}</div>
    <div style="height:${h * 0.09}px;background:linear-gradient(90deg,#000,#fff)"></div>
    <div style="position:absolute;left:${w * 0.11}px;top:${h * 0.38}px;width:${w * 0.33}px;height:${h * 0.22}px;background:#dfa584;border-radius:30px"></div>
    <div style="position:absolute;left:${w * 0.58}px;top:${h * 0.4}px;width:${Math.min(w, h) * 0.3}px;height:${Math.min(w, h) * 0.3}px;background:#fff;border-radius:50%"></div>
    <div style="position:absolute;left:0;top:${h * 0.7}px;width:${w}px;text-align:center">${text}</div></body>`);
  await page.addStyleTag({ content: 'i{display:block;flex:1}' });
  const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
  await page.close();
  return buf;
}

async function boot(t, deviceName, frameKey, { hintSeen = true } = {}) {
  const F = FRAMES[frameKey];
  const browser = await playwright.chromium.launch();
  const jpeg = await makeFrame(browser, F.w, F.h, `${frameKey.replace('x', ':')} test frame`);
  const server = await startFakeServer({
    code: 'ABCD', jpeg, jw: F.w, jh: F.h, srcW: F.srcW, srcH: F.srcH,
    state: defaultState({ sequence: { name: 'Main edit', ...F.seq, fpsNum: 24000, fpsDen: 1001, fps: 23.976, aspect: F.aspect, par: 1, duration: 120 } }),
  });
  const context = await browser.newContext({ ...playwright.devices[deviceName] });
  if (hintSeen) await context.addInitScript(() => { try { localStorage.setItem('ot.hintSeen', '1'); } catch { /* ignore */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  t.after(async () => { await browser.close(); await server.close(); });
  await page.goto(`${server.url}/c/ABCD`);
  await page.waitForFunction(() => document.getElementById('cover').hidden);
  await page.waitForFunction((w) => document.getElementById('canvas').width === w, F.w);
  await page.waitForTimeout(250);
  const slug = `${deviceName.toLowerCase().replace(/\s+/g, '-')}-${frameKey}`;
  const shot = (name) => page.screenshot({ path: path.join(shots, `${slug}-${name}.png`) });
  return { page, errors, server, shot, F };
}

const rect = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
const overlap = (a, b) => a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1;
const closeTray = async (page) => { await page.click('[data-close-tray]'); await page.waitForTimeout(250); };
const tapPicture = async (page) => {
  const r = await rect(page, '#pic');
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await page.waitForTimeout(450);
};
const widgetRects = (page) => page.evaluate(() => [...document.querySelectorAll('.sc-widget')].map((e) => { const r = e.getBoundingClientRect(); return { k: e.dataset.scope, docked: e.dataset.docked, x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; }));

const DEVICES = ['iPhone 13', 'iPhone 13 landscape', 'Pixel 7'];

for (const device of DEVICES) {
  for (const frameKey of Object.keys(FRAMES)) {
    test(`${device}, ${frameKey}: chrome, tray, guides, scopes, exposure`, { skip }, async (t) => {
      const landscape = device.includes('landscape');
      const { page, errors, shot } = await boot(t, device, frameKey, { hintSeen: false });
      const vp = page.viewportSize();

      // idle: first-run tip is shown, header is one line, tap targets are big enough
      assert.ok(await page.isVisible('#hint'), 'first-run tip shown');
      assert.match(await page.textContent('#hint'), /Tap the picture for controls/);
      await shot('idle');
      const hdr = await rect(page, '#top .np');
      assert.ok(hdr.h <= 48, `header is one line (${hdr.h}px)`);
      for (const sel of ['.qgroup', '#tpPlay', '#tpBack1', '#btnSave', '#hintClose']) {
        const r = await rect(page, sel);
        assert.ok(r.h >= 43.5, `${sel} height ${r.h}`);
      }
      await page.click('#hintClose');
      assert.equal(await page.evaluate(() => localStorage.getItem('ot.hintSeen')), '1');
      await page.reload();
      await page.waitForFunction(() => document.getElementById('cover').hidden);
      assert.ok(await page.isHidden('#hint'), 'tip does not come back');

      // tap the picture: controls hide, tap again: they come back
      await tapPicture(page);
      assert.equal(await page.evaluate(() => document.getElementById('app').dataset.ui), 'hidden');
      await shot('ui-hidden');
      await tapPicture(page);
      assert.equal(await page.evaluate(() => document.getElementById('app').dataset.ui), 'shown');
      await shot('controls');

      // tray: compact, the picture stays fully visible next to it
      await page.click('[data-chip="social"]');
      await page.waitForSelector('#tray:not([hidden])');
      await page.waitForTimeout(300);
      const tray = await rect(page, '#tray');
      const pic = await rect(page, '#pic');
      if (landscape) {
        assert.ok(tray.w <= vp.width * 0.401, `tray width ${tray.w}`);
        assert.ok(pic.r <= tray.x + 1, 'picture is left of the side panel');
      } else {
        assert.ok(tray.h <= vp.height * 0.381, `tray height ${tray.h} of ${vp.height}`);
        assert.ok(pic.b <= tray.y + 1, 'picture is above the tray');
        assert.ok(pic.h > 100, `picture still ${pic.h}px tall`);
      }
      await shot('tray-frame');
      await page.click('[data-platform="instagram-reels"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-ot-layer="social"] .s-zone').length > 0);
      await page.waitForTimeout(200);
      await shot('tray-frame-reels');
      // tapping the picture closes the tray
      await tapPicture(page);
      assert.ok(await page.isHidden('#tray'), 'tap on picture closes the tray');
      assert.match(await page.textContent('[data-chip="social"]'), /Instagram Reels/);

      // every social frame, tray closed
      const list = device === 'iPhone 13' ? PLATFORMS : ['instagram-reels', 'youtube'];
      for (const id of list) {
        await page.click('[data-chip="social"]');
        await page.waitForSelector('#tray:not([hidden])');
        await page.click(`#tray [data-platform="${id}"]`);
        await closeTray(page);
        await page.waitForTimeout(150);
        const info = await page.evaluate(() => {
          const svg = document.querySelector('[data-ot-layer="social"]');
          const vb = svg.viewBox.baseVal;
          const bad = [];
          for (const el of svg.querySelectorAll('.s-zone, .s-icon, .s-pill, .s-bar')) {
            const b = el.getBBox();
            if (b.x < -1 || b.y < -1 || b.x + b.width > vb.width + 1 || b.y + b.height > vb.height + 1) bad.push(el.getAttribute('class'));
          }
          const sizes = [...svg.querySelectorAll('text.s-text')].map((e) => parseFloat(e.getAttribute('font-size')));
          return { bad, minText: Math.min(...sizes, 99), labels: svg.querySelectorAll('.s-label').length, safe: svg.querySelectorAll('.s-safe').length };
        });
        assert.deepEqual(info.bad, [], `${id} draws outside the picture`);
        assert.ok(info.minText >= 12, `${id} text ${info.minText}px`);
        assert.equal(info.labels, 0, 'no zone labels by default');
        assert.equal(info.safe, 0, 'no unsafe-area highlight by default');
        await shot(`social-${id}`);
      }

      // aspect mismatch: the crop is centred and the rest is darkened
      if (frameKey === '16x9') {
        await page.click('[data-chip="social"]');
        await page.click('#tray [data-platform="instagram-reels"]');
        await closeTray(page);
        const g = await page.evaluate(() => {
          const svg = document.querySelector('[data-ot-layer="social"]');
          const f = svg.querySelector('.s-frame').getBBox();
          const vb = svg.viewBox.baseVal;
          return { cx: f.x + f.width / 2, vw: vb.width, ratio: f.width / f.height, outside: svg.querySelectorAll('.s-outside').length };
        });
        assert.ok(Math.abs(g.cx - g.vw / 2) < 1, 'crop centred');
        assert.ok(Math.abs(g.ratio - 9 / 16) < 0.01, `crop ratio ${g.ratio}`);
        assert.equal(g.outside, 2, 'dark bars left and right of the crop');
      }
      // switch the frame off with the x on the chip
      await page.click('[data-chip-clear="social"]');
      assert.equal(await page.locator('[data-ot-layer="social"] .s-zone').count(), 0);

      // frame settings: labels and highlight are opt-in
      await page.click('[data-chip="social"]');
      await page.click('#tray [data-platform="tiktok"]');
      await page.locator('#tray .ui-row', { hasText: 'Show labels' }).locator('input').check();
      await page.locator('#tray .ui-row', { hasText: 'Highlight unsafe' }).locator('input').check();
      await page.waitForTimeout(200);
      assert.ok(await page.locator('[data-ot-layer="social"] .s-label').count() > 0);
      await shot('tray-frame-labels');
      await page.locator('#tray .ui-row', { hasText: 'Show labels' }).locator('input').uncheck();
      await page.locator('#tray .ui-row', { hasText: 'Highlight unsafe' }).locator('input').uncheck();
      await page.click('#tray [data-platform=""]');
      await closeTray(page);

      // guides: one tap
      await page.click('[data-chip="guides"]');
      assert.equal(await page.getAttribute('[data-chip="guides"]', 'aria-pressed'), 'true');
      await page.waitForTimeout(150);
      await shot('guides');
      await page.click('[data-chip-more="guides"]');
      await page.waitForSelector('#tray .ov-page[data-page="guides"]:not([hidden])');
      await page.locator('#tray .ui-row', { hasText: 'Rule of thirds' }).locator('input').check();
      await page.locator('#tray .ui-row', { hasText: 'Centre mark' }).locator('input').check();
      await page.locator('#tray .ui-row', { hasText: 'Title safe' }).first().locator('input').check();
      await page.waitForTimeout(200);
      await shot('tray-guides');
      await closeTray(page);
      await page.click('[data-chip="guides"]');
      assert.equal(await page.getAttribute('[data-chip="guides"]', 'aria-pressed'), 'false');
      assert.equal(await page.locator('[data-ot-layer="guides"] line').count(), 0);

      // scopes: one at a time, docked into free space when there is some
      const picR = await rect(page, '#pic');
      for (const kind of ['hist', 'wave', 'vec', 'audio']) {
        await page.click('[data-chip-more="scopes"]');
        await page.waitForSelector('#tray .ov-page[data-page="scopes"]:not([hidden])');
        await page.click(`#tray [data-kind="${kind}"]`);
        if (kind === 'hist') await shot('tray-scopes');
        await closeTray(page);
        await page.waitForTimeout(450);
        if (kind === 'audio') await page.evaluate(() => window.__tethery.bus.emit('audio-levels', { l: 0.3, r: 0.1, peakL: 0.5, peakR: 0.2 }));
        await page.waitForTimeout(150);
        const ws = await widgetRects(page);
        assert.equal(ws.length, 1, 'one scope at a time');
        assert.equal(ws[0].k, kind);
        const stage = await rect(page, '#stage');
        const bandAbove = picR.y - stage.y;
        const bandBelow = stage.b - picR.b;
        const bandSide = Math.max(picR.x - stage.x, stage.r - picR.r);
        const roomy = Math.max(bandAbove, bandBelow) >= ws[0].h + 8 || bandSide >= ws[0].w + 8;
        if (roomy) {
          assert.equal(ws[0].docked, '1', `${kind} docked`);
          assert.ok(!overlap(ws[0], { x: picR.x, y: picR.y, r: picR.r, b: picR.b }), `${kind} sits outside the picture`);
        }
        assert.ok(ws[0].w <= 160, `default size is small (${ws[0].w})`);
        await shot(`scope-${kind}`);
      }
      // scope chip toggles it off and brings it back
      await page.click('[data-chip="scopes"]');
      assert.equal(await page.locator('.sc-widget').count(), 0);
      await page.click('[data-chip="scopes"]');
      assert.equal(await page.locator('.sc-widget').count(), 1);
      await page.click('[data-chip="scopes"]');

      // false colour and zebras
      await page.click('[data-chip="colour"]');
      await page.waitForFunction(() => { const c = document.querySelector('canvas.ot-expo'); return c && !c.hidden && c.getContext('2d').getImageData(c.width >> 1, 10, 1, 1).data[3] > 0; });
      await page.waitForTimeout(300);
      await shot('false-colour');
      await page.click('[data-chip="colour"]');
      await page.click('[data-chip="zebra"]');
      await page.waitForTimeout(400);
      await shot('zebras');
      await page.click('[data-chip="zebra"]');

      // info
      await page.click('[data-chip="info"]');
      assert.match(await page.locator('[data-ot-layer="info"]').textContent(), /Main edit/);
      await shot('info');

      // the chip row never leaves the screen and nothing overflows horizontally
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(over, false, 'no horizontal page scroll');
      assert.deepEqual(errors, []);
    });
  }
}

test('controls hide by themselves 3 s after the last touch while playing, tap brings them back', { skip }, async (t) => {
  const { page, server, shot } = await boot(t, 'iPhone 13', '16x9');
  server.broadcast(defaultState({ playing: true, sequence: { name: 'Main edit', width: 1920, height: 1080, fps: 23.976, aspect: '16x9', duration: 120 } }));
  await page.waitForFunction(() => window.__tethery.state?.playing === true);
  assert.equal(await page.evaluate(() => document.getElementById('app').dataset.ui), 'shown');
  await page.waitForFunction(() => document.getElementById('app').dataset.ui === 'hidden', null, { timeout: 6000 });
  await shot('autohidden');
  await tapPicture(page);
  assert.equal(await page.evaluate(() => document.getElementById('app').dataset.ui), 'shown');
  // an open tray keeps the controls up
  await page.click('[data-chip="social"]');
  await page.waitForTimeout(3600);
  assert.equal(await page.evaluate(() => document.getElementById('app').dataset.ui), 'shown');
});

test('swipe down on the tray closes it', { skip }, async (t) => {
  const { page } = await boot(t, 'iPhone 13', '16x9');
  await page.click('[data-chip="scopes"] ~ .qmore, [data-chip-more="scopes"]');
  await page.waitForSelector('#tray:not([hidden])');
  const g = await rect(page, '.tray-grab');
  await page.mouse.move(g.x + g.w / 2, g.y + 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.w / 2, g.y + 80, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#tray', { state: 'hidden' });
});

test('long-press on a chip opens its settings', { skip }, async (t) => {
  const { page } = await boot(t, 'iPhone 13', '16x9');
  const r = await rect(page, '[data-chip="guides"]');
  await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForSelector('#tray .ov-page[data-page="guides"]:not([hidden])');
  assert.equal(await page.getAttribute('[data-chip="guides"]', 'aria-pressed'), 'false', 'long press does not toggle');
});
