// Picture rectangle math. Pure.
// Fit an aw:ah picture inside a cw x ch box, centred (letter-box / pillar-box).
export function fitRect(cw, ch, aw, ah) {
  if (!(cw > 0 && ch > 0 && aw > 0 && ah > 0)) return { x: 0, y: 0, w: Math.max(0, cw || 0), h: Math.max(0, ch || 0) };
  const scale = Math.min(cw / aw, ch / ah);
  const w = Math.round(aw * scale);
  const h = Math.round(ah * scale);
  return { x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w, h };
}
