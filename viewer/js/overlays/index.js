// The one entry point for everything drawn on the phone from the decoded picture (M4).
// app.js imports this at start, calls init() once, then open() each time the Overlays sheet is shown.
// It mounts the feature modules (CONTRACT.md): social frames, guides, scopes/exposure, info.
import { initSocial } from '../social.js';
import { initGuides } from '../guides.js';
import { initScopes } from '../scopes.js';
import { initInfo } from './info.js';
import { h } from '../ui-kit.js';

const GROUPS = [
  { id: 'social', title: 'Social frames', hint: 'Reels, TikTok, Shorts, X…' },
  { id: 'guides', title: 'Guides', hint: 'Safe zones, thirds, letterbox' },
  { id: 'scopes', title: 'Scopes & exposure', hint: 'Histogram, waveform, zebras' },
  { id: 'info', title: 'Info', hint: 'Timecode, sequence, fps' },
];

let layerEl = null;
let refresh = () => {};

export async function init({ bus, layer, panel, dock, toast, saveFrame }) {
  layerEl = layer;
  const root = h('div', { class: 'ov-root' });
  const tilesView = h('div', { class: 'ov-tiles-view' });
  const grid = h('div', { class: 'ui-tiles ov-tiles' });
  const pages = {};
  const mods = {};
  const tiles = {};

  const make = (id) => { pages[id] = h('div', { class: 'ov-page', hidden: true }); return pages[id]; };
  const ctx = (id) => ({ bus, layer, panel: make(id), dock: dock || document.getElementById('dock') });
  // Order sets stacking: exposure canvas first (bottom), then social, guides, info on top.
  mods.scopes = initScopes(ctx('scopes'));
  mods.social = initSocial(ctx('social'));
  mods.guides = initGuides(ctx('guides'));
  mods.info = initInfo(ctx('info'));

  function show(id) {
    tilesView.hidden = id != null;
    for (const [k, p] of Object.entries(pages)) p.hidden = k !== id;
    refresh();
  }

  for (const g of GROUPS) {
    const name = h('b', {}, g.title);
    const sum = h('small', {}, g.hint);
    const t = h('button', { type: 'button', class: 'ui-tile big', 'data-group': g.id, onclick: () => show(g.id) }, name, sum);
    tiles[g.id] = { t, sum, g };
    grid.appendChild(t);
    pages[g.id].prepend(h('div', { class: 'ov-back' }, h('button', { type: 'button', class: 'ui-btn', onclick: () => show(null) }, '‹ Overlays'), h('h3', {}, g.title)));
  }

  const saveBtn = h('button', { type: 'button', class: 'ui-btn wide', 'data-act': 'save-overlays', onclick: async () => {
    if (saveFrame) await saveFrame({ overlays: true }); else toast?.('Saving is not available.');
  } }, 'Save frame with overlays');
  tilesView.append(grid, h('p', { class: 'ui-note' }, 'Everything here is drawn on your phone from the picture. Nothing is sent to the PC.'), saveBtn);
  root.append(tilesView, ...Object.values(pages));
  panel.append(root);

  refresh = () => {
    for (const { sum, g, t } of Object.values(tiles)) {
      const m = mods[g.id];
      const on = m?.isActive?.();
      sum.textContent = on ? m.summary() : g.hint;
      t.setAttribute('aria-pressed', String(!!on));
    }
  };
  refresh();
  panel.addEventListener('change', () => setTimeout(refresh, 0));
  panel.addEventListener('click', () => setTimeout(refresh, 0));
  return { mods };
}

// Called each time the sheet opens: back to the tile grid.
export function open() {
  const sheet = document.querySelector('#overlaysPanel .ov-root');
  if (sheet) {
    sheet.querySelector('.ov-tiles-view').hidden = false;
    for (const p of sheet.querySelectorAll('.ov-page')) p.hidden = true;
  }
  refresh();
}

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('overlay render failed'));
  img.src = url;
});

// Picture + every visible overlay layer (SVG and canvas) in one canvas, at the picture's own resolution.
export async function composite(pictureCanvas) {
  const W = pictureCanvas.width, H = pictureCanvas.height;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(pictureCanvas, 0, 0);
  if (!layerEl) return out;
  for (const el of layerEl.children) {
    if (el.hidden || el.style.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas') {
      ctx.drawImage(el, 0, 0, W, H);
    } else if (tag === 'svg') {
      if (!el.firstChild || !el.getAttribute('viewBox')) continue;
      const clone = el.cloneNode(true);
      clone.setAttribute('width', W);
      clone.setAttribute('height', H);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const xml = new XMLSerializer().serializeToString(clone);
      try {
        const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml));
        ctx.drawImage(img, 0, 0, W, H);
      } catch (e) { console.error(e); }
    }
  }
  return out;
}
