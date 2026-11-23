'use strict';

// A werift "phone" for tests: answers the helper's rtc-offer over an existing viewer WebSocket client
// (tools/wsclient.js) and counts the RTP it receives. No browser needed.

const { loadWerift } = require('../lib/webrtc');

// client: result of connectViewer({... accept: ['jpeg','pcm','webrtc']}). Returns null without werift.
function attachRtcPhone(client, { hostAddresses = ['127.0.0.1'] } = {}) {
  const werift = loadWerift();
  if (!werift) return null;
  const { RTCPeerConnection, RTCRtpCodecParameters } = werift;
  const pc = new RTCPeerConnection({
    iceServers: [],
    iceAdditionalHostAddresses: hostAddresses,
    codecs: {
      audio: [],
      video: [new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }], parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' })],
    },
  });
  const phone = { pc, rtpPackets: 0, frames: 0, payloads: [], lastRtpAt: 0 };
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      phone.rtpPackets += 1;
      phone.lastRtpAt = Date.now();
      if (rtp.header.marker) phone.frames += 1;
      if (phone.payloads.length < 4000) phone.payloads.push(rtp.payload);
    });
  });
  pc.addTransceiver('video', { direction: 'recvonly' });
  for (const t of pc.iceTransports) t.connection.stunServer = undefined; // werift would query Google STUN
  pc.onIceCandidate.subscribe((c) => {
    if (c) client.send({ t: 'rtc-ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } });
  });
  client.ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString('utf8'));
    if (msg.t === 'rtc-offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      client.send({ t: 'rtc-answer', sdp: pc.localDescription.sdp });
    } else if (msg.t === 'rtc-ice' && msg.candidate) {
      await pc.addIceCandidate(msg.candidate).catch(() => {});
    }
  });
  phone.close = () => pc.close().catch(() => {});
  return phone;
}

module.exports = { attachRtcPhone };
