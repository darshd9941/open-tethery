// Open Tethery phone viewer: wires the UI to the helper (docs/PROTOCOL.md v1).
import { bus } from './bus.js';
import { setStage, publishFrame, publishLayout, getStage } from './frame-bus.js';
import { parseOTV1 } from './otv1.js';
import { codeFromPath, editCode, lockText, CODE_LENGTH } from './code.js';
import { formatTimecode, formatFps, formatClock, frameFileName } from './timecode.js';
import { fitRect } from './layout.js';
import { createConnection } from './net.js';
import { createWebRtcTransport, isSupported as webrtcSupported } from './transport-webrtc.js';
import { createAudioPlayer } from './audio.js';
import { createTransport, controlState, errorText } from './transport.js';
import { createStats } from './stats.js';
import { createGestures } from './gestures.js';
import { saveFrame, shareLink } from './share.js';
import { guessDeviceName } from './device.js';
import { store } from './storage.js';

const $ = (id) => document.getElementById(id);
const KEY_CODE = 'ot.lastCode';
const KEY_SYNC = 'ot.syncMs';
const KEY_VOL = 'ot.volume';
const APP_NAMES = { premiere: 'Premiere Pro', aftereffects: 'After Effects', photoshop: 'Photoshop' };
const ENGINE_HINTS = {
  premiere: 'In Premiere Pro: Edit > Preferences > Playback, tick Open Tethery under Video Device.',
  aftereffects: 'In After Effects: Edit > Preferences > Video Preview, choose Open Tethery.',
};

const app = $('app');
const stage = $('stage');
const canvas = $('canvas');
const pic = $('pic');
const ctx2d = canvas.getContext('2d');
setStage($('overlayStage'));

let conn = null;
let code = null;
let welcome = null;
let control = false;
let state = null;
let hasFrame = false;
let curTime = NaN;
let scrubbing = false;
let picSrc = { w: 16, h: 9 };
let lastBitmap = null;

const stats = createStats();

// Hidden <video> that receives the WebRTC stream; its frames are drawn onto the canvas (see onRtcFrame).
const rtcVideo = document.createElement('video');
rtcVideo.muted = true;
rtcVideo.playsInline = true;
rtcVideo.autoplay = true;
rtcVideo.setAttribute('playsinline', '');
rtcVideo.setAttribute('aria-hidden', 'true');
rtcVideo.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
document.body.appendChild(rtcVideo);
const rtc = createWebRtcTransport({
  send: (m) => conn?.send(m),
  video: rtcVideo,
  onFrame: (v) => onRtcFrame(v),
  onActive: () => { pending = null; },
  log: (t) => console.info('[rtc]', t),
});
const audio = createAudioPlayer({ onLevels: (l) => bus.emit('audio-levels', l) });
const transport = createTransport({
  send: (m) => conn?.send(m),
  getTime: () => curTime,
  getDuration: () => state?.sequence?.duration,
});

// ---------------------------------------------------------------- small helpers

let toastTimer = null;
function toast(text, ms = 3200) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const hostApp = () => state?.host?.app;
const appName = () => state?.host?.appName || APP_NAMES[hostApp()] || 'the editor';
const pcName = () => welcome?.server?.pcName || welcome?.server?.host || location.hostname;

function seqFps() {
  const s = state?.sequence;
  if (!s) return NaN;
  if (Number.isFinite(s.fps)) return s.fps;
  return s.fpsNum && s.fpsDen ? s.fpsNum / s.fpsDen : NaN;
}

function currentTimecode() {
  if (!state) return '--:--:--:--';
  if (state.playing === false && state.timecode && !Number.isFinite(curTime)) return state.timecode;
  if (Number.isFinite(curTime)) return formatTimecode(curTime, seqFps());
  return state.timecode || '--:--:--:--';
}

// ---------------------------------------------------------------- cover / banner

function setCover(title, text, { spin = true, over = false } = {}) {
  $('cover').hidden = false;
  $('cover').classList.toggle('over-picture', over);
  $('coverTitle').textContent = title;
  const p = $('coverText');
  p.replaceChildren();
  for (const line of [].concat(text || [])) {
    const el = document.createElement('p');
    el.textContent = line;
    p.appendChild(el);
  }
  $('coverSpin').classList.toggle('stopped', !spin);
}

