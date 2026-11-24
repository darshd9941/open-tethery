'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generateCode, ALPHABET, Lockout, codesMatch, isLoopbackAddress } = require('../lib/session');
const { FrameParser, parseFramePayload, message, frameMessage, TICKS_PER_SECOND } = require('../lib/otx1');
const otv1 = require('../lib/otv1');
const { reduceAspect, timecodeFromTime, StateModel } = require('../lib/state');
const { lanAddresses, sessionUrls } = require('../lib/lan');
const { loadConfig } = require('../lib/config');
const { safeJoin } = require('../lib/static');
const { JPEG } = require('../tools/testcard');

test('codes: 4 chars from the alphabet, case-insensitive match', () => {
  for (let i = 0; i < 200; i += 1) {
    const c = generateCode();
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  }
  assert.strictEqual(ALPHABET.length, 32);
  assert.ok(codesMatch(' cl7g ', 'CL7G'));
  assert.ok(!codesMatch('CL7H', 'CL7G'));
  assert.ok(!codesMatch(undefined, 'CL7G'));
});

test('lockout: 5 wrong in 5 min locks for 60 s, then frees', () => {
  const l = new Lockout();
  const ip = '::ffff:192.168.1.31';
  let t = 1000;
  for (let i = 0; i < 4; i += 1) {
    l.fail(ip, t);
    assert.strictEqual(l.check(ip, t).locked, false);
  }
  l.fail(ip, t);
  const c = l.check('192.168.1.31', t + 1000);
  assert.strictEqual(c.locked, true);
  assert.strictEqual(c.retryInSec, 59);
  assert.strictEqual(l.check('192.168.1.99', t).locked, false);
  assert.strictEqual(l.check(ip, t + 60001).locked, false);
});

test('lockout: failures older than 5 minutes do not count; success resets', () => {
  const l = new Lockout();
  for (let i = 0; i < 4; i += 1) l.fail('1.1.1.1', 0);
  l.fail('1.1.1.1', 5 * 60 * 1000 + 1);
  assert.strictEqual(l.check('1.1.1.1', 5 * 60 * 1000 + 2).locked, false);
  l.success('1.1.1.1');
  for (let i = 0; i < 4; i += 1) l.fail('1.1.1.1', 10);
  assert.strictEqual(l.check('1.1.1.1', 11).locked, false);
});

test('loopback detection', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopbackAddress(a));
  for (const a of ['192.168.1.2', '::ffff:10.0.0.1', '']) assert.ok(!isLoopbackAddress(a));
});

function collect() {
  const out = [];
  return { out, parser: new FrameParser((m) => out.push(m)) };
}

test('OTX1: several messages in one chunk', () => {
  const { out, parser } = collect();
  parser.push(Buffer.concat([message(3, 1, Buffer.alloc(0)), message(2, 2, Buffer.from('{"playing":true}')), message(3, 3, Buffer.alloc(0))]));
  assert.deepStrictEqual(out.map((m) => [m.type, m.seq]), [[3, 1], [2, 2], [3, 3]]);
});

test('OTX1: byte-by-byte delivery of a frame', () => {
  const { out, parser } = collect();
  const wire = frameMessage(9, JPEG, { width: 320, height: 180, seqWidth: 1920, seqHeight: 1080, ticks: TICKS_PER_SECOND * 2n, fpsNum: 25, fpsDen: 1 });
  for (let i = 0; i < wire.length; i += 1) parser.push(wire.subarray(i, i + 1));
  assert.strictEqual(out.length, 1);
  const f = parseFramePayload(out[0].payload);
  assert.strictEqual(f.width, 320);
  assert.strictEqual(f.seqWidth, 1920);
  assert.strictEqual(f.time, 2);
  assert.ok(f.jpeg.equals(JPEG));
});

test('OTX1: frame split mid-payload with next frame glued on', () => {
  const { out, parser } = collect();
  const a = frameMessage(1, JPEG, { width: 10, height: 10 });
  const b = frameMessage(2, JPEG, { width: 10, height: 10 });
  const all = Buffer.concat([a, b]);
  parser.push(all.subarray(0, 100));
  parser.push(all.subarray(100, a.length + 5));
  parser.push(all.subarray(a.length + 5));
  assert.deepStrictEqual(out.map((m) => m.seq), [1, 2]);
});

test('OTX1: bad magic and oversize payload throw', () => {
  assert.throws(() => collect().parser.push(Buffer.from('HTTP/1.1 200')), /bad magic/);
  const head = Buffer.alloc(16);
  head.write('OTXF', 0);
  head[4] = 1;
  head.writeUInt32LE(32 * 1024 * 1024 + 1, 8);
  assert.throws(() => collect().parser.push(head), /too large/);
  // exactly at the limit is accepted (header only, payload pending)
  head.writeUInt32LE(32 * 1024 * 1024, 8);
  assert.doesNotThrow(() => collect().parser.push(head));
});

