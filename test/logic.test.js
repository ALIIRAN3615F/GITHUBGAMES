'use strict';

// Server-side logic tests. These run without a browser and cover the parts that
// are easy to break and hard to notice in play: level connectivity, the frame
// codec, and a full objective round from spawn to extraction.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { generate, worldToCell, idx } = require('../server/mapgen');
const { findPath, hasLineOfSight } = require('../server/pathfind');
const { makeRng } = require('../server/rng');
const { Session } = require('../server/game');

const gridOf = (map) => Uint8Array.from(map.grid, (c) => +c);

// --- Map generation ---------------------------------------------------------

test('every generated map keeps its objectives reachable', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const map = generate({ seed, size: seed % 3 === 0 ? 'small' : seed % 3 === 1 ? 'medium' : 'large' });
    const grid = gridOf(map);
    const from = { cx: map.spawn.cx, cy: map.spawn.cy };

    assert.strictEqual(grid[idx(from.cx, from.cy, map.w)], 1, `seed ${seed}: spawn is inside rock`);

    for (const [name, target] of [['generator', map.generator], ['exit', map.exit]]) {
      const path = findPath(grid, map.w, map.h, from, { cx: target.cx, cy: target.cy });
      assert.ok(path, `seed ${seed}: ${name} unreachable from spawn`);
    }
    for (const fuse of map.fuses) {
      const cell = worldToCell(fuse.x, fuse.z, map.w, map.h);
      assert.strictEqual(grid[idx(cell.cx, cell.cy, map.w)], 1, `seed ${seed}: fuse ${fuse.id} inside rock`);
      assert.ok(findPath(grid, map.w, map.h, from, cell), `seed ${seed}: fuse ${fuse.id} unreachable`);
    }
  }
});

test('the map is enclosed by solid rock', () => {
  const map = generate({ seed: 99 });
  const grid = gridOf(map);
  for (let x = 0; x < map.w; x++) {
    assert.strictEqual(grid[idx(x, 0, map.w)], 0, 'top edge leaks');
    assert.strictEqual(grid[idx(x, map.h - 1, map.w)], 0, 'bottom edge leaks');
  }
  for (let y = 0; y < map.h; y++) {
    assert.strictEqual(grid[idx(0, y, map.w)], 0, 'left edge leaks');
    assert.strictEqual(grid[idx(map.w - 1, y, map.w)], 0, 'right edge leaks');
  }
});

test('the same seed always produces the same facility', () => {
  const a = generate({ seed: 4242, size: 'medium', fuseCount: 6 });
  const b = generate({ seed: 4242, size: 'medium', fuseCount: 6 });
  assert.strictEqual(a.grid, b.grid);
  assert.deepStrictEqual(a.fuses, b.fuses);
  assert.deepStrictEqual(a.props, b.props);
});

test('fuse count is honoured and clamped', () => {
  assert.strictEqual(generate({ seed: 5, fuseCount: 3 }).fuses.length, 3);
  assert.strictEqual(generate({ seed: 5, fuseCount: 9 }).fuses.length, 9);
  assert.strictEqual(generate({ seed: 5, fuseCount: 99 }).fuses.length, 9);
  assert.strictEqual(generate({ seed: 5, fuseCount: 0 }).fuses.length, 3);
});

// --- Navigation -------------------------------------------------------------

test('line of sight is blocked by walls but clear along a corridor', () => {
  const map = generate({ seed: 7 });
  const grid = gridOf(map);
  const spawn = map.spawn;

  assert.ok(hasLineOfSight(grid, map.w, map.h, map.cell, spawn.x, spawn.z, spawn.x, spawn.z),
    'a point should see itself');

  // Somewhere across a 31-cell maze is never in view.
  assert.ok(!hasLineOfSight(grid, map.w, map.h, map.cell, spawn.x, spawn.z, map.exit.x, map.exit.z),
    'the exit should not be visible from the spawn');
});

