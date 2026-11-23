// The one entry point for everything drawn on the phone from the decoded picture.
// app.js imports this at start and calls init() once. It mounts the feature modules (CONTRACT.md): social
// frames, guides, scopes/exposure, info; builds the quick-toggle chip row; and owns the settings tray.
import { initSocial } from '../social.js';
import { initGuides } from '../guides.js';
import { initScopes } from '../scopes.js';
import { initInfo } from './info.js';
import { h, icon } from '../ui-kit.js';

// Tabs of the settings tray, in order.
const TABS = [
  { id: 'social', title: 'Frame' },
  { id: 'guides', title: 'Guides' },
  { id: 'scopes', title: 'Scopes' },
  { id: 'exposure', title: 'Exposure' },
  { id: 'info', title: 'Info' },
];
const LONG_PRESS_MS = 450;

let layerEl = null;
let api = { open() {}, close() {}, isOpen: () => false };

export async function init({ bus, layer, tray, chips, dock, toast, saveFrame, onTray }) {
  layerEl = layer;
  const pages = {};
  const mods = {};
  const page = (id) => { pages[id] = h('div', { class: 'ov-page', 'data-page': id, role: 'tabpanel', hidden: true }); return pages[id]; };
  const ctx = (id) => ({ bus, layer, panel: page(id), dock: dock || document.getElementById('dock') });

  // Order sets stacking: exposure canvas first (bottom), then social, guides, info on top.
  const scopesCtx = ctx('scopes');
  mods.scopes = initScopes({ ...scopesCtx, panelExposure: page('exposure') });
  mods.social = initSocial(ctx('social'));
  mods.guides = initGuides(ctx('guides'));
  mods.info = initInfo(ctx('info'));

  // ---- tray
  let current = null; // open tab id, or null when the tray is closed
  const tabBtns = {};
  const tabs = h('div', { class: 'tray-tabs', role: 'tablist', 'aria-label': 'Overlay settings' });
  for (const t of TABS) {
    tabBtns[t.id] = h('button', { type: 'button', class: 'tray-tab', role: 'tab', 'data-tab': t.id, onclick: () => open(t.id) }, t.title);
    tabs.appendChild(tabBtns[t.id]);
  }
  const saveBtn = h('button', { type: 'button', class: 'tray-icon', 'data-act': 'save-overlays', 'aria-label': 'Save frame with overlays', title: 'Save frame with overlays', onclick: async () => {
    if (saveFrame) await saveFrame({ overlays: true }); else toast?.('Saving is not available.');
  } }, icon('save'));
  const closeBtn = h('button', { type: 'button', class: 'tray-icon', 'data-close-tray': '', 'aria-label': 'Close settings', title: 'Close', onclick: () => close() }, icon('x'));
  const head = h('div', { class: 'tray-head' }, h('div', { class: 'tray-grab', 'aria-hidden': 'true' }), h('div', { class: 'tray-bar' }, tabs, saveBtn, closeBtn));
  const body = h('div', { class: 'tray-body' }, ...Object.values(pages));
  tray.replaceChildren(head, body);
  tray.addEventListener('click', () => setTimeout(refresh, 0));
  tray.addEventListener('change', () => setTimeout(refresh, 0));

  // swipe down (portrait) or right (landscape side panel) on the tray head closes it
  let swipe = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    swipe = { x: e.clientX, y: e.clientY };
    try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  head.addEventListener('pointermove', (e) => {
    if (!swipe) return;
    const side = window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
    if (side ? e.clientX - swipe.x > 50 : e.clientY - swipe.y > 40) { swipe = null; close(); }
  });
  for (const t of ['pointerup', 'pointercancel']) head.addEventListener(t, () => { swipe = null; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close(); });

  function open(id = 'social') {
    if (!pages[id]) id = 'social';
    current = id;
    for (const t of TABS) {
      const on = t.id === id;
      pages[t.id].hidden = !on;
      tabBtns[t.id].setAttribute('aria-selected', String(on));
      tabBtns[t.id].tabIndex = on ? 0 : -1;
    }
    body.scrollTop = 0;
    tabBtns[id].scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    tray.hidden = false;
    onTray?.(true);
    refresh();
  }
  function close() {
    if (!current) return;
    current = null;
    tray.hidden = true;
    onTray?.(false);
    refresh();
  }
  api = { open, close, isOpen: () => current != null };

  // ---- quick-toggle chips
  const chipDefs = [
    { id: 'social', label: 'Frame', icon: 'frame', tab: 'social', mod: mods.social, tap: () => (current === 'social' ? close() : open('social')), clear: true },
    { id: 'guides', label: 'Guides', icon: 'guides', tab: 'guides', mod: mods.guides, tap: () => mods.guides.toggle() },
    { id: 'scopes', label: 'Scopes', icon: 'scopes', tab: 'scopes', mod: mods.scopes, tap: () => mods.scopes.toggleScopes() },
    { id: 'colour', label: 'False colour', icon: 'colour', tab: 'exposure', mod: { isActive: () => mods.scopes.isFalseColour() }, tap: () => mods.scopes.toggleFalseColour() },
    { id: 'zebra', label: 'Zebras', icon: 'zebra', tab: 'exposure', mod: { isActive: () => mods.scopes.isZebra() }, tap: () => mods.scopes.toggleZebra() },
    { id: 'info', label: 'Info', icon: 'info', tab: 'info', mod: mods.info, tap: () => mods.info.toggle() },
  ];
  const chipEls = {};
  for (const d of chipDefs) {
    const labelEl = h('span', { class: 'qlabel' }, d.label);
    const main = h('button', { type: 'button', class: 'qchip', 'data-chip': d.id, 'aria-pressed': 'false' }, icon(d.icon), labelEl);
    const side = d.clear
      ? h('button', { type: 'button', class: 'qmore', 'data-chip-clear': d.id, 'aria-label': 'Turn the frame off', hidden: true, onclick: () => { mods.social.select(''); refresh(); } }, icon('x'))
      : h('button', { type: 'button', class: 'qmore', 'data-chip-more': d.id, 'aria-label': `${d.label} settings`, onclick: () => open(d.tab) }, icon('chevron-up'));
    const group = h('div', { class: 'qgroup', 'data-on': 'false' }, main, side);
    // long press opens the settings; the click that follows is swallowed
    let timer = 0;
    let fired = false;
    const cancel = () => clearTimeout(timer);
    main.addEventListener('pointerdown', () => { fired = false; cancel(); timer = setTimeout(() => { fired = true; open(d.tab); }, LONG_PRESS_MS); });
    for (const t of ['pointerup', 'pointerleave', 'pointercancel']) main.addEventListener(t, cancel);
    main.addEventListener('contextmenu', (e) => e.preventDefault());
    main.addEventListener('click', () => {
      if (fired) { fired = false; return; }
      d.tap();
      refresh();
    });
    chipEls[d.id] = { group, main, side, labelEl, d };
    chips.appendChild(group);
  }

  function refresh() {
    for (const { group, main, side, labelEl, d } of Object.values(chipEls)) {
      const on = !!d.mod.isActive?.();
      main.setAttribute('aria-pressed', String(on));
      group.dataset.on = String(on);
      group.dataset.open = String(current != null && current === d.tab);
      if (d.id === 'social') {
        labelEl.textContent = on ? mods.social.shortName() : d.label;
        side.hidden = !on;
      }
    }
  }
  refresh();
  bus.on('state', refresh);
  return { mods, open, close, refresh };
}

// Tray control for app.js.
export const open = (id) => api.open(id);
export const close = () => api.close();
export const isOpen = () => api.isOpen();

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