test('OTX1: non-JPEG frame payload is rejected', () => {
  assert.strictEqual(parseFramePayload(Buffer.alloc(40)), null);
  assert.strictEqual(parseFramePayload(Buffer.alloc(5)), null);
});

test('OTV1: JPEG header layout is byte exact', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const b = otv1.encodeFrame({ seq: 0x01020304, flags: 1, time: 12.5, width: 640, height: 360, srcWidth: 3840, srcHeight: 2160, jpeg });
  const exp = Buffer.alloc(36);
  exp.write('OTV1', 0, 'ascii');
  exp[4] = 1;
  exp[5] = 1;
  exp.writeUInt32LE(0x01020304, 8);
  exp.writeDoubleLE(12.5, 16);
  exp.writeUInt16LE(640, 24);
  exp.writeUInt16LE(360, 26);
  exp.writeUInt16LE(3840, 28);
  exp.writeUInt16LE(2160, 30);
  jpeg.copy(exp, 32);
  assert.strictEqual(b.toString('hex'), exp.toString('hex'));
  assert.strictEqual(b.subarray(0, 4).toString(), 'OTV1');
  assert.deepStrictEqual([...b.subarray(24, 32)], [0x80, 0x02, 0x68, 0x01, 0x00, 0x0f, 0x70, 0x08]);
  const d = otv1.decode(b);
  assert.strictEqual(d.time, 12.5);
  assert.strictEqual(d.srcWidth, 3840);
  assert.ok(d.jpeg.equals(jpeg));
});

test('OTV1: PCM header layout and NaN time', () => {
  const samples = Buffer.alloc(8, 5);
  const b = otv1.encodeAudio({ seq: 7, frames: 960, samples });
  assert.strictEqual(b.length, 24 + 8 + 8);
  assert.strictEqual(b[4], 2);
  assert.strictEqual(b.readUInt32LE(8), 7);
  assert.ok(Number.isNaN(b.readDoubleLE(16)));
  assert.strictEqual(b.readUInt32LE(24), 48000);
  assert.strictEqual(b[28], 2);
  assert.strictEqual(b[29], 1);
  assert.strictEqual(b.readUInt16LE(30), 960);
  assert.strictEqual(otv1.decode(b).frames, 960);
  assert.strictEqual(otv1.decode(Buffer.from('nope')), null);
});

test('aspect reduction', () => {
  assert.strictEqual(reduceAspect(3840, 2160), '16x9');
  assert.strictEqual(reduceAspect(1080, 1920), '9x16');
  assert.strictEqual(reduceAspect(1080, 1350), '4x5');
  assert.strictEqual(reduceAspect(1000, 1000), '1x1');
  assert.strictEqual(reduceAspect(2048, 858), '2.39x1');
  assert.strictEqual(reduceAspect(4096, 2160), '1.9x1');
  assert.strictEqual(reduceAspect(0, 10), undefined);
});

test('timecode from time + fps', () => {
  assert.strictEqual(timecodeFromTime(0, 25, 1), '00:00:00:00');
  assert.strictEqual(timecodeFromTime(61.5, 24, 1), '00:01:01:12');
  assert.strictEqual(timecodeFromTime(3600, 25, 1), '01:00:00:00');
  assert.strictEqual(timecodeFromTime(-1, 25, 1), '00:00:00:00');
  assert.strictEqual(timecodeFromTime(1, 0, 0), '00:00:01:00');
  assert.strictEqual(timecodeFromTime(12.5, 24000, 1001), '00:00:12:11');
  const f = 1001 / 30000;
  assert.strictEqual(timecodeFromTime(1799 * f, 30000, 1001), '00:00:59;29');
  assert.strictEqual(timecodeFromTime(1800 * f, 30000, 1001), '00:01:00;02');
  assert.strictEqual(timecodeFromTime(17982 * f, 30000, 1001), '00:10:00;00');
});