function updateCover() {
  if (hasFrame) { $('cover').hidden = true; return; }
  if (!conn?.welcomed) return;
  const lines = [];
  const hint = ENGINE_HINTS[hostApp()];
  if (state?.engine && state.engine.transmit === false) {
    lines.push(hint || 'Open Premiere Pro or After Effects and turn on Open Tethery in its preferences.');
  } else if (state?.status === 'live') {
    lines.push('The picture will appear in a moment.');
  } else {
    lines.push('Open a sequence in the editor and press play, or move the playhead.');
  }
  setCover(`Connected, waiting for picture — ${pcName()}`, lines);
}

function setBanner(text) {
  const b = $('banner');
  b.hidden = !text;
  if (text) b.textContent = text;
}

// ---------------------------------------------------------------- now playing

function updateNowPlaying() {
  const online = !!conn?.welcomed && !offline;
  const badge = $('liveBadge');
  const live = online && state?.status === 'live';
  badge.textContent = !online ? 'OFFLINE' : live ? 'LIVE' : 'IDLE';
  badge.className = 'badge' + (live ? ' live' : !online ? ' off' : '');

  $('npApp').textContent = state?.host ? appName() : '';
  $('npSeq').textContent = state ? (state.sequence?.name || 'No sequence') : (conn?.welcomed ? 'Waiting…' : 'Connecting…');

  const s = state?.sequence;
  const aspect = $('npAspect');
  aspect.hidden = !s?.aspect;
  aspect.textContent = s?.aspect || '';
  const fps = formatFps(seqFps());
  $('npRes').textContent = s?.width && s?.height ? `${s.width}×${s.height}${fps ? ' @ ' + fps : ''}` : '';
  $('npPlay').textContent = state && typeof state.playing === 'boolean' && hostApp() !== 'photoshop'
    ? (state.playing ? '▶ Playing' : '❚❚ Paused') : '';
  updateTimecode();
}

let lastTc = '';
function updateTimecode() {
  const tc = hostApp() === 'photoshop' ? '' : currentTimecode();
  if (tc === lastTc) return;
  lastTc = tc;
  $('npTc').textContent = tc;
}

let offline = false;

// ---------------------------------------------------------------- transport bar

const tpButtons = ['tpStart', 'tpBack5', 'tpBack1', 'tpPlay', 'tpFwd1', 'tpFwd5', 'tpEnd'];

function updateTransport() {
  const cs = controlState({ control, state });
  $('transport').hidden = hostApp() === 'photoshop'; // nothing to play in Photoshop
  for (const id of tpButtons) $(id).disabled = !cs.enabled;
  $('scrub').disabled = !cs.enabled || !(state?.sequence?.duration > 0);
  const note = $('tpNote');
  note.hidden = cs.enabled || !cs.note;
  note.textContent = cs.note;
  const playing = !!state?.playing;
  $('tpPlayIcon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('tpPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const dur = state?.sequence?.duration;
  $('scrub').max = String(dur > 0 ? dur : 1);
  $('scrubDur').textContent = formatClock(dur);
  if (!scrubbing) {
    $('scrub').value = String(Number.isFinite(curTime) ? curTime : 0);
    $('scrubCur').textContent = formatClock(curTime);
  }
}

$('tpPlay').addEventListener('click', () => (state?.playing ? transport.pause() : transport.play()));
$('tpBack1').addEventListener('click', () => transport.step(-1));
$('tpFwd1').addEventListener('click', () => transport.step(1));
$('tpBack5').addEventListener('click', () => transport.skip(-5));
$('tpFwd5').addEventListener('click', () => transport.skip(5));
$('tpStart').addEventListener('click', () => transport.jump('start'));
$('tpEnd').addEventListener('click', () => transport.jump('end'));

let scrubTimer = null;
$('scrub').addEventListener('input', (e) => {
  scrubbing = true;
  clearTimeout(scrubTimer);
  const v = parseFloat(e.target.value);
  $('scrubCur').textContent = formatClock(v);
  transport.scrub(v);
});
$('scrub').addEventListener('change', () => {
  transport.endScrub();
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => { scrubbing = false; }, 400);
});

// ---------------------------------------------------------------- sound

function soundBlocked() {
  if (!state) return null;
  if (hostApp() === 'aftereffects' || state.audio?.available === false) return `No sound from ${appName()}`;
  return null;
}

