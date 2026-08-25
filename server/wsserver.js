'use strict';

// Minimal RFC 6455 WebSocket server.
//
// Written from scratch so the game has zero npm dependencies: clone the repo on
// any LAN machine and `npm start` works offline, with no install step. Supports
// text frames, fragmentation, ping/pong keepalive and clean close handshakes -
// everything this game needs and nothing it does not.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1 MiB - generous for chat, hostile to abuse.

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.remoteAddress = req.socket.remoteAddress;
    this.open = true;
    this.lastSeen = Date.now();
    this._buf = Buffer.alloc(0);
    this._fragOp = null;
    this._frags = [];

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._shutdown());
    socket.on('error', () => this._shutdown());
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // A single TCP read can carry several frames, or half of one.
    while (this.open) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD)) { this.close(1009, 'payload too large'); return null; }
      len = Number(big);
      offset += 8;
    }
    if (len > MAX_PAYLOAD) { this.close(1009, 'payload too large'); return null; }

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;

    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;
    switch (opcode) {
      case OP.PING:
        this._send(OP.PONG, payload);
        break;
      case OP.PONG:
        break;
      case OP.CLOSE:
        this._send(OP.CLOSE, payload.subarray(0, 2));
        this._shutdown();
        break;
      case OP.TEXT:
      case OP.BINARY:
        if (fin) this._deliver(opcode, payload);
        else { this._fragOp = opcode; this._frags = [payload]; }
        break;
      case OP.CONT: {
        if (this._fragOp === null) break;
        this._frags.push(payload);
        const total = this._frags.reduce((n, b) => n + b.length, 0);
        if (total > MAX_PAYLOAD) { this.close(1009, 'payload too large'); break; }
        if (fin) {
          const full = Buffer.concat(this._frags);
          const op = this._fragOp;
          this._fragOp = null;
          this._frags = [];
          this._deliver(op, full);
        }
        break;
      }
      default:
        this.close(1002, 'bad opcode');
    }
  }

  _deliver(opcode, payload) {
    if (opcode !== OP.TEXT) return; // The game protocol is JSON text only.
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch {
      return; // Ignore garbage rather than killing the connection.
    }
    if (msg && typeof msg === 'object') this.emit('message', msg);
  }

  _send(opcode, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode. Server frames are never masked.
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._shutdown();
    }
  }

  // Public API -------------------------------------------------------------

  send(obj) {
    this._send(OP.TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  sendRaw(json) {
    // Pre-serialised payload, so one broadcast stringifies once for every client.
    this._send(OP.TEXT, Buffer.from(json, 'utf8'));
  }

  ping() {
    this._send(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._send(OP.CLOSE, body);
    // Give the close frame a moment to flush before tearing the socket down.
    setTimeout(() => this._shutdown(), 60).unref?.();
  }

  _shutdown() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.emit('close');
  }
}

class WsServer extends EventEmitter {
  constructor(httpServer) {
    super();
    this.clients = new Set();
    httpServer.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));

    // Keepalive: ping everyone, drop anyone silent for too long. Without this a
    // client that loses Wi-Fi lingers as a ghost player in the lobby.
    this._timer = setInterval(() => {
      const now = Date.now();
      for (const c of this.clients) {
        if (now - c.lastSeen > 40000) c._shutdown();
        else c.ping();
      }
    }, 12000);
    this._timer.unref?.();
  }

  _upgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const conn = new WsConnection(socket, req);
    if (head && head.length) conn._onData(head);
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
    this.emit('connection', conn);
  }

  broadcast(obj, filter) {
    const json = JSON.stringify(obj);
    for (const c of this.clients) {
      if (filter && !filter(c)) continue;
      c.sendRaw(json);
    }
  }
}

module.exports = { WsServer, WsConnection };
