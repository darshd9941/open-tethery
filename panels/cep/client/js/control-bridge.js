// Maps helper "control" messages to ExtendScript calls (host/host.jsx).
// evalScript(scriptString, cb(resultString)) is injected: CSInterface.evalScript in CEP, a fake in tests.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.controlBridge = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var SIMPLE = { play: 1, pause: 1, toggle: 1 };
  var MAX_STEP = 1000;

  function parseResult(raw) {
    if (typeof raw !== 'string' || raw === '') return { ok: false, code: 'host-error', message: 'Empty reply from host' };
    if (raw === 'EvalScript error.') return { ok: false, code: 'host-error', message: 'ExtendScript error' };
    try {
      var r = JSON.parse(raw);
      return r && typeof r === 'object' ? r : { ok: false, code: 'host-error', message: 'Bad reply' };
    } catch (e) {
      return { ok: false, code: 'host-error', message: 'Bad reply: ' + String(raw).slice(0, 80) };
    }
  }

  // Returns {script} for a control message, or {error:{code,message}}.
  function buildScript(msg) {
    var cmd = msg && msg.cmd;
    var arg = null;
    if (SIMPLE[cmd]) {
      arg = null;
    } else if (cmd === 'seek') {
      if (typeof msg.time !== 'number' || !isFinite(msg.time)) return { error: { code: 'bad-args', message: 'seek needs time' } };
      arg = Math.max(0, msg.time);
    } else if (cmd === 'step') {
      if (typeof msg.frames !== 'number' || !isFinite(msg.frames)) return { error: { code: 'bad-args', message: 'step needs frames' } };
      arg = Math.max(-MAX_STEP, Math.min(MAX_STEP, Math.round(msg.frames)));
    } else if (cmd === 'jump') {
      if (msg.to !== 'start' && msg.to !== 'end') return { error: { code: 'bad-args', message: 'jump needs start or end' } };
      arg = msg.to;
    } else {
      return { error: { code: 'unsupported', message: 'Unknown command ' + cmd } };
    }
    return { script: 'otControl(' + JSON.stringify(cmd) + ',' + JSON.stringify(arg) + ')' };
  }

  function create(opts) {
    var evalScript = opts.evalScript;

    function call(script) {
      return new Promise(function (resolve) {
        try { evalScript(script, function (raw) { resolve(parseResult(raw)); }); }
        catch (e) { resolve({ ok: false, code: 'host-error', message: String(e) }); }
      });
    }

    return {
      // -> {ok, code?, message?}
      run: function (msg) {
        var built = buildScript(msg);
        if (built.error) return Promise.resolve({ ok: false, code: built.error.code, message: built.error.message });
        return call(built.script);
      },
      // -> {host, sequence, playing, time} or null when the host cannot answer
      pollState: function () {
        return call('otGetHostState()').then(function (r) {
          if (!r || r.ok === false) return null;
          return { host: r.host, sequence: r.sequence || null, playing: !!r.playing, time: r.time };
        });
      }
    };
  }

  return { create: create, buildScript: buildScript, parseResult: parseResult };
});
