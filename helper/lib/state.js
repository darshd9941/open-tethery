'use strict';

// State aggregation: host-state (panel / source) + Transmit plugin state +
// frame facts -> the `state` message of PROTOCOL.md section 4.

const IDLE_AFTER_MS = 3000;
const APP_NAMES = { premiere: 'Premiere Pro', aftereffects: 'After Effects', photoshop: 'Photoshop' };

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

// 1920x1080 -> "16x9"; 2048x858 -> "2.39x1" (ratios that do not reduce to small integers).
function reduceAspect(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0) || !(h > 0)) return undefined;
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  if (a <= 32 && b <= 32) return `${a}x${b}`;
  const r = w / h;
  return r >= 1 ? `${Number(r.toFixed(2))}x1` : `1x${Number((1 / r).toFixed(2))}`;
}

// Seconds + frame rate -> "HH:MM:SS:FF" ("HH:MM:SS;FF" for 29.97 / 59.94 drop-frame).
// Unknown fps falls back to 24.
function timecodeFromTime(time, fpsNum, fpsDen) {
  let t = Number(time);
  if (!Number.isFinite(t) || t < 0) t = 0;
  let num = Number(fpsNum) || 0;
  let den = Number(fpsDen) || 0;
  if (num <= 0 || den <= 0) {
    num = 24;
    den = 1;
  }
  let frame = Math.floor((t * num) / den + 1e-6);
  const nominal = Math.round(num / den);
  const dropFrame = den === 1001 && (nominal === 30 || nominal === 60);
  if (dropFrame) {
    const drop = nominal === 30 ? 2 : 4;
    const perMin = nominal * 60 - drop;
    const per10Min = nominal * 600 - drop * 9;
    const tenMins = Math.floor(frame / per10Min);
    const rem = frame % per10Min;
    frame += drop * 9 * tenMins;
    if (rem > drop) frame += drop * Math.floor((rem - drop) / perMin);
  }
  const ff = frame % nominal;
  const total = Math.floor(frame / nominal);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}${dropFrame ? ';' : ':'}${pad(ff)}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Copies only the known fields (the protocol says unknown fields are ignored).
function cleanHost(host) {
  if (!host || typeof host !== 'object') return undefined;
  const out = {};
  for (const k of ['app', 'appName', 'version']) if (typeof host[k] === 'string') out[k] = host[k];
  return Object.keys(out).length ? out : undefined;
}

function cleanSequence(seq) {
  if (!seq || typeof seq !== 'object') return undefined;
  const out = {};
  if (typeof seq.name === 'string') out.name = seq.name;
  for (const k of ['width', 'height', 'fpsNum', 'fpsDen', 'duration', 'par']) if (isNum(seq[k])) out[k] = seq[k];
  return Object.keys(out).length ? out : undefined;
}

