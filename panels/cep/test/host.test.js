'use strict';
// Runs host/host.jsx in a vm with stub ExtendScript globals (no Adobe app needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../host/host.jsx'), 'utf8');
const TICKS = 254016000000;

function load(globals, clock) {
  let now = 1000;
  const FakeDate = function () { return { getTime: () => now }; };
  globals.Date = FakeDate;
  const ctx = vm.createContext(globals);   // same object, so stubs can add globals (qe)
  vm.runInContext(SRC, ctx, { filename: 'host.jsx' });
  const call = (expr) => JSON.parse(vm.runInContext(expr, ctx));
  return { ctx, call, advance: (ms) => { now += ms; } };
}

function premiere({ qeOk = true } = {}) {
  const log = { playback: [] };
  const seq = {
    name: 'Main edit', frameSizeHorizontal: 3840, frameSizeVertical: 2160,
    timebase: '10594584000',                 // 23.976 fps
    end: String(Math.round(512.3 * TICKS)),
    pos: 12.5,
    getPlayerPosition() { return { seconds: this.pos, ticks: String(Math.round(this.pos * TICKS)) }; },
    setPlayerPosition(ticks) { log.setPos = ticks; this.pos = Number(ticks) / TICKS; }
  };
  const globals = {
    app: {
      name: 'Adobe Premiere Pro', version: '27.0.0',
      project: { activeSequence: seq },
      enableQE() { if (qeOk) globals.qe = { startPlayback() { log.playback.push('start'); }, stopPlayback() { log.playback.push('stop'); } }; }
    }
  };
  return { globals, seq, log };
}

function aftereffects({ cmdId = 2285 } = {}) {
  const log = { cmds: [] };
  function CompItem() {}
  const comp = Object.assign(new CompItem(), {
    name: 'Comp 1', width: 1080, height: 1920, frameRate: 29.97, frameDuration: 1 / 29.97, duration: 10, time: 2
  });
  const globals = {
    CompItem,
    app: {
      name: 'Adobe After Effects 2025', version: '25.1x10',
      project: { activeItem: comp },
      findMenuCommandId: (n) => (n === 'Play/Pause' ? cmdId : 0),
      executeCommand: (id) => log.cmds.push(id)
    }
  };
  return { globals, comp, log };
}

test('premiere state: name, size, exact fps from ticks, duration, time', () => {
  const p = premiere();
  const h = load(p.globals);
  const s = h.call('otGetHostState()');
  assert.equal(s.ok, true);
  assert.deepEqual(s.host, { app: 'premiere', appName: 'Premiere Pro', version: '27.0.0' });
  assert.equal(s.sequence.name, 'Main edit');
  assert.equal(s.sequence.width, 3840);
  assert.equal(s.sequence.height, 2160);
  assert.equal(s.sequence.fpsNum, 24000);
  assert.equal(s.sequence.fpsDen, 1001);
  assert.ok(Math.abs(s.sequence.duration - 512.3) < 1e-6);
  assert.equal(s.time, 12.5);
  assert.equal(s.playing, false);
});

test('premiere with no active sequence reports sequence null', () => {
  const p = premiere();
  p.globals.app.project.activeSequence = null;
  const s = load(p.globals).call('otGetHostState()');
  assert.equal(s.ok, true);
  assert.equal(s.sequence, null);
});

test('premiere names with quotes and unicode survive JSON', () => {
  const p = premiere();
  p.seq.name = 'Cut "final" é中\\x';
  const s = load(p.globals).call('otGetHostState()');
  assert.equal(s.sequence.name, p.seq.name);
});

test('premiere play / pause use QE and track our flag', () => {
  const p = premiere();
  const h = load(p.globals);
  assert.deepEqual(h.call('otControl("play",null)'), { ok: true });
  assert.equal(h.call('otGetHostState()').playing, true);
  assert.deepEqual(h.call('otControl("toggle",null)'), { ok: true });   // now pauses
  assert.deepEqual(h.call('otControl("toggle",null)'), { ok: true });   // plays again
  assert.deepEqual(h.call('otControl("pause",null)'), { ok: true });
  assert.deepEqual(p.log.playback, ['start', 'stop', 'start', 'stop']);
});

test('premiere infers playing from the playhead moving in real time, and stopping', () => {
  const p = premiere();
  const h = load(p.globals);
  h.call('otGetHostState()');                 // baseline
  h.advance(500); p.seq.pos += 0.5;
  assert.equal(h.call('otGetHostState()').playing, true);
  h.advance(500); p.seq.pos += 0.5;
  assert.equal(h.call('otGetHostState()').playing, true);
  h.advance(500); assert.equal(h.call('otGetHostState()').playing, true);   // 1 still poll
  h.advance(500); assert.equal(h.call('otGetHostState()').playing, false);  // 2 still polls
});

test('premiere: a scrub jump is not mistaken for playback', () => {
  const p = premiere();
  const h = load(p.globals);
  h.call('otGetHostState()');
  h.advance(500); p.seq.pos += 60;
  assert.equal(h.call('otGetHostState()').playing, false);
});

