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
    ['http://127.0.0.1:47825/api/session', 'GET'],
    ['http://127.0.0.1:47825/api/session/new', 'POST'],
  ]);
  assert.equal(HELPER_WS, 'ws://127.0.0.1:47825/ws');
});

test('non-200 answers reject', async () => {
  await assert.rejects(getSession(async () => ({ ok: false, status: 403 })), /403/);
});
