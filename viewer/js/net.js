// WebSocket client: hello/welcome, ping, reconnect with backoff. See docs/PROTOCOL.md sections 2, 3, 6.
// No DOM access at import time (so the backoff maths can be unit tested).

export function backoffMs(attempt) {
  return Math.min(8000, Math.round(500 * Math.pow(1.7, Math.max(0, attempt))));
}

export function wsUrl(loc = globalThis.location) {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

// handlers: onStatus(status, info), onWelcome(msg), onMessage(msg), onBinary(arrayBuffer),
//           onPong(rttMs), onFatal(code, info)
// status: 'connecting' | 'open' | 'reconnecting' | 'closed'
export function createConnection({ code, name, url = wsUrl(), accept = ['jpeg', 'pcm'], handlers = {}, pingMs = 2000 }) {
  let ws = null;
  let stopped = false;
  let attempts = 0;
  let retryTimer = null;
  let pingTimer = null;
  let welcomed = false;

  const h = (fn, ...a) => { try { handlers[fn]?.(...a); } catch (e) { console.error(fn, e); } };

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function clearTimers() {
    clearInterval(pingTimer); pingTimer = null;
    clearTimeout(retryTimer); retryTimer = null;
  }

  function connect() {
    if (stopped) return;
    h('onStatus', attempts ? 'reconnecting' : 'connecting', { attempt: attempts });
    let sock;
    try { sock = new WebSocket(url); } catch { schedule(); return; }
    sock.binaryType = 'arraybuffer';
    ws = sock;
    welcomed = false;

    sock.onopen = () => {
      send({ t: 'hello', role: 'viewer', code, name, protocol: 1, accept });
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { h('onBinary', ev.data); return; }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'welcome') {
        welcomed = true;
        attempts = 0;
        clearInterval(pingTimer);
        pingTimer = setInterval(() => send({ t: 'ping', ts: Date.now() }), pingMs);
        send({ t: 'ping', ts: Date.now() });
        h('onStatus', 'open', {});
        h('onWelcome', msg);
      } else if (msg.t === 'error' && (msg.code === 'bad-code' || msg.code === 'locked')) {
        stopped = true;
        clearTimers();
        h('onFatal', msg.code, msg);
      } else if (msg.t === 'pong') {
        if (Number.isFinite(msg.ts)) h('onPong', Math.max(0, Date.now() - msg.ts));
      } else {
        h('onMessage', msg);
      }
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      clearInterval(pingTimer); pingTimer = null;
      if (stopped) return;
      attempts++;
      schedule();
    };
    sock.onerror = () => { /* onclose follows */ };
  }

  function schedule() {
    if (stopped) return;
    const wait = backoffMs(attempts - 1);
    h('onStatus', 'reconnecting', { attempt: attempts, inMs: wait });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, wait);
  }

  // Phone woke up or came back to the tab: do not wait out the backoff.
  function nudge() {
    if (stopped || ws) return;
    clearTimeout(retryTimer);
    connect();
  }

  return {
    start() { stopped = false; connect(); },
    stop() {
      stopped = true;
      clearTimers();
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
      h('onStatus', 'closed', {});
    },
    send,
    nudge,
    get welcomed() { return welcomed; },
  };
}
