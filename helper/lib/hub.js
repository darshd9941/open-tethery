'use strict';

// The hub owns every WebSocket client: viewers, panels and sources
// (docs/PROTOCOL.md). It aggregates state, fans media out to viewers and routes
// playback commands from viewers to the panel.

const os = require('os');
const { WebSocket } = require('ws');
const otv1 = require('./otv1');
const otx1 = require('./otx1');
const { StateModel } = require('./state');
const { generateCode, codesMatch, Lockout, normalizeIp, isLoopbackAddress } = require('./session');

const HELLO_TIMEOUT_MS = 5000;
const STATE_MIN_INTERVAL_MS = 250; // at most ~4 state messages per second
const MAX_VIEWER_TEXT = 64 * 1024;
const AUDIO_BACKLOG_LIMIT = 256 * 1024; // skip PCM for a viewer this far behind
const CONTROL_TIMEOUT_MS = 5000;
const SEEK_TIMEOUT_MS = 2000;
const CONTROL_CMDS = new Set(['play', 'pause', 'toggle', 'seek', 'step', 'jump']);

// Browsers must not be able to drive panel/source roles or loopback APIs from a web page.
function originAllowed(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true; // file://, chrome-extension://, uxp://
    return isLoopbackAddress(u.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return true; // "null" and other non-URL origins (CEP / UXP hosts)
  }
}

