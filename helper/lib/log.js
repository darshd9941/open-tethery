'use strict';

// Tiny logger: stdout (optional), in-memory ring buffer for GET /api/log, and
// an append-only file (rotated to .1 when it passes 1 MB at startup).

const fs = require('fs');
const path = require('path');

function createLogger({ file = null, echo = true, keep = 500 } = {}) {
  const lines = [];
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
      } catch {
        // no previous log
      }
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
  }
  function log(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    lines.push(line);
    if (lines.length > keep) lines.shift();
    if (echo) console.log(line);
    if (stream) stream.write(`${line}\n`);
  }
  log.tail = (n = 200) => lines.slice(-Math.max(1, n));
  log.close = () => {
    if (stream) stream.end();
    stream = null;
  };
  return log;
}

module.exports = { createLogger };
