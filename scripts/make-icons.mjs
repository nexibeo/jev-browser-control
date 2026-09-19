// Renders assets/logo.svg to the extension's PNG icons with headless Chromium.
//   npm run icons
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const big = readFileSync('assets/logo.svg', 'utf8');
const small = readFileSync('assets/logo-small.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  const svg = size <= 16 ? small : big;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(`extension/icons/icon${size}.png`, await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('icons written');
