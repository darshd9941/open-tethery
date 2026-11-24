'use strict';

// Pocket Monitor - Photoshop UXP panel (role "source" on the helper).
// Glue only: protocol in js/source-client.js, Photoshop calls in js/ps-capture.js.

const { SourceClient } = require('./js/source-client');
const { PsCapture, DEFAULT_PROFILE } = require('./js/ps-capture');
const { HELPER_WS, getSession, newSession } = require('./js/helper-api');
const { docLine, phonesText, shortUrl, errorText } = require('./js/format');

const SETTINGS_KEY = 'ot.photoshop.settings.v1';
const SESSION_POLL_MS = 5000; // code/URL only; phone count comes from `state`
const LIVE_WINDOW_MS = 5000;

const $ = (id) => document.getElementById(id);
const PRODUCT = require('./js/product');
{
  const t = $('productTitle');
  if (t) t.textContent = PRODUCT.name;
  for (const n of document.querySelectorAll('.brand-name')) n.textContent = PRODUCT.name;
}
const el = {
  pill: $('statusPill'), dot: $('statusDot'), text: $('statusText'), note: $('note'),
  helperCard: $('helperCard'), qrWrap: $('qrWrap'), qr: $('qrCode'),
  codeBlock: $('codeBlock'), code: $('sessionCode'), url: $('pairUrl'),
  doc: $('docLine'), phones: $('phones'), newCode: $('newCode'),
  size: $('size'), profile: $('profile'), profileNotice: $('profileNotice'),
  settingsBtn: $('settingsBtn'), settingsBody: $('settingsBody'),
};

const ui = {
  helperUp: false, // /api/session answered
  session: null,
  doc: null,
  lastFrameAt: 0,
  note: null,
  failures: 0,
  qrUrl: '',
  viewers: 0,
};
const settings = { size: 1600, profile: DEFAULT_PROFILE };

// ---------------------------------------------------------------- settings

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {};
    const size = Number(saved.size);
    if (size >= 600 && size <= 4000) settings.size = size;
    if (typeof saved.profile === 'string') settings.profile = saved.profile;
  } catch {
    /* settings are a convenience only */
  }
  el.size.value = String(settings.size);
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

async function loadProfiles() {
  const { srgb, p3 } = await capture.listProfiles();
  const menu = el.profile.querySelector('sp-menu');
  menu.textContent = '';
  const add = (value, label) => {
    const item = document.createElement('sp-menu-item');
    item.setAttribute('value', value);
    item.value = value; // some UXP builds read the property, others the attribute
    item.textContent = label;
    menu.appendChild(item);
  };
  add(srgb, 'sRGB · safe default');
  if (p3 && p3 !== srgb) add(p3, 'Display P3 · iPhone');
  const allowed = [srgb, p3].filter(Boolean);
  if (allowed.indexOf(settings.profile) === -1) settings.profile = srgb;
  el.profile.value = settings.profile;
  el.profileNotice.style.display = p3 ? 'none' : 'block';
  if (!p3) {
    el.profileNotice.textContent =
      'Display P3 is not installed in Windows, so sRGB is used. Install the Display P3 colour profile and reopen this panel to get it.';
  }
}

// ----------------------------------------------------------------- QR code

function renderQr(url) {
  ui.qrUrl = url;
  el.qr.textContent = '';
  if (!url || typeof qrcode !== 'function') return;
  let qr;
  try {
    qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
  } catch {
    return;
  }
  const count = qr.getModuleCount();
  const width = (document.body && document.body.clientWidth) || 300;
  const avail = Math.max(160, Math.min(520, width - 32));
  const cell = Math.max(2, Math.floor(avail / (count + 8))); // 4-module quiet zone each side
  el.qr.style.padding = cell * 4 + 'px';
  for (let r = 0; r < count; r++) {
    const row = document.createElement('div');
    row.className = 'qr-row';
    row.style.height = cell + 'px';
    for (let c = 0; c < count; c++) {
      const px = document.createElement('div');
      px.className = qr.isDark(r, c) ? 'qr-cell dark' : 'qr-cell';
      px.style.width = cell + 'px';
      px.style.height = cell + 'px';
      row.appendChild(px);
    }
    el.qr.appendChild(row);
  }
}

