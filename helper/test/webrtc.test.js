'use strict';

// OTX1 types 4/5/64/65, H.264 packetizing, and werift <-> werift RTP loopback.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const otx1 = require('../lib/otx1');
const { splitAnnexB, packetize, nalType, hasIdr } = require('../lib/h264');
const { createRtc, loadWerift } = require('../lib/webrtc');
const { splitAccessUnits, h264Size, DEFAULT_CLIP } = require('../tools/fake-transmit-h264');

const werift = loadWerift();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- OTX1 messages

function roundTrip(buf) {
  const out = [];
  const parser = new otx1.FrameParser((m) => out.push(m));
  // feed in awkward chunk sizes
  for (let i = 0; i < buf.length; i += 7) parser.push(buf.subarray(i, i + 7));
  assert.equal(out.length, 1);
  return out[0];
}

test('OTX1 type 4: H.264 access unit round trip', () => {
  const data = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x65, 9, 9, 9]);
  const msg = roundTrip(otx1.h264Message(7, data, { keyframe: true, width: 1920, height: 1080, ticks: 254016000000n * 3n }));
  assert.equal(msg.type, otx1.TYPE_H264);
  assert.equal(msg.seq, 7);
  assert.equal(msg.payload.length, otx1.H264_META_SIZE + data.length);
  const au = otx1.parseH264Payload(msg.payload);
  assert.equal(au.keyframe, true);
  assert.equal(au.width, 1920);
  assert.equal(au.height, 1080);
  assert.equal(au.time, 3);
  assert.deepEqual(au.data, data);
  // flags bit 0 clear -> not a keyframe
  assert.equal(otx1.parseH264Payload(roundTrip(otx1.h264Message(1, data, { width: 8, height: 8 })).payload).keyframe, false);
});

test('OTX1 type 4: rejects payloads without a start code or too short', () => {
  const meta = Buffer.alloc(otx1.H264_META_SIZE);
  assert.equal(otx1.parseH264Payload(meta), null);
  assert.equal(otx1.parseH264Payload(Buffer.concat([meta, Buffer.from([1, 2, 3, 4, 5, 6])])), null);
  assert.equal(otx1.parseH264Payload(Buffer.concat([meta, Buffer.from([0, 0, 1, 0x65, 1])])).data.length, 5);
});

test('OTX1 type 5: PCM chunk round trip and validation', () => {
  const samples = Buffer.alloc(960 * 2 * 2); // 20 ms of 48 kHz stereo
  for (let i = 0; i < samples.length; i += 2) samples.writeInt16LE((i * 31) % 20000, i);
  const msg = roundTrip(otx1.audioMessage(3, samples, { sampleRate: 48000, channels: 2, ticks: 254016000000n / 2n }));
  assert.equal(msg.type, otx1.TYPE_AUDIO);
  const a = otx1.parseAudioPayload(msg.payload);
  assert.equal(a.sampleRate, 48000);
  assert.equal(a.channels, 2);
  assert.equal(a.format, 1);
  assert.equal(a.frames, 960);
  assert.equal(a.time, 0.5);
  assert.deepEqual(a.samples, samples);
  // frame count that disagrees with the byte count is rejected
  const bad = Buffer.from(msg.payload);
  bad.writeUInt16LE(959, 6);
  assert.equal(otx1.parseAudioPayload(bad), null);
  assert.equal(otx1.parseAudioPayload(Buffer.alloc(4)), null);
});

test('OTX1 types 64/65: helper -> plugin messages', () => {
  const k = roundTrip(otx1.requestKeyframeMessage(5));
  assert.equal(k.type, otx1.TYPE_REQUEST_KEYFRAME);
  assert.equal(k.type, 64);
  assert.equal(k.payload.length, 0);
  const j = roundTrip(otx1.jpegWantedMessage(6, true));
  assert.equal(j.type, 65);
  assert.equal(otx1.parseJpegWanted(j.payload), true);
  assert.equal(otx1.parseJpegWanted(roundTrip(otx1.jpegWantedMessage(7, false)).payload), false);
  assert.equal(otx1.parseJpegWanted(Buffer.from('{"jpeg":1}')), null);
  assert.equal(otx1.parseJpegWanted(Buffer.from('nope')), null);
});

// ---------------------------------------------------------------- H.264 helpers

const clip = fs.readFileSync(DEFAULT_CLIP);

