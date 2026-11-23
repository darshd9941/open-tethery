// Pinch-zoom, pan, double-tap fit/zoom and single-tap callback (ported from the old viewer).
// The transformed element is `zoomEl`; it fills `stage` and zooms around the stage centre.
export function createGestures({ stage, zoomEl, getContent, onTap, onChange }) {
  const MAX = 12;
  const MIN = 1;
  let scale = 1;
  let tx = 0;
  let ty = 0;

  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let moved = false;
  let tapTimer = null;
  let lastTap = { time: 0, x: 0, y: 0 };

  function apply() {
    zoomEl.style.transform = scale === 1 && !tx && !ty ? '' : `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    onChange?.({ scale });
  }

  function clamp() {
    const c = getContent();
    const maxX = Math.max(0, (c.w * scale - stage.clientWidth) / 2 + 0);
    const maxY = Math.max(0, (c.h * scale - stage.clientHeight) / 2 + 0);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
    if (scale === 1) { tx = 0; ty = 0; }
  }

  function zoomAt(cx, cy, next) {
    const s = Math.min(MAX, Math.max(MIN, next));
    const r = stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const ox = (px - tx) / scale;
    const oy = (py - ty) / scale;
    scale = s;
    tx = px - ox * scale;
    ty = py - oy * scale;
    clamp();
    apply();
  }

  function reset() { scale = 1; tx = 0; ty = 0; apply(); }

  // Fit <-> pixel-for-pixel (at least 2x so the double tap visibly does something).
  function toggle(cx, cy) {
    if (scale > 1.02) return reset();
    const c = getContent();
    const actual = c.w && c.srcW ? Math.max(2, c.srcW / c.w) : 2;
    const r = stage.getBoundingClientRect();
    zoomAt(cx ?? r.left + r.width / 2, cy ?? r.top + r.height / 2, Math.min(actual, 4));
  }

  const list = () => Array.from(pointers.values());

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    pinch = null;
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, tx, ty };
    else if (pointers.size === 2) {
      const [a, b] = list();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      drag = null;
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const [a, b] = list();
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (pinch) {
        zoomAt(mx, my, scale * (d / pinch.d));
        tx += mx - pinch.mx;
        ty += my - pinch.my;
        clamp();
        apply();
      }
      pinch = { d, mx, my };
      moved = true;
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 6) moved = true;
    if (scale > 1) {
      tx = drag.tx + dx;
      ty = drag.ty + dy;
      clamp();
      apply();
    }
  });

  function end(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const [p] = list();
      drag = { x: p.x, y: p.y, tx, ty };
    }
    if (pointers.size === 0) {
      drag = null;
      if (!moved && e.type === 'pointerup') handleTap(e);
    }
  }
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  function handleTap(e) {
    const now = Date.now();
    const dbl = now - lastTap.time < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
    clearTimeout(tapTimer);
    if (dbl) {
      lastTap = { time: 0, x: 0, y: 0 };
      toggle(e.clientX, e.clientY);
      return;
    }
    lastTap = { time: now, x: e.clientX, y: e.clientY };
    tapTimer = setTimeout(() => onTap?.(), 280);
  }

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, scale * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  return { reset, toggle, relayout() { clamp(); apply(); }, get scale() { return scale; } };
}