test('premiere seek sends ticks as a string; step and jump', () => {
  const p = premiere();
  const h = load(p.globals);
  assert.deepEqual(h.call('otControl("seek",20.5)'), { ok: true });
  assert.equal(p.log.setPos, String(Math.round(20.5 * TICKS)));
  assert.equal(typeof p.log.setPos, 'string');

  h.call('otControl("step",2)');
  const frame = 10594584000 / TICKS;
  assert.ok(Math.abs(p.seq.pos - (20.5 + 2 * frame)) < 1e-6);
  h.call('otControl("step",-4)');
  assert.ok(Math.abs(p.seq.pos - (20.5 - 2 * frame)) < 1e-6);

  h.call('otControl("jump","start")');
  assert.equal(p.log.setPos, '0');
  h.call('otControl("step",-1)');                 // clamped at zero
  assert.equal(p.log.setPos, '0');
  h.call('otControl("jump","end")');
  assert.equal(p.log.setPos, p.seq.end);
});

test('premiere errors: no QE, bad args, unknown command, no sequence', () => {
  let p = premiere({ qeOk: false });
  let h = load(p.globals);
  let r = h.call('otControl("play",null)');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported');

  h = load(premiere().globals);
  assert.equal(h.call('otControl("seek","abc")').code, 'bad-args');
  assert.equal(h.call('otControl("jump","middle")').code, 'bad-args');
  assert.equal(h.call('otControl("dance",null)').code, 'unsupported');

  p = premiere();
  p.globals.app.project.activeSequence = null;
  h = load(p.globals);
  assert.equal(h.call('otControl("seek",1)').code, 'no-sequence');
  assert.equal(h.call('otControl("play",null)').code, 'no-sequence');
});

test('after effects state: comp name, size, ntsc fps, duration, time', () => {
  const a = aftereffects();
  const s = load(a.globals).call('otGetHostState()');
  assert.deepEqual(s.host, { app: 'aftereffects', appName: 'After Effects', version: '25.1x10' });
  assert.equal(s.sequence.name, 'Comp 1');
  assert.equal(s.sequence.width, 1080);
  assert.equal(s.sequence.height, 1920);
  assert.equal(s.sequence.fpsNum, 30000);
  assert.equal(s.sequence.fpsDen, 1001);
  assert.equal(s.sequence.duration, 10);
  assert.equal(s.time, 2);
});

test('after effects: non-comp active item gives no sequence', () => {
  const a = aftereffects();
  a.globals.app.project.activeItem = {};
  assert.equal(load(a.globals).call('otGetHostState()').sequence, null);
});

test('after effects seek, step, jump set comp.time within bounds', () => {
  const a = aftereffects();
  const h = load(a.globals);
  h.call('otControl("seek",5)');
  assert.equal(a.comp.time, 5);
  h.call('otControl("seek",99)');
  assert.equal(a.comp.time, 10);
  h.call('otControl("seek",0)');
  h.call('otControl("step",3)');
  assert.ok(Math.abs(a.comp.time - 3 / 29.97) < 1e-9);
  h.call('otControl("jump","start")');
  assert.equal(a.comp.time, 0);
  h.call('otControl("jump","end")');
  assert.ok(Math.abs(a.comp.time - (10 - 1 / 29.97)) < 1e-9);
});

test('after effects play/pause use a menu command when found, else unsupported', () => {
  const a = aftereffects();
  const h = load(a.globals);
  assert.deepEqual(h.call('otControl("play",null)'), { ok: true });
  assert.deepEqual(h.call('otControl("play",null)'), { ok: true });   // already playing: no second toggle
  assert.equal(h.call('otGetHostState()').playing, true);
  h.call('otControl("toggle",null)');
  assert.deepEqual(a.log.cmds, [2285, 2285]);
  assert.equal(h.call('otGetHostState()').playing, false);

  const b = aftereffects({ cmdId: 0 });
  const r = load(b.globals).call('otControl("play",null)');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported');
  assert.equal(b.log.cmds.length, 0);
});

test('unknown host returns unsupported, and a throwing host call is contained', () => {
  const h = load({ app: { name: 'Something Else' } });
  assert.equal(h.call('otGetHostState()').code, 'unsupported');
  const p = premiere();
  p.seq.getPlayerPosition = () => { throw new Error('boom'); };
  p.seq.setPlayerPosition = () => { throw new Error('seek boom'); };
  const h2 = load(p.globals);
  assert.equal(h2.call('otGetHostState()').ok, true);               // position failure tolerated
  assert.equal(h2.call('otControl("seek",1)').code, 'host-error');
});

test('host.jsx stays ES3: no let/const/arrow functions/template strings/JSON.', () => {
  const code = SRC.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  assert.doesNotMatch(code, /\b(let|const)\s/);
  assert.doesNotMatch(code, /=>/);
  assert.doesNotMatch(code, /`/);
  assert.doesNotMatch(code, /\bJSON\./);
});