function updateSound() {
  const blocked = soundBlocked();
  if (blocked && audio.on) setSound(false);
  const btn = $('btnSound');
  btn.setAttribute('aria-pressed', String(audio.on));
  btn.style.opacity = blocked ? '0.45' : '';
  $('soundLabel').textContent = blocked ? 'No sound' : audio.on ? 'Sound on' : 'Sound';
  $('soundIcon').setAttribute('href', audio.on ? '#i-speaker' : '#i-speaker-off');
  $('soundRow').hidden = !audio.on;
}

function setSound(on) {
  if (!on) audio.disable();
  conn?.send({ t: 'audio', on });
  updateSound();
}

$('btnSound').addEventListener('click', async () => {
  const blocked = soundBlocked();
  if (blocked) { toast(blocked); return; }
  if (audio.on) { setSound(false); return; }
  try {
    await audio.enable(); // first call runs inside the tap, which unlocks iOS audio
    setSound(true);
    toast('Sound on. If you hear nothing, check your phone is not on silent.', 4000);
  } catch (e) {
    toast(e.message || 'Could not start sound.');
  }
});

const volEl = $('vol');
const syncEl = $('sync');
const savedVol = parseFloat(store.get(KEY_VOL));
if (Number.isFinite(savedVol)) volEl.value = String(savedVol);
const savedSync = parseInt(store.get(KEY_SYNC), 10);
if (Number.isFinite(savedSync)) syncEl.value = String(savedSync);
function applySound() {
  audio.setVolume(parseFloat(volEl.value));
  const ms = parseInt(syncEl.value, 10);
  audio.setOffsetMs(ms);
  $('syncOut').textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
}
volEl.addEventListener('input', () => { store.set(KEY_VOL, volEl.value); applySound(); });
syncEl.addEventListener('input', () => { store.set(KEY_SYNC, syncEl.value); applySound(); });
applySound();

// ---------------------------------------------------------------- picture

function layoutPic() {
  const r = fitRect(stage.clientWidth, stage.clientHeight, picSrc.w, picSrc.h);
  pic.style.left = r.x + 'px';
  pic.style.top = r.y + 'px';
  pic.style.width = r.w + 'px';
  pic.style.height = r.h + 'px';
  gestures.relayout();
  publishLayout(r);
  bus.emit('layout', r);
}

const gestures = createGestures({
  stage,
  zoomEl: $('zoom'),
  getContent: () => ({ w: pic.offsetWidth, h: pic.offsetHeight, srcW: picSrc.w }),
  onTap: () => setUi(app.dataset.ui !== 'shown'),
});

new ResizeObserver(layoutPic).observe(stage);

function setUi(shown) {
  app.dataset.ui = shown ? 'shown' : 'hidden';
}

