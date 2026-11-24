import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRtcTransport, retryDelay, isSupported, RETRY_MIN_MS, NO_VIDEO_MS } from '../js/transport-webrtc.js';

// ---- fakes
class FakePc {
  static last = null;
  constructor(cfg) {
    this.cfg = cfg;
    this.closed = false;
    this.added = [];
    this.connectionState = 'new';
    FakePc.last = this;
  }
  async setRemoteDescription(d) { this.remote = d; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async addIceCandidate(c) { this.added.push(c); }
  close() { this.closed = true; }
}

function makeClock() {
  const c = { t: 1000, timers: [] };
  c.now = () => c.t;
  c.setTimer = (fn, ms) => { const h = { fn, at: c.t + ms }; c.timers.push(h); return h; };
  c.clearTimer = (h) => { c.timers = c.timers.filter((x) => x !== h); };
  c.advance = (ms) => {
    const end = c.t + ms;
    for (;;) {
      const next = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      c.timers = c.timers.filter((x) => x !== next);
      c.t = next.at;
      next.fn();
    }
    c.t = end;
  };
  return c;
}

function setup() {
  const clock = makeClock();
  const sent = [];
  const active = [];
  const video = { videoWidth: 0, pause() {}, play() { return Promise.resolve(); } };
  const rtc = createWebRtcTransport({
    send: (m) => { sent.push(m); return true; },
    PeerConnection: FakePc,
    video,
    onActive: (a) => active.push(a),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const types = () => sent.map((m) => m.t);
  return { clock, sent, active, rtc, video, types };
}

const tick = () => new Promise((r) => setImmediate(r));

test('retryDelay enforces one rtc-start per 10 s', () => {
  assert.equal(retryDelay(NaN, 5000), 0);
  assert.equal(retryDelay(1000, 1000), RETRY_MIN_MS);
  assert.equal(retryDelay(1000, 6000), 5000);
  assert.equal(retryDelay(1000, 20000), 0);
});

test('isSupported checks RTCPeerConnection', () => {
  assert.equal(isSupported({}), false);
  assert.equal(isSupported({ RTCPeerConnection: FakePc }), true);
});

test('unsupported browser: never sends rtc-start', () => {
  const sent = [];
  const rtc = createWebRtcTransport({ send: (m) => sent.push(m), PeerConnection: undefined });
  assert.equal(rtc.supported, false);
  rtc.setAvailable(true);
  assert.deepEqual(sent, []);
});

test('webrtc not available from the helper: nothing is sent', () => {
  const { rtc, sent } = setup();
  rtc.setAvailable(false);
  assert.deepEqual(sent, []);
});

test('full signalling: rtc-start, offer -> answer, trickle both ways, connected', async () => {
  const { rtc, sent, active, types } = setup();
  rtc.setAvailable(true);
  assert.deepEqual(types(), ['rtc-start']);
  assert.equal(rtc.handleMessage({ t: 'rtc-offer', sdp: 'v=0 offer' }), true);
  await tick();
  assert.deepEqual(FakePc.last.cfg, { iceServers: [] }, 'no STUN/TURN');
  assert.equal(FakePc.last.remote.sdp, 'v=0 offer');
  assert.deepEqual(sent.at(-1), { t: 'rtc-answer', sdp: 'v=0 answer' });

  // candidates from the helper are applied; null / empty means end-of-candidates
  rtc.handleMessage({ t: 'rtc-ice', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  rtc.handleMessage({ t: 'rtc-ice', candidate: null });
  assert.equal(FakePc.last.added.length, 1);
  // our candidates are trickled
  FakePc.last.onicecandidate({ candidate: { candidate: 'candidate:9 1 udp 1 10.0.0.9 6000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  FakePc.last.onicecandidate({ candidate: null });
  assert.equal(sent.at(-2).t, 'rtc-ice');
  assert.equal(sent.at(-2).candidate.sdpMLineIndex, 0);
  assert.deepEqual(sent.at(-1), { t: 'rtc-ice', candidate: null });

  rtc.handleMessage({ t: 'rtc-state', state: 'connected' });
  assert.equal(rtc.active, true);
  assert.deepEqual(active, [true]);
});

test('candidates arriving before the offer is applied are queued', async () => {
  const { rtc } = setup();
  rtc.setAvailable(true);
  rtc.handleMessage({ t: 'rtc-offer', sdp: 'x' });
  rtc.handleMessage({ t: 'rtc-ice', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } }); // before setRemoteDescription resolved
  await tick();
  await tick();
  assert.equal(FakePc.last.added.length, 1);
});

test('rtc-state failed: falls back, retries no sooner than 10 s after the last rtc-start', async () => {
  const { rtc, clock, types, active } = setup();
  rtc.setAvailable(true);
  rtc.handleMessage({ t: 'rtc-offer', sdp: 'x' });
  await tick();
  rtc.handleMessage({ t: 'rtc-state', state: 'connected' });
  clock.advance(2000);
  rtc.handleMessage({ t: 'rtc-state', state: 'failed' });
  assert.equal(rtc.active, false);
  assert.equal(FakePc.last.closed, true);
  assert.deepEqual(active, [true, false]);
  assert.deepEqual(types().filter((t) => t === 'rtc-start').length, 1);
  clock.advance(RETRY_MIN_MS - 2000 - 100);
  assert.equal(types().filter((t) => t === 'rtc-start').length, 1, 'too early');
  clock.advance(200);
  assert.equal(types().filter((t) => t === 'rtc-start').length, 2, 'retried after 10 s');
});

test('connected but no decoded video for 5 s: gives up with rtc-stop (JPEG resumes), then retries', async () => {
  const { rtc, clock, types, video } = setup();
  rtc.setAvailable(true);
  rtc.handleMessage({ t: 'rtc-offer', sdp: 'x' });
  await tick();
  rtc.handleMessage({ t: 'rtc-state', state: 'connected' });
  clock.advance(NO_VIDEO_MS + 1500);
  assert.equal(rtc.active, false);
  assert.ok(types().includes('rtc-stop'));
  assert.equal(video.srcObject, null);
  clock.advance(RETRY_MIN_MS);
  assert.equal(types().filter((t) => t === 'rtc-start').length, 2);
});

test('helper never sends an offer: gives up and retries', () => {
  const { rtc, clock, types } = setup();
  rtc.setAvailable(true);
  clock.advance(9000);
  assert.ok(types().includes('rtc-stop'));
  assert.equal(rtc.state, 'idle');
  clock.advance(RETRY_MIN_MS);
  assert.equal(types().filter((t) => t === 'rtc-start').length, 2);
});

test('connectionLost resets so a reconnect can start at once; stop() sends rtc-stop', async () => {
  const { rtc, types } = setup();
  rtc.setAvailable(true);
  rtc.connectionLost();
  assert.equal(rtc.state, 'idle');
  rtc.setAvailable(true);
  assert.equal(types().filter((t) => t === 'rtc-start').length, 2);
  rtc.stop();
  assert.equal(types().at(-1), 'rtc-stop');
});

test('non-signalling messages are not consumed', () => {
  const { rtc } = setup();
  assert.equal(rtc.handleMessage({ t: 'state' }), false);
  assert.equal(rtc.handleMessage({ t: 'stats' }), false);
});
