// Social media frame previews: our own outline drawings of where each app puts its buttons, caption,
// profile bar and top/bottom bars. Zones come from /social/<id>.json (normalised to a reference frame),
// so adding a platform is a data change. Pure helpers are exported for tests; initSocial draws SVG.
import { store } from './storage.js';
import { h, s, mountSvg, setViewBox, toggleRow, sliderRow, section, loadJson } from './ui-kit.js';

export const LABEL_AT = ['tl', 'tr', 'bl', 'br', 'tc', 'bc'];
export const KINDS = ['topbar', 'bottombar', 'buttons', 'caption', 'profile', 'badge', 'crop'];
export const VIEW_MODES = ['ui', 'safe'];
export const normalizeViewMode = (m) => (VIEW_MODES.includes(m) ? m : 'ui');

const COUNTS = { heart: '42.8K', comment: '618', share: '2.1K', send: '2.1K', bookmark: '1.4K', repost: '890', up: '1.2K' };
export const actionCount = (shape) => COUNTS[shape] || '';

// Crisp modern outline icons on a -1..1 box (stroke only unless `fill`). Original drawings, no brand artwork.
const dot = (cx, cy, r) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
export const ICONS = {
  heart: { d: 'M0 .84 C-.52 .42 -.96 .06 -.96 -.36 C-.96 -.68 -.71 -.9 -.42 -.9 C-.21 -.9 -.06 -.77 0 -.62 C.06 -.77 .21 -.9 .42 -.9 C.71 -.9 .96 -.68 .96 -.36 C.96 .06 .52 .42 0 .84Z' },
  comment: { d: 'M0 -.86 C.54 -.86 .94 -.5 .94 -.04 C.94 .42 .54 .76 0 .76 C-.16 .76 -.31 .73 -.45 .67 L-.88 .86 L-.74 .46 C-.87 .32 -.94 .15 -.94 -.04 C-.94 -.5 -.54 -.86 0 -.86Z' },
  share: { d: 'M.88 -.1 L.12 -.78 V-.36 C-.48 -.32 -.86 .04 -.88 .72 C-.62 .34 -.28 .18 .12 .18 V.58 L.88 -.1Z' },
  send: { d: 'M.9 -.82 L-.88 -.14 L-.18 .14 L.12 .84 L.9 -.82Z M.9 -.82 L-.18 .14' },
  upload: { d: 'M0 .42 V-.82 M-.45 -.38 L0 -.84 L.45 -.38 M-.78 .14 V.64 Q-.78 .84 -.58 .84 H.58 Q.78 .84 .78 .64 V.14' },
  bookmark: { d: 'M-.58 -.86 H.58 Q.7 -.86 .7 -.72 V.88 L0 .44 L-.7 .88 V-.72 Q-.7 -.86 -.58 -.86Z' },
  more: { d: `${dot(-0.66, 0, 0.14)} ${dot(0, 0, 0.14)} ${dot(0.66, 0, 0.14)}`, fill: true },
  play: { d: 'M-.46 -.78 L.78 0 L-.46 .78Z', fill: true },
  back: { d: 'M.32 -.78 L-.44 0 L.32 .78' },
  search: { d: `${dot(-0.14, -0.14, 0.62)} M.32 .32 L.86 .86` },
  plus: { d: 'M0 -.76 V.76 M-.76 0 H.76' },
  close: { d: 'M-.68 -.68 L.68 .68 M.68 -.68 L-.68 .68' },
  music: { d: `M.46 -.82 V.46 M.46 -.82 L-.46 -.56 V.58 ${dot(-0.66, 0.58, 0.24)} ${dot(0.26, 0.46, 0.24)}` },
  camera: { d: `M-.72 -.5 H-.38 L-.24 -.76 H.24 L.38 -.5 H.72 Q.92 -.5 .92 -.3 V.56 Q.92 .76 .72 .76 H-.72 Q-.92 .76 -.92 .56 V-.3 Q-.92 -.5 -.72 -.5Z ${dot(0, 0.12, 0.36)}` },
  home: { d: 'M-.84 -.04 L0 -.82 L.84 -.04 M-.62 -.22 V.68 Q-.62 .82 -.48 .82 H-.18 V.36 H.18 V.82 H.48 Q.62 .82 .62 .68 V-.22' },
  user: { d: `${dot(0, -0.36, 0.34)} M-.76 .84 C-.74 .28 -.4 .12 0 .12 C.4 .12 .74 .28 .76 .84` },
  mute: { d: 'M-.88 -.28 H-.48 L.02 -.72 V.72 L-.48 .28 H-.88 Q-.96 .28 -.96 .2 V-.2 Q-.96 -.28 -.88 -.28Z M.38 -.38 Q.74 0 .38 .38 M.62 -.62 Q1.08 0 .62 .62' },
  fullscreen: { d: 'M-.82 -.32 V-.68 Q-.82 -.82 -.68 -.82 H-.32 M.82 -.32 V-.68 Q.82 -.82 .68 -.82 H.32 M-.82 .32 V.68 Q-.82 .82 -.68 .82 H-.32 M.82 .32 V.68 Q.82 .82 .68 .82 H.32' },
  sliders: { d: `M-.84 -.42 H.84 M-.84 .42 H.84 ${dot(-0.28, -0.42, 0.2)} ${dot(0.3, 0.42, 0.2)}` },
  up: { d: 'M0 .78 V-.78 M-.58 -.2 L0 -.78 L.58 -.2' },
  down: { d: 'M0 -.78 V.78 M-.58 .2 L0 .78 L.58 .2' },
  repost: { d: 'M-.78 -.18 V-.46 Q-.78 -.6 -.64 -.6 H.56 M.28 -.86 L.58 -.6 L.28 -.34 M.78 .18 V.46 Q.78 .6 .64 .6 H-.56 M-.28 .86 L-.58 .6 L-.28 .34' },
  dot: { d: dot(0, 0, 0.44), fill: true },
};

