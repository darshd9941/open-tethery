'use strict';
// Parses the bytes written by test_otx with the helper's real OTX1 parser.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const otx = require(path.join(__dirname, '..', '..', '..', 'helper', 'lib', 'otx1.js'));

const file = process.argv[2];
const msgs = [];
const parser = new otx.FrameParser((m) => msgs.push(m));
const bytes = fs.readFileSync(file);
// feed in odd-sized pieces to exercise reassembly
for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, Math.min(i + 7, bytes.length)));

assert.deepEqual(msgs.map((m) => m.type), [1, 3, 4, 4, 5]);
assert.deepEqual(msgs.map((m) => m.seq), [0, 1, 2, 3, 4]);

const jpeg = otx.parseFramePayload(msgs[0].payload);
assert.ok(jpeg);
assert.equal(jpeg.width, 1280);
assert.equal(jpeg.height, 720);
assert.equal(jpeg.seqWidth, 1920);
assert.equal(jpeg.seqHeight, 1080);
assert.equal(jpeg.ticks, 254016000000n * 5n + 123n);
assert.equal(jpeg.fpsNum, 30000);
assert.equal(jpeg.fpsDen, 1001);

const key = otx.parseH264Payload(msgs[2].payload);
assert.ok(key);
assert.equal(key.keyframe, true);
assert.equal(key.width, 1920);
assert.equal(key.height, 1080);
assert.equal(key.ticks, 254016000000n * 2n);
assert.equal(key.data[4], 0x67);
assert.equal(key.data.length, 23);

const delta = otx.parseH264Payload(msgs[3].payload);
assert.ok(delta);
assert.equal(delta.keyframe, false);
assert.equal(delta.ticks, -1n);

const audio = otx.parseAudioPayload(msgs[4].payload);
assert.ok(audio, 'audio payload accepted by helper');
assert.equal(audio.sampleRate, 48000);
assert.equal(audio.channels, 2);
assert.equal(audio.frames, 960);
assert.equal(audio.ticks, 254016000000n * 7n + 5292000n);
assert.equal(audio.samples.readInt16LE(4 * 100), 100);
assert.equal(audio.samples.readInt16LE(4 * 100 + 2), -100);

console.log('check_golden: ok (helper parsed', msgs.length, 'messages)');
