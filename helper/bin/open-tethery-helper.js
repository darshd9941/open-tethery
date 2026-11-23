#!/usr/bin/env node
'use strict';

const http = require('http');
const { createHelper } = require('../lib/index');

// Is an Open Tethery helper already answering on this port?
function probeExisting(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).name === 'open-tethery');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const helper = createHelper();
  try {
    await helper.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const port = err.port || 47825;
      if (await probeExisting(port)) process.exit(0); // already running: stay quiet
      console.error(`Port ${port} is in use by another program. Set OPEN_TETHERY_PORT to use a different port.`);
      process.exit(1);
    }
    console.error(`Could not start: ${err.message}`);
    process.exit(1);
  }
  const shutdown = () => helper.stop().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
