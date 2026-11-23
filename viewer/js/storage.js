// localStorage that never throws (private mode, blocked storage).
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};