class StateModel {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.panels = new Map(); // panelId -> { at, host, sequence, playing, time }
    this.sources = new Map(); // sourceId -> same shape (+ profile)
    this.transmit = { connected: false, state: {}, lastFrameAt: 0, lastActivityAt: 0 };
    this.liveSources = new Set(); // source ids that have sent at least one frame
    this.frame = null; // { at, origin, time, width, height, srcWidth, srcHeight, fpsNum, fpsDen }
    this.audio = null; // { at, sampleRate, channels }
    this.transmitPlaying = false;
  }

  setHost(kind, id, msg) {
    const map = kind === 'panel' ? this.panels : this.sources;
    const prev = map.get(id) || {};
    map.set(id, {
      at: this.now(),
      host: cleanHost(msg.host) || prev.host,
      sequence: cleanSequence(msg.sequence) || prev.sequence,
      playing: typeof msg.playing === 'boolean' ? msg.playing : prev.playing,
      time: isNum(msg.time) ? msg.time : prev.time,
      timeAt: isNum(msg.time) ? this.now() : prev.timeAt || 0,
    });
  }

  clearHost(kind, id) {
    (kind === 'panel' ? this.panels : this.sources).delete(id);
    if (kind === 'source') {
      this.liveSources.delete(id);
      if (this.frame && this.frame.sourceId === id) this.frame = null;
    }
  }

  setTransmitConnected(connected) {
    this.transmit.connected = connected;
    if (!connected) {
      this.transmit.state = {};
      this.transmit.lastActivityAt = 0;
      this.transmitPlaying = false;
      if (this.frame && this.frame.origin === 'transmit') this.frame = null;
      this.audio = null;
    }
  }

  // Transmit plugin sent a frame or heartbeat.
  noteTransmitActivity() {
    this.transmit.lastActivityAt = this.now();
  }

  setTransmitState(obj) {
    this.transmit.state = { ...this.transmit.state, ...obj };
    if (typeof obj.playing === 'boolean') this.transmitPlaying = obj.playing;
  }

  noteFrame(info) {
    this.frame = { at: this.now(), ...info };
    if (info.origin === 'transmit') {
      this.transmit.lastFrameAt = this.frame.at;
      this.transmit.lastActivityAt = this.frame.at;
    } else if (info.sourceId) this.liveSources.add(info.sourceId);
  }

  noteAudio(info) {
    this.audio = { at: this.now(), ...info };
  }

  // The most recently updated host-state across panels and sources.
  latestHost() {
    let best = null;
    for (const e of [...this.panels.values(), ...this.sources.values()]) if (!best || e.at >= best.at) best = e;
    return best;
  }

  // Transmit plugin: live while frames or heartbeats arrive (idle after 3 s of neither).
  // A source (Photoshop) stays live while connected once it has sent a frame.
  isLive() {
    if (this.liveSources.size > 0) return true;
    return this.transmit.connected && this.now() - this.transmit.lastActivityAt < IDLE_AFTER_MS;
  }

  // viewers: number of connected viewers.
  snapshot(viewers = 0) {
    const now = this.now();
    const host = this.latestHost() || {};
    const tState = this.transmit.state;
    const live = this.isLive();
    const frame = live || this.frame ? this.frame : null;

    const hostInfo = { ...(host.host || {}) };
    if (!hostInfo.app && typeof tState.app === 'string') hostInfo.app = tState.app;
    if (!hostInfo.appName && APP_NAMES[hostInfo.app]) hostInfo.appName = APP_NAMES[hostInfo.app];
    if (!hostInfo.version && typeof tState.hostVersion === 'string') hostInfo.version = tState.hostVersion;

    const seq = { ...(host.sequence || {}) };
    if (!seq.name && typeof tState.sequence === 'string') seq.name = tState.sequence;
    if (frame) {
      if (!seq.width && frame.srcWidth) seq.width = frame.srcWidth;
      if (!seq.height && frame.srcHeight) seq.height = frame.srcHeight;
      if (!seq.fpsNum && frame.fpsNum > 0 && frame.fpsDen > 0) {
        seq.fpsNum = frame.fpsNum;
        seq.fpsDen = frame.fpsDen;
      }
    }
    if (seq.fpsNum > 0 && seq.fpsDen > 0) seq.fps = Math.round((seq.fpsNum / seq.fpsDen) * 1000) / 1000;
    const aspect = reduceAspect(seq.width, seq.height);
    if (aspect) seq.aspect = aspect;

    // time: whichever of the panel's last time and the newest frame's time is newer
    let time;
    if (frame && isNum(frame.time) && (!host.timeAt || frame.at >= host.timeAt)) time = frame.time;
    else if (isNum(host.time)) time = host.time;
    else if (frame && isNum(frame.time)) time = frame.time;

    let playing = host.playing;
    if (typeof playing !== 'boolean' && this.transmit.connected) playing = this.transmitPlaying;

    const out = { t: 'state', status: live ? 'live' : 'idle' };
    if (Object.keys(hostInfo).length) out.host = hostInfo;
    if (Object.keys(seq).length) out.sequence = seq;
    if (typeof playing === 'boolean') out.playing = playing;
    if (isNum(time)) {
      out.time = Math.round(time * 1000) / 1000;
      out.timecode = timecodeFromTime(time, seq.fpsNum, seq.fpsDen);
    }
    const audioLive = this.audio && now - this.audio.at < IDLE_AFTER_MS;
    out.audio = audioLive
      ? { available: true, sampleRate: this.audio.sampleRate, channels: this.audio.channels }
      : { available: false };
    out.engine = { transmit: this.transmit.connected, sending: Boolean(this.transmit.lastFrameAt) && now - this.transmit.lastFrameAt < IDLE_AFTER_MS };
    out.viewers = viewers;
    return out;
  }
}

module.exports = { StateModel, reduceAspect, timecodeFromTime, IDLE_AFTER_MS, APP_NAMES };
