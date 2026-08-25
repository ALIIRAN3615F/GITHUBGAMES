// WebSocket client.
//
// Thin on purpose: it owns the socket, the 20 Hz input stream and the RTT
// probe, and hands everything else to whoever subscribed. Reconnection is
// deliberate rather than automatic - silently rejoining a horror game while the
// player is looking away is worse than telling them the link dropped.

const INPUT_HZ = 20;
const PING_INTERVAL = 2000;

export class Net {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.connected = false;
    this.id = null;
    this.ping = 0;
    this.lastInputSent = 0;
    this.pingTimer = null;
    this.pendingPings = new Map();
    this.seq = 0;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  emit(type, payload) {
    for (const fn of this.handlers.get(type) || []) fn(payload);
  }

  connect(name) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let socket;
      try {
        socket = new WebSocket(`${proto}//${location.host}`);
      } catch (err) {
        reject(err);
        return;
      }
      this.socket = socket;

      const failFast = setTimeout(() => {
        if (!this.connected) {
          try { socket.close(); } catch { /* already closing */ }
          reject(new Error('The host did not answer.'));
        }
      }, 8000);

      socket.addEventListener('open', () => {
        clearTimeout(failFast);
        this.connected = true;
        this.send({ t: 'join', name });
        this.startPing();
        resolve();
      });

      socket.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'hello') this.id = msg.id;
        if (msg.t === 'pong') {
          const sent = this.pendingPings.get(msg.c);
          if (sent !== undefined) {
            this.ping = Math.round(performance.now() - sent);
            this.pendingPings.delete(msg.c);
          }
          return;
        }
        this.emit(msg.t, msg);
        this.emit('*', msg);
      });

      socket.addEventListener('close', () => {
        clearTimeout(failFast);
        const wasConnected = this.connected;
        this.connected = false;
        this.stopPing();
        if (wasConnected) this.emit('disconnected', {});
        else reject(new Error('Could not reach the host.'));
      });

      socket.addEventListener('error', () => {
        // 'close' always follows, and carries the state we actually branch on.
      });
    });
  }

  disconnect() {
    this.stopPing();
    if (this.socket) {
      try { this.socket.close(1000, 'left'); } catch { /* already gone */ }
    }
    this.socket = null;
    this.connected = false;
  }

  send(obj) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(obj));
  }

  // Rate-limited: the server runs at 30 Hz and interpolates, so flooding it at
  // display refresh would just burn bandwidth on a shared Wi-Fi link.
  sendInput(position, yaw, pitch, flags) {
    const now = performance.now();
    if (now - this.lastInputSent < 1000 / INPUT_HZ) return;
    this.lastInputSent = now;
    this.send({
      t: 'input',
      p: [round(position.x), round(position.y), round(position.z)],
      y: round(yaw),
      pt: round(pitch),
      f: flags,
    });
  }

  use(kind, id) { this.send({ t: 'use', k: kind, id }); }
  reload() { this.send({ t: 'use', k: 'reload' }); }
  chat(text) { this.send({ t: 'chat', m: text }); }
  setConfig(cfg) { this.send({ t: 'cfg', ...cfg }); }
  start() { this.send({ t: 'start' }); }
  ready() { this.send({ t: 'ready' }); }
  rename(name) { this.send({ t: 'name', name }); }

  startPing() {
    this.stopPing();
    const probe = () => {
      const c = ++this.seq;
      this.pendingPings.set(c, performance.now());
      // Drop stale probes so a long stall cannot grow this map without bound.
      if (this.pendingPings.size > 10) {
        const oldest = this.pendingPings.keys().next().value;
        this.pendingPings.delete(oldest);
      }
      this.send({ t: 'ping', c });
    };
    probe();
    this.pingTimer = setInterval(probe, PING_INTERVAL);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pendingPings.clear();
  }
}

function round(v) { return Math.round(v * 100) / 100; }
