// Tiny module API for overlays, scopes and anything else that needs the picture.
//
//   import { onFrame, getStage, onLayout, getLatestFrame } from '/js/frame-bus.js';
//
//   onFrame(({ bitmap, canvas, width, height, srcW, srcH, time, seq }) => { ... })
//     Called for every displayed frame (and once at subscribe time if one exists).
//     `canvas` is the visible canvas holding the pixels of the latest frame (stable
//     element, read it with getImageData/drawImage). `bitmap` is the decoded ImageBitmap
//     (null on the Image fallback path); it is closed when the next frame arrives, so
//     use it synchronously inside the callback.
//   getStage()
//     The overlay container: an absolutely positioned div that always covers exactly
//     the picture rectangle (letter-boxed to srcW:srcH) and zooms/pans with it.
//     pointer-events: none by default; give your own children pointer-events if needed.
//   onLayout(({ x, y, w, h }) => ...)  picture rect in CSS px inside the stage.

let stage = null;
let latest = null;
let layout = null;
const frameSubs = new Set();
const layoutSubs = new Set();

const safe = (fn, arg) => { try { fn(arg); } catch (e) { console.error('[frame-bus]', e); } };

export function onFrame(cb) {
  frameSubs.add(cb);
  if (latest) safe(cb, latest);
  return () => frameSubs.delete(cb);
}

export function onLayout(cb) {
  layoutSubs.add(cb);
  if (layout) safe(cb, layout);
  return () => layoutSubs.delete(cb);
}

export function getStage() { return stage; }
export function getLatestFrame() { return latest; }

// Used by the app core only.
export function setStage(el) { stage = el; }
export function publishFrame(frame) {
  latest = frame;
  for (const cb of frameSubs) safe(cb, frame);
}
export function publishLayout(rect) {
  layout = rect;
  for (const cb of layoutSubs) safe(cb, rect);
}
