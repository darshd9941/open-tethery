'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getSession, newSession, HELPER_WS } = require('../js/helper-api');

test('session calls hit the loopback endpoints', async () => {
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push([url, opts.method]);
    return { ok: true, json: async () => ({ code: 'CL7G', viewers: 0 }) };
  };
  assert.equal((await getSession(fakeFetch)).code, 'CL7G');
  await newSession(fakeFetch);
  assert.deepEqual(seen, [
    ['http://127.0.0.1:47823/api/session', 'GET'],
    ['http://127.0.0.1:47823/api/session/new', 'POST'],
  ]);
  assert.equal(HELPER_WS, 'ws://127.0.0.1:47823/ws');
});

test('non-200 answers reject', async () => {
  await assert.rejects(getSession(async () => ({ ok: false, status: 403 })), /403/);
});

test('HttpSourceClient posts state and base64 JPEG frames over HTTP fetch', async () => {
  const { HttpSourceClient } = require('../js/http-source-client');
  const { base64ToBytes, bytesToBase64 } = require('../js/format');
  const raw = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  assert.deepEqual(Array.from(base64ToBytes(bytesToBase64(raw))), Array.from(raw));

  const reqs = [];
  const fakeFetch = async (url, opts) => {
    reqs.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, viewers: 3 }) };
  };
  let viewers = 0;
  const c = new HttpSourceClient({
    fetchImpl: fakeFetch,
    host: { app: 'photoshop', appName: 'Photoshop', version: '27.0' },
    onViewers: (n) => { viewers = n; },
  });
  c.setSequence({ name: 'a.psd', width: 1080, height: 1350, aspect: '4x5' });
  c.sendFrame(raw, { width: 540, height: 675, srcWidth: 1080, srcHeight: 1350 });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(reqs[0].url, 'http://127.0.0.1:47823/api/source/state');
  assert.equal(reqs[1].url, 'http://127.0.0.1:47823/api/source/frame');
  assert.equal(reqs[1].body.jpegBase64, bytesToBase64(raw));
  assert.equal(viewers, 3);
});