test('pathfinding refuses to route into rock', () => {
  const map = generate({ seed: 11 });
  const grid = gridOf(map);
  const wall = { cx: 0, cy: 0 };
  assert.strictEqual(findPath(grid, map.w, map.h, { cx: map.spawn.cx, cy: map.spawn.cy }, wall), null);
});

// --- Deterministic RNG ------------------------------------------------------

test('the seeded rng is reproducible and in range', () => {
  const a = makeRng(1234), b = makeRng(1234);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.strictEqual(v, b());
    assert.ok(v >= 0 && v < 1);
  }
  const r = makeRng(9);
  for (let i = 0; i < 200; i++) {
    const n = r.int(3, 7);
    assert.ok(n >= 3 && n <= 7, `int out of range: ${n}`);
  }
});

// --- WebSocket framing ------------------------------------------------------

test('the handshake matches the RFC 6455 example', () => {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const accept = crypto.createHash('sha1')
    .update('dGhlIHNhbXBsZSBub25jZQ==' + GUID).digest('base64');
  assert.strictEqual(accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

  // And the server must be using that same constant.
  const source = require('fs').readFileSync(require.resolve('../server/wsserver.js'), 'utf8');
  assert.ok(source.includes(GUID), 'wsserver.js is not using the RFC GUID');
});

test('frames survive a masked client round trip at every length class', () => {
  const { WsConnection } = require('../server/wsserver');

  for (const size of [5, 200, 70000]) {
    const payload = JSON.stringify({ t: 'chat', m: 'x'.repeat(size) });
    const conn = new WsConnection(stubSocket(), { socket: { remoteAddress: '127.0.0.1' } });
    const received = [];
    conn.on('message', (m) => received.push(m));

    // Deliver it in two chunks to exercise the partial-frame buffering.
    const frame = maskedTextFrame(payload);
    conn._onData(frame.subarray(0, 3));
    conn._onData(frame.subarray(3));

    assert.strictEqual(received.length, 1, `size ${size}: expected exactly one message`);
    assert.strictEqual(received[0].m.length, size);
  }
});

test('two frames arriving in one packet both get delivered', () => {
  const { WsConnection } = require('../server/wsserver');
  const conn = new WsConnection(stubSocket(), { socket: { remoteAddress: '127.0.0.1' } });
  const received = [];
  conn.on('message', (m) => received.push(m));
  conn._onData(Buffer.concat([
    maskedTextFrame(JSON.stringify({ t: 'a' })),
    maskedTextFrame(JSON.stringify({ t: 'b' })),
  ]));
  assert.deepStrictEqual(received.map((m) => m.t), ['a', 'b']);
});

test('malformed payloads are ignored rather than fatal', () => {
  const { WsConnection } = require('../server/wsserver');
  const conn = new WsConnection(stubSocket(), { socket: { remoteAddress: '127.0.0.1' } });
  const received = [];
  conn.on('message', (m) => received.push(m));
  conn._onData(maskedTextFrame('{not json at all'));
  assert.strictEqual(received.length, 0);
  assert.ok(conn.open, 'garbage should not kill the connection');
});

function stubSocket() {
  const { EventEmitter } = require('events');
  const socket = new EventEmitter();
  socket.write = () => {};
  socket.destroy = () => {};
  socket.setTimeout = () => {};
  socket.setNoDelay = () => {};
  return socket;
}

// Build the client->server form of a text frame: masked, per the spec.
function maskedTextFrame(text) {
  const body = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x81, 0x80 | body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// --- Session ----------------------------------------------------------------

function fakeConn() {
  const sent = [];
  return {
    open: true,
    sent,
    send: (o) => sent.push(o),
    sendRaw: (j) => sent.push(JSON.parse(j)),
    close: () => {},
    of: (type) => sent.filter((m) => m.t === type),
  };
}

function startedSession(playerCount = 2, cfg = {}) {
  const session = new Session();
  Object.assign(session.cfg, { difficulty: 'calm', size: 'small', fuses: 3 }, cfg);
  const players = [];
  for (let i = 0; i < playerCount; i++) {
    players.push(session.addPlayer(fakeConn(), 'P' + i));
  }
  session.startRound();
  return { session, players };
}

// Put a player where walking there would have put them.
function standAt(player, point) {
  player.x = point.x;
  player.z = point.z;
}

test('names are sanitised and never empty', () => {
  const session = new Session();
  const a = session.addPlayer(fakeConn(), '   ');
  const b = session.addPlayer(fakeConn(), '<script>alert(1)</script>');
  const c = session.addPlayer(fakeConn(), 'A'.repeat(50));
  assert.match(a.name, /^Survivor \d+$/);
  assert.ok(!b.name.includes('<'), `unsafe name survived: ${b.name}`);
  assert.ok(c.name.length <= 16);
});

test('the first player hosts, and the host passes on when they leave', () => {
  const session = new Session();
  const a = session.addPlayer(fakeConn(), 'A');
  const b = session.addPlayer(fakeConn(), 'B');
  assert.strictEqual(session.hostId, a.id);
  session.removePlayer(a.id);
  assert.strictEqual(session.hostId, b.id);
});

test('only the host can change settings or start the round', () => {
  const session = new Session();
  session.addPlayer(fakeConn(), 'Host');
  const guest = session.addPlayer(fakeConn(), 'Guest');
  session.handle(guest, { t: 'cfg', difficulty: 'nightmare' });
  assert.strictEqual(session.cfg.difficulty, 'normal', 'a guest changed the difficulty');
  session.handle(guest, { t: 'start' });
  assert.strictEqual(session.phase, 'lobby', 'a guest started the round');
});

test('a full round: collect every fuse, power the generator, escape', () => {
  const { session, players } = startedSession(2, { fuses: 3 });
  const [alice] = players;
  assert.strictEqual(session.phase, 'playing');
  assert.strictEqual(session.fuses.length, 3);

  for (const fuse of session.fuses) {
    standAt(alice, fuse);
    session.handle(alice, { t: 'use', k: 'fuse', id: fuse.id });
    assert.strictEqual(alice.carrying, fuse.id, 'pickup failed');

    standAt(alice, session.map.generator);
    session.handle(alice, { t: 'use', k: 'insert' });
    assert.strictEqual(alice.carrying, null, 'insert failed');
  }

  assert.strictEqual(session.powered, 3);
  assert.ok(session.exitOpen, 'exit did not open once every fuse was seated');
  assert.strictEqual(alice.stats.fuses, 3);

  standAt(alice, session.map.exit);
  session.handle(alice, { t: 'use', k: 'exit' });
  assert.strictEqual(alice.state, 3, 'escape did not register');
  // The round continues while the second player is still down there.
  assert.strictEqual(session.phase, 'playing');

  const [, bob] = players;
  standAt(bob, session.map.exit);
  session.handle(bob, { t: 'use', k: 'exit' });
  assert.strictEqual(session.phase, 'ended');
  assert.strictEqual(session.outcome, 'escaped');
});

test('objectives reject action at a distance', () => {
  const { session, players } = startedSession(1, { fuses: 3 });
  const [p] = players;
  const fuse = session.fuses[0];

  p.x = fuse.x + 40; p.z = fuse.z + 40;
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.carrying, null, 'picked up a fuse from across the map');

  standAt(p, fuse);
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.carrying, fuse.id);

  p.x = session.map.generator.x + 40;
  p.z = session.map.generator.z + 40;
  session.handle(p, { t: 'use', k: 'insert' });
  assert.strictEqual(session.powered, 0, 'seated a fuse from across the map');
});

