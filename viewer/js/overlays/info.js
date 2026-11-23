// Info overlay: timecode, sequence name, play state, frame rate and host app drawn on the picture.
import { store } from '../storage.js';
import { s, mountSvg, setViewBox, toggleRow, section, loadJson } from '../ui-kit.js';
import { formatTimecode, formatFps } from '../timecode.js';
import { getLatestFrame } from '../frame-bus.js';

const KEY = 'ot.info.cfg';
const APPS = { premiere: 'Premiere Pro', aftereffects: 'After Effects', photoshop: 'Photoshop' };
const FIELDS = [
  ['timecode', 'Timecode'], ['sequence', 'Sequence name'], ['play', 'Play state'], ['fps', 'Frame rate'], ['host', 'Host app'],
];

const CSS = '.i-bg{fill:rgba(0,0,0,.6)}.i-t{fill:#fff;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600}';

// Lines to show for the current config and state. Pure.
export function infoLines(cfg, state, time) {
  const seq = state?.sequence;
  const fps = Number.isFinite(seq?.fps) ? seq.fps : (seq?.fpsNum && seq?.fpsDen ? seq.fpsNum / seq.fpsDen : NaN);
  const lines = [];
  if (cfg.timecode) lines.push(state?.host?.app === 'photoshop' ? '' : (Number.isFinite(time) ? formatTimecode(time, fps) : (state?.timecode || '--:--:--:--')));
  if (cfg.sequence && seq?.name) lines.push(seq.name);
  if (cfg.play && typeof state?.playing === 'boolean' && state?.host?.app !== 'photoshop') lines.push(state.playing ? 'PLAYING' : 'PAUSED');
  if (cfg.fps && formatFps(fps)) lines.push(`${formatFps(fps)} fps`);
  if (cfg.host && state?.host) lines.push(state.host.appName || APPS[state.host.app] || state.host.app || '');
  return lines.filter(Boolean);
}

export function initInfo({ bus, layer, panel }) {
  const cfg = Object.assign({ timecode: false, sequence: false, play: false, fps: false, host: false }, loadJson(KEY, {}, store));
  const svg = mountSvg(layer, 'info');
  let size = { w: layer.clientWidth || 0, h: layer.clientHeight || 0 };
  let time = getLatestFrame()?.time ?? NaN;
  let drawn = '';

  function render(force) {
    const { w, h } = size;
    const lines = infoLines(cfg, bus.last('state'), time);
    const key = `${w}x${h}|${lines.join('|')}`;
    if (!force && key === drawn) return;
    drawn = key;
    svg.replaceChildren(s('style', {}, CSS));
    if (!(w > 0 && h > 0) || !lines.length) return;
    setViewBox(svg, w, h);
    const fs = Math.max(10, Math.min(15, w * 0.04));
    const lh = fs * 1.5;
    const bw = Math.min(w - 12, Math.max(...lines.map((l) => l.length)) * fs * 0.62 + 14);
    svg.appendChild(s('rect', { x: 6, y: 6, width: bw, height: lines.length * lh + 6, rx: 6, class: 'i-bg' }));
    lines.forEach((l, i) => svg.appendChild(s('text', { x: 13, y: 6 + 3 + lh * (i + 0.5) + fs * 0.35, 'font-size': fs, class: 'i-t' }, l)));
  }

  const save = () => { store.set(KEY, JSON.stringify(cfg)); render(true); };
  panel.append(section('Show on picture', ...FIELDS.map(([k, label]) => toggleRow(label, cfg[k], (v) => { cfg[k] = v; save(); }).el)));

  const apply = (r) => { size = { w: r.w, h: r.h }; render(true); };
  bus.on('layout', apply);
  bus.on('state', () => render());
  let lastAt = 0;
  bus.on('frame', (f) => {
    if (Number.isFinite(f.time)) time = f.time;
    const now = performance.now();
    if (now - lastAt > 100) { lastAt = now; render(); }
  });
  const last = bus.last('layout');
  if (last) apply(last); else render(true);

  return {
    isActive: () => Object.values(cfg).some(Boolean),
    summary: () => { const n = Object.values(cfg).filter(Boolean).length; return n ? `${n} shown` : 'Off'; },
  };
}
