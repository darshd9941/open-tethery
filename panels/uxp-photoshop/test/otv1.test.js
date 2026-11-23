'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packFrame, fitU16 } = require('../js/otv1');
const { aspectString, base64ToBytes, fitSize, shortUrl, phonesText } = require('../js/format');
const { resolveProfile, injectProfile } = require('../js/icc');

test('packFrame is byte-exact per PROTOCOL section 5', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const out = packFrame({ jpeg, seq: 7, width: 1600, height: 900, srcWidth: 3840, srcHeight: 2160 });
  assert.equal(out.length, 24 + 8 + jpeg.length);
  assert.equal(Buffer.from(out.subarray(0, 4)).toString('latin1'), 'OTV1');
  assert.equal(out[4], 1); // kind
  assert.equal(out[5], 1); // flags: still
  assert.equal(out[6], 0);
  assert.equal(out[7], 0);
  const b = Buffer.from(out.buffer, out.byteOffset, out.length);
  assert.equal(b.readUInt32LE(8), 7);
  assert.equal(b.readUInt32LE(12), 0);
  assert.ok(Number.isNaN(b.readDoubleLE(16)));
  assert.equal(b.readUInt16LE(24), 1600);
  assert.equal(b.readUInt16LE(26), 900);
  assert.equal(b.readUInt16LE(28), 3840);
  assert.equal(b.readUInt16LE(30), 2160);
  assert.deepEqual(Array.from(out.subarray(32)), Array.from(jpeg));
});

test('packFrame writes media time and flags when given', () => {
  const out = packFrame({ jpeg: new Uint8Array([1]), seq: 0xffffffff, time: 12.5, flags: 0, width: 2, height: 2, srcWidth: 2, srcHeight: 2 });
  const b = Buffer.from(out);
  assert.equal(b.readUInt32LE(8), 0xffffffff);
  assert.equal(b.readDoubleLE(16), 12.5);
  assert.equal(out[5], 0);
});

test('fitU16 keeps aspect for huge documents', () => {
  assert.deepEqual(fitU16(1920, 1080), [1920, 1080]);
  const [w, h] = fitU16(130000, 65000);
  assert.equal(w, 65535);
  assert.ok(Math.abs(w / h - 2) < 0.01);
});

test('aspectString', () => {
  assert.equal(aspectString(3840, 2160), '16x9');
  assert.equal(aspectString(1080, 1920), '9x16');
  assert.equal(aspectString(1080, 1350), '4x5');
  assert.equal(aspectString(1000, 1000), '1x1');
  assert.equal(aspectString(2390, 1000), '2.39x1');
  assert.equal(aspectString(0, 10), '');
});

test('fitSize limits long edge and pixel count', () => {
  assert.deepEqual(fitSize(4000, 2000, 1600, 12e6), { width: 1600, height: 800 });
  assert.deepEqual(fitSize(800, 600, 1600, 12e6), { width: 800, height: 600 });
  const s = fitSize(4000, 4000, 4000, 1e6);
  assert.ok(s.width * s.height <= 1e6);
});

test('base64ToBytes and small text helpers', () => {
  assert.deepEqual(Array.from(base64ToBytes('AP8Q')), [0, 255, 16]);
  assert.deepEqual(Array.from(base64ToBytes('/9g=')), [255, 216]);
  assert.equal(shortUrl('http://192.168.1.20:47825/c/CL7G'), 'http://192.168.1.20:47825');
  assert.equal(phonesText(0), 'No phones connected');
  assert.equal(phonesText(1), '1 phone connected');
  assert.equal(phonesText(3), '3 phones connected');
});

test('ICC injection puts the profile after SOI and replaces an old one', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);
  const icc = resolveProfile('Display P3');
  assert.ok(icc && icc.length > 100);
  assert.equal(resolveProfile('unknown profile'), null);
  const once = injectProfile(jpeg, icc);
  assert.equal(once[2], 0xff);
  assert.equal(once[3], 0xe2);
  assert.equal(Buffer.from(once.subarray(6, 17)).toString('latin1'), 'ICC_PROFILE');
  assert.equal(once.length, jpeg.length + 4 + 14 + icc.length);
  const twice = injectProfile(once, resolveProfile('sRGB IEC61966-2.1'));
  assert.equal(twice.length, jpeg.length + 4 + 14 + resolveProfile('sRGB').length);
  assert.equal(injectProfile(new Uint8Array([1, 2, 3, 4]), icc)[0], 1); // not a JPEG: untouched
});
