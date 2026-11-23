'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const stage = $('stage');
  const zoom = $('zoom');
  const frameA = $('frameA');
  const frameB = $('frameB');
  const guidesOverlay = $('guidesOverlay');
  const guide916 = $('guide916');
  const guide45 = $('guide45');
  const guide11 = $('guide11');
  const guideSafe = $('guideSafe');
  const hud = $('hud');
  const statusDot = $('statusDot');
  const hostBadge = $('hostBadge');
  const docName = $('docName');
  const tcDisplay = $('tcDisplay');
  const resDisplay = $('resDisplay');
  const guideBtn = $('guideBtn');
  const zoomBtn = $('zoomBtn');
  const empty = $('empty');
  const emptyTitle = $('emptyTitle');
  const emptyText = $('emptyText');
  const toast = $('toast');

  const TOKEN_KEY = 'lvp.token';
  const MAX_SCALE = 10;
  const MIN_SCALE = 0.5;

  function readToken() {
    const match = /(?:^#|&)pair=([A-Za-z0-9_-]{16,128})/.exec(location.hash || '');
    if (match) {
      const token = match[1];
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {}
      history.replaceState(null, '', location.pathname + location.search);
      return token;
    }
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  const token = readToken();

  const state = {
    ws: null,
    connected: false,
    authed: false,
    hasFrame: false,
    ended: false,
    attempts: 0,
    reconnectTimer: null,
    pingTimer: null,
    hudTimer: null,
    toastTimer: null,
    wakeLock: null,
    guideMode: 0, // 0: off, 1: 9:16, 2: 4:5, 3: 1:1, 4: safe
    lastMeta: null,
  };

  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        state.wakeLock = await navigator.wakeLock.request('screen');
      } catch {}
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
  });
  requestWakeLock();

  function showToast(text, duration = 3000) {
    clearTimeout(state.toastTimer);
    toast.textContent = text;
    toast.classList.remove('hidden');
    state.toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
  }

  function showEmpty(title, text) {
    empty.hidden = false;
    emptyTitle.textContent = title;
    emptyText.textContent = text;
  }

  function hideEmpty() {
    empty.hidden = true;
  }

  if (!token) {
    showEmpty(
      'Live Video Preview Ready',
      'Scan the QR code shown in Premiere Pro or After Effects to connect.'
    );
    hud.classList.remove('hidden');
    return;
  }

  function connect() {
    if (state.ended) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

    if (!state.hasFrame) {
      showEmpty('Connecting to Relay…', 'Make sure the Live Video Preview relay is running on your PC.');
    }

    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      ws.send(JSON.stringify({ type: 'hello', role: 'viewer', token }));
    };

    ws.binaryType = 'arraybuffer';

    ws.onmessage = (event) => {
      // Binary = JPEG frame from the native plugin: [u32 LE metaLen][meta JSON][JPEG]
      if (typeof event.data !== 'string') {
        handleBinaryFrame(event.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = (event) => {
      state.connected = false;
      state.authed = false;
      clearInterval(state.pingTimer);
      if (state.ws === ws) state.ws = null;
      if (state.ended) return;

      if (event.code === 4003) {
        state.ended = true;
        statusDot.className = 'dot ended';
        docName.textContent = 'Session stopped';
        showEmpty('Session Stopped', 'The preview was stopped in the Adobe panel. Rescan the new QR code.');
        return;
      }

      statusDot.className = 'dot';
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const wait = Math.min(6000, 500 * Math.pow(1.6, state.attempts++));
    state.reconnectTimer = setTimeout(connect, wait);
  }

  function handleBinaryFrame(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return;
    const metaLen = new DataView(buf).getUint32(0, true);
    if (4 + metaLen >= buf.byteLength) return;
    let meta;
    try {
      meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, metaLen)));
    } catch {
      return;
    }
    const blob = new Blob([new Uint8Array(buf, 4 + metaLen)], { type: meta.mime || 'image/jpeg' });
    state.hasFrame = true;
    hideEmpty();
    statusDot.className = 'dot live';
    updateMeta(meta);
    queueFrame(null, meta, blob);
  }

  function showNativeStatus(msg) {
    const tx = msg.transmit;
    if (!tx || !tx.connected || state.hasFrame) return;
    showEmpty(
      'Premiere connected',
      tx.playing ? 'Playing... waiting for the first frame.' : 'Idle. Move the playhead or press play in Premiere.'
    );
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        state.authed = true;
        state.attempts = 0;
        clearInterval(state.pingTimer);
        state.pingTimer = setInterval(() => {
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 20000);

        if (msg.hasFrame && msg.frame) {
          updateMeta(msg.frame);
        } else if (msg.transmit && msg.transmit.connected) {
          showNativeStatus(msg);
        } else {
          showEmpty('Waiting for Timeline…', 'Scrub or pause the timeline in Premiere Pro or After Effects to send a frame.');
        }
        break;
      }

      case 'status': {
        if (msg.frame) updateMeta(msg.frame);
        showNativeStatus(msg);
        if (msg.pluginOnline && state.hasFrame) {
          statusDot.className = 'dot live';
        } else if (!msg.pluginOnline && state.hasFrame) {
          statusDot.className = 'dot';
          showToast('Editor disconnected');
        }
        break;
      }

      case 'frame': {
        if (!msg.data) return;
        state.hasFrame = true;
        hideEmpty();
        statusDot.className = 'dot live';
        if (msg.meta) updateMeta(msg.meta);
        queueFrame(msg.data, msg.meta || {});
        break;
      }

      default:
        break;
    }
  }

  function updateMeta(meta) {
    state.lastMeta = meta;
    docName.textContent = meta.name || 'Untitled';
    tcDisplay.textContent = meta.timecode || '00:00:00:00';
    if (meta.width && meta.height) {
      resDisplay.textContent = `${meta.width} × ${meta.height}`;
    }
    if (meta.host) {
      hostBadge.textContent = meta.host.toLowerCase().includes('after') ? 'Ae' : 'Pr';
      hostBadge.classList.remove('hidden');
    }
    updateGuides();
  }

  // ------------------------------------------------------------------ Frame Rendering
  let active = frameA;
  let imgWidth = 0;
  let imgHeight = 0;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let isFit = true;
  let pendingFrame = null;
  let rendering = false;

  function queueFrame(data, meta, blob) {
    if (pendingFrame && pendingFrame.blobUrl) URL.revokeObjectURL(pendingFrame.blobUrl);
    pendingFrame = { data, meta, blobUrl: blob ? URL.createObjectURL(blob) : null };
    if (!rendering) pump();
  }

  async function pump() {
    rendering = true;
    try {
      while (pendingFrame) {
        const f = pendingFrame;
        pendingFrame = null;
        await render(f.data, f.meta, f.blobUrl);
      }
    } finally {
      rendering = false;
    }
  }

  let activeBlobUrl = null;

  async function render(base64, meta, blobUrl) {
    const next = active === frameA ? frameB : frameA;
    const mime = (meta && meta.mime) || (base64 && base64.startsWith('iVBORw') ? 'image/png' : 'image/jpeg');
    const url = blobUrl || `data:${mime};base64,${base64}`;

    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
    } catch {}

    next.src = url;
    await new Promise((res) => {
      if (next.complete && next.naturalWidth) return res();
      next.onload = res;
      next.onerror = res;
      setTimeout(res, 3000);
    });

    const isFirst = !imgWidth;
    imgWidth = next.naturalWidth || meta.width || 1920;
    imgHeight = next.naturalHeight || meta.height || 1080;

    next.style.width = imgWidth + 'px';
    next.style.height = imgHeight + 'px';
    zoom.style.width = imgWidth + 'px';
    zoom.style.height = imgHeight + 'px';

    next.classList.add('visible');
    active.classList.remove('visible');
    active = next;
    if (activeBlobUrl) URL.revokeObjectURL(activeBlobUrl);
    activeBlobUrl = blobUrl || null;

    if (isFirst || isFit) {
      fitToScreen();
    } else {
      applyTransform();
    }
    updateGuides();
  }

  function fitToScreen() {
    if (!imgWidth || !imgHeight) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    scale = Math.min(sw / imgWidth, sh / imgHeight);
    tx = (sw - imgWidth * scale) / 2;
    ty = (sh - imgHeight * scale) / 2;
    isFit = true;
    zoomBtn.textContent = '1:1';
    applyTransform();
  }

  function setOneToOne() {
    if (!imgWidth || !imgHeight) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    scale = 1;
    tx = (sw - imgWidth) / 2;
    ty = (sh - imgHeight) / 2;
    isFit = false;
    zoomBtn.textContent = 'Fit';
    applyTransform();
  }

  function applyTransform() {
    zoom.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  }

  zoomBtn.addEventListener('click', () => {
    if (isFit) setOneToOne();
    else fitToScreen();
  });

  // ------------------------------------------------------------------ Guides
  const GUIDE_MODES = ['Off', '9:16', '4:5', '1:1', 'Safe'];
  guideBtn.addEventListener('click', () => {
    state.guideMode = (state.guideMode + 1) % GUIDE_MODES.length;
    guideBtn.textContent = GUIDE_MODES[state.guideMode];
    guideBtn.classList.toggle('active', state.guideMode > 0);
    updateGuides();
  });

  function updateGuides() {
    if (!imgWidth || !imgHeight || state.guideMode === 0) {
      guidesOverlay.classList.add('hidden');
      return;
    }
    guidesOverlay.classList.remove('hidden');
    guide916.classList.add('hidden');
    guide45.classList.add('hidden');
    guide11.classList.add('hidden');
    guideSafe.classList.add('hidden');

    function centerBox(el, targetRatio) {
      el.classList.remove('hidden');
      const currentRatio = imgWidth / imgHeight;
      let w, h, x, y;
      if (currentRatio > targetRatio) {
        // Timeline is wider: crop sides
        h = imgHeight;
        w = h * targetRatio;
        x = (imgWidth - w) / 2;
        y = 0;
      } else {
        // Timeline is taller: crop top/bottom
        w = imgWidth;
        h = w / targetRatio;
        x = 0;
        y = (imgHeight - h) / 2;
      }
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    }

    if (state.guideMode === 1) centerBox(guide916, 9 / 16);
    else if (state.guideMode === 2) centerBox(guide45, 4 / 5);
    else if (state.guideMode === 3) centerBox(guide11, 1 / 1);
    else if (state.guideMode === 4) guideSafe.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ Touch Gestures
  let pointers = new Map();
  let startDist = 0;
  let startScale = 1;
  let startTx = 0;
  let startTy = 0;
  let startMidX = 0;
  let startMidY = 0;
  let lastTap = 0;

  stage.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      startTx = tx;
      startTy = ty;
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      startScale = scale;
      startMidX = (pts[0].x + pts[1].x) / 2;
      startMidY = (pts[0].y + pts[1].y) / 2;
      startTx = tx;
      startTy = ty;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      const p = pointers.get(e.pointerId);
      tx += e.movementX;
      ty += e.movementY;
      isFit = false;
      zoomBtn.textContent = 'Fit';
      applyTransform();
    } else if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (startDist > 0) {
        const factor = dist / startDist;
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale * factor));
        tx = startMidX - (startMidX - startTx) * (newScale / startScale);
        ty = startMidY - (startMidY - startTy) * (newScale / startScale);
        scale = newScale;
        isFit = false;
        zoomBtn.textContent = 'Fit';
        applyTransform();
      }
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      // Double tap: toggle 1:1 / fit
      if (isFit) setOneToOne();
      else fitToScreen();
    } else {
      // Single tap: toggle HUD
      hud.classList.toggle('hidden');
    }
    lastTap = now;
  });

  window.addEventListener('resize', () => {
    if (isFit) fitToScreen();
  });

  connect();
})();
