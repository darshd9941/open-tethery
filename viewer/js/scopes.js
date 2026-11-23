// Scopes and exposure helpers, all computed on the phone from the decoded picture.
// Widgets (histogram, waveform, vectorscope, audio meters, false-colour legend) float in `dock` and are
// draggable; false colour and zebras are a full-picture canvas in `layer`.
import { store } from './storage.js';
import { getLatestFrame } from './frame-bus.js';
import { h, toggleRow, chips, sliderRow, section, loadJson } from './ui-kit.js';
import {
  analyse, analysisSize, arrayMax, BAR_TARGETS, skinLineEnd, VEC_SIZE, FALSE_COLOUR_BANDS,
  falseColourImage, zebraMask, levelToMeter,
} from './scope-math.js';

const KEY_CFG = 'ot.scopes.cfg';
const KEY_POS = 'ot.scopes.pos';
const WIDTHS = [104, 160, 236]; // small, medium, large (CSS px)
const MIN_INTERVAL = 100; // ms: at most ~10 analyses per second
const ANALYSIS_W = 320;

const KINDS = {
  hist: { label: 'Histogram', ratio: 0.5 },
  wave: { label: 'Waveform', ratio: 0.62 },
  vec: { label: 'Vectorscope', ratio: 1 },
  audio: { label: 'Audio', ratio: 0.42 },
  legend: { label: 'False colour', ratio: 1.2 },
};
const HIST_MODES = [{ value: 'luma', label: 'Luma' }, { value: 'rgb', label: 'RGB' }, { value: 'parade', label: 'Parade' }];

const DEFAULTS = () => ({
  widgets: { hist: { on: false, size: 1, mode: 'luma' }, wave: { on: false, size: 1 }, vec: { on: false, size: 1 }, audio: { on: false, size: 1 } },
  falseColour: false,
  zebra: { on: false, thr: 95 },
});

export function mergeScopeConfig(saved) {
  const c = DEFAULTS();
  if (!saved || typeof saved !== 'object') return c;
  for (const k of Object.keys(c.widgets)) Object.assign(c.widgets[k], saved.widgets?.[k] || {});
  for (const k of Object.keys(c.widgets)) {
    c.widgets[k].size = [0, 1, 2].includes(c.widgets[k].size) ? c.widgets[k].size : 1;
    c.widgets[k].on = !!c.widgets[k].on;
  }
  if (!HIST_MODES.some((m) => m.value === c.widgets.hist.mode)) c.widgets.hist.mode = 'luma';
  c.falseColour = !!saved.falseColour;
  if (saved.zebra) { c.zebra.on = !!saved.zebra.on; c.zebra.thr = Math.min(100, Math.max(70, +saved.zebra.thr || 95)); }
  return c;
}

const SKIN = 'rgba(255,200,150,.9)';

function drawHist(ctx, W, H, res, mode) {
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.lineWidth = 1;
  const panes = mode === 'parade' ? 3 : 1;
  const pw = W / panes;
  const bars = (arr, x0, w, colour) => {
    const m = Math.max(1, arrayMax(arr));
    ctx.fillStyle = colour;
    const bw = w / 256;
    for (let i = 0; i < 256; i++) {
      const v = Math.sqrt(arr[i] / m);
      if (v > 0) ctx.fillRect(x0 + i * bw, H - v * (H - 2), Math.max(1, bw), v * (H - 2));
    }
  };
  for (let p = 0; p < panes; p++) for (const f of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(p * pw + f * pw, 0); ctx.lineTo(p * pw + f * pw, H); ctx.stroke(); }
  if (!res?.hist) return;
  if (mode === 'luma') bars(res.hist.luma, 0, W, 'rgba(235,235,235,.9)');
  else if (mode === 'rgb') {
    ctx.globalCompositeOperation = 'lighter';
    bars(res.hist.r, 0, W, 'rgba(255,40,40,.75)'); bars(res.hist.g, 0, W, 'rgba(40,255,40,.75)'); bars(res.hist.b, 0, W, 'rgba(60,90,255,.85)');
    ctx.globalCompositeOperation = 'source-over';
  } else {
    bars(res.hist.r, 0, pw - 1, 'rgba(255,70,70,.9)'); bars(res.hist.g, pw, pw - 1, 'rgba(70,255,70,.9)'); bars(res.hist.b, 2 * pw, pw - 1, 'rgba(90,120,255,.95)');
  }
}

