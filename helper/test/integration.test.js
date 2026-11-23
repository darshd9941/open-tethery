'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHelper } = require('../lib/index');
const otv1 = require('../lib/otv1');
const { connectViewer } = require('../tools/fake-viewer');
const { connectPanel, connectSource } = require('../tools/fake-panel');
const { connectTransmit } = require('../tools/fake-transmit');
const { connectClient } = require('../tools/wsclient');
const { JPEG } = require('../tools/testcard');

const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-viewer-'));
fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><title>viewer</title>');
fs.writeFileSync(path.join(viewerDir, 'app.mjs'), 'export {}');
fs.writeFileSync(path.join(viewerDir, 'site.webmanifest'), '{}');

async function withHelper(fn, opts = {}) {
  const helper = createHelper({ port: 0, ingestPort: 0, lanIp: '192.168.1.20', logFile: null, echo: false, viewerDir, configPath: path.join(viewerDir, 'none.json'), ...opts });
  const { port, ingestPort } = await helper.start();
  const clients = [];
  const track = (c) => {
    clients.push(c);
    return c;
  };
  try {
    await fn({ helper, port, ingestPort, code: helper.hub.code, track });
  } finally {
    for (const c of clients) {
      if (c.close) c.close();
      else if (c.destroy) c.destroy();
    }
    await helper.stop();
  }
}

