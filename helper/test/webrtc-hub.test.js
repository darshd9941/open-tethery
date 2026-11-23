'use strict';

// Hub + ingest + WebRTC together: fake Transmit (H.264) -> helper -> viewers (ws) and a werift phone.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHelper } = require('../lib/index');
const { createRtc, loadWerift } = require('../lib/webrtc');
const { connectViewer } = require('../tools/fake-viewer');
const { connectH264Transmit } = require('../tools/fake-transmit-h264');
const { attachRtcPhone } = require('../tools/fake-rtc-phone');

const werift = loadWerift();
const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-viewer-'));
fs.writeFileSync(path.join(viewerDir, 'index.html'), '<!doctype html><title>viewer</title>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function withHelper(fn, { rtc, rtcOpts } = {}) {
  const helper = createHelper({
    port: 0,
    ingestPort: 0,
    lanIp: '192.168.1.20',
    logFile: null,
    echo: false,
    viewerDir,
    configPath: path.join(viewerDir, 'none.json'),
    rtc: rtc || createRtc({ hostAddresses: ['127.0.0.1'], ...rtcOpts }),
  });
  const { port, ingestPort } = await helper.start();
  const closers = [];
  const track = (c) => {
    closers.push(c);
    return c;
  };
  try {
    await fn({ helper, port, ingestPort, code: helper.hub.code, track });
  } finally {
    for (const c of closers) if (c.close) c.close();
    await helper.stop();
  }
}

const binaryCount = (v) => v.binary.length;

test('no werift: welcome.webrtc false even with H.264 flowing; viewers get JPEG; rtc-start is unsupported', async () => {
  await withHelper(async ({ port, ingestPort, code, track }) => {
    const plugin = track(await connectH264Transmit({ port: ingestPort, fps: 30 }));
    await waitFor(() => plugin.sentH264 > 5, 'H.264 sent');
    const v = track(await connectViewer({ port, code, accept: ['jpeg', 'pcm', 'webrtc'] }));
    const welcome = await v.welcome();
    assert.strictEqual(welcome.webrtc, false);
    v.send({ t: 'rtc-start' });
    const err = await v.waitFor((m) => m.t === 'error' && m.cmd === 'rtc-start');
    assert.strictEqual(err.code, 'unsupported');
    // JPEG keeps flowing: the plugin was told JPEG is wanted
    await v.waitBinary((b) => b[4] === 1, 4000);
    assert.strictEqual(plugin.jpegWanted, true);
  }, { rtc: createRtc({ werift: null }) });
});

test('webrtc flag: false without an H.264 source, announced when H.264 starts; per-viewer accept', { skip: !werift && 'werift missing' }, async () => {
  await withHelper(async ({ port, ingestPort, code, track }) => {
    const withRtc = track(await connectViewer({ port, code, accept: ['jpeg', 'pcm', 'webrtc'] }));
    assert.strictEqual((await withRtc.welcome()).webrtc, false, 'no H.264 source yet');
    const jpegOnly = track(await connectViewer({ port, code, accept: ['jpeg', 'pcm'] }));
    await jpegOnly.welcome();

    const plugin = track(await connectH264Transmit({ port: ingestPort, fps: 30 }));
    const ann = await withRtc.waitFor((m) => m.t === 'webrtc');
    assert.deepStrictEqual(ann, { t: 'webrtc', available: true });
    assert.ok(!jpegOnly.messages.some((m) => m.t === 'webrtc'), 'viewer without "webrtc" in accept hears nothing about it');

    // a new viewer that accepts webrtc gets webrtc:true in welcome; one that does not, false
    const late = track(await connectViewer({ port, code, accept: ['jpeg', 'webrtc'] }));
    assert.strictEqual((await late.welcome()).webrtc, true);
    const late2 = track(await connectViewer({ port, code, accept: ['jpeg'] }));
    assert.strictEqual((await late2.welcome()).webrtc, false);

    // viewer without "webrtc" in accept: rtc-start refused, JPEG only
    jpegOnly.send({ t: 'rtc-start' });
    assert.strictEqual((await jpegOnly.waitFor((m) => m.t === 'error' && m.cmd === 'rtc-start')).code, 'unsupported');
    await jpegOnly.waitBinary((b) => b[4] === 1, 4000);
    assert.ok(plugin.sentJpeg > 0);

    // the plugin disconnecting ends H.264: viewers hear webrtc unavailable
    plugin.close();
    assert.deepStrictEqual(await withRtc.waitFor((m) => m.t === 'webrtc' && m.available === false), { t: 'webrtc', available: false });
  });
});

