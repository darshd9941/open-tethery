'use strict';
// Run: node --test tools/transmit-parser.test.js
const test = require('node:test');
const assert = require('node:assert');
const { FrameParser, ticksToTimecode, parseFramePayload, TICKS_PER_SECOND } = require('../relay/transmit-ingest');
const { message, frameMessage } = require('./fake-transmit');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7), Buffer.from([0xff, 0xd9])]);

function collect() {
  const out = [];
  return { out, parser: new FrameParser((m) => out.push(m)) };
}

test('merged chunks: several messages in one chunk', () => {
  const { out, parser } = collect();
  parser.push(Buffer.concat([message(3, 1, Buffer.alloc(0)), message(2, 2, Buffer.from('{"playing":true}')), message(3, 3, Buffer.alloc(0))]));
  assert.deepStrictEqual(out.map((m) => [m.type, m.seq]), [[3, 1], [2, 2], [3, 3]]);
});

test('split chunks: byte-by-byte delivery of a frame', () => {
  const { out, parser } = collect();
  const wire = frameMessage(9, JPEG, { width: 320, height: 180 }, 0n, 25, 1);
  for (let i = 0; i < wire.length; i += 1) parser.push(wire.subarray(i, i + 1));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].seq, 9);
  const f = parseFramePayload(out[0].payload);
  assert.strictEqual(f.width, 320);
  assert.strictEqual(f.height, 180);
  assert.ok(f.jpeg.equals(JPEG));
});

test('mixed: frame split mid-payload, next frame glued on', () => {
  const { out, parser } = collect();
  const a = frameMessage(1, JPEG, { width: 10, height: 10 }, 0n, 25, 1);
  const b = frameMessage(2, JPEG, { width: 10, height: 10 }, 0n, 25, 1);
  const all = Buffer.concat([a, b]);
  parser.push(all.subarray(0, 100));
  parser.push(all.subarray(100, a.length + 5));
  parser.push(all.subarray(a.length + 5));
  assert.deepStrictEqual(out.map((m) => m.seq), [1, 2]);
});

test('bad magic throws (even on first bytes)', () => {
  const { parser } = collect();
  assert.throws(() => parser.push(Buffer.from('HTTP/1.1 200')), /bad magic/);
});

test('payload over 32 MiB throws', () => {
  const { parser } = collect();
  const head = Buffer.alloc(16);
  head.write('OTXF', 0);
  head[4] = 1;
  head.writeUInt32LE(32 * 1024 * 1024 + 1, 8);
  assert.throws(() => parser.push(head), /too large/);
});

test('timecode: ticks + fps', () => {
  assert.strictEqual(ticksToTimecode(0n, 25, 1), '00:00:00:00');
  assert.strictEqual(ticksToTimecode(TICKS_PER_SECOND * 61n + TICKS_PER_SECOND / 2n, 24, 1), '00:01:01:12');
  assert.strictEqual(ticksToTimecode(TICKS_PER_SECOND * 3600n, 25, 1), '01:00:00:00');
  assert.strictEqual(ticksToTimecode(-5n, 25, 1), '00:00:00:00');
  assert.strictEqual(ticksToTimecode(TICKS_PER_SECOND, 0, 0), '00:00:01:00'); // unknown fps -> 24
});

test('timecode: 29.97 drop-frame', () => {
  const tpf = (TICKS_PER_SECOND * 1001n) / 30000n;
  assert.strictEqual(ticksToTimecode(tpf * 1799n, 30000, 1001), '00:00:59;29');
  assert.strictEqual(ticksToTimecode(tpf * 1800n, 30000, 1001), '00:01:00;02');
  assert.strictEqual(ticksToTimecode(tpf * 17982n, 30000, 1001), '00:10:00;00');
});
