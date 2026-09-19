// Remote control end to end: a remote MCP client (standing in for Grok Bot) calls
// <base>/mcp with a jbc_ key; the relay passes the calls to the extension in a real Chrome.
//   CHROME_PATH=... OPENROUTER_API_KEY=... JBC_REMOTE_KEY=jbc_... JBC_CLOUD_BASE=https://... node test/e2e/remote.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = (process.env.JBC_CLOUD_BASE || 'https://jevbrowsercontrol.com').replace(/\/$/, '');
const KEY = process.env.JBC_REMOTE_KEY;
if (!KEY) throw new Error('Set JBC_REMOTE_KEY');
let failures = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${msg}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };

let n = 0;
async function mcp(method, params, key = KEY) {
  const t = Date.now();
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: Date.now() - t };
}
const tool = async (name, args = {}) => {
  const r = await mcp('tools/call', { name, arguments: args });
  const c = r.body?.result?.content?.[0];
  return { ...r, text: c?.text || '', image: c?.type === 'image' ? c : null, isError: !!r.body?.result?.isError };
};

const site = createServer((req, res) => {
  let body;
  try { body = readFileSync(join('test/e2e/fixtures', req.url.split('?')[0].replace(/^\/$/, '/pizza.html'))); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// Before the browser connects: the protocol works, and tool calls explain how to connect.
const bad = await mcp('initialize', { protocolVersion: '2025-06-18' }, 'jbc_wrong');
ok(bad.status === 401, 'wrong key → 401');
const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'remote-e2e', version: '1' } });
ok(init.body?.result?.serverInfo?.name === 'jev-browser-control', 'initialize', `protocol ${init.body?.result?.protocolVersion}`);
const list = await mcp('tools/list', {});
ok(list.body?.result?.tools?.length === 17, 'tools/list', `${list.body?.result?.tools?.length} tools`);
const off = await tool('browser_status');
ok(off.isError && /not connected for remote control/.test(off.text), 'not connected yet → clear setup message');

const EXT = resolve('extension');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'jbc-remote-')), {
  executablePath: process.env.CHROME_PATH, headless: !process.env.HEADED, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  let [sw] = ctx.serviceWorkers();
  sw ||= await ctx.waitForEvent('serviceworker');
  // Jev runs on the user's own OpenRouter key; the jbc_ key is only for the relay.
  await sw.evaluate((s) => chrome.storage.local.set(s), { provider: 'openrouter', openrouterKey: process.env.OPENROUTER_API_KEY, cloudBase: BASE, remoteEnabled: true, remoteKey: KEY, bridgeEnabled: false });

  let status;
  for (let i = 0; i < 30; i++) {
    status = await tool('browser_status');
    if (!status.isError) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(!status.isError, 'extension connects to the relay', `${status.ms} ms round trip · ${status.text.split('\n')[0]}`);

  const nav = await tool('browser_navigate', { url: `${SITE}/pizza.html`, newTab: true });
  ok(/textbox "Customer name"/.test(nav.text), 'browser_navigate through the relay', `${nav.ms} ms`);
  const snap = await tool('browser_snapshot', { full: true });
  const ref = (re) => Number(snap.text.split('\n').find((l) => re.test(l))?.match(/^\[(\d+)\]/)?.[1]);
  const typed = await tool('browser_type', { ref: ref(/textbox "Customer name"/), text: 'Ada Lovelace' });
  ok(/value="Ada Lovelace"/.test(typed.text), 'browser_type', `${typed.ms} ms`);
  const clicked = await tool('browser_click', { ref: ref(/radio "Large"/) });
  ok(/radio "Large" \(checked\)/.test(clicked.text), 'browser_click', `${clicked.ms} ms`);
  const order = await tool('browser_click', { ref: ref(/button "Place order"/) });
  ok(order.isError && /needs the user's OK/.test(order.text), 'remote click on "Place order" is refused without the person\'s OK');
  const after = await tool('browser_read', { format: 'text' });
  ok(!/ORDER PLACED/.test(after.text), 'the order was not placed');
  const shot = await tool('browser_screenshot');
  ok(shot.image?.data?.length > 1000, 'browser_screenshot returns an image', `${Math.round((shot.image?.data?.length || 0) / 1024)} KB`);

  const task = await tool('jev_task', { goal: 'Search Wikipedia for "Ristretto" and open the Ristretto article.', url: 'https://en.wikipedia.org/wiki/Main_Page', maxSteps: 12, allowIrreversible: true });
  ok(/^Status: done/.test(task.text) && /Final page: .*Ristretto/.test(task.text), 'jev_task through the relay', `${task.ms} ms · ${task.text.match(/Steps: [^\n]+/)?.[0]}`);

  await sw.evaluate(() => chrome.storage.local.set({ remoteEnabled: false }));
  await new Promise((r) => setTimeout(r, 1500));
  const disabled = await tool('browser_status');
  ok(disabled.isError, 'switching remote control off disconnects at once');
} finally {
  await ctx.close();
  site.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall remote checks passed');
process.exitCode = failures ? 1 : 0;
