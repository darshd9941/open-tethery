// Scopes and exposure helpers, all computed on the phone from the decoded picture.
// Widgets (histogram, waveform, vectorscope, audio meters, false-colour legend) float in `dock`: they sit in the
// empty space around the picture when there is room, otherwise over it, and can be dragged. One scope at a time
// by default. False colour and zebras are a full-picture canvas in `layer`.
import { store } from './storage.js';
import { getLatestFrame } from './frame-bus.js';
import { h, toggleRow, chips, sliderRow, section, loadJson } from './ui-kit.js';
import {
  analyse, analysisSize, arrayMax, BAR_TARGETS, skinLineEnd, VEC_SIZE, FALSE_COLOUR_BANDS,
  falseColourImage, zebraMask, levelToMeter, dockLayout,
} from './scope-math.js';

const KEY_CFG = 'ot.scopes.cfg';
const KEY_POS = 'ot.scopes.pos';
const WIDTHS = [152, 212, 292]; // small (default), medium, large (CSS px)
const SIZE_NAMES = ['S', 'M', 'L'];
const MIN_INTERVAL = 100; // ms: at most ~10 analyses per second
const ANALYSIS_W = 320;
const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const KINDS = {
  // S is sized to fit the ~90 px empty band above/below a 16:9 picture on a portrait phone (header 24 + canvas, 8 px margins)
  hist: { label: 'Histogram', ratio: 0.4 },
  wave: { label: 'Waveform', ratio: 0.4 },
  vec: { label: 'Vectorscope', ratio: 1, widths: [58, 150, 230] },
  audio: { label: 'Audio', ratio: 0.3 },
  legend: { label: 'False colour', ratio: 44 / 290 },
};
const PICKABLE = ['hist', 'wave', 'vec', 'audio'];
const HIST_MODES = [{ value: 'luma', label: 'Luma' }, { value: 'rgb', label: 'RGB' }, { value: 'parade', label: 'Parade' }];

const DEFAULTS = () => ({
  widgets: { hist: { on: false, size: 0, mode: 'luma' }, wave: { on: false, size: 0 }, vec: { on: false, size: 0 }, audio: { on: false, size: 0 } },
  multi: false, // false: picking a scope replaces the current one
  last: ['hist'], // what the quick-toggle chip brings back
  falseColour: false,
  zebra: { on: false, thr: 95 },
});

export function mergeScopeConfig(saved) {
  const c = DEFAULTS();
  if (!saved || typeof saved !== 'object') return c;
  for (const k of Object.keys(c.widgets)) Object.assign(c.widgets[k], saved.widgets?.[k] || {});
  for (const k of Object.keys(c.widgets)) {
    c.widgets[k].size = [0, 1, 2].includes(c.widgets[k].size) ? c.widgets[k].size : 0;
    c.widgets[k].on = !!c.widgets[k].on;
  }
  if (!HIST_MODES.some((m) => m.value === c.widgets.hist.mode)) c.widgets.hist.mode = 'luma';
  c.multi = !!saved.multi;
  if (Array.isArray(saved.last)) {
    const l = saved.last.filter((k) => PICKABLE.includes(k));
    if (l.length) c.last = l;
  }
  c.falseColour = !!saved.falseColour;
  if (saved.zebra) { c.zebra.on = !!saved.zebra.on; c.zebra.thr = Math.min(100, Math.max(70, +saved.zebra.thr || 95)); }
  return c;
}

const SKIN = 'rgba(255,200,150,.95)';

