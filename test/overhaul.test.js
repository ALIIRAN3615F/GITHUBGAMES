'use strict';

// The gameplay overhaul: the sealed doorway, the shutter and its button, the
// Backrooms, the rifle, and the way out through the vent.

const test = require('node:test');
const assert = require('node:assert');

const { generate, idx, ROCK, FLOOR, DOOR } = require('../server/mapgen');
const BACKROOMS = require('../server/backrooms');
const {
  Session, DOOR_SHUT, DOOR_OPENING, DOOR_OPEN, DOOR_OPEN_TIME,
  Z_FACILITY, Z_BACKROOMS, MAG_SIZE, AMMO_RESERVE, MONSTER_HP,
  AK_DAMAGE_MONSTER, F_CROUCH, F_GUN,
} = require('../server/game');

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

function startedSession(players = 1, cfg = {}, seed = 8118) {
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

function powerUp(session, player) {
  for (const fuse of session.fuses) {
    player.x = fuse.x; player.z = fuse.z;
    session.handle(player, { t: 'use', k: 'fuse', id: fuse.id });
    player.x = session.map.generator.x; player.z = session.map.generator.z;
    session.handle(player, { t: 'use', k: 'insert' });
  }
}

function openDoor(session, player) {
  const panel = session.map.door.panel;
  player.x = panel.x; player.z = panel.z;
  session.handle(player, { t: 'use', k: 'button' });
  run(session, DOOR_OPEN_TIME + 0.5);
}

// Reachability on foot, with the door either barring the way or not.
function flood(map, grid, from, doorPasses) {
  const seen = new Uint8Array(map.w * map.h);
  const q = [from];
  seen[idx(from.cx, from.cy, map.w)] = 1;
  for (let k = 0; k < q.length; k++) {
    const c = q[k];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cx = c.cx + dx, cy = c.cy + dy;
      if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) continue;
      const i = idx(cx, cy, map.w);
      if (seen[i]) continue;
      const v = grid[i];
      if (v === ROCK) continue;
      if (v === DOOR && !doorPasses) continue;
      seen[i] = 1;
      q.push({ cx, cy });
    }
  }
  return seen;
}

// --- The doorway ---------------------------------------------------------------

test('the door is an opening in a real wall, with rock on both flanks', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const map = generate({ seed, size: ['small', 'medium', 'large'][seed % 3] });
    const grid = Uint8Array.from(map.grid, (c) => +c);
    const d = map.door;
    const px = d.nz, py = -d.nx;                 // perpendicular to the doorway

    let doors = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === DOOR) doors++;
    assert.strictEqual(doors, 1, `seed ${seed}: expected exactly one door cell`);

    for (const c of [{ cx: d.cx, cy: d.cy }, ...d.vestibule]) {
      for (const s of [-1, 1]) {
        assert.strictEqual(grid[idx(c.cx + px * s, c.cy + py * s, map.w)], ROCK,
          `seed ${seed}: the passage is open at the side of ${c.cx},${c.cy}`);
      }
    }
    const last = d.vestibule[d.vestibule.length - 1];
    assert.strictEqual(grid[idx(last.cx + d.nx, last.cy + d.nz, map.w)], ROCK,
      `seed ${seed}: the passage is not a dead end`);
  }
});

test('nothing can reach the Backrooms side before the door opens', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const map = generate({ seed, size: ['small', 'medium', 'large'][seed % 3] });
    const grid = Uint8Array.from(map.grid, (c) => +c);
    const shut = flood(map, grid, map.spawn, false);
    const open = flood(map, grid, map.spawn, true);

    for (const c of map.door.vestibule) {
      assert.ok(!shut[idx(c.cx, c.cy, map.w)],
        `seed ${seed}: the passage is walkable with the door shut`);
      assert.ok(open[idx(c.cx, c.cy, map.w)],
        `seed ${seed}: the passage is unreachable even with the door open`);
    }
  }
});

test('boring the passage never cuts the facility in two', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const map = generate({ seed, size: ['small', 'medium', 'large'][seed % 3] });
    const grid = Uint8Array.from(map.grid, (c) => +c);
    const reach = flood(map, grid, map.spawn, false);

    let stranded = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR && !reach[i]) stranded++;
    assert.strictEqual(stranded, 0, `seed ${seed}: ${stranded} floor cells cut off from the spawn`);
    assert.ok(reach[idx(map.generator.cx, map.generator.cy, map.w)],
      `seed ${seed}: the generator got walled off`);
  }
});

