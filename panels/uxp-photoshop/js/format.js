'use strict';

// Small pure helpers shared by the panel and the capture code.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

// Own decoder: does not depend on atob/Buffer being present in the host.
function base64ToBytes(str) {
  const s = String(str).replace(/^data:[^,]*,/, '').replace(/[\s=]+/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s.charCodeAt(i) < 128 ? B64_INDEX[s.charCodeAt(i)] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out.subarray(0, n);
}

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parts = [];
  for (let i = 0; i < arr.length; i += 3) {
    const a = arr[i];
    const b = i + 1 < arr.length ? arr[i + 1] : 0;
    const c = i + 2 < arr.length ? arr[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    parts.push(
      B64[(triple >> 18) & 63],
      B64[(triple >> 12) & 63],
      i + 1 < arr.length ? B64[(triple >> 6) & 63] : '=',
      i + 2 < arr.length ? B64[triple & 63] : '='
    );
  }
  return parts.join('');
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

// Reduced ratio with "x" ("16x9"); odd ratios become "2.39x1" / "1x2.39".
function aspectString(w, h) {
  w = Math.round(w);
  h = Math.round(h);
  if (!(w > 0 && h > 0)) return '';
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  if (a <= 32 && b <= 32) return a + 'x' + b;
  const r = w / h;
  const dec = (x) => String(Number(x.toFixed(2)));
  return r >= 1 ? dec(r) + 'x1' : '1x' + dec(1 / r);
}

// Picture size for the JPEG: long edge <= maxSide and <= maxPixels in total.
function fitSize(docW, docH, maxSide, maxPixels) {
  docW = Math.max(1, Math.round(docW));
  docH = Math.max(1, Math.round(docH));
  const ratio = Math.min(1, maxSide / Math.max(docW, docH));
  let w = Math.max(1, Math.round(docW * ratio));
  let h = Math.max(1, Math.round(docH * ratio));
  if (w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  return { width: w, height: h };
}

function docLine(name, w, h) {
  if (!name) return 'Open a document in Photoshop to see it on the phone.';
  return name + ' · ' + Math.round(w) + ' × ' + Math.round(h);
}

function phonesText(n) {
  n = n | 0;
  if (n <= 0) return 'No phones connected';
  return n === 1 ? '1 phone connected' : n + ' phones connected';
}

// "http://192.168.1.20:47825/c/CL7G" -> "http://192.168.1.20:47825"
function shortUrl(url) {
  return String(url || '').replace(/\/c\/[^/]*$/, '').replace(/\/$/, '');
}

function errorText(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

module.exports = { base64ToBytes, bytesToBase64, aspectString, fitSize, docLine, phonesText, shortUrl, errorText };
