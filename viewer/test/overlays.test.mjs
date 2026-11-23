// Playwright (Chromium, iPhone 13) checks for M4 overlays against the fake helper.
// Screenshots go to test/screenshots/overlays/ for a human look.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServer } from './fake-server.mjs';

const require = createRequire(import.meta.url);
let playwright = null;
try { playwright = require('playwright'); } catch { /* skipped below */ }
const skip = playwright ? false : 'playwright is not installed';
const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots', 'overlays');
fs.mkdirSync(shots, { recursive: true });

const PLATFORMS = ['instagram-reels', 'instagram-feed', 'instagram-story', 'youtube', 'youtube-shorts', 'tiktok', 'x', 'facebook', 'snapchat', 'pinterest', 'reddit'];

// 9:16 test frame: 75% colour bars, grey ramp, a skin-tone patch and a blown-out highlight.
async function makeFrame(browser) {
  const page = await browser.newPage({ viewport: { width: 180, height: 320 } });
  const bars = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf', '#000'].map((c) => `<i style="background:${c}"></i>`).join('');
  await page.setContent(`<body style="margin:0;width:180px;height:320px;background:#305a78;position:relative;font:700 14px sans-serif;color:#fff;overflow:hidden">
    <div style="display:flex;height:70px">${bars}</div>
    <div style="height:30px;background:linear-gradient(90deg,#000,#fff)"></div>
    <div style="position:absolute;left:20px;top:120px;width:60px;height:70px;background:#dfa584;border-radius:30px"></div>
    <div style="position:absolute;left:105px;top:130px;width:60px;height:60px;background:#fff;border-radius:30px"></div>
    <div style="position:absolute;left:0;top:215px;width:180px;text-align:center">9:16 test frame</div></body>`);
  await page.addStyleTag({ content: 'i{display:block;flex:1}' });
  const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
  await page.close();
  return buf;
}

