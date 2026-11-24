'use strict';

// Session codes, per-IP lockout and loopback checks.

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

function generateCode(randomInt = crypto.randomInt) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function normalizeCode(input) {
  return String(input == null ? '' : input).trim().toUpperCase();
}

function codesMatch(given, actual) {
  const a = Buffer.from(normalizeCode(given));
  const b = Buffer.from(String(actual));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeIp(ip) {
  const s = String(ip || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function isLoopbackAddress(ip) {
  const s = normalizeIp(ip);
  return s === '::1' || s === 'localhost' || /^127\./.test(s);
}

// 5 wrong codes inside 5 minutes -> that IP is locked for 60 s.
class Lockout {
  constructor({ maxWrong = 5, windowMs = 5 * 60 * 1000, lockMs = 60 * 1000 } = {}) {
    this.maxWrong = maxWrong;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.entries = new Map(); // ip -> { fails: [ms], lockedUntil }
  }

  // -> { locked:false } or { locked:true, retryInSec }
  check(ip, now = Date.now()) {
    const e = this.entries.get(normalizeIp(ip));
    if (e && e.lockedUntil > now) return { locked: true, retryInSec: Math.ceil((e.lockedUntil - now) / 1000) };
    return { locked: false };
  }

  fail(ip, now = Date.now()) {
    const key = normalizeIp(ip);
    const e = this.entries.get(key) || { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter((t) => now - t < this.windowMs);
    e.fails.push(now);
    if (e.fails.length >= this.maxWrong) {
      e.lockedUntil = now + this.lockMs;
      e.fails = [];
    }
    this.entries.set(key, e);
    this.prune(now);
  }

  success(ip) {
    this.entries.delete(normalizeIp(ip));
  }

  prune(now) {
    if (this.entries.size < 200) return;
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && e.fails.every((t) => now - t >= this.windowMs)) this.entries.delete(k);
    }
  }
}

module.exports = { ALPHABET, CODE_LENGTH, generateCode, normalizeCode, codesMatch, normalizeIp, isLoopbackAddress, Lockout };