class Hub {
  constructor({ log, rtc, version, allowControl = true, helloTimeoutMs = HELLO_TIMEOUT_MS, getAddresses, setConnection = null, lockout = new Lockout(), now = Date.now }) {
    this.log = log;
    this.rtc = rtc;
    this.version = version;
    this.allowControl = allowControl;
    this.helloTimeoutMs = helloTimeoutMs;
    this.getAddresses = getAddresses; // (code) => { urls, primaryUrl, connections }
    this.setConnection = setConnection; // (ip|null) => boolean; persists the choice
    this.recentStates = []; // last 50 state messages sent to the panel (for reports)
    this.lockout = lockout;
    this.now = now;
    this.model = new StateModel({ now });
    this.code = generateCode();
    this.clients = new Set();
    this.nextId = { viewer: 1, panel: 1, source: 1 };
    this.controlPanelId = null;
    this.reqCounter = 0;
    this.pendingReqs = new Map(); // req -> { viewer, cmd, timer }
    this.seekInFlight = null; // req
    this.pendingSeek = null; // { viewer, msg }
    this.seq = { video: 0, audio: 0 };
    this.latestFrame = null; // OTV1 buffer
    this.stats = { frames: 0, width: 0, height: 0 };
    this.startedAt = now();
    // H.264 from the Transmit plugin (docs/transmit-protocol.md): WebRTC is offered only while it flows.
    this.h264Active = false;
    this.pluginSend = null; // (buffer) => boolean, helper -> plugin over OTX1
    this.pluginSeq = 0;
    this.jpegWantedSent = null;
    if (rtc) {
      rtc.onChange = () => this.updateJpegWanted();
      rtc.requestKeyframe = () => this.requestKeyframe();
    }
    this.lastStateAt = 0;
    this.stateTimer = null;
    this.lastStateSig = '';
    this.timers = [
      setInterval(() => this.statsTick(), 1000),
      setInterval(() => this.housekeeping(), 250),
    ];
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.stateTimer);
    for (const c of this.clients) c.ws.terminate();
  }

  // ---- queries ----

  viewers() {
    return [...this.clients].filter((c) => c.role === 'viewer');
  }

  byRole(role) {
    return [...this.clients].filter((c) => c.role === role);
  }

  sessionInfo() {
    const { urls, primaryUrl, connections = [] } = this.getAddresses(this.code);
    return { code: this.code, urls, primaryUrl, connections, viewers: this.viewers().length, source: this.model.snapshot(this.viewers().length) };
  }

  controlPanel() {
    const panels = this.byRole('panel');
    return panels.find((p) => p.id === this.controlPanelId) || panels[panels.length - 1] || null;
  }

  // ---- connection lifecycle ----

  onConnection(ws, req) {
    const client = {
      ws,
      id: null,
      role: null,
      ip: normalizeIp(req.socket.remoteAddress),
      origin: req.headers.origin || '',
      name: '',
      control: this.allowControl,
      audioOn: false,
      inflight: false,
      pending: null,
      bytes: 0,
      dropped: 0,
      tele: null,
      info: null,
      send: (obj) => this.sendJson(client, obj),
    };
    this.clients.add(client);
    const helloTimer = setTimeout(() => {
      if (!client.role) {
        client.send({ t: 'error', code: 'hello-timeout' });
        ws.close(4000, 'hello timeout');
      }
    }, this.helloTimeoutMs);
    client.alive = true;
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.onBinary(client, data);
        else this.onText(client, data.toString('utf8'));
      } catch (err) {
        this.log(`ws message error (${client.role || 'new'} ${client.id || ''}): ${err.message}`);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.onClose(client);
    });
    ws.on('error', () => {});
  }

  onClose(client) {
    this.clients.delete(client);
    if (!client.role) return;
    this.log(`${client.role} ${client.id} disconnected`);
    if (client.role === 'viewer') {
      this.rtc.stop(client);
      this.dropReqsFor(client);
      this.updateJpegWanted();
    } else if (client.role === 'panel') {
      this.model.clearHost('panel', client.id);
      if (this.controlPanelId === client.id) this.controlPanelId = null;
      if (!this.controlPanel()) this.failAllReqs('no-host');
    } else if (client.role === 'source') {
      this.model.clearHost('source', client.id);
      if (!this.model.isLive()) this.latestFrame = null;
    }
    this.markDirty();
  }

  // ---- handshake ----

  onText(client, text) {
    if (client.role === 'viewer' && text.length > MAX_VIEWER_TEXT) return client.ws.close(1009, 'too big');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    if (!client.role) return this.onHello(client, msg);
    if (client.role === 'viewer') this.onViewerMessage(client, msg);
    else if (client.role === 'panel') this.onPanelMessage(client, msg);
    else this.onSourceMessage(client, msg);
  }

  reject(client, code, extra = {}) {
    client.send({ t: 'error', code, ...extra });
    setTimeout(() => client.ws.close(4001, code), 20);
  }

  onHello(client, msg) {
    if (msg.t !== 'hello') return this.reject(client, 'bad-hello');
    const role = msg.role;
    if (role === 'viewer') {
      const lock = this.lockout.check(client.ip, this.now());
      if (lock.locked) return this.reject(client, 'locked', { retryInSec: lock.retryInSec });
      if (!codesMatch(msg.code, this.code)) {
        this.lockout.fail(client.ip, this.now());
        this.log(`viewer from ${client.ip} gave a wrong code`);
        return this.reject(client, 'bad-code');
      }
      this.lockout.success(client.ip);
      client.name = typeof msg.name === 'string' ? msg.name.slice(0, 60) : '';
      client.accept = Array.isArray(msg.accept) ? msg.accept.filter((a) => typeof a === 'string') : [];
    } else if (role === 'panel' || role === 'source') {
      if (!isLoopbackAddress(client.ip) || !originAllowed(client.origin)) return this.reject(client, 'forbidden');
    } else {
      return this.reject(client, 'bad-hello');
    }

    client.role = role;
    client.id = `${role === 'viewer' ? 'v' : role === 'panel' ? 'p' : 's'}${this.nextId[role]++}`;
    client.control = role === 'viewer' ? this.allowControl : true;
    client.send({
      t: 'welcome',
      id: client.id,
      role,
      protocol: 1,
      control: client.control,
      webrtc: this.webrtcAvailable(client),
      server: { name: 'open-tethery', version: this.version, pcName: os.hostname() },
    });
    if (role === 'panel') {
      const app = typeof msg.app === 'string' ? msg.app : msg.host && msg.host.app;
      this.log(`panel opened ${app || 'unknown'}`);
      client.app = app || null;
    } else {
      this.log(`${role} ${client.id} connected${role === 'viewer' ? ` from ${client.ip} (${client.name || 'unnamed'})` : ''}`);
    }
    client.send(this.stateFor(client));
    if (role === 'viewer') {
      if (this.latestFrame) this.offerFrame(client, this.latestFrame);
      this.markDirty(); // viewer count changed
    }
  }

  // ---- viewer messages ----

  onViewerMessage(v, msg) {
    switch (msg.t) {
      case 'ping':
        v.send({ t: 'pong', ts: msg.ts, serverTs: this.now() });
        break;
      case 'audio':
        v.audioOn = msg.on === true;
        break;
      case 'info':
        if (typeof msg.name === 'string') v.name = msg.name.slice(0, 60);
        v.info = { w: Number(msg.w) || undefined, h: Number(msg.h) || undefined };
        this.markDirty();
        break;
      case 'telemetry':
        v.tele = {};
        for (const k of ['fps', 'delayMs', 'decodeMs', 'w', 'h']) if (Number.isFinite(msg[k])) v.tele[k] = msg[k];
        this.markDirty();
        break;
      case 'control':
        this.onViewerControl(v, msg);
        break;
      case 'rtc-start':
        if (!this.webrtcAvailable(v)) v.send({ t: 'error', code: 'unsupported', cmd: 'rtc-start' });
        else this.rtc.start(v);
        break;
      case 'rtc-answer':
        this.rtc.answer(v, msg.sdp);
        break;
      case 'rtc-ice':
        this.rtc.ice(v, msg.candidate);
        break;
      case 'rtc-stop':
        this.rtc.stop(v);
        break;
      default:
        break; // unknown t: ignore
    }
  }

  // ---- control routing ----

  onViewerControl(v, msg) {
    const cmd = msg.cmd;
    if (!this.allowControl) return v.send({ t: 'error', code: 'control-off', cmd });
    const panel = this.controlPanel();
    if (!panel) return v.send({ t: 'error', code: 'no-host', cmd });
    const out = { cmd };
    if (cmd === 'seek') {
      if (!Number.isFinite(msg.time) || msg.time < 0) return v.send({ t: 'error', code: 'unsupported', cmd });
      out.time = msg.time;
    } else if (cmd === 'step') {
      if (!Number.isInteger(msg.frames) || msg.frames === 0 || Math.abs(msg.frames) > 10000) return v.send({ t: 'error', code: 'unsupported', cmd });
      out.frames = msg.frames;
    } else if (cmd === 'jump') {
      if (msg.to !== 'start' && msg.to !== 'end') return v.send({ t: 'error', code: 'unsupported', cmd });
      out.to = msg.to;
    } else if (!CONTROL_CMDS.has(cmd)) {
      return v.send({ t: 'error', code: 'unsupported', cmd });
    }

    if (cmd === 'seek' && this.seekInFlight !== null) {
      // The panel is still busy with a seek: keep only the newest one.
      if (this.pendingSeek) this.ackViewer(this.pendingSeek.viewer, 'seek', { ok: true, coalesced: true });
      this.pendingSeek = { viewer: v, out };
      return;
    }
    this.dispatchControl(panel, v, out);
  }

  dispatchControl(panel, viewer, out) {
    const req = ++this.reqCounter;
    const timer = setTimeout(() => this.finishReq(req, { ok: false, error: 'timeout' }), out.cmd === 'seek' ? SEEK_TIMEOUT_MS : CONTROL_TIMEOUT_MS);
    this.pendingReqs.set(req, { viewer, cmd: out.cmd, timer });
    if (out.cmd === 'seek') this.seekInFlight = req;
    panel.send({ t: 'control', req, ...out });
  }

  finishReq(req, result) {
    const p = this.pendingReqs.get(req);
    if (!p) return;
    this.pendingReqs.delete(req);
    clearTimeout(p.timer);
    if (p.cmd === 'seek' && this.seekInFlight === req) {
      this.seekInFlight = null;
      this.flushPendingSeek();
    }
    if (result.ok) this.ackViewer(p.viewer, p.cmd, { ok: true });
    else if (result.error === 'timeout') this.ackViewer(p.viewer, p.cmd, { ok: false, error: 'timeout' });
    else {
      // the panel's failure code (e.g. "unsupported") goes to the viewer as an error
      const code = typeof result.error === 'string' && result.error ? result.error : 'failed';
      p.viewer.send({ t: 'error', code, cmd: p.cmd, ...(typeof result.message === 'string' ? { message: result.message.slice(0, 200) } : {}) });
    }
  }

  flushPendingSeek() {
    const next = this.pendingSeek;
    this.pendingSeek = null;
    if (!next || !this.clients.has(next.viewer)) return;
    const panel = this.controlPanel();
    if (!panel) return next.viewer.send({ t: 'error', code: 'no-host', cmd: 'seek' });
    this.dispatchControl(panel, next.viewer, next.out);
  }

  ackViewer(viewer, cmd, extra) {
    viewer.send({ t: 'control-ack', cmd, ...extra });
  }

  dropReqsFor(viewer) {
    for (const [req, p] of this.pendingReqs) {
      if (p.viewer === viewer) {
        clearTimeout(p.timer);
        this.pendingReqs.delete(req);
        if (this.seekInFlight === req) this.seekInFlight = null;
      }
    }
    if (this.pendingSeek && this.pendingSeek.viewer === viewer) this.pendingSeek = null;
    if (this.seekInFlight === null) this.flushPendingSeek();
  }

  failAllReqs(error) {
    this.pendingSeek = null;
    for (const req of [...this.pendingReqs.keys()]) this.finishReq(req, { ok: false, error });
  }

  // ---- panel / source messages ----

  onPanelMessage(p, msg) {
    switch (msg.t) {
      case 'host-state':
        this.model.setHost('panel', p.id, msg);
        this.controlPanelId = p.id;
        if (!p.app && msg.host && msg.host.app) {
          p.app = msg.host.app;
          this.log(`panel opened ${p.app}`);
        }
        this.markDirty();
        break;
      case 'panel-settings':
        if (typeof msg.allowControl === 'boolean') this.setAllowControl(msg.allowControl);
        if ((typeof msg.connection === 'string' || msg.connection === null) && this.setConnection) {
          if (this.setConnection(msg.connection || null)) {
            this.log(`connection set to ${msg.connection || 'auto'}`);
            this.markDirty();
          }
        }
        break;
      case 'new-session':
        this.newSession();
        break;
      case 'kick': {
        const v = this.viewers().find((c) => c.id === msg.id);
        if (v) {
          this.log(`kick ${v.id}`);
          v.send({ t: 'error', code: 'kicked' });
          setTimeout(() => v.ws.close(4002, 'kicked'), 20);
        }
        break;
      }
      case 'control-result':
        this.finishReq(msg.req, { ok: msg.ok === true, error: msg.code || msg.error, message: msg.message });
        break;
      case 'get-state':
        p.send(this.stateFor(p));
        break;
      case 'ping':
        p.send({ t: 'pong', ts: msg.ts, serverTs: this.now() });
        break;
      default:
        break;
    }
  }

  onSourceMessage(s, msg) {
    if (msg.t === 'source-state') {
      this.model.setHost('source', s.id, msg);
      this.markDirty();
    } else if (msg.t === 'ping') {
      s.send({ t: 'pong', ts: msg.ts, serverTs: this.now() });
    }
  }

  setAllowControl(allow) {
    if (allow === this.allowControl) return;
    this.allowControl = allow;
    this.log(`control from phones ${allow ? 'on' : 'off'}`);
    for (const v of this.viewers()) {
      v.control = allow;
      v.send({ t: 'perm', control: allow });
    }
    if (!allow) this.pendingSeek = null;
  }

  newSession() {
    this.code = generateCode();
    this.log(`new session code ${this.code}`);
    for (const v of this.viewers()) {
      v.send({ t: 'error', code: 'session-ended' });
      setTimeout(() => v.ws.close(4003, 'session ended'), 20);
      // drop them from the registry right away so counts are right
      this.clients.delete(v);
      this.rtc.stop(v);
      this.dropReqsFor(v);
      v.role = null;
    }
    this.pushState(true);
    return this.code;
  }

  // ---- media in ----

  onBinary(client, data) {
    if (client.role !== 'source' && client.role !== 'panel') {
      if (client.role === 'viewer') client.ws.close(1003, 'binary not accepted');
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    const m = otv1.decode(buf);
    if (!m) return;
    if (m.kind === otv1.KIND_JPEG) {
      // JPEG bytes are forwarded unchanged: the source embeds any ICC profile itself.
      this.publishFrame({
        origin: 'source',
        sourceId: client.id,
        jpeg: m.jpeg,
        flags: m.flags,
        time: m.time,
        width: m.width,
        height: m.height,
        srcWidth: m.srcWidth,
        srcHeight: m.srcHeight,
      });
    } else {
      this.publishAudio({ time: m.time, sampleRate: m.sampleRate, channels: m.channels, format: m.format, frames: m.frames, samples: m.samples });
    }
  }

  onTransmitConnection(connected) {
    this.model.setTransmitConnected(connected);
    this.jpegWantedSent = true; // a new plugin connection starts with "jpeg wanted" (the documented default)
    if (!connected) {
      if (this.h264Active) {
        this.h264Active = false;
        this.announceWebrtc();
      }
      if (!this.model.isLive()) this.latestFrame = null;
    }
    if (connected) this.updateJpegWanted();
    this.markDirty();
  }

  // ---- H.264 from the plugin (OTX1 type 4/5) and the reverse channel (type 64/65) ----

  // send: (buffer) => boolean, writes a helper -> plugin OTX1 message
  setPluginLink(send) {
    this.pluginSend = send;
  }

  // WebRTC is offered to a viewer that accepts it, while werift is loaded and an H.264 source is active.
  webrtcAvailable(viewer) {
    return Boolean(this.rtc.available && this.h264Active && viewer && viewer.role === 'viewer' && viewer.accept && viewer.accept.includes('webrtc'));
  }

  announceWebrtc() {
    for (const v of this.viewers()) if (v.accept && v.accept.includes('webrtc')) v.send({ t: 'webrtc', available: this.webrtcAvailable(v) });
    this.updateJpegWanted();
  }

  requestKeyframe() {
    if (this.pluginSend) this.pluginSend(otx1.requestKeyframeMessage(this.pluginSeq++));
  }

  // The plugin sends JPEG alongside H.264 only while some viewer cannot use the H.264 stream.
  updateJpegWanted() {
    if (!this.pluginSend) return;
    const wanted = !this.h264Active || this.viewers().some((v) => !this.rtc.isConnected(v));
    if (wanted === this.jpegWantedSent) return;
    if (this.pluginSend(otx1.jpegWantedMessage(this.pluginSeq++, wanted))) this.jpegWantedSent = wanted;
  }

  onTransmitH264(au) {
    if (!this.h264Active) {
      this.h264Active = true;
      this.log('transmit: H.264 stream active');
      this.announceWebrtc();
    }
    const wasLive = this.model.isLive();
    this.stats.frames += 1;
    this.stats.width = au.width;
    this.stats.height = au.height;
    this.model.noteFrame({ origin: 'transmit', time: au.time, srcWidth: au.width, srcHeight: au.height });
    this.rtc.pushH264(au);
    this.markDirty();
    if (!wasLive) this.pushState();
  }

  onTransmitAudio(a) {
    this.publishAudio(a);
  }

  onTransmitHeartbeat() {
    this.model.noteTransmitActivity();
  }

  onTransmitState(obj) {
    this.model.setTransmitState(obj);
    this.markDirty();
  }

  onTransmitFrame(f) {
    this.publishFrame({
      origin: 'transmit',
      jpeg: f.jpeg,
      flags: otv1.FLAG_KEYFRAME,
      time: f.time,
      width: f.width,
      height: f.height,
      srcWidth: f.seqWidth,
      srcHeight: f.seqHeight,
      fpsNum: f.fpsNum,
      fpsDen: f.fpsDen,
    });
  }

  publishFrame(f) {
    const wasLive = this.model.isLive();
    const buf = otv1.encodeFrame({ seq: ++this.seq.video, ...f });
    this.latestFrame = buf;
    if (!(this.h264Active && f.origin === 'transmit')) this.stats.frames += 1; // H.264 units are counted instead
    if (!this.h264Active) {
      this.stats.width = f.width;
      this.stats.height = f.height;
    }
    this.model.noteFrame({
      origin: f.origin,
      sourceId: f.sourceId,
      time: f.time,
      srcWidth: f.srcWidth,
      srcHeight: f.srcHeight,
      fpsNum: f.fpsNum,
      fpsDen: f.fpsDen,
    });
    this.rtc.pushFrame({ ...f, seq: this.seq.video });
    for (const v of this.viewers()) this.offerFrame(v, buf);
    this.markDirty(); // throttled, so a 60 fps source still yields at most ~4 state/s
    if (!wasLive) this.pushState();
  }

  publishAudio(a) {
    const buf = otv1.encodeAudio({ seq: ++this.seq.audio, ...a });
    this.model.noteAudio({ sampleRate: a.sampleRate, channels: a.channels });
    this.rtc.pushAudio(a);
    for (const v of this.viewers()) {
      if (!v.audioOn || (this.rtc.carriesAudio && this.rtc.carriesAudio(v))) continue;
      if (v.ws.readyState !== WebSocket.OPEN || v.ws.bufferedAmount > AUDIO_BACKLOG_LIMIT) continue;
      v.bytes += buf.length;
      v.ws.send(buf, { binary: true });
    }
  }

  // ---- fan-out: newest frame wins, at most one frame in flight + one pending ----

  offerFrame(v, buf) {
    if (v.ws.readyState !== WebSocket.OPEN || this.rtc.isConnected(v)) return;
    if (v.inflight || v.ws.bufferedAmount > 0) {
      if (v.pending) v.dropped += 1; // replaced a frame nobody saw
      v.pending = buf;
      return;
    }
    v.inflight = true;
    v.ws.send(buf, { binary: true }, () => {
      v.inflight = false;
      v.bytes += buf.length;
      if (v.pending) {
        const next = v.pending;
        v.pending = null;
        this.offerFrame(v, next);
      }
    });
  }

  // ---- state ----

  stateFor(client) {
    const state = this.model.snapshot(this.viewers().length);
    if (client.role === 'panel') {
      const { urls, primaryUrl, connections = [] } = this.getAddresses(this.code);
      state.viewerList = this.viewers().map((v) => ({
        id: v.id,
        name: v.name,
        ip: v.ip,
        ...(v.info && v.info.w ? { w: v.info.w, h: v.info.h } : {}),
        ...(v.tele || {}),
      }));
      state.code = this.code;
      state.urls = urls;
      state.primaryUrl = primaryUrl;
      state.connections = connections;
      state.allowControl = this.allowControl;
    }
    return state;
  }

  markDirty() {
    if (this.stateTimer) return;
    const wait = Math.max(0, this.lastStateAt + STATE_MIN_INTERVAL_MS - this.now());
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.pushState();
    }, wait);
  }

  pushState(force = false) {
    clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.lastStateAt = this.now();
    const viewerState = JSON.stringify(this.stateFor({ role: 'viewer' }));
    const panels = this.byRole('panel');
    const panelState = panels.length ? JSON.stringify(this.stateFor({ role: 'panel' })) : '';
    const sig = viewerState + panelState;
    if (!force && sig === this.lastStateSig) return;
    this.lastStateSig = sig;
    for (const v of [...this.viewers(), ...this.byRole('source')]) this.sendRaw(v, viewerState);
    for (const p of panels) this.sendRaw(p, panelState);
    if (panelState) {
      this.recentStates.push(panelState);
      if (this.recentStates.length > 50) this.recentStates.shift();
    }
  }

  // Viewer list with telemetry, for diagnostics reports.
  viewerReport() {
    return this.viewers().map((v) => ({ id: v.id, name: v.name, ip: v.ip, info: v.info, telemetry: v.tele, bytes: v.bytes, dropped: v.dropped }));
  }

  // ---- periodic work ----

  housekeeping() {
    this.updateJpegWanted(); // viewers' WebRTC state changes with time (stall -> JPEG again)
    // idle <-> live and audio availability change with time, not with messages
    const sig = `${this.model.isLive()}|${this.model.snapshot().audio.available}`;
    if (sig !== this.idleSig) {
      this.idleSig = sig;
      this.markDirty();
    }
    for (const v of this.viewers()) {
      if (v.pending && !v.inflight && v.ws.bufferedAmount === 0) {
        const next = v.pending;
        v.pending = null;
        this.offerFrame(v, next);
      }
    }
    const t = this.now();
    if (t - (this.lastPing || 0) > 15000) {
      this.lastPing = t;
      for (const c of this.clients) {
        if (!c.alive) c.ws.terminate();
        else {
          c.alive = false;
          try {
            c.ws.ping();
          } catch {
            // closing
          }
        }
      }
    }
  }

  statsTick() {
    const panels = this.byRole('panel');
    const sources = this.byRole('source');
    const active = this.model.transmit.connected || panels.length > 0 || sources.length > 0;
    const fps = this.stats.frames;
    this.stats.frames = 0;
    const viewers = this.viewers();
    let totalBytes = 0;
    let totalDropped = 0;
    const seq = (this.model.latestHost() || {}).sequence || {};
    const srcFps = seq.fpsNum > 0 && seq.fpsDen > 0 ? Math.round((seq.fpsNum / seq.fpsDen) * 1000) / 1000 : undefined;
    const base = {
      t: 'stats',
      fps,
      width: this.stats.width,
      height: this.stats.height,
      viewers: viewers.length,
      ...(srcFps ? { srcFps } : {}),
      uptimeSec: Math.floor((this.now() - this.startedAt) / 1000),
    };
    for (const v of viewers) {
      totalBytes += v.bytes;
      totalDropped += v.dropped;
      if (active) {
        v.send({ ...base, kbps: Math.round((v.bytes * 8) / 1000), transport: this.rtc.isConnected(v) ? 'webrtc' : 'jpeg', dropped: v.dropped });
      }
      v.bytes = 0;
      v.dropped = 0;
    }
    if (active) for (const p of panels) p.send({ ...base, kbps: Math.round((totalBytes * 8) / 1000), dropped: totalDropped });
  }

  // ---- sending ----

  sendRaw(client, text) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(text);
  }

  sendJson(client, obj) {
    this.sendRaw(client, JSON.stringify(obj));
  }
}

module.exports = { Hub, originAllowed, CONTROL_CMDS };