test('end to end with a werift phone: connects, JPEG stops, keyframe + jpeg:false reach the plugin, stall brings JPEG back', { skip: !werift && 'werift missing', timeout: 40000 }, async () => {
  await withHelper(async ({ helper, port, ingestPort, code, track }) => {
    const plugin = track(await connectH264Transmit({ port: ingestPort, fps: 30 }));
    await waitFor(() => helper.hub.h264Active, 'H.264 active');
    const v = track(await connectViewer({ port, code, accept: ['jpeg', 'pcm', 'webrtc'] }));
    assert.strictEqual((await v.welcome()).webrtc, true);
    const phone = attachRtcPhone(v);
    track(phone);
    const keyframesBefore = plugin.keyframeRequests;
    v.send({ t: 'rtc-start' });
    await v.waitFor((m) => m.t === 'rtc-offer');
    await v.waitFor((m) => m.t === 'rtc-state' && m.state === 'connected', 10000);
    assert.ok(plugin.keyframeRequests > keyframesBefore, 'plugin was asked for a keyframe');
    await waitFor(() => phone.frames >= 10, 'RTP frames at the phone');

    // helper tells the plugin JPEG is no longer needed, and stops binary video to this viewer
    await waitFor(() => plugin.jpegWanted === false, 'jpeg:false sent to plugin');
    await sleep(300);
    const n = binaryCount(v);
    await sleep(700);
    assert.strictEqual(binaryCount(v), n, 'no binary JPEG while WebRTC is connected');
    const stats = await v.waitFor((m) => m.t === 'stats' && m.transport === 'webrtc', 3000);
    assert.strictEqual(stats.transport, 'webrtc');

    // the RTP stalls (plugin stops sending H.264): after ~3 s state failed, JPEG wanted again and flowing
    plugin.paused = true;
    const t0 = Date.now();
    await v.waitFor((m) => m.t === 'rtc-state' && m.state === 'failed', 8000);
    const took = Date.now() - t0;
    assert.ok(took >= 2500 && took < 6000, `fallback after about 3 s (took ${took} ms)`);
    await waitFor(() => plugin.jpegWanted === true, 'jpeg:true sent to plugin');
    const before = binaryCount(v);
    await waitFor(() => binaryCount(v) > before + 2, 'JPEG frames resume');
    const stats2 = await v.waitFor((m) => m.t === 'stats' && m.transport === 'jpeg' && m.kbps > 0, 4000);
    assert.strictEqual(stats2.transport, 'jpeg');
  });
});

test('viewer rtc-stop returns to JPEG and the plugin is asked for JPEG again', { skip: !werift && 'werift missing', timeout: 30000 }, async () => {
  await withHelper(async ({ helper, port, ingestPort, code, track }) => {
    const plugin = track(await connectH264Transmit({ port: ingestPort, fps: 30 }));
    await waitFor(() => helper.hub.h264Active, 'H.264 active');
    const v = track(await connectViewer({ port, code, accept: ['jpeg', 'webrtc'] }));
    await v.welcome();
    track(attachRtcPhone(v));
    v.send({ t: 'rtc-start' });
    await v.waitFor((m) => m.t === 'rtc-state' && m.state === 'connected', 10000);
    await waitFor(() => plugin.jpegWanted === false, 'jpeg:false');
    v.send({ t: 'rtc-stop' });
    await v.waitFor((m) => m.t === 'rtc-state' && m.state === 'closed');
    await waitFor(() => plugin.jpegWanted === true, 'jpeg:true again');
    const before = binaryCount(v);
    await waitFor(() => binaryCount(v) > before, 'JPEG resumes');
  });
});
