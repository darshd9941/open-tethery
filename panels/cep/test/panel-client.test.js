'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer, WebSocket } = require('ws');
const P = require('../client/js/panel-client.js');

// Minimal fake helper: /health over HTTP plus /ws speaking the panel side of the protocol.
async function fakeHelper() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, name: 'open-tethery', version: '0.2.0', protocol: 1 }));
    } else { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const received = [];
  const waiters = [];
  const h = { received, sockets: [] };
  wss.on('connection', (ws) => {
    h.sockets.push(ws);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      received.push(m);
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'welcome', id: 'p1', role: 'panel', protocol: 1 }));
      for (const w of waiters.slice()) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  Object.assign(h, {
    port,
    send: (obj) => h.sockets[h.sockets.length - 1].send(JSON.stringify(obj)),
    // Resolves with the next (or an already received) message matching pred.
    waitFor: (pred, from = 0) => {
      const hit = received.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for message; got ' + JSON.stringify(received))), 2000);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(() => server.close(r)); })
  });
  return h;
}

function makeClient(h, extra = {}) {
  const events = { states: [], stats: [], statuses: [], errors: [] };
  const hostState = { host: { app: 'premiere', appName: 'Premiere Pro', version: '27.0' }, sequence: { name: 'Main', width: 1920, height: 1080, fpsNum: 24, fpsDen: 1, duration: 10 }, playing: false, time: 1 };
  const ctl = { hostState, controls: [], result: { ok: true } };
  const client = P.create({
    WebSocketImpl: WebSocket,
    fetchImpl: (u) => fetch(u),
    wsUrl: `ws://127.0.0.1:${h.port}/ws`,
    healthUrl: `http://127.0.0.1:${h.port}/health`,
    pollMs: 20, minRetryMs: 20, maxRetryMs: 80,
    pollState: async () => JSON.parse(JSON.stringify(ctl.hostState)),
    runControl: async (m) => { ctl.controls.push(m); return ctl.result; },
    onState: (s) => events.states.push(s),
    onStats: (s) => events.stats.push(s),
    onStatus: (s) => events.statuses.push(s),
    onError: (e) => events.errors.push(e),
    ...extra
  });
  return { client, events, ctl };
}

test('hello, welcome, host-state only when changed, state/stats delivered', async () => {
  const h = await fakeHelper();
  const { client, events, ctl } = makeClient(h);
  client.start();
  const hello = await h.waitFor((m) => m.t === 'hello');
  assert.equal(hello.role, 'panel');
  assert.equal(hello.protocol, 1);

  const hs = await h.waitFor((m) => m.t === 'host-state');
  assert.equal(hs.host.app, 'premiere');
  assert.equal(hs.sequence.name, 'Main');
  assert.equal(hs.playing, false);
  assert.equal(hs.time, 1);

  await new Promise((r) => setTimeout(r, 120));   // several polls, nothing changed
  assert.equal(h.received.filter((m) => m.t === 'host-state').length, 1);

  ctl.hostState.time = 2.5;
  ctl.hostState.playing = true;
  const hs2 = await h.waitFor((m) => m.t === 'host-state' && m.time === 2.5);
  assert.equal(hs2.playing, true);

  h.send({ t: 'state', status: 'live', code: 'AB2C', viewers: 1 });
  h.send({ t: 'stats', fps: 24, kbps: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.states[0].code, 'AB2C');
  assert.equal(events.stats[0].kbps, 5000);
  assert.deepEqual(events.statuses.slice(0, 2), ['connecting', 'connected']);
  client.stop();
  await h.close();
});

test('control runs through runControl and answers control-result with req', async () => {
  const h = await fakeHelper();
  const { client, ctl } = makeClient(h);
  client.start();
  await h.waitFor((m) => m.t === 'hello');
  await h.waitFor((m) => m.t === 'host-state');

  h.send({ t: 'control', req: 7, cmd: 'seek', time: 12.5 });
  const r = await h.waitFor((m) => m.t === 'control-result' && m.req === 7);
  assert.deepEqual(r, { t: 'control-result', req: 7, ok: true });
  assert.deepEqual(ctl.controls[0], { t: 'control', req: 7, cmd: 'seek', time: 12.5 });

  ctl.result = { ok: false, code: 'unsupported', message: 'no QE' };
  h.send({ t: 'control', req: 8, cmd: 'play' });
  const r2 = await h.waitFor((m) => m.t === 'control-result' && m.req === 8);
  assert.deepEqual(r2, { t: 'control-result', req: 8, ok: false, code: 'unsupported', message: 'no QE' });
  client.stop();
  await h.close();
});

test('a throwing runControl still yields control-result ok:false', async () => {
  const h = await fakeHelper();
  const { client } = makeClient(h, { runControl: async () => { throw new Error('bang'); } });
  client.start();
  await h.waitFor((m) => m.t === 'host-state');
  h.send({ t: 'control', req: 1, cmd: 'play' });
  const r = await h.waitFor((m) => m.t === 'control-result');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'host-error');
  client.stop();
  await h.close();
});

test('kick, new-session and panel-settings messages', async () => {
  const h = await fakeHelper();
  const { client } = makeClient(h);
  client.start();
  await h.waitFor((m) => m.t === 'host-state');
  assert.ok(!h.received.some((m) => m.t === 'panel-settings'));   // helper owns the default
  client.setAllowControl(false);
  assert.deepEqual(await h.waitFor((m) => m.t === 'panel-settings'), { t: 'panel-settings', allowControl: false });
  assert.equal(client.getState(), true);
  assert.deepEqual(await h.waitFor((m) => m.t === 'get-state'), { t: 'get-state' });
  assert.equal(client.kick('v3'), true);
  assert.equal(client.newSession(), true);
  assert.deepEqual(await h.waitFor((m) => m.t === 'kick'), { t: 'kick', id: 'v3' });
  assert.deepEqual(await h.waitFor((m) => m.t === 'new-session'), { t: 'new-session' });
  client.stop();
  await h.close();
});

test('reconnects after the helper drops the socket and resends host-state', async () => {
  const h = await fakeHelper();
  const { client, events } = makeClient(h);
  client.start();
  await h.waitFor((m) => m.t === 'host-state');
  const before = h.received.length;
  h.sockets[0].terminate();
  await h.waitFor((m) => m.t === 'hello', before);
  await h.waitFor((m) => m.t === 'host-state', before);
  assert.ok(events.statuses.includes('helper-down'));
  assert.equal(client.getStatus(), 'connected');
  client.stop();
  await h.close();
});

test('helper down: calls ensureHelper, backs off, connects once /health answers', async () => {
  const h = await fakeHelper();
  let healthy = false;
  const ensured = [];
  const { client, events } = makeClient(h, {
    fetchImpl: (u) => (healthy ? fetch(u) : Promise.reject(new Error('ECONNREFUSED'))),
    ensureHelper: async (n) => { ensured.push(n); if (n === 3) healthy = true; }
  });
  client.start();
  await h.waitFor((m) => m.t === 'host-state');
  assert.deepEqual(ensured, [1, 2, 3]);
  assert.equal(events.statuses[0], 'helper-down');
  assert.equal(client.getStatus(), 'connected');
  client.stop();
  await h.close();
});

test('stop() closes the socket and stops polling', async () => {
  const h = await fakeHelper();
  const { client } = makeClient(h);
  client.start();
  await h.waitFor((m) => m.t === 'host-state');
  client.stop();
  const n = h.received.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.received.length, n);
  assert.equal(client.kick('v1'), false);
  await h.close();
});
