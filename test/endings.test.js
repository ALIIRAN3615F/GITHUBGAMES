'use strict';

// The two endings, and the rule that they never trigger each other.

const test = require('node:test');
const assert = require('node:assert');

const { generate } = require('../server/mapgen');
const { Session } = require('../server/game');

function fakeConn() {
  const sent = [];
  return {
    open: true, sent,
    send: (o) => sent.push(o),
    sendRaw: (j) => sent.push(JSON.parse(j)),
    close: () => {},
    of: (type) => sent.filter((m) => m.t === type),
    events: (k) => sent.filter((m) => m.t === 'ev' && m.k === k),
  };
}

function startedSession(players = 1, cfg = {}) {
  const session = new Session({ seed: 4242 });
  Object.assign(session.cfg, { difficulty: 'calm', size: 'small', fuses: 3 }, cfg);
  const list = [];
  for (let i = 0; i < players; i++) list.push(session.addPlayer(fakeConn(), 'P' + i));
  session.startRound();
  return { session, players: list };
}

const run = (session, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) session.update(1 / 30);
};

// Power the door's panel, press the button, and let the shutter finish.
function openDoor(session, player) {
  const panel = session.map.door.panel;
  const at = { x: player.x, z: player.z };
  player.x = panel.x; player.z = panel.z;
  session.handle(player, { t: 'use', k: 'button' });
  run(session, 7);
  player.x = at.x; player.z = at.z;
}

// Seat every fuse, which brings the generator up.
function powerUp(session, player) {
  for (const fuse of session.fuses) {
    player.x = fuse.x; player.z = fuse.z;
    session.handle(player, { t: 'use', k: 'fuse', id: fuse.id });
    player.x = session.map.generator.x; player.z = session.map.generator.z;
    session.handle(player, { t: 'use', k: 'insert' });
  }
}

// --- The fuel can -------------------------------------------------------------

test('every map hides exactly one fuel can, away from the entrance', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const map = generate({ seed });
    assert.ok(map.gasoline, `seed ${seed}: no gasoline on the map`);
    const fromSpawn = Math.hypot(map.gasoline.x - map.spawn.x, map.gasoline.z - map.spawn.z);
    assert.ok(fromSpawn > 10, `seed ${seed}: fuel can is ${fromSpawn.toFixed(1)}m from the spawn`);
  }
});

test('the fuel can is picked up, carried, and dropped when downed', () => {
  const { session, players } = startedSession(1);
  const [p] = players;

  p.x = session.gas.x + 40; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  assert.strictEqual(p.carryingGas, false, 'picked the can up from across the map');

  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  assert.strictEqual(p.carryingGas, true, 'could not pick the can up');
  assert.strictEqual(session.gas.state, 1);

  session.downPlayer(p, null);
  assert.strictEqual(p.carryingGas, false, 'kept the can while down');
  assert.strictEqual(session.gas.state, 0, 'the can did not fall to the floor');
});

test('you cannot carry a fuse and the fuel can at once', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const fuse = session.fuses[0];
  p.x = fuse.x; p.z = fuse.z;
  session.handle(p, { t: 'use', k: 'fuse', id: fuse.id });
  assert.strictEqual(p.carrying, fuse.id);

  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  assert.strictEqual(p.carryingGas, false, 'carried a fuse and a fuel can together');
});

// --- Ending 2 -----------------------------------------------------------------

test('pouring fuel does not explode anything immediately', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });

  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });

  assert.ok(session.sabotage, 'pouring did not start the sequence');
  assert.strictEqual(session.sabotage.phase, 'unstable');
  assert.strictEqual(session.phase, 'playing', 'the ending fired instantly');
  assert.strictEqual(p.carryingGas, false, 'the can was not consumed');
});

test('the sequence runs unstable, explodes, burns, then ends', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const conn = p.conn;

  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });

  run(session, 3);
  assert.strictEqual(session.sabotage.phase, 'unstable', 'it went up too early');
  assert.ok(conn.events('spark').length > 0, 'no sparking during the unstable phase');

  run(session, 7);
  assert.strictEqual(session.sabotage.phase, 'burning', 'it never exploded');
  assert.strictEqual(conn.events('explosion').length, 1, 'no explosion event');
  assert.ok(session.fire > 0, 'nothing caught fire');

  // Fire spreads over the burn window rather than appearing all at once.
  const early = session.fire;
  run(session, 8);
  assert.ok(session.fire > early, 'the fire never spread');

  run(session, 14);
  assert.strictEqual(session.phase, 'ended');
  assert.strictEqual(session.outcome, 'burned', 'wrong ending');
});

