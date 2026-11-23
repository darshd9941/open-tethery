'use strict';

// Helper client for role "source" (docs/PROTOCOL.md sections 3 and 9).
// The WebSocket class is injected so it can be tested with a fake server.

const { packFrame } = require('./otv1');

const OPEN = 1;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

class SourceClient {
  // opts: { url, WebSocketImpl, host, name, reconnectMs,
  //         maxBuffered, onStatus(s), onState(state), onError(msg),
  //         setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn }
  constructor(opts) {
    this.url = opts.url;
    this.WS = opts.WebSocketImpl;
    this.host = opts.host;
    this.name = opts.name || 'Open Tethery (Photoshop)';
    this.reconnectMs = opts.reconnectMs === undefined ? 2000 : opts.reconnectMs;
    this.maxBuffered = opts.maxBuffered || 8 * 1024 * 1024;
    this.onStatus = opts.onStatus || (() => {});
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.setTimeoutFn = opts.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;

    this.ws = null;
    this.status = 'disconnected'; // disconnected | connecting | connected
    this.running = false;
    this.sequence = null;
    this.lastFrame = null;
    this.seq = 0;
    this.reconnectTimer = null;
  }

  get connected() {
    return this.status === 'connected';
  }

  start() {
    this.running = true;
    this._open();
  }

  stop() {
    this.running = false;
    this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this._setStatus('disconnected');
  }

  // sequence: { name, width, height, aspect }. Sent now if connected, and again
  // after every reconnect.
  setSequence(sequence) {
    this.sequence = sequence;
    return this._sendSourceState();
  }

  // Returns false when the frame was not sent (not connected / slow socket).
  sendFrame(jpeg, meta) {
    if (jpeg.length + 32 > MAX_FRAME_BYTES) return false;
    this.lastFrame = { jpeg, meta };
    return this._sendLast();
  }

  _sendLast() {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== OPEN || !this.lastFrame) return false;
    if (ws.bufferedAmount > this.maxBuffered) return false;
    const { jpeg, meta } = this.lastFrame;
    const bytes = packFrame({
      jpeg,
      seq: ++this.seq,
      width: meta.width,
      height: meta.height,
      srcWidth: meta.srcWidth,
      srcHeight: meta.srcHeight,
    });
    try {
      ws.send(bytes.buffer);
    } catch (error) {
      this.onError(String(error && error.message || error));
      return false;
    }
    return true;
  }

  _sendSourceState() {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== OPEN || !this.sequence) return false;
    try {
      ws.send(JSON.stringify({ t: 'source-state', host: this.host, sequence: this.sequence }));
    } catch (error) {
      this.onError(String(error && error.message || error));
      return false;
    }
    return true;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus(status);
  }

  _open() {
    if (!this.running || this.ws) return;
    this._setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (error) {
      this._lost();
      return;
    }
    try {
      ws.binaryType = 'arraybuffer';
    } catch {
      /* optional */
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ t: 'hello', role: 'source', protocol: 1, name: this.name }));
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'welcome') {
        this._setStatus('connected');
        this._sendSourceState();
        this._sendLast(); // the viewer gets the current picture straight away
      } else if (msg.t === 'state') {
        this.onState(msg);
      } else if (msg.t === 'error') {
        this.onError(msg.code || 'helper error');
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._lost();
    };
  }

  _lost() {
    this._setStatus('disconnected');
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this._open();
    }, this.reconnectMs);
  }
}

module.exports = { SourceClient };