// Crisp text with a dark outline so it reads on any background.
function label(ctx, text, x, y, align = 'left') {
  ctx.font = `600 11px ${FONT}`;
  ctx.textAlign = align;
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = 'rgba(255,255,255,.92)';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

const hline = (ctx, x1, x2, y) => { const yy = Math.round(y) + 0.5; ctx.beginPath(); ctx.moveTo(x1, yy); ctx.lineTo(x2, yy); ctx.stroke(); };
const vline = (ctx, x, y1, y2) => { const xx = Math.round(x) + 0.5; ctx.beginPath(); ctx.moveTo(xx, y1); ctx.lineTo(xx, y2); ctx.stroke(); };

function drawHist(ctx, W, H, res, mode) {
  ctx.clearRect(0, 0, W, H);
  const labH = 14;
  const plotH = H - labH;
  const panes = mode === 'parade' ? 3 : 1;
  const pw = W / panes;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.2)';
  for (let p = 0; p < panes; p++) for (const f of [0.25, 0.5, 0.75]) vline(ctx, p * pw + f * pw, 0, plotH);
  ctx.strokeStyle = 'rgba(255,255,255,.3)';
  hline(ctx, 0, W, plotH);
  const area = (arr, x0, w, fill, stroke) => {
    const m = Math.max(1, arrayMax(arr));
    ctx.beginPath();
    ctx.moveTo(x0, plotH);
    for (let i = 0; i < 256; i++) ctx.lineTo(x0 + (i / 255) * w, plotH - Math.sqrt(arr[i] / m) * (plotH - 3));
    ctx.lineTo(x0 + w, plotH);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
  };
  if (res?.hist) {
    if (mode === 'luma') area(res.hist.luma, 0, W, 'rgba(235,235,235,.55)', 'rgba(255,255,255,.95)');
    else if (mode === 'rgb') {
      ctx.globalCompositeOperation = 'lighter';
      area(res.hist.r, 0, W, 'rgba(255,40,40,.45)', 'rgba(255,90,90,.9)');
      area(res.hist.g, 0, W, 'rgba(40,255,40,.45)', 'rgba(90,255,90,.9)');
      area(res.hist.b, 0, W, 'rgba(60,90,255,.55)', 'rgba(120,150,255,.95)');
      ctx.globalCompositeOperation = 'source-over';
    } else {
      area(res.hist.r, 0, pw - 1, 'rgba(255,70,70,.55)', 'rgba(255,110,110,.95)');
      area(res.hist.g, pw, pw - 1, 'rgba(70,255,70,.55)', 'rgba(110,255,110,.95)');
      area(res.hist.b, 2 * pw, pw - 1, 'rgba(90,120,255,.6)', 'rgba(140,165,255,.95)');
    }
  }
  label(ctx, '0', 2, H - 2);
  label(ctx, '50%', W / 2, H - 2, 'center');
  label(ctx, '100', W - 2, H - 2, 'right');
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
        img.data[o] = 120; img.data[o + 1] = 255; img.data[o + 2] = 140; img.data[o + 3] = Math.round(60 + 195 * a);
      }
    }
    waveCanvas.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(waveCanvas, 0, 0, W, H);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.28)';
  for (const p of [0, 25, 50, 75, 100]) {
    const y = Math.min(H - 1, Math.max(0, H - (p / 100) * H));
    hline(ctx, 0, W, y);
    if (H >= 90 || p % 50 === 0) label(ctx, String(p), 3, Math.min(H - 3, Math.max(11, y - 2)));
  }
}

let vecCanvas = null;
function drawVec(ctx, W, H, res) {
  ctx.clearRect(0, 0, W, H);
  if (res?.vec) {
    vecCanvas = vecCanvas || tmp();
    vecCanvas.width = vecCanvas.height = VEC_SIZE;
    const vctx = vecCanvas.getContext('2d');
    const img = vctx.createImageData(VEC_SIZE, VEC_SIZE);
    const m = Math.max(1, arrayMax(res.vec));
    for (let i = 0; i < res.vec.length; i++) {
      if (!res.vec[i]) continue;
      const a = Math.min(1, 0.45 + Math.sqrt(res.vec[i] / m));
      img.data[i * 4] = 150; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 170; img.data[i * 4 + 3] = Math.round(a * 255);
    }
    vctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(vecCanvas, 0, 0, W, H);
  }
  const px = (cb) => (cb + 0.5) * W;
  const py = (cr) => (0.5 - cr) * H;
  ctx.strokeStyle = 'rgba(255,255,255,.32)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.5 - 1, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, W * 0.25, 0, Math.PI * 2); ctx.stroke();
  vline(ctx, W / 2, 0, H); hline(ctx, 0, W, H / 2);
  const e = skinLineEnd(0.5);
  ctx.strokeStyle = SKIN;
  ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(px(e.cb), py(e.cr)); ctx.stroke();
  const box = Math.max(6, W * 0.06);
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  for (const t of BAR_TARGETS) {
    ctx.strokeRect(Math.round(px(t.cb) - box / 2) + 0.5, Math.round(py(t.cr) - box / 2) + 0.5, box, box);
    // names sit on the outside of the box so they do not cover the dots (skipped on the tiny S size)
    const out = t.cb >= 0 ? 'left' : 'right';
    if (W >= 120) label(ctx, t.name, t.cb >= 0 ? px(t.cb) + box / 2 + 2 : px(t.cb) - box / 2 - 2, py(t.cr) + 4, out === 'left' ? 'left' : 'right');
  }
}