test('you cannot escape before the power is on', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  standAt(p, session.map.exit);
  session.handle(p, { t: 'use', k: 'exit' });
  assert.strictEqual(p.state, 0, 'escaped through a sealed door');
});

test('only one player can hold a given fuse', () => {
  const { session, players } = startedSession(2);
  const [alice, bob] = players;
  const fuse = session.fuses[0];
  standAt(alice, fuse);
  standAt(bob, fuse);
  session.handle(alice, { t: 'use', k: 'fuse', id: fuse.id });
  session.handle(bob, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(alice.carrying, fuse.id);
  assert.strictEqual(bob.carrying, null, 'two players carried the same fuse');
});

test('going down drops the fuse, and a teammate can revive', () => {
  const { session, players } = startedSession(2);
  const [alice, bob] = players;
  const fuse = session.fuses[0];
  standAt(alice, fuse);
  session.handle(alice, { t: 'use', k: 'fuse', id: fuse.id });

  session.downPlayer(alice, null);
  assert.strictEqual(alice.state, 1, 'not downed');
  assert.strictEqual(alice.carrying, null, 'kept the fuse while down');
  assert.strictEqual(session.fuses[0].state, 0, 'the fuse did not fall to the floor');

  standAt(bob, { x: alice.x, z: alice.z });
  session.handle(bob, { t: 'use', k: 'revive', id: alice.id });
  assert.strictEqual(alice.state, 0, 'revive failed');
  assert.strictEqual(bob.stats.revives, 1);
});

test('a revive only works within reach', () => {
  const { session, players } = startedSession(2);
  const [alice, bob] = players;
  session.downPlayer(alice, null);
  bob.x = alice.x + 30; bob.z = alice.z;
  session.handle(bob, { t: 'use', k: 'revive', id: alice.id });
  assert.strictEqual(alice.state, 1, 'revived from across the map');
});

test('bleeding out kills, and the last death ends the round', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  session.downPlayer(p, null);
  assert.strictEqual(p.state, 1);

  // Calm difficulty gives 60 seconds of bleed-out; run well past it.
  for (let i = 0; i < 120 * 30 && p.state === 1; i++) session.update(1 / 30);
  assert.strictEqual(p.state, 2, 'never bled out');
  assert.strictEqual(session.phase, 'ended');
  assert.strictEqual(session.outcome, 'lost');
});