test('fixture clip: access units and size', () => {
  const units = splitAccessUnits(clip);
  assert.equal(units.length, 120); // 4 s at 30 fps
  assert.equal(units[0].keyframe, true);
  assert.equal(units.filter((u) => u.keyframe).length, 4); // -g 30
  assert.deepEqual(h264Size(clip), { width: 640, height: 360 });
  // every keyframe unit carries SPS + PPS in front of the IDR (repeat-headers)
  const types = splitAnnexB(units[30].data).map(nalType);
  assert.deepEqual(types.filter((t) => t === 7 || t === 8 || t === 5).sort(), [5, 7, 8]);
});

// Reassembles RTP payloads (single NAL + FU-A) into NAL units.
function depacketize(payloads) {
  const nals = [];
  let fu = null;
  for (const p of payloads) {
    const t = p[0] & 0x1f;
    if (t === 28) {
      if (p[1] & 0x80) fu = [Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)])];
      fu.push(p.subarray(2));
      if (p[1] & 0x40) {
        nals.push(Buffer.concat(fu));
        fu = null;
      }
    } else nals.push(p);
  }
  return nals;
}

test('packetize: FU-A splits big NAL units and reassembles byte-exact', () => {
  const units = splitAccessUnits(clip);
  const nals = splitAnnexB(units[0].data);
  assert.ok(hasIdr(nals));
  const payloads = packetize(nals, 1200);
  assert.ok(payloads.every((p) => p.length <= 1200));
  assert.ok(payloads.some((p) => (p[0] & 0x1f) === 28), 'IDR is larger than one packet');
  const back = depacketize(payloads);
  assert.equal(back.length, nals.length);
  back.forEach((n, i) => assert.deepEqual(n, nals[i]));
});

test('splitAnnexB handles 3- and 4-byte start codes', () => {
  const buf = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4, 5]);
  assert.deepEqual(splitAnnexB(buf).map((n) => [...n]), [[0x67, 1, 2], [0x68, 3], [0x65, 4, 5]]);
});

// ---------------------------------------------------------------- werift loopback

function fakeViewer(id = 'v1') {
  const msgs = [];
  const handlers = [];
  return {
    id,
    accept: ['jpeg', 'webrtc'],
    msgs,
    on: (fn) => handlers.push(fn),
    send(obj) {
      msgs.push(obj);
      for (const h of handlers) h(obj);
    },
  };
}

