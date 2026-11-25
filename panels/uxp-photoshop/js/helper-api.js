'use strict';

// Loopback HTTP endpoints of the helper (docs/PROTOCOL.md section 1).

const HELPER_PORT = 47823;
const HELPER_HTTP = 'http://127.0.0.1:' + HELPER_PORT;
const HELPER_WS = 'ws://127.0.0.1:' + HELPER_PORT + '/ws';

async function request(fetchImpl, path, method, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetchImpl(HELPER_HTTP + path, opts);
  if (!res || !res.ok) throw new Error('Helper answered ' + (res && res.status));
  return res.json();
}

const getSession = (fetchImpl) => request(fetchImpl, '/api/session', 'GET');
const newSession = (fetchImpl) => request(fetchImpl, '/api/session/new', 'POST');
const postSourceState = (fetchImpl, payload) => request(fetchImpl, '/api/source/state', 'POST', payload);
const postSourceFrame = (fetchImpl, payload) => request(fetchImpl, '/api/source/frame', 'POST', payload);
const postSourceLog = (fetchImpl, msg) => request(fetchImpl, '/api/source/log', 'POST', { msg }).catch(() => {});

module.exports = {
  HELPER_PORT, HELPER_HTTP, HELPER_WS,
  getSession, newSession, postSourceState, postSourceFrame, postSourceLog,
};
