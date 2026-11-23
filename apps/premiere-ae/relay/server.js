'use strict';

// Live Video Preview Relay for Premiere Pro & After Effects
// - Serves the mobile viewer page over LAN Wi-Fi
// - Accepts connection from the Premiere / AE CEP panel
// - Caches latest frame in memory and pushes to paired mobile browsers
// - Injects ICC profile for JPEG frames; handles PNG seamlessly

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { resolveProfile, injectProfile } = require('./icc');
const { startTransmitIngest } = require('./transmit-ingest');

const ROOT = path.resolve(__dirname, '..');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'relay.log');

const DEFAULT_PORT = 47825;
const DEFAULT_TRANSMIT_PORT = 47826; // native Transmit plugin ingest (loopback only)
const NATIVE_LIVE_MS = 3000; // native frames this recent mean the native plugin "owns" the preview
const VIEWER_BACKLOG_MIN = 256 * 1024; // skip frames for a viewer with more than this (or one frame) queued
const AUTH_TIMEOUT_MS = 15000;
const MAX_FRAME_BASE64 = 28 * 1024 * 1024; // ~21 MB
const MAX_FRAME_META_NAME = 300;

function loadConfig() {
  const defaults = { port: DEFAULT_PORT, lanIp: null, transmitPort: DEFAULT_TRANSMIT_PORT };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      port: Number.isInteger(parsed.port) ? parsed.port : defaults.port,
      transmitPort:
        Number.isInteger(parsed.transmitPort) && parsed.transmitPort > 0 && parsed.transmitPort < 65536
          ? parsed.transmitPort
          : defaults.transmitPort,
      lanIp: typeof parsed.lanIp === 'string' && parsed.lanIp.trim() ? parsed.lanIp.trim() : null,
    };
  } catch {
    return defaults;
  }
}

function isVirtualAdapter(name) {
  return /(vEthernet|hyper-v|vethernet|vmware|virtualbox|virtual box|docker|wsl|tailscale|zerotier|vpn|wireguard|openvpn|tap-|tap adapter|tun|bluetooth|loopback|npcap|hamachi|radmin|fortinet|cisco anyconnect)/i.test(name);
}

function rankAddress(name, address) {
  let score = 0;
  if (/^192\.168\./.test(address)) score += 40;
  else if (/^10\./.test(address)) score += 30;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 20;
  else score += 5;
  if (/ethernet|wi-?fi|wlan|local area connection/i.test(name)) score += 10;
  if (/^169\.254\./.test(address)) score -= 100;
  if (isVirtualAdapter(name)) score -= 200;
  return score;
}