test('the control panel is beside the door, not on it', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const map = generate({ seed });
    const d = map.door;
    const offset = Math.hypot(d.panel.x - d.x, d.panel.z - d.z);
    assert.ok(offset > 1.5 && offset < 6,
      `seed ${seed}: the panel sits ${offset.toFixed(2)}m from the doorway`);
  }
});

test('the door cell is solid until the shutter is all the way up', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const d = session.map.door;

  assert.ok(session.isSolidAt(d.x, d.z, Z_FACILITY), 'the shut door is not solid');
  powerUp(session, p);
  assert.ok(session.isSolidAt(d.x, d.z, Z_FACILITY), 'power alone made the door passable');

  p.x = d.panel.x; p.z = d.panel.z;
  session.handle(p, { t: 'use', k: 'button' });
  run(session, DOOR_OPEN_TIME * 0.7);
  assert.strictEqual(session.door.phase, DOOR_OPENING);
  assert.ok(session.isSolidAt(d.x, d.z, Z_FACILITY),
    'the doorway opened up before the shutter had finished');

  run(session, DOOR_OPEN_TIME);
  assert.strictEqual(session.door.phase, DOOR_OPEN);
  assert.ok(!session.isSolidAt(d.x, d.z, Z_FACILITY), 'the open doorway is still solid');
});

test('you cannot squeeze past the jambs of an open doorway', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const d = session.map.door;
  powerUp(session, p);
  openDoor(session, p);

  // Stand in the doorway, then try to slide sideways into the wall beside it.
  for (const side of [-1, 1]) {
    p.zone = Z_FACILITY;
    p.x = d.x + d.nz * side * 1.9;
    p.z = d.z + d.nx * side * 1.9;
    session.clampToAperture(p);
    const across = d.nx !== 0 ? Math.abs(p.z - d.z) : Math.abs(p.x - d.x);
    assert.ok(across <= d.half - 0.3,
      `a body ended up ${across.toFixed(2)}m off centre in a ${d.half}m half-opening`);
  }
});

// --- The button -----------------------------------------------------------------

test('the shutter only ever moves because somebody pressed the button', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);
  run(session, 20);
  assert.strictEqual(session.door.phase, DOOR_SHUT,
    'the door opened without anyone touching the panel');
});

test('once it is up it stays up, whatever happens to the power', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);
  openDoor(session, p);
  assert.strictEqual(session.door.phase, DOOR_OPEN);

  p.x = session.map.generator.x; p.z = session.map.generator.z;
  session.handle(p, { t: 'use', k: 'power' });
  assert.strictEqual(session.generatorOn, false);
  run(session, 5);
  assert.strictEqual(session.door.phase, DOOR_OPEN, 'cutting the power shut the door');
});

test('a second press mid-open does not restart the shutter', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  powerUp(session, p);
  p.x = session.map.door.panel.x; p.z = session.map.door.panel.z;
  session.handle(p, { t: 'use', k: 'button' });
  run(session, 3);
  const progress = session.doorProgress();
  session.handle(p, { t: 'use', k: 'button' });
  assert.ok(session.doorProgress() >= progress, 'the shutter went back down');
});

// --- Zones ------------------------------------------------------------------------

test('crossing the threshold moves you on without ending anything', () => {
  const { session, players } = startedSession(2);
  const [a, b] = players;
  powerUp(session, a);
  openDoor(session, a);

  a.x = session.map.door.threshold.x;
  a.z = session.map.door.threshold.z;
  session.update(1 / 30);

  assert.strictEqual(a.zone, Z_BACKROOMS);
  assert.strictEqual(a.state, 0, 'going through counted as escaping');
  assert.strictEqual(session.phase, 'playing', 'going through ended the round');
  assert.strictEqual(b.zone, Z_FACILITY, 'it moved everybody');
  assert.strictEqual(a.conn.events('backrooms').length, 1);
});

test('the threshold does nothing while the door is shut', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.x = session.map.door.threshold.x;
  p.z = session.map.door.threshold.z;
  run(session, 2);
  assert.strictEqual(p.zone, Z_FACILITY, 'walked through a shut door');
});

test('the monster cannot perceive anyone who has gone through', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];
  m.state = 'patrol';

  // Standing on top of it, sprinting, light on: as loud as the game gets.
  p.x = m.x + 1; p.z = m.z;
  p.flags = 1 | 2 | 8;
  p.zone = Z_BACKROOMS;
  run(session, 6);
  assert.notStrictEqual(m.state, 'chase', 'it chased somebody in another zone');
  assert.strictEqual(m.targetId, null);
});

