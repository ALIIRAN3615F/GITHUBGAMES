'use strict';

// The round: fuses, the generator, the door, and the way out. Plus the rules a
// tampered client is not allowed to break.

const test = require('node:test');
const assert = require('node:assert');

const { Session, DOOR_SHUT, DOOR_OPENING, DOOR_OPEN, DOOR_OPEN_TIME, MAX_RESERVE } = require('../server/game');

function fakeConn() {
  const sent = [];
  return {
    open: true, sent,
    send: (o) => sent.push(o),
    sendRaw: (j) => sent.push(JSON.parse(j)),
    close: () => {},
    of: (t) => sent.filter((m) => m.t === t),
    events: (k) => sent.filter((m) => m.t === 'ev' && m.k === k),
  };
}

function startedSession(players = 1, cfg = {}, seed = 4242) {
  const session = new Session({ seed });
  Object.assign(session.cfg, { difficulty: 'calm', size: 'small', fuses: 3 }, cfg);
  const list = [];
  for (let i = 0; i < players; i++) list.push(session.addPlayer(fakeConn(), 'P' + i));
  session.startRound();
  return { session, players: list };
}

const run = (session, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) session.update(1 / 30);
};

const standAt = (p, at) => { p.x = at.x; p.y = at.y; };

function powerUp(session, player) {
  for (const fuse of session.fuses) {
    standAt(player, fuse);
    session.handle(player, { t: 'use', k: 'fuse', id: fuse.id });
    standAt(player, session.map.generator);
    session.handle(player, { t: 'use', k: 'insert' });
  }
}

function openDoor(session, player) {
  standAt(player, session.map.door.panel);
  session.handle(player, { t: 'use', k: 'button' });
  run(session, DOOR_OPEN_TIME + 0.5);
}

// --- A full round ---------------------------------------------------------------

test('a full round: every fuse, the generator, the button, and out', () => {
  const { session, players } = startedSession(2, { fuses: 3 });
  const [alice, bob] = players;
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
  assert.strictEqual(session.generatorOn, true, 'the last fuse did not start the generator');
  assert.strictEqual(alice.stats.fuses, 3);
  // Power lights the panel. It does not open the door.
  assert.strictEqual(session.door.phase, DOOR_SHUT, 'the generator opened the door by itself');

  standAt(alice, session.map.door.panel);
  session.handle(alice, { t: 'use', k: 'button' });
  assert.strictEqual(session.door.phase, DOOR_OPENING, 'the button did nothing');
  run(session, DOOR_OPEN_TIME + 0.5);
  assert.strictEqual(session.door.phase, DOOR_OPEN, 'the shutter never finished');
  assert.strictEqual(session.phase, 'playing', 'opening the door ended the round');

  standAt(alice, session.map.door.threshold);
  session.update(1 / 30);
  assert.strictEqual(alice.state, 3, 'reaching the alcove did not count as getting out');
  // The round carries on while somebody is still down there.
  assert.strictEqual(session.phase, 'playing');

  standAt(bob, session.map.door.threshold);
  session.update(1 / 30);
  assert.strictEqual(session.phase, 'ended');
  assert.strictEqual(session.outcome, 'escaped');
});

// --- The door ----------------------------------------------------------------------

test('the doorway is solid until the shutter is all the way up', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const d = session.map.door;

  assert.ok(session.isSolidAt(d.x, d.y), 'the shut door is not solid');
  powerUp(session, p);
  assert.ok(session.isSolidAt(d.x, d.y), 'power alone made the doorway passable');

  standAt(p, d.panel);
  session.handle(p, { t: 'use', k: 'button' });
  run(session, DOOR_OPEN_TIME * 0.6);
  assert.strictEqual(session.door.phase, DOOR_OPENING);
  assert.ok(session.isSolidAt(d.x, d.y), 'the doorway opened before the shutter finished');

  run(session, DOOR_OPEN_TIME);
  assert.ok(!session.isSolidAt(d.x, d.y), 'the open doorway is still solid');
});

test('a dead panel does nothing, and says so', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  standAt(p, session.map.door.panel);
  session.handle(p, { t: 'use', k: 'button' });
  assert.strictEqual(session.door.phase, DOOR_SHUT, 'the shutter moved on a dead panel');
  assert.strictEqual(p.conn.events('door-dead').length, 1, 'no feedback from a dead panel');
});

