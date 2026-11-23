// Pure-logic tests for M4: scope maths, social JSON schema, guides geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../js/scope-math.js';
import { validatePlatform, fitFrame, toPx, wrapText, coverCrop, ICONS } from '../js/social.js';
import { safeRect, thirdsLines, gridLines, matteRects, mergeConfig, MATTES, centreMark } from '../js/guides.js';
import { mergeScopeConfig } from '../js/scopes.js';
import { infoLines } from '../js/overlays/info.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const socialDir = path.join(here, '..', 'social');
const solid = (r, g, b, n = 100) => { const d = new Uint8ClampedArray(n * 4); for (let i = 0; i < n; i++) d.set([r, g, b, 255], i * 4); return d; };

test('BT.709 luma and Cb/Cr', () => {
  assert.equal(M.luma709(1, 1, 1), 1);
  assert.equal(M.luma709(0, 0, 0), 0);
  assert.ok(Math.abs(M.luma709(0, 1, 0) - 0.7152) < 1e-9);
  const w = M.cbcr(1, 1, 1);
  assert.ok(Math.abs(w.cb) < 1e-9 && Math.abs(w.cr) < 1e-9);
  const red = M.cbcr(1, 0, 0);
  assert.ok(Math.abs(red.cr - 0.5) < 1e-6);
  const blue = M.cbcr(0, 0, 1);
  assert.ok(Math.abs(blue.cb - 0.5) < 1e-6);
});

test('histogram of pure white and pure black', () => {
  const white = M.analyse(solid(255, 255, 255), 10, 10, { hist: true });
  for (const k of ['luma', 'r', 'g', 'b']) { assert.equal(white.hist[k][255], 100); assert.equal(M.arrayMax(white.hist[k]), 100); }
  const black = M.analyse(solid(0, 0, 0), 10, 10, { hist: true });
  for (const k of ['luma', 'r', 'g', 'b']) assert.equal(black.hist[k][0], 100);
  const red = M.analyse(solid(255, 0, 0), 10, 10, { hist: true });
  assert.equal(red.hist.r[255], 100);
  assert.equal(red.hist.g[0], 100);
  assert.equal(red.hist.luma[Math.round(0.2126 * 255)], 100);
});

test('waveform puts a grey level on the right row for every column', () => {
  const r = M.analyse(solid(128, 128, 128, 20), 5, 4, { wave: true });
  for (let x = 0; x < 5; x++) assert.equal(r.wave[x * 256 + 128], 4);
});

test('75% colour bars land on the vectorscope targets', () => {
  const bars = [[1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0], [1, 0, 1], [1, 0, 0], [0, 0, 1], [0, 0, 0]].map((c) => c.map((v) => Math.round(v * 0.75 * 255)));
  const w = 80, h = 10;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...bars[Math.floor(x / 10)], 255], (y * w + x) * 4);
  const r = M.analyse(data, w, h, { vec: true });
  assert.equal(M.BAR_TARGETS.length, 6);
  for (const t of M.BAR_TARGETS) {
    const { gx, gy } = M.vecCell(t.cb, t.cr);
    let found = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) found += r.vec[(gy + dy) * M.VEC_SIZE + gx + dx];
    assert.ok(found >= 100, `bar ${t.name} has ${found} samples near its target`);
  }
  // white/black sit at the centre
  const c = M.vecCell(0, 0);
  assert.ok(r.vec[c.gy * M.VEC_SIZE + c.gx] >= 200);
});

test('skin line points up-left at 123 degrees', () => {
  const e = M.skinLineEnd(1);
  assert.ok(e.cb < 0 && e.cr > 0);
  assert.ok(Math.abs(Math.atan2(e.cr, e.cb) * 180 / Math.PI - 123) < 1e-9);
  // typical skin colour is near the line
  const s = M.cbcr(0.87, 0.65, 0.53);
  const ang = Math.atan2(s.cr, s.cb) * 180 / Math.PI;
  assert.ok(Math.abs(ang - 123) < 12, `skin angle ${ang}`);
});