function pickLanIp(override) {
  if (override) return override;
  const candidates = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' && address.family !== 4) continue;
      if (address.internal) continue;
      if (!address.address || address.address.startsWith('127.')) continue;
      if (address.address.startsWith('169.254.')) continue;
      candidates.push({
        name,
        address: address.address,
        score: rankAddress(name, address.address),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return candidates[0].address;
  return '127.0.0.1';
}

let logDirReady = false;
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logDirReady = true;
    }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // ignore logging failure
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function serveStatic(res, pathname) {
  let relative = pathname.replace(/^\/+/, '');
  if (!relative) relative = 'index.html';
  const filePath = path.resolve(VIEWER_DIR, relative);
  if (filePath !== VIEWER_DIR && !filePath.startsWith(VIEWER_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const config = loadConfig();
const PORT = config.port;
const TRANSMIT_PORT = config.transmitPort;

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
const LAN_IP = pickLanIp(config.lanIp);
const BASE_URL = `http://${LAN_IP}:${PORT}/`;
const STARTED_AT = Date.now();

let sessionToken = null;
let pluginSocket = null;
let pluginInfo = null;
let lastFrame = null;
const viewers = new Set();
let transmit = null; // set once the ingest listener starts
let lastNativeFrameAt = 0;
let skippedFrames = 0;

function transmitStatus() {
  return transmit ? transmit.status() : { connected: false, playing: false, fps: 0 };
}

function nativeLive() {
  return transmitStatus().connected && Date.now() - lastNativeFrameAt < NATIVE_LIVE_MS;
}

function frameMeta() {
  return lastFrame ? lastFrame.meta : null;
}

function statusPayload() {
  const tx = transmitStatus();
  return {
    type: 'status',
    pluginOnline: Boolean(pluginSocket) || tx.connected,
    hasFrame: Boolean(lastFrame),
    frame: frameMeta(),
    transmit: tx,
    serverTime: Date.now(),
  };
}

function send(ws, value) {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(value));
    return true;
  } catch (error) {
    log(`send failed: ${error.message}`);
    return false;
  }
}

function broadcast(value) {
  const text = JSON.stringify(value);
  for (const viewer of viewers) {
    if (viewer.readyState !== viewer.OPEN) continue;
    try {
      viewer.send(text);
    } catch {
      // closed
    }
  }
}

function broadcastStatus() {
  broadcast(statusPayload());
}

// ---- Native Transmit plugin frames -> viewers (binary WebSocket messages) ----
// Wire format to viewers: [u32 LE metaLen][meta JSON utf8][JPEG bytes].
function buildBinaryFrame(meta, jpeg) {
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(metaBuf.length, 0);
  return Buffer.concat([head, metaBuf, jpeg]);
}

function viewerCanTake(viewer, wire) {
  return viewer.bufferedAmount <= Math.max(VIEWER_BACKLOG_MIN, wire.length);
}

// Latest frame wins per viewer: if a phone is backed up we do not queue, we
// remember only the newest frame in viewer.pendingWire and flush it later.
function sendBinaryToViewer(viewer, wire) {
  if (viewer.readyState !== viewer.OPEN) return;
  if (!viewerCanTake(viewer, wire)) {
    viewer.pendingWire = wire;
    skippedFrames += 1;
    return;
  }
  viewer.pendingWire = null;
  try {
    viewer.send(wire, { binary: true });
  } catch {
    // closed
  }
}

function broadcastBinary(wire) {
  for (const viewer of viewers) sendBinaryToViewer(viewer, wire);
}

setInterval(() => {
  for (const viewer of viewers) {
    if (viewer.pendingWire && viewer.readyState === viewer.OPEN && viewerCanTake(viewer, viewer.pendingWire)) {
      const wire = viewer.pendingWire;
      viewer.pendingWire = null;
      try {
        viewer.send(wire, { binary: true });
      } catch {
        // closed
      }
    }
  }
}, 100).unref();

function handleTransmitFrame(frame, status, state) {
  // The native plugin has no pairing flow of its own: make sure a session exists.
  if (!sessionToken) sessionToken = crypto.randomBytes(24).toString('base64url');
  lastNativeFrameAt = Date.now();
  const meta = {
    name: (state && typeof state.sequence === 'string' && state.sequence.slice(0, MAX_FRAME_META_NAME)) || 'Premiere Pro',
    timecode: frame.timecode,
    host: 'Premiere Pro',
    mime: 'image/jpeg',
    width: frame.width,
    height: frame.height,
    seqWidth: frame.seqWidth,
    seqHeight: frame.seqHeight,
    fps: Math.round(frame.fps * 1000) / 1000,
    profile: 'sRGB',
    source: 'transmit',
    timestamp: lastNativeFrameAt,
    bytes: frame.jpeg.length,
  };
  const wire = buildBinaryFrame(meta, frame.jpeg);
  lastFrame = { base64: null, wire, meta, receivedAt: lastNativeFrameAt };
  broadcastBinary(wire);
}

function handleTransmitChange(status) {
  if (status.connected && !sessionToken) sessionToken = crypto.randomBytes(24).toString('base64url');
  broadcastStatus();
}

function clearSession(reason) {
  sessionToken = null;
  lastFrame = null;
  for (const viewer of viewers) {
    try {
      viewer.close(4003, reason || 'Preview stopped');
    } catch {
      // ignore
    }
  }
  viewers.clear();
}

function sanitizeMeta(meta) {
  const input = meta && typeof meta === 'object' ? meta : {};
  const name = typeof input.name === 'string' ? input.name.slice(0, MAX_FRAME_META_NAME) : 'Untitled';
  const toInt = (val, fb) => {
    const n = Number(val);
    return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n) : fb;
  };
  const profile = typeof input.profile === 'string' ? input.profile.slice(0, 80) : 'sRGB';
  const timecode = typeof input.timecode === 'string' ? input.timecode : '00:00:00:00';
  const host = typeof input.host === 'string' ? input.host : 'Video';
  const mime = typeof input.mime === 'string' ? input.mime : 'image/jpeg';
  return {
    name,
    timecode,
    host,
    mime,
    width: toInt(input.width, 0),
    height: toInt(input.height, 0),
    fps: Number(input.fps) || 0,
    profile,
    timestamp: Date.now(),
  };
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { ok: true, uptimeMs: Date.now() - STARTED_AT });
    return;
  }

  if (pathname === '/info') {
    sendJson(res, 200, {
      ok: true,
      ip: LAN_IP,
      port: PORT,
      url: BASE_URL,
      pluginOnline: Boolean(pluginSocket) || transmitStatus().connected,
      plugin: pluginInfo,
      transmit: { ...transmitStatus(), port: TRANSMIT_PORT, viewersSkippedFrames: skippedFrames },
      // Pairing URL for the native plugin flow (no CEP panel to show a QR). Loopback callers only.
      pairUrl:
        sessionToken && isLoopback(req.socket.remoteAddress) ? `${BASE_URL}#pair=${sessionToken}` : undefined,
      hasSession: Boolean(sessionToken),
      viewers: viewers.size,
      hasFrame: Boolean(lastFrame),
      frame: frameMeta(),
      serverTime: Date.now(),
      startedAt: STARTED_AT,
    });
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  serveStatic(res, pathname);
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_FRAME_BASE64 + 4096,
  perMessageDeflate: false,
});

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

