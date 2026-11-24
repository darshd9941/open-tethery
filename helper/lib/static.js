'use strict';

// Static file serving for the viewer app, plus the placeholder page shown when
// the viewer directory is missing.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function placeholder(name = 'Pocket Monitor') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>body{font:16px system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}</style>
</head><body><div><h1>${esc(name)}</h1><p>The helper is running, but the viewer app files were not found.</p>
<p>Set <code>OT_VIEWER_DIR</code> to the viewer folder.</p></div></body></html>`;
}
const PLACEHOLDER = placeholder();

// Finds the viewer dir: explicit option / env, then ../../viewer relative to lib/ (repo layout).
function findViewerDir(explicit) {
  // OT_VIEWER_DIR / OT_EXE_DIR win over repo-relative paths; the exe's own folder is the last resort.
  const exeDir = process.env.OT_EXE_DIR;
  const candidates = [
    process.env.OT_VIEWER_DIR,
    explicit,
    exeDir && path.join(exeDir, 'viewer'),
    path.join(__dirname, '..', '..', 'viewer'),
    path.join(__dirname, '..', 'viewer'),
    // Packaged helper (single exe): the installer puts viewer\ next to the exe.
    path.join(path.dirname(process.execPath), 'viewer'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'index.html'))) return path.resolve(c);
  }
  return null;
}

// Resolves a URL path inside root; null when it would escape the root.
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  root = path.resolve(root);
  const full = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

function sendIndex(res, root, head, name) {
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': MIME['.html'] };
  if (!root) {
    res.writeHead(200, headers);
    return res.end(head ? undefined : placeholder(name));
  }
  fs.readFile(path.join(root, 'index.html'), (err, data) => {
    if (err) {
      res.writeHead(200, headers);
      return res.end(head ? undefined : placeholder(name));
    }
    res.writeHead(200, headers);
    res.end(head ? undefined : data);
  });
}

// Serves the viewer. `pathname` is the decoded-or-not URL path. Returns nothing; always responds.
function serveViewer(root, pathname, req, res, name) {
  const head = req.method === 'HEAD';
  if (pathname === '/' || pathname === '/index.html' || /^\/c\/[^/]*$/.test(pathname) || !root) {
    if (!root && pathname !== '/' && !/^\/c\//.test(pathname) && pathname !== '/index.html') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    return sendIndex(res, root, head, name);
  }
  const file = safeJoin(root, pathname);
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad path');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size}-${Math.trunc(st.mtimeMs)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const compressible = st.size >= 512 && COMPRESSIBLE.has(ext);
    const wantsGzip = compressible && /\bgzip\b/i.test((req.headers && req.headers['accept-encoding']) || '');
    if (wantsGzip) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      if (head) return res.end();
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(zlib.createGzip()).pipe(res);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (head) return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

module.exports = { placeholder, serveViewer, safeJoin, findViewerDir, MIME, PLACEHOLDER };
