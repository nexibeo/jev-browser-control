// A minimal WebSocket server (RFC 6455) on node:http, so the MCP server has no dependencies.
// Text and binary frames, fragmentation, ping/pong and close. Server frames are never masked.
import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024;

export function listen({ port, host = '127.0.0.1', verify, onConnection, onHttp }) {
  const server = createServer((req, res) => {
    if (onHttp && onHttp(req, res) !== false) return;
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only\n');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) return socket.destroy();
    const role = verify(req);
    if (!role) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    onConnection(new WsConnection(socket), req, role);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

// A client connection (used by peer MCP servers), so Node 18+ works without a global WebSocket.
export function connect(url, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = randomBytes(16).toString('base64');
    const req = request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (res, socket, head) => {
      const expected = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) { socket.destroy(); return reject(new Error('Bad WebSocket handshake')); }
      socket.setNoDelay(true);
      const conn = new WsConnection(socket, { client: true });
      if (head?.length) socket.unshift(head);
      resolve(conn);
    });
    req.on('response', (res) => { res.resume(); reject(new Error(`WebSocket refused: HTTP ${res.statusCode}`)); });
    req.on('timeout', () => req.destroy(new Error('WebSocket connect timed out')));
    req.on('error', reject);
    req.end();
  });
}

export class WsConnection extends EventEmitter {
  constructor(socket, { client = false } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.open = true;
    let buf = Buffer.alloc(0);
    let fragments = [];
    let fragOpcode = 0;
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (len > MAX_MESSAGE) return this.terminate();
        const maskAt = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
        buf = buf.subarray(off + len);

        if (opcode === 0x8) { this.close(); return; }
        if (opcode === 0x9) { this.frame(0xa, payload); continue; }
        if (opcode === 0xa) continue;
        if (opcode === 0x0) {
          fragments.push(payload);
          if (fin) { this.deliver(fragOpcode, Buffer.concat(fragments)); fragments = []; }
          continue;
        }
        if (!fin) { fragOpcode = opcode; fragments = [payload]; continue; }
        this.deliver(opcode, payload);
      }
    });
    const gone = () => {
      if (!this.open) return;
      this.open = false;
      this.emit('close');
    };
    socket.on('close', gone);
    socket.on('end', gone);
    socket.on('error', gone);
  }

  deliver(opcode, payload) {
    this.emit('message', opcode === 0x1 ? payload.toString('utf8') : payload);
  }

  frame(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    const mask = this.client ? 0x80 : 0; // clients must mask, servers must not
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, mask | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = mask | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = mask | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    if (!this.client) return void this.socket.write(Buffer.concat([head, payload]));
    const key = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
    this.socket.write(Buffer.concat([head, key, body]));
  }

  send(text) {
    this.frame(0x1, Buffer.from(typeof text === 'string' ? text : JSON.stringify(text), 'utf8'));
  }

  close() {
    if (!this.open) return;
    try { this.frame(0x8, Buffer.alloc(0)); } catch {}
    this.open = false;
    this.socket.end();
    this.emit('close');
  }

  terminate() {
    this.open = false;
    this.socket.destroy();
    this.emit('close');
  }
}