function drawAudio(ctx, W, H, st, now) {
  ctx.clearRect(0, 0, W, H);
  const fresh = st && now - st.at < 1200;
  const rowH = (H - 8) / 2;
  const rows = [['L', st?.l, st?.hold?.[0]], ['R', st?.r, st?.hold?.[1]]];
  rows.forEach(([name, v, hold], i) => {
    const y = 3 + i * (rowH + 2);
    const x0 = 16, bw = W - x0 - 4;
    label(ctx, name, 3, y + rowH * 0.5 + 4);
    ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(x0, y, bw, rowH);
    if (fresh) {
      const f = levelToMeter(v);
      const grad = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
      grad.addColorStop(0, '#34d399'); grad.addColorStop(0.75, '#f5d90a'); grad.addColorStop(1, '#f87171');
      ctx.fillStyle = grad; ctx.fillRect(x0, y, bw * f, rowH);
      ctx.fillStyle = '#fff'; ctx.fillRect(x0 + bw * Math.min(1, levelToMeter(hold)) - 1.5, y, 2, rowH);
    }
  });
  if (!fresh) label(ctx, 'Turn Sound on', W / 2, H / 2 + 4, 'center');
}

function drawLegend(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  const n = FALSE_COLOUR_BANDS.length;
  const cw = (W - 8) / n;
  const swH = 22;
  FALSE_COLOUR_BANDS.forEach((b, i) => {
    const x = 4 + i * cw;
    ctx.fillStyle = b.rgb ? `rgb(${b.rgb})` : 'rgb(130,130,130)';
    ctx.fillRect(Math.round(x), 2, Math.ceil(cw), swH);
    label(ctx, String(Math.min(100, Math.round(b.to))), x + cw / 2, 2 + swH / 2 + 4, 'center');
  });
  label(ctx, 'crushed', 4, H - 3);
  label(ctx, 'clipped', W - 4, H - 3, 'right');
}

