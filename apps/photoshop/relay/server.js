'use strict';

// Live Phone Preview relay.
//
// - Serves the viewer page to phones on the local network.
// - Accepts one Photoshop UXP plugin connection (the plugin connects out to us).
// - Keeps only the latest frame in memory and pushes it to every paired phone.
//
// No cloud, no accounts, no database. Everything is bound to the local machine
// and reachable only from the same LAN.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { resolveProfile, injectProfile } = require('./icc');

const ROOT = path.resolve(__dirname, '..');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'relay.log');

const DEFAULT_PORT = 47823;
const SESSION_GRACE_MS = 5 * 60 * 1000; // keep a session alive briefly if Photoshop closes
const AUTH_TIMEOUT_MS = 15000;
const MAX_FRAME_BASE64 = 28 * 1024 * 1024; // ~21 MB of JPEG
const MAX_FRAME_META_NAME = 300;

// ---------------------------------------------------------------------------
// Settings and LAN address detection
// ---------------------------------------------------------------------------

function loadConfig() {
  const defaults = { port: DEFAULT_PORT, lanIp: null };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      port: Number.isInteger(parsed.port) ? parsed.port : defaults.port,
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

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logDirReady = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    if (!logDirReady) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logDirReady = true;
    }
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > 2 * 1024 * 1024) {
        fs.renameSync(LOG_PATH, path.join(LOG_DIR, 'relay.old.log'));
      }
    } catch {
      // first log line
    }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // Logging must never take the server down.
  }
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

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
      // Always revalidate: the phone must pick up viewer fixes immediately.
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const config = loadConfig();
const PORT = config.port;
const LAN_IP = pickLanIp(config.lanIp);
const BASE_URL = `http://${LAN_IP}:${PORT}/`;
const STARTED_AT = Date.now();

let sessionToken = null;
let pluginSocket = null;
let pluginInfo = null;
let lastFrame = null; // { base64, meta, receivedAt }
let sessionGraceTimer = null;
const viewers = new Set();

function frameMeta() {
  return lastFrame ? lastFrame.meta : null;
}

function statusPayload() {
  return {
    type: 'status',
    pluginOnline: Boolean(pluginSocket),
    hasFrame: Boolean(lastFrame),
    frame: frameMeta(),
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
      // The close handler will clean this viewer up.
    }
  }
}

function broadcastStatus() {
  broadcast(statusPayload());
}

function clearSession(reason) {
  sessionToken = null;
  lastFrame = null;
  if (sessionGraceTimer) {
    clearTimeout(sessionGraceTimer);
    sessionGraceTimer = null;
  }
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
  const toInt = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number < 100000 ? Math.round(number) : fallback;
  };
  const profile = typeof input.profile === 'string' ? input.profile.slice(0, 80) : 'sRGB IEC61966-2.1';
  const timestamp = Number(input.timestamp);
  return {
    name,
    width: toInt(input.width, 0),
    height: toInt(input.height, 0),
    sourceWidth: toInt(input.sourceWidth, 0),
    sourceHeight: toInt(input.sourceHeight, 0),
    profile,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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
      pluginOnline: Boolean(pluginSocket),
      plugin: pluginInfo,
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

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

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
      pluginSocket.close(4002, 'Replaced by a newer plugin connection');
    } catch {
      // ignore
    }
  }
  if (!isSameSession) {
    // A new Start means a brand new session: old frames and old viewers must not
    // carry over into it.
    lastFrame = null;
    for (const viewer of viewers) {
      try {
        viewer.close(4003, 'A new preview session started');
      } catch {
        /* ignore */
      }
    }
    viewers.clear();
  }
  sessionToken = token;
  pluginSocket = ws;
  pluginInfo = info;
  ws.role = 'plugin';
  if (sessionGraceTimer) {
    clearTimeout(sessionGraceTimer);
    sessionGraceTimer = null;
  }

  send(ws, {
    type: 'registered',
    url: `${BASE_URL}#pair=${token}`,
    ip: LAN_IP,
    port: PORT,
    serverTime: Date.now(),
  });

  if (LAN_IP === '127.0.0.1') {
    send(ws, {
      type: 'warning',
      code: 'no-lan-ip',
      message: 'No LAN address was detected. Set "lanIp" in config.json to this PC\'s address, then restart the relay.',
    });
  }

  broadcastStatus();
  log(`plugin registered${isSameSession ? ' (session resumed)' : ' (new session)'} from ${ws._socket ? ws._socket.remoteAddress : 'unknown'}`);
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
  if (lastFrame) {
    send(ws, {
      type: 'frame',
      data: lastFrame.base64,
      meta: lastFrame.meta,
      receivedAt: lastFrame.receivedAt,
    });
  }
  log(`viewer connected (${ws._socket ? ws._socket.remoteAddress : 'unknown'}); ${viewers.size} viewer(s)`);
}

