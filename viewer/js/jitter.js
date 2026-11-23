// Audio jitter-buffer scheduling math. Pure: the caller passes the AudioContext clock.
export const BASE_MS = 100;       // audio jitter buffer (and matching video hold while sound is on)
export const OFFSET_MIN = -300;
export const OFFSET_MAX = 300;

// Sync offset (ms, positive = sound later than picture) -> how long to hold audio and video.
// While sound is on, video is held BASE_MS so it lines up with the audio buffer.
export function latencies(offsetMs, audioOn) {
  if (!audioOn) return { audioSec: BASE_MS / 1000, videoSec: 0 };
  const off = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, Number(offsetMs) || 0));
  return {
    audioSec: (BASE_MS + Math.max(0, off)) / 1000,
    videoSec: (BASE_MS + Math.max(0, -off)) / 1000,
  };
}

export class JitterScheduler {
  constructor({ gapTolSec = 0.05, maxExtraSec = 0.25 } = {}) {
    this.gapTolSec = gapTolSec;
    this.maxExtraSec = maxExtraSec;
    this.reset();
  }

  reset() {
    this.nextStart = null;    // context time where the next chunk should start
    this.expectedMedia = NaN; // media time the next chunk should carry
  }

  // Returns { startAt, drop, reanchored }. Chunks are laid back to back; we re-anchor to
  // now + latency after an underrun or a media-time jump (seek), and drop a chunk when
  // we are running too far ahead (the host clock is faster than ours).
  schedule(now, mediaTime, durSec, latencySec) {
    let reanchored = false;
    if (this.nextStart == null) {
      reanchored = true;
    } else {
      const jumped = Number.isFinite(mediaTime) && Number.isFinite(this.expectedMedia)
        && Math.abs(mediaTime - this.expectedMedia) > this.gapTolSec;
      if (jumped || this.nextStart < now) reanchored = true;
      else if (this.nextStart - now > latencySec + this.maxExtraSec) {
        // Keep the media clock moving so the next chunk is not mistaken for a seek.
        if (Number.isFinite(mediaTime)) this.expectedMedia = mediaTime + durSec;
        return { startAt: this.nextStart, drop: true, reanchored: false };
      }
    }
    const startAt = reanchored ? now + latencySec : this.nextStart;
    this.nextStart = startAt + durSec;
    this.expectedMedia = Number.isFinite(mediaTime) ? mediaTime + durSec : NaN;
    return { startAt, drop: false, reanchored };
  }
}
