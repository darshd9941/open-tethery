'use strict';

// HTTP source client for Photoshop UXP -> helper on port 47823.
// Uses plain fetch() POSTs instead of WebSocket so UXP never hangs on ws://.

const { postSourceState, postSourceFrame, postSourceLog } = require('./helper-api');
const { bytesToBase64, errorText } = require('./format');

class HttpSourceClient {
  constructor(opts) {
    this.fetchImpl = opts.fetchImpl || fetch;
    this.host = opts.host || { app: 'photoshop', appName: 'Photoshop', version: '' };
    this.onViewers = opts.onViewers || (() => {});
    this.onError = opts.onError || (() => {});
    this.sequence = null;
    this.connected = true;
    this.inflight = false;
    this.pending = null;
  }

  log(msg) {
    return postSourceLog(this.fetchImpl, msg);
  }

  setSequence(sequence) {
    this.sequence = sequence;
    postSourceState(this.fetchImpl, { host: this.host, sequence })
      .then((res) => {
        if (res && typeof res.viewers === 'number') this.onViewers(res.viewers);
      })
      .catch((err) => this.onError('Helper state: ' + errorText(err)));
    return true;
  }

  sendFrame(jpeg, meta) {
    const jpegBase64 = typeof jpeg === 'string' ? jpeg : bytesToBase64(jpeg);
    const payload = {
      jpegBase64,
      width: meta.width,
      height: meta.height,
      srcWidth: meta.srcWidth,
      srcHeight: meta.srcHeight,
      host: this.host,
      sequence: this.sequence || undefined,
    };
    if (this.inflight) {
      this.pending = payload;
      return true;
    }
    this._flush(payload);
    return true;
  }

  _flush(payload) {
    this.inflight = true;
    postSourceFrame(this.fetchImpl, payload)
      .then((res) => {
        if (res && typeof res.viewers === 'number') this.onViewers(res.viewers);
      })
      .catch((err) => this.onError('Helper send: ' + errorText(err)))
      .finally(() => {
        this.inflight = false;
        if (this.pending) {
          const next = this.pending;
          this.pending = null;
          this._flush(next);
        }
      });
  }
}

module.exports = { HttpSourceClient };
