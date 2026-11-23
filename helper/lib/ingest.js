'use strict';

// OTX1 TCP listener (loopback only). One plugin connection at a time; a newer
// connection replaces the older one.

const net = require('net');
const { FrameParser, parseFramePayload, TYPE_FRAME_JPEG, TYPE_STATE, TYPE_HEARTBEAT } = require('./otx1');

const IDLE_TIMEOUT_MS = 15000; // plugin heartbeats every 1 s

// Callbacks: onFrame(frame), onState(obj), onHeartbeat(), onConnection(connected)
function startIngest({ port, host = '127.0.0.1', onFrame, onState, onHeartbeat, onConnection, log = () => {}, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
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
    server.once('error', () => resolve({ ok: false, port: 0, close() {} }));
    server.listen(port, host, () => {
      const actual = server.address().port;
      log(`transmit: listening on ${host}:${actual}`);
      resolve({
        ok: true,
        port: actual,
        close() {
          if (current) current.destroy();
          server.close();
        },
      });
    });
  });
}

module.exports = { startIngest };
