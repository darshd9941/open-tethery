import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOTV1 } from '../js/otv1.js';
import { normalizeCode, codeFromPath, extractCode, editCode, isValidCode, lockText } from '../js/code.js';
import { formatTimecode, formatFps, formatClock, frameFileName } from '../js/timecode.js';
import { JitterScheduler, latencies } from '../js/jitter.js';
import { createSeekThrottle } from '../js/throttle.js';
import { controlState, errorText, clampTime, createTransport } from '../js/transport.js';
import { fitRect } from '../js/layout.js';
import { guessDeviceName } from '../js/device.js';
import { backoffMs } from '../js/net.js';
import { createStats } from '../js/stats.js';
import { makeFrame } from './fake-server.mjs';

// ---- OTV1 (byte-exact per PROTOCOL section 5)
test('parse video frame', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const buf = makeFrame({ jpeg, w: 640, h: 360, srcW: 3840, srcH: 2160, seq: 77, time: 12.5 });
  const m = parseOTV1(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.equal(m.kind, 'video');
  assert.equal(m.seq, 77);
  assert.equal(m.time, 12.5);
  assert.equal(m.keyframe, true);
  assert.deepEqual([m.width, m.height, m.srcW, m.srcH], [640, 360, 3840, 2160]);
  assert.deepEqual(Array.from(m.jpeg), Array.from(jpeg));
});

test('parse video frame from an offset view and NaN time', () => {
  const buf = makeFrame({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), w: 2, h: 2, srcW: 2, srcH: 2, time: NaN });
  const padded = Buffer.concat([Buffer.from([9, 9, 9]), buf]);
  const m = parseOTV1(new Uint8Array(padded.buffer, padded.byteOffset + 3, buf.length));
  assert.equal(m.kind, 'video');
  assert.ok(Number.isNaN(m.time));
});