function attachPlugin(ws, token, info) {
  const isSameSession = sessionToken === token;
  if (pluginSocket && pluginSocket !== ws) {
    try {
      pluginSocket.close(4002, 'Replaced by newer connection');
    } catch {
      // ignore
    }
  }
  if (!isSameSession) {
    lastFrame = null;
    for (const viewer of viewers) {
      try {
        viewer.close(4003, 'A new preview session started');
      } catch {
        // ignore
      }
    }
    viewers.clear();
  }
  sessionToken = token;
  pluginSocket = ws;
  pluginInfo = info;
  ws.role = 'plugin';

  send(ws, {
    type: 'registered',
    url: `${BASE_URL}#pair=${token}`,
    ip: LAN_IP,
    port: PORT,
    serverTime: Date.now(),
  });

  broadcastStatus();
  log(`plugin registered (${info && info.host ? info.host : 'Video Host'})`);
}

function attachViewer(ws, token) {
  if (!sessionToken || token !== sessionToken) {
    send(ws, { type: 'error', code: 'no-session', message: 'No active preview session' });
    ws.close(4001, 'No active preview session');
    return;
  }
  ws.role = 'viewer';
  viewers.add(ws);
  send(ws, {
    ...statusPayload(),
    type: 'welcome',
    serverTime: Date.now(),
  });
  if (lastFrame && lastFrame.wire) {
    try {
      ws.send(lastFrame.wire, { binary: true });
    } catch {
      // closed
    }
  } else if (lastFrame) {
    send(ws, {
      type: 'frame',
      data: lastFrame.base64,
      meta: lastFrame.meta,
      receivedAt: lastFrame.receivedAt,
    });
  }
  log(`viewer connected (${viewers.size} active)`);
}

function handlePluginMessage(ws, msg) {
  if (ws !== pluginSocket) return;

  if (msg.type === 'frame') {
    // Native plugin wins while its frames are live.
    if (nativeLive()) return;
    if (typeof msg.data !== 'string' || msg.data.length < 32) return;
    if (msg.data.length > MAX_FRAME_BASE64) {
      log('dropped oversized frame');
      return;
    }

    let buffer;
    try {
      buffer = Buffer.from(msg.data, 'base64');
    } catch {
      return;
    }

    const meta = sanitizeMeta(msg.meta);
    let output = buffer;

    // If JPEG, attempt ICC profile injection
    const isJpeg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8;
    if (isJpeg) {
      try {
        const icc = resolveProfile(meta.profile);
        if (icc) output = injectProfile(buffer, icc);
      } catch (err) {
        log(`ICC injection skipped: ${err.message}`);
        output = buffer;
      }
    }

    const base64 = output.toString('base64');
    lastFrame = {
      base64,
      meta: { ...meta, bytes: output.length },
      receivedAt: Date.now(),
    };
    broadcast({ type: 'frame', data: base64, meta: lastFrame.meta, receivedAt: lastFrame.receivedAt });
    return;
  }

  if (msg.type === 'stop') {
    log('plugin stopped session');
    clearSession('Preview stopped');
    sessionToken = null;
    pluginSocket = null;
    pluginInfo = null;
    broadcastStatus();
    try {
      ws.close(1000, 'Stopped');
    } catch {
      // ignore
    }
    return;
  }

  if (msg.type === 'ping') {
    send(ws, { type: 'pong', serverTime: Date.now() });
    return;
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;

  const authTimer = setTimeout(() => {
    if (!ws.role) {
      try {
        ws.close(4001, 'Auth timeout');
      } catch {
        // ignore
      }
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (!ws.role) {
      if (msg.type === 'register') {
        clearTimeout(authTimer);
        attachPlugin(ws, String(msg.token || ''), {
          name: msg.name,
          version: msg.version,
          host: msg.host,
        });
        return;
      }
      if (msg.type === 'hello' && msg.role === 'viewer') {
        clearTimeout(authTimer);
        attachViewer(ws, String(msg.token || ''));
        return;
      }
      return;
    }

    if (ws.role === 'plugin') {
      handlePluginMessage(ws, msg);
    } else if (ws.role === 'viewer') {
      if (msg.type === 'ping') {
        send(ws, { type: 'pong', serverTime: Date.now() });
      }
    }
  });

  ws.on('close', () => {
    if (ws.role === 'plugin' && pluginSocket === ws) {
      log('plugin disconnected');
      pluginSocket = null;
      pluginInfo = null;
      broadcastStatus();
    } else if (ws.role === 'viewer') {
      viewers.delete(ws);
      log(`viewer left (${viewers.size} remaining)`);
    }
  });
});

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

transmit = startTransmitIngest({
  port: TRANSMIT_PORT,
  host: '127.0.0.1',
  onFrame: handleTransmitFrame,
  onChange: handleTransmitChange,
  log,
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('========================================================');
  console.log(`Live Video Preview Relay (Premiere Pro & After Effects)`);
  console.log(`Port:     ${PORT}`);
  console.log(`Local PC: ${BASE_URL}`);
  console.log('========================================================');
  log(`relay listening on 0.0.0.0:${PORT} (advertised ${BASE_URL})`);
});
