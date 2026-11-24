'use strict';

// OTX1 TCP listener (loopback only). One plugin connection at a time; a newer
// connection replaces the older one.

const net = require('net');
const otx1 = require('./otx1');

const { FrameParser, parseFramePayload, TYPE_FRAME_JPEG, TYPE_STATE, TYPE_HEARTBEAT, TYPE_H264, TYPE_AUDIO } = otx1;

const IDLE_TIMEOUT_MS = 15000; // plugin heartbeats every 1 s

// Callbacks: onFrame(frame), onH264(au), onAudio(chunk), onState(obj), onHeartbeat(), onConnection(connected)
// The result has send(buffer) for helper -> plugin messages (otx1.requestKeyframeMessage etc.).
function startIngest({ port, host = '127.0.0.1', onFrame, onH264, onAudio, onState, onHeartbeat, onConnection, log = () => {}, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
  let current = null;

  const server = net.createServer((socket) => {
    if (current) {
      log('transmit: newer plugin connection replaces the old one');
      const old = current;
      current = null;
      old.replaced = true;
      old.destroy();
    }
    current = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setTimeout(idleTimeoutMs);
    log(`transmit: plugin connected from ${socket.remoteAddress}:${socket.remotePort}`);

    const parser = new FrameParser((msg) => {
      if (current !== socket) return;
      if (msg.type === TYPE_FRAME_JPEG) {
        const frame = parseFramePayload(msg.payload);
        if (!frame) return log('transmit: dropped malformed frame message');
        onFrame && onFrame(frame);
      } else if (msg.type === TYPE_H264) {
        const au = otx1.parseH264Payload(msg.payload);
        if (!au) return log('transmit: dropped malformed H.264 message');
        onH264 && onH264(au);
      } else if (msg.type === TYPE_AUDIO) {
        const chunk = otx1.parseAudioPayload(msg.payload);
        if (!chunk) return log('transmit: dropped malformed audio message');
        onAudio && onAudio(chunk);
      } else if (msg.type === TYPE_STATE) {
        try {
          const parsed = JSON.parse(msg.payload.toString('utf8'));
          if (parsed && typeof parsed === 'object') onState && onState(parsed);
        } catch {
          log('transmit: ignored invalid state JSON');
        }
      } else if (msg.type === TYPE_HEARTBEAT) onHeartbeat && onHeartbeat();
      // unknown types are ignored (any message resets the socket idle timer)
    });

    socket.on('data', (chunk) => {
      try {
        parser.push(chunk);
      } catch (err) {
        log(`transmit: protocol error (${err.message}); dropping connection`);
        socket.destroy();
      }
    });
    socket.on('timeout', () => {
      log('transmit: plugin silent too long; dropping connection');
      socket.destroy();
    });
    socket.on('error', (err) => log(`transmit: socket error: ${err.message}`));
    socket.on('close', () => {
      if (socket.replaced || current !== socket) return;
      current = null;
      log('transmit: plugin disconnected');
      onConnection && onConnection(false);
    });
    onConnection && onConnection(true);
  });

  server.on('error', (err) => log(`transmit: listener error on ${host}:${port}: ${err.message}`));

  return new Promise((resolve) => {
    server.once('error', () => resolve({ ok: false, port: 0, send: () => false, close() {} }));
    server.listen(port, host, () => {
      const actual = server.address().port;
      log(`transmit: listening on ${host}:${actual}`);
      resolve({
        ok: true,
        port: actual,
        // helper -> plugin; false when no plugin is connected
        send(buf) {
          if (!current || current.destroyed) return false;
          current.write(buf);
          return true;
        },
        close() {
          if (current) current.destroy();
          server.close();
        },
      });
    });
  });
}

module.exports = { startIngest };
