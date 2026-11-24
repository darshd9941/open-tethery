// First-run guide state machine (pure). Loads in CEP (window.OT.onboarding) and in Node tests.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.onboarding = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var KEY = 'ot.guide.seen';
  var COUNT = 3;

  function steps(app, product) {
    var ae = app === 'aftereffects';
    return [
      {
        title: 'Turn on the engine',
        lines: ae
          ? ['In After Effects: Edit > Preferences > Video Preview.', 'Under Output Device, choose ' + product + '.']
          : ['In Premiere Pro: Edit > Preferences > Playback.',
             'Under Video Device, tick ' + product + '.',
             'For sound: leave Audio Device on your speakers, and tick ' + product + ' for audio if it is listed.'],
        tick: 'Engine is on'
      },
      {
        title: 'Scan the QR with your phone',
        lines: ['Join the same Wi-Fi as this computer, then point the phone camera at the QR code.'],
        tick: 'Phone connected'
      },
      {
        title: 'Tap Overlays and Sound',
        lines: ['On the phone, tap Overlays to add guides and frames. Tap Sound to hear your edit.'],
        tick: null
      }
    ];
  }

  // Which steps are done, from the live panel state.
  function ticks(state) {
    return [
      !!(state && state.engine && state.engine.transmit === true),
      !!(state && typeof state.viewers === 'number' && state.viewers > 0),
      false
    ];
  }

  function safeGet(st) { try { return st.getItem(KEY); } catch (e) { return null; } }
  function safeSet(st, v) { try { st.setItem(KEY, v); } catch (e) {} }

  // storage: anything with getItem/setItem (localStorage). May be null or throw.
  function create(storage) {
    var m = { step: 0, open: !(storage && safeGet(storage) === '1') };
    function finish() { m.open = false; if (storage) safeSet(storage, '1'); }
    m.next = function () { if (m.step < COUNT - 1) m.step++; else finish(); };
    m.back = function () { if (m.step > 0) m.step--; };
    m.skip = finish;
    m.done = finish;
    m.reset = function () { m.step = 0; m.open = true; };
    m.isLast = function () { return m.step === COUNT - 1; };
    return m;
  }

  return { create: create, steps: steps, ticks: ticks, COUNT: COUNT, KEY: KEY };
});
