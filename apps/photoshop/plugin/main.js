'use strict';

// Live Phone Preview - Photoshop UXP panel.
//
// The plugin never captures the monitor. It asks Photoshop's imaging API for
// the document pixels at a reduced size, converted to the chosen profile, and
// encodes a JPEG. The relay embeds the matching ICC profile and pushes the
// frame to phones.

const { app, core, imaging } = require('photoshop');
const uxp = require('uxp');

const SETTINGS_KEY = 'lpp.settings.v1';
const DEFAULT_PORT = 47823;
const POLL_MS = 300;
const DEBOUNCE_MS = 350;
const MAX_PIXELS = 12000000;
const RELAY_HOST = '127.0.0.1';
const VERSION = '1.0.0';

const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const qrWrap = $('qrWrap');
const qrCode = $('qrCode');
const pairUrlEl = $('pairUrl');
const toggleBtn = $('toggle');
const onceBtn = $('once');
const openBtn = $('openBtn');
const sizeEl = $('size');
const profileEl = $('profile');
const portEl = $('port');
const profileNotice = $('profileNotice');

let running = false;
let registered = false;
let token = null;
let currentPort = DEFAULT_PORT;
let pairUrl = '';
let ws = null;
let pollTimer = null;
let debounceTimer = null;
let reconnectTimer = null;
let pendingSignature = null;
let lastSignature = null;
let capturing = false;
let queued = false;
let selectedProfile = 'sRGB IEC61966-2.1';
let availableProfiles = [];

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(text, kind) {
  statusText.textContent = text;
  statusDot.className = 'dot' + (kind ? ' ' + kind : '');
}

function errorText(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  let saved = {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch {
    saved = {};
  }

  const size = Number(saved.size);
  if (Number.isFinite(size) && size >= 600 && size <= 4000) {
    sizeEl.value = String(size);
  }
  const port = Number(saved.port);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    portEl.value = String(port);
  }
  if (typeof saved.profile === 'string') {
    selectedProfile = saved.profile;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        size: readSize(),
        port: readPort(),
        profile: selectedProfile,
      })
    );
  } catch {
    /* localStorage can be unavailable; settings are a convenience only. */
  }
}

function readSize() {
  const size = parseInt(sizeEl.value, 10);
  if (Number.isFinite(size) && size >= 600 && size <= 4000) return size;
  return 1600;
}

function readPort() {
  const port = parseInt(portEl.value, 10);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return 0;
}

// ---------------------------------------------------------------------------
// Colour profiles
// ---------------------------------------------------------------------------

async function loadProfiles() {
  let profiles = [];
  try {
    profiles = await app.getColorProfiles('RGB');
  } catch {
    profiles = [];
  }
  availableProfiles = Array.isArray(profiles) ? profiles : [];

  const srgb =
    availableProfiles.find((name) => /^sRGB IEC61966-2\.1$/i.test(name)) ||
    'sRGB IEC61966-2.1';
  const p3 = availableProfiles.find((name) => /display\s*p3/i.test(name));

  const menu = profileEl.querySelector('sp-menu');
  if (menu) {
    menu.textContent = '';
    addProfileItem(menu, srgb, 'sRGB · safe default');
    if (p3 && p3 !== srgb) addProfileItem(menu, p3, 'Display P3 · iPhone');
  }

  const allowed = [srgb, p3].filter(Boolean);
  if (selectedProfile && allowed.indexOf(selectedProfile) !== -1) {
    profileEl.value = selectedProfile;
  } else {
    selectedProfile = srgb;
    profileEl.value = srgb;
  }

  if (!p3) {
    profileNotice.style.display = 'block';
    profileNotice.textContent =
      'Display P3 is not installed in Windows, so sRGB is used. Right-click relay/profiles/DisplayP3.icc → Install profile, then reopen this panel.';
  } else {
    profileNotice.style.display = 'none';
  }
}

function addProfileItem(menu, value, label) {
  const item = document.createElement('sp-menu-item');
  item.setAttribute('value', value);
  // UXP spectrum widgets read the property in some hosts and the attribute in
  // others; set both so the picker always reports the profile name.
  item.value = value;
  item.textContent = label;
  menu.appendChild(item);
}

// ---------------------------------------------------------------------------
// Relay connection
// ---------------------------------------------------------------------------