export function initScopes({ bus, layer, panel, panelExposure, dock }) {
  const cfg = mergeScopeConfig(loadJson(KEY_CFG, null, store));
  const positions = loadJson(KEY_POS, {}, store);
  const save = () => store.set(KEY_CFG, JSON.stringify(cfg));
  const dpr = () => Math.min(3, window.devicePixelRatio || 1);

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
  let layoutRect = bus.last('layout') || { x: 0, y: 0, w: layer.clientWidth || 0, h: layer.clientHeight || 0 };
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
  bus.on('layout', (r) => { layoutRect = r; placeAll(); if (cfg.falseColour || cfg.zebra.on) run(true); });
  bus.on('audio-levels', (a) => {
    audio.l = a.l; audio.r = a.r;
    audio.hold = [Math.max(a.peakL, audio.hold[0] * 0.97), Math.max(a.peakR, audio.hold[1] * 0.97)];
    audio.at = performance.now();
    if (cfg.widgets.audio.on && audio.at - (audio.drawn || 0) > 50) { audio.drawn = audio.at; drawWidgets(); }
  });

  // ---- widgets
  const dockRect = () => dock.getBoundingClientRect();
  const clampTo = (el, x, y, dr) => {
    el.style.left = Math.min(Math.max(0, dr.width - el.offsetWidth), Math.max(0, x)) + 'px';
    el.style.top = Math.min(Math.max(0, dr.height - el.offsetHeight), Math.max(0, y)) + 'px';
  };
  // Widgets the user has not dragged go where there is empty space around the picture; dragged ones stay put.
  function placeAll() {
    if (!widgets.size) return;
    const dr = dockRect();
    if (!(dr.width > 0 && dr.height > 0)) return;
    const auto = [];
    for (const [k, wd] of widgets) {
      const p = positions[k];
      if (p) clampTo(wd.el, p.x * dr.width, p.y * dr.height, dr);
      else auto.push([k, wd]);
    }
    const hasPic = layoutRect && layoutRect.w > 0 && layoutRect.h > 0;
    const pic = hasPic ? { x: layoutRect.x || 0, y: layoutRect.y || 0, w: layoutRect.w, h: layoutRect.h } : { x: 0, y: 0, w: dr.width, h: dr.height };
    const spots = dockLayout({ w: dr.width, h: dr.height }, pic, auto.map(([, wd]) => ({ w: wd.el.offsetWidth, h: wd.el.offsetHeight })), { gap: 4, margin: 4 });
    auto.forEach(([, wd], i) => {
      clampTo(wd.el, spots[i].x, spots[i].y, dr);
      wd.el.dataset.docked = spots[i].docked ? '1' : '0';
    });
  }
  function sizeOf(kind) {
    const w = kind === 'legend' ? 290 : (KINDS[kind].widths || WIDTHS)[cfg.widgets[kind].size];
    return { w, h: Math.round(w * KINDS[kind].ratio) };
  }
  function resizeCanvas(kind) {
    const wd = widgets.get(kind);
    const { w, h: hh } = sizeOf(kind);
    const d = dpr();
    wd.el.classList.toggle('narrow', w < 100); // too small for a title next to the buttons
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
      const sizeBtn = h('button', { type: 'button', class: 'sc-btn sc-size', 'aria-label': `${KINDS[kind].label} size` }, SIZE_NAMES[cfg.widgets[kind].size]);
      sizeBtn.addEventListener('click', () => {
        cfg.widgets[kind].size = (cfg.widgets[kind].size + 1) % 3; save();
        sizeBtn.textContent = SIZE_NAMES[cfg.widgets[kind].size];
        resizeCanvas(kind); placeAll(); drawWidgets();
      });
      extra.push(sizeBtn);
    }
    extra.push(h('button', { type: 'button', class: 'sc-btn', 'aria-label': `Close ${KINDS[kind].label}`, onclick: () => setWidget(kind, false) }, '×'));
    head.append(...extra);
    const el = h('div', { class: `sc-widget sc-${kind}`, 'data-scope': kind }, head, canvas);
    wireDrag(kind, el, head);
    dock.appendChild(el);
    widgets.set(kind, { el, canvas, ctx: canvas.getContext('2d') });
    resizeCanvas(kind);
    placeAll();
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
      clampTo(el, e.clientX - drag.dr.left - drag.dx, e.clientY - drag.dr.top - drag.dy, drag.dr);
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
    if (wd) { wd.el.remove(); widgets.delete(kind); placeAll(); }
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

  const kindBtns = {};
  const markKinds = () => { for (const k of PICKABLE) kindBtns[k]?.setAttribute('aria-pressed', String(cfg.widgets[k].on)); };
  function setWidget(kind, on) {
    cfg.widgets[kind].on = on;
    const onKinds = PICKABLE.filter((k) => cfg.widgets[k].on);
    if (onKinds.length) cfg.last = onKinds;
    save();
    if (on && !widgets.has(kind)) makeWidget(kind);
    if (!on) removeWidget(kind);
    markKinds();
    if (on) { run(true); drawWidgets(); }
  }
  // Panel pick: one scope at a time unless "Show several at once" is on.
  function pick(kind) {
    const on = !cfg.widgets[kind].on;
    if (on && !cfg.multi) for (const k of PICKABLE) if (k !== kind && cfg.widgets[k].on) setWidget(k, false);
    setWidget(kind, on);
  }
  // Quick-toggle chip: everything off, or whatever was on last time (the histogram at first).
  function toggleScopes() {
    const onKinds = PICKABLE.filter((k) => cfg.widgets[k].on);
    if (onKinds.length) {
      for (const k of onKinds) setWidget(k, false);
      cfg.last = onKinds; save();
      return false;
    }
    for (const k of cfg.last) setWidget(k, true);
    return true;
  }
  function setExposure() {
    save();
    if (cfg.falseColour && !widgets.has('legend')) makeWidget('legend');
    if (!cfg.falseColour) removeWidget('legend');
    ensureExpo();
    if (cfg.falseColour || cfg.zebra.on) run(true); else if (expo) expo.getContext('2d').clearRect(0, 0, expo.width, expo.height);
    drawWidgets();
    fc.set(cfg.falseColour); zb.set(cfg.zebra.on);
  }

  // ---- panels
  const kindChips = h('div', { class: 'ui-chips', role: 'group', 'aria-label': 'Scope' });
  for (const k of PICKABLE) {
    kindBtns[k] = h('button', { type: 'button', class: 'ui-chip', 'data-kind': k, onclick: () => pick(k) }, KINDS[k].label);
    kindChips.appendChild(kindBtns[k]);
  }
  markKinds();
  const modeChips = chips(HIST_MODES, cfg.widgets.hist.mode, (v) => { cfg.widgets.hist.mode = v; save(); drawWidgets(); }, { label: 'Histogram mode' });
  const multi = toggleRow('Show several at once', cfg.multi, (v) => { cfg.multi = v; save(); });
  const resetBtn = h('button', { type: 'button', class: 'ui-btn', onclick: () => {
    for (const k of Object.keys(positions)) delete positions[k];
    store.set(KEY_POS, '{}');
    placeAll();
  } }, 'Reset positions');
  const fc = toggleRow('False colour', cfg.falseColour, (v) => { cfg.falseColour = v; setExposure(); }, 'Colours show exposure bands');
  const zb = toggleRow('Zebras', cfg.zebra.on, (v) => { cfg.zebra.on = v; setExposure(); }, 'Stripes where brighter than the level');
  const zr = sliderRow('Zebra level', { min: 70, max: 100, step: 1, value: cfg.zebra.thr, fmt: (v) => v + '%' }, (v) => { cfg.zebra.thr = v; save(); if (cfg.zebra.on) run(true); });
  const zp = chips([{ value: 95, label: '95% near clip' }, { value: 100, label: '100% clipped' }], cfg.zebra.thr, (v) => { cfg.zebra.thr = v; zr.set(v); cfg.zebra.on = true; zb.set(true); setExposure(); }, { label: 'Zebra presets' });

  const scopeSection = section('Scope', kindChips, modeChips.el, multi.el, h('p', { class: 'ui-note' }, 'Scopes sit in the empty space around the picture when there is room. Drag one by its title to move it; S/M/L changes its size. The audio meter needs Sound on (Premiere).'), h('div', { class: 'ui-btns' }, resetBtn));
  const expoSection = section('Exposure', fc.el, zb.el, zr.el, zp.el);
  panel.append(scopeSection);
  (panelExposure || panel).append(expoSection);

  for (const k of PICKABLE) if (cfg.widgets[k].on) makeWidget(k);
  if (cfg.falseColour) makeWidget('legend');
  ensureExpo();
  drawWidgets();
  // keep widgets inside the dock when it resizes (rotation, full screen, tray)
  new ResizeObserver(() => placeAll()).observe(dock);
  setInterval(() => { if (cfg.widgets.audio.on && widgets.has('audio')) drawWidgets(); }, 250);
  if (needsPixels()) setTimeout(() => run(true), 300);

  return {
    isActive: () => PICKABLE.some((k) => cfg.widgets[k].on),
    isFalseColour: () => cfg.falseColour,
    isZebra: () => cfg.zebra.on,
    toggleScopes,
    toggleFalseColour() { cfg.falseColour = !cfg.falseColour; setExposure(); return cfg.falseColour; },
    toggleZebra() { cfg.zebra.on = !cfg.zebra.on; setExposure(); return cfg.zebra.on; },
    summary() {
      const on = [];
      for (const k of PICKABLE) if (cfg.widgets[k].on) on.push(KINDS[k].label.toLowerCase());
      if (cfg.falseColour) on.push('false colour');
      if (cfg.zebra.on) on.push('zebras');
      return on.length ? on.join(', ') : 'Off';
    },
    // exposed for tests
    _debug: { get result() { return result; }, get usingWorker() { return !!worker; } },
  };
}
