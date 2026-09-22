// End to end in browser mode: the MCP server opens and drives its own Chrome (no extension),
// talking MCP over stdio, on a local fixture site and live Jev calls.
//   OPENROUTER_API_KEY=... node test/e2e/browser-mode.mjs
//   CHROME_PATH=... to use Chromium or Chrome for Testing instead of the installed Google Chrome
//   HEADED=1 to watch the window
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const HOME = mkdtempSync(join(tmpdir(), 'jbc-bm-'));
let failures = 0;
const ok = (c, m, x = '') => { console.log(`${c ? '✓' : '✗'} ${m}${x ? ' — ' + x : ''}`); if (!c) failures++; };

const site = createServer((req, res) => {
  let body;
  try { body = readFileSync(join('test/e2e/fixtures', req.url.split('?')[0].replace(/^\/$/, '/pizza.html'))); } catch { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

function server() {
  const env = { ...process.env, JBC_PORT: String(PORT), JBC_HOME: HOME, JBC_HEADLESS: process.env.HEADED ? '0' : '1' };
  delete env.JBC_MODE;
  const child = spawn(process.execPath, ['mcp/server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', n = 0;
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args = {}) => {
    const t = Date.now();
    const r = await rpc('tools/call', { name, arguments: args });
    const c = r.result?.content?.[0];
    return { ms: Date.now() - t, isError: !!r.result?.isError, text: c?.type === 'text' ? c.text : '', image: c?.type === 'image' ? c : null };
  };
  return { child, rpc, tool };
}

const a = server();
let b;
try {
  const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  ok(/drive a Chrome window that this server opens/.test(init.result?.instructions || ''), 'initialize (browser mode)');

  const st = await a.tool('browser_status');
  ok(!st.isError && /^Browser: ready/.test(st.text), 'the first call opens Chrome', `${st.ms} ms · ${st.text.split('\n')[0]}`);

  const nav = await a.tool('browser_navigate', { url: `${SITE}/pizza.html` });
  ok(/textbox "Customer name"/.test(nav.text), 'browser_navigate', `${nav.ms} ms`);
  const snap = (await a.tool('browser_snapshot', { full: true })).text;
  ok(!/Password/.test(snap.split('Visible text:')[0]) && /button "Add a gift note"/.test(snap), 'snapshot hides passwords, sees shadow DOM');
  const ref = (re, text = snap) => Number(text.split('\n').find((l) => re.test(l))?.match(/^\[(\d+)\]/)?.[1]);
  const typed = await a.tool('browser_type', { ref: ref(/textbox "Customer name"/), text: 'Ada Lovelace' });
  ok(/value="Ada Lovelace"/.test(typed.text), 'browser_type', `${typed.ms} ms`);
  const clicked = await a.tool('browser_click', { ref: ref(/checkbox "Onion"/) });
  ok(/checkbox "Onion" \(checked\)/.test(clicked.text), 'browser_click', `${clicked.ms} ms`);
  const sel = await a.tool('browser_select', { ref: ref(/combobox "Crust"/), option: 'Thin' });
  ok(/combobox "Crust" = "Thin"/.test(sel.text), 'browser_select');
  const shot = await a.tool('browser_screenshot');
  ok(shot.image?.data?.length > 1000, 'browser_screenshot', `${Math.round((shot.image?.data?.length || 0) / 1024)} KB`);
  const read = await a.tool('browser_read', { format: 'markdown' });
  ok(/# Order a pizza/.test(read.text), 'browser_read');

  const find = await a.tool('jev_find', { description: 'the checkbox for mushrooms' });
  ok(/Best match: \[\d+\] checkbox "Mushroom"/.test(find.text), 'jev_find', find.text.split('\n')[0]);

  await a.tool('browser_navigate', { url: `${SITE}/pizza.html` });
  const form = await a.tool('jev_task', {
    goal: 'Fill in the pizza order: a large pizza with bacon and extra cheese, thin crust, delivery at 19:30, then place the order.',
    details: 'Customer name: Jeroen Erne. Telephone: +31 6 1234 5678.', maxSteps: 20,
  });
  const after = (await a.tool('browser_snapshot', { full: true })).text;
  const want = [/value="Jeroen Erne"/, /radio "Large" \(checked\)/, /checkbox "Bacon" \(checked\)/, /checkbox "Extra cheese" \(checked\)/, /combobox "Crust" = "Thin"/, /value="19:30"/];
  const missing = want.filter((re) => !re.test(after));
  ok(/Status: needs_confirmation/.test(form.text) && !missing.length && !/ORDER PLACED/.test(after), 'jev_task fills the form and stops before "Place order"', `${form.ms} ms · ${form.text.match(/Steps: [^\n]+/)?.[0]}${missing.length ? ' · missing ' + missing : ''}`);

  const popup = await a.tool('jev_task', { goal: 'Open the terms of service.', url: `${SITE}/links.html`, maxSteps: 6 });
  ok(/Final page: Terms of service/.test(popup.text), 'a link that opens a new tab is followed', popup.text.match(/Status: \w+/)?.[0]);
  const tabs = await a.tool('browser_tabs');
  ok(/Terms of service/.test(tabs.text) && tabs.text.split('\n').filter((l) => /^\S?\s*\d+/.test(l)).length >= 2, 'browser_tabs lists both tabs');

  const wiki = await a.tool('jev_task', { goal: 'Search Wikipedia for "Ristretto" and open the Ristretto article.', url: 'https://en.wikipedia.org/wiki/Main_Page', maxSteps: 12 });
  ok(/Status: done/.test(wiki.text) && /Final page: .*Ristretto/.test(wiki.text), 'jev_task on live Wikipedia', `${wiki.ms} ms · ${wiki.text.match(/Steps: [^\n]+/)?.[0]}`);
  const check = await a.tool('jev_check', { statement: 'This page is an encyclopedia article about a coffee drink.' });
  ok(Number(check.text.match(/true: ([\d.]+)/)?.[1]) > 0.7, 'jev_check', check.text.split('\n')[0]);

  // A second Claude or Codex session shares the same browser instead of opening another.
  b = server();
  await b.rpc('initialize', { protocolVersion: '2025-06-18' });
  await new Promise((r) => setTimeout(r, 800));
  const st2 = await b.tool('browser_status');
  ok(!st2.isError && /Ristretto/.test(st2.text), 'a second session joins the same browser', st2.text.split('\n')[2]);

  // The first session ends: the second takes over and opens the browser again on the same profile.
  a.child.stdin.end();
  await new Promise((r) => a.child.on('exit', r));
  await new Promise((r) => setTimeout(r, 1200));
  const again = await b.tool('browser_navigate', { url: `${SITE}/terms.html` });
  ok(!again.isError && /Refunds within 30 days/.test(again.text), 'when the first session ends, the second takes over the browser', `${again.ms} ms${again.isError ? ' · ' + again.text : ''}`);
  b.child.stdin.end();
} finally {
  a.child.kill();
  b?.child.kill();
  site.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall browser-mode checks passed');
process.exitCode = failures ? 1 : 0;
