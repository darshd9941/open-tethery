#!/usr/bin/env node
'use strict';
// Builds helper/ into one PocketMonitorHelper.exe using Node's Single Executable Applications (SEA).
//
//   node installer/build-helper-exe.js [--helper <dir>] [--viewer <dir>] [--out <dir>]
//                                      [--exe-name <name>] [--bundle-only] [--no-esbuild]
//
// Steps: 1) bundle helper code into one CommonJS file (esbuild if installed, else a tiny built-in
// bundler), 2) write sea-config.json and make the blob (node --experimental-sea-config),
// 3) copy node.exe, strip its signature (signtool, Windows), 4) inject the blob with postject (npx).
// Output (default installer/dist/helper): the exe, viewer/, profiles/ (if helper/profiles exists).
// viewer and profiles stay plain files next to the exe; the bundle sets OT_VIEWER_DIR /
// OT_PROFILES_DIR / OT_EXE_DIR from process.execPath when it runs as a SEA.

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const ENTRY_CANDIDATES = ['src/index.js', 'src/main.js', 'src/server.js', 'index.js', 'main.js', 'server.js'];

const BANNER = `try{var __s=require('node:sea');if(__s.isSea()){var __p=require('node:path');var __d=__p.dirname(process.execPath);
process.env.OT_EXE_DIR=process.env.OT_EXE_DIR||__d;
process.env.OT_VIEWER_DIR=process.env.OT_VIEWER_DIR||__p.join(__d,'viewer');
process.env.OT_PROFILES_DIR=process.env.OT_PROFILES_DIR||__p.join(__d,'profiles');}}catch(e){}
`;

