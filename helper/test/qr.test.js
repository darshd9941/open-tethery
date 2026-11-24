'use strict';
const test = require('node:test');
const assert = require('node:assert');
const jsQR = require('jsqr');
const { encode, toSvg } = require('../lib/qr');

function decode(text, scale = 4) {
  const { size, modules } = encode(text);
  const quiet = 4;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, dim, dim);
}

test('QR: session URL decodes', () => {
  const url = 'http://192.168.1.20:47825/c/CL7G';
  const r = decode(url);
  assert.ok(r, 'jsQR found a code');
  assert.strictEqual(r.data, url);
  assert.strictEqual(encode(url).version, 3);
});

test('QR: every version 1-10 round-trips', () => {
  const seen = new Set();
  for (const len of [1, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213]) {
    const text = Array.from({ length: len }, (_, i) => String.fromCharCode(65 + ((i * 7) % 26))).join('');
    const { version } = encode(text);
    seen.add(version);
    const r = decode(text);
    assert.ok(r, `decoded len ${len} (v${version})`);
    assert.strictEqual(r.data, text);
  }
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('QR: utf-8 and too-long input', () => {
  assert.strictEqual(decode('héllo ✓').data, 'héllo ✓');
  assert.throws(() => encode('x'.repeat(300)), /too long/);
});

test('QR: svg output is well formed', () => {
  const svg = toSvg('http://10.0.0.5:47825/c/ABCD');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
});