function handlePluginMessage(ws, msg) {
  if (ws !== pluginSocket) return;

  if (msg.type === 'frame') {
    if (typeof msg.data !== 'string' || msg.data.length < 32) return;
    if (msg.data.length > MAX_FRAME_BASE64) {
      log(`dropped oversized frame (${Math.round(msg.data.length / 1024 / 1024)} MB base64)`);
      return;
    }
    let jpeg;
    try {
      jpeg = Buffer.from(msg.data, 'base64');
    } catch {
      return;
    }
    if (jpeg.length < 4 || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) {
      log('dropped frame: not a JPEG');
      return;
    }

    const meta = sanitizeMeta(msg.meta);
    let output = jpeg;
    try {
      const icc = resolveProfile(meta.profile);
      if (icc) output = injectProfile(jpeg, icc);
    } catch (error) {
      log(`ICC injection failed, sending untagged frame: ${error.message}`);
      output = jpeg;
    }

    const base64 = output.toString('base64');
    lastFrame = {
      base64,
      meta: { ...meta, bytes: output.length, profile: meta.profile },
      receivedAt: Date.now(),
    };
    broadcast({ type: 'frame', data: base64, meta: lastFrame.meta, receivedAt: lastFrame.receivedAt });
    return;
  }

  if (msg.type === 'stop') {
    log('plugin stopped the session');
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

  if (msg.type === 'hello') {
    // Already authenticated as plugin; ignore.
    return;
  }
}

function handleViewerMessage(ws, msg) {
  if (msg.type === 'ping') {
    send(ws, { type: 'pong', serverTime: Date.now() });
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;

  const authTimer = setTimeout(() => {
    if (!ws.role) {
      try {
        ws.close(4001, 'Authentication timeout');
      } catch {
        // ignore
      }
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    ws.isAlive = true;
    if (isBinary) {
      try {
        ws.close(4003, 'Binary messages are not supported');
      } catch {
        // ignore
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    if (!ws.role) {
      if (msg.type === 'register') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
          send(ws, { type: 'error', code: 'bad-token', message: 'Invalid session token' });
          ws.close(4001, 'Invalid token');
          return;
        }
        clearTimeout(authTimer);
        attachPlugin(ws, token, {
          name: typeof msg.name === 'string' ? msg.name.slice(0, 80) : 'Photoshop plugin',
          version: typeof msg.version === 'string' ? msg.version.slice(0, 40) : '',
          remote: ws._socket ? ws._socket.remoteAddress : '',
        });
        return;
      }

      if (msg.type === 'hello' && msg.role === 'viewer') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
          send(ws, { type: 'error', code: 'bad-token', message: 'Invalid session token' });
          ws.close(4001, 'Invalid token');
          return;
        }
        clearTimeout(authTimer);
        attachViewer(ws, token);
        return;
      }

      send(ws, { type: 'error', code: 'auth', message: 'Authenticate first' });
      ws.close(4001, 'Authenticate first');
      return;
    }

    if (ws.role === 'plugin') {
      handlePluginMessage(ws, msg);
    } else {
      handleViewerMessage(ws, msg);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws.role === 'viewer') {
      viewers.delete(ws);
      log(`viewer disconnected; ${viewers.size} viewer(s) left`);
      return;
    }
    if (ws.role === 'plugin' && ws === pluginSocket) {
      pluginSocket = null;
      pluginInfo = null;
      broadcastStatus();
      log('plugin disconnected');
      // Give Photoshop a short grace period to reconnect before ending the session.
      if (sessionToken && !sessionGraceTimer) {
        sessionGraceTimer = setTimeout(() => {
          sessionGraceTimer = null;
          if (!pluginSocket) {
            log('session expired after plugin disconnect');
            clearSession('Session expired');
            broadcastStatus();
          }
        }, SESSION_GRACE_MS);
      }
    }
  });

  ws.on('error', (error) => {
    // Most errors here are normal disconnects; log only the message.
    if (error && error.message && !/ECONNRESET|EPIPE/.test(error.message)) {
      log(`websocket error: ${error.message}`);
    }
  });
});

// Keep-alive: browsers and UXP clients answer ping frames automatically.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use. Close the other preview window or change "port" in config.json and the plugin panel.`);
  } else {
    log(`Server error: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, '0.0.0.0', () => {
  log('------------------------------------------------------------');
  log('  Live Phone Preview relay is running');
  log(`  This PC:  ${BASE_URL}`);
  log(`  Port:     ${PORT} (change in config.json and the plugin panel)`);
  log('  Waiting for Photoshop... open the plugin panel and press Start.');
  log('  Keep this window open. Press Ctrl+C to stop.');
  log('------------------------------------------------------------');
  console.log('');
  console.log(`  Phone address (QR is shown in Photoshop): ${BASE_URL}`);
  console.log('');
  if (LAN_IP === '127.0.0.1') {
    log('WARNING: no LAN IPv4 address was detected. Set "lanIp" in config.json to this PC\'s address.');
  }
});

function shutdown(signal) {
  log(`shutting down (${signal})`);
  clearInterval(heartbeat);
  clearSession('Relay stopped');
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Relay stopping');
    } catch {
      // ignore
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.stack || error.message}`);
});
process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error && error.stack ? error.stack : error}`);
});