async function decodeJpeg(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch { /* fall back below */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Newest frame wins while a decode is in flight.
let decoding = false;
let pending = null;
async function pump() {
  decoding = true;
  try {
    while (pending) {
      const p = pending;
      pending = null;
      const t0 = performance.now();
      let img;
      try { img = await decodeJpeg(p.jpeg); } catch { continue; }
      enqueue({ img, p, decodeMs: performance.now() - t0 });
    }
  } finally {
    decoding = false;
  }
}

// While sound is on, the picture is held back a little so it lines up with the audio buffer.
const queue = [];
let rafId = 0;
function enqueue(f) {
  const delay = audio.videoDelayMs();
  if (delay <= 0 && !queue.length) { present(f); return; }
  queue.push({ at: performance.now() + delay, f });
  if (!rafId) rafId = requestAnimationFrame(drain);
}
function drain() {
  rafId = 0;
  const now = performance.now();
  let due = null;
  while (queue.length && queue[0].at <= now) {
    if (due) closeImage(due.img);
    due = queue.shift().f;
  }
  if (due) present(due);
  if (queue.length) rafId = requestAnimationFrame(drain);
}
function closeImage(img) { if (img && typeof img.close === 'function') img.close(); }

// One decoded video frame from the WebRTC stream. Picture size follows the stream; the aspect used for
// letter-boxing is the sequence's when it matches (same as for JPEG frames).
let rtcSeq = 0;
function onRtcFrame(v) {
  const w = v.videoWidth;
  const h = v.videoHeight;
  const seqW = state?.sequence?.width;
  const seqH = state?.sequence?.height;
  const sameAspect = seqW && seqH && Math.abs(seqW / seqH - w / h) < 0.02;
  const p = { width: w, height: h, srcW: sameAspect ? seqW : w, srcH: sameAspect ? seqH : h, time: NaN, seq: ++rtcSeq };
  if (audio.videoDelayMs() <= 0 && !queue.length) { present({ img: v, p, decodeMs: 0 }); return; }
  // sound is on: hold the picture back like JPEG frames; the <video> keeps moving, so copy the frame
  createImageBitmap(v).then((img) => enqueue({ img, p, decodeMs: 0 }), () => {});
}

function present({ img, p, decodeMs }) {
  const w = img.videoWidth || img.width || p.width;
  const h = img.videoHeight || img.height || p.height;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx2d.drawImage(img, 0, 0, w, h);
  const srcW = p.srcW || w;
  const srcH = p.srcH || h;
  if (srcW !== picSrc.w || srcH !== picSrc.h) { picSrc = { w: srcW, h: srcH }; layoutPic(); }
  hasFrame = true;
  if (Number.isFinite(p.time)) curTime = p.time;
  stats.frameShown(decodeMs);

  closeImage(lastBitmap);
  const isBitmap = typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap;
  lastBitmap = isBitmap ? img : null;
  publishFrame({ bitmap: lastBitmap, canvas, width: w, height: h, srcW, srcH, time: p.time, seq: p.seq });
  bus.emit('frame', { image: img, width: w, height: h, srcW, srcH, time: p.time, seq: p.seq });

  updateCover();
  updateTimecode();
  if (!scrubbing) updateTransport();
}

// ---------------------------------------------------------------- session

function onBinary(buf) {
  const m = parseOTV1(buf);
  if (!m) return;
  if (m.kind === 'video') {
    if (rtc.active) return; // WebRTC carries the picture; a late JPEG would flicker
    pending = m;
    if (!decoding) pump();
  } else if (audio.on) {
    audio.push(m);
  }
}

function onMessage(msg) {
  if (rtc.handleMessage(msg)) return;
  switch (msg.t) {
    case 'webrtc':
      rtc.setAvailable(msg.available === true);
      break;
    case 'state':
      state = msg;
      if (state.playing === false && Number.isFinite(state.time)) curTime = state.time;
      else if (!Number.isFinite(curTime) && Number.isFinite(state.time)) curTime = state.time;
      bus.emit('state', state);
      bus.emit('conn', { status: state.status === 'live' ? 'live' : 'idle' });
      updateNowPlaying();
      updateTransport();
      updateSound();
      updateCover();
      break;
    case 'perm':
      control = !!msg.control;
      updateTransport();
      break;
    case 'stats':
      stats.setServer(msg);
      break;
    case 'control-ack':
      if (msg.ok === false) toast(`The ${msg.cmd || 'command'} did not work.`);
      break;
    case 'error':
      toast(errorText(msg.code, msg.cmd));
      break;
    default:
      break;
  }
}

function startSession(c) {
  code = c;
  $('entry').hidden = true;
  app.hidden = false;
  if (codeFromPath(location.pathname) !== c) {
    try { history.replaceState(null, '', `/c/${c}`); } catch { /* ignore */ }
  }
  setCover('Connecting…', 'Make sure your PC is on and on the same Wi-Fi.');
  const name = guessDeviceName(navigator.userAgent);
  conn = createConnection({
    code: c,
    name,
    accept: webrtcSupported() ? ['jpeg', 'pcm', 'webrtc'] : ['jpeg', 'pcm'],
    handlers: {
      onStatus(status, info) {
        offline = status === 'reconnecting';
        if (status !== 'open') rtc.connectionLost();
        if (status === 'reconnecting') {
          bus.emit('conn', { status: 'connecting', detail: 'reconnecting' });
          if (hasFrame) setBanner('Connection lost. Reconnecting…');
          else setCover('Connection lost', 'Trying to reconnect. Keep this page open.');
        } else if (status === 'open') {
          setBanner('');
        }
        updateNowPlaying();
      },
      onWelcome(msg) {
        welcome = msg;
        control = !!msg.control;
        rtc.setAvailable(msg.webrtc === true);
        store.set(KEY_CODE, c);
        const dpr = window.devicePixelRatio || 1;
        conn.send({ t: 'info', name, w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) });
        if (audio.on) conn.send({ t: 'audio', on: true });
        updateNowPlaying();
        updateTransport();
        updateCover();
      },
      onMessage,
      onBinary,
      onPong: (rtt) => stats.pong(rtt),
      onFatal(errCode, info) { showEntry({ error: errCode, retryInSec: info?.retryInSec }); },
    },
  });
  conn.start();
}

// ---------------------------------------------------------------- code entry

const boxes = Array.from(document.querySelectorAll('.code-box'));
let chars = Array(CODE_LENGTH).fill('');
let lockTimer = null;
let lockedUntil = 0;

function renderBoxes() {
  boxes.forEach((b, i) => { b.value = chars[i]; });
  $('entryGo').disabled = !chars.every(Boolean) || Date.now() < lockedUntil;
}

function setEntryError(text) {
  const el = $('entryError');
  el.hidden = !text;
  el.textContent = text || '';
  $('codeBoxes').classList.toggle('bad', !!text);
}

function showEntry({ prefill, error, retryInSec } = {}) {
  conn?.stop();
  conn = null;
  welcome = null; state = null; hasFrame = false; curTime = NaN; offline = false;
  app.hidden = true;
  $('entry').hidden = false;
  clearInterval(lockTimer);
  lockedUntil = 0;
  setEntryError('');
  chars = Array(CODE_LENGTH).fill('');
  if (prefill) chars = editCode(chars, 0, prefill).chars;
  if (error === 'bad-code') {
    if (store.get(KEY_CODE) === code) store.remove(KEY_CODE);
    chars = Array(CODE_LENGTH).fill('');
    setEntryError("That code isn't right. Check the 4 characters in the Open Tethery panel on your PC.");
  } else if (error === 'locked') {
    lockedUntil = Date.now() + (retryInSec || 60) * 1000;
    const tick = () => {
      const left = (lockedUntil - Date.now()) / 1000;
      if (left <= 0) { clearInterval(lockTimer); setEntryError(''); renderBoxes(); return; }
      setEntryError(lockText(left));
      renderBoxes();
    };
    tick();
    lockTimer = setInterval(tick, 500);
  } else if (error === 'bad-link') {
    setEntryError('That link has an invalid code. Type the code from your PC instead.');
  }
  renderBoxes();
  const first = boxes[chars.findIndex((c) => !c)] || boxes[CODE_LENGTH - 1];
  setTimeout(() => first.focus(), 50);
}

function applyEdit(index, text) {
  const r = editCode(chars, index, text);
  chars = r.chars;
  setEntryError('');
  renderBoxes();
  boxes[r.focus].focus();
  if (r.complete && Date.now() >= lockedUntil) submitCode();
}

function submitCode() {
  if (!chars.every(Boolean) || Date.now() < lockedUntil) return;
  startSession(chars.join(''));
}

boxes.forEach((box, i) => {
  box.addEventListener('focus', () => box.select());
  box.addEventListener('input', () => {
    const v = box.value;
    if (!v) { chars[i] = ''; renderBoxes(); return; }
    box.value = chars[i]; // restore, then let editCode decide
    applyEdit(i, v.length > 1 && chars[i] && v.startsWith(chars[i]) ? v.slice(chars[i].length) : v);
  });
  box.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text') || '';
    applyEdit(text.length > 1 ? 0 : i, text);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !chars[i] && i > 0) {
      chars[i - 1] = '';
      renderBoxes();
      boxes[i - 1].focus();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
    else if (e.key === 'ArrowRight' && i < CODE_LENGTH - 1) boxes[i + 1].focus();
    else if (e.key === 'Enter') submitCode();
  });
});
$('entryGo').addEventListener('click', submitCode);