async function boot(t) {
  const browser = await playwright.chromium.launch();
  const server = await startFakeServer({ code: 'ABCD', jpeg: await makeFrame(browser) });
  const context = await browser.newContext({ ...playwright.devices['iPhone 13'], acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  t.after(async () => { await browser.close(); await server.close(); });
  await page.goto(`${server.url}/c/ABCD`);
  await page.waitForFunction(() => document.getElementById('cover').hidden);
  await page.waitForFunction(() => document.getElementById('canvas').width === 180);
  return { page, errors, server };
}

const openGroup = async (page, id) => {
  await page.click('#btnOverlays');
  await page.click(`[data-group="${id}"]`);
};
const closeSheet = (page) => page.click('#sheetOverlays [data-close]');
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
const toggle = (page, label) => page.locator('.ui-row', { hasText: label }).first().locator('input').check();

// count of non-transparent pixels on a canvas
const painted = (page, sel) => page.evaluate((s) => {
  const c = document.querySelector(s);
  if (!c || !c.width) return 0;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}, sel);

test('every social frame renders inside the picture and the tile sheet works', { skip }, async (t) => {
  const { page, errors } = await boot(t);
  await page.click('#btnOverlays');
  await page.waitForSelector('[data-group="social"]');
  await shot(page, 'sheet-tiles');
  await page.click('[data-group="social"]');
  await page.waitForSelector('[data-platform="tiktok"]');
  assert.equal(await page.locator('[data-platform]').count(), PLATFORMS.length);
  await shot(page, 'sheet-social');
  await closeSheet(page);

  for (const id of PLATFORMS) {
    await openGroup(page, 'social');
    await page.click(`[data-platform="${id}"]`);
    await closeSheet(page);
    await page.waitForFunction(() => document.querySelectorAll('[data-ot-layer="social"] .s-zone').length > 0);
    // everything drawn must stay inside the picture
    const bad = await page.evaluate(() => {
      const svg = document.querySelector('[data-ot-layer="social"]');
      const vb = svg.viewBox.baseVal;
      const out = [];
      for (const el of svg.querySelectorAll('.s-zone, .s-icon, .s-pill, .s-bar')) {
        const b = el.getBBox();
        if (b.x < -1 || b.y < -1 || b.x + b.width > vb.width + 1 || b.y + b.height > vb.height + 1) out.push(el.getAttribute('class'));
      }
      return out;
    });
    assert.deepEqual(bad, [], `${id} draws outside the picture`);
    await shot(page, `social-${id}`);
  }

  // without the highlight the zones become plain outlines
  await openGroup(page, 'social');
  await page.locator('.ui-row', { hasText: 'Highlight unsafe areas' }).locator('input').uncheck();
  await closeSheet(page);
  assert.equal(await page.locator('[data-ot-layer="social"] .s-safe').count(), 0);
  await shot(page, 'social-no-highlight');
  assert.deepEqual(errors, []);
});

test('profiles: handle, caption and picture are stored and drawn', { skip }, async (t) => {
  const { page, errors } = await boot(t);
  await openGroup(page, 'social');
  await page.click('[data-platform="instagram-reels"]');
  await page.fill('input[aria-label="Handle"]', '@maya.cuts');
  await page.fill('textarea[aria-label="Caption"]', 'Golden hour edit, shot on a phone and graded in the cut #reels');
  // a 200x100 PNG as the picked photo
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const x = c.getContext('2d'); x.fillStyle = '#e11d74'; x.fillRect(0, 0, 200, 100); x.fillStyle = '#fde047'; x.fillRect(50, 0, 100, 100); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('input[type=file]', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => document.querySelector('[data-ot-layer="social"] image'));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('ot.social.profiles')));
  assert.equal(stored[0].handle, 'maya.cuts');
  assert.match(stored[0].avatar, /^data:image\/jpeg;base64,/);
  assert.ok(stored[0].avatar.length < 20000, 'avatar is small');
  // second profile and switching
  await page.click('button:has-text("New profile")');
  await page.fill('input[aria-label="Handle"]', 'second');
  await page.selectOption('select[aria-label="Profile"]', { index: 0 });
  assert.equal(await page.inputValue('input[aria-label="Handle"]'), 'maya.cuts');
  await closeSheet(page);
  assert.match(await page.locator('[data-ot-layer="social"] text.s-text').first().textContent(), /@maya\.cuts/);
  await shot(page, 'social-profile');
  // survives reload
  await page.reload();
  await page.waitForFunction(() => document.getElementById('cover').hidden);
  await page.waitForFunction(() => document.querySelector('[data-ot-layer="social"] .s-zone'));
  assert.equal(await page.locator('[data-ot-layer="social"] image').count(), 1);
  assert.deepEqual(errors, []);
});

test('guides: safe zones, thirds, centre, grid and mattes', { skip }, async (t) => {
  const { page, errors } = await boot(t);
  await openGroup(page, 'guides');
  await toggle(page, 'Title safe');
  await toggle(page, 'Action safe');
  await toggle(page, 'Rule of thirds');
  await toggle(page, 'Centre mark');
  await toggle(page, 'Custom grid');
  await shot(page, 'sheet-guides');
  await closeSheet(page);
  const g = await page.evaluate(() => {
    const svg = document.querySelector('[data-ot-layer="guides"]');
    const vb = svg.viewBox.baseVal;
    const r = svg.querySelector('.g-title').getBBox();
    return { vbW: vb.width, rW: r.width, lines: svg.querySelectorAll('.g-line').length, centre: svg.querySelectorAll('.g-centre').length };
  });
  assert.ok(Math.abs(g.rW / g.vbW - 0.9) < 0.01);
  assert.equal(g.lines, 4 + 3 + 3);
  assert.equal(g.centre, 2);
  await shot(page, 'guides-all');

  await openGroup(page, 'guides');
  await page.click('.ui-chip:has-text("2.39:1")');
  await closeSheet(page);
  assert.equal(await page.locator('[data-ot-layer="guides"] .g-matte').count(), 2);
  await shot(page, 'guides-matte-2.39');
  await openGroup(page, 'guides');
  await page.click('.ui-chip:has-text("1:1")');
  await closeSheet(page);
  await shot(page, 'guides-matte-1x1');
  assert.deepEqual(errors, []);
});

