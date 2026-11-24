'use strict';

// Display name of the product, read from product.json (repo root, or next to the exe when installed).
// Only display strings live here; protocol ids ("open-tethery" in /health) never change.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  name: 'Pocket Monitor',
  shortName: 'Pocket Monitor',
  vendor: 'Pocket Monitor',
  website: '',
  version: '',
  supportUrl: '',
  updateUrl: '',
};

function candidates() {
  return [
    process.env.OT_PRODUCT_FILE,
    process.env.OT_EXE_DIR && path.join(process.env.OT_EXE_DIR, 'product.json'),
    path.join(__dirname, '..', '..', 'product.json'),
    path.join(__dirname, '..', 'product.json'),
    path.join(path.dirname(process.execPath), 'product.json'),
  ].filter(Boolean);
}

function loadProduct() {
  for (const f of candidates()) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j.name === 'string' && j.name) return { ...DEFAULTS, shortName: j.name, ...j };
    } catch { /* try next */ }
  }
  return { ...DEFAULTS };
}

// The public subset (no ids needed by phones).
function publicProduct(p) {
  const { name, shortName, vendor, website, version, supportUrl } = p;
  return { name, shortName, vendor, website, version, supportUrl };
}

module.exports = { loadProduct, publicProduct, DEFAULTS };
