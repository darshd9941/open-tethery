'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const stage = $('stage');
  const zoom = $('zoom');
  const frameA = $('frameA');
  const frameB = $('frameB');
  const empty = $('empty');
  const emptySpinner = $('emptySpinner');
  const emptyTitle = $('emptyTitle');
  const emptyText = $('emptyText');
  const hud = $('hud');
  const statusDot = $('statusDot');
  const docName = $('docName');
  const profilePill = $('profilePill');
  const details = $('details');
  const toast = $('toast');
  const zoomBtn = $('zoomBtn');
  const tips = $('tips');
  const tipsBtn = $('tipsBtn');
  const tipsClose = $('tipsClose');

  const TOKEN_KEY = 'lpp.token';
  const TIPS_KEY = 'lpp.tipsSeen';
  const MAX_SCALE = 12;
  const MIN_SCALE = 0.5;

  // ------------------------------------------------------------------ token

  function readToken() {
    const match = /(?:^#|&)pair=([A-Za-z0-9_-]{16,128})/.exec(location.hash || '');
    if (match) {
      const token = match[1];
      try {
        // localStorage so a home-screen launch can reuse the token while the
        // session is still alive. The token dies when the plugin starts a new
        // session; a stale token is simply rejected.
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* private mode */
      }
      // Keep the token out of the address bar and out of server logs.
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

  // ------------------------------------------------------------------ state

  const state = {
    ws: null,
    connected: false,
    authed: false,
    hasFrame: false,
    ended: false,
    attempts: 0,
    noSessionCloses: 0,
    reconnectTimer: null,
    pingTimer: null,
    hudTimer: null,
    toastTimer: null,
    pluginOnline: false,
    lastMeta: null,
    lastFrameAt: 0,
    hudHidden: false,
    tipsScheduled: false,
  };

  // ------------------------------------------------------------------ empty state

  function showEmpty(title, text, kind) {
    empty.hidden = false;
    emptyTitle.textContent = title;
    emptyText.textContent = text;
    emptySpinner.classList.toggle('stopped', kind === 'ended');
  }

  function hideEmpty() {
    empty.hidden = true;
  }

  if (!token) {
    showEmpty('Join the preview', '', 'waiting');
    emptySpinner.hidden = true;
    emptyText.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'code-form';
    form.setAttribute('autocomplete', 'off');
    const lead = document.createElement('p');
    lead.textContent = 'Enter the 4-letter code shown in Photoshop';
    const input = document.createElement('input');
    input.className = 'code-input';
    input.type = 'text';
    input.maxLength = 4;
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('inputmode', 'text');
    input.setAttribute('aria-label', '4-letter code');
    input.placeholder = 'ABCD';
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'primary-btn';
    btn.textContent = 'Join';
    const msg = document.createElement('div');
    msg.className = 'code-error';
    msg.setAttribute('role', 'alert');
    form.append(lead, input, btn, msg);
    emptyText.appendChild(form);
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = input.value.trim().toUpperCase();
      if (code.length !== 4) {
        msg.textContent = 'Type all 4 letters shown in Photoshop.';
        return;
      }
      btn.disabled = true;
      msg.textContent = '';
      try {
        const res = await fetch('/api/join?code=' + encodeURIComponent(code), { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          location.hash = 'pair=' + data.token;
          location.reload();
          return;
        }
        msg.textContent = res.status === 429
          ? 'Too many tries. Wait a minute and try again.'
          : "That code doesn't match. Check the panel in Photoshop.";
      } catch {
        msg.textContent = "Can't reach the PC. Make sure it is on the same Wi-Fi.";
      }
      btn.disabled = false;
    });
    statusDot.className = 'dot';
    docName.textContent = 'Waiting for pairing';
    details.textContent = location.host;
    hud.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
    return;
  }

  // ------------------------------------------------------------------ websocket

  function send(value) {
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function setConnecting() {
    statusDot.className = 'dot';
    if (!state.hasFrame) {
      docName.textContent = 'Connecting…';
      showEmpty('Connecting to the relay', 'Make sure the preview relay window is still open on the PC.', 'waiting');
    }
  }

  function setWaiting(message) {
    statusDot.className = 'dot';
    if (!state.hasFrame) {
      docName.textContent = 'Waiting for Photoshop';
      showEmpty('Waiting for Photoshop', message || 'Open the Open Tethery panel in Photoshop.', 'waiting');
    }
  }

  function setLive(meta) {
    statusDot.className = 'dot live';
    if (meta) docName.textContent = meta.name || 'Untitled';
    hideEmpty();
  }

  function setEnded(message) {
    state.ended = true;
    clearTimeout(state.reconnectTimer);
    clearInterval(state.pingTimer);
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    statusDot.className = 'dot ended';
    docName.textContent = 'Session ended';
    showEmpty('Session ended', message, 'ended');
    toastMessage(message, 6000);
    try {
      if (state.ws) state.ws.close(1000, 'Ended');
    } catch {
      /* ignore */
    }
    state.ws = null;
  }

  function scheduleReconnect(delay) {
    if (state.ended) return;
    clearTimeout(state.reconnectTimer);
    const wait = delay == null ? Math.min(8000, 500 * Math.pow(1.7, state.attempts)) : delay;
    state.reconnectTimer = setTimeout(connect, wait);
  }

  function connect() {
    if (state.ended) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

    setConnecting();
    let ws;
    try {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${scheme}//${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      send({ type: 'hello', role: 'viewer', token });
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(message);
    };

    ws.onclose = (event) => {
      state.connected = false;
      state.authed = false;
      clearInterval(state.pingTimer);
      state.pingTimer = null;
      if (state.ws === ws) state.ws = null;
      if (state.ended) return;

      if (event.code === 4003) {
        setEnded('The preview was stopped in Photoshop. Open the Open Tethery panel and scan the QR code again, or type the new code.');
        return;
      }

      if (event.code === 4001) {
        state.noSessionCloses++;
        if (state.noSessionCloses >= 8) {
          setEnded('The session has expired. Scan the QR code shown in Photoshop again.');
          return;
        }
        setWaiting('A new preview session may be starting. Retrying…');
        scheduleReconnect(700 + state.noSessionCloses * 400);
        return;
      }

      state.attempts++;
      if (!state.hasFrame) {
        showEmpty('Connection lost', 'Trying to reconnect. Keep this page open.', 'waiting');
        docName.textContent = 'Reconnecting…';
      } else {
        toastMessage('Reconnecting…');
        statusDot.className = 'dot';
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose handles recovery.
    };
  }

  function handleMessage(message) {
    switch (message.type) {
      case 'welcome': {
        state.authed = true;
        state.attempts = 0;
        state.noSessionCloses = 0;
        state.pluginOnline = Boolean(message.pluginOnline);
        state.hasFrame = Boolean(message.hasFrame);

        clearInterval(state.pingTimer);
        state.pingTimer = setInterval(() => send({ type: 'ping' }), 20000);

        if (message.hasFrame && message.frame) {
          // The frame follows as a separate message; show the metadata meanwhile.
          setLive(message.frame);
        } else if (state.pluginOnline) {
          setWaiting('Photoshop is connected. Open a document to send the first frame.');
        } else {
          setWaiting('Press Start in the Live Phone Preview panel in Photoshop.');
        }

        if (!state.hasFrame) scheduleHudHide();
        break;
      }

      case 'status': {
        state.pluginOnline = Boolean(message.pluginOnline);
        if (message.frame) {
          state.lastMeta = message.frame;
          updateHud(message.frame);
        }
        if (!state.pluginOnline && state.hasFrame) {
          statusDot.className = 'dot';
          toastMessage('Photoshop disconnected — showing the last frame.');
        } else if (state.pluginOnline && state.hasFrame) {
          statusDot.className = 'dot live';
        } else if (state.pluginOnline) {
          setWaiting('Photoshop is connected. Open a document to send the first frame.');
        }
        break;
      }

      case 'frame': {
        if (typeof message.data !== 'string') return;
        state.hasFrame = true;
        state.ended = false;
        state.lastFrameAt = Date.now();
        state.lastMeta = message.meta || null;
        queueFrame(message.data, message.meta || {});
        break;
      }

      case 'error': {
        if (message.code === 'no-session') {
          state.noSessionCloses++;
        }
        break;
      }

      case 'pong':
        break;

      default:
        break;
    }
  }

  // ------------------------------------------------------------------ frame rendering

  let active = frameA;
  let naturalWidth = 0;
  let naturalHeight = 0;
  let layoutWidth = 0;
  let layoutHeight = 0;
  let scale = 1;
  let tx = 0;
  let ty = 0;

  let rendering = false;
  let pendingFrame = null;

  function queueFrame(data, meta) {
    pendingFrame = { data, meta };
    if (!rendering) pumpFrames();
  }

  async function pumpFrames() {
    rendering = true;
    try {
      while (pendingFrame) {
        const frame = pendingFrame;
        pendingFrame = null;
        await renderFrame(frame.data, frame.meta);
      }
    } finally {
      rendering = false;
    }
  }

  async function renderFrame(base64, meta) {
    const incoming = active === frameA ? frameB : frameA;
    const url = `data:image/jpeg;base64,${base64}`;

    // Decode before showing so the previous frame never flashes away.
    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
    } catch {
      /* Older browsers: fall through to the image load below. */
    }

    incoming.src = url;
    if (!incoming.complete || !incoming.naturalWidth) {
      await new Promise((resolve) => {
        incoming.onload = resolve;
        incoming.onerror = resolve;
        setTimeout(resolve, 4000);
      });
    }

    incoming.classList.add('active');
    active.classList.remove('active');
    active = incoming;

    naturalWidth = incoming.naturalWidth || meta.width || 0;
    naturalHeight = incoming.naturalHeight || meta.height || 0;
    layoutWidth = incoming.clientWidth || naturalWidth;
    layoutHeight = incoming.clientHeight || naturalHeight;

    clampTransform();
    applyTransform();
    updateZoomLabel();
    updateHud(meta);
    setLive(meta);

    if (!state.hudHidden) {
      hud.classList.remove('hidden');
      scheduleHudHide();
    }

    if (!localStorageTipsSeen()) {
      if (!state.tipsScheduled) {
        state.tipsScheduled = true;
        setTimeout(showTips, 550);
      }
    }
  }

  function updateHud(meta) {
    if (!meta) return;
    if (meta.name) docName.textContent = meta.name;

    const profile = shortProfile(meta.profile);
    if (profile) {
      profilePill.hidden = false;
      profilePill.textContent = profile;
    } else {
      profilePill.hidden = true;
    }

    const width = Number(meta.width) || naturalWidth || 0;
    const height = Number(meta.height) || naturalHeight || 0;
    const timestamp = Number(meta.timestamp) || Date.now();
    const time = new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    details.textContent = `${width} × ${height} px · updated ${time}`;
  }

  function shortProfile(name) {
    if (!name) return '';
    if (/display\s*p3|\bp3\b/i.test(name)) return 'Display P3';
    if (/srgb|iec\s*61966/i.test(name)) return 'sRGB';
    return String(name).slice(0, 24);
  }

  // ------------------------------------------------------------------ zoom and pan

  function applyTransform() {
    zoom.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  }

  function clampTransform() {
    const viewportWidth = stage.clientWidth;
    const viewportHeight = stage.clientHeight;
    const contentWidth = (layoutWidth || viewportWidth) * scale;
    const contentHeight = (layoutHeight || viewportHeight) * scale;
    const maxX = Math.max(0, (contentWidth - viewportWidth) / 2);
    const maxY = Math.max(0, (contentHeight - viewportHeight) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  function zoomAt(clientX, clientY, nextScale) {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const px = clientX - centerX;
    const py = clientY - centerY;
    const contentX = (px - tx) / scale;
    const contentY = (py - ty) / scale;

    scale = clamped;
    tx = px - contentX * scale;
    ty = py - contentY * scale;

    clampTransform();
    applyTransform();
    updateZoomLabel();
  }

  function resetFit() {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
    updateZoomLabel();
  }

  function actualSize() {
    if (!layoutWidth || !naturalWidth) return 1;
    return Math.max(1, naturalWidth / layoutWidth);
  }

  function toggleZoom(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const x = typeof clientX === 'number' ? clientX : rect.left + rect.width / 2;
    const y = typeof clientY === 'number' ? clientY : rect.top + rect.height / 2;
    if (scale > 1.02) {
      resetFit();
    } else {
      zoomAt(x, y, actualSize());
    }
  }

  function updateZoomLabel() {
    zoomBtn.textContent = scale > 1.02 ? 'Fit' : '1:1';
  }

  // ------------------------------------------------------------------ gestures

  const pointers = new Map();
  let dragStart = null;
  let pinch = null;
  let moved = false;
  let tapTimer = null;
  let lastTap = { time: 0, x: 0, y: 0 };

  function pointerList() {
    return Array.from(pointers.values());
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: event.pointerType });
    moved = false;
    pinch = null;
    if (pointers.size === 1) {
      dragStart = { x: event.clientX, y: event.clientY, tx, ty };
      stage.classList.add('dragging');
    } else if (pointers.size === 2) {
      const [a, b] = pointerList();
      pinch = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      };
      dragStart = null;
    }
  });

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, type: previous.type });

    if (pointers.size >= 2) {
      const [a, b] = pointerList();
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (!pinch) {
        pinch = { distance, midX, midY };
      } else {
        const factor = distance / pinch.distance;
        zoomAt(midX, midY, scale * factor);
        tx += midX - pinch.midX;
        ty += midY - pinch.midY;
        clampTransform();
        applyTransform();
        pinch = { distance, midX, midY };
      }
      moved = true;
      return;
    }

    if (!dragStart) return;
    const dx = event.clientX - dragStart.x;
    const dy = event.clientY - dragStart.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    tx = dragStart.tx + dx;
    ty = dragStart.ty + dy;
    clampTransform();
    applyTransform();
  });

  function endPointer(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);

    if (pointers.size < 2) pinch = null;

    if (pointers.size === 1) {
      const [remaining] = pointerList();
      dragStart = { x: remaining.x, y: remaining.y, tx, ty };
    }

    if (pointers.size === 0) {
      dragStart = null;
      stage.classList.remove('dragging');
      if (!moved && event.pointerType !== 'mouse') handleTap(event);
      if (!moved && event.pointerType === 'mouse') toggleHud();
    }
  }

  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  function handleTap(event) {
    const now = Date.now();
    const isDouble =
      now - lastTap.time < 320 &&
      Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 40;

    if (isDouble) {
      clearTimeout(tapTimer);
      lastTap = { time: 0, x: 0, y: 0 };
      toggleZoom(event.clientX, event.clientY);
      return;
    }

    lastTap = { time: now, x: event.clientX, y: event.clientY };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(toggleHud, 280);
  }

  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAt(event.clientX, event.clientY, scale * factor);
      showHudTemporarily();
    },
    { passive: false }
  );

  stage.addEventListener('dblclick', (event) => {
    event.preventDefault();
    toggleZoom(event.clientX, event.clientY);
  });

  window.addEventListener('resize', () => {
    layoutWidth = active.clientWidth || layoutWidth;
    layoutHeight = active.clientHeight || layoutHeight;
    clampTransform();
    applyTransform();
  });

  // ------------------------------------------------------------------ HUD

  let hudHideTimer = null;

  function toggleHud() {
    if (hud.classList.contains('hidden')) {
      hud.classList.remove('hidden');
      state.hudHidden = false;
      scheduleHudHide();
    } else {
      hud.classList.add('hidden');
      state.hudHidden = true;
      clearTimeout(hudHideTimer);
    }
  }

  function showHudTemporarily() {
    hud.classList.remove('hidden');
    state.hudHidden = false;
    scheduleHudHide();
  }

  function scheduleHudHide() {
    clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (state.hasFrame) {
        hud.classList.add('hidden');
        state.hudHidden = true;
      }
    }, 4000);
  }

  function toastMessage(text, duration) {
    toast.textContent = text;
    toast.hidden = false;
    hud.classList.remove('hidden');
    state.hudHidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.hidden = true;
      scheduleHudHide();
    }, duration || 3200);
  }

  // ------------------------------------------------------------------ tips

  function localStorageTipsSeen() {
    try {
      return localStorage.getItem(TIPS_KEY) === '1';
    } catch {
      return true;
    }
  }

  function showTips() {
    tips.hidden = false;
  }

  function hideTips() {
    tips.hidden = true;
    try {
      localStorage.setItem(TIPS_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  tipsBtn.addEventListener('click', showTips);
  tipsClose.addEventListener('click', hideTips);
  tips.addEventListener('click', (event) => {
    if (event.target === tips) hideTips();
  });

  zoomBtn.addEventListener('click', () => {
    toggleZoom();
    scheduleHudHide();
  });

  // ------------------------------------------------------------------ wake lock

  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      /* Not available, or denied. */
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      if (!state.ws && !state.ended) {
        state.attempts = 0;
        connect();
      }
    }
  });

  window.addEventListener('pageshow', () => {
    requestWakeLock();
    if (!state.ws && !state.ended) connect();
  });

  // ------------------------------------------------------------------ start

  setConnecting();
  connect();
  requestWakeLock();
  showHudTemporarily();
})();
