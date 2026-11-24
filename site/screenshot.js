'use strict';
// node site/screenshot.js : screenshots both pages at phone and desktop width into site/test/screenshots.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const OUT = path.join(__dirname, 'test', 'screenshots');
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  for (const [vn, vp] of [['phone', { width: 375, height: 800 }], ['desktop', { width: 1200, height: 800 }]]) {
    for (const scheme of ['light', 'dark']) {
      if (vn === 'desktop' && scheme === 'dark') continue;
      const page = await browser.newPage({ viewport: vp, colorScheme: scheme });
      for (const f of ['index', 'help']) {
        await page.goto('file://' + path.join(__dirname, f + '.html'));
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        console.log(f, vn, scheme, 'scrollWidth', sw);
        await page.screenshot({ path: path.join(OUT, `${f}-${vn}-${scheme}.png`), fullPage: true });
      }
      await page.close();
    }
  }
  await browser.close();
})();