const inUnit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const isRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => typeof v === 'number')
  && inUnit(r[0]) && inUnit(r[1]) && r[2] > 0 && r[3] > 0 && r[0] + r[2] <= 1 + 1e-9 && r[1] + r[3] <= 1 + 1e-9;
const overlaps = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

// Returns a list of problems (empty = valid).
export function validatePlatform(p) {
  const err = [];
  const bad = (m) => err.push(m);
  if (!p || typeof p !== 'object') return ['not an object'];
  if (!/^[a-z0-9-]+$/.test(p.id || '')) bad('id must be lowercase kebab-case');
  if (!p.name || typeof p.name !== 'string') bad('name missing');
  if (!(p.ref && p.ref.w > 0 && p.ref.h > 0)) bad('ref.w/ref.h must be positive');
  if (!isRect(p.safe)) bad('safe must be [x,y,w,h] inside 0..1');
  if (!Array.isArray(p.zones) || !p.zones.length) { bad('zones missing'); return err; }
  const seen = new Set();
  for (const z of p.zones) {
    const at = `zone ${z && z.id}`;
    if (!z || !z.id || seen.has(z.id)) { bad(`${at}: id missing or duplicate`); continue; }
    seen.add(z.id);
    if (!KINDS.includes(z.kind)) bad(`${at}: unknown kind ${z.kind}`);
    if (!z.label) bad(`${at}: label missing`);
    if (z.labelAt && !LABEL_AT.includes(z.labelAt)) bad(`${at}: labelAt must be one of ${LABEL_AT.join(',')}`);
    if (typeof z.unsafe !== 'boolean') bad(`${at}: unsafe must be true/false`);
    if (!isRect(z.rect)) bad(`${at}: rect must be [x,y,w,h] inside 0..1`);
    for (const ic of z.icons || []) {
      if (!ICONS[ic.shape]) bad(`${at}: unknown icon ${ic.shape}`);
      if (!inUnit(ic.x) || !inUnit(ic.y) || !(ic.size > 0 && ic.size <= 0.2)) bad(`${at}: icon ${ic.shape} out of range`);
    }
    for (const l of z.lines || []) if (!inUnit(l.x) || !inUnit(l.y) || !(l.w > 0) || l.x + l.w > 1 + 1e-9) bad(`${at}: line out of range`);
    if (z.avatar && (!inUnit(z.avatar.x) || !inUnit(z.avatar.y) || !(z.avatar.r > 0 && z.avatar.r < 0.2))) bad(`${at}: avatar out of range`);
    if (z.handle && (!inUnit(z.handle.x) || !inUnit(z.handle.y) || !(z.handle.size > 0))) bad(`${at}: handle out of range`);
    if (z.pill && !(isRect([z.pill.x, z.pill.y, z.pill.w, z.pill.h]) && z.pill.text)) bad(`${at}: pill out of range`);
    // the safe box must be free of everything flagged unsafe
    if (z.unsafe && isRect(p.safe) && isRect(z.rect) && overlaps(p.safe, z.rect)) bad(`${at}: safe box overlaps this unsafe zone`);
  }
  return err;
}