function get(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('HTTP: health, session, viewer pages, static files, qr, log', async () => {
  await withHelper(async ({ port, code, track }) => {
    const health = JSON.parse((await get(port, '/health')).body);
    assert.deepStrictEqual(health, { ok: true, name: 'open-tethery', version: '0.2.0', protocol: 1 });

    for (const p of ['/', `/c/${code}`]) {
      const r = await get(port, p);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.strictEqual(r.headers['cache-control'], 'no-store');
      assert.match(r.body, /<title>viewer<\/title>/);
    }
    assert.match((await get(port, '/app.mjs')).headers['content-type'], /text\/javascript/);
    assert.match((await get(port, '/site.webmanifest')).headers['content-type'], /application\/manifest\+json/);
    assert.strictEqual((await get(port, '/nope.js')).status, 404);
    assert.strictEqual((await get(port, '/..%2f..%2fetc/passwd')).status, 404);

    const s = JSON.parse((await get(port, '/api/session')).body);
    assert.strictEqual(s.code, code);
    assert.strictEqual(s.primaryUrl, `http://192.168.1.20:${port}/c/${code}`);
    assert.strictEqual(s.urls[0], s.primaryUrl);
    assert.strictEqual(s.viewers, 0);

    const qr = await get(port, '/api/qr.svg');
    assert.strictEqual(qr.headers['content-type'], 'image/svg+xml');
    assert.match(qr.body, /^<svg /);
    assert.match((await get(port, '/api/qr.svg?text=hello')).body, /^<svg /);

    track(await connectPanel({ port, app: 'premiere' }));
    await sleep(50);
    const log = await get(port, '/api/log');
    assert.match(log.body, /panel opened premiere/);

    // a web page on another origin must not reach loopback APIs
    assert.strictEqual((await get(port, '/api/session', { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.strictEqual((await get(port, '/api/session/new')).status, 405);
  });
});

test('HTTP: placeholder page when the viewer dir is missing', async () => {
  const saved = process.env.OT_VIEWER_DIR;
  delete process.env.OT_VIEWER_DIR;
  await withHelper(
    async ({ port, helper }) => {
      if (helper.viewerDir) return; // repo viewer/ exists; nothing to check
      const r = await get(port, '/');
      assert.strictEqual(r.status, 200);
      assert.match(r.body, /viewer app files were not found/);
    },
    { viewerDir: path.join(os.tmpdir(), 'ot-does-not-exist') },
  );
  if (saved !== undefined) process.env.OT_VIEWER_DIR = saved;
});

test('handshake: welcome, state, roles, perm default', async () => {
  await withHelper(async ({ port, code, track }) => {
    const v = track(await connectViewer({ port, code: code.toLowerCase(), name: 'Pixel 8' }));
    const w = await v.waitFor('welcome');
    assert.strictEqual(w.role, 'viewer');
    assert.match(w.id, /^v\d+$/);
    assert.strictEqual(w.protocol, 1);
    assert.strictEqual(w.control, true);
    assert.strictEqual(w.webrtc, false);
    assert.deepStrictEqual(w.server, { name: 'open-tethery', version: '0.2.0', pcName: require('os').hostname() });
    const st = await v.waitFor('state');
    assert.strictEqual(st.status, 'idle');
    assert.strictEqual(st.engine.transmit, false);

    const p = track(await connectPanel({ port }));
    assert.match((await p.waitFor('welcome')).id, /^p\d+$/);
    const ps = await p.waitFor('state');
    assert.strictEqual(ps.code, code);
    assert.strictEqual(ps.primaryUrl, `http://192.168.1.20:${port}/c/${code}`);
    assert.deepStrictEqual(ps.viewerList.map((x) => [x.name]), [['Pixel 8']]);
    assert.match(ps.viewerList[0].id, /^v\d+$/);

    const s = track(await connectSource({ port }));
    assert.match((await s.waitFor('welcome')).id, /^s\d+$/);
  });
});

test('handshake: bad code, case, lockout after 5 wrong', async () => {
  await withHelper(async ({ port, code }) => {
    for (let i = 0; i < 5; i += 1) {
      const v = await connectViewer({ port, code: 'ZZZZ' === code ? 'YYYY' : 'ZZZZ' });
      const e = await v.waitFor('error');
      assert.strictEqual(e.code, 'bad-code');
      await v.waitClose();
    }
    const locked = await connectViewer({ port, code });
    const e = await locked.waitFor('error');
    assert.strictEqual(e.code, 'locked');
    assert.ok(e.retryInSec > 50 && e.retryInSec <= 60);
    await locked.waitClose();
  });
});

test('handshake: hello timeout, non-hello first message, browser origin on panel role', async () => {
  await withHelper(
    async ({ port, track }) => {
      const idle = await connectClient({ port });
      assert.ok((await idle.waitClose(2000)) >= 1000);
      const bad = track(await connectClient({ port }));
      bad.send({ t: 'ping' });
      assert.strictEqual((await bad.waitFor('error')).code, 'bad-hello');
      const WebSocket = require('ws');
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://evil.example' } });
      const got = await new Promise((resolve) => {
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'panel' })));
        ws.on('message', (d) => resolve(JSON.parse(d.toString())));
      });
      assert.strictEqual(got.code, 'forbidden');
      ws.close();
    },
    { helloTimeoutMs: 200 },
  );
});

test('transmit: frames arrive with a correct OTV1 header; state goes live with timecode', async () => {
  await withHelper(async ({ port, ingestPort, code, track }) => {
    const v = track(await connectViewer({ port, code }));
    await v.waitFor('welcome');
    const p = track(await connectPanel({ port }));
    p.sendHostState({ time: 0, playing: true });
    const tx = track(await connectTransmit({ ingestPort, port: ingestPort, fpsNum: 25, fpsDen: 1 }));
    tx.sendState({ app: 'premiere', playing: true, sequence: 'Fake Sequence' });
    await sleep(30);
    tx.sendFrame(2.5);
    const bin = await v.waitBinary();
    const f = otv1.decode(bin);
    assert.strictEqual(bin.subarray(0, 4).toString(), 'OTV1');
    assert.strictEqual(f.kind, 1);
    assert.strictEqual(f.flags & 1, 1);
    assert.strictEqual(f.seq, 1);
    assert.strictEqual(f.time, 2.5);
    assert.strictEqual(f.width, 320);
    assert.strictEqual(f.height, 180);
    assert.strictEqual(f.srcWidth, 1920);
    assert.strictEqual(f.srcHeight, 1080);
    assert.ok(f.jpeg.equals(JPEG));

    const live = await v.waitFor((m) => m.t === 'state' && m.status === 'live' && m.timecode);
    assert.strictEqual(live.host.app, 'premiere');
    assert.strictEqual(live.host.appName, 'Premiere Pro');
    assert.strictEqual(live.sequence.aspect, '16x9');
    assert.strictEqual(live.time, 2.5);
    assert.strictEqual(live.timecode, '00:00:02:11');
    assert.strictEqual(live.engine.transmit, true);
    assert.strictEqual(live.engine.sending, true);

    // a late viewer gets the newest frame right after welcome
    const late = track(await connectViewer({ port, code }));
    const lf = otv1.decode(await late.waitBinary());
    assert.strictEqual(lf.time, 2.5);

    // no frames for 3 s -> idle
    const idle = await v.waitFor((m) => m.t === 'state' && m.status === 'idle', 6000);
    assert.strictEqual(idle.engine.sending, false);
  });
});

test('transmit: chunked / garbage input does not take the helper down', async () => {
  await withHelper(async ({ port, ingestPort, code, track }) => {
    const v = track(await connectViewer({ port, code }));
    const tx = track(await connectTransmit({ port: ingestPort }));
    const net = require('net');
    const bad = net.connect(ingestPort, '127.0.0.1');
    bad.on('error', () => {});
    await sleep(30); // `bad` replaces tx (newest wins)
    bad.write('GET / HTTP/1.1\r\n\r\n');
    await new Promise((r) => bad.on('close', r));
    const tx2 = track(await connectTransmit({ port: ingestPort }));
    tx2.sendFrame(1);
    assert.strictEqual(otv1.decode(await v.waitBinary()).time, 1);
    assert.ok(tx);
  });
});

test('control: round trip, errors, perm, seek coalescing', async () => {
  await withHelper(async ({ port, code, track }) => {
    const v = track(await connectViewer({ port, code }));
    await v.waitFor('welcome');

    v.send({ t: 'control', cmd: 'play' });
    assert.deepStrictEqual(pick(await v.waitFor('error'), ['code', 'cmd']), { code: 'no-host', cmd: 'play' });

    const p = track(await connectPanel({ port }));
    await p.waitFor('welcome');
    p.sendHostState();
    await sleep(30);

    v.send({ t: 'control', cmd: 'toggle' });
    const c1 = await p.waitFor((m) => m.t === 'control' && m.cmd === 'toggle');
    assert.ok(Number.isInteger(c1.req));
    p.send({ t: 'control-result', req: c1.req, ok: true });
    assert.deepStrictEqual(pick(await v.waitFor('control-ack'), ['cmd', 'ok']), { cmd: 'toggle', ok: true });

    v.send({ t: 'control', cmd: 'step', frames: -1 });
    const c2 = await p.waitFor((m) => m.cmd === 'step');
    assert.strictEqual(c2.frames, -1);
    v.send({ t: 'control', cmd: 'jump', to: 'end' });
    assert.strictEqual((await p.waitFor((m) => m.cmd === 'jump')).to, 'end');

    // panel says unsupported (code + message are forwarded)
    p.send({ t: 'control-result', req: c2.req, ok: false, code: 'unsupported', message: 'No step here' });
    assert.deepStrictEqual(pick(await v.waitFor((m) => m.t === 'error' && m.cmd === 'step'), ['code', 'message']), { code: 'unsupported', message: 'No step here' });

    // get-state answers at once and carries allowControl
    const before = p.messages.length;
    p.send({ t: 'get-state' });
    const gs = await p.waitFor((m) => m.t === 'state' && p.messages.indexOf(m) >= before);
    assert.strictEqual(gs.allowControl, true);

    v.send({ t: 'control', cmd: 'explode' });
    assert.strictEqual((await v.waitFor((m) => m.t === 'error' && m.cmd === 'explode')).code, 'unsupported');

    // seek coalescing: first goes out, 2nd and 3rd wait, only the newest is delivered after the ack
    for (const time of [1, 2, 3]) v.send({ t: 'control', cmd: 'seek', time });
    const s1 = await p.waitFor((m) => m.cmd === 'seek');
    assert.strictEqual(s1.time, 1);
    await sleep(100);
    assert.strictEqual(p.messages.filter((m) => m.cmd === 'seek').length, 1);
    p.send({ t: 'control-result', req: s1.req, ok: true });
    const s3 = await p.waitFor((m) => m.cmd === 'seek' && m.time === 3);
    await sleep(100);
    assert.strictEqual(p.messages.filter((m) => m.cmd === 'seek').length, 2);
    p.send({ t: 'control-result', req: s3.req, ok: true });
    await v.waitFor((m) => m.t === 'control-ack' && m.cmd === 'seek' && m.ok === true && !m.coalesced);

    // permission off -> perm message + control-off
    p.send({ t: 'panel-settings', allowControl: false });
    assert.deepStrictEqual(pick(await v.waitFor('perm'), ['control']), { control: false });
    v.send({ t: 'control', cmd: 'play' });
    assert.strictEqual((await v.waitFor((m) => m.t === 'error' && m.code === 'control-off')).cmd, 'play');
    const v2 = track(await connectViewer({ port, code }));
    assert.strictEqual((await v2.waitFor('welcome')).control, false);
    p.send({ t: 'panel-settings', allowControl: true });
    assert.strictEqual((await v.waitFor((m) => m.t === 'perm' && m.control === true)).control, true);

    // panel gone -> no-host again
    p.close();
    await p.waitClose();
    await sleep(50);
    v.send({ t: 'control', cmd: 'pause' });
    assert.strictEqual((await v.waitFor((m) => m.t === 'error' && m.cmd === 'pause')).code, 'no-host');
  });
});

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

test('kick and new-session', async () => {
  await withHelper(async ({ port, code, track, helper }) => {
    const p = track(await connectPanel({ port }));
    const a = track(await connectViewer({ port, code, name: 'A' }));
    const b = track(await connectViewer({ port, code, name: 'B' }));
    const aid = (await a.waitFor('welcome')).id;
    await b.waitFor('welcome');
    await p.waitFor((m) => m.t === 'state' && m.viewerList && m.viewerList.length === 2);

    p.send({ t: 'kick', id: aid });
    assert.strictEqual((await a.waitFor('error')).code, 'kicked');
    await a.waitClose();
    await p.waitFor((m) => m.t === 'state' && m.viewerList && m.viewerList.length === 1);

    p.send({ t: 'new-session' });
    assert.strictEqual((await b.waitFor('error')).code, 'session-ended');
    await b.waitClose();
    const next = await p.waitFor((m) => m.t === 'state' && m.code && m.code !== code && m.viewerList.length === 0);
    assert.notStrictEqual(helper.hub.code, code);
    assert.strictEqual(next.code, helper.hub.code);

    const old = await connectViewer({ port, code });
    // the old code is now wrong (unless the new random code collides)
    if (helper.hub.code !== code) assert.strictEqual((await old.waitFor('error')).code, 'bad-code');

    // HTTP endpoint does the same
    const before = helper.hub.code;
    const r = await get(port, '/api/session/new', { method: 'POST' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).code, helper.hub.code);
    assert.ok(before);
  });
});

test('audio only reaches viewers that turned it on; source frames fan out', async () => {
  await withHelper(async ({ port, code, track }) => {
    const quiet = track(await connectViewer({ port, code }));
    const loud = track(await connectViewer({ port, code }));
    await quiet.waitFor('welcome');
    await loud.waitFor('welcome');
    loud.send({ t: 'audio', on: true });
    const src = track(await connectSource({ port }));
    src.sendSourceState();
    await sleep(50);

    const samples = Buffer.alloc(960 * 4, 1);
    src.sendBinary(otv1.encodeAudio({ seq: 0, time: 1.25, frames: 960, samples }));
    src.sendBinary(otv1.encodeFrame({ seq: 99, time: NaN, width: 320, height: 180, srcWidth: 1080, srcHeight: 1350, jpeg: JPEG }));

    const audio = otv1.decode(await loud.waitBinary((b) => b[4] === 2));
    assert.strictEqual(audio.frames, 960);
    assert.strictEqual(audio.sampleRate, 48000);
    assert.strictEqual(audio.time, 1.25);
    assert.ok(audio.samples.equals(samples));

    const frame = otv1.decode(await quiet.waitBinary((b) => b[4] === 1));
    assert.strictEqual(frame.seq, 1); // helper rewrites the sequence number
    assert.ok(Number.isNaN(frame.time));
    assert.strictEqual(frame.srcHeight, 1350);
    await loud.waitBinary((b) => b[4] === 1);
    await sleep(100);
    assert.strictEqual(quiet.binary.filter((b) => b[4] === 2).length, 0);

    // sources receive state too
    assert.strictEqual((await src.waitFor((m) => m.t === 'state' && m.status === 'live')).viewers, 2);

    // photoshop-style state: no fps/time, aspect 4x5
    const st = await quiet.waitFor((m) => m.t === 'state' && m.status === 'live');
    assert.strictEqual(st.host.app, 'photoshop');
    assert.strictEqual(st.sequence.name, 'poster.psd');
    assert.strictEqual(st.sequence.aspect, '4x5');
    assert.strictEqual(st.timecode, undefined);
    assert.strictEqual(st.audio.available, true);

    // turning audio off stops chunks
    loud.send({ t: 'audio', on: false });
    await sleep(50);
    const n = loud.binary.length;
    src.sendBinary(otv1.encodeAudio({ seq: 0, frames: 960, samples }));
    await sleep(100);
    assert.strictEqual(loud.binary.length, n);
  });
});

test('ping/pong, info, telemetry in viewerList, stats every second, rtc unsupported', async () => {
  await withHelper(async ({ port, ingestPort, code, track }) => {
    const p = track(await connectPanel({ port }));
    const v = track(await connectViewer({ port, code, name: 'Pixel' }));
    await v.waitFor('welcome');
    v.send({ t: 'ping', ts: 1234 });
    const pong = await v.waitFor('pong');
    assert.strictEqual(pong.ts, 1234);
    assert.ok(Math.abs(pong.serverTs - Date.now()) < 5000);

    v.send({ t: 'info', name: 'Pixel 8', w: 1080, h: 2400 });
    v.send({ t: 'telemetry', fps: 23.5, delayMs: 140, decodeMs: 6, w: 1080, h: 2400 });
    const withTele = await p.waitFor((m) => m.t === 'state' && m.viewerList && m.viewerList[0] && m.viewerList[0].delayMs === 140);
    assert.strictEqual(withTele.viewerList[0].name, 'Pixel 8');
    assert.strictEqual(withTele.viewerList[0].fps, 23.5);

    v.send({ t: 'rtc-start' });
    assert.strictEqual((await v.waitFor((m) => m.t === 'error' && m.cmd === 'rtc-start')).code, 'unsupported');

    const tx = track(await connectTransmit({ port: ingestPort }));
    const timer = setInterval(() => tx.sendFrame(1), 40);
    try {
      const vs = await v.waitFor((m) => m.t === 'stats' && m.kbps > 0 && m.fps > 5, 4000);
      assert.strictEqual(vs.transport, 'jpeg');
      assert.strictEqual(vs.viewers, 1);
      assert.strictEqual(vs.width, 320);
      assert.strictEqual(vs.dropped, 0);
      assert.ok(vs.uptimeSec >= 0);
      const ps = await p.waitFor((m) => m.t === 'stats' && m.kbps > 0, 4000);
      assert.strictEqual(ps.transport, undefined);
    } finally {
      clearInterval(timer);
    }
  });
});

test('slow viewer: frames are dropped, never queued', async () => {
  await withHelper(async ({ port, code, track, helper }) => {
    const p = track(await connectPanel({ port }));
    const slow = track(await connectViewer({ port, code }));
    await slow.waitFor('welcome');
    slow.ws._socket.pause();
    const src = track(await connectSource({ port }));
    const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(1_500_000, 7), Buffer.from([0xff, 0xd9])]);
    for (let i = 0; i < 40; i += 1) {
      src.sendBinary(otv1.encodeFrame({ seq: 0, time: i, width: 320, height: 180, jpeg: big }));
      if (i % 5 === 4) await sleep(10);
    }
    await sleep(300);
    const v = helper.hub.viewers()[0];
    assert.ok(v.ws.bufferedAmount < 8_000_000, `bufferedAmount ${v.ws.bufferedAmount}`);
    await p.waitFor((m) => m.t === 'stats' && m.dropped > 0, 3000);
    // a healthy viewer still gets the newest frame
    const ok = track(await connectViewer({ port, code }));
    await ok.waitFor('welcome');
    src.sendBinary(otv1.encodeFrame({ seq: 0, time: 77, width: 320, height: 180, jpeg: JPEG }));
    assert.strictEqual(otv1.decode(await ok.waitBinary((b) => otv1.decode(b) && otv1.decode(b).time === 77)).time, 77);
  });
});