function findEntry(helperDir) {
  const pkgPath = path.join(helperDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const main = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main;
    if (main && fs.existsSync(path.join(helperDir, main))) return path.resolve(helperDir, main);
  }
  for (const c of ENTRY_CANDIDATES) {
    const p = path.join(helperDir, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No helper entry file found in ${helperDir} (set "main" in helper/package.json)`);
}

// ---- tiny fallback bundler: CommonJS only, relative + node_modules requires, JSON ----
function resolveFile(base) {
  const tries = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const t of tries) if (fs.existsSync(t) && fs.statSync(t).isFile()) return t;
  return null;
}
function resolveModule(spec, fromDir) {
  if (spec.startsWith('.') || path.isAbsolute(spec)) return resolveFile(path.resolve(fromDir, spec));
  for (let d = fromDir; ; d = path.dirname(d)) {
    const dir = path.join(d, 'node_modules', spec);
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const main = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).main || 'index.js';
      const r = resolveFile(path.resolve(dir, main));
      if (r) return r;
    }
    const f = resolveFile(dir);
    if (f) return f;
    if (path.dirname(d) === d) return null;
  }
}
function miniBundle(entry) {
  const modules = new Map(); // abs path -> {id, code}
  const visit = (file) => {
    if (modules.has(file)) return modules.get(file).id;
    const entryRec = { id: modules.size, code: '', deps: {} };
    modules.set(file, entryRec);
    let src = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.json')) src = 'module.exports = ' + src + ';';
    src = src.replace(/^#!.*/, '');
    src.replace(/\brequire\(\s*(['"])([^'"]+)\1\s*\)/g, (m, q, spec) => {
      if (spec.startsWith('node:') || require('node:module').builtinModules.includes(spec)) return m;
      const r = resolveModule(spec, path.dirname(file));
      if (r) entryRec.deps[spec] = visit(r); // unresolved bare names (optional deps) fall through to real require
      return m;
    });
    entryRec.code = src;
    return entryRec.id;
  };
  visit(entry);
  const defs = [...modules.entries()].map(([file, m]) =>
    `${m.id}:[function(module,exports,require,__filename,__dirname){${m.code}\n},${JSON.stringify(m.deps)},${JSON.stringify(file)}]`);
  return `${BANNER}(function(defs){var cache={};var nreq=require;
function load(id){if(cache[id])return cache[id].exports;var d=defs[id];var m=cache[id]={exports:{}};
var req=function(s){return Object.prototype.hasOwnProperty.call(d[1],s)?load(d[1][s]):nreq(s);};
var fn=require('node:path');d[0].call(m.exports,m,m.exports,req,d[2],fn.dirname(d[2]));return m.exports;}
load(0);})({${defs.join(',')}});\n`;
}

function bundle(entry, outFile, { useEsbuild = true } = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let esbuild = null;
  if (useEsbuild) {
    try { esbuild = require(require.resolve('esbuild', { paths: [__dirname, path.dirname(entry)] })); } catch { /* not installed */ }
  }
  if (esbuild) {
    esbuild.buildSync({
      entryPoints: [entry], bundle: true, platform: 'node', target: 'node22', format: 'cjs',
      outfile: outFile, banner: { js: BANNER },
      external: ['bufferutil', 'utf-8-validate'], // optional native add-ons of ws
      logLevel: 'warning',
    });
    return 'esbuild';
  }
  fs.writeFileSync(outFile, miniBundle(entry));
  return 'mini';
}

function writeSeaConfig(dir, bundleFile) {
  const blob = path.join(dir, 'sea-prep.blob');
  const cfgFile = path.join(dir, 'sea-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    main: bundleFile, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false,
  }, null, 2));
  return { cfgFile, blob };
}

function run(cmd, args, opts = {}) {
  const r = cp.spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npx', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error})`);
}

function findSigntool() {
  if (process.platform !== 'win32') return null;
  const which = cp.spawnSync('where', ['signtool'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0];
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (!fs.existsSync(kits)) return null;
  for (const v of fs.readdirSync(kits).sort().reverse()) {
    const p = path.join(kits, v, 'x64', 'signtool.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildExe({ blob, cfgFile, exePath }) {
  run(process.execPath, ['--experimental-sea-config', cfgFile]);
  fs.copyFileSync(process.execPath, exePath);
  fs.chmodSync(exePath, 0o755);
  const st = findSigntool();
  if (st) {
    try { run(st, ['remove', '/s', exePath]); } catch (e) { console.warn('signtool remove failed (continuing):', e.message); }
  }
  const args = ['--yes', 'postject', exePath, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  run('npx', args);
}

// Plain recursive copy: fs.cpSync crashes some Node 22 builds on Windows (0xC0000409).
function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// Exe name and display data come from product.json at the repo root.
function productFile() { return path.join(__dirname, '..', 'product.json'); }
function productIds() {
  try { return JSON.parse(fs.readFileSync(productFile(), 'utf8')).ids || {}; } catch { return { helperExe: 'PocketMonitorHelper.exe' }; }
}

function main(argv) {
  const opt = { helper: path.join(__dirname, '..', 'helper'), viewer: path.join(__dirname, '..', 'viewer'),
    out: path.join(__dirname, 'dist', 'helper'), exeName: productIds().helperExe, bundleOnly: false, noEsbuild: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--helper') opt.helper = argv[++i];
    else if (a === '--viewer') opt.viewer = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--exe-name') opt.exeName = argv[++i];
    else if (a === '--bundle-only') opt.bundleOnly = true;
    else if (a === '--no-esbuild') opt.noEsbuild = true;
    else throw new Error('Unknown option ' + a);
  }
  opt.helper = path.resolve(opt.helper); opt.viewer = path.resolve(opt.viewer); opt.out = path.resolve(opt.out);
  const buildDir = path.join(path.dirname(opt.out), 'build');
  const bundleFile = path.join(buildDir, 'helper.bundle.js');

  const entry = findEntry(opt.helper);
  console.log('Helper entry:', entry);
  const how = bundle(entry, bundleFile, { useEsbuild: !opt.noEsbuild });
  console.log(`Bundled with ${how}: ${bundleFile}`);
  const { cfgFile, blob } = writeSeaConfig(buildDir, bundleFile);
  console.log('Wrote', cfgFile);
  if (opt.bundleOnly) return { bundleFile, cfgFile };

  fs.mkdirSync(opt.out, { recursive: true });
  const exePath = path.join(opt.out, opt.exeName);
  buildExe({ blob, cfgFile, exePath });
  if (fs.existsSync(opt.viewer)) copyDir(opt.viewer, path.join(opt.out, 'viewer'));
  else console.warn('WARNING: viewer dir not found:', opt.viewer);
  const profiles = path.join(opt.helper, 'profiles');
  if (fs.existsSync(profiles)) copyDir(profiles, path.join(opt.out, 'profiles'));
  if (fs.existsSync(productFile())) fs.copyFileSync(productFile(), path.join(opt.out, 'product.json'));
  console.log('Built', exePath);
  return { bundleFile, cfgFile, exePath };
}

if (require.main === module) {
  try { main(process.argv); } catch (e) { console.error('ERROR:', e.message); process.exit(1); }
}
module.exports = { findEntry, bundle, miniBundle, writeSeaConfig, main, FUSE };
