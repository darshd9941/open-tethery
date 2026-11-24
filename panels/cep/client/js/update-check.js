// Update check (pure logic). Loads in CEP (window.OT.updateCheck) and in Node tests.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.updateCheck = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var KEY = 'ot.update';
  var DAY = 24 * 60 * 60 * 1000;

  // "v1.2.3-beta" -> [1,2,3] or null
  function parse(v) {
    var m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v == null ? '' : v).trim());
    return m ? [+m[1], +(m[2] || 0), +(m[3] || 0)] : null;
  }

  // 1 if a > b, -1 if a < b, 0 if equal or unparseable.
  function compare(a, b) {
    var x = parse(a), y = parse(b);
    if (!x || !y) return 0;
    for (var i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }

  function load(st) {
    try { return JSON.parse(st.getItem(KEY)) || {}; } catch (e) { return {}; }
  }
  function save(st, rec) { try { st.setItem(KEY, JSON.stringify(rec)); } catch (e) {} }

  function shouldCheck(rec, now) {
    return !rec.checkedAt || now - rec.checkedAt >= DAY || now < rec.checkedAt;
  }

  // Banner info for a record, or null (nothing newer, or that version was dismissed).
  function banner(rec, current) {
    if (!rec || !rec.latest || compare(rec.latest, current) <= 0) return null;
    if (rec.dismissed && compare(rec.dismissed, rec.latest) >= 0) return null;
    return { version: rec.latest.replace(/^v/, ''), url: rec.url || '' };
  }

  // opts: {storage, fetchImpl(url)->Promise<Response>, updateUrl, current, now}
  // Resolves to banner info or null. Never rejects.
  function check(opts) {
    var now = opts.now || Date.now();
    var rec = load(opts.storage);
    if (!opts.updateUrl || !shouldCheck(rec, now)) return Promise.resolve(banner(rec, opts.current));
    return Promise.resolve().then(function () { return opts.fetchImpl(opts.updateUrl); })
      .then(function (r) { if (!r || !r.ok) throw new Error('http'); return r.json(); })
      .then(function (j) {
        var tag = j && j.tag_name;
        if (!parse(tag)) throw new Error('no tag');
        rec.checkedAt = now;
        rec.latest = String(tag).replace(/^v/, '');
        rec.url = (j.html_url && /^https:\/\//.test(j.html_url)) ? j.html_url : '';
        save(opts.storage, rec);
        return banner(rec, opts.current);
      })
      .catch(function () { return banner(rec, opts.current); });
  }

  function dismiss(storage, version) {
    var rec = load(storage);
    rec.dismissed = String(version);
    save(storage, rec);
  }

  return { parse: parse, compare: compare, shouldCheck: shouldCheck, banner: banner, check: check, dismiss: dismiss, KEY: KEY, DAY: DAY };
});
