'use strict';

// WebRTC video to phones (docs/PROTOCOL.md section 7), using the pure-JS
// "werift" library (optional dependency). The helper never encodes: it
// packetizes the H.264 access units the Transmit plugin sends (OTX1 type 4)
// into RTP and forwards them. JPEG over the WebSocket stays the fallback.
//
// Interface used by the hub:
//   rtc.available                 werift loaded (goes into welcome.webrtc together with an active H.264 source)
//   rtc.start(viewer)             viewer sent rtc-start; sends rtc-offer via viewer.send(obj)
//   rtc.answer(viewer, sdp) / rtc.ice(viewer, candidate) / rtc.stop(viewer)
//   rtc.isConnected(viewer)       true -> hub stops binary JPEG to that viewer
//   rtc.carriesAudio(viewer)      true -> hub stops binary PCM (always false until Opus exists)
//   rtc.pushH264(au)              every H.264 access unit from the plugin
//   rtc.pushFrame / pushAudio     unused here (JPEG / PCM stay on the WebSocket)
//   rtc.onChange                  hub sets it: called when any viewer's connected state changes
//   rtc.requestKeyframe           hub sets it: ask the plugin for an IDR frame
//   rtc.close()

const { splitAnnexB, packetize, hasIdr } = require('./h264');

const H264_FMTP = 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f';
const STALL_MS = 3000; // no RTP written to a connected viewer for this long -> fall back to JPEG
const CONNECT_TIMEOUT_MS = 10000; // ICE/DTLS did not finish
const KEYFRAME_MIN_INTERVAL_MS = 500;

function loadWerift() {
  try {
    return require('werift');
  } catch {
    return null;
  }
}

