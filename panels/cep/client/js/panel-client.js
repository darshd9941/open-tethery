// WebSocket client for the helper, role "panel" (docs/PROTOCOL.md section 8).
// Everything environment-specific is injected so Node tests can use a fake server:
//   WebSocketImpl, fetchImpl, runControl(msg) -> Promise<{ok,code?,message?}>,
//   pollState() -> Promise<{host,sequence,playing,time}|null>, ensureHelper(attempt) -> Promise.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.panelClient = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function create(opts) {
    var WS = opts.WebSocketImpl;
    var fetchImpl = opts.fetchImpl;
    var wsUrl = opts.wsUrl || 'ws://127.0.0.1:47825/ws';
    var healthUrl = opts.healthUrl || 'http://127.0.0.1:47825/health';
    var pollMs = opts.pollMs || 500;
    var minDelay = opts.minRetryMs || 500;
    var maxDelay = opts.maxRetryMs || 5000;
    var T = opts.timers || {
      setTimeout: function (f, ms) { return setTimeout(f, ms); },
      clearTimeout: function (h) { clearTimeout(h); },
      setInterval: function (f, ms) { return setInterval(f, ms); },
      clearInterval: function (h) { clearInterval(h); }
    };
    function noop() {}
    var onState = opts.onState || noop;
    var onStats = opts.onStats || noop;
    var onStatus = opts.onStatus || noop;
    var onError = opts.onError || noop;

    var ws = null;
    var running = false;
    var welcomed = false;
    var status = '';
    var retryHandle = null;
    var pollHandle = null;
    var polling = false;
    var attemptNo = 0;
    var delay = minDelay;
    var lastSent = '';
    var allowControl = null;
    var lastState = null;

    function setStatus(s) {
      if (s === status) return;
      status = s;
      onStatus(s);
    }

    function send(obj) {
      if (!ws || ws.readyState !== 1) return false;
      ws.send(JSON.stringify(obj));
      return true;
    }

    function scheduleRetry() {
      if (!running || retryHandle) return;
      var d = delay;
      delay = Math.min(maxDelay, delay * 2);
      retryHandle = T.setTimeout(function () { retryHandle = null; attempt(); }, d);
    }

    function healthOk() {
      return Promise.resolve()
        .then(function () { return fetchImpl(healthUrl); })
        .then(function (res) { return res && res.ok ? res.json() : null; })
        .then(function (j) { return !!(j && j.ok && j.name === 'open-tethery'); })
        .catch(function () { return false; });
    }

    function attempt() {
      if (!running || ws) return;
      attemptNo++;
      var n = attemptNo;
      healthOk().then(function (ok) {
        if (!running || ws) return;
        if (!ok) {
          setStatus('helper-down');
          var p = opts.ensureHelper ? Promise.resolve().then(function () { return opts.ensureHelper(n); }) : Promise.resolve();
          p.catch(function (e) { onError(e); }).then(scheduleRetry);
          return;
        }
        openSocket();
      });
    }

    function openSocket() {
      setStatus('connecting');
      var sock;
      try { sock = new WS(wsUrl); } catch (e) { onError(e); scheduleRetry(); return; }
      ws = sock;
      sock.onopen = function () {
        send({ t: 'hello', role: 'panel', protocol: 1, name: opts.name || 'Open Tethery panel' });
      };
      sock.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
        handle(msg);
      };
      sock.onerror = function () { /* close follows */ };
      sock.onclose = function () {
        if (ws !== sock) return;
        ws = null;
        welcomed = false;
        stopPolling();
        setStatus('helper-down');
        scheduleRetry();
      };
    }

    function handle(msg) {
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'welcome') {
        welcomed = true;
        delay = minDelay;
        lastSent = '';
        setStatus('connected');
        startPolling();
      } else if (msg.t === 'state') {
        lastState = msg;
        onState(msg);
      } else if (msg.t === 'stats') {
        onStats(msg);
      } else if (msg.t === 'control') {
        runControl(msg);
      } else if (msg.t === 'error') {
        onError(msg);
      }
    }

    function runControl(msg) {
      Promise.resolve()
        .then(function () { return opts.runControl(msg); })
        .catch(function (e) { return { ok: false, code: 'host-error', message: String(e) }; })
        .then(function (r) {
          var out = { t: 'control-result', req: msg.req, ok: !!(r && r.ok) };
          if (r && !r.ok) {
            if (r.code) out.code = r.code;
            if (r.message) out.message = r.message;
          }
          send(out);
        });
    }

    function pollOnce() {
      if (polling || !welcomed || !opts.pollState) return Promise.resolve();
      polling = true;
      return Promise.resolve()
        .then(function () { return opts.pollState(); })
        .then(function (hs) { if (hs) pushHostState(hs); })
        .catch(function (e) { onError(e); })
        .then(function () { polling = false; });
    }

    function startPolling() {
      stopPolling();
      pollOnce();
      pollHandle = T.setInterval(pollOnce, pollMs);
    }

    function stopPolling() {
      if (pollHandle !== null) { T.clearInterval(pollHandle); pollHandle = null; }
    }

    // Sends only when something changed since the last send.
    function pushHostState(hs) {
      var body = { t: 'host-state', host: hs.host, sequence: hs.sequence, playing: !!hs.playing, time: hs.time };
      var key = JSON.stringify(body);
      if (key === lastSent) return false;
      if (send(body)) { lastSent = key; return true; }
      return false;
    }

    return {
      start: function () { if (running) return; running = true; delay = minDelay; attempt(); },
      stop: function () {
        running = false;
        if (retryHandle) { T.clearTimeout(retryHandle); retryHandle = null; }
        stopPolling();
        if (ws) { var s = ws; ws = null; try { s.close(); } catch (e) {} }
        welcomed = false;
      },
      retryNow: function () {
        if (retryHandle) { T.clearTimeout(retryHandle); retryHandle = null; }
        delay = minDelay;
        attempt();
      },
      pushHostState: pushHostState,
      setAllowControl: function (v) {
        allowControl = !!v;
        if (welcomed) send({ t: 'panel-settings', allowControl: allowControl });
      },
      // ip string, or null for automatic (helper ignores addresses it does not have)
      setConnection: function (ip) { return send({ t: 'panel-settings', connection: ip }); },
      getState: function () { return send({ t: 'get-state' }); },
      newSession: function () { return send({ t: 'new-session' }); },
      kick: function (id) { return send({ t: 'kick', id: id }); },
      getStatus: function () { return status; },
      getLastState: function () { return lastState; }
    };
  }

  return { create: create };
});
