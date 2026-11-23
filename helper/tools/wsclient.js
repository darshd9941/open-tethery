'use strict';

// Shared WebSocket test client used by fake-viewer / fake-panel and the tests.
// Records every message and lets callers await a matching one.

const WebSocket = require('ws');

// hello: the hello message object. Resolves once the socket is open.
function connectClient({ port, host = '127.0.0.1', hello, autoHello = true }) {
  const ws = new WebSocket(`ws://${host}:${port}/ws`);
  const client = { ws, messages: [], binary: [], closed: false, closeCode: null };
  const waiters = [];

  function check() {
    for (const w of [...waiters]) {
      const hit = w.source() .find(w.pred);
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(hit);
      } else if (client.closed && w.rejectOnClose) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.reject(new Error('socket closed while waiting'));
      }
    }
  }

  function wait(source, pred, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const w = { source, pred, resolve, reject, rejectOnClose: true };
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`timeout waiting for ${label}`));
      }, timeoutMs);
      waiters.push(w);
      check();
    });
  }

  // Waits for a JSON message (already received ones count).
  client.waitFor = (pred, timeoutMs = 3000) => {
    const fn = typeof pred === 'string' ? (m) => m.t === pred : pred;
    return wait(() => client.messages, fn, timeoutMs, typeof pred === 'string' ? pred : 'message');
  };
  client.waitBinary = (pred = () => true, timeoutMs = 3000) => wait(() => client.binary, pred, timeoutMs, 'binary message');
  client.waitClose = (timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      if (client.closed) return resolve(client.closeCode);
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
      ws.once('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  client.send = (obj) => ws.send(JSON.stringify(obj));
  client.sendBinary = (buf) => ws.send(buf, { binary: true });
  client.close = () => ws.close();

  ws.on('message', (data, isBinary) => {
    if (isBinary) client.binary.push(Buffer.from(data));
    else client.messages.push(JSON.parse(data.toString('utf8')));
    check();
  });
  ws.on('close', (code) => {
    client.closed = true;
    client.closeCode = code;
    check();
  });
  ws.on('error', () => {});

  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      if (hello && autoHello) client.send(hello);
      resolve(client);
    });
    ws.once('error', reject);
  });
}

module.exports = { connectClient };