test('the Backrooms are their own level, and the way out is walkable', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const back = BACKROOMS.generate(seed);
    const grid = Uint8Array.from(back.grid, (c) => +c);
    const entry = BACKROOMS.worldToCell(back.entry.x, back.entry.z);
    const ladder = BACKROOMS.worldToCell(back.ladder.x, back.ladder.z);

    const seen = new Uint8Array(back.w * back.h);
    const q = [entry];
    seen[entry.cy * back.w + entry.cx] = 1;
    for (let k = 0; k < q.length; k++) {
      const c = q[k];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cx = c.cx + dx, cy = c.cy + dy;
        if (cx < 0 || cy < 0 || cx >= back.w || cy >= back.h) continue;
        const i = cy * back.w + cx;
        if (seen[i] || grid[i] !== 1) continue;
        seen[i] = 1;
        q.push({ cx, cy });
      }
    }
    assert.ok(seen[ladder.cy * back.w + ladder.cx], `seed ${seed}: the ladder is walled off`);
    assert.ok(back.corridor.length >= 80,
      `seed ${seed}: the final corridor is only ${back.corridor.length}m`);
  }
});

// --- The ladder --------------------------------------------------------------------

test('the climb is a fixed move the server owns, and it ends in the vent', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.zone = Z_BACKROOMS;
  p.x = session.back.ladder.x; p.z = session.back.ladder.z;
  session.handle(p, { t: 'use', k: 'ladder' });
  assert.ok(p.climb > 0, 'the climb never started');

  // Input during the climb must not move anybody anywhere.
  const at = { x: p.x, z: p.z };
  session.handle(p, { t: 'input', p: [at.x + 40, 0, at.z + 40], y: 0, f: 1 });
  assert.ok(Math.hypot(p.x - at.x, p.z - at.z) < 0.01, 'a client walked off the ladder');

  run(session, 2);
  assert.ok(p.y > 0.5, 'the climb is not actually raising them');
  run(session, 4);
  assert.strictEqual(p.state, 3, 'reaching the vent did not get them out');
  assert.strictEqual(p.conn.events('vent').length, 1);
});

test('you cannot climb a ladder you are not standing at', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.zone = Z_BACKROOMS;
  p.x = session.back.ladder.x + 30; p.z = session.back.ladder.z;
  session.handle(p, { t: 'use', k: 'ladder' });
  assert.strictEqual(p.climb, 0, 'climbed a ladder from 30m away');
});

// --- The rifle -----------------------------------------------------------------------

test('there is exactly one rifle, and picking it up is a decision', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  assert.ok(session.weapon, 'no rifle on the map');
  assert.strictEqual(session.weapon.mag, MAG_SIZE);
  assert.strictEqual(session.weapon.reserve, AMMO_RESERVE);

  p.x = session.weapon.x + 20; p.z = session.weapon.z;
  session.handle(p, { t: 'use', k: 'weapon' });
  assert.strictEqual(session.weapon.holder, null, 'picked the rifle up from 20m away');

  p.x = session.weapon.x; p.z = session.weapon.z;
  session.handle(p, { t: 'use', k: 'weapon' });
  assert.strictEqual(session.weapon.holder, p.id);
  assert.ok(p.flags & F_GUN, 'the rifle is not reflected in the player flags');
});

test('a downed player drops the rifle where they fell', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  p.x = session.weapon.x; p.z = session.weapon.z;
  session.handle(p, { t: 'use', k: 'weapon' });
  p.x += 10;
  session.downPlayer(p, null);
  assert.strictEqual(session.weapon.holder, null, 'they kept the rifle while down');
  assert.strictEqual(session.weapon.state, 0);
});

// A direction from the shooter with a clear run of open floor down it.
function clearLine(session, p, metres = 7) {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let clear = true;
    for (let t = 0.2; t < metres; t += 0.2) {
      if (session.isSolidAt(p.x + dx * t, p.z + dz * t, 0)) { clear = false; break; }
    }
    if (clear) return { dx, dz };
  }
  return null;
}

function arm(session, p) {
  p.x = session.weapon.x; p.z = session.weapon.z;
  session.handle(p, { t: 'use', k: 'weapon' });
}

