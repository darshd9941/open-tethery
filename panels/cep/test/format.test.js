'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../client/js/state-format.js');
const L = require('../client/js/helper-launcher.js');

test('resolution and fps formatting', () => {
  const seq = { width: 3840, height: 2160, fpsNum: 24000, fpsDen: 1001 };
  assert.equal(F.formatResolution(seq), '3840x2160');
  assert.equal(F.formatFps(seq), '23.976');
  assert.equal(F.formatSequenceLine(seq), '3840x2160 @ 23.976');
  assert.equal(F.formatSequenceLine({ width: 1920, height: 1080, fpsNum: 25, fpsDen: 1 }), '1920x1080 @ 25');
  assert.equal(F.formatFps({ fpsNum: 30000, fpsDen: 1001 }), '29.97');
  assert.equal(F.formatFps({ fpsNum: 60000, fpsDen: 1001 }), '59.94');
  assert.equal(F.formatSequenceLine({ width: 1080, height: 1920, fps: 30 }), '1080x1920 @ 30');
  assert.equal(F.formatSequenceLine(null), '');
  assert.equal(F.formatSequenceLine({ width: 100, height: 50 }), '100x50');
});

test('status and host labels', () => {
  assert.equal(F.statusLabel({ status: 'live' }), 'LIVE');
  assert.equal(F.statusLabel({ status: 'idle' }), 'IDLE');
  assert.equal(F.statusLabel(null), 'IDLE');
  assert.equal(F.hostLabel({ host: { app: 'premiere', appName: 'Premiere Pro', version: '27.0' } }), 'Premiere Pro 27.0');
  assert.equal(F.hostLabel({ host: { app: 'aftereffects' } }), 'After Effects');
  assert.equal(F.hostLabel({}), '');
});

test('engine hint text per host', () => {
  assert.equal(F.engineHint('premiere'), 'Edit > Preferences > Playback, tick Open Tethery under Video Device');
  assert.match(F.engineHint('aftereffects'), /^Edit > Preferences > Video Preview, choose Open Tethery/);
});

test('engine warning only when transmit is false', () => {
  assert.equal(F.engineWarning(null), null);
  assert.equal(F.engineWarning({ engine: { transmit: true } }), null);
  assert.equal(F.engineWarning({}), null);
  const w = F.engineWarning({ engine: { transmit: false }, host: { app: 'aftereffects' } });
  assert.match(w.title, /After Effects/);
  assert.match(w.steps, /Video Preview/);
  const p = F.engineWarning({ engine: { transmit: false }, host: { app: 'premiere' } });
  assert.match(p.steps, /Playback/);
});

test('stats, delay and phone rows', () => {
  assert.equal(F.formatStats({ fps: 23.94, kbps: 8400.4 }), '23.9 fps \u00b7 8400 kbps');
  assert.equal(F.formatStats(null), '');
  assert.equal(F.formatDelay(140.4), '140 ms');
  assert.equal(F.formatDelay(undefined), '\u2013');
  const rows = F.phoneRows({ viewerList: [{ id: 'v3', name: 'Pixel 8', ip: '192.168.1.31', delayMs: 90 }, { id: 'v4' }] });
  assert.deepEqual(rows[0], { id: 'v3', name: 'Pixel 8', ip: '192.168.1.31', delay: '90 ms' });
  assert.equal(rows[1].name, 'Phone');
  assert.deepEqual(F.phoneRows({}), []);
});

test('code validation', () => {
  assert.ok(F.isValidCode('CL7G'));
  assert.ok(!F.isValidCode('CL0G'));
  assert.ok(!F.isValidCode('cl7g'));
  assert.ok(!F.isValidCode('CL7'));
});

test('helper launcher picks exe first, then dev node script', () => {
  const exe = 'C:\\Users\\a\\AppData\\Local\\OpenTethery\\OpenTetheryHelper.exe';
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() { calls.push('unref'); } }; };
  const env = { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  const dev = '/repo/helper/bin/open-tethery-helper.js';

  const vbs = 'C:\\Users\\a\\AppData\\Local\\OpenTethery\\start-helper.vbs';
  let r = L.start({ fs: { existsSync: (p) => p === vbs || p === exe || p === dev }, spawn, env }, { devHelperPath: dev });
  assert.equal(r.via, 'vbs');
  assert.equal(calls[0].cmd, 'wscript.exe');
  assert.deepEqual(calls[0].args, [vbs]);

  calls.length = 0;
  r = L.start({ fs: { existsSync: (p) => p === exe || p === dev }, spawn, env }, { devHelperPath: dev });
  assert.equal(r.via, 'exe');
  assert.equal(calls[0].cmd, exe);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[1], 'unref');

  calls.length = 0;
  r = L.start({ fs: { existsSync: (p) => p === dev }, spawn, env }, { devHelperPath: dev });
  assert.equal(r.via, 'node');
  assert.equal(calls[0].cmd, 'node');
  assert.deepEqual(calls[0].args, [dev]);

  r = L.start({ fs: { existsSync: () => false }, spawn, env }, { devHelperPath: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /OpenTetheryHelper\.exe/);

  r = L.start({ fs: { existsSync: () => true }, spawn: () => { throw new Error('boom'); }, env }, {});
  assert.deepEqual(r, { ok: false, reason: 'boom' });
});