function randomToken() {
  const bytes = new Uint8Array(16);
  const cryptoObject =
    (typeof crypto !== 'undefined' && crypto) ||
    (typeof window !== 'undefined' && window.crypto) ||
    null;
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function connect() {
  if (!running || ws) return;

  const port = readPort();
  if (!port) {
    setStatus('Enter a valid relay port (1–65535).', 'err');
    stop();
    return;
  }
  currentPort = port;

  let socket;
  try {
    socket = new WebSocket(`ws://${RELAY_HOST}:${port}/ws`);
  } catch (error) {
    setStatus('Could not open the relay connection: ' + errorText(error), 'err');
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    try {
      socket.send(
        JSON.stringify({
          type: 'register',
          token,
          name: 'Live Phone Preview',
          version: VERSION,
        })
      );
      setStatus('Registering with the relay…', 'warn');
    } catch (error) {
      setStatus('Could not register: ' + errorText(error), 'err');
    }
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'registered') {
      registered = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      pairUrl = String(message.url || '');
      renderQr(pairUrl);
      qrWrap.classList.add('visible');
      lastSignature = null;
      pendingSignature = null;
      setStatus('Live · waiting for an open document', 'on');
      // Send the current document as soon as possible.
      setTimeout(() => {
        if (running && registered) captureAndSend();
      }, 80);
      return;
    }

    if (message.type === 'pong') return;

    if (message.type === 'warning') {
      setStatus(message.message || 'Relay warning', 'warn');
      return;
    }

    if (message.type === 'error') {
      setStatus(message.message || 'Relay error', 'err');
    }
  };

  socket.onerror = () => {
    // onclose handles retrying.
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    registered = false;
    if (!running) return;
    setStatus('Relay not reachable — retrying. Is the preview window open?', 'err');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function disconnect() {
  const socket = ws;
  ws = null;
  registered = false;
  if (!socket) return;
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'stop' }));
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }, 120);
}

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------

function qrFactory() {
  if (typeof qrcode === 'function') return qrcode;
  if (typeof window !== 'undefined' && typeof window.qrcode === 'function') {
    return window.qrcode;
  }
  return null;
}

function renderQr(url) {
  qrCode.textContent = '';
  pairUrlEl.textContent = url;

  const factory = qrFactory();
  if (!factory) {
    pairUrlEl.textContent =
      url + '\n(QR library did not load — open the link above on the phone.)';
    return;
  }

  let qr;
  try {
    qr = factory(0, 'M');
    qr.addData(url);
    qr.make();
  } catch (error) {
    pairUrlEl.textContent = url + '\n(Could not draw the QR code.)';
    return;
  }

  const count = qr.getModuleCount();
  // Leave a four-module quiet zone (required for reliable scanning) inside the
  // white card, and keep the whole code within the narrowest panel width.
  const cell = Math.max(3, Math.floor(180 / (count + 8)));
  qrCode.style.padding = cell * 4 + 'px';

  for (let row = 0; row < count; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'qr-row';
    rowEl.style.height = cell + 'px';
    for (let col = 0; col < count; col++) {
      const cellEl = document.createElement('div');
      cellEl.className = qr.isDark(row, col) ? 'qr-cell dark' : 'qr-cell';
      cellEl.style.width = cell + 'px';
      cellEl.style.height = cell + 'px';
      rowEl.appendChild(cellEl);
    }
    qrCode.appendChild(rowEl);
  }
}

// ---------------------------------------------------------------------------
// Document change tracking
// ---------------------------------------------------------------------------

function signature(doc) {
  if (!doc) return null;
  let history = '';
  try {
    history = doc.activeHistoryState ? doc.activeHistoryState.id : '';
  } catch {
    history = '';
  }
  let layerCount = 0;
  try {
    layerCount = doc.layers ? doc.layers.length : 0;
  } catch {
    layerCount = 0;
  }
  return [
    doc.id,
    history,
    Math.round(doc.width),
    Math.round(doc.height),
    layerCount,
  ].join(':');
}

function scheduleCapture(sig) {
  if (sig === lastSignature) return;
  if (sig === pendingSignature) return;
  pendingSignature = sig;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    pendingSignature = null;
    captureAndSend();
  }, DEBOUNCE_MS);
}

function activeDocument() {
  try {
    if (app.documents && app.documents.length === 0) return null;
    return app.activeDocument || null;
  } catch {
    return null;
  }
}

function tick() {
  if (!running || capturing) return;
  const doc = activeDocument();
  if (!doc) {
    if (registered) setStatus('Live · no open document', 'warn');
    lastSignature = null;
    return;
  }
  const sig = signature(doc);
  if (!sig) return;
  if (sig !== lastSignature) scheduleCapture(sig);
}

// ---------------------------------------------------------------------------
// Capture and send
// ---------------------------------------------------------------------------

async function captureDoc(doc, maxSide, profile) {
  const docWidth = Math.max(1, Math.round(doc.width));
  const docHeight = Math.max(1, Math.round(doc.height));
  const longEdge = Math.max(docWidth, docHeight);
  const ratio = Math.min(1, maxSide / longEdge);

  let width = Math.max(1, Math.round(docWidth * ratio));
  let height = Math.max(1, Math.round(docHeight * ratio));

  if (width * height > MAX_PIXELS) {
    const shrink = Math.sqrt(MAX_PIXELS / (width * height));
    width = Math.max(1, Math.floor(width * shrink));
    height = Math.max(1, Math.floor(height * shrink));
  }

  let result = null;
  let base64 = null;
  let capturedWidth = width;
  let capturedHeight = height;

  await core.executeAsModal(
    async () => {
      result = await imaging.getPixels({
        documentID: doc.id,
        targetSize: { width, height },
        componentSize: 8,
        applyAlpha: true,
        colorSpace: 'RGB',
        colorProfile: profile,
      });
      try {
        capturedWidth = result.imageData.width;
        capturedHeight = result.imageData.height;
        base64 = await imaging.encodeImageData({
          imageData: result.imageData,
          base64: true,
        });
      } finally {
        if (result && result.imageData) result.imageData.dispose();
      }
    },
    { commandName: 'Live Phone Preview' }
  );

  if (typeof base64 !== 'string' || !base64) {
    throw new Error('Photoshop returned an empty frame');
  }

  return {
    base64,
    meta: {
      name: doc.name || 'Untitled',
      width: capturedWidth,
      height: capturedHeight,
      sourceWidth: docWidth,
      sourceHeight: docHeight,
      profile,
      timestamp: Date.now(),
    },
  };
}

