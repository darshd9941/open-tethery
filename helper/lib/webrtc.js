'use strict';

// WebRTC module placeholder (PROTOCOL.md section 7). v0.2 has no WebRTC media:
// welcome says "webrtc": false and rtc-start is answered with an "unsupported"
// error. A real implementation replaces createRtc() and keeps this interface:
//
//   rtc.available                 boolean; goes into the welcome message
//   rtc.start(viewer)             viewer asked for rtc-start; send rtc-offer via viewer.send(obj)
//   rtc.answer(viewer, sdp)       viewer's rtc-answer
//   rtc.ice(viewer, candidate)    viewer's rtc-ice (candidate may be null)
//   rtc.stop(viewer)              rtc-stop or the viewer disconnected
//   rtc.isConnected(viewer)       true -> hub stops sending binary video/audio to it
//   rtc.pushFrame(frame)          every new JPEG frame (decoded, see otv1.decode) for the encoder
//   rtc.pushAudio(chunk)          every PCM chunk
//   rtc.close()
//
// `viewer` is the hub's viewer record; use viewer.send(obj) for JSON.

function createRtc() {
  return {
    available: false,
    start(viewer) {
      viewer.send({ t: 'error', code: 'unsupported', cmd: 'rtc-start' });
    },
    answer() {},
    ice() {},
    stop() {},
    isConnected() {
      return false;
    },
    pushFrame() {},
    pushAudio() {},
    close() {},
  };
}

module.exports = { createRtc };
