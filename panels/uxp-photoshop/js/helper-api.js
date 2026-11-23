'use strict';

// Loopback HTTP endpoints of the helper (docs/PROTOCOL.md section 1).

const HELPER_PORT = 47825;
const HELPER_HTTP = 'http://127.0.0.1:' + HELPER_PORT;
const HELPER_WS = 'ws://127.0.0.1:' + HELPER_PORT + '/ws';

async function request(fetchImpl, path, method) {
  const res = await fetchImpl(HELPER_HTTP + path, { method });
  if (!res || !res.ok) throw new Error('Helper answered ' + (res && res.status));
  return res.json();
}

const getSession = (fetchImpl) => request(fetchImpl, '/api/session', 'GET');
const newSession = (fetchImpl) => request(fetchImpl, '/api/session/new', 'POST');

module.exports = { HELPER_PORT, HELPER_HTTP, HELPER_WS, getSession, newSession };