// Where the platform's reference frame sits inside the picture (contain, centred), in px.
export function fitFrame(picW, picH, ref) {
  const k = Math.min(picW / ref.w, picH / ref.h);
  const w = ref.w * k, h = ref.h * k;
  return { x: (picW - w) / 2, y: (picH - h) / 2, w, h };
}

// Normalised rect -> px rect inside `frame`.
export const toPx = (frame, r) => ({ x: frame.x + r[0] * frame.w, y: frame.y + r[1] * frame.h, w: r[2] * frame.w, h: r[3] * frame.h });

// Greedy word wrap into at most maxLines lines of maxChars; the last line ends with an ellipsis if text was cut.
export function wrapText(text, maxChars, maxLines) {
  const max = Math.max(4, maxChars | 0);
  const lines = [];
  let cur = '';
  for (const w of String(text || '').trim().split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const cut = lines.length > maxLines;
  const out = lines.slice(0, maxLines).map((l) => (l.length > max ? l.slice(0, max - 1) + '…' : l));
  if (cut && out.length) {
    const last = out[out.length - 1].replace(/…$/, '');
    out[out.length - 1] = (last.length >= max ? last.slice(0, max - 1) : last) + '…';
  }
  return out;
}

// Avatar target size (square, centre-cropped).
export const AVATAR_PX = 96;
export function coverCrop(sw, sh) {
  const side = Math.min(sw, sh);
  return { sx: (sw - side) / 2, sy: (sh - side) / 2, side };
}

const CSS = `
.s-outside{fill:rgba(0,0,0,.68)}
.s-frame{fill:none;stroke:rgba(255,255,255,.35);stroke-width:1;vector-effect:non-scaling-stroke}
.s-scrim-top{fill:url(#s-grad-top)}
.s-scrim-bot{fill:url(#s-grad-bot)}
.s-nav-bg{fill:rgba(8,10,14,.52)}
.s-nav-line{stroke:rgba(255,255,255,.14);stroke-width:1;vector-effect:non-scaling-stroke}
.s-zone{fill:rgba(15,23,42,.22);stroke:rgba(255,255,255,.35);stroke-width:1;vector-effect:non-scaling-stroke}
.s-zone.crop{fill:none;stroke:#7dd3fc;stroke-dasharray:6 4}
.s-hl .s-zone.unsafe{fill:url(#s-hatch);stroke:rgba(248,113,113,.85);stroke-dasharray:4 3}
.s-safe{fill:rgba(16,185,129,.06);stroke:rgba(52,211,153,.8);stroke-width:1.25;stroke-dasharray:6 4;vector-effect:non-scaling-stroke}
.s-bracket{fill:none;stroke:#34d399;stroke-width:2.2;stroke-linecap:round;vector-effect:non-scaling-stroke}
.s-safe-pill{fill:rgba(6,78,59,.85);stroke:rgba(52,211,153,.75);stroke-width:1;vector-effect:non-scaling-stroke}
.s-safe-txt{fill:#a7f3d0;font:700 9.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.08em}
.s-icon{fill:none;stroke:#fff;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.s-icon.fill{fill:#fff;stroke:none}
.s-count{fill:rgba(255,255,255,.92);font:600 10px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
.s-bar{fill:rgba(255,255,255,.55)}
.s-avatar-bg{fill:url(#s-av-grad);stroke:rgba(255,255,255,.92);stroke-width:1.5;vector-effect:non-scaling-stroke}
.s-text{fill:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-weight:600;letter-spacing:-.01em}
.s-cap{font-weight:400;fill:rgba(255,255,255,.92)}
.s-pill{fill:rgba(255,255,255,.14);stroke:rgba(255,255,255,.78);stroke-width:1.15;vector-effect:non-scaling-stroke}
.s-label{fill:#fff;font:600 10.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;paint-order:stroke;stroke:rgba(0,0,0,.85);stroke-width:2.5px}
.s-fg-dim{opacity:.22}
`;

const KEY_PLATFORM = 'ot.social.platform';
const KEY_MODE = 'ot.social.mode';
const KEY_HL = 'ot.social.unsafe';
const KEY_LABELS = 'ot.social.labels';
const KEY_OPACITY = 'ot.social.opacity';
const KEY_PROFILES = 'ot.social.profiles';
const KEY_PROFILE = 'ot.social.profile';

const DEFAULT_PROFILE = () => ({ id: 'p' + Date.now().toString(36), handle: 'yourhandle', caption: 'Your caption goes here #hashtag', avatar: '' });

export function initSocial({ bus, layer, panel }) {
  const svg = mountSvg(layer, 'social');
  const cache = new Map();
  let index = [];
  let platformId = store.get(KEY_PLATFORM) || '';
  let viewMode = normalizeViewMode(store.get(KEY_MODE) || 'ui');
  let highlight = store.get(KEY_HL) === '1' || viewMode === 'safe'; // off by default
  let showLabels = store.get(KEY_LABELS) === '1'; // off by default
  let opacity = Math.min(1, Math.max(0.3, parseFloat(store.get(KEY_OPACITY)) || 1));
  let profiles = loadJson(KEY_PROFILES, [], store);
  if (!Array.isArray(profiles) || !profiles.length) profiles = [{ ...DEFAULT_PROFILE(), id: 'p1' }];
  let profileId = store.get(KEY_PROFILE) || profiles[0].id;
  if (!profiles.some((p) => p.id === profileId)) profileId = profiles[0].id;
  let size = { w: layer.clientWidth || 0, h: layer.clientHeight || 0 };
  let uid = 0;

  const profile = () => profiles.find((p) => p.id === profileId) || profiles[0];
  const saveProfiles = () => { store.set(KEY_PROFILES, JSON.stringify(profiles)); store.set(KEY_PROFILE, profileId); };

  async function load(id) {
    if (cache.has(id)) return cache.get(id);
    const res = await fetch(`/social/${id}.json`);
    if (!res.ok) throw new Error(`social/${id}.json ${res.status}`);
    const p = await res.json();
    cache.set(id, p);
    return p;
  }

  const MIN_TEXT = 12; // CSS px: handle, caption and button text never get smaller than this
  const textW = (str, fs, k = 0.56) => str.length * fs * k;

  function drawIcon(g, ic, frame, withCount) {
    const def = ICONS[ic.shape];
    if (!def) return;
    const k = Math.max(7, (ic.size * frame.w) / 2);
    // keep the whole icon inside the frame, whatever the crop size
    const cx = Math.min(Math.max(frame.x + ic.x * frame.w, frame.x + k + 1), frame.x + frame.w - k - 1);
    const cy = Math.min(Math.max(frame.y + ic.y * frame.h, frame.y + k + 1), frame.y + frame.h - k - 1);
    g.appendChild(s('path', { d: def.d, class: 's-icon' + (def.fill ? ' fill' : ''), transform: `translate(${cx} ${cy}) scale(${k})` }));
    if (withCount) {
      const cnt = actionCount(ic.shape);
      if (cnt && cy + k + 12 <= frame.y + frame.h - 2) {
        g.appendChild(s('text', { x: cx, y: cy + k + 11, 'text-anchor': 'middle', class: 's-count' }, cnt));
      }
    }
  }

  // Draws avatar and handle; returns the right edge of the handle text (for the pill collision check).
  function drawProfileBits(g, z, frame, prof) {
    let handleEnd = 0;
    let avatarEdge = 0;
    if (z.avatar) {
      const r = Math.max(z.avatar.r * frame.w, 9);
      const cx = frame.x + z.avatar.x * frame.w, cy = frame.y + z.avatar.y * frame.h;
      avatarEdge = cx + r;
      g.appendChild(s('circle', { cx, cy, r, class: 's-avatar-bg' }));
      const id = `av${++uid}`;
      g.appendChild(s('clipPath', { id }, s('circle', { cx, cy, r })));
      if (prof.avatar) {
        g.appendChild(s('image', { href: prof.avatar, x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, 'clip-path': `url(#${id})`, preserveAspectRatio: 'xMidYMid slice' }));
      } else {
        g.appendChild(s('circle', { cx, cy: cy - r * 0.18, r: r * 0.28, fill: 'rgba(255,255,255,.9)' }));
        g.appendChild(s('ellipse', { cx, cy: cy + r * 0.82, rx: r * 0.58, ry: r * 0.46, fill: 'rgba(255,255,255,.9)', 'clip-path': `url(#${id})` }));
      }
    }
    if (z.handle) {
      const fs = Math.max(MIN_TEXT, z.handle.size * frame.w);
      const label = '@' + (prof.handle || 'yourhandle');
      const x = Math.max(frame.x + z.handle.x * frame.w, avatarEdge + 6);
      g.appendChild(s('text', { x, y: frame.y + z.handle.y * frame.h + fs * 0.35, class: 's-text', 'font-size': fs }, label));
      handleEnd = x + textW(label, fs);
    }
    return handleEnd;
  }

  function drawCaption(g, z, frame, prof) {
    const lines = z.lines || [];
    if (!lines.length) return;
    const text = (prof.caption || '').trim();
    const fs = Math.max(MIN_TEXT, 0.022 * frame.h);
    // lines keep their data positions but are never closer than a text line height apart
    const step = Math.max(fs * 1.3, lines.length > 1 ? (lines[1].y - lines[0].y) * frame.h : 0);
    const bottom = frame.y + (z.rect[1] + z.rect[3]) * frame.h;
    const y0 = frame.y + lines[0].y * frame.h;
    const fit = Math.max(1, Math.min(lines.length, Math.floor((bottom - y0 - fs * 0.4) / step) + 1));
    let chunks = [];
    if (text) {
      const maxW = Math.max(...lines.map((l) => l.w)) * frame.w;
      chunks = wrapText(text, Math.floor(maxW / (fs * 0.54)), fit);
    }
    for (let i = 0; i < fit; i++) {
      const l = lines[i];
      const x = frame.x + l.x * frame.w, y = y0 + i * step;
      if (chunks[i]) g.appendChild(s('text', { x, y: y + fs * 0.35, class: 's-text s-cap', 'font-size': fs }, chunks[i]));
      else if (!text) g.appendChild(s('rect', { x, y: y - 2, width: l.w * frame.w, height: 4, rx: 2, class: 's-bar' }));
    }
  }

  function drawSafeFrame(root, sb) {
    root.appendChild(s('rect', { x: sb.x, y: sb.y, width: sb.w, height: sb.h, rx: 4, class: 's-safe' }));
    const arm = Math.max(8, Math.min(18, Math.min(sb.w, sb.h) * 0.12));
    const x1 = sb.x, y1 = sb.y, x2 = sb.x + sb.w, y2 = sb.y + sb.h;
    const corners = [
      `M${x1} ${y1 + arm} V${y1} H${x1 + arm}`,
      `M${x2 - arm} ${y1} H${x2} V${y1 + arm}`,
      `M${x1} ${y2 - arm} V${y2} H${x1 + arm}`,
      `M${x2 - arm} ${y2} H${x2} V${y2 - arm}`,
    ].join(' ');
    root.appendChild(s('path', { d: corners, class: 's-bracket' }));
    if (sb.w >= 76 && sb.h >= 28) {
      const pw = 68, ph2 = 16;
      const px = sb.x + 6, py = sb.y + 6;
      root.appendChild(s('rect', { x: px, y: py, width: pw, height: ph2, rx: 8, class: 's-safe-pill' }));
      root.appendChild(s('text', { x: px + pw / 2, y: py + 11.2, 'text-anchor': 'middle', class: 's-safe-txt' }, 'SAFE AREA'));
    }
  }

  let token = 0;
  // Zone labels (off by default): skipped on small zones or when a pill fills the zone.
  function labelWanted(z, frame) {
    const r = toPx(frame, z.rect);
    if (r.h < 22) return false;
    return !(z.pill && z.pill.h / z.rect[3] > 0.6);
  }
  function drawLabel(root, z, frame) {
    const r = toPx(frame, z.rect);
    const est = z.label.length * 6;
    const pos = z.labelAt || (z.kind === 'bottombar' ? 'tl' : z.kind === 'profile' ? 'tc' : 'bl');
    let x = pos.endsWith('c') ? r.x + r.w / 2 : pos.endsWith('r') ? r.x + r.w - 3 : r.x + 3;
    let anchor = pos.endsWith('c') ? 'middle' : pos.endsWith('r') ? 'end' : 'start';
    if (anchor === 'start' && x + est > frame.x + frame.w - 2) { x = Math.min(r.x + r.w, frame.x + frame.w) - 3; anchor = 'end'; }
    const y = pos.startsWith('t') ? r.y + 12 : r.y + r.h - 3;
    root.appendChild(s('text', { x, y, class: 's-label', 'text-anchor': anchor }, z.label));
  }

  async function render() {
    const my = ++token;
    const { w, h: ph } = size;
    if (!platformId || !(w > 0 && ph > 0)) { svg.replaceChildren(s('style', {}, CSS)); return; }
    let p;
    try { p = await load(platformId); } catch (e) { console.error(e); return; }
    if (my !== token || p.id !== platformId) return; // a newer render is on its way
    svg.replaceChildren(s('style', {}, CSS));
    setViewBox(svg, w, ph);
    const defs = s('defs', {},
      s('filter', { id: 's-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' },
        s('feDropShadow', { dx: 0, dy: 1, stdDeviation: 1.5, 'flood-color': '#000', 'flood-opacity': 0.55 })),
      s('linearGradient', { id: 's-grad-top', x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0%', 'stop-color': '#000', 'stop-opacity': '0.52' }),
        s('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': '0' })),
      s('linearGradient', { id: 's-grad-bot', x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0%', 'stop-color': '#000', 'stop-opacity': '0' }),
        s('stop', { offset: '45%', 'stop-color': '#000', 'stop-opacity': '0.32' }),
        s('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': '0.68' })),
      s('linearGradient', { id: 's-av-grad', x1: '0', y1: '0', x2: '1', y2: '1' },
        s('stop', { offset: '0%', 'stop-color': '#6366f1' }),
        s('stop', { offset: '100%', 'stop-color': '#ec4899' })),
      s('pattern', { id: 's-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        s('rect', { width: 8, height: 8, fill: 'rgba(239,68,68,.20)' }),
        s('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: 'rgba(248,113,113,.38)', 'stroke-width': 2 })),
    );
    svg.appendChild(defs);
    const frame = fitFrame(w, ph, p.ref);
    const prof = profile();
    const safeMode = viewMode === 'safe';
    const showSafe = safeMode || highlight;
    // the platform's crop sits centred on the picture; everything outside it is darkened
    for (const r of [
      { x: 0, y: 0, w, h: frame.y }, { x: 0, y: frame.y + frame.h, w, h: ph - frame.y - frame.h },
      { x: 0, y: frame.y, w: frame.x, h: frame.h }, { x: frame.x + frame.w, y: frame.y, w: w - frame.x - frame.w, h: frame.h },
    ]) if (r.w > 0.5 && r.h > 0.5) svg.appendChild(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 's-outside' }));
    const root = s('g', { class: showSafe ? 's-hl' : '', opacity: opacity });
    svg.appendChild(root);

    // Subtle top/bottom gradient scrims + frosted bottom nav bar in UI preview mode
    if (!safeMode) {
      const hasTop = p.zones.some((z) => z.kind === 'topbar');
      const hasBottomChrome = p.zones.some((z) => z.kind === 'caption' || z.kind === 'profile' || z.kind === 'bottombar');
      if (hasTop) root.appendChild(s('rect', { x: frame.x, y: frame.y, width: frame.w, height: frame.h * 0.14, class: 's-scrim-top' }));
      if (hasBottomChrome) {
        const sh = frame.h * 0.34;
        root.appendChild(s('rect', { x: frame.x, y: frame.y + frame.h - sh, width: frame.w, height: sh, class: 's-scrim-bot' }));
      }
      for (const z of p.zones) {
        if (z.kind === 'bottombar') {
          const r = toPx(frame, z.rect);
          root.appendChild(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: 's-nav-bg' }));
          root.appendChild(s('line', { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y, class: 's-nav-line' }));
        }
      }
    }

    if (frame.w < w - 1 || frame.h < ph - 1) {
      root.appendChild(s('rect', { x: frame.x, y: frame.y, width: frame.w, height: frame.h, class: 's-frame' }));
    }
    if (showSafe || showLabels) {
      for (const z of p.zones) {
        const r = toPx(frame, z.rect);
        root.appendChild(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 3, class: `s-zone ${z.kind}${z.unsafe ? ' unsafe' : ''}` }));
      }
    }
    if (showSafe) drawSafeFrame(root, toPx(frame, p.safe));

    const fg = s('g', { filter: 'url(#s-shadow)', class: safeMode ? 's-fg-dim' : '' });
    root.appendChild(fg);
    for (const z of p.zones) {
      const showCounts = !safeMode && z.kind === 'buttons' && (z.icons || []).length >= 2 && z.rect[3] >= 0.22;
      for (const ic of z.icons || []) drawIcon(fg, ic, frame, showCounts);
      if (z.kind === 'caption' || z.lines) drawCaption(fg, z, frame, prof);
      const handleEnd = drawProfileBits(fg, z, frame, prof);
      if (z.pill) {
        const r = toPx(frame, [z.pill.x, z.pill.y, z.pill.w, z.pill.h]);
        const fs = Math.max(MIN_TEXT, Math.min(r.h * 0.5, 12.5));
        const needW = textW(z.pill.text, fs) + 16;
        const pw = Math.max(r.w, needW), ph2 = Math.max(r.h, fs + 8);
        const px = Math.min(r.x + r.w, frame.x + frame.w - 2) - pw;
        const py = Math.min(Math.max(r.y + r.h / 2 - ph2 / 2, frame.y + 1), frame.y + frame.h - ph2 - 1);
        if (px > handleEnd + 6) { // skip the pill when the crop is too narrow to fit it next to the handle
          fg.appendChild(s('rect', { x: px, y: py, width: pw, height: ph2, rx: Math.min(ph2 / 2, 8), class: 's-pill' }));
          fg.appendChild(s('text', { x: px + pw / 2, y: py + ph2 / 2 + fs * 0.35, 'text-anchor': 'middle', class: 's-text', 'font-size': fs }, z.pill.text));
        }
      }
    }
    if (showLabels) for (const z of p.zones) if (labelWanted(z, frame)) drawLabel(root, z, frame);
  }

  // ---------------- panel
  const grid = h('div', { class: 'ui-chips', role: 'group', 'aria-label': 'Platform' });
  const buttons = new Map();
  const offBtn = h('button', { type: 'button', class: 'ui-chip', 'data-platform': '', onclick: () => selectPlatform('') }, 'Off');
  grid.appendChild(offBtn);
  const markPlatform = () => { for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === platformId)); offBtn.setAttribute('aria-pressed', String(!platformId)); };
  function addPlatformButton(id, name) {
    const b = h('button', { type: 'button', class: 'ui-chip', 'data-platform': id, onclick: () => selectPlatform(platformId === id ? '' : id) }, name);
    buttons.set(id, b);
    grid.appendChild(b);
  }
  function selectPlatform(id) {
    platformId = id;
    store.set(KEY_PLATFORM, id);
    markPlatform();
    render();
  }

  const modeGrid = h('div', { class: 'ui-chips', role: 'group', 'aria-label': 'View mode' });
  const modeBtns = new Map();
  const markMode = () => { for (const [id, b] of modeBtns) b.setAttribute('aria-pressed', String(id === viewMode)); };
  function setMode(m) {
    viewMode = normalizeViewMode(m);
    store.set(KEY_MODE, viewMode);
    if (viewMode === 'safe') { highlight = true; store.set(KEY_HL, '1'); hlToggle.set(true); }
    else { highlight = false; store.set(KEY_HL, '0'); hlToggle.set(false); }
    markMode();
    render();
  }
  for (const [id, label] of [['ui', 'UI preview'], ['safe', 'Safe zones']]) {
    const b = h('button', { type: 'button', class: 'ui-chip', 'data-view-mode': id, onclick: () => setMode(id) }, label);
    modeBtns.set(id, b);
    modeGrid.appendChild(b);
  }
  markMode();

  const select = h('select', { 'aria-label': 'Profile', onchange: (e) => { profileId = e.target.value; saveProfiles(); syncFields(); render(); } });
  const handleIn = h('input', { type: 'text', maxlength: 30, placeholder: 'yourhandle', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Handle', oninput: () => { profile().handle = handleIn.value.replace(/^@+/, '').replace(/\s+/g, ''); saveProfiles(); renderSoon(); } });
  const capIn = h('textarea', { rows: 3, maxlength: 160, placeholder: 'Caption text (leave empty for grey placeholder lines)', 'aria-label': 'Caption', oninput: () => { profile().caption = capIn.value; saveProfiles(); renderSoon(); } });
  const avatarImg = h('img', { class: 'ui-avatar', alt: '', width: 44, height: 44 });
  const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: onPickFile });
  let soonTimer = 0;
  const renderSoon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(render, 120); };

  function fillSelect() {
    select.replaceChildren(...profiles.map((p) => h('option', { value: p.id }, '@' + (p.handle || 'yourhandle'))));
    select.value = profileId;
  }
  function syncFields() {
    const p = profile();
    handleIn.value = p.handle || '';
    capIn.value = p.caption || '';
    if (p.avatar) { avatarImg.src = p.avatar; avatarImg.hidden = false; } else { avatarImg.removeAttribute('src'); avatarImg.hidden = true; }
    select.value = profileId;
  }

  async function onPickFile() {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try {
      const bmp = typeof createImageBitmap === 'function' ? await createImageBitmap(f) : await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
      const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
      const { sx, sy, side } = coverCrop(sw, sh);
      const c = document.createElement('canvas');
      c.width = c.height = AVATAR_PX;
      c.getContext('2d').drawImage(bmp, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
      profile().avatar = c.toDataURL('image/jpeg', 0.8);
      saveProfiles(); syncFields(); render();
    } catch (e) { console.error('avatar', e); }
  }

  const newBtn = h('button', { type: 'button', class: 'ui-btn', onclick: () => {
    const p = DEFAULT_PROFILE();
    p.handle = `profile${profiles.length + 1}`;
    profiles.push(p); profileId = p.id; saveProfiles(); fillSelect(); syncFields(); render();
  } }, 'New profile');
  const delBtn = h('button', { type: 'button', class: 'ui-btn', onclick: () => {
    if (profiles.length <= 1) { profiles[0] = { ...DEFAULT_PROFILE(), id: profiles[0].id }; } else { profiles = profiles.filter((p) => p.id !== profileId); profileId = profiles[0].id; }
    saveProfiles(); fillSelect(); syncFields(); render();
  } }, 'Delete');
  const picBtn = h('button', { type: 'button', class: 'ui-btn', onclick: () => fileIn.click() }, 'Choose picture');

  fillSelect();
  syncFields();
  const hlToggle = toggleRow('Highlight unsafe areas', highlight, (v) => { highlight = v; store.set(KEY_HL, v ? '1' : '0'); if (!v && viewMode === 'safe') { viewMode = 'ui'; store.set(KEY_MODE, 'ui'); markMode(); } render(); }, 'Red = covered by the app, green = clear');
  const lblToggle = toggleRow('Show labels', showLabels, (v) => { showLabels = v; store.set(KEY_LABELS, v ? '1' : '0'); render(); }, 'Names of the top bar, buttons, caption…');
  const opSlider = sliderRow('Opacity', { min: 0.3, max: 1, step: 0.05, value: opacity, fmt: (v) => Math.round(v * 100) + '%' }, (v) => { opacity = v; store.set(KEY_OPACITY, v); render(); });
  panel.append(
    section('Platform', grid),
    section('View mode', modeGrid),
    opSlider.el, lblToggle.el, hlToggle.el,
    section('Profile', h('div', { class: 'ui-profile' }, avatarImg, select), h('label', { class: 'ui-field' }, 'Handle', handleIn), h('label', { class: 'ui-field' }, 'Caption', capIn), h('div', { class: 'ui-btns' }, picBtn, newBtn, delBtn), fileIn),
  );

  fetch('/social/index.json').then((r) => r.json()).then((j) => {
    index = j.platforms || [];
    for (const p of index) addPlatformButton(p.id, p.name);
    markPlatform();
  }).catch((e) => console.error('social index', e));

  const apply = (r) => { size = { w: r.w, h: r.h }; render(); };
  bus.on('layout', apply);
  const last = bus.last('layout');
  if (last) apply(last); else render();

  return {
    isActive: () => !!platformId,
    summary: () => (platformId ? (index.find((p) => p.id === platformId)?.name || platformId) : 'Off'),
    // short name for the quick-toggle chip: "Instagram Feed (4:5)" -> "Instagram Feed"
    shortName: () => (platformId ? (index.find((p) => p.id === platformId)?.name || platformId).replace(/\s*\(.*\)\s*$/, '') : ''),
    select: selectPlatform,
  };
}
