// Playback control (milestone M5): message building + availability rules. No DOM.
import { createSeekThrottle } from './throttle.js';
import { brand } from './brand.js';

// Can the transport bar be used right now? `note` explains why not.
export function controlState({ control, state }) {
  const app = state?.host?.app;
  if (app === 'photoshop') return { enabled: false, note: 'Photoshop has no playback to control.' };
  if (control === false) {
    return { enabled: false, note: `Playback control is off. Turn on "Allow control from phones" in the ${brand.shortName} panel on the PC.` };
  }
  if (!state || state.status !== 'live') return { enabled: false, note: 'Waiting for the editor to connect.' };
  return { enabled: true, note: '' };
}

export function errorText(code, cmd) {
  switch (code) {
    case 'control-off': return 'Control is off. Turn on "Allow control from phones" on the PC.';
    case 'no-host': return 'No Premiere Pro or After Effects is connected right now.';
    case 'unsupported': return `This app can't do "${cmd || 'that'}".`;
    default: return `Command failed (${code}).`;
  }
}

export function clampTime(t, duration) {
  let v = Math.max(0, Number(t) || 0);
  if (Number.isFinite(duration) && duration > 0) v = Math.min(v, duration);
  return v;
}

export function createTransport({ send, getTime, getDuration, throttle = {} }) {
  const cmd = (c, extra) => send({ t: 'control', cmd: c, ...extra });
  const seekThrottle = createSeekThrottle((time) => cmd('seek', { time }), throttle);
  return {
    play: () => cmd('play'),
    pause: () => cmd('pause'),
    toggle: () => cmd('toggle'),
    step: (frames) => cmd('step', { frames }),
    jump: (to) => cmd('jump', { to }),
    // Relative jump in seconds (one-off, not throttled).
    skip(sec) {
      seekThrottle.cancel();
      cmd('seek', { time: clampTime((getTime() || 0) + sec, getDuration()) });
    },
    // Scrub: call repeatedly while dragging, then end().
    scrub: (time) => seekThrottle.push(clampTime(time, getDuration())),
    endScrub: () => seekThrottle.flush(),
  };
}