test('the server counts the rounds, and the client cannot spend more', () => {
  const { session, players } = startedSession(1, {}, 4242);
  const [p] = players;
  arm(session, p);

  session.roundTime = 100;
  session.weapon.nextShot = session.roundTime;
  session.handle(p, { t: 'shoot', d: [1, 0, 0] });
  assert.strictEqual(session.weapon.mag, MAG_SIZE - 1);

  // Spamming inside the fire interval buys nothing beyond the small allowance
  // that lets a stuttering client catch up.
  const instant = session.weapon.mag;
  for (let i = 0; i < 50; i++) session.handle(p, { t: 'shoot', d: [1, 0, 0] });
  assert.ok(instant - session.weapon.mag <= 4,
    `a client dumped ${instant - session.weapon.mag} rounds into a single instant`);

  // And over a second of real time it can never beat the rifle's cadence,
  // however hard it hammers the button.
  session.weapon.mag = MAG_SIZE;
  session.weapon.reserve = 200;
  session.weapon.nextShot = session.roundTime;
  let fired = 0;
  for (let tick = 0; tick < 30; tick++) {
    session.roundTime += 1 / 30;
    const before = session.weapon.mag;
    for (let i = 0; i < 8; i++) session.handle(p, { t: 'shoot', d: [1, 0, 0] });
    fired += before - session.weapon.mag;
  }
  assert.ok(fired <= 12, `a spamming client managed ${fired} rounds in a second`);
  assert.ok(fired >= 9, `the rifle only managed ${fired} rounds in a second`);

  // And a magazine is a magazine.
  session.weapon.mag = 1;
  session.weapon.nextShot = session.roundTime;
  session.roundTime += 1;
  session.handle(p, { t: 'shoot', d: [1, 0, 0] });
  session.roundTime += 1;
  session.handle(p, { t: 'shoot', d: [1, 0, 0] });
  assert.strictEqual(session.weapon.mag, 0);
  assert.ok(p.conn.events('dry').length > 0, 'an empty rifle fired silently');
});

test('a shot stops at the first wall it meets', () => {
  const { session, players } = startedSession(1, {}, 4242);
  const [p] = players;
  const m = session.monsters[0];
  arm(session, p);
  m.state = 'patrol';

  // Put the monster somewhere with no line of sight and shoot straight at it.
  let placed = null;
  for (let y = 1; y < session.map.h - 1 && !placed; y++) {
    for (let x = 1; x < session.map.w - 1; x++) {
      const c = session.cellCenter({ cx: x, cy: y });
      if (session.isSolidAt(c.x, c.z, 0)) continue;
      const dx = c.x - p.x, dz = c.z - p.z;
      const r = Math.hypot(dx, dz);
      if (r < 6 || r > 22) continue;
      let blocked = false;
      for (let t = 0.2; t < r; t += 0.2) {
        if (session.isSolidAt(p.x + dx / r * t, p.z + dz / r * t, 0)) { blocked = true; break; }
      }
      if (blocked) { placed = { c, dir: { x: dx / r, z: dz / r } }; break; }
    }
  }
  assert.ok(placed, 'no walled-off spot to test with');
  m.x = placed.c.x; m.z = placed.c.z;
  session.roundTime += 5;
  session.handle(p, { t: 'shoot', d: [placed.dir.x, 0, placed.dir.z] });
  assert.strictEqual(m.hp, MONSTER_HP, 'a round went through a wall');
});

test('the monster takes real damage, goes down, and gets back up angrier', () => {
  const { session, players } = startedSession(1, {}, 4242);
  const [p] = players;
  const m = session.monsters[0];
  arm(session, p);

  const dir = clearLine(session, p);
  assert.ok(dir, 'no clear firing line on this map');
  m.state = 'patrol';
  m.x = p.x + dir.dx * 5;
  m.z = p.z + dir.dz * 5;

  let shots = 0;
  while (m.state !== 'downed' && shots < 40) {
    session.roundTime += 0.2;
    session.handle(p, { t: 'shoot', d: [dir.dx, 0, dir.dz] });
    shots++;
  }
  assert.strictEqual(m.state, 'downed', 'a full magazine did not put it down');
  assert.strictEqual(shots, Math.ceil(MONSTER_HP / AK_DAMAGE_MONSTER),
    'the damage numbers do not add up');

  // Firing into a body already on the floor is a waste of ammunition.
  const downs = p.conn.events('monster-down').length;
  for (let i = 0; i < 5; i++) {
    session.roundTime += 0.2;
    session.weapon.mag = 30;
    session.handle(p, { t: 'shoot', d: [dir.dx, 0, dir.dz] });
  }
  assert.strictEqual(p.conn.events('monster-down').length, downs, 'it was killed twice');

  run(session, 60);
  assert.notStrictEqual(m.state, 'downed', 'it never got back up');
  assert.strictEqual(m.hp, MONSTER_HP);
  assert.strictEqual(m.rage, 1, 'it came back exactly as it was');
  assert.strictEqual(p.conn.events('monster-rise').length, 1);
});

