// WebSocket client. One socket, JSON messages, and a ping every couple of
// seconds so the HUD can show the round trip.

const INPUT_HZ = 20;

export class Net {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.id = null;
    this.ping = 0;
    this.handlers = {};
    this.lastInputSent = 0;
    this.pingTimer = null;
  }

  on(type, fn) { this.handlers[type] = fn; return this; }

  connect(name) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${proto}//${location.host}`);
      let settled = false;

      socket.addEventListener('open', () => {
        this.socket = socket;
        this.connected = true;
        socket.send(JSON.stringify({ t: 'join', name }));
        this.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ t: 'ping', c: Date.now() }));
          }
        }, 2000);
        settled = true;
        resolve();
      });

      socket.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === 'pong') { this.ping = Date.now() - msg.c; return; }
        if (msg.t === 'hello') this.id = msg.id;
        const fn = this.handlers[msg.t];
        if (fn) fn(msg);
      });

      socket.addEventListener('close', () => {
        this.connected = false;
        clearInterval(this.pingTimer);
        if (!settled) reject(new Error('Could not reach the host.'));
        else if (this.handlers.closed) this.handlers.closed();
      });

      socket.addEventListener('error', () => {
        if (!settled) reject(new Error('Could not reach the host.'));
      });
    });
  }

  disconnect() {
    clearInterval(this.pingTimer);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'left');
    this.socket = null;
    this.connected = false;
  }

  send(obj) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(obj));
  }

  // Rate limited: the server runs at 30 Hz and interpolates, so flooding it at
  // the display refresh would only burn bandwidth on a shared link.
  sendInput(x, y, aim, flags) {
    const now = performance.now();
    if (now - this.lastInputSent < 1000 / INPUT_HZ) return;
    this.lastInputSent = now;
    this.send({ t: 'input', p: [round(x), round(y)], a: round(aim), f: flags });
  }

  use(kind, id) { this.send({ t: 'use', k: kind, id }); }
  chat(text) { this.send({ t: 'chat', m: text }); }
  setConfig(cfg) { this.send({ t: 'cfg', ...cfg }); }
  ready() { this.send({ t: 'ready' }); }
  start() { this.send({ t: 'start' }); }
}

const round = (v) => Math.round(v * 1000) / 1000;
