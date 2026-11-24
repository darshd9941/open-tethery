// Tiny static server + fake helper WebSocket for tests and manual runs:
//   node test/fake-server.mjs [port]     then open http://localhost:<port>/c/ABCD
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

export function makeFrame({ jpeg, w, h, srcW, srcH, seq = 1, time = 12.5 }) {
  const head = Buffer.alloc(32);
  head.write('OTV1', 0, 'ascii');
  head[4] = 1; head[5] = 1;
  head.writeUInt32LE(seq, 8);
  head.writeDoubleLE(time, 16);
  head.writeUInt16LE(w, 24); head.writeUInt16LE(h, 26);
  head.writeUInt16LE(srcW, 28); head.writeUInt16LE(srcH, 30);
  return Buffer.concat([head, jpeg]);
}

export function defaultState(over = {}) {
  return {
    t: 'state', status: 'live',
    host: { app: 'premiere', appName: 'Premiere Pro', version: '27.0' },
    sequence: { name: 'Main edit', width: 1080, height: 1920, fpsNum: 30000, fpsDen: 1001, fps: 29.97, aspect: '9x16', par: 1, duration: 120 },
    playing: false, time: 12.5, timecode: '00:00:12:15',
    audio: { available: true, sampleRate: 48000, channels: 2 },
    engine: { transmit: true, sending: true }, viewers: 1, ...over,
  };
}

// opts: { code, jpeg, jw, jh, srcW, srcH, state, control, sendFrame, onMessage(msg, ws) }
export async function startFakeServer(opts = {}) {
  const code = opts.code || 'ABCD';
  const received = [];
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/product.json') {
      // The real helper serves this from the repo's product.json.
      const prod = JSON.parse(fs.readFileSync(path.join(root, '..', 'product.json'), 'utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: prod.name, shortName: prod.shortName }));
      return;
    }
    if (p === '/' || /^\/c\/[A-Za-z0-9]{4}\/?$/.test(p)) p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      received.push(msg);
      if (msg.t === 'hello') {
        if (msg.code !== code) { ws.send(JSON.stringify({ t: 'error', code: 'bad-code' })); ws.close(); return; }
        ws.send(JSON.stringify({ t: 'welcome', id: 'v1', role: 'viewer', protocol: 1, control: opts.control ?? true, webrtc: false, server: { name: 'open-tethery', version: '0.2.0', pcName: opts.pcName || 'STUDIO-PC' } }));
        ws.send(JSON.stringify(opts.state || defaultState()));
        if (opts.jpeg && opts.sendFrame !== false) {
          ws.send(makeFrame({ jpeg: opts.jpeg, w: opts.jw || 180, h: opts.jh || 320, srcW: opts.srcW || 1080, srcH: opts.srcH || 1920 }));
        }
      } else if (msg.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', ts: msg.ts, serverTs: Date.now() }));
      } else {
        opts.onMessage?.(msg, ws);
      }
    });
  });
  await new Promise((r) => server.listen(opts.port || 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, code, received,
    // push a message (object = JSON state/etc.) to every connected viewer
    broadcast: (msg) => { for (const c of wss.clients) c.send(JSON.stringify(msg)); },
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(r); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeServer({ port: Number(process.argv[2]) || 47825, sendFrame: false });
  console.log(`fake helper on ${s.url}  (code ${s.code}, no frames)`);
}
