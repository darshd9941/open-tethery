// Panel wiring: DOM, CEP APIs, helper launch. Logic lives in the other modules.
(function () {
  'use strict';
  var OT = window.OT;
  var F = OT.format;
  var $ = function (id) { return document.getElementById(id); };

  function loadConfig() {
    if (window.__OT_CONFIG) return window.__OT_CONFIG;
    var cfg = { helperHost: '127.0.0.1:47825', devHelperPath: '' };
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'config.json', false);
      xhr.send();
      var parsed = JSON.parse(xhr.responseText);
      for (var k in parsed) cfg[k] = parsed[k];
    } catch (e) { /* defaults */ }
    return cfg;
  }

  var config = loadConfig();
  var httpBase = 'http://' + config.helperHost;

  // ---- CEP / Node access (both are optional so the page also runs in a plain browser)
  var cs = (typeof window.CSInterface === 'function') ? new window.CSInterface() : null;
  function nodeRequire(name) {
    try {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    } catch (e) {}
    return null;
  }
  var cp = nodeRequire('child_process');
  var nodeFs = nodeRequire('fs');

  var bridge = OT.controlBridge.create({
    evalScript: function (script, cb) {
      if (!cs) { cb('EvalScript error.'); return; }
      cs.evalScript(script, cb);
    }
  });

  var launchNote = '';
  function startHelper() {
    if (!cp || !nodeFs) {
      launchNote = 'This panel cannot start programs (Node is off). Start Open Tethery from the Start menu.';
      renderHelper();
      return false;
    }
    var res = OT.helperLauncher.start({
      fs: nodeFs, spawn: cp.spawn, env: (typeof process !== 'undefined' ? process.env : {}), nodeCommand: 'node'
    }, config);
    launchNote = res.ok ? '' : res.reason;
    renderHelper();
    return res.ok;
  }

  var client = OT.panelClient.create({
    WebSocketImpl: window.WebSocket,
    fetchImpl: function (u) { return window.fetch(u); },
    wsUrl: 'ws://' + config.helperHost + '/ws',
    healthUrl: httpBase + '/health',
    runControl: bridge.run,
    pollState: bridge.pollState,
    // Try to launch the helper on the first miss, then again every 6th retry.
    ensureHelper: function (n) { if (n === 1 || n % 6 === 0) startHelper(); },
    onState: function (s) { state = s; render(); },
    onStats: function (s) { $('stats').textContent = F.formatStats(s) || ' '; },
    onStatus: function (s) { status = s; renderHelper(); if (s !== 'connected') render(); }
  });

  var allow = $('allowControl');
  var state = null;
  var status = 'connecting';
  var shownCode = '';

  // ---- rendering
  function renderHelper() {
    var down = status === 'helper-down';
    $('helperCard').hidden = !down;
    $('pairing').hidden = down;
    if (down) {
      $('helperText').textContent = launchNote ||
        'Open Tethery needs its small helper program to talk to phones. Click Start, or wait a moment: the panel keeps trying.';
    }
  }

  function setPill(live) {
    var p = $('pill');
    p.textContent = live ? 'LIVE' : 'IDLE';
    p.className = 'pill ' + (live ? 'live' : 'idle');
  }

  function render() {
    var s = status === 'connected' ? state : null;
    setPill(F.statusLabel(s) === 'LIVE');

    var warn = F.engineWarning(s);
    $('engineCard').hidden = !warn;
    if (warn) {
      $('engineTitle').textContent = warn.title;
      $('engineBody').textContent = warn.body;
      $('engineSteps').textContent = warn.steps;
    }

    if (s && s.code && s.code !== shownCode) {
      shownCode = s.code;
      $('qr').src = httpBase + '/api/qr.svg?v=' + encodeURIComponent(s.code);
    }
    if (s && typeof s.allowControl === 'boolean') allow.checked = s.allowControl;
    $('code').textContent = (s && s.code) || '----';
    var url = (s && s.primaryUrl) || '';
    $('url').textContent = url.replace(/^https?:\/\//, '');
    $('url').title = url;

    var seq = s && s.sequence;
    $('seqName').textContent = (seq && seq.name) || 'No sequence';
    $('seqInfo').textContent = F.formatSequenceLine(seq);
    $('hostApp').textContent = F.hostLabel(s);

    var rows = F.phoneRows(s);
    $('phoneCount').textContent = String(s && typeof s.viewers === 'number' ? s.viewers : rows.length);
    var ul = $('phoneList');
    ul.textContent = '';
    if (!rows.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No phones yet. Scan the QR code.';
      ul.appendChild(empty);
    }
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var who = document.createElement('span');
      who.className = 'who';
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;
      var ip = document.createElement('span');
      ip.className = 'ip';
      ip.textContent = r.ip;
      who.appendChild(name);
      who.appendChild(ip);
      var delay = document.createElement('span');
      delay.className = 'delay';
      delay.textContent = r.delay;
      var kick = document.createElement('button');
      kick.className = 'btn small danger';
      kick.textContent = 'Kick';
      kick.addEventListener('click', function () { client.kick(r.id); });
      li.appendChild(who);
      li.appendChild(delay);
      li.appendChild(kick);
      ul.appendChild(li);
    });
  }

  // ---- buttons
  function copyText(text) {
    if (!text) return;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  $('copyBtn').addEventListener('click', function () {
    copyText($('url').title);
    var b = $('copyBtn');
    b.textContent = 'Copied';
    setTimeout(function () { b.textContent = 'Copy'; }, 1200);
  });
  $('newCodeBtn').addEventListener('click', function () { client.newSession(); });
  $('startHelperBtn').addEventListener('click', function () { startHelper(); client.retryNow(); });
  $('recheckBtn').addEventListener('click', function () { client.getState(); });

  allow.addEventListener('change', function () {
    client.setAllowControl(allow.checked);
  });

  renderHelper();
  render();
  client.start();
  window.__otClient = client;
})();