test('the button cannot be pressed from across the room', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);
  const panel = session.map.door.panel;
  p.x = panel.x + 8; p.y = panel.y;
  session.handle(p, { t: 'use', k: 'button' });
  assert.strictEqual(session.door.phase, DOOR_SHUT, 'pressed a button eight tiles away');
});

test('once the shutter is up, cutting the power does not bring it down', () => {
  const { session, players } = startedSession(2);
  const [a, b] = players;
  powerUp(session, a);
  openDoor(session, a);

  standAt(a, session.map.generator);
  session.handle(a, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, false);
  assert.strictEqual(session.door.phase, DOOR_OPEN, 'the door closed when the lights went out');

  standAt(b, session.map.door.threshold);
  session.update(1 / 30);
  assert.strictEqual(b.state, 3, 'a teammate was stranded by the power going out');
});

test('the alcove does nothing while the door is shut', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  standAt(p, session.map.door.threshold);
  run(session, 2);
  assert.strictEqual(p.state, 0, 'got out through a shut door');
});

// --- Objectives ---------------------------------------------------------------------

test('objectives refuse action at a distance', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const fuse = session.fuses[0];

  p.x = fuse.x + 12; p.y = fuse.y + 12;
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.carrying, null, 'picked up a fuse from across the map');

  standAt(p, fuse);
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.carrying, fuse.id);

  p.x = session.map.generator.x + 12; p.y = session.map.generator.y + 12;
  session.handle(p, { t: 'use', k: 'insert' });
  assert.strictEqual(session.powered, 0, 'seated a fuse from across the map');
});

test('you carry one fuse at a time, and drop it when you go down', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const [first, second] = session.fuses;

  standAt(p, first);
  session.handle(p, { t: 'use', k: 'fuse', id: first.id });
  standAt(p, second);
  session.handle(p, { t: 'use', k: 'fuse', id: second.id });
  assert.strictEqual(p.carrying, first.id, 'picked up a second fuse');

  p.x += 3;
  session.downPlayer(p, null);
  assert.strictEqual(p.carrying, null, 'kept the fuse while down');
  assert.strictEqual(session.fuses.find((f) => f.id === first.id).state, 0, 'the fuse did not fall');
});

test('a fuse tops the flashlight up, and batteries bank rather than spend', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.charge = 20;

  const battery = session.batteries[0];
  standAt(p, battery);
  session.handle(p, { t: 'use', k: 'battery', id: battery.id });
  assert.strictEqual(p.reserve, 1, 'the battery was not banked');
  assert.strictEqual(p.charge, 20, 'the battery was spent on the spot');

  session.handle(p, { t: 'use', k: 'reload' });
  assert.strictEqual(p.charge, 100, 'reloading did not fill the flashlight');
  assert.strictEqual(p.reserve, 0, 'reloading spent more than one battery');

  p.charge = 40;
  const fuse = session.fuses[0];
  standAt(p, fuse);
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.charge, 100, 'handling a fuse did not recharge the flashlight');
});

test('the flashlight only ever runs down, and dies when it is empty', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.flags = 8;                    // light on
  p.charge = 1;
  run(session, 2);
  assert.strictEqual(p.charge, 0);
  assert.strictEqual(p.flags & 8, 0, 'the light stayed on with a dead battery');
  assert.strictEqual(p.conn.events('dead-battery').length, 1);

  run(session, 3);
  assert.strictEqual(p.charge, 0, 'the battery recharged itself');
});

test('the reserve has a ceiling', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.reserve = MAX_RESERVE;
  const battery = session.batteries[0];
  standAt(p, battery);
  session.handle(p, { t: 'use', k: 'battery', id: battery.id });
  assert.strictEqual(p.reserve, MAX_RESERVE, 'carried more than the maximum');
  assert.strictEqual(battery.taken, false, 'the battery was consumed anyway');
});

// --- Downs -------------------------------------------------------------------------

test('downs bleed out, revives cost less each time, and the round ends when nobody is left', () => {
  const { session, players } = startedSession(2);
  const [a, b] = players;

  session.downPlayer(a, null);
  assert.strictEqual(a.state, 1);
  const firstBleed = a.downTimer;

  b.x = a.x; b.y = a.y;
  session.handle(b, { t: 'use', k: 'revive', id: a.id });
  assert.strictEqual(a.state, 0, 'the revive did not land');
  assert.strictEqual(b.stats.revives, 1);

  session.downPlayer(a, null);
  assert.ok(a.downTimer < firstBleed, 'the second down bought the same time as the first');

  session.downPlayer(b, null);
  run(session, 90);
  assert.strictEqual(session.phase, 'ended');
  assert.strictEqual(session.outcome, 'lost');
});

