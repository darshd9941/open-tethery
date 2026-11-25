'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Fake "photoshop" module, resolved through a require hook like the real host.
const calls = [];
const state = { docs: [], active: null };
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xda, 0, 2, 7, 7, 0xff, 0xd9]);

const fakePhotoshop = {
  app: {
    version: '27.1.0',
    get documents() { return state.docs; },
    get activeDocument() { return state.active; },
    getColorProfiles: async () => ['sRGB IEC61966-2.1', 'Display P3'],
  },
  core: {
    executeAsModal: async (fn) => fn({}),
  },
  imaging: {
    getPixels: async (opts) => {
      calls.push(opts);
      return { imageData: { width: opts.targetSize.width, height: opts.targetSize.height, dispose() { calls.push('dispose'); } } };
    },
    encodeImageData: async () => FAKE_JPEG.toString('base64'),
  },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'photoshop') return fakePhotoshop;
  return origLoad.call(this, request, ...rest);
};
test.after(() => { Module._load = origLoad; });

const { PsCapture } = require('../js/ps-capture');

function doc(over) {
  return { id: 1, name: 'poster.psd', width: 4000, height: 2000, layers: [1, 2], activeHistoryState: { id: 10 }, ...over };
}

function fakeClient() {
  const c = { sequences: [], frames: [] };
  c.setSequence = (s) => c.sequences.push(s);
  c.sendFrame = (jpeg, meta) => { c.frames.push({ jpeg, meta }); return true; };
  return c;
}

test('no document: nothing sent', async () => {
  state.docs = [];
  state.active = null;
  const client = fakeClient();
  const cap = new PsCapture({ client, debounceMs: 0 });
  cap.tick();
  assert.equal(await cap.captureNow(), false);
  assert.equal(client.sequences.length, 0);
  assert.equal(client.frames.length, 0);
});

test('photoshop API error in activeDocument is surfaced via onError instead of swallowed', () => {
  const errors = [];
  const brokenPs = {
    app: {
      get documents() { throw new Error('UXP host unavailable'); },
    },
  };
  const cap = new PsCapture({ client: fakeClient(), ps: brokenPs, debounceMs: 0, onError: (e) => errors.push(e) });
  cap.tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /UXP host unavailable/);
});

test('captures a downscaled frame, tags the profile, reports source-state', async () => {
  calls.length = 0;
  state.docs = [doc()];
  state.active = state.docs[0];
  const client = fakeClient();
  const docs = [];
  const cap = new PsCapture({
    client, debounceMs: 0,
    getSettings: () => ({ size: 1600, profile: 'Display P3' }),
    onDoc: (d) => docs.push(d),
  });

  assert.deepEqual(cap.hostInfo(), { app: 'photoshop', appName: 'Photoshop', version: '27.1.0' });
  cap.tick();
  assert.deepEqual(client.sequences[0], { name: 'poster.psd', width: 4000, height: 2000, aspect: '2x1' });
  assert.equal(docs[0].name, 'poster.psd');

  assert.equal(await cap.captureNow(), true);
  const req = calls[0];
  assert.equal(req.documentID, 1);
  assert.deepEqual(req.targetSize, { width: 1600, height: 800 });
  assert.equal(req.colorProfile, 'Display P3');
  assert.equal(req.componentSize, 8);
  assert.ok(calls.includes('dispose'));

  const f = client.frames[0];
  assert.deepEqual([f.meta.width, f.meta.height, f.meta.srcWidth, f.meta.srcHeight], [1600, 800, 4000, 2000]);
  assert.deepEqual(Array.from(f.jpeg.subarray(0, 2)), [0xff, 0xd8]);
  assert.equal(f.jpeg[3], 0xe2); // ICC APP2 injected right after SOI
  assert.ok(f.jpeg.length > FAKE_JPEG.length);
});

test('document switch and resize emit a new source-state; edits trigger a frame', async () => {
  state.docs = [doc()];
  state.active = state.docs[0];
  const client = fakeClient();
  const cap = new PsCapture({ client, debounceMs: 0 });
  cap.tick();
  cap.tick(); // unchanged: no duplicate
  assert.equal(client.sequences.length, 1);

  const second = doc({ id: 2, name: 'banner.psd', width: 1080, height: 1920 });
  state.docs = [state.docs[0], second];
  state.active = second;
  cap.tick();
  assert.equal(client.sequences.length, 2);
  assert.deepEqual(client.sequences[1], { name: 'banner.psd', width: 1080, height: 1920, aspect: '9x16' });

  second.width = 1080;
  second.height = 1350;
  cap.tick();
  assert.equal(client.sequences[2].aspect, '4x5');

  // history change -> a debounced capture happens by itself
  await new Promise((r) => setTimeout(r, 30));
  const before = client.frames.length;
  second.activeHistoryState = { id: 11 };
  cap.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(client.frames.length, before + 1);
  cap.stop();
});

test('busy Photoshop is reported and retried, not thrown', async () => {
  state.docs = [doc()];
  state.active = state.docs[0];
  const errors = [];
  const client = fakeClient();
  const cap = new PsCapture({ client, onError: (e) => errors.push(e) });
  const orig = fakePhotoshop.core.executeAsModal;
  fakePhotoshop.core.executeAsModal = async () => { throw new Error('Another modal operation is in progress'); };
  assert.equal(await cap.captureNow(), false);
  fakePhotoshop.core.executeAsModal = orig;
  cap.stop();
  assert.match(errors[0], /busy/i);
});

test('listProfiles finds sRGB and Display P3', async () => {
  const cap = new PsCapture({ client: fakeClient() });
  assert.deepEqual(await cap.listProfiles(), { srgb: 'sRGB IEC61966-2.1', p3: 'Display P3' });
});