// ---------------------------------------------------------------- stats sheet

let statsTimer = null;
function renderStats() {
  const s = stats.snapshot();
  const sv = s.server || {};
  const n = (v, d = 0, unit = '') => (Number.isFinite(v) ? v.toFixed(d) + unit : '–');
  const rows = [
    ['Frame rate (shown)', n(s.fps, 1, ' fps')],
    ['Frame rate (from PC)', n(sv.fps, 1, ' fps')],
    ['Picture size', picSrc ? `${canvas.width}×${canvas.height}` : '–'],
    ['Data rate', n(sv.kbps, 0, ' kbps')],
    ['Transport', sv.transport || 'jpeg'],
    ['Delay', n(s.delayMs, 0, ' ms')],
    ['Decode time', n(s.decodeMs, 1, ' ms')],
    ['Dropped (last sec)', n(sv.dropped, 0)],
    ['Viewers', n(sv.viewers ?? state?.viewers, 0)],
  ];
  const dl = $('statsList');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}
function openSheet(id) { $(id).hidden = false; }
function closeSheets() {
  for (const el of document.querySelectorAll('.sheet')) el.hidden = true;
  clearInterval(statsTimer);
}
$('btnStats').addEventListener('click', () => {
  renderStats();
  openSheet('sheetStats');
  clearInterval(statsTimer);
  statsTimer = setInterval(renderStats, 500);
});
for (const sheet of document.querySelectorAll('.sheet')) {
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) closeSheets();
  });
}