test('a revive cannot be done from across the room', () => {
  const { session, players } = startedSession(2);
  const [a, b] = players;
  session.downPlayer(a, null);
  b.x = a.x + 9; b.y = a.y;
  session.handle(b, { t: 'use', k: 'revive', id: a.id });
  assert.strictEqual(a.state, 1, 'revived somebody nine tiles away');
});

// --- What a client is not allowed to do -----------------------------------------------

test('a client cannot teleport, and cannot slide through a wall when clamped', () => {
  const { session, players } = startedSession(1, {}, 99);
  const [p] = players;
  const start = { x: p.x, y: p.y };

  // Straight past a wall, with the largest budget the clamp ever allows.
  let checked = 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let wall = null;
    for (let r = 1; r < 8; r++) {
      if (session.isSolidAt(start.x + dx * r, start.y + dy * r)) { wall = r; break; }
    }
    if (!wall) continue;
    checked++;
    p.x = start.x; p.y = start.y;
    p.lastInput = Date.now() - 500;
    session.handle(p, { t: 'input', p: [start.x + dx * 20, start.y + dy * 20], a: 0, f: 1 });
    const past = Math.abs(dx) > 0 ? (p.x - start.x) * dx : (p.y - start.y) * dy;
    assert.ok(past < wall, `slid ${past.toFixed(2)} tiles past a wall ${wall} away`);
  }
  assert.ok(checked > 0, 'no wall to test against on this map');
});

test('only the host changes the settings or starts the round', () => {
  const session = new Session({ seed: 7 });
  const host = session.addPlayer(fakeConn(), 'Host');
  const guest = session.addPlayer(fakeConn(), 'Guest');
  assert.strictEqual(session.hostId, host.id);

  session.handle(guest, { t: 'cfg', difficulty: 'nightmare' });
  assert.strictEqual(session.cfg.difficulty, 'normal', 'a guest changed the difficulty');
  session.handle(guest, { t: 'start' });
  assert.strictEqual(session.phase, 'lobby', 'a guest started the round');

  session.handle(host, { t: 'cfg', difficulty: 'nightmare' });
  assert.strictEqual(session.cfg.difficulty, 'nightmare');
});

test('names are sanitised and never empty', () => {
  const session = new Session({ seed: 3 });
  const blank = session.addPlayer(fakeConn(), '   ');
  assert.ok(blank.name.startsWith('Survivor'));
  const nasty = session.addPlayer(fakeConn(), '<script>alert(1)</script>');
  assert.ok(!nasty.name.includes('<'), 'markup survived the name filter');
});

// --- The wire --------------------------------------------------------------------------

test('every piece of state a client needs rides in the snapshot', () => {
  const { session, players } = startedSession(2);
  const conn = players[1].conn;
  const [a] = players;

  session.sendSnapshot();
  let snap = conn.of('snap').pop();
  assert.strictEqual(snap.p.length, 2);
  assert.strictEqual(snap.p[0].length, 10, 'the player row layout changed');
  assert.strictEqual(snap.m.length, session.monsters.length);
  assert.strictEqual(snap.f.length, session.fuses.length);
  assert.strictEqual(snap.b.length, session.batteries.length);
  assert.deepStrictEqual(snap.dr, [DOOR_SHUT, 0], 'the door is not broadcast');

  powerUp(session, a);
  standAt(a, session.map.door.panel);
  session.handle(a, { t: 'use', k: 'button' });
  run(session, 1.5);
  session.sendSnapshot();
  snap = conn.of('snap').pop();
  assert.strictEqual(snap.dr[0], DOOR_OPENING);
  assert.ok(snap.dr[1] > 0 && snap.dr[1] < 1, 'the shutter progress is not broadcast');
  assert.strictEqual(snap.o, 1, 'the generator state is not broadcast');
});

test('a player who leaves takes nothing with them', () => {
  const { session, players } = startedSession(2);
  const [a] = players;
  const fuse = session.fuses[0];
  standAt(a, fuse);
  session.handle(a, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(session.fuses[0].state, 1);
  session.removePlayer(a.id);
  assert.strictEqual(session.fuses[0].state, 0, 'the fuse left with them');
});

test('an empty session falls back to the lobby', () => {
  const { session, players } = startedSession(1);
  session.removePlayer(players[0].id);
  assert.strictEqual(session.phase, 'lobby');
});