test('false colour band mapping', () => {
  const b = (p) => M.FALSE_COLOUR_BANDS[M.falseColourBand(p)];
  assert.deepEqual(b(0).rgb, [123, 47, 191]);
  assert.deepEqual(b(5).rgb, [47, 95, 223]);
  assert.equal(b(35).rgb, null);
  assert.deepEqual(b(47).rgb, [63, 191, 74]);
  assert.deepEqual(b(90).rgb, [240, 138, 36]);
  assert.deepEqual(b(100).rgb, [224, 32, 32]);
  const out = new Uint8ClampedArray(8);
  M.falseColourImage(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]), out);
  assert.deepEqual([...out.slice(0, 4)], [224, 32, 32, 255]);
  assert.deepEqual([...out.slice(4, 8)], [123, 47, 191, 255]);
});

test('zebra threshold', () => {
  assert.equal(M.isZebra(255, 100), true);
  assert.equal(M.isZebra(254, 100), false);
  assert.equal(M.isZebra(243, 95), true); // 95.3 %
  assert.equal(M.isZebra(240, 95), false); // 94.1 %
  const out = new Uint8ClampedArray(8);
  M.zebraMask(new Uint8ClampedArray([255, 255, 255, 255, 100, 100, 100, 255]), out, 95);
  assert.equal(out[3], 255);
  assert.equal(out[7], 0);
});

test('analysis size and audio levels', () => {
  assert.deepEqual(M.analysisSize(1920, 1080, 320), { w: 320, h: 180 });
  assert.deepEqual(M.analysisSize(100, 50, 320), { w: 100, h: 50 });
  const full = M.chunkLevels(new Int16Array([32767, 0, -32768, 0]), 2);
  assert.ok(full.peakL > 0.999 && full.peakR === 0 && full.r === 0);
  const mono = M.chunkLevels(new Int16Array([16384, 16384]), 1);
  assert.ok(Math.abs(mono.l - 0.5) < 1e-6 && mono.l === mono.r);
  assert.equal(M.levelToMeter(1), 1);
  assert.equal(M.levelToMeter(0), 0);
  assert.ok(Math.abs(M.levelToMeter(0.1) - 2 / 3) < 1e-6); // -20 dB
});

test('every social platform file is valid, inside 0..1, and listed in the index', () => {
  const index = JSON.parse(fs.readFileSync(path.join(socialDir, 'index.json'), 'utf8'));
  const required = ['instagram-reels', 'instagram-feed', 'instagram-story', 'youtube', 'youtube-shorts', 'tiktok', 'x', 'facebook', 'snapchat', 'pinterest', 'reddit'];
  assert.deepEqual(index.platforms.map((p) => p.id).sort(), required.slice().sort());
  const files = fs.readdirSync(socialDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  assert.equal(files.length, required.length);
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(socialDir, f), 'utf8'));
    assert.equal(p.id + '.json', f);
    assert.deepEqual(validatePlatform(p), [], f);
    assert.ok(p.zones.length >= 2, `${f} has zones`);
    for (const z of p.zones) for (const ic of z.icons || []) assert.ok(ICONS[ic.shape]);
  }
});

test('validator catches bad data', () => {
  const good = JSON.parse(fs.readFileSync(path.join(socialDir, 'tiktok.json'), 'utf8'));
  const bad = structuredClone(good);
  bad.zones[0].rect = [0.5, 0.5, 0.8, 0.2];
  assert.ok(validatePlatform(bad).some((e) => /rect/.test(e)));
  const bad2 = structuredClone(good);
  bad2.zones[1].icons[0].shape = 'logo';
  assert.ok(validatePlatform(bad2).some((e) => /unknown icon/.test(e)));
  const bad3 = structuredClone(good);
  bad3.safe = [0, 0, 1, 1];
  assert.ok(validatePlatform(bad3).some((e) => /safe box overlaps/.test(e)));
});

