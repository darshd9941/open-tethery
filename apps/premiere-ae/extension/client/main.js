'use strict';

// Live Video Preview - CEP Panel Controller for Premiere Pro & After Effects

(() => {
  const cs = new CSInterface();
  const fs = (typeof window.require === 'function') ? window.require('fs') : (typeof require === 'function' ? require('fs') : null);
  const path = (typeof window.require === 'function') ? window.require('path') : (typeof require === 'function' ? require('path') : null);
  const os = (typeof window.require === 'function') ? window.require('os') : (typeof require === 'function' ? require('os') : null);

  const $ = (id) => document.getElementById(id);

  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const hostBadge = $('hostBadge');
  const toggleBtn = $('toggleBtn');
  const onceBtn = $('onceBtn');
  const qrWrap = $('qrWrap');
  const qrCode = $('qrCode');
  const pairUrlEl = $('pairUrl');
  const openBrowserBtn = $('openBrowserBtn');
  const profileSelect = $('profileSelect');
  const portInput = $('portInput');
  const debounceInput = $('debounceInput');
  const debounceVal = $('debounceVal');

  let running = false;
  let ws = null;
  let token = null;
  let pairUrl = '';
  let hostName = 'Video Host';
  let pollTimer = null;
  let debounceTimer = null;
  let lastSignature = null;
  let pendingSignature = null;
  let isCapturing = false;

  // Temp path for frame exports
  const tempDir = (os && typeof os.tmpdir === 'function') ? os.tmpdir() : 'C:/Users/User/AppData/Local/Temp';
  const tempFramePath = (path && typeof path.join === 'function') ? path.join(tempDir, 'live_preview_frame.tmp') : (tempDir + '/live_preview_frame.tmp');

  function setStatus(text, kind) {
    statusText.textContent = text;
    statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  }

  function randomToken() {
    let out = '';
    for (let i = 0; i < 16; i++) {
      out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
    }
    return out;
  }

  function readFileAsBase64(filePath) {
    // 1. Native Adobe CEP file API (fastest, guaranteed available)
    if (window.cep && window.cep.fs && window.cep.fs.readFile) {
      try {
        const res = window.cep.fs.readFile(filePath, window.cep.encoding.Base64);
        if (res.err === 0 && res.data) return res.data;
      } catch (e) {}
    }
    // 2. Node.js fs
    if (fs && fs.readFileSync) {
      try {
        const buf = fs.readFileSync(filePath);
        return buf.toString('base64');
      } catch (e) {}
    }
    return null;
  }

  // ------------------------------------------------------------------ Host Init
  try {
    const hostEnv = cs.getHostEnvironment ? cs.getHostEnvironment() : null;
    const appId = hostEnv ? hostEnv.appId : "";
    if (appId === "PPRO") {
      hostName = "Premiere Pro";
    } else if (appId === "AEFT") {
      hostName = "After Effects";
    }
  } catch (e) {}

  if (hostName !== 'Video Host') {
    cs.evalScript(`setHostType("${hostName}")`);
    hostBadge.textContent = hostName.includes('After') ? 'Ae' : 'Pr';
    hostBadge.className = 'badge ' + (hostName.includes('After') ? 'ae' : 'pr');
  } else {
    cs.evalScript('getHostInfo()', (res) => {
      try {
        const info = JSON.parse(res);
        hostName = info.host || 'Video Host';
        hostBadge.textContent = hostName.includes('After') ? 'Ae' : 'Pr';
        hostBadge.className = 'badge ' + (hostName.includes('After') ? 'ae' : 'pr');
      } catch {
        hostBadge.textContent = 'Video';
      }
    });
  }

  debounceInput.addEventListener('input', () => {
    debounceVal.textContent = `${debounceInput.value} ms`;
  });

  pairUrlEl.addEventListener('click', () => {
    if (pairUrl) {
      navigator.clipboard.writeText(pairUrl);
      setStatus('Link copied to clipboard!', 'live');
    }
  });

  openBrowserBtn.addEventListener('click', () => {
    if (pairUrl) cs.openURLInDefaultBrowser(pairUrl);
  });

  // ------------------------------------------------------------------ QR Drawing
  function renderQr(url) {
    qrCode.textContent = '';
    pairUrlEl.textContent = url;

    if (typeof qrcode !== 'function') {
      pairUrlEl.textContent = url + ' (Open URL manually)';
      return;
    }

    let qr;
    try {
      qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
    } catch (e) {
      return;
    }

    const count = qr.getModuleCount();
    const cell = Math.max(3, Math.floor(180 / (count + 6)));
    qrCode.style.padding = (cell * 3) + 'px';

    for (let r = 0; r < count; r++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'qr-row';
      rowEl.style.height = cell + 'px';
      for (let c = 0; c < count; c++) {
        const cellEl = document.createElement('div');
        cellEl.className = qr.isDark(r, c) ? 'qr-cell dark' : 'qr-cell';
        cellEl.style.width = cell + 'px';
        cellEl.style.height = cell + 'px';
        rowEl.appendChild(cellEl);
      }
      qrCode.appendChild(rowEl);
    }
  }

  // ------------------------------------------------------------------ WebSocket
  function connect() {
    if (!running || ws) return;

    const port = parseInt(portInput.value, 10) || 47825;
    setStatus('Connecting to Relay server…', 'warn');

    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    } catch (err) {
      setStatus('Cannot connect to relay: ' + err.message, 'err');
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'register',
        token,
        name: 'Live Video Preview',
        version: '1.0.0',
        host: hostName,
      }));
      setStatus('Registering with Relay…', 'warn');
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'registered') {
        pairUrl = msg.url;
        renderQr(pairUrl);
        qrWrap.classList.remove('hidden');
        setStatus('Live · Ready for playback/scrub', 'live');
        lastSignature = null;
        setTimeout(() => triggerCapture(), 150);
        return;
      }

      if (msg.type === 'error') {
        setStatus(msg.message || 'Relay error', 'err');
      }
    };

    socket.onclose = () => {
      ws = null;
      if (!running) return;
      setStatus('Relay disconnected. Retrying…', 'err');
      scheduleReconnect();
    };

    socket.onerror = () => {};
  }

  let reconnectTimer = null;
  function scheduleReconnect() {
    if (!running || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  // ------------------------------------------------------------------ Polling & Capture
  function tick() {
    if (!running || isCapturing) return;

    cs.evalScript('getTimelineSignature()', (sig) => {
      if (!sig || sig.startsWith('err') || sig === 'no-seq' || sig === 'no-comp' || sig === 'none') {
        if (sig === 'no-seq' || sig === 'no-comp') {
          setStatus('Open a sequence or composition', 'warn');
        }
        return;
      }

      if (sig !== lastSignature) {
        if (sig === pendingSignature) return;
        pendingSignature = sig;
        clearTimeout(debounceTimer);
        const delay = parseInt(debounceInput.value, 10) || 350;
        debounceTimer = setTimeout(() => {
          pendingSignature = null;
          triggerCapture();
        }, delay);
      }
    });
  }

  function triggerCapture(isManual) {
    if (!running || isCapturing) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (isManual) setStatus('Not connected to relay', 'warn');
      return;
    }

    isCapturing = true;
    const safePath = tempFramePath.replace(/\\/g, '/');

    cs.evalScript(`captureActiveFrame("${safePath}")`, (res) => {
      try {
        let result = null;
        try {
          result = JSON.parse(res);
        } catch (jsonErr) {
          isCapturing = false;
          setStatus('Invalid response: ' + res, 'err');
          return;
        }

        if (!result.success) {
          isCapturing = false;
          if (result.error) setStatus(result.error, 'warn');
          return;
        }

        // Read exported file as Base64
        const base64 = readFileAsBase64(result.path);
        if (!base64) {
          isCapturing = false;
          setStatus('Failed to read frame at: ' + result.path, 'err');
          return;
        }

        const payload = JSON.stringify({
          type: 'frame',
          data: base64,
          meta: {
            name: result.name || 'Untitled',
            timecode: result.timecode || '00:00:00:00',
            width: result.width || 0,
            height: result.height || 0,
            fps: result.fps || 0,
            host: result.host || hostName,
            profile: profileSelect.value,
            mime: result.mime || 'image/jpeg',
          }
        });

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
          const kb = Math.round((base64.length * 3 / 4) / 1024);
          setStatus(`Live · ${result.name} · ${result.timecode} (${kb} KB)`, 'live');
          lastSignature = result.timecode;
        }
      } catch (err) {
        setStatus('Capture error: ' + err.message, 'err');
      } finally {
        isCapturing = false;
      }
    });
  }

  // ------------------------------------------------------------------ Start / Stop
  function start() {
    running = true;
    token = randomToken();
    toggleBtn.textContent = 'Stop Preview';
    toggleBtn.className = 'btn btn-primary stop';
    setStatus('Starting relay session…', 'warn');
    connect();

    clearInterval(pollTimer);
    pollTimer = setInterval(tick, 250);
  }

  function stop() {
    running = false;
    clearInterval(pollTimer);
    pollTimer = null;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    if (ws) {
      try {
        ws.send(JSON.stringify({ type: 'stop' }));
        ws.close();
      } catch {}
      ws = null;
    }

    qrWrap.classList.add('hidden');
    toggleBtn.textContent = 'Start Preview';
    toggleBtn.className = 'btn btn-primary';
    setStatus('Stopped', '');
  }

  toggleBtn.addEventListener('click', () => {
    if (running) stop();
    else start();
  });

  onceBtn.addEventListener('click', () => {
    if (!running) {
      setStatus('Click Start Preview first', 'warn');
      return;
    }
    triggerCapture(true);
  });
})();
