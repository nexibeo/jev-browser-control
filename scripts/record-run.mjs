// Records one live Jev task with every decision (top alternatives, timings, cost) as JSON.
// Used for the website's replay and for docs. Talks to the extension through the bridge directly.
//   CHROME_PATH=... node --env-file=.env scripts/record-run.mjs "<goal>" <url> results/run-name.json
import { chromium } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hub } from '../mcp/lib/hub.mjs';

const [goal, url, out = 'results/run.json'] = process.argv.slice(2);
const PORT = 20000 + Math.floor(Math.random() * 20000);
const hub = await new Hub({ port: PORT, version: 'rec', home: mkdtempSync(join(tmpdir(), 'jbc-rec-')) }).start();
const EXT = resolve('extension');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'jbc-rec-chrome-')), {
  executablePath: process.env.CHROME_PATH, headless: !process.env.HEADED, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
sw ||= await ctx.waitForEvent('serviceworker');
const settings = process.env.JBC_CLOUD_KEY
  ? { provider: 'cloud', cloudKey: process.env.JBC_CLOUD_KEY, cloudBase: process.env.JBC_CLOUD_BASE }
  : { provider: 'openrouter', openrouterKey: process.env.OPENROUTER_API_KEY };
await sw.evaluate((s) => chrome.storage.local.set(s), { ...settings, bridgePort: PORT });
await hub.waitForExtension(15000);
const decisions = [];
const result = await hub.request('jev.task', { goal, url, newTab: true, maxSteps: 20 }, { timeoutMs: 300000, onEvent: (e) => e.type === 'decision' && decisions.push(e) });
writeFileSync(out, JSON.stringify({ recorded: new Date().toISOString(), goal, url, decisions, result }, null, 2));
console.log(`${result.status} · ${result.steps.length} actions · ${(result.elapsed_ms / 1000).toFixed(1)} s · $${result.cost_usd} → ${out}`);
await ctx.close();
hub.close();