// ------------------------------------------------------------------ render

function render() {
  const connected = client.connected;
  const helperDown = !ui.helperUp && !connected && ui.failures >= 2;
  const live = connected && !!ui.doc && Date.now() - ui.lastFrameAt < LIVE_WINDOW_MS;

  el.text.textContent = live ? 'LIVE' : 'IDLE';
  el.dot.className = 'dot' + (live ? ' on' : '');
  el.pill.className = 'pill' + (live ? ' on' : '');

  el.helperCard.className = 'helper-card' + (helperDown ? ' visible' : '');

  const s = ui.session;
  const show = !!s && !helperDown;
  el.qrWrap.className = 'qr-wrap' + (show ? ' visible' : '');
  el.codeBlock.className = 'code-block' + (show ? ' visible' : '');
  if (show) {
    el.code.textContent = s.code || '';
    el.url.textContent = shortUrl(s.primaryUrl);
    if (s.primaryUrl !== ui.qrUrl) renderQr(s.primaryUrl);
  }

  el.doc.textContent = ui.doc ? docLine(ui.doc.name, ui.doc.width, ui.doc.height) : docLine(null);
  el.phones.textContent = s && !helperDown ? phonesText(ui.viewers) : '';

  if (ui.note && !helperDown) {
    el.note.textContent = ui.note;
    el.note.className = 'note err';
    el.note.style.display = 'block';
  } else {
    el.note.textContent = '';
    el.note.style.display = 'none';
  }
}

// ------------------------------------------------------------------ wiring

const client = new SourceClient({
  url: HELPER_WS,
  WebSocketImpl: WebSocket,
  host: { app: 'photoshop', appName: 'Photoshop', version: '' },
  onStatus: (status) => {
    if (status === 'connected') capture.invalidate(); // resend doc + frame after reconnects
    render();
  },
  onState: (state) => {
    if (typeof state.viewers === 'number') ui.viewers = state.viewers;
    // code or phone count changed: refresh code/URL now instead of waiting for the poll
    if (!ui.session || (state.code && state.code !== ui.session.code)) pollSession();
    render();
  },
  onError: (code) => {
    ui.note = 'Helper: ' + code;
    render();
  },
});

const capture = new PsCapture({
  client,
  getSettings: () => settings,
  onDoc: (info) => {
    ui.doc = info;
    render();
  },
  onFrame: (info) => {
    if (info.sent) {
      ui.lastFrameAt = Date.now();
      ui.note = null;
    }
    render();
  },
  onError: (text) => {
    ui.note = text;
    render();
  },
});

async function pollSession() {
  try {
    ui.session = await getSession(fetch);
    if (typeof ui.session.viewers === 'number' && !client.connected) ui.viewers = ui.session.viewers;
    ui.helperUp = true;
    ui.failures = 0;
  } catch {
    ui.helperUp = false;
    ui.failures++;
  }
  render();
}

el.newCode.addEventListener('click', async () => {
  try {
    ui.session = await newSession(fetch);
    ui.viewers = ui.session.viewers || 0;
    ui.helperUp = true;
    ui.note = null;
  } catch (error) {
    ui.note = 'Could not make a new code: ' + errorText(error);
  }
  render();
});

el.size.addEventListener('change', () => {
  settings.size = parseInt(el.size.value, 10) || 1600;
  saveSettings();
  capture.invalidate();
});
el.profile.addEventListener('change', () => {
  settings.profile = el.profile.value || settings.profile;
  saveSettings();
  capture.invalidate();
});
el.settingsBtn.addEventListener('click', () => {
  const open = el.settingsBody.style.display === 'none';
  el.settingsBody.style.display = open ? 'flex' : 'none';
  el.settingsBtn.textContent = open ? 'Settings ▾' : 'Settings ▸';
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => ui.qrUrl && renderQr(ui.qrUrl), 120);
});

loadSettings();
client.host = capture.hostInfo();
render();
pollSession();
setInterval(pollSession, SESSION_POLL_MS);
setInterval(render, 1000); // lets LIVE fall back to IDLE when frames stop
client.start();
capture.start();
setTimeout(loadProfiles, 0);
