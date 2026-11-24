'use strict';

// Open Tethery - Photoshop UXP panel.
//
// The plugin never captures the monitor. It asks Photoshop's imaging API for
// the document pixels at a reduced size, converted to the chosen profile, and
// encodes a JPEG. The relay embeds the matching ICC profile and pushes the
// frame to phones.

const { app, core, imaging } = require('photoshop');
const uxp = require('uxp');

const SETTINGS_KEY = 'lpp.settings.v1'; // old key kept so saved settings still load
const DEFAULT_PORT = 47823;
const POLL_MS = 300;
const DEBOUNCE_MS = 350;
const MAX_PIXELS = 12000000;
const RELAY_HOST = '127.0.0.1';
const VERSION = '0.2.0';

const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const statusPill = $('statusPill');
const qrWrap = $('qrWrap');
const qrCode = $('qrCode');
const pairUrlEl = $('pairUrl');
const codeEl = $('sessionCode');
const codeBlock = $('codeBlock');
const docLine = $('docLine');
const noteEl = $('note');
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
let sessionCode = '';
let viewerCount = 0;
let relayFailed = false;
let note = null; // { text, kind } - a problem line under the status pill
let docText = '';
let lastQrUrl = '';
let shortUrl = '';

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

// The pill always shows the overall state. Problems and hints from capture
// (setStatus with 'warn'/'err') appear in a small line under it.
function updatePill() {
  let text;
  let kind = '';
  if (!running) {
    text = 'Stopped';
  } else if (registered) {
    kind = 'on';
    if (viewerCount > 0) {
      text = 'Live \u00b7 ' + viewerCount + (viewerCount === 1 ? ' phone watching' : ' phones watching');
    } else {
      text = 'Live \u00b7 waiting for a phone';
    }
  } else if (relayFailed) {
    kind = 'warn';
    text = 'Waiting for the Open Tethery helper \u2014 is it running?';
  } else {
    text = 'Starting\u2026';
  }
  statusText.textContent = text;
  statusDot.className = 'dot' + (kind ? ' ' + kind : '');
  statusPill.className = 'pill' + (kind ? ' ' + kind : '');
  if (note && note.text) {
    noteEl.textContent = note.text;
    noteEl.className = 'note ' + (note.kind || '');
    noteEl.style.display = 'block';
  } else {
    noteEl.textContent = '';
    noteEl.style.display = 'none';
  }
}

function setStatus(text, kind) {
  // 'on' / '' messages are covered by the pill; only problems become notes.
  note = kind === 'warn' || kind === 'err' ? { text, kind } : null;
  updatePill();
}

function clearNote() {
  note = null;
  updatePill();
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
    stop();
    setStatus('Enter a valid port (1–65535) under Settings.', 'err');
    return;
  }
  currentPort = port;

  let socket;
  try {
    socket = new WebSocket(`ws://${RELAY_HOST}:${port}/ws`);
  } catch (error) {
    relayFailed = true;
    updatePill();
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
          name: 'Open Tethery',
          version: VERSION,
        })
      );
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
      sessionCode = String(message.code || '').toUpperCase();
      shortUrl = message.ip && message.port ? 'http://' + message.ip + ':' + message.port : '';
      relayFailed = false;
      viewerCount = 0;
      codeEl.textContent = sessionCode;
      renderQr(pairUrl);
      qrWrap.classList.add('visible');
      codeBlock.classList.add('visible');
      lastSignature = null;
      pendingSignature = null;
      clearNote();
      // Send the current document as soon as possible.
      setTimeout(() => {
        if (running && registered) captureAndSend();
      }, 80);
      return;
    }

    if (message.type === 'status') {
      if (typeof message.viewers === 'number') {
        viewerCount = message.viewers;
        updatePill();
      }
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
    relayFailed = true;
    viewerCount = 0;
    updatePill();
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

function availableWidth() {
  const w = (document.body && document.body.clientWidth) || window.innerWidth || 300;
  return Math.max(160, w - 24); // body padding
}

function renderQr(url) {
  lastQrUrl = url;
  qrCode.textContent = '';
  pairUrlEl.textContent = shortUrl || url;

  const factory = qrFactory();
  if (!factory) {
    pairUrlEl.textContent =
      (shortUrl || url) + ' (QR picture unavailable - type the code on the phone.)';
    return;
  }

  let qr;
  try {
    qr = factory(0, 'M');
    qr.addData(url);
    qr.make();
  } catch (error) {
    pairUrlEl.textContent = (shortUrl || url) + ' (QR picture unavailable - type the code on the phone.)';
    return;
  }

  const count = qr.getModuleCount();
  // Leave a four-module quiet zone (required for reliable scanning) inside the
  // white card, and keep the whole code within the narrowest panel width.
  const avail = Math.max(160, Math.min(520, availableWidth() - 8));
  const cell = Math.max(2, Math.floor(avail / (count + 8)));
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

function setDocText(name, w, h) {
  docText = name ? name + ' \u00b7 ' + w + ' \u00d7 ' + h : 'Open a document in Photoshop to see it on the phone.';
  docLine.textContent = docText;
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
    if (registered) setDocText(null);
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
    { commandName: 'Open Tethery' }
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
    if (manual) setStatus('Not connected yet. Please wait a moment.', 'warn');
    return;
  }

  const doc = activeDocument();
  if (!doc) {
    setDocText(null);
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

    setDocText(frame.meta.name, frame.meta.sourceWidth, frame.meta.sourceHeight);
    clearNote();

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
    setStatus('Enter a valid port (1–65535) under Settings.', 'err');
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
  sessionCode = '';
  viewerCount = 0;
  relayFailed = false;
  note = null;

  toggleBtn.textContent = 'Stop';
  toggleBtn.setAttribute('variant', 'secondary');
  qrWrap.classList.remove('visible');
  codeBlock.classList.remove('visible');
  qrCode.textContent = '';
  pairUrlEl.textContent = '';
  codeEl.textContent = '';
  updatePill();
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
  codeBlock.classList.remove('visible');
  qrCode.textContent = '';
  pairUrlEl.textContent = '';
  pairUrl = '';
  token = null;
  sessionCode = '';
  viewerCount = 0;
  relayFailed = false;
  note = null;
  codeEl.textContent = '';

  toggleBtn.textContent = 'Start';
  toggleBtn.setAttribute('variant', 'cta');
  updatePill();
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
    setStatus('Port saved. Press Stop, then Start to use it.', 'warn');
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

const settingsBtn = $('settingsBtn');
const settingsBody = $('settingsBody');
settingsBtn.addEventListener('click', () => {
  const open = settingsBody.style.display === 'none';
  settingsBody.style.display = open ? 'flex' : 'none';
  settingsBtn.textContent = open ? 'Settings ▾' : 'Settings ▸';
});

loadSettings();
updatePill();
docLine.textContent = '';

// Re-draw the QR code when the panel is resized so it always fills the width.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastQrUrl && registered) renderQr(lastQrUrl);
  }, 120);
});

// Start streaming as soon as the panel opens - no button press needed.
start();
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
