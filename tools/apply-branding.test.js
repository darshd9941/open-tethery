'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { run, targets } = require('./apply-branding');

const ROOT = path.resolve(__dirname, '..');
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
  const files = ['product.json', ...targets().map(([f]) => f)];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}

test('--check passes on the repo as committed', () => {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'apply-branding.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('renaming: display strings change everywhere, ids do not, apply is idempotent', () => {
  const dir = tempCopy();
  const pj = JSON.parse(read(dir, 'product.json'));
  const oldName = pj.name;
  pj.name = 'Pocket Monitor Pro';
  pj.shortName = 'Pocket Monitor';
  pj.vendor = 'Acme Labs';
  pj.version = '9.8.7';
  fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify(pj, null, 2));
  pj.name = 'Pocket Monitor'; // (shortName stays; name below is what we assert)
  const before = Object.fromEntries(targets().map(([f]) => [f, read(dir, f)]));

  const changed = run(dir);
  for (const f of ['panels/cep/CSXS/manifest.xml', 'panels/uxp-photoshop/manifest.json', 'installer/version.txt',
    'installer/PocketMonitor.iss', 'installer/common.ps1', 'native/transmit/src/ProductName.h',
    'panels/cep/client/js/product.js', 'panels/uxp-photoshop/js/product.js']) {
    assert.ok(changed.includes(f), `${f} should change`);
  }
  // Id-only files stay put.
  for (const f of ['panels/cep/.debug', 'native/transmit/PocketMonitorTransmit.vcxproj', 'installer/start-helper.vbs']) {
    assert.strictEqual(read(dir, f), before[f], `${f} should not change`);
  }

  const cep = read(dir, 'panels/cep/CSXS/manifest.xml');
  assert.match(cep, /ExtensionBundleName="Pocket Monitor Pro"/);
  assert.match(cep, /<Menu>Pocket Monitor Pro<\/Menu>/);
  assert.match(cep, /<Author>Acme Labs<\/Author>/);
  assert.match(cep, /ExtensionBundleId="com\.pocketmonitor\.panel"/);
  assert.match(cep, /<Extension Id="com\.pocketmonitor\.panel\.main"/);
  const ux = JSON.parse(read(dir, 'panels/uxp-photoshop/manifest.json'));
  assert.strictEqual(ux.name, 'Pocket Monitor Pro');
  assert.strictEqual(ux.entrypoints[0].label.default, 'Pocket Monitor Pro');
  assert.strictEqual(ux.id, 'com.pocketmonitor.photoshop');
  assert.strictEqual(read(dir, 'installer/version.txt').trim(), '9.8.7');
  const issText = read(dir, 'installer/PocketMonitor.iss');
  assert.match(issText, /#define AppName "Pocket Monitor Pro"/);
  assert.match(issText, /#define AppPublisher "Acme Labs"/);
  assert.match(issText, /#define HelperExe "PocketMonitorHelper\.exe"/);
  assert.match(read(dir, 'installer/common.ps1'), /\$script:AppName\s+= 'Pocket Monitor Pro'/);
  const h = read(dir, 'native/transmit/src/ProductName.h');
  assert.match(h, /L"Pocket Monitor Pro \(phone preview\)"/);
  assert.match(h, /kAudioNameL = L"Pocket Monitor L"/);
  assert.match(read(dir, 'panels/cep/client/js/product.js'), /"name":"Pocket Monitor Pro"/);
  assert.ok(!read(dir, 'panels/cep/CSXS/manifest.xml').includes(oldName + '<'));

  assert.deepStrictEqual(run(dir), [], 'second run changes nothing');
  assert.deepStrictEqual(run(dir, { check: true }), []);
  pj.name = 'Changed Again';
  fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify({ ...pj, name: 'Changed Again' }));
  assert.ok(run(dir, { check: true }).length > 0, 'check reports drift');
});

test('non-ASCII and quote characters are escaped per format', () => {
  const dir = tempCopy();
  const pj = JSON.parse(read(dir, 'product.json'));
  pj.name = 'Café "Cam" & O\'Neil';
  pj.shortName = pj.name;
  fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify(pj));
  run(dir);
  assert.match(read(dir, 'panels/cep/CSXS/manifest.xml'), /ExtensionBundleName="Café &quot;Cam&quot; &amp; O'Neil"/);
  assert.match(read(dir, 'native/transmit/src/ProductName.h'), /Caf\\u00e9 \\u0022Cam\\u0022/);
  assert.match(read(dir, 'installer/common.ps1'), /'Café "Cam" & O''Neil'/);
  JSON.parse(read(dir, 'panels/uxp-photoshop/manifest.json'));
});
