'use strict';

// Pocket Monitor - Photoshop UXP panel (dedicated Photoshop helper on port 47823).
// Glue only: HTTP source client in js/http-source-client.js, Photoshop calls in js/ps-capture.js.

const { HttpSourceClient } = require('./js/http-source-client');
const { PsCapture, DEFAULT_PROFILE } = require('./js/ps-capture');
const { getSession, newSession } = require('./js/helper-api');
const { docLine, phonesText, shortUrl, errorText } = require('./js/format');

const SETTINGS_KEY = 'ot.photoshop.settings.v1';
const SESSION_POLL_MS = 2500;

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
  doc: $('docLine'), phones: $('phones'), newCode: $('newCode'), sendNow: $('sendNow'),
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
  if (el.size) el.size.value = String(settings.size);
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
  const menu = el.profile && el.profile.querySelector('sp-menu');
  if (!menu) return;
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
  const width = (document.body && document.body.clientWidth) || 260;
  const avail = Math.max(140, Math.min(190, width - 48));
  const cell = Math.max(2, Math.floor(avail / (count + 6)));
  el.qr.style.padding = cell * 3 + 'px';
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
  const helperDown = !ui.helperUp && ui.failures >= 2;
  const live = ui.helperUp && !!ui.doc && ui.lastFrameAt > 0;
  const ready = ui.helperUp && !live;

  el.text.textContent = live ? 'LIVE' : ready ? 'READY' : 'IDLE';
  el.dot.className = 'dot' + (live ? ' on' : ready ? ' warn' : '');
  el.pill.className = 'pill' + (live ? ' on' : ready ? ' warn' : '');

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

let psHost = null;
try {
  psHost = require('photoshop');
} catch (error) {
  ui.note = 'Could not load Photoshop API: ' + errorText(error);
}

const client = new HttpSourceClient({
  fetchImpl: fetch,
  host: { app: 'photoshop', appName: 'Photoshop', version: '' },
  onViewers: (n) => {
    ui.viewers = n;
    render();
  },
  onError: (text) => {
    ui.note = text;
    render();
  },
});

const capture = new PsCapture({
  client,
  ps: psHost,
  getSettings: () => settings,
  onDoc: (info) => {
    ui.doc = info;
    if (!info) ui.lastFrameAt = 0;
    client.log('doc=' + (info ? `${info.name} ${info.width}x${info.height} id=${info.id}` : 'none'));
    render();
  },
  onFrame: (info) => {
    if (info.sent) {
      ui.lastFrameAt = Date.now();
      ui.note = null;
      client.log(`frame sent ${info.width}x${info.height} (${info.bytes} B)`);
    }
    render();
  },
  onError: (text) => {
    ui.note = text;
    client.log('error: ' + text);
    render();
  },
});

async function pollSession() {
  try {
    const wasDown = !ui.helperUp;
    ui.session = await getSession(fetch);
    if (typeof ui.session.viewers === 'number') ui.viewers = ui.session.viewers;
    ui.helperUp = true;
    ui.failures = 0;
    if (wasDown) capture.invalidate();
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
    capture.invalidate();
  } catch (error) {
    ui.note = 'Could not make a new code: ' + errorText(error);
  }
  render();
});

if (el.sendNow) {
  el.sendNow.addEventListener('click', async () => {
    capture.invalidate();
    capture.tick();
    const ok = await capture.captureNow();
    if (!ok && !ui.doc && !ui.note) {
      let diag = 'no psHost';
      try {
        const a = psHost && psHost.app;
        diag = `app=${!!a} docs=${a && a.documents ? a.documents.length : 'n/a'} active=${!!(a && a.activeDocument)}`;
      } catch (e) {
        diag = errorText(e);
      }
      ui.note = 'No document detected (' + diag + ')';
      client.log('sendNow: ' + ui.note);
      render();
    }
  });
}

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

window.addEventListener('error', (ev) => {
  const msg = 'Panel error: ' + errorText(ev && (ev.error || ev.message));
  ui.note = msg;
  client.log(msg);
  render();
});
window.addEventListener('unhandledrejection', (ev) => {
  const msg = 'Panel async error: ' + errorText(ev && ev.reason);
  ui.note = msg;
  client.log(msg);
  render();
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
capture.start();
client.log('panel v0.3.4 started; host=' + JSON.stringify(client.host) + ' hasPs=' + Boolean(psHost));
setTimeout(loadProfiles, 0);