async function captureAndSend(manual) {
  if (!running || capturing) {
    if (manual) queued = true;
    return;
  }
  if (!registered || !ws) {
    if (manual) setStatus('Not connected to the relay yet.', 'err');
    return;
  }

  const doc = activeDocument();
  if (!doc) {
    setStatus('Open a document in Photoshop first.', 'warn');
    return;
  }

  const sig = signature(doc);
  capturing = true;
  try {
    const frame = await captureDoc(doc, readSize(), selectedProfile);
    const payload = JSON.stringify({
      type: 'frame',
      data: frame.base64,
      meta: frame.meta,
    });

    if (!registered || !ws || ws.readyState !== 1) {
      throw new Error('Relay connection closed');
    }
    ws.send(payload);
    lastSignature = sig;

    const kb = Math.round((frame.base64.length * 3) / 4 / 1024);
    setStatus(
      `Live · ${frame.meta.name} · ${frame.meta.width}×${frame.meta.height} · ${kb} KB`,
      'on'
    );

    const after = activeDocument();
    if (after) {
      const afterSig = signature(after);
      if (afterSig && afterSig !== sig) scheduleCapture(afterSig);
    }
  } catch (error) {
    const message = errorText(error);
    if (/modal|busy|in progress|locked|transaction/i.test(message)) {
      setStatus('Photoshop is busy — will retry.', 'warn');
      setTimeout(() => {
        if (running) captureAndSend();
      }, 700);
    } else {
      setStatus(message, 'err');
    }
  } finally {
    capturing = false;
    if (queued) {
      queued = false;
      setTimeout(() => {
        if (running) captureAndSend();
      }, 60);
    }
  }
}

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

function start() {
  const port = readPort();
  if (!port) {
    setStatus('Enter a valid relay port (1–65535).', 'err');
    return;
  }
  currentPort = port;
  saveSettings();

  running = true;
  registered = false;
  token = randomToken();
  lastSignature = null;
  pendingSignature = null;
  pairUrl = '';

  toggleBtn.textContent = 'Stop';
  toggleBtn.setAttribute('variant', 'warning');
  qrWrap.classList.remove('visible');
  qrCode.textContent = '';
  pairUrlEl.textContent = '';

  setStatus('Connecting to the relay…', 'warn');
  connect();

  clearInterval(pollTimer);
  pollTimer = setInterval(tick, POLL_MS);
  tick();
}

function stop() {
  running = false;
  registered = false;
  clearInterval(pollTimer);
  pollTimer = null;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  pendingSignature = null;

  disconnect();

  qrWrap.classList.remove('visible');
  qrCode.textContent = '';
  pairUrlEl.textContent = '';
  pairUrl = '';
  token = null;

  toggleBtn.textContent = 'Start';
  toggleBtn.setAttribute('variant', 'cta');
  setStatus('Stopped', '');
}

toggleBtn.addEventListener('click', () => {
  if (running) stop();
  else start();
});

onceBtn.addEventListener('click', () => {
  if (!running) {
    setStatus('Press Start first, then Send now.', 'warn');
    return;
  }
  captureAndSend(true);
});

openBtn.addEventListener('click', () => {
  const url = pairUrl || `http://${RELAY_HOST}:${readPort()}/`;
  try {
    uxp.shell.openExternal(url);
  } catch (error) {
    setStatus('Could not open the browser: ' + errorText(error), 'err');
  }
});

sizeEl.addEventListener('change', () => {
  saveSettings();
  lastSignature = null;
  if (running) captureAndSend();
});

profileEl.addEventListener('change', () => {
  selectedProfile = profileEl.value || selectedProfile;
  saveSettings();
  lastSignature = null;
  if (running) captureAndSend();
});

portEl.addEventListener('change', () => {
  saveSettings();
  if (running) {
    setStatus('Port saved. Press Stop and Start to use it.', 'warn');
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadSettings();
setStatus('Stopped', '');
// Ask the host for profiles only after the panel itself has finished loading.
// This keeps plugin startup independent of the colour-profile lookup.
function initProfiles() {
  setTimeout(() => {
    loadProfiles();
  }, 0);
}
if (document.readyState === 'complete') {
  initProfiles();
} else {
  window.addEventListener('load', initProfiles, { once: true });
  setTimeout(initProfiles, 1500);
}
