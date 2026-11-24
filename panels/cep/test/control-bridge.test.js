'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../client/js/control-bridge.js');

function fakeEval(replies) {
  const calls = [];
  const evalScript = (script, cb) => { calls.push(script); cb(typeof replies === 'function' ? replies(script) : replies); };
  return { calls, evalScript };
}

test('maps each control message to an otControl call', async () => {
  const f = fakeEval('{"ok":true}');
  const b = B.create({ evalScript: f.evalScript });
  const cases = [
    [{ cmd: 'play' }, 'otControl("play",null)'],
    [{ cmd: 'pause' }, 'otControl("pause",null)'],
    [{ cmd: 'toggle' }, 'otControl("toggle",null)'],
    [{ cmd: 'seek', time: 12.5 }, 'otControl("seek",12.5)'],
    [{ cmd: 'seek', time: -3 }, 'otControl("seek",0)'],
    [{ cmd: 'step', frames: -1 }, 'otControl("step",-1)'],
    [{ cmd: 'step', frames: 2.6 }, 'otControl("step",3)'],
    [{ cmd: 'step', frames: 99999 }, 'otControl("step",1000)'],
    [{ cmd: 'jump', to: 'start' }, 'otControl("jump","start")'],
    [{ cmd: 'jump', to: 'end' }, 'otControl("jump","end")']
  ];
  for (const [msg, script] of cases) {
    const r = await b.run(msg);
    assert.equal(r.ok, true);
    assert.equal(f.calls.pop(), script);
  }
});

test('bad arguments never reach ExtendScript', async () => {
  const f = fakeEval('{"ok":true}');
  const b = B.create({ evalScript: f.evalScript });
  for (const msg of [{ cmd: 'seek' }, { cmd: 'seek', time: 'x' }, { cmd: 'step' }, { cmd: 'jump', to: 'middle' }]) {
    const r = await b.run(msg);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad-args');
  }
  const u = await b.run({ cmd: 'explode' });
  assert.equal(u.code, 'unsupported');
  assert.equal(f.calls.length, 0);
});

test('passes through host failures and survives garbage replies', async () => {
  let b = B.create({ evalScript: fakeEval('{"ok":false,"code":"unsupported","message":"nope"}').evalScript });
  assert.deepEqual(await b.run({ cmd: 'play' }), { ok: false, code: 'unsupported', message: 'nope' });

  b = B.create({ evalScript: fakeEval('EvalScript error.').evalScript });
  assert.equal((await b.run({ cmd: 'play' })).code, 'host-error');
  b = B.create({ evalScript: fakeEval('not json').evalScript });
  assert.equal((await b.run({ cmd: 'play' })).code, 'host-error');
  b = B.create({ evalScript: () => { throw new Error('x'); } });
  assert.equal((await b.run({ cmd: 'play' })).code, 'host-error');
});

test('pollState returns the host-state fields or null', async () => {
  const good = JSON.stringify({ ok: true, host: { app: 'premiere' }, sequence: { name: 'S' }, playing: true, time: 2 });
  let b = B.create({ evalScript: fakeEval(good).evalScript });
  assert.deepEqual(await b.pollState(), { host: { app: 'premiere' }, sequence: { name: 'S' }, playing: true, time: 2 });
  b = B.create({ evalScript: fakeEval('{"ok":false,"code":"unsupported"}').evalScript });
  assert.equal(await b.pollState(), null);
  b = B.create({ evalScript: fakeEval('EvalScript error.').evalScript });
  assert.equal(await b.pollState(), null);
});
