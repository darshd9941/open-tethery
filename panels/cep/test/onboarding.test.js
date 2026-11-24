'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../client/js/onboarding.js');
const U = require('../client/js/update-check.js');

const mem = () => { const d = {}; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); }, d }; };

test('guide opens on first run, remembers done and skip', () => {
  const st = mem();
  const g = O.create(st);
  assert.equal(g.open, true);
  g.next(); g.next();
  assert.equal(g.isLast(), true);
  g.done();
  assert.equal(g.open, false);
  assert.equal(O.create(st).open, false);
  const g2 = O.create(st);
  g2.reset();
  assert.equal(g2.open, true);
  assert.equal(g2.step, 0);
  const st2 = mem();
  const g3 = O.create(st2);
  g3.skip();
  assert.equal(O.create(st2).open, false);
});

test('next past the last step finishes; back stops at 0; broken storage is fine', () => {
  const g = O.create({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } });
  assert.equal(g.open, true);
  g.back(); assert.equal(g.step, 0);
  g.next(); g.next(); g.next();
  assert.equal(g.open, false);
  assert.equal(O.create(null).open, true);
});

test('steps are host specific and ticks follow state', () => {
  const pr = O.steps('premiere', 'Pocket Monitor');
  const ae = O.steps('aftereffects', 'Pocket Monitor');
  assert.equal(pr.length, 3);
  assert.match(pr[0].lines.join(' '), /Playback.*Video Device/);
  assert.match(pr[0].lines.join(' '), /Audio Device/);
  assert.match(ae[0].lines.join(' '), /Video Preview/);
  assert.deepEqual(O.ticks(null), [false, false, false]);
  assert.deepEqual(O.ticks({ engine: { transmit: true }, viewers: 0 }), [true, false, false]);
  assert.deepEqual(O.ticks({ engine: { transmit: false }, viewers: 2 }), [false, true, false]);
});

test('semver compare', () => {
  assert.equal(U.compare('v0.4.0', '0.3.0'), 1);
  assert.equal(U.compare('0.3.0', '0.3.0'), 0);
  assert.equal(U.compare('0.10.0', '0.9.9'), 1);
  assert.equal(U.compare('1.0', '1.0.1'), -1);
  assert.equal(U.compare('junk', '1.0.0'), 0);
});

const rel = (tag) => () => Promise.resolve({ ok: true, json: () => Promise.resolve({ tag_name: tag, html_url: 'https://github.com/x/y/releases/tag/' + tag }) });

test('update check: newer shows banner, same does not, errors are silent', async () => {
  const base = { updateUrl: 'u', current: '0.3.0', now: 1000 };
  let b = await U.check({ ...base, storage: mem(), fetchImpl: rel('v0.4.0') });
  assert.deepEqual(b, { version: '0.4.0', url: 'https://github.com/x/y/releases/tag/v0.4.0' });
  assert.equal(await U.check({ ...base, storage: mem(), fetchImpl: rel('v0.3.0') }), null);
  assert.equal(await U.check({ ...base, storage: mem(), fetchImpl: () => Promise.reject(new Error('offline')) }), null);
  assert.equal(await U.check({ ...base, storage: mem(), fetchImpl: () => Promise.resolve({ ok: false }) }), null);
  assert.equal(await U.check({ ...base, storage: mem(), fetchImpl: () => { throw new Error('sync'); } }), null);
  assert.equal(await U.check({ ...base, storage: mem(), fetchImpl: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }) }), null);
});

test('update check: 24h throttle uses the cache', async () => {
  const st = mem();
  let calls = 0;
  const f = (tag) => () => { calls++; return rel(tag)(); };
  await U.check({ storage: st, updateUrl: 'u', current: '0.3.0', now: 1000, fetchImpl: f('v0.4.0') });
  const b = await U.check({ storage: st, updateUrl: 'u', current: '0.3.0', now: 1000 + U.DAY - 1, fetchImpl: f('v0.5.0') });
  assert.equal(calls, 1);
  assert.equal(b.version, '0.4.0');
  const b2 = await U.check({ storage: st, updateUrl: 'u', current: '0.3.0', now: 1000 + U.DAY, fetchImpl: f('v0.5.0') });
  assert.equal(calls, 2);
  assert.equal(b2.version, '0.5.0');
  // offline later: keeps showing the cached newer version
  const b3 = await U.check({ storage: st, updateUrl: 'u', current: '0.3.0', now: 1000 + 3 * U.DAY, fetchImpl: () => Promise.reject(new Error('x')) });
  assert.equal(b3.version, '0.5.0');
});

test('update check: dismissed version is remembered, a newer one shows again', async () => {
  const st = mem();
  const o = { storage: st, updateUrl: 'u', current: '0.3.0' };
  await U.check({ ...o, now: 1, fetchImpl: rel('v0.4.0') });
  U.dismiss(st, '0.4.0');
  assert.equal(await U.check({ ...o, now: 2, fetchImpl: rel('v0.4.0') }), null);
  assert.equal(await U.check({ ...o, now: 1 + U.DAY * 2, fetchImpl: rel('v0.4.0') }), null);
  const b = await U.check({ ...o, now: 1 + U.DAY * 4, fetchImpl: rel('v0.5.0') });
  assert.equal(b.version, '0.5.0');
});
