// The MCP server over real stdio, with a fake extension on the bridge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 20000 + Math.floor(Math.random() * 20000);
const EXT = 'chrome-extension://' + 'c'.repeat(32);

function startServer() {
  const child = spawn(process.execPath, ['mcp/server.mjs'], { env: { ...process.env, JBC_MODE: 'extension', JBC_PORT: String(port), JBC_HOME: mkdtempSync(join(tmpdir(), 'jbc-')) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  const notes = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } else notes.push(msg);
    }
  });
  let n = 0;
  const call = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { child, call, notes };
}

const PAGE = {
  url: 'https://example.com/', title: 'Example', text: 'Hello world',
  scroll: { y: 0, height: 900, canDown: false, canUp: false },
  elements: [
    { ref: 5, role: 'link', label: 'More info', href: '/info', context: 'About this domain', inView: true },
    { ref: 6, role: 'textbox', label: 'Email', value: 'a@b.c', editable: true, inView: true },
    { ref: 7, role: 'combobox', label: 'Country', options: [{ label: 'NL', selected: true }, { label: 'BE' }], inView: true },
  ],
};

function fakeExtension() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers: { origin: EXT } });
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', version: '0.2.0', extensionId: 'c'.repeat(32) })); resolve(ws); };
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type !== 'request') return;
      const reply = (result) => ws.send(JSON.stringify({ type: 'response', id: m.id, result }));
      if (m.method === 'snapshot') reply({ tabId: 3, page: PAGE });
      else if (m.method === 'click') reply({ clicked: 'More info', tabId: 3, page: PAGE });
      else if (m.method === 'screenshot') reply({ mimeType: 'image/jpeg', data: 'AAAA' });
      else if (m.method === 'jev.task') {
        ws.send(JSON.stringify({ type: 'event', id: m.id, event: { type: 'action', step: 1, operation: 'CLICK', action: 'More info' } }));
        reply({ status: 'done', note: '', goal: m.params.goal, decisions: 2, cost_usd: 0.00041, elapsed_ms: 1800, model: 'typesafe/jev-1.13-20260917',
          steps: [{ step: 1, operation: 'CLICK', action: 'More info', confidence: 0.97, target_confidence: 0.93, outcome: 'done', page_changed: true }],
          final: { url: 'https://example.com/info', title: 'Info', text: 'Info page' } });
      } else ws.send(JSON.stringify({ type: 'response', id: m.id, error: { message: 'nope' } }));
    };
  });
}

test('initialize, list tools, call tools, stream progress', async () => {
  const s = startServer();
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'jev-browser-control');
    assert.match(init.result.instructions, /untrusted/);
    const old = await s.call('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(old.result.protocolVersion, '2025-11-25');

    const list = await s.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['browser_snapshot', 'browser_click', 'browser_type', 'jev_task', 'jev_find', 'jev_check']) assert.ok(names.includes(n), n);
    assert.ok(list.result.tools.every((t) => t.inputSchema.type === 'object' && !('method' in t)));

    // Without the extension: a helpful error, not a crash.
    const noExt = await s.call('tools/call', { name: 'browser_snapshot', arguments: {} });
    assert.equal(noExt.result.isError, true);
    assert.match(noExt.result.content[0].text, /not connected/);

    const ext = await fakeExtension();
    const snap = await s.call('tools/call', { name: 'browser_snapshot', arguments: {} });
    const text = snap.result.content[0].text;
    assert.match(text, /\[5\] link "More info" → \/info — About this domain/);
    assert.match(text, /\[6\] textbox "Email" value="a@b.c"/);
    assert.match(text, /\[7\] combobox "Country" = "NL" options: NL \| BE/);

    const click = await s.call('tools/call', { name: 'browser_click', arguments: { ref: 5 } });
    assert.match(click.result.content[0].text, /^Clicked "More info"/);

    const shot = await s.call('tools/call', { name: 'browser_screenshot', arguments: {} });
    assert.deepEqual(shot.result.content[0], { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });

    const task = await s.call('tools/call', { name: 'jev_task', arguments: { goal: 'Open more info' }, _meta: { progressToken: 'p1' } });
    const t = task.result.content[0].text;
    assert.match(t, /^Status: done/);
    assert.match(t, /1\. CLICK "More info" \(0.93\)/);
    assert.match(t, /Final page: Info — https:\/\/example.com\/info/);
    assert.ok(s.notes.some((n) => n.method === 'notifications/progress' && n.params.progressToken === 'p1'));

    const err = await s.call('tools/call', { name: 'jev_check', arguments: { statement: 'x' } });
    assert.equal(err.result.isError, true);
    const unknown = await s.call('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const missing = await s.call('bogus/method', {});
    assert.equal(missing.error.code, -32601);
    ext.close();
  } finally {
    s.child.kill();
  }
});