const tmp = () => document.createElement('canvas');
let waveCanvas = null;
function drawWave(ctx, W, H, res) {
  ctx.clearRect(0, 0, W, H);
  if (res?.wave) {
    const cols = res.w;
    waveCanvas = waveCanvas || tmp();
    waveCanvas.width = cols; waveCanvas.height = 256;
    const img = waveCanvas.getContext('2d').createImageData(cols, 256);
    const gain = 5 / Math.max(1, res.h);
    for (let x = 0; x < cols; x++) {
      for (let l = 0; l < 256; l++) {
        const n = res.wave[x * 256 + l];
        if (!n) continue;
        const a = 1 - Math.exp(-n * gain);
        const o = ((255 - l) * cols + x) * 4;
        img.data[o] = 120; img.data[o + 1] = 255; img.data[o + 2] = 140; img.data[o + 3] = Math.round(40 + 215 * a);
      }
    }
    waveCanvas.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(waveCanvas, 0, 0, W, H);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.2)';
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.font = '9px sans-serif';
  for (const p of [0, 25, 50, 75, 100]) {
    const y = Math.min(H - 0.5, Math.max(0.5, H - (p / 100) * H));
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    if (W > 120) ctx.fillText(String(p), 2, Math.min(H - 2, Math.max(9, y - 1)));
  }
}

