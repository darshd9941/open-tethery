// Finds and starts the Open Tethery helper from inside CEP (Node enabled).
// Injected deps keep this testable: fs, spawn, env, execPath, platform.
(function (root, factory) {
  var api = factory();
  root.OT = root.OT || {};
  root.OT.helperLauncher = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function join(base, rest, sep) {
    var s = base.charAt(base.length - 1) === sep ? '' : sep;
    return base + s + rest;
  }

  // Candidates in priority order: installer's start-helper.vbs, installed exe, then dev "node <repo>/helper/bin/...".
  function candidates(deps, config) {
    var env = deps.env || {};
    var list = [];
    if (env.LOCALAPPDATA) {
      list.push({ kind: 'vbs', file: join(env.LOCALAPPDATA, 'OpenTethery\\start-helper.vbs', '\\') });
      list.push({ kind: 'exe', file: join(env.LOCALAPPDATA, 'OpenTethery\\OpenTetheryHelper.exe', '\\') });
    }
    if (config && config.devHelperPath) {
      list.push({ kind: 'node', file: config.devHelperPath });
    }
    return list;
  }

  function find(deps, config) {
    var list = candidates(deps, config);
    for (var i = 0; i < list.length; i++) {
      try { if (deps.fs.existsSync(list[i].file)) return list[i]; } catch (e) {}
    }
    return null;
  }

  // Returns {ok:true, via} or {ok:false, reason}. Never throws.
  function start(deps, config) {
    var found = find(deps, config);
    if (!found) {
      return { ok: false, reason: 'Could not find OpenTetheryHelper.exe in %LOCALAPPDATA%\\OpenTethery, and no devHelperPath is set in client/config.json.' };
    }
    try {
      var child;
      var opts = { detached: true, stdio: 'ignore', windowsHide: true, env: deps.env };
      if (found.kind === 'vbs') {
        // Installer's hidden launcher.
        child = deps.spawn('wscript.exe', [found.file], opts);
      } else if (found.kind === 'exe') {
        child = deps.spawn(found.file, [], opts);
      } else {
        // Inside Adobe's CEF, process.execPath is the host app, not node. Use "node" from PATH.
        child = deps.spawn(deps.nodeCommand || 'node', [found.file], opts);
      }
      if (child && typeof child.on === 'function') child.on('error', function () {});
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true, via: found.kind, file: found.file };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  }

  return { candidates: candidates, find: find, start: start };
});
