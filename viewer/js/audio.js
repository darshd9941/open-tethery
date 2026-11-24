// PCM playback through Web Audio with a small jitter buffer (scheduling maths in jitter.js).
import { JitterScheduler, latencies } from './jitter.js';
import { chunkLevels } from './scope-math.js';

// onLevels({l,r,peakL,peakR}) is called per pushed chunk (app.js publishes it as bus 'audio-levels').
export function createAudioPlayer({ onLevels } = {}) {
  let ctx = null;
  let gain = null;
  let on = false;
  let volume = 1;
  let offsetMs = 0;
  const sched = new JitterScheduler();

  return {
    get on() { return on; },
    get supported() { return typeof (globalThis.AudioContext || globalThis.webkitAudioContext) === 'function'; },

    // Must be called from a tap handler so iOS lets the context run.
    async enable() {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not available in this browser.');
      if (!ctx) {
        try { ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch { ctx = new AC(); }
        gain = ctx.createGain();
        gain.gain.value = volume;
        gain.connect(ctx.destination);
      }
      // Starting a silent buffer inside the gesture is the reliable iOS unlock.
      try {
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch { /* ignore */ }
      await ctx.resume();
      sched.reset();
      on = true;
    },

    disable() { on = false; sched.reset(); },
    resume() { if (on && ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); },
    get running() { return !!ctx && ctx.state === 'running'; },

    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (gain) gain.gain.value = volume;
    },
    setOffsetMs(ms) { offsetMs = ms; sched.reset(); },
    // How long the picture should be held back so it lines up with the sound.
    videoDelayMs() { return on ? latencies(offsetMs, true).videoSec * 1000 : 0; },

    push(chunk) {
      if (!on || !ctx || ctx.state !== 'running') return false;
      const { sampleRate, channels, frames, samples, time } = chunk;
      if (onLevels) { try { onLevels(chunkLevels(samples, channels)); } catch { /* meters must never break sound */ } }
      const dur = frames / sampleRate;
      const r = sched.schedule(ctx.currentTime, time, dur, latencies(offsetMs, true).audioSec);
      if (r.drop) return false;
      const buf = ctx.createBuffer(channels, frames, sampleRate);
      for (let c = 0; c < channels; c++) {
        const out = buf.getChannelData(c);
        for (let i = 0, j = c; i < frames; i++, j += channels) out[i] = samples[j] / 32768;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gain);
      src.start(r.startAt);
      return true;
    },
  };
}
