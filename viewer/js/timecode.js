// Time formatting helpers. Pure.
const pad = (n, w = 2) => String(n).padStart(w, '0');

// Non-drop timecode HH:MM:SS:FF using the nominal frame rate (23.976 counts as 24).
export function formatTimecode(sec, fps) {
  if (!Number.isFinite(sec)) return '--:--:--:--';
  const t = Math.max(0, sec);
  if (!Number.isFinite(fps) || fps <= 0) {
    const s = Math.floor(t);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }
  const base = Math.max(1, Math.round(fps));
  const total = Math.floor(t * fps + 1e-4);
  const f = total % base;
  const s = Math.floor(total / base);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}

// 23.976 -> "23.976", 30 -> "30", 29.97 -> "29.97"
export function formatFps(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return '';
  return String(parseFloat(fps.toFixed(3)));
}

// Short m:ss (or h:mm:ss) for the scrub bar ends.
export function formatClock(sec) {
  if (!Number.isFinite(sec)) return '-:--';
  const s = Math.floor(Math.max(0, sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// "Main edit" + "00:00:12:12" -> "Main_edit_00-00-12-12.png" (safe on Windows, iOS, Android).
export function frameFileName(sequence, timecode) {
  const clean = (s) => String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  const seq = clean(sequence) || 'frame';
  const tc = clean(timecode);
  return `${seq}${tc ? '_' + tc : ''}.png`;
}
