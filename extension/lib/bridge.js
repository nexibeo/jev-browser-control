// The link to Claude: the MCP server (started by Claude Code / Claude Desktop) listens on
// ws://127.0.0.1:<port>/extension and this service worker connects to it as a client.
// It probes /health over plain HTTP first, so no WebSocket error is logged while Claude isn't running.
// Messages: server -> {type:'request', id, method, params}; extension -> {type:'response', id, result|error}
// and {type:'event', id, event} for progress. A ping every 20 s keeps the service worker alive.

export class Bridge {
  // endpoint: null for the local MCP bridge on 127.0.0.1:<port>, or { url, protocols } for the remote relay.
  constructor({ port, endpoint = null, source = 'claude', onRequest, onStatus, version }) {
    this.port = port;
    this.endpoint = endpoint;
    this.source = source;
    this.onRequest = onRequest;
    this.onStatus = onStatus || (() => {});
    this.version = version;
    this.ws = null;
    this.connected = false;
    this.server = null;
    this.retry = 1000;
    this.timer = null;
    this.pinger = null;
    this.enabled = true;
  }

  setEndpoint(endpoint) {
    if (JSON.stringify(endpoint) === JSON.stringify(this.endpoint)) return;
    this.endpoint = endpoint;
    this.close();
    this.retry = 1000;
    if (endpoint) this.connect();
  }

  setPort(port) {
    if (port === this.port) return;
    this.port = port;
    this.close();
    this.connect();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.close();
    else this.connect();
  }

  close() {
    clearTimeout(this.timer);
    clearInterval(this.pinger);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} }
    this.ws = null;
    this.setConnected(false);
  }

  setConnected(v, server = null) {
    if (this.connected === v && this.server === server) return;
    this.connected = v;
    this.server = server;
    this.onStatus({ connected: v, port: this.port, server });
  }

  async connect() {
    if (!this.enabled || (this.ws && this.ws.readyState <= 1)) return;
    if (this.source === 'remote' && !this.endpoint) return;
    clearTimeout(this.timer);
    let health = null;
    if (!this.endpoint) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1500) });
        health = await res.json();
      } catch {
        return this.schedule();
      }
      if (health?.service !== 'jev-browser-control') return this.schedule();
    }
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = this.endpoint ? new WebSocket(this.endpoint.url, this.endpoint.protocols) : new WebSocket(`ws://127.0.0.1:${this.port}/extension`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      ws.send(JSON.stringify({ type: 'hello', role: 'extension', version: this.version, extensionId: chrome.runtime.id, userAgent: navigator.userAgent }));
      this.setConnected(true, health ? { version: health.version, clients: health.clients } : { remote: true });
      clearInterval(this.pinger);
      // Exactly this text: the relay answers it without waking up (and it keeps the service worker alive).
      this.pinger = setInterval(() => this.ws?.readyState === 1 && this.ws.send('{"type":"ping"}'), 20_000);
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onclose = () => {
      clearInterval(this.pinger);
      if (this.ws === ws) this.ws = null;
      this.setConnected(false);
      this.schedule();
    };
    ws.onerror = () => {};
  }

  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, this.endpoint ? 60_000 : 10_000);
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  async handle(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'pong' || msg.type === 'welcome') return;
    if (msg.type !== 'request') return;
    const emit = (event) => this.send({ type: 'event', id: msg.id, event });
    try {
      const result = await this.onRequest(msg.method, msg.params || {}, { emit, source: this.source });
      this.send({ type: 'response', id: msg.id, result });
    } catch (err) {
      this.send({ type: 'response', id: msg.id, error: { message: String(err?.message || err), code: err?.code } });
    }
  }
}
