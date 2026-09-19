// The bridge between MCP servers and the Chrome extension.
// The first MCP server on this computer owns the port and talks to the extension.
// Every other one (a second Claude session) connects to the owner as a peer and
// forwards its requests, so several sessions can share one browser. If the owner
// exits, a peer takes over the port.
import { listen } from './ws.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export class NotConnectedError extends Error {
  constructor(port) {
    super(
      `The Jev Browser Control extension is not connected (port ${port}). ` +
      'Ask the user to: 1) install the extension from https://jevbrowsercontrol.com (or load extension/ unpacked), ' +
      '2) keep Chrome open, 3) make sure "Let Claude control this browser" is on in its settings. ' +
      'Clicking the Jev toolbar icon wakes it up. Then retry.',
    );
    this.code = 'not_connected';
  }
}

function peerToken(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'bridge-token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(24).toString('hex');
  writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class Hub {
  constructor({ port, version, allowedExtensionIds = [], home, log = () => {} }) {
    this.port = port;
    this.version = version;
    this.allowed = allowedExtensionIds;
    this.home = home || process.env.JBC_HOME || join(homedir(), '.jev-browser-control');
    this.log = log;
    this.mode = null; // 'owner' | 'peer'
    this.extension = null;
    this.extensionInfo = null;
    this.peers = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.server = null;
    this.peerSocket = null;
    this.waiters = new Set();
    this.closed = false;
  }

  async start() {
    this.token = peerToken(this.home);
    try {
      await this.becomeOwner();
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      await this.becomePeer();
    }
    return this;
  }

  // ---------- owner ----------

  async becomeOwner() {
    this.server = await listen({
      port: this.port,
      verify: (req) => this.verify(req),
      onHttp: (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ service: 'jev-browser-control', version: this.version, extension: !!this.extension, clients: this.peers.size + 1 }));
          return true;
        }
        return false;
      },
      onConnection: (conn, _req, role) => (role === 'extension' ? this.attachExtension(conn) : this.attachPeer(conn)),
    });
    this.mode = 'owner';
    this.log(`bridge listening on 127.0.0.1:${this.port}`);
  }

  verify(req) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = String(req.headers.origin || '');
    if (url.pathname === '/extension') {
      // Web pages always send their own Origin and can't forge chrome-extension://.
      const m = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
      if (!m) return false;
      if (this.allowed.length && !this.allowed.includes(m[1])) return false;
      return 'extension';
    }
    if (url.pathname === '/peer') {
      if (origin) return false; // peers are local Node processes, never pages
      const t = url.searchParams.get('token') || '';
      return same(t, this.token) ? 'peer' : false;
    }
    return false;
  }

  attachExtension(conn) {
    if (this.extension && this.extension !== conn) this.extension.close();
    this.extension = conn;
    conn.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'hello') {
        this.extensionInfo = { version: msg.version, extensionId: msg.extensionId, userAgent: msg.userAgent };
        this.log(`extension ${msg.extensionId} v${msg.version} connected`);
        conn.send({ type: 'welcome', version: this.version });
        for (const w of this.waiters) w();
        this.waiters.clear();
      } else if (msg.type === 'ping') conn.send({ type: 'pong', t: msg.t });
      else if (msg.type === 'response') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const e = new Error(msg.error.message);
          e.code = msg.error.code;
          p.reject(e);
        } else p.resolve(msg.result);
      } else if (msg.type === 'event') this.pending.get(msg.id)?.onEvent?.(msg.event);
    });
    conn.on('close', () => {
      if (this.extension !== conn) return;
      this.extension = null;
      this.extensionInfo = null;
      this.log('extension disconnected');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('The browser extension disconnected before answering (Chrome closed, or the extension was reloaded).'));
        this.pending.delete(id);
      }
    });
  }

  attachPeer(conn) {
    this.peers.add(conn);
    conn.on('close', () => this.peers.delete(conn));
    conn.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type !== 'request') return;
      try {
        const result = await this.request(msg.method, msg.params, { timeoutMs: msg.timeoutMs, onEvent: (event) => conn.send({ type: 'event', id: msg.id, event }) });
        conn.send({ type: 'response', id: msg.id, result });
      } catch (err) {
        conn.send({ type: 'response', id: msg.id, error: { message: err.message, code: err.code } });
      }
    });
  }

  waitForExtension(ms) {
    if (this.extension && this.extensionInfo) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { this.waiters.delete(done); resolve(false); }, ms);
      this.waiters.add(done);
    });
  }

  // ---------- peer ----------

  becomePeer() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/peer?token=${this.token}`);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.mode = 'peer';
        this.peerSocket = ws;
        this.log(`joined the bridge on 127.0.0.1:${this.port} as a peer`);
        resolve();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'event') return p.onEvent?.(msg.event);
        if (msg.type !== 'response') return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; p.reject(e); } else p.resolve(msg.result);
      };
      ws.onclose = () => {
        if (!opened) return reject(new Error(`Port ${this.port} is in use by another program. Set JBC_PORT to a free port (and the same port in the extension settings).`));
        this.peerSocket = null;
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Lost the bridge while waiting; retry.')); this.pending.delete(id); }
        if (!this.closed) setTimeout(() => this.recover(), 200 + Math.random() * 500);
      };
      ws.onerror = () => {};
    });
  }

  async recover() {
    if (this.closed) return;
    try {
      await this.becomeOwner();
    } catch {
      try { await this.becomePeer(); } catch { setTimeout(() => this.recover(), 1000); }
    }
  }

  // ---------- requests ----------

  async request(method, params = {}, { timeoutMs = 60_000, onEvent } = {}) {
    if (this.mode === 'owner') {
      if (!this.extension || !this.extensionInfo) await this.waitForExtension(4000);
      if (!this.extension) throw new NotConnectedError(this.port);
    } else if (!this.peerSocket) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!this.peerSocket) throw new Error('Reconnecting to the browser bridge; retry in a moment.');
    }
    const id = `${process.pid}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, onEvent, timer });
      const msg = { type: 'request', id, method, params, timeoutMs };
      if (this.mode === 'owner') this.extension.send(msg);
      else this.peerSocket.send(JSON.stringify(msg));
    });
  }

  status() {
    return { mode: this.mode, port: this.port, extension: this.mode === 'owner' ? this.extensionInfo : undefined, peers: this.peers.size };
  }

  close() {
    this.closed = true;
    this.extension?.close();
    for (const p of this.peers) p.close();
    this.peerSocket?.close();
    this.server?.close();
  }
}