test('a revived player bleeds out faster the next time', () => {
  const { session, players } = startedSession(2);
  const [alice, bob] = players;
  session.downPlayer(alice, null);
  const first = alice.downTimer;
  standAt(bob, { x: alice.x, z: alice.z });
  session.handle(bob, { t: 'use', k: 'revive', id: alice.id });
  session.downPlayer(alice, null);
  assert.ok(alice.downTimer < first, 'the second down was not harsher');
});

test('the monster wakes, leaves its corner and can be heard', () => {
  const { session } = startedSession(1, { difficulty: 'normal' });
  const monster = session.monsters[0];
  assert.strictEqual(monster.state, 'dormant');
  const start = { x: monster.x, z: monster.z };

  for (let i = 0; i < 30 * 60; i++) session.update(1 / 30);   // 60 seconds
  assert.notStrictEqual(monster.state, 'dormant', 'the monster never woke up');
  const travelled = Math.hypot(monster.x - start.x, monster.z - start.z);
  assert.ok(travelled > 1, `the monster never moved (${travelled.toFixed(2)}m)`);

  // A loud noise nearby should pull it into an investigation.
  monster.state = 'patrol';
  session.hearNoise(monster.x + 2, monster.z, 1);
  assert.strictEqual(monster.state, 'hunt', 'the monster ignored a noise at its feet');
});

test('the monster stays inside the level', () => {
  const { session } = startedSession(2, { difficulty: 'nightmare' });
  for (let i = 0; i < 30 * 90; i++) {
    session.update(1 / 30);
    for (const m of session.monsters) {
      assert.ok(!session.isSolidAt(m.x, m.z),
        `monster ${m.id} walked into rock at ${m.x.toFixed(1)},${m.z.toFixed(1)} (state ${m.state})`);
    }
  }
});

test('nightmare fields more than one monster', () => {
  const { session } = startedSession(1, { difficulty: 'nightmare' });
  assert.strictEqual(session.monsters.length, 2);
});

