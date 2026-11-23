// Session code helpers. Pure.
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

// Upper-case and drop every character that cannot be in a code.
export function normalizeCode(text) {
  let out = '';
  for (const ch of String(text ?? '').toUpperCase()) if (ALPHABET.includes(ch)) out += ch;
  return out;
}

export function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && normalizeCode(code) === code;
}

// "/c/cl7g" or "/c/CL7G/" -> "CL7G"; anything else -> null.
export function codeFromPath(pathname) {
  const m = /^\/c\/([A-Za-z0-9]{4})\/?$/.exec(String(pathname ?? ''));
  if (!m) return null;
  const code = normalizeCode(m[1]);
  return isValidCode(code) ? code : null;
}

// Pasted text may be a whole link ("http://pc:47825/c/CL7G"), a sentence or just the code.
export function extractCode(text) {
  const s = String(text ?? '');
  const link = /\/c\/([A-Za-z0-9]{4})(?![A-Za-z0-9])/.exec(s);
  if (link && isValidCode(normalizeCode(link[1]))) return normalizeCode(link[1]);
  for (const m of s.matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{4}(?![A-Za-z0-9])/g)) {
    const c = normalizeCode(m[0]);
    if (isValidCode(c)) return c;
  }
  return normalizeCode(s).slice(0, CODE_LENGTH);
}

// Four boxes. Typing or pasting `text` at box `index` fills forward.
// Returns the new chars, the box to focus next and whether all four are filled.
export function editCode(chars, index, text) {
  const next = Array.from({ length: CODE_LENGTH }, (_, i) => chars?.[i] || '');
  const s = String(text ?? '');
  const clean = s.length > 1 ? extractCode(s) : normalizeCode(s);
  if (!clean) return { chars: next, focus: index, complete: next.every(Boolean) };
  let i = index;
  for (const ch of clean) {
    if (i >= CODE_LENGTH) break;
    next[i++] = ch;
  }
  return { chars: next, focus: Math.min(i, CODE_LENGTH - 1), complete: next.every(Boolean) };
}

export function lockText(retryInSec) {
  const n = Math.max(0, Math.ceil(retryInSec));
  return `Too many wrong codes. Try again in ${n} second${n === 1 ? '' : 's'}.`;
}
