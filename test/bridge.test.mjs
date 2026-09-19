// The bridge: extension <-> owner hub <-> peer hubs, over real sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../mcp/lib/hub.mjs';

const EXT = 'chrome-extension://' + 'a'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => 20000 + Math.floor(Math.random() * 20000);

// A fake extension: answers every request with its method name, and sends one progress event.
function fakeExtension(port, origin = EXT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers: { origin } });
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', version: 't', extensionId: 'a'.repeat(32) })); resolve(ws); };
    ws.onerror = () => reject(new Error('refused'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== 'request') return;
      ws.send(JSON.stringify({ type: 'event', id: msg.id, event: { type: 'action', step: 1 } }));
      if (msg.method === 'boom') ws.send(JSON.stringify({ type: 'response', id: msg.id, error: { message: 'kaboom' } }));
      else ws.send(JSON.stringify({ type: 'response', id: msg.id, result: { echo: msg.method, params: msg.params, big: 'x'.repeat(msg.params.big || 0) } }));
    };
  });
}

test('owner forwards requests to the extension and relays progress and errors', async () => {
  const port = freePort();
  const home = mkdtempSync(join(tmpdir(), 'jbc-'));
  const hub = await new Hub({ port, version: 't', home }).start();
  assert.equal(hub.mode, 'owner');
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.service, 'jev-browser-control');
  assert.equal(health.extension, false);

  const ext = await fakeExtension(port);
  const events = [];
  const r = await hub.request('snapshot', { a: 1, big: 200_000 }, { onEvent: (e) => events.push(e) });
  assert.equal(r.echo, 'snapshot');
  assert.equal(r.big.length, 200_000); // 64-bit length frames
  assert.deepEqual(events, [{ type: 'action', step: 1 }]);
  await assert.rejects(hub.request('boom'), /kaboom/);
  ext.close();
  hub.close();
});

test('web pages and unknown extensions are refused', async () => {
  const port = freePort();
  const home = mkdtempSync(join(tmpdir(), 'jbc-'));
  const hub = await new Hub({ port, version: 't', home, allowedExtensionIds: ['a'.repeat(32)] }).start();
  await assert.rejects(fakeExtension(port, 'https://evil.example'), /refused/);
  await assert.rejects(fakeExtension(port, 'chrome-extension://' + 'b'.repeat(32)), /refused/);
  const ok = await fakeExtension(port);
  ok.close();
  // A peer needs the token from the local file.
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}/peer?token=nope`); w.onopen = res; w.onerror = () => rej(new Error('refused')); }), /refused/);
  hub.close();
});

test('no extension: a clear error after a short wait', async () => {
  const port = freePort();
  const hub = await new Hub({ port, version: 't', home: mkdtempSync(join(tmpdir(), 'jbc-')) }).start();
  const t0 = Date.now();
  await assert.rejects(hub.request('status'), /not connected/);
  assert.ok(Date.now() - t0 >= 3900);
  hub.close();
});

test('a second session joins as a peer, and takes over when the owner exits', async () => {
  const port = freePort();
  const home = mkdtempSync(join(tmpdir(), 'jbc-'));
  const owner = await new Hub({ port, version: 't', home }).start();
  const peer = await new Hub({ port, version: 't', home }).start();
  assert.equal(peer.mode, 'peer');
  let ext = await fakeExtension(port);
  const events = [];
  const r = await peer.request('tabs.list', { x: 2 }, { onEvent: (e) => events.push(e) });
  assert.equal(r.echo, 'tabs.list');
  assert.equal(events.length, 1);

  owner.close();
  ext.close();
  await sleep(1500);
  assert.equal(peer.mode, 'owner');
  ext = await fakeExtension(port);
  assert.equal((await peer.request('status')).echo, 'status');
  ext.close();
  peer.close();
});