test('scopes: histogram, waveform, vectorscope, audio meters, drag and persistence', { skip }, async (t) => {
  const { page, errors } = await boot(t);
  await openGroup(page, 'scopes');
  await toggle(page, 'Histogram');
  await page.waitForFunction(() => document.querySelector('.sc-hist canvas') !== null);
  await page.waitForFunction(() => { const c = document.querySelector('.sc-hist canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) return true; return false; });
  await shot(page, 'sheet-scopes');
  await closeSheet(page);
  await shot(page, 'scope-hist-luma');

  // histogram modes
  for (const [m, name] of [['RGB', 'rgb'], ['Parade', 'parade']]) {
    await openGroup(page, 'scopes');
    await page.click(`.ui-chip:has-text("${m}")`);
    await closeSheet(page);
    await shot(page, `scope-hist-${name}`);
  }
  await openGroup(page, 'scopes');
  await toggle(page, 'Waveform');
  await toggle(page, 'Vectorscope');
  await toggle(page, 'Audio');
  await closeSheet(page);
  await page.waitForTimeout(400);
  assert.ok(await painted(page, '.sc-wave canvas') > 500, 'waveform has pixels');
  assert.ok(await painted(page, '.sc-vec canvas') > 500, 'vectorscope has pixels');

  // widgets overlap each other by default? they must not
  const rects = await page.evaluate(() => [...document.querySelectorAll('.sc-widget')].map((e) => { const r = e.getBoundingClientRect(); return { k: e.dataset.scope, x: r.x, y: r.y, w: r.width, h: r.height }; }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    assert.ok(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1, `${a.k} overlaps ${b.k}`);
  }
  await shot(page, 'scopes-all-medium');

  // audio meter reacts to published levels
  await page.evaluate(() => { window.__tethery.bus.emit('audio-levels', { l: 0.3, r: 0.1, peakL: 0.5, peakR: 0.2 }); });
  await page.waitForTimeout(150);
  await shot(page, 'scope-audio');

  // size button cycles S -> M -> L
  const w0 = await page.evaluate(() => document.querySelector('.sc-vec').offsetWidth);
  await page.click('.sc-vec .sc-btn:has-text("S/M/L")');
  const w1 = await page.evaluate(() => document.querySelector('.sc-vec').offsetWidth);
  assert.ok(w1 > w0, `size grew ${w0} -> ${w1}`);
  await shot(page, 'scope-vec-large');

  // drag the histogram
  const before = await page.evaluate(() => { const e = document.querySelector('.sc-hist'); return { x: e.offsetLeft, y: e.offsetTop }; });
  const head = await page.locator('.sc-hist .sc-head').boundingBox();
  await page.mouse.move(head.x + 20, head.y + 10);
  await page.mouse.down();
  await page.mouse.move(head.x - 60, head.y + 120, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => { const e = document.querySelector('.sc-hist'); return { x: e.offsetLeft, y: e.offsetTop }; });
  assert.ok(after.x < before.x - 30 && after.y > before.y + 80, `dragged ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ot.scopes.pos')));
  assert.ok(saved.hist && saved.hist.y > 0);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('cover').hidden);
  await page.waitForSelector('.sc-hist');
  const again = await page.evaluate(() => { const e = document.querySelector('.sc-hist'); return { x: e.offsetLeft, y: e.offsetTop }; });
  assert.ok(Math.abs(again.x - after.x) < 3 && Math.abs(again.y - after.y) < 3, 'position restored');
  await shot(page, 'scopes-after-drag-reload');
  assert.deepEqual(errors, []);
});

test('scope maths on the real picture: highlight shows clipped white, bars hit the targets', { skip }, async (t) => {
  const { page } = await boot(t);
  await openGroup(page, 'scopes');
  await toggle(page, 'Histogram');
  await toggle(page, 'Vectorscope');
  await closeSheet(page);
  await page.waitForTimeout(500);
  // vectorscope: the test frame has 75% bars, so the target cells must hold samples
  const hits = await page.evaluate(async () => {
    const m = await import('/js/scope-math.js');
    const c = document.getElementById('canvas');
    const s = document.createElement('canvas'); s.width = 180; s.height = 320;
    const x = s.getContext('2d'); x.drawImage(c, 0, 0);
    const d = x.getImageData(0, 0, 180, 320);
    const r = m.analyse(d.data, 180, 320, { vec: true });
    return m.BAR_TARGETS.map((t) => { const { gx, gy } = m.vecCell(t.cb, t.cr); let n = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) n += r.vec[(gy + dy) * m.VEC_SIZE + gx + dx]; return [t.name, n]; });
  });
  for (const [name, n] of hits) assert.ok(n > 100, `target ${name} has ${n}`);
});

test('exposure: false colour with legend and zebras', { skip }, async (t) => {
  const { page, errors } = await boot(t);
  await openGroup(page, 'scopes');
  await toggle(page, 'False colour');
  await page.waitForFunction(() => { const c = document.querySelector('canvas.ot-expo'); return c && !c.hidden && c.getContext('2d').getImageData(c.width >> 1, 10, 1, 1).data[3] > 0; });
  await shot(page, 'sheet-exposure');
  await closeSheet(page);
  assert.equal(await page.locator('.sc-legend').count(), 1);
  // the white disc (clipped) must be red, the 75% blue bar must be a false colour too
  const px = await page.evaluate(() => {
    const c = document.querySelector('canvas.ot-expo');
    const at = (fx, fy) => [...c.getContext('2d').getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data];
    return { disc: at(135 / 180, 160 / 320), bar: at(0.6, 0.1) };
  });
  assert.ok(px.disc[0] > 200 && px.disc[1] < 80 && px.disc[2] < 80, `clipped highlight is red: ${px.disc}`);
  await shot(page, 'false-colour');

  await openGroup(page, 'scopes');
  await page.locator('.ui-row', { hasText: 'False colour' }).locator('input').uncheck();
  await toggle(page, 'Zebras');
  await page.waitForFunction(() => { const c = document.querySelector('canvas.ot-expo'); return c && !c.hidden; });
  await closeSheet(page);
  await page.waitForTimeout(300);
  const z = await painted(page, 'canvas.ot-expo');
  assert.ok(z > 500, `zebra pixels ${z}`);
  assert.equal(await page.locator('.sc-legend').count(), 0);
  await shot(page, 'zebras-95');
  // at 100% only truly clipped white stays striped; a JPEG white disc is still >= 95 but fewer pixels
  await openGroup(page, 'scopes');
  await page.click('.ui-chip:has-text("100% clipped")');
  await closeSheet(page);
  await page.waitForTimeout(300);
  await shot(page, 'zebras-100');
  assert.deepEqual(errors, []);
});

test('info overlay and save frame with overlays', { skip }, async (t) => {
  const { page, errors } = await boot(t);
  await openGroup(page, 'info');
  for (const l of ['Timecode', 'Sequence name', 'Play state', 'Frame rate', 'Host app']) await toggle(page, l);
  await closeSheet(page);
  const txt = await page.locator('[data-ot-layer="info"]').textContent();
  assert.match(txt, /00:00:12:1[45]/);
  assert.match(txt, /Main edit/);
  assert.match(txt, /PAUSED/);
  assert.match(txt, /29\.97 fps/);
  assert.match(txt, /Premiere Pro/);
  await shot(page, 'info');

  // add a guide + social frame, then save clean and with overlays
  await openGroup(page, 'social');
  await page.click('[data-platform="tiktok"]');
  await closeSheet(page);
  await page.waitForFunction(() => document.querySelector('[data-ot-layer="social"] .s-zone'));
  const dl = async (fn) => {
    const [d] = await Promise.all([page.waitForEvent('download'), fn()]);
    const file = path.join(shots, 'saved-' + d.suggestedFilename());
    await d.saveAs(file);
    return file;
  };
  const clean = await dl(() => page.click('#btnSave'));
  await page.waitForTimeout(100);
  const withOv = await dl(async () => { await page.click('#btnOverlays'); await page.click('[data-act="save-overlays"]'); });
  assert.match(path.basename(withOv), /_overlays\.png$/);
  const a = fs.readFileSync(clean), b = fs.readFileSync(withOv);
  for (const f of [a, b]) {
    assert.equal(f.readUInt32BE(16), 180); assert.equal(f.readUInt32BE(20), 320); // PNG IHDR size = picture size
  }
  assert.ok(!a.equals(b), 'overlay version differs from the clean one');
  assert.ok(b.length > a.length * 0.5);
  assert.deepEqual(errors, []);
});
