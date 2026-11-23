// WebRTC video transport (docs/PROTOCOL.md section 7). The helper makes the offer (H.264); we answer,
// trickle ICE (host candidates only, no iceServers) and draw the incoming video into the same canvas
// pipeline as JPEG frames, so overlays, scopes and save-frame keep working through the frame bus.
// JPEG over the WebSocket is always the fallback: on any failure the helper resumes it by itself.
//
// Everything browser-specific is injected so the signalling logic can be unit tested with fakes.

export const RETRY_MIN_MS = 10000; // PROTOCOL: at most one rtc-start every 10 s
export const NO_VIDEO_MS = 5000; // connected but no decoded picture for this long -> give up, use JPEG

export function isSupported(g = globalThis) {
  return typeof g.RTCPeerConnection === 'function';
}

// Milliseconds to wait before the next rtc-start may be sent.
export function retryDelay(lastStartAt, now, minMs = RETRY_MIN_MS) {
  if (!Number.isFinite(lastStartAt)) return 0;
  return Math.max(0, lastStartAt + minMs - now);
}

// deps: send(obj) -> bool, PeerConnection (ctor), video (HTMLVideoElement or fake),
//       onFrame(video) per decoded video frame, onActive(bool), now(), setTimer/clearTimer
export function createWebRtcTransport({
  send,
  PeerConnection = globalThis.RTCPeerConnection,
  video = null,
  onFrame = () => {},
  onActive = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  log = () => {},
} = {}) {
  const supported = typeof PeerConnection === 'function';
  let pc = null;
  let session = 0; // bumps on every start/teardown so late async results are ignored
  let wantStart = false; // helper has WebRTC available and we should be running
  let lastStartAt = NaN;
  let retryTimer = null;
  let watchTimer = null;
  let state = 'idle'; // idle | starting | connected
  let lastFrameAt = 0;
  let connectedAt = 0;
  let remoteSet = false;
  let pendingIce = [];
  let frameLoop = 0;

  const setState = (s) => {
    if (s === state) return;
    const was = state === 'connected';
    state = s;
    if (was !== (s === 'connected')) onActive(s === 'connected');
  };

  function teardown() {
    session += 1;
    clearTimer(retryTimer);
    retryTimer = null;
    clearTimer(watchTimer);
    watchTimer = null;
    frameLoop += 1;
    if (pc) {
      try { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); } catch { /* closed */ }
      pc = null;
    }
    if (video) {
      try { video.pause?.(); video.srcObject = null; } catch { /* ignore */ }
    }
    remoteSet = false;
    pendingIce = [];
    setState('idle');
  }

  function scheduleRetry() {
    clearTimer(retryTimer);
    retryTimer = null;
    if (!wantStart || !supported) return;
    retryTimer = setTimer(() => { retryTimer = null; if (wantStart && state === 'idle') begin(); }, Math.max(50, retryDelay(lastStartAt, now())));
  }

  // Failure of any kind: tell the helper (so it resumes JPEG), drop the connection, retry later.
  function fail(reason, { notify = true } = {}) {
    log(`webrtc: ${reason}`);
    if (notify && state !== 'idle') send({ t: 'rtc-stop' });
    teardown();
    scheduleRetry();
  }

  function begin() {
    if (!supported || state !== 'idle') return false;
    lastStartAt = now();
    setState('starting');
    session += 1;
    if (send({ t: 'rtc-start' }) === false) {
      state = 'idle';
      return false;
    }
    // helper never answered: give up and retry
    watchTimer = setTimer(() => { if (state === 'starting') fail('no offer'); }, 8000);
    return true;
  }

  function startWatchdog() {
    clearTimer(watchTimer);
    const tick = () => {
      if (state !== 'connected') return;
      const idleFor = now() - (lastFrameAt || connectedAt);
      if (idleFor > NO_VIDEO_MS) return fail('no video frames');
      watchTimer = setTimer(tick, 1000);
    };
    watchTimer = setTimer(tick, 1000);
  }

  // Draw loop: one callback per decoded video frame.
  function startFrameLoop() {
    const mine = ++frameLoop;
    if (!video) return;
    const onVideoFrame = () => {
      if (mine !== frameLoop) return;
      if (video.videoWidth > 0) {
        lastFrameAt = now();
        try { onFrame(video); } catch (e) { console.error('webrtc frame', e); }
      }
      schedule();
    };
    let lastTime = -1;
    const schedule = () => {
      if (mine !== frameLoop) return;
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(onVideoFrame);
      else {
        requestAnimationFrame(() => {
          if (mine !== frameLoop) return;
          if (video.currentTime !== lastTime) { lastTime = video.currentTime; onVideoFrame(); } else schedule();
        });
      }
    };
    schedule();
  }

  async function onOffer(sdp) {
    if (state !== 'starting' || typeof sdp !== 'string') return;
    clearTimer(watchTimer);
    const mine = session;
    try {
      pc = new PeerConnection({ iceServers: [] });
      const conn = pc;
      conn.onicecandidate = (ev) => {
        if (mine !== session) return;
        const c = ev.candidate;
        send({ t: 'rtc-ice', candidate: c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } : null });
      };
      conn.ontrack = (ev) => {
        if (mine !== session || ev.track.kind !== 'video' || !video) return;
        video.srcObject = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
        const p = video.play?.();
        if (p && p.catch) p.catch((e) => log(`webrtc: video.play: ${e.message}`));
        startFrameLoop();
      };
      conn.onconnectionstatechange = () => {
        if (mine !== session) return;
        if (conn.connectionState === 'failed' || conn.connectionState === 'closed') fail(`peer connection ${conn.connectionState}`);
      };
      await conn.setRemoteDescription({ type: 'offer', sdp });
      if (mine !== session) return;
      remoteSet = true;
      for (const c of pendingIce.splice(0)) await conn.addIceCandidate(c).catch(() => {});
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      if (mine !== session) return;
      send({ t: 'rtc-answer', sdp: conn.localDescription.sdp });
    } catch (e) {
      if (mine === session) fail(`offer failed: ${e.message}`);
    }
  }

  return {
    supported,
    reason: supported ? '' : 'This browser has no WebRTC; using the JPEG stream.',
    get state() { return state; },
    get active() { return state === 'connected'; },

    // Call when the helper says WebRTC is (or is not) available: welcome.webrtc and {t:"webrtc"}.
    setAvailable(available) {
      wantStart = Boolean(available) && supported;
      if (!wantStart) { if (state !== 'idle') fail('helper has no WebRTC', { notify: true }); clearTimer(retryTimer); retryTimer = null; return; }
      if (state === 'idle' && !retryTimer) {
        const wait = retryDelay(lastStartAt, now());
        if (wait <= 0) begin();
        else scheduleRetry();
      }
    },

    // Returns true when the message belonged to WebRTC signalling.
    handleMessage(msg) {
      switch (msg.t) {
        case 'rtc-offer':
          onOffer(msg.sdp);
          return true;
        case 'rtc-ice': {
          if (!pc || !msg.candidate || !msg.candidate.candidate) return true; // null = end of candidates
          if (!remoteSet) pendingIce.push(msg.candidate);
          else pc.addIceCandidate(msg.candidate).catch(() => {});
          return true;
        }
        case 'rtc-state':
          if (msg.state === 'connected') {
            if (state === 'starting') {
              connectedAt = now();
              lastFrameAt = 0;
              setState('connected');
              startWatchdog();
            }
          } else if (msg.state === 'failed' || msg.state === 'closed') {
            if (state !== 'idle') fail(`helper says ${msg.state}`, { notify: false });
          }
          return true;
        default:
          return false;
      }
    },

    // WebSocket dropped: the helper forgets this peer connection.
    connectionLost() {
      teardown();
      lastStartAt = NaN;
      wantStart = false;
    },

    stop() {
      wantStart = false;
      if (state !== 'idle') send({ t: 'rtc-stop' });
      teardown();
    },
  };
}