// ---------------------------------------------------------------- overlays

// One path: js/overlays/index.js mounts social frames, guides, scopes/exposure and info (see CONTRACT.md).
// It is loaded at start so saved overlays come back; the Overlays button only opens the sheet.
const overlaysReady = import('/js/overlays/index.js').then(async (mod) => {
  await mod.init({
    bus, getStage, layer: getStage(), panel: $('overlaysPanel'), dock: $('dock'), toast,
    saveFrame: (opts) => doSave(opts),
  });
  return mod;
}).catch((e) => { console.error('overlays failed to start', e); return null; });

$('btnOverlays').addEventListener('click', async () => {
  const mod = await overlaysReady;
  if (!mod) { toast('Overlays could not start.'); return; }
  openSheet('sheetOverlays');
  mod.open?.();
});

// ---------------------------------------------------------------- save / share / fullscreen

async function doSave({ overlays = false } = {}) {
  if (!hasFrame) { toast('No picture to save yet.'); return; }
  try {
    let src = canvas;
    let name = frameFileName(state?.sequence?.name, currentTimecode());
    if (overlays) {
      const mod = await overlaysReady;
      if (mod?.composite) src = await mod.composite(canvas);
      name = name.replace(/\.png$/, '_overlays.png');
      closeSheets();
    }
    const r = await saveFrame(src, name);
    if (r === 'downloaded') toast('Frame saved to your downloads.');
    else if (r === 'shared') toast('Frame ready to save.');
  } catch (e) {
    toast(e.message || 'Could not save the frame.');
  }
}
$('btnSave').addEventListener('click', () => doSave());

$('btnShare').addEventListener('click', async () => {
  if (!code) return;
  const r = await shareLink(`${location.origin}/c/${code}`, 'Open Tethery stream');
  if (r === 'copied') toast('Link copied.');
  else if (r === 'failed') toast(`Link: ${location.origin}/c/${code}`, 8000);
});

const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
$('btnFull').addEventListener('click', async () => {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  try {
    if (fsElement()) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (req) {
      await req.call(el);
    } else {
      // iPhone Safari has no Fullscreen API for pages: just hide our controls.
      setUi(false);
      toast('Tap the picture to bring the controls back.');
    }
  } catch {
    setUi(false);
    toast('Tap the picture to bring the controls back.');
  }
});
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => setUi(!fsElement()));
}

// ---------------------------------------------------------------- telemetry, wake lock, lifecycle

setInterval(() => {
  if (!conn?.welcomed) return;
  const s = stats.snapshot();
  const dpr = window.devicePixelRatio || 1;
  const msg = { t: 'telemetry', w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) };
  msg.fps = Math.round(s.fps * 10) / 10;
  if (Number.isFinite(s.delayMs)) msg.delayMs = s.delayMs;
  if (Number.isFinite(s.decodeMs)) msg.decodeMs = Math.round(s.decodeMs * 10) / 10;
  conn.send(msg);
}, 2000);

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  requestWakeLock();
  audio.resume();
  conn?.nudge();
});
window.addEventListener('pageshow', () => conn?.nudge());

// ---------------------------------------------------------------- boot

updateSound();
updateTransport();
requestWakeLock();
const pathCode = codeFromPath(location.pathname);
if (pathCode) startSession(pathCode);
else showEntry({
  prefill: store.get(KEY_CODE),
  error: location.pathname.startsWith('/c/') ? 'bad-link' : undefined,
});

// Handy for debugging and for the smoke test.
window.__tethery = { bus, get state() { return state; } };