function createRtc({ werift = loadWerift(), log = () => {}, now = Date.now, stallMs = STALL_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, hostAddresses } = {}) {
  const sessions = new Map(); // viewer -> session
  let lastKeyframe = null; // newest keyframe access unit, sent to a viewer as soon as its link is up
  let lastKeyframeRequest = 0;
  let closed = false;

  const rtc = {
    available: Boolean(werift),
    onChange: null,
    requestKeyframe: null,
  };

  const changed = () => {
    try {
      rtc.onChange && rtc.onChange();
    } catch (err) {
      log(`webrtc: onChange failed: ${err.message}`);
    }
  };

  function askKeyframe() {
    const t = now();
    if (t - lastKeyframeRequest < KEYFRAME_MIN_INTERVAL_MS) return;
    lastKeyframeRequest = t;
    try {
      rtc.requestKeyframe && rtc.requestKeyframe();
    } catch {
      // plugin link gone
    }
  }

  function writeAu(s, payloads) {
    const ts = (s.tsBase + Math.round((now() - s.t0) * 90)) >>> 0;
    const { RtpHeader, RtpPacket } = werift;
    for (let i = 0; i < payloads.length; i += 1) {
      const header = new RtpHeader({
        payloadType: 96, // rewritten by the sender to the negotiated one
        sequenceNumber: s.seq,
        timestamp: ts,
        marker: i === payloads.length - 1,
      });
      s.seq = (s.seq + 1) & 0xffff;
      s.track.writeRtp(new RtpPacket(header, payloads[i]));
    }
    s.lastWrite = now();
  }

  function markConnected(s) {
    if (s.state !== 'connecting') return;
    s.state = 'connected';
    s.viewer.send({ t: 'rtc-state', state: 'connected' });
    log(`webrtc: ${s.viewer.id} connected`);
    changed();
  }

  // Link is up and a keyframe is available: start the stream.
  function tryStart(s) {
    if (!s.dtlsUp || s.started || !lastKeyframe) return;
    s.started = true;
    writeAu(s, lastKeyframe.payloads);
    markConnected(s);
  }

  function endSession(s, state, reason) {
    if (s.ended) return;
    s.ended = true;
    clearTimeout(s.connectTimer);
    if (sessions.get(s.viewer) === s) sessions.delete(s.viewer);
    const wasConnected = s.state === 'connected';
    s.state = 'closed';
    try {
      s.pc.close().catch(() => {});
    } catch {
      // already closed
    }
    if (state) s.viewer.send({ t: 'rtc-state', state });
    log(`webrtc: ${s.viewer.id} ${state || 'closed'}${reason ? ` (${reason})` : ''}`);
    if (wasConnected || state === 'failed') changed();
  }

  rtc.start = function start(viewer) {
    if (!werift || closed) return viewer.send({ t: 'error', code: 'unsupported', cmd: 'rtc-start' });
    const old = sessions.get(viewer);
    if (old) endSession(old, null, 'restart');

    const { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack } = werift;
    const pc = new RTCPeerConnection({
      iceServers: [], // host candidates only: LAN / Tailscale, no STUN or TURN (see stunServer below)
      iceUseIpv6: false,
      ...(hostAddresses ? { iceAdditionalHostAddresses: hostAddresses } : {}),
      codecs: {
        audio: [],
        video: [
          new RTCRtpCodecParameters({
            mimeType: 'video/H264',
            clockRate: 90000,
            rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
            parameters: H264_FMTP,
          }),
        ],
      },
    });
    const track = new MediaStreamTrack({ kind: 'video' });
    const s = {
      viewer,
      pc,
      track,
      state: 'connecting',
      ended: false,
      dtlsUp: false,
      started: false,
      remoteSet: false,
      pendingIce: [],
      offerSent: false,
      pendingLocalIce: [],
      seq: Math.floor(Math.random() * 0xffff),
      t0: now(),
      tsBase: Math.floor(Math.random() * 0xffffffff),
      lastWrite: now(),
      connectTimer: null,
    };
    sessions.set(viewer, s);
    s.connectTimer = setTimeout(() => endSession(s, 'failed', 'connect timeout'), connectTimeoutMs);
    s.connectTimer.unref();

    const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
    // werift falls back to Google's STUN server when none is configured; this stays on the LAN.
    for (const t of pc.iceTransports) t.connection.stunServer = undefined;
    transceiver.sender.onPictureLossIndication.subscribe(() => askKeyframe());

    pc.onIceCandidate.subscribe((c) => {
      const msg = { t: 'rtc-ice', candidate: c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } : null };
      if (s.offerSent) viewer.send(msg);
      else s.pendingLocalIce.push(msg);
    });
    pc.connectionStateChange.subscribe((st) => {
      if (s.ended) return;
      if (st === 'connected') {
        s.dtlsUp = true;
        s.lastWrite = now();
        if (lastKeyframe) tryStart(s);
        else askKeyframe();
      } else if (st === 'failed' || st === 'closed') endSession(s, 'failed', `pc ${st}`);
    });

    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (s.ended) return;
      viewer.send({ t: 'rtc-offer', sdp: pc.localDescription.sdp });
      s.offerSent = true;
      for (const m of s.pendingLocalIce.splice(0)) viewer.send(m);
      askKeyframe();
    })().catch((err) => endSession(s, 'failed', `offer: ${err.message}`));
  };

  rtc.answer = function answer(viewer, sdp) {
    const s = sessions.get(viewer);
    if (!s || typeof sdp !== 'string' || s.remoteSet) return;
    s.remoteSet = true;
    s.pc
      .setRemoteDescription({ type: 'answer', sdp })
      .then(async () => {
        for (const c of s.pendingIce.splice(0)) await addCandidate(s, c);
      })
      .catch((err) => endSession(s, 'failed', `answer: ${err.message}`));
  };

  async function addCandidate(s, cand) {
    try {
      await s.pc.addIceCandidate(cand);
    } catch (err) {
      // e.g. an mDNS ".local" host candidate; the phone's checks still reach us (peer-reflexive)
      log(`webrtc: ${s.viewer.id} ignored candidate: ${err.message}`);
    }
  }

  rtc.ice = function ice(viewer, candidate) {
    const s = sessions.get(viewer);
    if (!s || !candidate || typeof candidate.candidate !== 'string' || !candidate.candidate) return; // null = end of candidates
    const init = { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? '0', sdpMLineIndex: candidate.sdpMLineIndex ?? 0 };
    if (!s.remoteSet || s.pendingIce.length) s.pendingIce.push(init);
    else addCandidate(s, init);
  };

  rtc.stop = function stop(viewer) {
    const s = sessions.get(viewer);
    if (s) endSession(s, 'closed', 'stopped');
  };

  rtc.isConnected = (viewer) => {
    const s = sessions.get(viewer);
    return Boolean(s && s.state === 'connected');
  };

  rtc.carriesAudio = () => false; // Opus track is reserved; PCM stays on the WebSocket

  rtc.pushFrame = () => {};
  rtc.pushAudio = () => {};

  rtc.pushH264 = function pushH264(au) {
    if (!werift || closed) return;
    const nals = splitAnnexB(au.data);
    if (!nals.length) return;
    const keyframe = au.keyframe || hasIdr(nals);
    const payloads = packetize(nals);
    if (!payloads.length) return;
    if (keyframe) lastKeyframe = { payloads };
    for (const s of sessions.values()) {
      if (!s.dtlsUp || s.ended) continue;
      if (!s.started) {
        if (!keyframe) continue; // a viewer must begin on a keyframe
        s.started = true;
        writeAu(s, payloads);
        markConnected(s);
      } else writeAu(s, payloads);
    }
  };

  // Stall detection: a connected viewer that has had no RTP for stallMs falls back to JPEG.
  const timer = setInterval(() => {
    const t = now();
    for (const s of [...sessions.values()]) {
      if (s.ended || !s.dtlsUp) continue;
      if (t - s.lastWrite > stallMs) endSession(s, 'failed', 'no RTP for 3 s');
    }
  }, 250);
  timer.unref();

  rtc.sessionCount = () => sessions.size;

  rtc.close = function close() {
    closed = true;
    clearInterval(timer);
    for (const s of [...sessions.values()]) endSession(s, null, 'shutdown');
  };

  return rtc;
}

module.exports = { createRtc, loadWerift };
