// Client-side measurements: displayed fps, decode time, ping delay. No DOM.
export function createStats({ now = () => performance.now(), windowMs = 2000 } = {}) {
  let frames = [];          // timestamps of displayed frames
  let decode = [];          // [timestamp, ms]
  let rttMs = NaN;
  let server = null;        // latest {t:"stats"} message

  function trim(t) {
    while (frames.length && t - frames[0] > windowMs) frames.shift();
    while (decode.length && t - decode[0][0] > windowMs) decode.shift();
  }

  return {
    frameShown(decodeMs) {
      const t = now();
      frames.push(t);
      if (Number.isFinite(decodeMs)) decode.push([t, decodeMs]);
      trim(t);
    },
    pong(rtt) { rttMs = rtt; },
    setServer(s) { server = s; },
    snapshot() {
      const t = now();
      trim(t);
      const fps = frames.length > 1 ? (frames.length - 1) * 1000 / Math.max(1, frames[frames.length - 1] - frames[0]) : 0;
      const decodeMs = decode.length ? decode.reduce((a, d) => a + d[1], 0) / decode.length : NaN;
      const delayMs = Number.isFinite(rttMs) ? Math.round(rttMs / 2 + (Number.isFinite(decodeMs) ? decodeMs : 0)) : NaN;
      return { fps, decodeMs, rttMs, delayMs, server };
    },
  };
}
