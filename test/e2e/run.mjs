// End to end: Chrome for Testing with the unpacked extension, the real MCP server over stdio,
// a local fixture site and live Jev calls.
//   OPENROUTER_API_KEY=... CHROME_PATH=... npm run e2e
//   E2E_PROVIDER=cloud JBC_CLOUD_KEY=jbc_... JBC_CLOUD_BASE=https://... npm run e2e
// Chrome 137+ ignores --load-extension in branded Chrome, so CHROME_PATH must be Chromium or Chrome for Testing.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const provider = process.env.E2E_PROVIDER || 'openrouter';
const only = (process.env.E2E_ONLY || '').split(',').filter(Boolean);
const headless = process.env.HEADED ? false : true;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const EXT_DIR = resolve('extension');
const results = [];
const t0 = Date.now();

// ---------- fixture site ----------
const site = createServer((req, res) => {
  const file = req.url.split('?')[0].replace(/^\/$/, '/pizza.html');
  let body;
  try { body = readFileSync(join('test/e2e/fixtures', file)); } catch { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ---------- MCP server ----------
const mcp = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, JBC_MODE: 'extension', JBC_PORT: String(PORT), JBC_HOME: mkdtempSync(join(tmpdir(), 'jbc-e2e-')), JBC_DEBUG: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', n = 0;
const waiting = new Map();
const progress = [];
mcp.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method === 'notifications/progress') progress.push(m.params.message);
  }
});
mcp.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
async function tool(name, args = {}, meta) {
  const t = Date.now();
  const r = await rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const c = r.result?.content?.[0];
  return { ms: Date.now() - t, isError: !!r.result?.isError, text: c?.type === 'text' ? c.text : '', image: c?.type === 'image' ? c : null, raw: r };
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });

