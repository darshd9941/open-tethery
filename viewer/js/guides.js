// Guides drawn over the picture: safe zones, thirds, centre mark, custom grid, letterbox mattes.
// Geometry is pure (tested in node); initGuides draws SVG into `layer`.
import { store } from './storage.js';
import { h, s, mountSvg, setViewBox, toggleRow, chips, sliderRow, section, loadJson } from './ui-kit.js';

export const MATTES = [
  { id: '2.39', label: '2.39:1', ratio: 2.39 },
  { id: '2.35', label: '2.35:1', ratio: 2.35 },
  { id: '1.85', label: '1.85:1', ratio: 1.85 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
];

export const DEFAULTS = {
  title: { on: false, pct: 90 },
  action: { on: false, pct: 93 },
  thirds: false,
  centre: false,
  grid: { on: false, n: 4, m: 4 },
  matte: { on: false, id: '2.39' },
  hidden: false, // master switch behind the quick-toggle chip; settings are kept while hidden
};

// Centred rectangle covering pct percent of width and height.
export function safeRect(w, h, pct) {
  const k = Math.min(100, Math.max(10, pct)) / 100;
  return { x: (w - w * k) / 2, y: (h - h * k) / 2, w: w * k, h: h * k };
}

export function thirdsLines(w, h) {
  return [
    { x1: w / 3, y1: 0, x2: w / 3, y2: h }, { x1: (2 * w) / 3, y1: 0, x2: (2 * w) / 3, y2: h },
    { x1: 0, y1: h / 3, x2: w, y2: h / 3 }, { x1: 0, y1: (2 * h) / 3, x2: w, y2: (2 * h) / 3 },
  ];
}

// n columns x m rows: the inner dividing lines.
export function gridLines(w, h, n, m) {
  const out = [];
  for (let i = 1; i < n; i++) out.push({ x1: (w * i) / n, y1: 0, x2: (w * i) / n, y2: h });
  for (let j = 1; j < m; j++) out.push({ x1: 0, y1: (h * j) / m, x2: w, y2: (h * j) / m });
  return out;
}

// Centre cross arm length and the centre point.
export function centreMark(w, h) {
  const arm = Math.max(6, Math.min(w, h) * 0.04);
  return { cx: w / 2, cy: h / 2, arm };
}

// Crop to `ratio` (w/h) inside a w x h picture: the kept rectangle plus the masked bars.
export function matteRects(w, h, ratio) {
  const pic = w / h;
  let keep;
  if (Math.abs(pic - ratio) < 1e-3) keep = { x: 0, y: 0, w, h };
  else if (ratio > pic) { const kh = w / ratio; keep = { x: 0, y: (h - kh) / 2, w, h: kh }; }
  else { const kw = h * ratio; keep = { x: (w - kw) / 2, y: 0, w: kw, h }; }
  const bars = [];
  if (keep.y > 0.5) bars.push({ x: 0, y: 0, w, h: keep.y }, { x: 0, y: keep.y + keep.h, w, h: h - keep.y - keep.h });
  if (keep.x > 0.5) bars.push({ x: 0, y: 0, w: keep.x, h }, { x: keep.x + keep.w, y: 0, w: w - keep.x - keep.w, h });
  return { keep, bars };
}

export function mergeConfig(saved) {
  const c = structuredClone(DEFAULTS);
  if (!saved || typeof saved !== 'object') return c;
  for (const k of Object.keys(c)) {
    if (typeof c[k] === 'object') Object.assign(c[k], saved[k] && typeof saved[k] === 'object' ? saved[k] : {});
    else if (typeof saved[k] === typeof c[k]) c[k] = saved[k];
  }
  c.hidden = !!saved.hidden;
  c.title.pct = Math.min(100, Math.max(50, +c.title.pct || 90));
  c.action.pct = Math.min(100, Math.max(50, +c.action.pct || 93));
  c.grid.n = Math.min(24, Math.max(1, Math.round(c.grid.n) || 4));
  c.grid.m = Math.min(24, Math.max(1, Math.round(c.grid.m) || 4));
  if (!MATTES.some((m) => m.id === c.matte.id)) c.matte.id = '2.39';
  return c;
}

const KEY = 'ot.guides.cfg';
const CSS = `
.g-matte{fill:rgba(0,0,0,.72);stroke:none}.g-keep{fill:none;stroke:rgba(255,255,255,.8);stroke-width:1}
.g-line{stroke:rgba(255,255,255,.55);stroke-width:1;fill:none;vector-effect:non-scaling-stroke}.g-thirds{stroke:rgba(255,255,255,.85)}
.g-safe{fill:none;stroke-width:1.5;stroke-dasharray:6 4;vector-effect:non-scaling-stroke}.g-action{stroke:#f5d90a}.g-title{stroke:#4fd1c5}
.g-centre{stroke:#fff;stroke-width:1.5}
.g-label{fill:#fff;stroke:none;font:600 11px -apple-system,Helvetica,Arial,sans-serif;paint-order:stroke;stroke:rgba(0,0,0,.85);stroke-width:2.5px}
`;

export function initGuides({ bus, layer, panel }) {
  const cfg = mergeConfig(loadJson(KEY, null, store));
  const svg = mountSvg(layer, 'guides');
  let size = { w: layer.clientWidth || 0, h: layer.clientHeight || 0 };
  const line = (l, cls) => s('line', { x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, class: cls });
  const rect = (r, cls) => s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: cls });
  const text = (x, y, str) => s('text', { x, y, class: 'g-label' }, str);

  function render() {
    const { w, h } = size;
    svg.replaceChildren(s('style', {}, CSS));
    if (!(w > 0 && h > 0) || cfg.hidden) return;
    setViewBox(svg, w, h);
    if (cfg.matte.on) {
      const m = MATTES.find((x) => x.id === cfg.matte.id);
      const { keep, bars } = matteRects(w, h, m.ratio);
      for (const b of bars) svg.appendChild(rect(b, 'g-matte'));
      if (bars.length) svg.appendChild(rect(keep, 'g-keep'));
      svg.appendChild(text(keep.x + 6, keep.y + 14, m.label));
    }
    if (cfg.grid.on) for (const l of gridLines(w, h, cfg.grid.n, cfg.grid.m)) svg.appendChild(line(l, 'g-line'));
    if (cfg.thirds) for (const l of thirdsLines(w, h)) svg.appendChild(line(l, 'g-line g-thirds'));
    if (cfg.action.on) {
      const r = safeRect(w, h, cfg.action.pct);
      svg.appendChild(rect(r, 'g-safe g-action'));
      svg.appendChild(text(r.x + 4, r.y + r.h - 5, `action ${cfg.action.pct}%`));
    }
    if (cfg.title.on) {
      const r = safeRect(w, h, cfg.title.pct);
      svg.appendChild(rect(r, 'g-safe g-title'));
      svg.appendChild(text(r.x + 4, r.y + 13, `title ${cfg.title.pct}%`));
    }
    if (cfg.centre) {
      const c = centreMark(w, h);
      svg.appendChild(line({ x1: c.cx - c.arm, y1: c.cy, x2: c.cx + c.arm, y2: c.cy }, 'g-centre'));
      svg.appendChild(line({ x1: c.cx, y1: c.cy - c.arm, x2: c.cx, y2: c.cy + c.arm }, 'g-centre'));
    }
  }

  const anyOn = () => cfg.title.on || cfg.action.on || cfg.thirds || cfg.centre || cfg.grid.on || cfg.matte.on;
  // any change in the panel means the user wants to see guides again
  const save = () => { cfg.hidden = false; store.set(KEY, JSON.stringify(cfg)); render(); };
  const gridNums = h('div', { class: 'ui-row' });
  const stepper = (key, label) => {
    const out = h('output', {}, String(cfg.grid[key]));
    const bump = (d) => { cfg.grid[key] = Math.min(24, Math.max(1, cfg.grid[key] + d)); out.textContent = cfg.grid[key]; cfg.grid.on = true; gridToggle.set(true); save(); };
    return h('span', { class: 'ui-step' }, label, h('button', { type: 'button', 'aria-label': `Fewer ${label}`, onclick: () => bump(-1) }, '−'), out, h('button', { type: 'button', 'aria-label': `More ${label}`, onclick: () => bump(1) }, '+'));
  };
  const gridToggle = toggleRow('Custom grid', cfg.grid.on, (v) => { cfg.grid.on = v; save(); });
  gridNums.append(stepper('n', 'columns'), stepper('m', 'rows'));
  const matteToggle = toggleRow('Letterbox / crop guide', cfg.matte.on, (v) => { cfg.matte.on = v; save(); });
  const matteChips = chips(MATTES.map((m) => ({ value: m.id, label: m.label })), cfg.matte.id, (v) => { cfg.matte.id = v; cfg.matte.on = true; matteToggle.set(true); save(); }, { label: 'Crop ratio' });

  const tTitle = toggleRow('Title safe', cfg.title.on, (v) => { cfg.title.on = v; save(); });
  const tAction = toggleRow('Action safe', cfg.action.on, (v) => { cfg.action.on = v; save(); });
  const tThirds = toggleRow('Rule of thirds', cfg.thirds, (v) => { cfg.thirds = v; save(); });
  const tCentre = toggleRow('Centre mark', cfg.centre, (v) => { cfg.centre = v; save(); });
  function syncPanel() { tTitle.set(cfg.title.on); tAction.set(cfg.action.on); tThirds.set(cfg.thirds); tCentre.set(cfg.centre); gridToggle.set(cfg.grid.on); matteToggle.set(cfg.matte.on); }
  panel.append(
    section('Safe zones',
      tTitle.el,
      sliderRow('Title safe size', { min: 70, max: 100, value: cfg.title.pct, fmt: (v) => v + '%' }, (v) => { cfg.title.pct = v; save(); }).el,
      tAction.el,
      sliderRow('Action safe size', { min: 70, max: 100, value: cfg.action.pct, fmt: (v) => v + '%' }, (v) => { cfg.action.pct = v; save(); }).el),
    section('Composition',
      tThirds.el,
      tCentre.el,
      gridToggle.el, gridNums),
    section('Letterbox', matteToggle.el, matteChips.el));

  const apply = (r) => { size = { w: r.w, h: r.h }; render(); };
  bus.on('layout', apply);
  const last = bus.last('layout');
  if (last) apply(last); else render();

  return {
    isActive: () => !cfg.hidden && anyOn(),
    // quick toggle: hide/show everything; showing with nothing selected switches on thirds + action safe
    toggle() {
      if (!cfg.hidden && anyOn()) { cfg.hidden = true; store.set(KEY, JSON.stringify(cfg)); render(); return false; }
      if (!anyOn()) { cfg.thirds = true; cfg.action.on = true; syncPanel(); }
      save();
      return true;
    },
    summary() {
      const on = [cfg.title.on && 'title', cfg.action.on && 'action', cfg.thirds && 'thirds', cfg.centre && 'centre', cfg.grid.on && 'grid', cfg.matte.on && cfg.matte.id].filter(Boolean);
      return !cfg.hidden && on.length ? on.join(', ') : 'Off';
    },
  };
}