test('state model: idle after 3 s, merges panel + transmit', () => {
  let now = 1000;
  const m = new StateModel({ now: () => now });
  assert.strictEqual(m.snapshot().status, 'idle');
  m.setHost('panel', 'p1', { host: { app: 'premiere', appName: 'Premiere Pro' }, sequence: { name: 'Main', width: 3840, height: 2160 }, playing: false, time: 5 });
  m.setTransmitConnected(true);
  m.noteFrame({ origin: 'transmit', time: 12.5, srcWidth: 3840, srcHeight: 2160, fpsNum: 24000, fpsDen: 1001 });
  let s = m.snapshot(2);
  assert.strictEqual(s.status, 'live');
  assert.strictEqual(s.sequence.aspect, '16x9');
  assert.strictEqual(s.sequence.fps, 23.976);
  assert.strictEqual(s.time, 12.5);
  assert.strictEqual(s.timecode, '00:00:12:11');
  assert.strictEqual(s.engine.transmit, true);
  assert.strictEqual(s.viewers, 2);
  now += 3001;
  s = m.snapshot();
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.engine.sending, false);
});

test('lan: ranking, virtual adapters last, override first', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'vEthernet (WSL)': [{ address: '172.20.0.1', family: 'IPv4', internal: false }],
    'Wi-Fi': [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
  };
  const addrs = lanAddresses({ interfaces: ifaces });
  assert.deepStrictEqual(addrs.map((a) => a.ip), ['192.168.1.20', '100.101.102.103', '172.20.0.1']);
  assert.strictEqual(lanAddresses({ interfaces: ifaces, lanIp: '10.9.9.9' })[0].ip, '10.9.9.9');
  const { urls, primaryUrl } = sessionUrls(addrs, 47825, 'CL7G');
  assert.strictEqual(primaryUrl, 'http://192.168.1.20:47825/c/CL7G');
  assert.strictEqual(urls.length, 3);
  assert.strictEqual(sessionUrls([], 47825, 'AB').primaryUrl, 'http://127.0.0.1:47825/c/AB');
});

test('config: env port overrides file', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ port: 5000, lanIp: '10.0.0.7' }));
  assert.strictEqual(loadConfig({ configPath: file, env: {} }).port, 5000);
  const c = loadConfig({ configPath: file, env: { OPEN_TETHERY_PORT: '6000' } });
  assert.strictEqual(c.port, 6000);
  assert.strictEqual(c.lanIp, '10.0.0.7');
  assert.strictEqual(loadConfig({ configPath: path.join(dir, 'none.json'), env: {} }).port, 47825);
});

test('static: safeJoin blocks traversal', () => {
  const root = '/srv/viewer';
  assert.strictEqual(safeJoin(root, '/app.js'), '/srv/viewer/app.js');
  assert.strictEqual(safeJoin(root, '/../etc/passwd'), '/srv/viewer/etc/passwd');
  assert.strictEqual(safeJoin(root, '/%2e%2e/%2e%2e/etc/passwd'), '/srv/viewer/etc/passwd');
  assert.strictEqual(safeJoin(root, '/a%00b'), null);
  assert.strictEqual(safeJoin(root, '/a\\..\\b'), null);
  assert.strictEqual(safeJoin(root, '/%E0%A4%A'), null);
});

test('state model: heartbeats keep Transmit live; a source stays live while connected', () => {
  let now = 100000;
  const m = new StateModel({ now: () => now });
  m.setTransmitConnected(true);
  assert.strictEqual(m.snapshot().status, 'idle'); // connected but nothing received yet
  m.noteTransmitActivity();
  now += 2900;
  assert.strictEqual(m.snapshot().status, 'live');
  m.noteTransmitActivity();
  now += 2900;
  assert.strictEqual(m.snapshot().status, 'live');
  now += 200;
  assert.strictEqual(m.snapshot().status, 'idle');

  m.noteFrame({ origin: 'source', sourceId: 's1', time: NaN, srcWidth: 1080, srcHeight: 1350 });
  now += 60000;
  assert.strictEqual(m.snapshot().status, 'live');
  assert.strictEqual(m.snapshot().sequence.aspect, '4x5');
  m.clearHost('source', 's1');
  assert.strictEqual(m.snapshot().status, 'idle');
});

test('product: loadProduct reads product.json override; placeholder uses the name', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prod-')), 'product.json');
  fs.writeFileSync(f, JSON.stringify({ name: 'Zed <Cam>', shortName: 'Zed' }));
  const old = process.env.OT_PRODUCT_FILE;
  process.env.OT_PRODUCT_FILE = f;
  try {
    const { loadProduct, publicProduct } = require('../lib/product');
    const p = loadProduct();
    assert.strictEqual(p.name, 'Zed <Cam>');
    assert.strictEqual(publicProduct(p).shortName, 'Zed');
    const html = require('../lib/static').placeholder(p.name);
    assert.match(html, /<h1>Zed &lt;Cam&gt;<\/h1>/);
  } finally {
    if (old === undefined) delete process.env.OT_PRODUCT_FILE; else process.env.OT_PRODUCT_FILE = old;
  }
});