test('the explosion kills the power, and a door already up stays up', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);
  assert.strictEqual(session.generatorOn, true);

  openDoor(session, p);
  assert.strictEqual(session.door.phase, 2);

  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });
  run(session, 9);

  assert.strictEqual(session.generatorOn, false, 'the generator kept running after exploding');
  // The shutter is mechanical and it has already done its work. Losing the
  // supply must never strand somebody behind it.
  assert.strictEqual(session.door.phase, 2, 'the explosion shut the door again');
});

test('the monster cannot interrupt a committed ending', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });

  run(session, 9);
  assert.strictEqual(session.sabotage.phase, 'burning');

  // Whatever the monster does now, it must not be able to down anyone.
  session.downPlayer(p, session.monsters[0]);
  assert.strictEqual(p.state, 0, 'the monster downed a player during the ending sequence');
});

// --- Ending 1 -----------------------------------------------------------------

test('the button does nothing without power, and everything with it', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const panel = session.map.door.panel;

  p.x = panel.x; p.z = panel.z;
  session.handle(p, { t: 'use', k: 'button' });
  assert.strictEqual(session.door.phase, 0, 'the shutter moved on a dead panel');
  assert.strictEqual(p.conn.events('door-dead').length, 1, 'no feedback from a dead panel');

  powerUp(session, p);
  p.x = panel.x; p.z = panel.z;
  session.handle(p, { t: 'use', k: 'button' });
  assert.strictEqual(session.door.phase, 1, 'the button did nothing with power on');
  assert.strictEqual(session.phase, 'playing', 'pressing the button ended the round');
});

test('the shutter cannot be pressed from across the room', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);
  const panel = session.map.door.panel;
  p.x = panel.x + 12; p.z = panel.z;
  session.handle(p, { t: 'use', k: 'button' });
  assert.strictEqual(session.door.phase, 0, 'pressed a button 12m away');
});

test('cutting the power afterwards does not close the door', () => {
  const { session, players } = startedSession(2);
  const [a, b] = players;
  powerUp(session, a);
  openDoor(session, a);

  a.x = session.map.generator.x; a.z = session.map.generator.z;
  session.handle(a, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, false);
  assert.strictEqual(session.door.phase, 2, 'the door closed when the lights went out');

  // And the way through is still walkable for whoever is left behind.
  b.x = session.map.door.threshold.x; b.z = session.map.door.threshold.z;
  session.update(1 / 30);
  assert.strictEqual(b.zone, 1, 'a teammate was stranded by the power going out');
});

// --- The two must stay distinct ------------------------------------------------

test('a powered generator does not turn the fuel can into an escape', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);

  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });
  run(session, 30);

  assert.strictEqual(session.outcome, 'burned', 'the fuel produced the wrong ending');
  assert.notStrictEqual(session.outcome, 'escaped');
});

test('getting out through the vent first means the fire ending never happens', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.zone = 1;
  p.x = session.back.ladder.x; p.z = session.back.ladder.z;
  session.handle(p, { t: 'use', k: 'ladder' });
  run(session, 5.2);
  assert.strictEqual(session.outcome, 'escaped');

  // Whatever happens afterwards must not overwrite the result.
  run(session, 30);
  assert.strictEqual(session.outcome, 'escaped', 'the ending changed after the round finished');
});

test('the fuel can cannot be poured twice', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });
  const first = session.sabotage.timer;

  session.handle(p, { t: 'use', k: 'pour' });
  assert.strictEqual(session.sabotage.timer, first, 'a second pour restarted the sequence');
});

// --- Everything the clients need ------------------------------------------------

test('every piece of ending state rides in the snapshot', () => {
  const { session, players } = startedSession(2);
  const [p] = players;
  const conn = players[1].conn;

  session.sendSnapshot();
  let snap = conn.of('snap').pop();
  assert.ok(Array.isArray(snap.gs), 'the fuel can is not in the snapshot');
  assert.strictEqual(snap.gs[2], 0, 'the can should start on the floor');
  assert.strictEqual(snap.sb, null);
  assert.strictEqual(snap.fi, 0);

  p.x = session.gas.x; p.z = session.gas.z;
  session.handle(p, { t: 'use', k: 'gas' });
  session.sendSnapshot();
  snap = conn.of('snap').pop();
  assert.strictEqual(snap.gs[2], 1, 'the other client cannot see the can was taken');
  assert.strictEqual(snap.gs[3], p.id, 'the holder is not broadcast');

  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'pour' });
  run(session, 10);
  session.sendSnapshot();
  snap = conn.of('snap').pop();
  assert.strictEqual(snap.sb, 'burning', 'the sabotage phase is not broadcast');
  assert.ok(snap.fi > 0, 'the fire level is not broadcast');
});