test('parse pcm audio', () => {
  const frames = 4;
  const buf = Buffer.alloc(32 + frames * 2 * 2);
  buf.write('OTV1', 0, 'ascii');
  buf[4] = 2;
  buf.writeUInt32LE(5, 8);
  buf.writeDoubleLE(1.25, 16);
  buf.writeUInt32LE(48000, 24);
  buf[28] = 2; buf[29] = 1;
  buf.writeUInt16LE(frames, 30);
  for (let i = 0; i < frames * 2; i++) buf.writeInt16LE(i % 2 ? -1000 - i : 1000 + i, 32 + i * 2);
  const m = parseOTV1(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.equal(m.kind, 'audio');
  assert.equal(m.sampleRate, 48000);
  assert.equal(m.channels, 2);
  assert.equal(m.frames, 4);
  assert.equal(m.time, 1.25);
  assert.equal(m.samples[0], 1000);
  assert.equal(m.samples[1], -1001);
  assert.equal(m.samples.length, 8);
});

test('rejects malformed binary', () => {
  assert.equal(parseOTV1(new ArrayBuffer(10)), null);
  const bad = Buffer.alloc(40); bad.write('XXXX', 0, 'ascii');
  assert.equal(parseOTV1(bad.buffer.slice(0, 40)), null);
  const short = Buffer.alloc(40); short.write('OTV1', 0, 'ascii'); short[4] = 2; short.writeUInt32LE(48000, 24); short[28] = 2; short[29] = 1; short.writeUInt16LE(100, 30);
  assert.equal(parseOTV1(short.buffer.slice(0, 40)), null, 'truncated audio');
  const unk = Buffer.alloc(40); unk.write('OTV1', 0, 'ascii'); unk[4] = 9;
  assert.equal(parseOTV1(unk.buffer.slice(0, 40)), null);
});

// ---- code input
test('normalizeCode is case-insensitive and drops invalid characters', () => {
  assert.equal(normalizeCode('cl7g'), 'CL7G');
  assert.equal(normalizeCode(' c-l 7g!'), 'CL7G');
  assert.equal(normalizeCode('0O1I'), '');
  assert.ok(isValidCode('CL7G'));
  assert.ok(!isValidCode('cl7g'));
});

test('codeFromPath', () => {
  assert.equal(codeFromPath('/c/cl7g'), 'CL7G');
  assert.equal(codeFromPath('/c/CL7G/'), 'CL7G');
  assert.equal(codeFromPath('/'), null);
  assert.equal(codeFromPath('/c/CL7'), null);
  assert.equal(codeFromPath('/c/CL0G'), null);
});

test('extractCode handles pasted links and sentences', () => {
  assert.equal(extractCode('http://192.168.1.20:47825/c/cl7g'), 'CL7G');
  assert.equal(extractCode('my code is ab23 ok'), 'AB23');
  assert.equal(extractCode('cl7g'), 'CL7G');
});

test('editCode types, auto-advances and pastes', () => {
  let r = editCode(['', '', '', ''], 0, 'c');
  assert.deepEqual(r.chars, ['C', '', '', '']);
  assert.equal(r.focus, 1);
  assert.equal(r.complete, false);
  r = editCode(r.chars, 1, 'L');
  r = editCode(r.chars, 2, '7');
  r = editCode(r.chars, 3, 'g');
  assert.deepEqual(r.chars, ['C', 'L', '7', 'G']);
  assert.equal(r.complete, true);
  assert.equal(r.focus, 3);
  r = editCode(['', '', '', ''], 0, 'http://pc/c/ab23');
  assert.deepEqual(r.chars, ['A', 'B', '2', '3']);
  assert.equal(r.complete, true);
  r = editCode(['A', '', '', ''], 1, '#');
  assert.deepEqual(r.chars, ['A', '', '', ''], 'invalid char ignored');
  assert.equal(r.focus, 1);
});

test('lockText', () => {
  assert.equal(lockText(1), 'Too many wrong codes. Try again in 1 second.');
  assert.equal(lockText(59.2), 'Too many wrong codes. Try again in 60 seconds.');
});

// ---- timecode
test('formatTimecode', () => {
  assert.equal(formatTimecode(0, 24), '00:00:00:00');
  assert.equal(formatTimecode(12.5, 24), '00:00:12:12');
  assert.equal(formatTimecode(1.001, 24000 / 1001), '00:00:01:00');
  assert.equal(formatTimecode(3661.5, 30), '01:01:01:15');
  assert.equal(formatTimecode(NaN, 30), '--:--:--:--');
  assert.equal(formatTimecode(5, undefined), '00:00:05');
  assert.equal(formatTimecode(-3, 25), '00:00:00:00');
});

test('formatFps / formatClock / frameFileName', () => {
  assert.equal(formatFps(23.976), '23.976');
  assert.equal(formatFps(30), '30');
  assert.equal(formatFps(29.97), '29.97');
  assert.equal(formatFps(NaN), '');
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(frameFileName('Main edit', '00:00:12:12'), 'Main_edit_00-00-12-12.png');
  assert.equal(frameFileName('a/b:c?', ''), 'a-b-c.png');
  assert.equal(frameFileName(undefined, '00:00:01:00'), 'frame_00-00-01-00.png');
});

// ---- jitter buffer
test('latencies split the sync offset between audio and video', () => {
  assert.deepEqual(latencies(0, true), { audioSec: 0.1, videoSec: 0.1 });
  assert.deepEqual(latencies(200, true), { audioSec: 0.3, videoSec: 0.1 });
  assert.deepEqual(latencies(-300, true), { audioSec: 0.1, videoSec: 0.4 });
  assert.deepEqual(latencies(900, true), { audioSec: 0.4, videoSec: 0.1 }, 'clamped');
  assert.equal(latencies(100, false).videoSec, 0);
});

test('jitter scheduler lays chunks back to back', () => {
  const j = new JitterScheduler();
  let r = j.schedule(10, 5, 0.02, 0.1);
  assert.equal(r.reanchored, true);
  assert.ok(Math.abs(r.startAt - 10.1) < 1e-9);
  r = j.schedule(10.02, 5.02, 0.02, 0.1);
  assert.equal(r.reanchored, false);
  assert.ok(Math.abs(r.startAt - 10.12) < 1e-9);
  r = j.schedule(10.04, 5.04, 0.02, 0.1);
  assert.ok(Math.abs(r.startAt - 10.14) < 1e-9);
});

test('jitter scheduler re-anchors on underrun and on media-time jump (seek)', () => {
  const j = new JitterScheduler();
  j.schedule(10, 5, 0.02, 0.1);
  let r = j.schedule(11, 5.02, 0.02, 0.1); // chunk arrived after its slot passed
  assert.equal(r.reanchored, true);
  assert.ok(Math.abs(r.startAt - 11.1) < 1e-9);
  r = j.schedule(11.02, 40, 0.02, 0.1); // seek
  assert.equal(r.reanchored, true);
  assert.ok(Math.abs(r.startAt - 11.12) < 1e-9);
});

test('jitter scheduler drops chunks when running too far ahead', () => {
  const j = new JitterScheduler();
  let r;
  for (let i = 0; i < 40; i++) r = j.schedule(10, 5 + i * 0.02, 0.02, 0.1); // burst, clock standing still
  assert.equal(r.drop, true);
  j.reset();
  assert.equal(j.schedule(20, NaN, 0.02, 0.1).reanchored, true);
});

// ---- seek throttle
test('seek throttle sends the first at once, then at most every interval, latest wins', () => {
  let t = 0;
  const timers = [];
  const sent = [];
  const th = createSeekThrottle((v) => sent.push(v), {
    intervalMs: 67,
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
  });
  th.push(1); // leading edge
  assert.deepEqual(sent, [1]);
  t = 10; th.push(2);
  t = 20; th.push(3);
  assert.deepEqual(sent, [1], 'held back');
  assert.equal(timers.filter(Boolean).length, 1, 'one trailing timer');
  t = 67; timers[0].fn();
  assert.deepEqual(sent, [1, 3]);
  t = 80; th.push(4);
  th.flush();
  assert.deepEqual(sent, [1, 3, 4], 'flush sends the pending value');
  // 100 rapid pushes over one second never exceed ~15 sends
  sent.length = 0; timers.length = 0; t = 5000;
  const th2 = createSeekThrottle((v) => sent.push(v), { intervalMs: 67, now: () => t, setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, clearTimer: () => {} });
  for (let i = 0; i < 100; i++) {
    t = 5000 + i * 10;
    for (const tm of timers) if (tm && tm.at <= t) { const f = tm.fn; tm.fn = () => {}; tm.at = Infinity; f(); }
    th2.push(i);
  }
  assert.ok(sent.length <= 16, `sent ${sent.length}`);
});

// ---- transport
test('controlState', () => {
  const live = { status: 'live', host: { app: 'premiere' } };
  assert.equal(controlState({ control: true, state: live }).enabled, true);
  assert.equal(controlState({ control: false, state: live }).enabled, false);
  assert.match(controlState({ control: false, state: live }).note, /Allow control from phones/);
  assert.match(controlState({ control: true, state: { status: 'live', host: { app: 'photoshop' } } }).note, /Photoshop/);
  assert.equal(controlState({ control: true, state: { status: 'idle', host: { app: 'premiere' } } }).enabled, false);
  assert.equal(controlState({ control: true, state: null }).enabled, false);
});

test('errorText and clampTime', () => {
  assert.match(errorText('control-off'), /Allow control/);
  assert.match(errorText('no-host'), /No Premiere/);
  assert.match(errorText('unsupported', 'step'), /step/);
  assert.equal(clampTime(-4, 100), 0);
  assert.equal(clampTime(150, 100), 100);
  assert.equal(clampTime(5, undefined), 5);
});

test('transport builds protocol messages', () => {
  const sent = [];
  const tp = createTransport({ send: (m) => sent.push(m), getTime: () => 10, getDuration: () => 12, throttle: { now: () => 0, setTimer: () => 1, clearTimer: () => {} } });
  tp.play(); tp.pause(); tp.toggle(); tp.step(-1); tp.jump('end'); tp.skip(5); tp.skip(-5);
  assert.deepEqual(sent, [
    { t: 'control', cmd: 'play' }, { t: 'control', cmd: 'pause' }, { t: 'control', cmd: 'toggle' },
    { t: 'control', cmd: 'step', frames: -1 }, { t: 'control', cmd: 'jump', to: 'end' },
    { t: 'control', cmd: 'seek', time: 12 }, { t: 'control', cmd: 'seek', time: 5 },
  ]);
  sent.length = 0;
  tp.scrub(3.5);
  assert.deepEqual(sent, [{ t: 'control', cmd: 'seek', time: 3.5 }]);
});

// ---- misc
test('fitRect letter-boxes', () => {
  assert.deepEqual(fitRect(400, 800, 16, 9), { x: 0, y: 288, w: 400, h: 225 });
  assert.deepEqual(fitRect(400, 400, 9, 16), { x: 88, y: 0, w: 225, h: 400 });
  assert.deepEqual(fitRect(0, 0, 9, 16), { x: 0, y: 0, w: 0, h: 0 });
});

test('guessDeviceName', () => {
  assert.equal(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
  assert.equal(guessDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'), 'Pixel 8');
  assert.equal(guessDeviceName('Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A) Chrome'), 'SM-S918B');
  assert.equal(guessDeviceName('Mozilla/5.0 (Linux; Android 10; K) Chrome'), 'K');
  assert.equal(guessDeviceName(''), 'Phone');
});

test('backoff grows and caps', () => {
  assert.equal(backoffMs(0), 500);
  assert.ok(backoffMs(3) > backoffMs(2));
  assert.equal(backoffMs(30), 8000);
});

test('stats fps and delay', () => {
  let t = 0;
  const s = createStats({ now: () => t });
  for (let i = 0; i < 25; i++) { t = i * 40; s.frameShown(8); }
  s.pong(100);
  const snap = s.snapshot();
  assert.ok(Math.abs(snap.fps - 25) < 0.5);
  assert.equal(snap.decodeMs, 8);
  assert.equal(snap.delayMs, 58);
});

test('brand: loadBrand reads /product.json and keeps the fallback on failure', async () => {
  const { brand, loadBrand } = await import('../js/brand.js');
  assert.equal(brand.name, 'Pocket Monitor');
  await loadBrand(async () => { throw new Error('offline'); });
  assert.equal(brand.name, 'Pocket Monitor');
  await loadBrand(async () => ({ ok: true, json: async () => ({ name: 'Zed Cam', shortName: 'Zed' }) }));
  assert.equal(brand.name, 'Zed Cam');
  assert.equal(brand.shortName, 'Zed');
});
