// Social media frame previews: our own outline drawings of where each app puts its buttons, caption,
// profile bar and top/bottom bars. Zones come from /social/<id>.json (normalised to a reference frame),
// so adding a platform is a data change. Pure helpers are exported for tests; initSocial draws SVG.
import { store } from './storage.js';
import { h, s, mountSvg, setViewBox, toggleRow, section, loadJson } from './ui-kit.js';

export const LABEL_AT = ['tl', 'tr', 'bl', 'br', 'tc', 'bc'];
export const KINDS = ['topbar', 'bottombar', 'buttons', 'caption', 'profile', 'badge', 'crop'];

// Generic icons on a -1..1 box (stroke only unless `fill`). Simple shapes, no brand artwork.
const dot = (cx, cy, r) => `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`;
export const ICONS = {
  heart: { d: 'M0 .85 C-1.1 .1 -1 -.8 -.5 -.8 C-.2 -.8 0 -.55 0 -.4 C0 -.55 .2 -.8 .5 -.8 C1 -.8 1.1 .1 0 .85Z' },
  comment: { d: 'M-.9 -.7 H.9 V.45 H-.2 L-.6 .9 V.45 H-.9Z' },
  share: { d: 'M0 .5 V-.8 M-.5 -.3 L0 -.8 L.5 -.3 M-.8 .1 V.8 H.8 V.1' },
  send: { d: 'M-.9 -.1 L.9 -.8 L.2 .85 L-.1 .15Z' },
  upload: { d: 'M0 .5 V-.8 M-.5 -.3 L0 -.8 L.5 -.3 M-.8 .1 V.8 H.8 V.1' },
  bookmark: { d: 'M-.55 -.9 H.55 V.9 L0 .4 L-.55 .9Z' },
  more: { d: `${dot(-0.7, 0, 0.14)} ${dot(0, 0, 0.14)} ${dot(0.7, 0, 0.14)}`, fill: true },
  play: { d: 'M-.5 -.8 L.8 0 L-.5 .8Z', fill: true },
  back: { d: 'M.4 -.8 L-.4 0 L.4 .8' },
  search: { d: `${dot(-0.1, -0.1, 0.6)} M.35 .35 L.85 .85` },
  plus: { d: 'M0 -.8 V.8 M-.8 0 H.8' },
  close: { d: 'M-.7 -.7 L.7 .7 M.7 -.7 L-.7 .7' },
  music: { d: `M.4 -.8 V.45 M.4 -.8 L-.5 -.55 V.6 ${dot(-0.15, 0.6, 0.35)} ${dot(0.75, 0.45, 0.35)}` },
  camera: { d: `M-.9 -.5 H-.4 L-.2 -.8 H.2 L.4 -.5 H.9 V.75 H-.9Z ${dot(0, 0.12, 0.4)}` },
  home: { d: 'M-.85 .05 L0 -.8 L.85 .05 M-.6 -.15 V.8 H.6 V-.15' },
  user: { d: `${dot(0, -0.35, 0.35)} M-.8 .85 C-.8 .2 .8 .2 .8 .85` },
  mute: { d: 'M-.9 -.3 H-.5 L0 -.75 V.75 L-.5 .3 H-.9Z M.4 -.4 Q.75 0 .4 .4' },
  fullscreen: { d: 'M-.8 -.3 V-.8 H-.3 M.8 -.3 V-.8 H.3 M-.8 .3 V.8 H-.3 M.8 .3 V.8 H.3' },
  sliders: { d: `M-.8 -.4 H.8 M-.8 .4 H.8 ${dot(-0.25, -0.4, 0.2)} ${dot(0.3, 0.4, 0.2)}` },
  up: { d: 'M0 .8 V-.8 M-.6 -.2 L0 -.8 L.6 -.2' },
  down: { d: 'M0 -.8 V.8 M-.6 .2 L0 .8 L.6 .2' },
  repost: { d: 'M-.8 -.2 V-.5 H.5 M.2 -.8 L.6 -.5 L.2 -.2 M.8 .2 V.5 H-.5 M-.2 .8 L-.6 .5 L-.2 .2' },
  dot: { d: dot(0, 0, 0.5), fill: true },
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
.s-outside{fill:rgba(0,0,0,.55)}.s-frame{fill:none;stroke:rgba(255,255,255,.55);stroke-width:1;stroke-dasharray:4 3}
.s-zone{fill:rgba(0,0,0,.28);stroke:rgba(255,255,255,.55);stroke-width:1}
.s-zone.crop{fill:none;stroke:#7dd3fc;stroke-dasharray:6 4}
.s-hl .s-zone.unsafe{fill:rgba(248,113,113,.38);stroke:#f87171}
.s-safe{fill:rgba(52,211,153,.08);stroke:#34d399;stroke-width:1.5;stroke-dasharray:5 3}
.s-icon{fill:none;stroke:#fff;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.s-icon.fill{fill:#fff;stroke:none}
.s-bar{fill:rgba(255,255,255,.75)}
.s-avatar-bg{fill:#4b5563;stroke:#fff;stroke-width:1.2}
.s-text{fill:#fff;font-family:-apple-system,Helvetica,Arial,sans-serif;font-weight:600}
.s-cap{font-weight:400}
.s-pill{fill:none;stroke:#fff;stroke-width:1.2}
.s-label{fill:#fff;font:600 9px -apple-system,Helvetica,Arial,sans-serif;paint-order:stroke;stroke:rgba(0,0,0,.85);stroke-width:2.5px}
`;

const KEY_PLATFORM = 'ot.social.platform';
const KEY_HL = 'ot.social.unsafe';
const KEY_PROFILES = 'ot.social.profiles';
const KEY_PROFILE = 'ot.social.profile';

const DEFAULT_PROFILE = () => ({ id: 'p' + Date.now().toString(36), handle: 'yourhandle', caption: '', avatar: '' });

export function initSocial({ bus, layer, panel }) {
  const svg = mountSvg(layer, 'social');
  const cache = new Map();
  let index = [];
  let platformId = store.get(KEY_PLATFORM) || '';
  let highlight = store.get(KEY_HL) !== '0';
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

  function drawIcon(g, ic, frame) {
    const def = ICONS[ic.shape];
    if (!def) return;
    const k = (ic.size * frame.w) / 2;
    g.appendChild(s('path', { d: def.d, class: 's-icon' + (def.fill ? ' fill' : ''), transform: `translate(${frame.x + ic.x * frame.w} ${frame.y + ic.y * frame.h}) scale(${k})` }));
  }

  function drawProfileBits(g, z, frame, prof) {
    if (z.avatar) {
      const cx = frame.x + z.avatar.x * frame.w, cy = frame.y + z.avatar.y * frame.h, r = z.avatar.r * frame.w;
      g.appendChild(s('circle', { cx, cy, r, class: 's-avatar-bg' }));
      if (prof.avatar) {
        const id = `av${++uid}`;
        g.appendChild(s('clipPath', { id }, s('circle', { cx, cy, r })));
        g.appendChild(s('image', { href: prof.avatar, x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, 'clip-path': `url(#${id})`, preserveAspectRatio: 'xMidYMid slice' }));
      } else {
        g.appendChild(s('circle', { cx, cy: cy - r * 0.2, r: r * 0.3, fill: '#d1d5db' }));
        const id = `av${++uid}`;
        g.appendChild(s('clipPath', { id }, s('circle', { cx, cy, r })));
        g.appendChild(s('ellipse', { cx, cy: cy + r * 0.85, rx: r * 0.62, ry: r * 0.5, fill: '#d1d5db', 'clip-path': `url(#${id})` }));
      }
    }
    if (z.handle) {
      const fs = Math.max(9, z.handle.size * frame.w);
      g.appendChild(s('text', { x: frame.x + z.handle.x * frame.w, y: frame.y + z.handle.y * frame.h + fs * 0.35, class: 's-text', 'font-size': fs }, '@' + (prof.handle || 'yourhandle')));
    }
  }

  function drawCaption(g, z, frame, prof) {
    const lines = z.lines || [];
    const text = (prof.caption || '').trim();
    const fs = Math.max(9, 0.03 * frame.h * 0.62);
    let chunks = [];
    if (text && lines.length) {
      const maxW = Math.max(...lines.map((l) => l.w)) * frame.w;
      chunks = wrapText(text, Math.floor(maxW / (fs * 0.52)), lines.length);
    }
    lines.forEach((l, i) => {
      const x = frame.x + l.x * frame.w, y = frame.y + l.y * frame.h;
      if (chunks[i]) g.appendChild(s('text', { x, y: y + fs * 0.35, class: 's-text s-cap', 'font-size': fs }, chunks[i]));
      else g.appendChild(s('rect', { x, y: y - 2.5, width: l.w * frame.w, height: 5, rx: 2.5, class: 's-bar' }));
    });
  }

  let token = 0;
  // Zone labels: skipped on small zones or when a pill fills the zone; anchored to stay inside the frame.
  function labelWanted(z, frame) {
    const r = toPx(frame, z.rect);
    if (r.h < 22) return false;
    return !(z.pill && z.pill.h / z.rect[3] > 0.6);
  }
  function drawLabel(root, z, frame) {
    const r = toPx(frame, z.rect);
    const est = z.label.length * 5.3;
    const pos = z.labelAt || (z.kind === 'bottombar' ? 'tl' : z.kind === 'profile' ? 'tc' : 'bl');
    let x = pos.endsWith('c') ? r.x + r.w / 2 : pos.endsWith('r') ? r.x + r.w - 3 : r.x + 3;
    let anchor = pos.endsWith('c') ? 'middle' : pos.endsWith('r') ? 'end' : 'start';
    if (anchor === 'start' && x + est > frame.x + frame.w - 2) { x = Math.min(r.x + r.w, frame.x + frame.w) - 3; anchor = 'end'; }
    const y = pos.startsWith('t') ? r.y + 9 : r.y + r.h - 3;
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
    const frame = fitFrame(w, ph, p.ref);
    const prof = profile();
    const root = s('g', { class: highlight ? 's-hl' : '' });
    // dim whatever lies outside the platform's frame (when the picture has a different shape)
    for (const r of [
      { x: 0, y: 0, w, h: frame.y }, { x: 0, y: frame.y + frame.h, w, h: ph - frame.y - frame.h },
      { x: 0, y: frame.y, w: frame.x, h: frame.h }, { x: frame.x + frame.w, y: frame.y, w: w - frame.x - frame.w, h: frame.h },
    ]) if (r.w > 0.5 && r.h > 0.5) root.appendChild(s('rect', { ...r, class: 's-outside' }));
    root.appendChild(s('rect', { x: frame.x, y: frame.y, width: frame.w, height: frame.h, class: 's-frame' }));
    for (const z of p.zones) {
      const r = toPx(frame, z.rect);
      root.appendChild(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, class: `s-zone ${z.kind}${z.unsafe ? ' unsafe' : ''}` }));
    }
    if (highlight) {
      const sb = toPx(frame, p.safe);
      root.appendChild(s('rect', { x: sb.x, y: sb.y, width: sb.w, height: sb.h, class: 's-safe' }));
      root.appendChild(s('text', { x: sb.x + 4, y: sb.y + 11, class: 's-label' }, 'safe'));
    }
    for (const z of p.zones) {
      for (const ic of z.icons || []) drawIcon(root, ic, frame);
      if (z.kind === 'caption' || z.lines) drawCaption(root, z, frame, prof);
      drawProfileBits(root, z, frame, prof);
      if (z.pill) {
        const r = toPx(frame, [z.pill.x, z.pill.y, z.pill.w, z.pill.h]);
        root.appendChild(s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: Math.min(r.h / 2, 10), class: 's-pill' }));
        root.appendChild(s('text', { x: r.x + r.w / 2, y: r.y + r.h / 2 + 3.5, 'text-anchor': 'middle', class: 's-text', 'font-size': Math.max(9, Math.min(r.h * 0.5, 12)) }, z.pill.text));
      }
      if (highlight && z.unsafe && labelWanted(z, frame)) drawLabel(root, z, frame);
    }
    svg.appendChild(root);
  }

  // ---------------- panel
  const grid = h('div', { class: 'ui-tiles small', role: 'group', 'aria-label': 'Platform' });
  const buttons = new Map();
  const markPlatform = () => { for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === platformId)); };
  function addPlatformButton(id, name) {
    const b = h('button', { type: 'button', class: 'ui-tile', 'data-platform': id, onclick: () => selectPlatform(platformId === id ? '' : id) }, name);
    buttons.set(id, b);
    grid.appendChild(b);
  }
  function selectPlatform(id) {
    platformId = id;
    store.set(KEY_PLATFORM, id);
    markPlatform();
    render();
  }

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
  const hlToggle = toggleRow('Highlight unsafe areas', highlight, (v) => { highlight = v; store.set(KEY_HL, v ? '1' : '0'); render(); }, 'Red = covered by the app, green = clear');
  panel.append(
    section('Platform', grid),
    hlToggle.el,
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
    select: selectPlatform,
  };
}
