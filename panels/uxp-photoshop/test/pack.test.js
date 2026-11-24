'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pack } = require('../tools/pack-ccx');

test('pack-ccx makes a valid zip with manifest at the root and no dev files', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ot-ccx-')), 'x.ccx');
  const files = pack(out);
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('js/otv1.js'));
  assert.ok(files.includes('lib/qrcode.js'));
  for (const f of files) assert.ok(!/^(test|tools|node_modules)\/|package|README/.test(f), f);

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'com.pocketmonitor.photoshop');
  try {
    const listing = execFileSync('unzip', ['-t', out], { encoding: 'utf8' });
    assert.match(listing, /No errors detected/);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // unzip not installed: skip the external check
  }
});

test('manifest allows the helper over HTTP and WebSocket', () => {
  const m = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'manifest.json'), 'utf8'));
  const d = m.requiredPermissions.network.domains;
  if (d !== 'all') {
    for (const u of ['http://127.0.0.1', 'ws://127.0.0.1', 'http://127.0.0.1:47825', 'ws://127.0.0.1:47825']) assert.ok(d.includes(u), u);
  }
});