test('there is not enough ammunition to hunt it', () => {
  // Sixty rounds against a monster that takes ten of them and gets back up.
  const kills = (MAG_SIZE + AMMO_RESERVE) / Math.ceil(MONSTER_HP / AK_DAMAGE_MONSTER);
  assert.ok(kills <= 6, `a full loadout buys ${kills} clean kills`);
});

test('friendly fire is real, and the server is the one that decides it', () => {
  const { session, players } = startedSession(2, {}, 4242);
  const [a, b] = players;
  arm(session, a);

  const dir = clearLine(session, a);
  assert.ok(dir, 'no clear firing line on this map');
  b.x = a.x + dir.dx * 3;
  b.z = a.z + dir.dz * 3;
  b.flags = 0;

  let shots = 0;
  while (b.state === 0 && shots < 12) {
    session.roundTime += 0.2;
    session.handle(a, { t: 'shoot', d: [dir.dx, 0, dir.dz] });
    shots++;
  }
  assert.strictEqual(b.state, 1, 'shooting a teammate in the back did nothing');
  assert.ok(a.conn.events('friendly').length >= 1);

  // Crouching genuinely presents a smaller target.
  b.state = 0; b.hp = 100; b.flags = F_CROUCH;
  const hits = a.conn.events('friendly').length;
  session.roundTime += 1;
  session.handle(a, { t: 'shoot', d: [dir.dx, 0.35, dir.dz] });
  assert.strictEqual(a.conn.events('friendly').length, hits,
    'a shot well over a crouching player still hit them');
});

test('a client cannot shoot a rifle it is not holding', () => {
  const { session, players } = startedSession(2, {}, 4242);
  const [a, b] = players;
  arm(session, a);
  session.roundTime += 5;
  const before = session.weapon.mag;
  session.handle(b, { t: 'shoot', d: [1, 0, 0] });
  assert.strictEqual(session.weapon.mag, before, 'somebody else fired the rifle');
});

test('reloading takes time and comes out of the reserve', () => {
  const { session, players } = startedSession(1, {}, 4242);
  const [p] = players;
  arm(session, p);
  session.weapon.mag = 4;
  session.handle(p, { t: 'rl' });
  assert.ok(session.weapon.reloading > 0);

  // Firing mid-reload is not allowed.
  session.roundTime += 5;
  session.handle(p, { t: 'shoot', d: [1, 0, 0] });
  assert.strictEqual(session.weapon.mag, 4, 'fired in the middle of a reload');

  run(session, 3);
  assert.strictEqual(session.weapon.mag, MAG_SIZE);
  assert.strictEqual(session.weapon.reserve, AMMO_RESERVE - (MAG_SIZE - 4));
});

// --- The wire ------------------------------------------------------------------------

test('everything the new systems need rides in the snapshot', () => {
  const { session, players } = startedSession(2);
  const conn = players[1].conn;
  const [a] = players;

  session.sendSnapshot();
  let snap = conn.of('snap').pop();
  assert.deepStrictEqual(snap.dr, [DOOR_SHUT, 0], 'the door is not broadcast');
  assert.strictEqual(snap.wp[2], 0, 'the rifle is not broadcast');
  assert.strictEqual(snap.p[0][12], Z_FACILITY, 'zones are not broadcast');

  powerUp(session, a);
  a.x = session.map.door.panel.x; a.z = session.map.door.panel.z;
  session.handle(a, { t: 'use', k: 'button' });
  run(session, 2);
  session.sendSnapshot();
  snap = conn.of('snap').pop();
  assert.strictEqual(snap.dr[0], DOOR_OPENING);
  assert.ok(snap.dr[1] > 0 && snap.dr[1] < 1, 'the shutter progress is not broadcast');

  run(session, DOOR_OPEN_TIME);
  a.x = session.map.door.threshold.x; a.z = session.map.door.threshold.z;
  session.update(1 / 30);
  session.sendSnapshot();
  snap = conn.of('snap').pop();
  const row = snap.p.find((r) => r[0] === a.id);
  assert.strictEqual(row[12], Z_BACKROOMS, 'the other client cannot tell they went through');
});