test('social geometry helpers', () => {
  const f = fitFrame(360, 640, { w: 9, h: 16 });
  assert.deepEqual([f.x, f.y, f.w, f.h], [0, 0, 360, 640]);
  const y = fitFrame(360, 640, { w: 16, h: 9 });
  assert.ok(Math.abs(y.w - 360) < 1e-9 && Math.abs(y.h - 202.5) < 1e-9 && Math.abs(y.y - 218.75) < 1e-9);
  assert.deepEqual(toPx({ x: 10, y: 20, w: 100, h: 200 }, [0.5, 0.5, 0.1, 0.1]), { x: 60, y: 120, w: 10, h: 20 });
  assert.deepEqual(wrapText('one two three four five', 9, 2), ['one two', 'three…']);
  assert.deepEqual(wrapText('', 10, 2), []);
  assert.deepEqual(wrapText('short', 10, 2), ['short']);
  const c = coverCrop(400, 300);
  assert.deepEqual(c, { sx: 50, sy: 0, side: 300 });
});

test('guides geometry', () => {
  assert.deepEqual(safeRect(1000, 500, 90), { x: 50, y: 25, w: 900, h: 450 });
  const a = safeRect(1920, 1080, 93);
  assert.ok(Math.abs(a.x - 67.2) < 1e-9 && Math.abs(a.w - 1785.6) < 1e-9);
  assert.equal(thirdsLines(300, 150).length, 4);
  assert.equal(thirdsLines(300, 150)[0].x1, 100);
  assert.equal(gridLines(100, 100, 4, 3).length, 3 + 2);
  assert.equal(gridLines(100, 100, 1, 1).length, 0);
  const m = matteRects(1920, 1080, 2.39);
  assert.ok(Math.abs(m.keep.h - 1920 / 2.39) < 1e-9);
  assert.equal(m.bars.length, 2);
  assert.ok(Math.abs(m.bars[0].h * 2 + m.keep.h - 1080) < 1e-9);
  const p = matteRects(1920, 1080, 9 / 16); // vertical crop of a landscape picture: pillar bars
  assert.ok(Math.abs(p.keep.w - 607.5) < 1e-9);
  assert.equal(p.bars[0].w, p.bars[1].w);
  assert.equal(matteRects(1920, 1080, 16 / 9).bars.length, 0);
  assert.equal(MATTES.length, 7);
  assert.deepEqual(centreMark(200, 100).cx, 100);
});

test('guides and scopes config merge ignores junk', () => {
  const g = mergeConfig({ title: { on: true, pct: 5000 }, grid: { n: 'x' }, matte: { id: 'nope' }, thirds: 'yes' });
  assert.equal(g.title.on, true);
  assert.equal(g.title.pct, 100);
  assert.equal(g.grid.n, 4);
  assert.equal(g.matte.id, '2.39');
  assert.equal(g.thirds, false);
  assert.equal(g.action.pct, 93);
  const s = mergeScopeConfig({ widgets: { hist: { on: true, size: 9, mode: 'x' } }, zebra: { thr: 10 } });
  assert.equal(s.widgets.hist.size, 1);
  assert.equal(s.widgets.hist.mode, 'luma');
  assert.equal(s.zebra.thr, 70);
});

test('info lines follow the toggles', () => {
  const state = { host: { app: 'premiere', appName: 'Premiere Pro' }, sequence: { name: 'Main', fps: 25 }, playing: true, timecode: '00:00:01:00' };
  const all = infoLines({ timecode: true, sequence: true, play: true, fps: true, host: true }, state, 2);
  assert.deepEqual(all, ['00:00:02:00', 'Main', 'PLAYING', '25 fps', 'Premiere Pro']);
  assert.deepEqual(infoLines({ timecode: false, sequence: true }, state, 2), ['Main']);
  assert.deepEqual(infoLines({ timecode: true }, null, NaN), ['--:--:--:--']);
});