test('input from a tampered client is clamped, not trusted', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const from = { x: p.x, z: p.z };
  p.lastInput = Date.now();
  // Claim a position on the far side of the map in a single tick.
  session.handle(p, { t: 'input', p: [from.x + 500, 0, from.z + 500], y: 0, f: 0 });
  const jump = Math.hypot(p.x - from.x, p.z - from.z);
  assert.ok(jump < 5, `teleport accepted: moved ${jump.toFixed(1)}m in one tick`);
});

test('chat is length-limited and stripped of control characters', () => {
  const session = new Session();
  const conn = fakeConn();
  const p = session.addPlayer(conn, 'Talker');

  const esc = String.fromCharCode(27);
  session.handle(p, { t: 'chat', m: `hello ${esc}[31m world` });
  const msg = conn.of('chat').pop();
  const hasControl = [...msg.m].some((c) => {
    const n = c.charCodeAt(0);
    return n < 32 || n === 127;
  });
  assert.ok(!hasControl, 'the escape sequence was not stripped');
  assert.ok(msg.m.includes('hello'), 'the message itself was eaten');

  session.handle(p, { t: 'chat', m: 'x'.repeat(500) });
  assert.ok(conn.of('chat').pop().m.length <= 180);
});

test('a disconnect mid-carry returns the fuse to the floor', () => {
  const { session, players } = startedSession(2);
  const [alice] = players;
  const fuse = session.fuses[0];
  standAt(alice, fuse);
  session.handle(alice, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(session.fuses[0].state, 1);
  session.removePlayer(alice.id);
  assert.strictEqual(session.fuses[0].state, 0, 'the fuse left with them');
});

test('snapshots carry every player, monster, fuse and battery', () => {
  const { session, players } = startedSession(2);
  const conn = players[0].conn;
  session.sendSnapshot();
  const snap = conn.of('snap').pop();
  assert.strictEqual(snap.p.length, 2);
  assert.strictEqual(snap.m.length, session.monsters.length);
  assert.strictEqual(snap.f.length, session.fuses.length);
  assert.strictEqual(snap.b.length, session.batteries.length);
  // [id, x, y, z, yaw, pitch, flags, state, carrying, downTimer, charge, reserve]
  assert.strictEqual(snap.p[0].length, 12, 'player row layout changed');
  assert.strictEqual(typeof snap.o, 'number', 'generator state not broadcast');
});

test('an empty session falls back to the lobby', () => {
  const { session, players } = startedSession(1);
  session.removePlayer(players[0].id);
  assert.strictEqual(session.phase, 'lobby');
});

// --- Flashlight economy and the power switch --------------------------------

test('24 batteries are hidden on every map size', () => {
  const { BATTERY_COUNT } = require('../server/mapgen');
  assert.strictEqual(BATTERY_COUNT, 24);
  for (const size of ['small', 'medium', 'large']) {
    for (const seed of [1, 2, 3]) {
      const map = generate({ seed, size });
      assert.strictEqual(map.batteries.length, 24, `${size}/${seed}: wrong battery count`);
      const cells = new Set(map.batteries.map((b) => `${b.cx},${b.cy}`));
      assert.strictEqual(cells.size, 24, `${size}/${seed}: batteries stacked on each other`);
      const grid = gridOf(map);
      for (const b of map.batteries) {
        assert.strictEqual(grid[idx(b.cx, b.cy, map.w)], 1, `${size}/${seed}: battery inside rock`);
      }
    }
  }
});

test('the flashlight drains only while lit, and never recharges itself', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  assert.strictEqual(p.charge, 100);

  p.flags = 0;                       // light off
  for (let i = 0; i < 30 * 10; i++) session.update(1 / 30);
  assert.strictEqual(p.charge, 100, 'charge moved with the light off');

  p.flags = 8;                       // light on
  for (let i = 0; i < 30 * 10; i++) session.update(1 / 30);
  assert.ok(p.charge < 95 && p.charge > 85, `unexpected drain: ${p.charge}`);

  const low = p.charge;
  p.flags = 0;
  for (let i = 0; i < 30 * 10; i++) session.update(1 / 30);
  assert.strictEqual(p.charge, low, 'the flashlight recharged on its own');
});

