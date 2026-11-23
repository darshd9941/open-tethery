// Small DOM helpers shared by the overlay modules (panels and SVG layers).
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((k) => k != null));
  return el;
}

export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter((k) => k != null));
  return el;
}

// An SVG that covers the layer; viewBox is the picture size in CSS px so exports scale cleanly.
export function mountSvg(layer, name) {
  const svg = s('svg', { class: 'ot-svg', 'data-ot-layer': name, preserveAspectRatio: 'none', xmlns: SVG_NS });
  layer.appendChild(svg);
  return svg;
}

export function setViewBox(svg, w, h) {
  svg.setAttribute('viewBox', `0 0 ${Math.max(1, w)} ${Math.max(1, h)}`);
}

// Labelled on/off switch row. Returns { el, set(v) }.
export function toggleRow(label, value, onChange, hint) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label', { class: 'ui-row' }, h('span', { class: 'ui-label' }, label, hint ? h('small', {}, hint) : null), input);
  return { el, set(v) { input.checked = !!v; } };
}

// Row of exclusive chips. options: [{ value, label }]. Returns { el, set(v) }.
export function chips(options, value, onChange, { label = '' } = {}) {
  const wrap = h('div', { class: 'ui-chips', role: 'group', 'aria-label': label });
  const btns = new Map();
  const set = (v) => { for (const [k, b] of btns) b.setAttribute('aria-pressed', String(k === v)); };
  for (const o of options) {
    const b = h('button', { type: 'button', class: 'ui-chip', onclick: () => { set(o.value); onChange(o.value); } }, o.label);
    btns.set(o.value, b);
    wrap.appendChild(b);
  }
  set(value);
  return { el: wrap, set };
}

export function sliderRow(label, { min, max, step = 1, value, fmt = (v) => String(v) }, onChange) {
  const out = h('output', {}, fmt(value));
  const input = h('input', { type: 'range', min, max, step });
  input.value = String(value);
  input.addEventListener('input', () => { const v = parseFloat(input.value); out.textContent = fmt(v); onChange(v); });
  return { el: h('label', { class: 'ui-row ui-slider' }, h('span', { class: 'ui-label' }, label), input, out), set(v) { input.value = String(v); out.textContent = fmt(v); } };
}

export const section = (title, ...kids) => h('section', { class: 'ui-section' }, h('h3', {}, title), ...kids);

export function loadJson(key, fallback, storeApi) {
  try { const v = JSON.parse(storeApi.get(key)); return v ?? fallback; } catch { return fallback; }
}
