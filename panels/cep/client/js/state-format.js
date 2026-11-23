// Pure formatting helpers. Loads in CEP (window.OT.format) and in Node tests.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.format = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var APP_NAMES = { premiere: 'Premiere Pro', aftereffects: 'After Effects', photoshop: 'Photoshop' };

  function fpsValue(seq) {
    if (!seq) return null;
    if (seq.fpsNum && seq.fpsDen) return seq.fpsNum / seq.fpsDen;
    return typeof seq.fps === 'number' ? seq.fps : null;
  }

  // 23.976, 24, 29.97, 59.94 (up to 3 decimals, trailing zeros trimmed)
  function formatFps(seq) {
    var f = fpsValue(seq);
    if (f === null || !isFinite(f) || f <= 0) return '';
    return String(parseFloat(f.toFixed(3)));
  }

  function formatResolution(seq) {
    if (!seq || !seq.width || !seq.height) return '';
    return seq.width + 'x' + seq.height;
  }

  // "3840x2160 @ 23.976"
  function formatSequenceLine(seq) {
    var res = formatResolution(seq);
    var fps = formatFps(seq);
    if (res && fps) return res + ' @ ' + fps;
    return res || (fps ? fps + ' fps' : '');
  }

  function statusLabel(state) {
    return state && state.status === 'live' ? 'LIVE' : 'IDLE';
  }

  function hostLabel(state) {
    var h = state && state.host;
    if (!h) return '';
    var name = h.appName || APP_NAMES[h.app] || h.app || '';
    return h.version ? name + ' ' + h.version : name;
  }

  // Exact clicks for turning the Transmit engine on.
  function engineHint(app) {
    if (app === 'aftereffects') {
      return 'Edit > Preferences > Video Preview, choose Open Tethery as the output device';
    }
    return 'Edit > Preferences > Playback, tick Open Tethery under Video Device';
  }

  // Returns null when fine, else {title, body, steps}.
  function engineWarning(state) {
    if (!state || !state.engine || state.engine.transmit !== false) return null;
    var app = state.host && state.host.app === 'aftereffects' ? 'aftereffects' : 'premiere';
    var appName = app === 'aftereffects' ? 'After Effects' : 'Premiere Pro';
    return {
      title: 'Open Tethery is switched off in ' + appName,
      body: 'Phones cannot see your picture until you turn it on.',
      steps: engineHint(app)
    };
  }

  function formatStats(stats) {
    if (!stats) return '';
    var parts = [];
    if (typeof stats.fps === 'number') parts.push(parseFloat(stats.fps.toFixed(1)) + ' fps');
    if (typeof stats.kbps === 'number') parts.push(Math.round(stats.kbps) + ' kbps');
    return parts.join(' · ');
  }

  function formatDelay(ms) {
    return typeof ms === 'number' && isFinite(ms) ? Math.round(ms) + ' ms' : '–';
  }

  // Normalise viewerList entries for display.
  function phoneRows(state) {
    var list = (state && state.viewerList) || [];
    return list.map(function (v) {
      return {
        id: v.id,
        name: v.name || 'Phone',
        ip: v.ip || '',
        delay: formatDelay(v.delayMs)
      };
    });
  }

  function isValidCode(code) {
    return typeof code === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code);
  }

  return {
    formatFps: formatFps, formatResolution: formatResolution, formatSequenceLine: formatSequenceLine,
    statusLabel: statusLabel, hostLabel: hostLabel, engineHint: engineHint, engineWarning: engineWarning,
    formatStats: formatStats, formatDelay: formatDelay, phoneRows: phoneRows, isValidCode: isValidCode
  };
});