// A werift "phone": answers the helper's offer and collects the RTP payloads it receives.
function attachReceiver(rtc, viewer) {
  const { RTCPeerConnection, RTCRtpCodecParameters } = werift;
  const pc = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: ['127.0.0.1'],
    codecs: {
      audio: [],
      video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' })],
    },
  });
  const rx = { pc, payloads: [], markers: 0, timestamps: new Set(), payloadTypes: new Set() };
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      rx.payloads.push(rtp.payload);
      rx.payloadTypes.add(rtp.header.payloadType);
      rx.timestamps.add(rtp.header.timestamp);
      if (rtp.header.marker) rx.markers += 1;
    });
  });
  pc.addTransceiver('video', { direction: 'recvonly' });
  for (const t of pc.iceTransports) t.connection.stunServer = undefined; // werift would query Google STUN
  pc.onIceCandidate.subscribe((c) => {
    if (c) rtc.ice(viewer, { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex });
  });
  viewer.on(async (msg) => {
    if (msg.t === 'rtc-offer') {
      rx.offer = msg.sdp;
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      rtc.answer(viewer, pc.localDescription.sdp);
    } else if (msg.t === 'rtc-ice' && msg.candidate) {
      await pc.addIceCandidate(msg.candidate).catch(() => {});
    }
  });
  return rx;
}

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${what}`);
}

test('werift loopback: helper offers H.264, RTP flows and reassembles to the original NAL units', { skip: !werift && 'werift not installed', timeout: 30000 }, async () => {
  const units = splitAccessUnits(clip);
  const rtc = createRtc({ hostAddresses: ['127.0.0.1'] });
  let keyframeRequests = 0;
  let changes = 0;
  rtc.requestKeyframe = () => { keyframeRequests += 1; };
  rtc.onChange = () => { changes += 1; };
  const viewer = fakeViewer();
  const rx = attachReceiver(rtc, viewer);
  rtc.start(viewer);

  let i = 0;
  const feed = setInterval(() => {
    const u = units[i++ % units.length];
    rtc.pushH264({ keyframe: u.keyframe, data: u.data, width: 640, height: 360 });
  }, 33);
  try {
    await waitFor(() => rtc.isConnected(viewer), 'connected');
    await waitFor(() => rx.markers >= 20, '20 frames received');
  } finally {
    clearInterval(feed);
  }

  // signalling per PROTOCOL section 7
  const offer = viewer.msgs.find((m) => m.t === 'rtc-offer');
  assert.ok(offer, 'rtc-offer sent');
  assert.match(offer.sdp, /m=video/);
  assert.match(offer.sdp, /a=rtpmap:\d+ H264\/90000/i);
  assert.match(offer.sdp, /packetization-mode=1/);
  assert.match(offer.sdp, /profile-level-id=42e01f/i);
  assert.match(offer.sdp, /a=sendonly/);
  assert.doesNotMatch(offer.sdp, /m=audio/, 'no audio m-line until Opus exists');
  assert.ok(viewer.msgs.some((m) => m.t === 'rtc-ice' && m.candidate && /127\.0\.0\.1/.test(m.candidate.candidate)), 'host candidate trickled');
  assert.deepEqual(viewer.msgs.filter((m) => m.t === 'rtc-state').map((m) => m.state), ['connected']);
  assert.ok(keyframeRequests >= 1, 'asked the plugin for a keyframe');
  assert.ok(changes >= 1);
  assert.equal(rtc.carriesAudio(viewer), false);

  // the first picture the viewer receives is a full keyframe: SPS, PPS, IDR
  const nals = depacketize(rx.payloads);
  const types = nals.map(nalType);
  assert.ok(types.includes(7) && types.includes(8) && types.includes(5), 'SPS, PPS and IDR arrived');
  // the stream may begin on any of the clip's keyframes: it must equal one of them byte for byte
  const sentIdrs = units.filter((u) => u.keyframe).map((u) => splitAnnexB(u.data).find((n) => nalType(n) === 5));
  const sentSps = splitAnnexB(units[0].data).find((n) => nalType(n) === 7);
  assert.deepEqual(nals.find((n) => nalType(n) === 7), sentSps);
  assert.ok(sentIdrs.some((idr) => idr.equals(nals.find((n) => nalType(n) === 5))), 'IDR slice byte-exact after RTP');
  assert.ok(rx.timestamps.size >= 15, 'distinct RTP timestamps per frame');
  assert.equal(rx.payloadTypes.size, 1);

  rtc.stop(viewer);
  assert.equal(rtc.isConnected(viewer), false);
  assert.equal(viewer.msgs.at(-1).state, 'closed');
  await rx.pc.close();
  rtc.close();
});

test('werift loopback: RTP stall for 3 s -> rtc-state failed, isConnected false', { skip: !werift && 'werift not installed', timeout: 30000 }, async () => {
  const units = splitAccessUnits(clip);
  const rtc = createRtc({ hostAddresses: ['127.0.0.1'], stallMs: 1000 }); // shortened for the test
  rtc.requestKeyframe = () => {};
  const viewer = fakeViewer();
  const rx = attachReceiver(rtc, viewer);
  rtc.start(viewer);
  let i = 0;
  const feed = setInterval(() => {
    const u = units[i++ % units.length];
    rtc.pushH264({ keyframe: u.keyframe, data: u.data, width: 640, height: 360 });
  }, 33);
  await waitFor(() => rtc.isConnected(viewer), 'connected');
  clearInterval(feed); // the source goes quiet
  await waitFor(() => viewer.msgs.some((m) => m.t === 'rtc-state' && m.state === 'failed'), 'failed after stall', 5000);
  assert.equal(rtc.isConnected(viewer), false);
  await rx.pc.close();
  rtc.close();
});

test('rtc without werift: available false, rtc-start answered with unsupported', () => {
  const rtc = createRtc({ werift: null });
  assert.equal(rtc.available, false);
  const viewer = fakeViewer();
  rtc.start(viewer);
  assert.deepEqual(viewer.msgs, [{ t: 'error', code: 'unsupported', cmd: 'rtc-start' }]);
  assert.equal(rtc.isConnected(viewer), false);
  rtc.pushH264({ keyframe: true, data: Buffer.from([0, 0, 1, 0x65, 1]) }); // no-op
  rtc.close();
});
