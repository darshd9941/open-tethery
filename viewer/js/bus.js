// Tiny event bus shared by core and feature modules. See CONTRACT.md.
const handlers = new Map();
const last = new Map();

export const bus = {
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type).delete(fn);
  },
  emit(type, payload) {
    last.set(type, payload);
    const set = handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.error(`[bus:${type}]`, err); }
    }
  },
  // Latest payload for a type (e.g. late-mounting modules read 'state').
  last(type) { return last.get(type); },
};
