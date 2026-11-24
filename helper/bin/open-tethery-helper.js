#!/usr/bin/env node
'use strict';

const http = require('http');
const { createHelper } = require('../lib/index');

// Is an Pocket Monitor helper already answering on this port?
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

function parseMode(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--mode=')) return argv[i].slice('--mode='.length);
  }
  return undefined;
}

async function main() {
  const mode = parseMode(process.argv);
  const helper = createHelper({ mode });
  try {
    await helper.start();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const port = err.port || (mode === 'photoshop' ? 47823 : 47825);
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