test('a flat battery switches the light off by itself', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.charge = 2;
  p.flags = 8;
  for (let i = 0; i < 30 * 5; i++) session.update(1 / 30);
  assert.strictEqual(p.charge, 0);
  assert.strictEqual(p.flags & 8, 0, 'the light stayed on with a flat battery');
});

test('picking up a battery banks it instead of spending it', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.charge = 40;
  const battery = session.batteries[0];
  p.x = battery.x; p.z = battery.z;

  session.handle(p, { t: 'use', k: 'battery', id: battery.id });
  assert.strictEqual(p.reserve, 1, 'battery not banked');
  assert.strictEqual(p.charge, 40, 'pickup spent the battery immediately');
  assert.ok(session.batteries[0].taken, 'battery still on the floor');

  // And it cannot be picked up twice.
  session.handle(p, { t: 'use', k: 'battery', id: battery.id });
  assert.strictEqual(p.reserve, 1, 'the same battery was collected twice');
});

test('batteries cannot be collected from across the map', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const battery = session.batteries[0];
  p.x = battery.x + 50; p.z = battery.z + 50;
  session.handle(p, { t: 'use', k: 'battery', id: battery.id });
  assert.strictEqual(p.reserve, 0);
});

test('reloading spends exactly one battery and refills the charge', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.reserve = 7;
  p.charge = 0;

  session.handle(p, { t: 'use', k: 'reload' });
  assert.strictEqual(p.charge, 100, 'reload did not refill');
  assert.strictEqual(p.reserve, 6, 'reload consumed the wrong number of batteries');

  // A full flashlight must not waste a battery.
  session.handle(p, { t: 'use', k: 'reload' });
  assert.strictEqual(p.reserve, 6, 'a battery was burned on a full flashlight');

  // And an empty reserve cannot conjure one.
  p.reserve = 0;
  p.charge = 10;
  session.handle(p, { t: 'use', k: 'reload' });
  assert.strictEqual(p.charge, 10, 'reloaded from an empty reserve');
});

test('picking up a fuse fully recharges the flashlight', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.charge = 23;
  const fuse = session.fuses[0];
  p.x = fuse.x; p.z = fuse.z;
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.carrying, fuse.id, 'fuse pickup failed');
  assert.strictEqual(p.charge, 100, 'the fuse did not recharge the flashlight');
});

test('the generator switch is authoritative and only live once fully fused', () => {
  const { session, players } = startedSession(2, { fuses: 3 });
  const [a, b] = players;
  const gen = session.map.generator;

  a.x = gen.x; a.z = gen.z;
  session.handle(a, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, false, 'powered up without any fuses');

  // Seat every fuse; the last one brings the building up on its own.
  for (const fuse of session.fuses) {
    a.x = fuse.x; a.z = fuse.z;
    session.handle(a, { t: 'use', k: 'fuse', id: fuse.id });
    a.x = gen.x; a.z = gen.z;
    session.handle(a, { t: 'use', k: 'insert' });
  }
  assert.strictEqual(session.generatorOn, true, 'the last fuse did not start the generator');
  assert.strictEqual(session.exitOpen, true);

  // Now it is a switch, and either player can throw it.
  session.handle(a, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, false, 'could not switch the power off');
  assert.strictEqual(session.exitOpen, true, 'the blast door should stay open once opened');

  b.x = gen.x; b.z = gen.z;
  session.handle(b, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, true, 'a second player could not switch it back on');

  // Not from the other end of the facility, though.
  b.x = gen.x + 40;
  session.handle(b, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, true, 'switched the power from across the map');
});

test('pitch is accepted and clamped', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  session.handle(p, { t: 'input', p: [p.x, 0, p.z], y: 0, pt: 0.7, f: 0 });
  assert.ok(Math.abs(p.pitch - 0.7) < 1e-6, 'pitch not stored');
  session.handle(p, { t: 'input', p: [p.x, 0, p.z], y: 0, pt: 99, f: 0 });
  assert.ok(p.pitch <= 1.6, 'pitch not clamped');
});
