'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const dir = path.join(__dirname, '..');
const repo = path.join(dir, '..');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const iss = read('PocketMonitor.iss');
const build = read('build-release.ps1');
const sign = read('sign-panel.ps1');

test('release .iss never touches PlayerDebugMode (signed panel needs no developer settings)', () => {
  assert.doesNotMatch(iss.replace(/^;.*$/gm, ''), /PlayerDebugMode|CSXS\.\d+/);
});

test('release .iss installs the signed panel and has the two components', () => {
  assert.match(iss, /Source: "dist\\panel\\\*";[^\n]*\{userappdata\}\\Adobe\\CEP\\extensions\\\{#CepId\}/);
  assert.doesNotMatch(iss, /Source: "\.\.\\panels\\cep/);
  assert.match(iss, /\[Components\]/);
  assert.match(iss, /Name: "adobe";[^\n]*Premiere Pro and After Effects[^\n]*fixed/);
  assert.match(iss, /Name: "photoshop";[^\n]*optional/i);
  assert.match(iss, /Photoshop\.ccx"; DestDir[^\n]*Components: photoshop/);
  assert.match(iss, /OutputBaseFilename=\{#InstallDirName\}Setup-\{#AppVersion\}/);
});

test('uninstaller cleans legacy leftovers', () => {
  const un = iss.slice(iss.indexOf('[UninstallRun]'), iss.indexOf('[Code]'));
  for (const s of ['com.screenlive.video', 'com.opentethery.panel', 'OpenTethery', 'OpenTetheryHelper']) assert.ok(un.includes(s), s);
});

test('build-release.ps1 references every step in order', () => {
  const order = ['apply-branding.js', 'npm ci', 'build-helper-exe.ps1', 'vswhere', 'MSBuild', 'sign-panel.ps1', '.ccx',
    'ISCC.exe', 'PM_SIGN_CERT', 'Get-FileHash', 'winget install JRSoftware.InnoSetup'];
  let at = -1;
  for (const s of order) {
    const i = build.indexOf(s, s === 'winget install JRSoftware.InnoSetup' ? 0 : at + 1);
    assert.ok(i >= 0, `missing: ${s}`);
    if (s !== 'winget install JRSoftware.InnoSetup' && s !== 'PM_SIGN_CERT') at = i;
  }
  assert.match(build, /\$total = \d+/);
  const steps = (build.match(/^Step '/gm) || []).length;
  assert.strictEqual(Number(build.match(/\$total = (\d+)/)[1]), steps);
  assert.match(build, /PocketMonitorSetup-\$version\.exe/);
  assert.match(build, /\.sha256/);
});

test('sign-panel.ps1 uses ZXPSignCmd, a timestamp, an external cert and a clean copy', () => {
  for (const s of ['-selfSignedCert', '-sign', '-tsa', '.pocketmonitor\\panel-cert.p12', 'PM_PANEL_CERT_PASS', 'Panel.zxp',
    'test node_modules screenshots', 'package.json', 'META-INF\\signatures.xml', 'github.com/Adobe-CEP/CEP-Resources']) {
    assert.ok(sign.includes(s), s);
  }
});

test('dev-install keeps PlayerDebugMode, release scripts do not write it', () => {
  assert.match(read('dev-install.ps1'), /PlayerDebugMode/);
  assert.doesNotMatch((build + sign).replace(/^\s*#.*$/gm, ''), /PlayerDebugMode/);
});

// Tiny YAML sanity check; uses python3+PyYAML when available.
test('workflow YAML files parse and have the expected triggers', (t) => {
  const wfDir = path.join(repo, '.github', 'workflows');
  const files = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml'));
  assert.ok(files.includes('release.yml') && files.includes('ci.yml'));
  for (const f of files) {
    const text = fs.readFileSync(path.join(wfDir, f), 'utf8');
    assert.ok(!/\t/.test(text), `${f}: tabs`);
    assert.match(text, /^name:/m);
    assert.match(text, /^jobs:/m);
    const r2 = cp.spawnSync('python3', ['-I', '-c', 'import sys,yaml;d=yaml.safe_load(open(sys.argv[1]));assert "jobs" in d', path.join(wfDir, f)], { encoding: 'utf8' });
    if (!r2.error && !/No module named yaml/.test(r2.stderr)) assert.strictEqual(r2.status, 0, f + ': ' + r2.stderr);
  }
  const rel = fs.readFileSync(path.join(wfDir, 'release.yml'), 'utf8');
  assert.match(rel, /tags:\s*\['v\*'\]/);
  assert.match(rel, /windows-latest/);
  assert.match(fs.readFileSync(path.join(wfDir, 'ci.yml'), 'utf8'), /ubuntu-latest[\s\S]*npm run test:all/);
});
