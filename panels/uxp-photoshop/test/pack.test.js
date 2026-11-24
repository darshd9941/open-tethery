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
