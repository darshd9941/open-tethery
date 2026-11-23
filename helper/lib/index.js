'use strict';

// Wires everything together: HTTP + WebSocket on one port, OTX1 ingest on loopback.

const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const pkg = require('../package.json');
const { loadConfig } = require('./config');
const { lanAddresses, sessionUrls } = require('./lan');
const { createLogger } = require('./log');
const { Hub, originAllowed } = require('./hub');
const { startIngest } = require('./ingest');
const { createRtc } = require('./webrtc');
const { toSvg } = require('./qr');
const { serveViewer, findViewerDir } = require('./static');
const { isLoopbackAddress, normalizeIp } = require('./session');

// opts override config: port, ingestPort, lanIp, allowControl, viewerDir, logFile, echo,
// helloTimeoutMs, configPath, env.
function createHelper(opts = {}) {
  const cfg = loadConfig({ env: opts.env, configPath: opts.configPath });
  for (const k of ['port', 'ingestPort', 'lanIp', 'allowControl', 'viewerDir']) if (opts[k] !== undefined) cfg[k] = opts[k];
  const log = createLogger({ file: opts.logFile === undefined ? path.join(cfg.dir, 'helper.log') : opts.logFile, echo: opts.echo !== false });
  const viewerDir = findViewerDir(cfg.viewerDir);
  const rtc = createRtc();
  let boundPort = cfg.port;

  const getAddresses = (code) => sessionUrls(lanAddresses({ lanIp: cfg.lanIp }), boundPort, code);
  const hub = new Hub({ log, rtc, version: pkg.version, allowControl: cfg.allowControl, helloTimeoutMs: opts.helloTimeoutMs, getAddresses });

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const local = isLoopbackAddress(normalizeIp(req.socket.remoteAddress)) && originAllowed(req.headers.origin);
    const deny = () => sendJson(res, 403, { error: 'loopback-only' });

    if (p === '/health') {
      // Public and harmless; the CEP panel (file:// origin) fetches it, so allow cross-origin reads.
      res.setHeader('Access-Control-Allow-Origin', '*');
      return sendJson(res, 200, { ok: true, name: 'open-tethery', version: pkg.version, protocol: 1 });
    }
    if (p === '/api/session' && req.method === 'GET') return local ? sendJson(res, 200, hub.sessionInfo()) : deny();
    if (p === '/api/session/new') {
      if (!local) return deny();
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' });
      hub.newSession();
      return sendJson(res, 200, hub.sessionInfo());
    }
    if (p === '/api/qr.svg') {
      if (!local) return deny();
      const text = url.searchParams.get('text') || hub.sessionInfo().primaryUrl;
      try {
        const svg = toSvg(text);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(svg);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    if (p === '/api/log') {
      if (!local) return deny();
      const n = Math.min(2000, Math.max(1, Number(url.searchParams.get('n')) || 200));
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`${log.tail(n).join('\n')}\n`);
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not-found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Method not allowed');
    }
    return serveViewer(viewerDir, p, req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 33 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.onConnection(ws, req));
  });

  let ingest = null;

  return {
    hub,
    log,
    get port() {
      return boundPort;
    },
    get ingestPort() {
      return ingest ? ingest.port : 0;
    },
    viewerDir,
    // Rejects with the listen error (e.g. EADDRINUSE) so the caller can decide.
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, () => {
          server.removeListener('error', reject);
          boundPort = server.address().port;
          resolve();
        });
      });
      log(`open-tethery helper ${pkg.version} listening on port ${boundPort}; session code ${hub.code}`);
      log(viewerDir ? `viewer files: ${viewerDir}` : 'viewer files not found; serving placeholder page');
      ingest = await startIngest({
        port: cfg.ingestPort,
        log,
        onFrame: (f) => hub.onTransmitFrame(f),
        onState: (s) => hub.onTransmitState(s),
        onHeartbeat: () => hub.onTransmitHeartbeat(),
        onConnection: (c) => hub.onTransmitConnection(c),
      });
      if (!ingest.ok) log(`WARNING: could not listen on 127.0.0.1:${cfg.ingestPort}; Transmit plugin cannot connect`);
      return { port: boundPort, ingestPort: this.ingestPort };
    },
    async stop() {
      hub.close();
      rtc.close();
      if (ingest) ingest.close();
      for (const c of wss.clients) c.terminate();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      log.close();
    },
  };
}

module.exports = { createHelper };
