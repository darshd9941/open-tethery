// WebRTC transport (PROTOCOL section 7). Not implemented yet: the viewer does not list "webrtc"
// in hello.accept, so the helper keeps sending binary JPEG/PCM. When this is built, create the
// RTCPeerConnection here, answer rtc-offer, and call onVideoTrack/onAudioTrack.
export const supported = false;

export function createWebRtcTransport() {
  return {
    supported: false,
    reason: 'WebRTC streaming is not available in this version.',
    start() { return false; },
    handleMessage() { return false; },
    stop() {},
  };
}