// ---------- Chrome with the extension ----------
const userData = mkdtempSync(join(tmpdir(), 'jbc-chrome-'));
const context = await chromium.launchPersistentContext(userData, {
  executablePath: process.env.CHROME_PATH,
  headless,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
let [sw] = context.serviceWorkers();
sw ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
const extId = sw.url().split('/')[2];
const settings = provider === 'cloud'
  ? { provider: 'cloud', cloudKey: process.env.JBC_CLOUD_KEY, cloudBase: process.env.JBC_CLOUD_BASE || 'https://jevbrowsercontrol.com' }
  : { provider: 'openrouter', openrouterKey: process.env.OPENROUTER_API_KEY };
await sw.evaluate((s) => chrome.storage.local.set(s), { ...settings, bridgePort: PORT });

async function check(name, fn) {
  if (only.length && !only.some((o) => name.includes(o))) return;
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, ...detail });
    console.log(`✓ ${name} (${Date.now() - t} ms)${detail?.note ? ' — ' + detail.note : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, error: err.message });
    console.log(`✗ ${name}: ${err.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const refOf = (text, pattern) => Number(text.split('\n').find((l) => pattern.test(l))?.match(/^\[(\d+)\]/)?.[1]);
const costOf = (text) => Number(text.match(/\$(\d+\.\d+)/)?.[1] || 0);

try {
  await check('extension connects to the MCP bridge', async () => {
    for (let i = 0; i < 40; i++) {
      const s = await tool('browser_status');
      if (!s.isError) return { note: s.text.split('\n')[0] + ' · ' + s.text.split('\n')[2] };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('extension never connected');
  });

  let snap;
  await check('navigate + snapshot lists elements, hides the password field, sees inside shadow DOM', async () => {
    const r = await tool('browser_navigate', { url: SITE + '/pizza.html', newTab: true });
    assert(!r.isError, r.text);
    snap = (await tool('browser_snapshot', { full: true })).text;
    assert(/textbox "Customer name"/.test(snap), 'name field missing');
    assert(!/Password/.test(snap.split('Visible text:')[0]), 'password field was listed');
    assert(/button "Add a gift note"/.test(snap), 'shadow DOM button missing');
    assert(/combobox "Crust" = "Regular" options: Regular \| Thin \| Stuffed/.test(snap), 'select missing');
    return { note: `${snap.split('\n').filter((l) => /^\[\d+\]/.test(l)).length} elements` };
  });

  await check('browser_type + browser_click + browser_select change the page', async () => {
    const name = refOf(snap, /textbox "Customer name"/);
    const onion = refOf(snap, /checkbox "Onion"/);
    const crust = refOf(snap, /combobox "Crust"/);
    let r = await tool('browser_type', { ref: name, text: 'Jeroen' });
    assert(/value="Jeroen"/.test(r.text), 'typed value not shown: ' + r.text.slice(0, 300));
    r = await tool('browser_click', { ref: onion });
    assert(/checkbox "Onion" \(checked\)/.test(r.text), 'checkbox not checked');
    r = await tool('browser_select', { ref: crust, option: 'Thin' });
    assert(/combobox "Crust" = "Thin"/.test(r.text), 'select not changed');
    const gift = refOf((await tool('browser_snapshot', { full: true })).text, /button "Add a gift note"/);
    r = await tool('browser_click', { ref: gift });
    assert(/GIFT NOTE ADDED/.test(r.text), 'shadow DOM click had no effect');
  });

  await check('browser_read and browser_screenshot', async () => {
    const r = await tool('browser_read', { format: 'markdown' });
    assert(/# Order a pizza/.test(r.text), 'markdown heading missing');
    const s = await tool('browser_screenshot');
    assert(s.image && s.image.data.length > 1000, 'no screenshot');
    return { note: `screenshot ${Math.round(s.image.data.length / 1024)} KB` };
  });

  await check('jev_find locates an element by description', async () => {
    const r = await tool('jev_find', { description: 'the checkbox for mushrooms' });
    assert(!r.isError, r.text);
    assert(/Best match: \[\d+\] checkbox "Mushroom"/.test(r.text), r.text);
    return { note: r.text.split('\n')[0], cost: costOf(r.text.split('Cost:')[1] || '') };
  });

  await check('jev_task fills the pizza form and stops before "Place order"', async () => {
    await tool('browser_navigate', { url: SITE + '/pizza.html' });
    const r = await tool('jev_task', {
      goal: 'Fill in the pizza order: a large pizza with bacon and extra cheese, thin crust, delivery at 19:30, then place the order.',
      details: 'Customer name: Jeroen Erne. Telephone: +31 6 1234 5678.',
      maxSteps: 20,
    }, { progressToken: 'e2e' });
    assert(!r.isError, r.text);
    assert(/Status: needs_confirmation/.test(r.text), 'expected a confirmation stop:\n' + r.text.slice(0, 1500));
    const page = (await tool('browser_snapshot', { full: true })).text;
    const ok = [/textbox "Customer name" value="Jeroen Erne"/, /radio "Large" \(checked\)/, /checkbox "Bacon" \(checked\)/, /checkbox "Extra cheese" \(checked\)/, /combobox "Crust" = "Thin"/, /value="19:30"/];
    const missing = ok.filter((re) => !re.test(page)).map(String);
    assert(!/ORDER PLACED/.test(page), 'the order was placed without confirmation');
    assert(missing.length <= 1, 'fields not set: ' + missing.join(', ') + '\n' + r.text.slice(0, 1200));
    return { note: `${r.text.match(/Steps: [^\n]+/)?.[0]}${missing.length ? ' · missed ' + missing : ''}`, transcript: r.text.split('\nFinal page')[0], progress: progress.length };
  });

  await check('jev_task on Wikipedia: search and open an article', async () => {
    const r = await tool('jev_task', { goal: 'Search Wikipedia for "Ristretto" and open the Ristretto article.', url: 'https://en.wikipedia.org/wiki/Main_Page', maxSteps: 12 });
    assert(!r.isError, r.text);
    assert(/Status: (done|done_unconfirmed)/.test(r.text), r.text.slice(0, 1500));
    assert(/Final page: .*Ristretto/i.test(r.text), 'did not end on the Ristretto article:\n' + r.text.slice(0, 1500));
    return { note: r.text.match(/Steps: [^\n]+/)?.[0], transcript: r.text.split('\nFinal page')[0] };
  });

  await check('jev_check verifies a statement about the page', async () => {
    const yes = await tool('jev_check', { statement: 'This page is an encyclopedia article about a coffee drink.' });
    const no = await tool('jev_check', { statement: 'This page is a checkout page for buying shoes.' });
    const p = (t) => Number(t.match(/true: ([\d.]+)/)?.[1]);
    assert(p(yes.text) > 0.7 && p(no.text) < 0.3, `yes=${p(yes.text)} no=${p(no.text)}`);
    return { note: `yes ${p(yes.text)}, no ${p(no.text)}` };
  });

  // Screenshots of the extension's own pages, for the docs and the website.
  if (process.env.E2E_SHOTS) {
    mkdirSync('docs/img', { recursive: true });
    const p = await context.newPage();
    await p.setViewportSize({ width: 420, height: 760 });
    await p.goto(`chrome-extension://${extId}/sidepanel.html`);
    await p.waitForTimeout(800);
    await p.screenshot({ path: 'docs/img/sidepanel.png' });
    await p.setViewportSize({ width: 900, height: 1200 });
    await p.goto(`chrome-extension://${extId}/options.html`);
    await p.waitForTimeout(800);
    await p.screenshot({ path: 'docs/img/options.png' });
  }
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s (provider: ${provider})`);
  mkdirSync('results', { recursive: true });
  writeFileSync(`results/e2e-${provider}.json`, JSON.stringify({ date: new Date().toISOString(), provider, results }, null, 2));
  await context.close();
  mcp.kill();
  site.close();
  process.exitCode = passed === results.length ? 0 : 1;
}
