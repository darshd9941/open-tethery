// Leading + trailing throttle for scrub seeks (<= ~15 per second). Clock and timers are injectable.
export function createSeekThrottle(send, opts = {}) {
  const intervalMs = opts.intervalMs ?? 67;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  let last = -Infinity;
  let pending;
  let has = false;
  let timer = null;

  function fire() {
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!has) return;
    has = false;
    last = now();
    send(pending);
  }

  return {
    push(value) {
      pending = value;
      has = true;
      const wait = intervalMs - (now() - last);
      if (wait <= 0) fire();
      else if (timer == null) timer = setTimer(fire, wait);
    },
    flush: fire,
    cancel() {
      has = false;
      if (timer != null) { clearTimer(timer); timer = null; }
    },
  };
}
