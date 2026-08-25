'use strict';

// DEAD AIR - LAN game host.
// Serves the client over plain HTTP and runs the authoritative session on the
// same port over WebSocket. One process, no build step, no dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { WsServer } = require('./wsserver');
const { Session, TICK_HZ, MAX_PLAYERS } = require('./game');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = resolvePort();
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  if (pathname === '/status') return sendJson(res, statusPayload());

  // Resolve inside PUBLIC_DIR and reject anything that escapes it.
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The client is edited and reloaded constantly during a LAN session.
      'Cache-Control': ext === '.js' && filePath.includes('vendor') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

const wss = new WsServer(server);
const session = new Session();

wss.on('connection', (conn) => {
  let player = null;

  conn.on('message', (msg) => {
    if (!player) {
      // The first message must be the join handshake; anything else is ignored
      // so half-open or probing connections never allocate a player slot.
      if (msg.t !== 'join') return;
      player = session.addPlayer(conn, msg.name);
      return;
    }
    try {
      session.handle(player, msg);
    } catch (err) {
      console.error('[session] error handling', msg && msg.t, err);
    }
  });

  conn.on('close', () => {
    if (player) session.removePlayer(player.id);
    player = null;
  });
});

// Fixed-step simulation. Long stalls (a laptop lid closing) are clamped rather
// than replayed, so nobody wakes up to a monster that teleported across the map.
const STEP = 1 / TICK_HZ;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  try {
    session.update(dt);
  } catch (err) {
    console.error('[session] update failed', err);
  }
}, STEP * 1000);

server.listen(PORT, HOST, () => banner());

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Start on another port:\n    npm start -- --port 8091\n`);
    process.exit(1);
  }
  throw err;
});

function statusPayload() {
  return {
    game: 'DEAD AIR',
    phase: session.phase,
    players: session.players.size,
    maxPlayers: MAX_PLAYERS,
    difficulty: session.cfg.difficulty,
  };
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function resolvePort() {
  const flag = process.argv.indexOf('--port');
  if (flag !== -1 && process.argv[flag + 1]) return parseInt(process.argv[flag + 1], 10);
  return parseInt(process.env.PORT || '8090', 10);
}

// Print every address the other machines on the LAN can actually reach.
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      out.push({ name, address: addr.address });
    }
  }
  return out;
}

function banner() {
  const lines = [];
  lines.push('D E A D   A I R');
  lines.push('');
  lines.push('  This machine:   http://localhost:' + PORT);
  const lan = lanAddresses();
  if (lan.length) {
    lines.push('');
    lines.push('  On the LAN, everyone else opens:');
    for (const { name, address } of lan) lines.push('    http://' + address + ':' + PORT + '   (' + name + ')');
  } else {
    lines.push('');
    lines.push('  No LAN interface found - this machine may be offline.');
  }
  lines.push('');
  lines.push('  Up to ' + MAX_PLAYERS + ' players. First to join hosts the lobby.');

  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '-'.repeat(width);
  console.log('\n' + bar);
  for (const l of lines) console.log('  ' + l);
  console.log(bar + '\n');
}
