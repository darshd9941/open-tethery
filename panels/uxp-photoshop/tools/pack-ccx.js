'use strict';

// Packs the plugin into build/photoshop/com.opentethery.photoshop.ccx (a zip
// with manifest.json at the root). No dependencies: writes the zip itself.
//
//   node panels/uxp-photoshop/tools/pack-ccx.js [outFile]
//
// Not shipped: test/, tools/, node_modules/, package*.json, README.md, dotfiles.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const EXCLUDE_TOP = new Set(['test', 'tools', 'node_modules', 'package.json', 'package-lock.json', 'README.md']);

function listFiles(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) continue;
    if (rel === '' && EXCLUDE_TOP.has(entry.name)) continue;
    const r = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01, keeps the output reproducible
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function pack(outFile) {
  if (!fs.existsSync(path.join(PLUGIN_DIR, 'manifest.json'))) throw new Error('manifest.json not found');
  const files = listFiles(PLUGIN_DIR);
  const zip = buildZip(files.map((name) => ({ name, data: fs.readFileSync(path.join(PLUGIN_DIR, name)) })));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);
  return files;
}

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(PLUGIN_DIR, '..', '..', 'build', 'photoshop', 'com.opentethery.photoshop.ccx'));
  const files = pack(out);
  console.log('Created ' + out + ' (' + files.length + ' files)');
}

module.exports = { pack, listFiles, buildZip, crc32 };