let vecCanvas = null;
function drawVec(ctx, W, H, res) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.fillRect(0, 0, W, H);
  if (res?.vec) {
    vecCanvas = vecCanvas || tmp();
    vecCanvas.width = vecCanvas.height = VEC_SIZE;
    const vctx = vecCanvas.getContext('2d');
    const img = vctx.createImageData(VEC_SIZE, VEC_SIZE);
    const m = Math.max(1, arrayMax(res.vec));
    for (let i = 0; i < res.vec.length; i++) {
      if (!res.vec[i]) continue;
      const a = Math.min(1, 0.35 + Math.sqrt(res.vec[i] / m));
      img.data[i * 4] = 150; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 170; img.data[i * 4 + 3] = Math.round(a * 255);
    }
    vctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(vecCanvas, 0, 0, W, H);
  }
  const px = (cb) => (cb + 0.5) * W;
  const py = (cr) => (0.5 - cr) * H;
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.5 - 1, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.25, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  const e = skinLineEnd(0.5);
  ctx.strokeStyle = SKIN;
  ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(px(e.cb) , py(e.cr)); ctx.stroke();
  const box = Math.max(5, W * 0.06);
  ctx.font = `${Math.max(8, Math.round(W * 0.07))}px sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  for (const t of BAR_TARGETS) {
    ctx.strokeRect(px(t.cb) - box / 2, py(t.cr) - box / 2, box, box);
    if (W > 120) ctx.fillText(t.name, px(t.cb) + box / 2 + 1, py(t.cr) - box / 2);
  }
}

function drawAudio(ctx, W, H, st, now) {
  ctx.clearRect(0, 0, W, H);
  const fresh = st && now - st.at < 1200;
  const rowH = (H - 6) / 2;
  const rows = [['L', st?.l, st?.hold?.[0]], ['R', st?.r, st?.hold?.[1]]];
  ctx.font = '10px sans-serif';
  rows.forEach(([name, v, hold], i) => {
    const y = 2 + i * (rowH + 2);
    const x0 = 14, bw = W - x0 - 3;
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillText(name, 2, y + rowH * 0.8);
    ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.fillRect(x0, y, bw, rowH);
    if (fresh) {
      const f = levelToMeter(v);
      const grad = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
      grad.addColorStop(0, '#34d399'); grad.addColorStop(0.75, '#f5d90a'); grad.addColorStop(1, '#f87171');
      ctx.fillStyle = grad; ctx.fillRect(x0, y, bw * f, rowH);
      ctx.fillStyle = '#fff'; ctx.fillRect(x0 + bw * Math.min(1, levelToMeter(hold)) - 1.5, y, 2, rowH);
    }
  });
  if (!fresh) {
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.font = '9px sans-serif';
    ctx.fillText('Turn Sound on', 16, H / 2 + 3);
  }
}

function drawLegend(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  const n = FALSE_COLOUR_BANDS.length;
  const rh = H / n;
  ctx.font = `${Math.max(8, Math.min(11, rh * 0.62))}px sans-serif`;
  FALSE_COLOUR_BANDS.slice().reverse().forEach((b, i) => {
    const y = i * rh;
    ctx.fillStyle = b.rgb ? `rgb(${b.rgb})` : 'rgb(120,120,120)';
    ctx.fillRect(0, y + 1, 12, rh - 2);
    ctx.fillStyle = '#fff';
    ctx.fillText(b.label.replace(/\s{2,}/g, ' '), 16, y + rh * 0.68);
  });
}

export function initScopes({ bus, layer, panel, dock }) {
  const cfg = mergeScopeConfig(loadJson(KEY_CFG, null, store));
  const positions = loadJson(KEY_POS, {}, store);
  const save = () => store.set(KEY_CFG, JSON.stringify(cfg));
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);

  // ---- analysis source and worker
  const small = tmp();
  const sctx = small.getContext('2d', { willReadFrequently: true });
  let worker = null;
  try { worker = new Worker('/js/scope-worker.js', { type: 'module' }); } catch { worker = null; }
  let busy = false;
  let reqId = 0;
  let result = null;
  let lastRun = 0;
  let audio = { l: 0, r: 0, hold: [0, 0], at: 0 };
  const widgets = new Map(); // kind -> { el, canvas, ctx }

  const want = () => ({ hist: cfg.widgets.hist.on, wave: cfg.widgets.wave.on, vec: cfg.widgets.vec.on });
  const needsPixels = () => Object.values(want()).some(Boolean) || cfg.falseColour || cfg.zebra.on;

  function onResult(r) {
    result = r;
    busy = false;
    drawWidgets();
  }
  if (worker) {
    worker.onmessage = (e) => { if (e.data.id === reqId) onResult(e.data.result); else busy = false; };
    worker.onerror = () => { worker = null; busy = false; };
  }

  // ---- exposure overlay canvas (false colour / zebras)
  let expo = null;
  let layoutRect = bus.last('layout') || { w: layer.clientWidth || 0, h: layer.clientHeight || 0 };
  let stripe = null;
  function ensureExpo() {
    if (!expo) {
      expo = h('canvas', { class: 'ot-expo', 'data-ot-layer': 'exposure' });
      layer.appendChild(expo);
    }
    const d = dpr();
    const W = Math.max(1, Math.round((layoutRect.w || 1) * d)), H = Math.max(1, Math.round((layoutRect.h || 1) * d));
    if (expo.width !== W || expo.height !== H) { expo.width = W; expo.height = H; }
    expo.hidden = !(cfg.falseColour || cfg.zebra.on);
    return expo;
  }
  function stripePattern(ctx) {
    if (!stripe) {
      const c = tmp(); c.width = c.height = 12;
      const x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, 12, 12);
      x.strokeStyle = '#fff'; x.lineWidth = 4;
      x.beginPath(); x.moveTo(-2, 14); x.lineTo(14, -2); x.moveTo(-8, 14); x.lineTo(8, -2); x.moveTo(4, 18); x.lineTo(20, 2); x.stroke();
      stripe = c;
    }
    return ctx.createPattern(stripe, 'repeat');
  }
  let tint = null;
  function drawExposure(img) {
    const c = ensureExpo();
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!(cfg.falseColour || cfg.zebra.on)) return;
    tint = tint || tmp();
    tint.width = img.width; tint.height = img.height;
    const tctx = tint.getContext('2d');
    if (cfg.falseColour) {
      const out = tctx.createImageData(img.width, img.height);
      falseColourImage(img.data, out.data);
      tctx.putImageData(out, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tint, 0, 0, c.width, c.height);
    }
    if (cfg.zebra.on) {
      const out = tctx.createImageData(img.width, img.height);
      zebraMask(img.data, out.data, cfg.zebra.thr);
      tctx.putImageData(out, 0, 0);
      const z = tmp(); z.width = c.width; z.height = c.height;
      const zc = z.getContext('2d');
      zc.imageSmoothingEnabled = false;
      zc.drawImage(tint, 0, 0, c.width, c.height);
      zc.globalCompositeOperation = 'source-in';
      zc.fillStyle = stripePattern(zc);
      zc.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(z, 0, 0);
    }
  }

  // ---- frame handling
  function run(force) {
    if (!needsPixels()) return;
    const now = performance.now();
    if (!force && (now - lastRun < MIN_INTERVAL || busy)) return;
    const f = getLatestFrame();
    const src = f?.canvas;
    if (!src || !src.width) return;
    lastRun = now;
    const sz = analysisSize(src.width, src.height, ANALYSIS_W);
    if (small.width !== sz.w || small.height !== sz.h) { small.width = sz.w; small.height = sz.h; }
    sctx.drawImage(src, 0, 0, sz.w, sz.h);
    let img;
    try { img = sctx.getImageData(0, 0, sz.w, sz.h); } catch { return; }
    if (cfg.falseColour || cfg.zebra.on) drawExposure(img);
    const w = want();
    if (!Object.values(w).some(Boolean)) return;
    if (worker) {
      busy = true;
      reqId++;
      const copy = img.data.buffer.slice(0);
      worker.postMessage({ id: reqId, buffer: copy, w: sz.w, h: sz.h, want: w }, [copy]);
    } else {
      onResult(analyse(img.data, sz.w, sz.h, w));
    }
  }
  bus.on('frame', () => run(false));
  bus.on('layout', (r) => { layoutRect = r; if (cfg.falseColour || cfg.zebra.on) run(true); });
  bus.on('audio-levels', (a) => {
    audio.l = a.l; audio.r = a.r;
    audio.hold = [Math.max(a.peakL, audio.hold[0] * 0.97), Math.max(a.peakR, audio.hold[1] * 0.97)];
    audio.at = performance.now();
    if (cfg.widgets.audio.on && audio.at - (audio.drawn || 0) > 50) { audio.drawn = audio.at; drawWidgets(); }
  });

  // ---- widgets
  const dockRect = () => dock.getBoundingClientRect();
  function place(kind, el) {
    const dr = dockRect();
    const maxX = Math.max(0, dr.width - el.offsetWidth), maxY = Math.max(0, dr.height - el.offsetHeight);
    const p = positions[kind];
    let x, y;
    if (p) { x = p.x * dr.width; y = p.y * dr.height; } else {
      // first time: pack down the right-hand side, starting a new column to the left when full
      x = dr.width - 6; y = 6;
      let colW = 0;
      const order = [...widgets.keys()].filter((k) => !positions[k]);
      let cy = 6, cx = dr.width - 6;
      for (const k of order) {
        const e = widgets.get(k).el;
        if (cy + e.offsetHeight > dr.height - 6 && cy > 6) { cx -= colW + 6; cy = 6; colW = 0; }
        if (k === kind) { x = cx - e.offsetWidth; y = cy; break; }
        cy += e.offsetHeight + 6;
        colW = Math.max(colW, e.offsetWidth);
      }
    }
    el.style.left = Math.min(maxX, Math.max(0, x)) + 'px';
    el.style.top = Math.min(maxY, Math.max(0, y)) + 'px';
  }
  function sizeOf(kind) {
    const w = kind === 'legend' ? 150 : WIDTHS[cfg.widgets[kind].size];
    return { w, h: Math.round(w * KINDS[kind].ratio) };
  }
  function resizeCanvas(kind) {
    const wd = widgets.get(kind);
    const { w, h: hh } = sizeOf(kind);
    const d = dpr();
    wd.canvas.style.width = w + 'px'; wd.canvas.style.height = hh + 'px';
    wd.canvas.width = Math.round(w * d); wd.canvas.height = Math.round(hh * d);
    wd.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  function makeWidget(kind) {
    const canvas = h('canvas', { class: 'sc-canvas' });
    const title = h('span', { class: 'sc-title' }, KINDS[kind].label);
    const head = h('div', { class: 'sc-head' }, title);
    const extra = [];
    if (kind !== 'legend') {
      extra.push(h('button', { type: 'button', class: 'sc-btn', 'aria-label': `${KINDS[kind].label} size`, onclick: () => {
        cfg.widgets[kind].size = (cfg.widgets[kind].size + 1) % 3; save(); resizeCanvas(kind); place(kind, el); drawWidgets();
      } }, 'S/M/L'));
    }
    extra.push(h('button', { type: 'button', class: 'sc-btn', 'aria-label': `Close ${KINDS[kind].label}`, onclick: () => setWidget(kind, false) }, '×'));
    head.append(...extra);
    const el = h('div', { class: `sc-widget sc-${kind}`, 'data-scope': kind }, head, canvas);
    wireDrag(kind, el, head);
    dock.appendChild(el);
    widgets.set(kind, { el, canvas, ctx: canvas.getContext('2d') });
    resizeCanvas(kind);
    place(kind, el);
  }
  function wireDrag(kind, el, handle) {
    let drag = null;
    // core's pan/zoom gestures live on #stage: keep widget touches away from them
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) el.addEventListener(t, (e) => e.stopPropagation());
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const dr = dockRect();
      drag = { dx: e.clientX - el.getBoundingClientRect().left, dy: e.clientY - el.getBoundingClientRect().top, dr };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.min(drag.dr.width - el.offsetWidth, Math.max(0, e.clientX - drag.dr.left - drag.dx));
      const y = Math.min(drag.dr.height - el.offsetHeight, Math.max(0, e.clientY - drag.dr.top - drag.dy));
      el.style.left = x + 'px'; el.style.top = y + 'px';
    });
    const end = () => {
      if (!drag) return;
      positions[kind] = { x: el.offsetLeft / drag.dr.width, y: el.offsetTop / drag.dr.height };
      store.set(KEY_POS, JSON.stringify(positions));
      drag = null;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function removeWidget(kind) {
    const wd = widgets.get(kind);
    if (wd) { wd.el.remove(); widgets.delete(kind); }
  }
  function drawWidgets() {
    const now = performance.now();
    for (const [kind, wd] of widgets) {
      const { w, h: hh } = sizeOf(kind);
      if (kind === 'hist') drawHist(wd.ctx, w, hh, result, cfg.widgets.hist.mode);
      else if (kind === 'wave') drawWave(wd.ctx, w, hh, result);
      else if (kind === 'vec') drawVec(wd.ctx, w, hh, result);
      else if (kind === 'audio') drawAudio(wd.ctx, w, hh, audio, now);
      else if (kind === 'legend') drawLegend(wd.ctx, w, hh);
    }
  }

  const ui = {};
  function setWidget(kind, on) {
    cfg.widgets[kind].on = on; save();
    if (on && !widgets.has(kind)) makeWidget(kind);
    if (!on) removeWidget(kind);
    ui[kind]?.set(on);
    if (on) { run(true); drawWidgets(); }
  }
  function setExposure() {
    save();
    if (cfg.falseColour && !widgets.has('legend')) makeWidget('legend');
    if (!cfg.falseColour) removeWidget('legend');
    ensureExpo();
    if (cfg.falseColour || cfg.zebra.on) run(true); else if (expo) expo.getContext('2d').clearRect(0, 0, expo.width, expo.height);
    drawWidgets();
  }

  // ---- panel
  for (const k of ['hist', 'wave', 'vec', 'audio']) ui[k] = toggleRow(KINDS[k].label, cfg.widgets[k].on, (v) => setWidget(k, v), k === 'audio' ? 'Needs Sound on (Premiere)' : null);
  const modeChips = chips(HIST_MODES, cfg.widgets.hist.mode, (v) => { cfg.widgets.hist.mode = v; save(); drawWidgets(); }, { label: 'Histogram mode' });
  const fc = toggleRow('False colour', cfg.falseColour, (v) => { cfg.falseColour = v; setExposure(); }, 'Colours show exposure bands');
  const zb = toggleRow('Zebras', cfg.zebra.on, (v) => { cfg.zebra.on = v; setExposure(); }, 'Stripes where brighter than the level');
  const zr = sliderRow('Zebra level', { min: 70, max: 100, step: 1, value: cfg.zebra.thr, fmt: (v) => v + '%' }, (v) => { cfg.zebra.thr = v; save(); if (cfg.zebra.on) run(true); });
  const zp = chips([{ value: 95, label: '95% near clip' }, { value: 100, label: '100% clipped' }], cfg.zebra.thr, (v) => { cfg.zebra.thr = v; zr.set(v); cfg.zebra.on = true; zb.set(true); setExposure(); }, { label: 'Zebra presets' });

  panel.append(
    section('Scopes', ui.hist.el, modeChips.el, ui.wave.el, ui.vec.el, ui.audio.el, h('p', { class: 'ui-note' }, 'Drag a scope by its title to move it. Tap S/M/L on a scope to change its size.')),
    section('Exposure', fc.el, zb.el, zr.el, zp.el),
  );
  for (const k of ['hist', 'wave', 'vec', 'audio']) if (cfg.widgets[k].on) makeWidget(k);
  if (cfg.falseColour) makeWidget('legend');
  ensureExpo();
  drawWidgets();
  // keep widgets inside the dock when it resizes (rotation, full screen)
  new ResizeObserver(() => { for (const [k, wd] of widgets) place(k, wd.el); }).observe(dock);
  setInterval(() => { if (cfg.widgets.audio.on && widgets.has('audio')) drawWidgets(); }, 250);
  if (needsPixels()) setTimeout(() => run(true), 300);

  return {
    isActive: () => Object.values(cfg.widgets).some((w) => w.on) || cfg.falseColour || cfg.zebra.on,
    summary() {
      const on = [];
      for (const [k, w] of Object.entries(cfg.widgets)) if (w.on) on.push(KINDS[k].label.toLowerCase());
      if (cfg.falseColour) on.push('false colour');
      if (cfg.zebra.on) on.push('zebras');
      return on.length ? on.join(', ') : 'Off';
    },
    // exposed for tests
    _debug: { get result() { return result; }, get usingWorker() { return !!worker; } },
  };
}
