'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const dir = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const common = read('common.ps1');
const install = read('dev-install.ps1');
const uninstall = read('dev-uninstall.ps1');
const iss = read('OpenTethery.iss');

test('shared ids, port, rule name and Run key are consistent across scripts', () => {
  for (const [name, text] of [['common.ps1', common], ['OpenTethery.iss', iss]]) {
    assert.match(text, /47825/, `${name} port`);
    assert.match(text, /Open Tethery Helper/, `${name} rule name`);
    assert.match(text, /com\.opentethery\.panel/, `${name} CEP id`);
    assert.match(text, /com\.opentethery\.photoshop/, `${name} PS id`);
    assert.match(text, /OpenTetheryHelper/, `${name} run value / exe`);
    assert.match(text, /Software.Microsoft.Windows.CurrentVersion.Run/, `${name} Run key`);
  }
  assert.match(common, /9\.\.13/);
  for (const v of [9, 10, 11, 12, 13]) assert.match(iss, new RegExp(`CSXS\\.${v}"`));
  assert.match(common, /com\.screenlive\.video/);
  assert.match(iss, /com\.screenlive\.video/);
  assert.match(common, /Live Video Preview\*/);
  assert.match(iss, /Live Video Preview \(TCP 47825\)/);
});

test('dev-install covers every required action', () => {
  assert.match(install, /SupportsShouldProcess/);
  for (const p of ['Uninstall', 'SkipNative', 'SkipPhotoshop']) assert.match(install, new RegExp(`\\[switch\\]\\$${p}`));
  const all = install + common;
  for (const s of ['Invoke-SelfElevate', 'panels\\cep', 'panels\\uxp-photoshop', 'OpenTetheryTransmit.prm',
    'MediaCore', 'New-NetFirewallRule', '-Profile Private', 'PlayerDebugMode', 'UnifiedPluginInstallerAgent.exe',
    'RunKeyPath', '/health', 'install.log', 'LOCALAPPDATA', 'APPDATA', 'start-helper.ps1', 'Get-NetTCPConnection']) {
    assert.ok(all.includes(s), s);
  }
});

test('dev-uninstall removes what install adds', () => {
  for (const s of ['Remove-ItemProperty', 'Remove-NetFirewallRule', 'CepId', 'OldCepId', 'Find-MediaCoreRoot', 'InstallDir', 'OldRulePatterns']) {
    assert.ok(uninstall.includes(s), s);
  }
});

test('installer .iss has required sections and settings', () => {
  for (const s of ['[Setup]', '[Files]', '[Registry]', '[Icons]', '[Run]', '[UninstallRun]', '[Code]', '[InstallDelete]']) {
    assert.ok(iss.includes(s), s);
  }
  assert.match(iss, /PrivilegesRequired=admin/);
  assert.match(iss, /CloseApplications=yes/);
  assert.match(iss, /CloseApplicationsFilter=.*Adobe Premiere Pro\.exe,AfterFX\.exe,Photoshop\.exe/);
  assert.match(iss, /Uninstall Open Tethery/);
  assert.match(iss, /version\.txt/);
  assert.match(iss, /localport=\{#Port\}/);
  assert.match(iss, /profile=private/);
  assert.match(iss, /OutputBaseFilename=OpenTetherySetup/);
});

test('version.txt is a plain semver and package.json matches', () => {
  const v = read('version.txt').trim();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(JSON.parse(read('package.json')).version, v);
});

test('start-helper.vbs launches the helper exe', () => {
  assert.match(read('start-helper.vbs'), /OpenTetheryHelper\.exe/);
});

test('PowerShell files parse (only if pwsh is installed)', (t) => {
  const has = cp.spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' });
  if (has.error) return t.skip('pwsh not available');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ps1'))) {
    const cmd = `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(dir, f)}',[ref]$null,[ref]$e);if($e){$e|%{$_.ToString()};exit 1}`;
    const r = cp.spawnSync('pwsh', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, f + ': ' + r.stdout);
  }
});

// ---- bundler against a minimal fake helper ----
const { findEntry, bundle, writeSeaConfig } = require('../build-helper-exe.js');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-fixture-'));
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  w('helper/package.json', JSON.stringify({ name: 'h', main: 'src/index.js' }));
  w('helper/src/index.js', "const a=require('./lib/a');const cfg=require('./cfg.json');const ws=require('ws');\n" +
    "let opt='none';try{require('bufferutil')}catch(e){opt='absent'}\n" +
    "console.log(JSON.stringify({a:a.hello('x'),port:cfg.port,ws:ws.name,opt,viewer:process.env.OT_VIEWER_DIR||null,dir:typeof __dirname}));");
  w('helper/src/lib/a.js', "exports.hello = (n) => 'hi ' + n + require('node:os').EOL.length;");
  w('helper/src/cfg.json', '{"port":47825}');
  w('helper/node_modules/ws/package.json', '{"name":"ws","main":"index.js"}');
  w('helper/node_modules/ws/index.js', "module.exports={name:'ws-fake'};");
  return root;
}

for (const useEsbuild of [true, false]) {
  test(`bundle step works (${useEsbuild ? 'esbuild if installed' : 'mini bundler'})`, () => {
    const root = makeFixture();
    const entry = findEntry(path.join(root, 'helper'));
    assert.ok(entry.endsWith(path.join('src', 'index.js')));
    const out = path.join(root, 'build', 'helper.bundle.js');
    const how = bundle(entry, out, { useEsbuild });
    if (!useEsbuild) assert.strictEqual(how, 'mini');
    const { cfgFile, blob } = writeSeaConfig(path.dirname(out), out);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert.strictEqual(cfg.main, out);
    assert.strictEqual(cfg.output, blob);
    // The bundle must run with no node_modules reachable from its location.
    const moved = path.join(os.tmpdir(), `ot-bundle-${process.pid}-${useEsbuild}.js`);
    fs.copyFileSync(out, moved);
    const r = cp.spawnSync(process.execPath, [moved], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.strictEqual(o.port, 47825);
    assert.strictEqual(o.ws, 'ws-fake');
    assert.match(o.a, /^hi x/);
    assert.strictEqual(o.opt, 'absent');
  });
}

test('findEntry reports a clear error for an empty helper dir', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-empty-'));
  assert.throws(() => findEntry(d), /No helper entry/);
});

// Bonus: real SEA binary on Linux/macOS. Needs network for `npx postject`; opt in with OT_TEST_SEA=1.
test('SEA smoke build (OT_TEST_SEA=1, not Windows)', { skip: !process.env.OT_TEST_SEA || process.platform === 'win32' }, () => {
  const root = makeFixture();
  fs.mkdirSync(path.join(root, 'viewer'));
  fs.writeFileSync(path.join(root, 'viewer', 'index.html'), 'x');
  const r = cp.spawnSync(process.execPath, [path.join(dir, 'build-helper-exe.js'), '--helper', path.join(root, 'helper'),
    '--viewer', path.join(root, 'viewer'), '--out', path.join(root, 'dist', 'helper'), '--exe-name', 'OpenTetheryHelper'],
  { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const exe = path.join(root, 'dist', 'helper', 'OpenTetheryHelper');
  const run = cp.spawnSync(exe, [], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  const o = JSON.parse(run.stdout);
  assert.strictEqual(o.viewer, path.join(root, 'dist', 'helper', 'viewer'));
  assert.ok(fs.existsSync(path.join(root, 'dist', 'helper', 'viewer', 'index.html')));
});
