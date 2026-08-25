'use strict';

// What the thing in the dark can and cannot know. These are the acceptance
// criteria from play: a long exploration phase first, crouching that genuinely
// hides you, and never any knowledge that came through a wall.

const test = require('node:test');
const assert = require('node:assert');

const { Session, DIFFICULTY } = require('../server/game');

const F_MOVING = 1, F_SPRINT = 2, F_CROUCH = 4, F_LIGHT = 8;

function fakeConn() {
  const sent = [];
  return {
    open: true, sent,
    send: (o) => sent.push(o),
    sendRaw: (j) => sent.push(JSON.parse(j)),
    close: () => {},
  };
}

// Fixed seed: these are assertions about perception rules, not about where a
// patrol happened to wander this run.
function startedSession(players = 1, cfg = {}, seed = 20260825) {
  const session = new Session({ seed });
  Object.assign(session.cfg, { difficulty: 'normal', size: 'medium', fuses: 4 }, cfg);
  const list = [];
  for (let i = 0; i < players; i++) list.push(session.addPlayer(fakeConn(), 'P' + i));
  session.startRound();
  return { session, players: list };
}

const run = (session, seconds) => {
  for (let i = 0; i < Math.round(seconds * 30); i++) session.update(1 / 30);
};

// Run the simulation with the monster pinned. These tests are about what it can
// perceive, not about where its patrol takes it.
const runPinned = (session, m, seconds) => {
  const at = { x: m.x, y: m.y };
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    session.update(1 / 30);
    m.x = at.x; m.y = at.y;
  }
};

// The longest straight run of open floor on the map. Rooms are only a handful
// of tiles across, so a sightline long enough to test perception at range has
// to be found rather than assumed.
function longestRun(session) {
  const map = session.map;
  const open = (cx, cy) => session.grid[cy * map.w + cx] === 1;
  let best = null;

  for (let cy = 1; cy < map.h - 1; cy++) {
    let start = null;
    for (let cx = 1; cx <= map.w - 1; cx++) {
      if (cx < map.w - 1 && open(cx, cy)) { if (start === null) start = cx; continue; }
      if (start !== null) {
        const len = cx - start;
        if (!best || len > best.len) best = { len, from: { x: start + 0.5, y: cy + 0.5 }, dir: { x: 1, y: 0 } };
        start = null;
      }
    }
  }
  for (let cx = 1; cx < map.w - 1; cx++) {
    let start = null;
    for (let cy = 1; cy <= map.h - 1; cy++) {
      if (cy < map.h - 1 && open(cx, cy)) { if (start === null) start = cy; continue; }
      if (start !== null) {
        const len = cy - start;
        if (!best || len > best.len) best = { len, from: { x: cx + 0.5, y: start + 0.5 }, dir: { x: 0, y: 1 } };
        start = null;
      }
    }
  }
  return best;
}

// Stand a monster and a player at either end of a clear line, `wanted` tiles
// apart or as close to it as the map allows.
function faceOff(session, wanted) {
  const m = session.monsters[0];
  const p = [...session.players.values()][0];
  const run = longestRun(session);
  assert.ok(run && run.len >= 6, 'no straight sightline on this map to test with');
  const d = Math.min(wanted, run.len - 1.2);

  m.state = 'patrol';
  m.timer = 0;
  m.exposure.clear();
  m.lastKnown = null;
  m.targetId = null;
  m.x = run.from.x; m.y = run.from.y;
  p.x = run.from.x + run.dir.x * d;
  p.y = run.from.y + run.dir.y * d;
  return { m, p, d };
}

// A floor cell the monster currently has no line of sight to.
function hiddenSpot(session, m) {
  const map = session.map;
  for (let cy = 1; cy < map.h - 1; cy++) {
    for (let cx = 1; cx < map.w - 1; cx++) {
      if (session.grid[cy * map.w + cx] !== 1) continue;
      const x = cx + 0.5, y = cy + 0.5;
      if (Math.hypot(x - m.x, y - m.y) < 8) continue;   // properly away, not behind a lip
      if (session.lineOfSight(m.x, m.y, x, y)) continue;
      return { x, y };
    }
  }
  return null;
}

// --- The exploration phase ------------------------------------------------------

test('it sleeps long enough to learn the map on every difficulty', () => {
  for (const [name, d] of Object.entries(DIFFICULTY)) {
    assert.ok(d.grace >= 85, `${name}: only ${d.grace}s before it wakes`);
  }
  assert.ok(DIFFICULTY.calm.grace > DIFFICULTY.nightmare.grace,
    'calm should give more breathing room than nightmare');
});

test('nothing a player does wakes it early', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];
  // Stand on top of it, sprinting, light on: as loud as the game allows.
  p.flags = F_MOVING | F_SPRINT | F_LIGHT;
  p.x = m.x + 1; p.y = m.y;

  run(session, 60);
  assert.strictEqual(m.state, 'sleeping', 'a noisy player dragged it out of the exploration phase');
});

test('it wakes through a distinct beat, then patrols', () => {
  const { session } = startedSession(1, { difficulty: 'nightmare' });
  const m = session.monsters[0];
  assert.strictEqual(m.state, 'sleeping');

  run(session, DIFFICULTY.nightmare.grace + 1);
  assert.strictEqual(m.state, 'waking', 'it skipped straight past waking');
  run(session, 8);
  assert.ok(['patrol', 'search', 'idle'].includes(m.state), `expected it up and about, got ${m.state}`);
});

// --- Crouching -------------------------------------------------------------------

test('crouching shrinks how far away it can pick you out', () => {
  const { session } = startedSession(1, { size: 'large' });
  const diff = session.difficulty();
  // Standing still is seen out to sight * 0.65; crouching only to sight * 0.30.
  // Anywhere between the two tells the two stances apart.
  const { m, p, d } = faceOff(session, diff.sight * 0.5);
  assert.ok(d > diff.sight * 0.30 && d < diff.sight * 0.65,
    `the test distance (${d.toFixed(1)}) does not sit between the two thresholds`);

  p.flags = 0;                                     // standing still, light off
  const standing = session.perceive(m, p, diff.hearing, diff.sight);
  p.flags = F_CROUCH;
  const crouched = session.perceive(m, p, diff.hearing, diff.sight);

  assert.ok(standing.seen, 'a standing player is not visible inside its sight range');
  assert.ok(!crouched.seen, 'crouching made no difference to being seen');
});

test('a crouching player is not locked on to instantly, even in the open', () => {
  const { session } = startedSession(1);
  const { m, p } = faceOff(session, 2);
  p.flags = F_CROUCH;

  session.update(1 / 30);
  assert.notStrictEqual(m.state, 'chase', 'locked on to a crouching player in one tick');

  runPinned(session, m, 4);
  assert.strictEqual(m.state, 'chase', 'a crouching player sat in the open at two tiles is never found');
});

test('crouching in a chase lets you break contact', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];

  faceOff(session, 8);
  p.flags = F_MOVING | F_SPRINT | F_LIGHT;
  runPinned(session, m, 2.5);
  assert.strictEqual(m.state, 'chase', 'the chase never started');
  const chasedFrom = { x: p.x, y: p.y };

  // Round a corner, crouch, light off.
  const hidden = hiddenSpot(session, m);
  assert.ok(hidden, 'nowhere on this map is hidden from it');
  p.x = hidden.x; p.y = hidden.y;
  p.flags = F_CROUCH;

  run(session, 6);
  assert.notStrictEqual(m.state, 'chase', 'it kept chasing a silent, hidden, crouching player');
  assert.ok(['search', 'idle', 'patrol'].includes(m.state), `expected it to search or give up, got ${m.state}`);

  // And what it searches is where it last had them, not where they are.
  if (m.lastKnown) {
    const toOld = Math.hypot(m.lastKnown.x - chasedFrom.x, m.lastKnown.y - chasedFrom.y);
    const toNew = Math.hypot(m.lastKnown.x - p.x, m.lastKnown.y - p.y);
    assert.ok(toOld < toNew, 'the last known position followed the player instead of staying put');
  }
});

// --- No knowledge through walls -----------------------------------------------------

test('it never learns a position it cannot see or hear', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];

  faceOff(session, 8);
  p.flags = F_MOVING | F_SPRINT | F_LIGHT;
  runPinned(session, m, 2.5);
  assert.strictEqual(m.state, 'chase');

  const hidden = hiddenSpot(session, m);
  assert.ok(hidden, 'nowhere hidden to test with');
  p.x = hidden.x; p.y = hidden.y;
  p.flags = F_CROUCH;

  const before = m.lastKnown ? { ...m.lastKnown } : null;
  run(session, 8);

  if (m.lastKnown && before) {
    const moved = Math.hypot(m.lastKnown.x - before.x, m.lastKnown.y - before.y);
    assert.ok(moved < 0.01, `the last known position moved ${moved.toFixed(2)} tiles with no perception`);
  }
  const gap = Math.hypot(m.x - p.x, m.y - p.y);
  assert.ok(gap > 2, `it homed in to ${gap.toFixed(1)} tiles on a player it could not perceive`);
});

test('sight always requires line of sight', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];
  const diff = session.difficulty();

  const hidden = hiddenSpot(session, m);
  assert.ok(hidden, 'nowhere hidden to test with');
  p.x = hidden.x; p.y = hidden.y;
  p.flags = F_MOVING | F_LIGHT;                     // as visible as it gets, behind rock

  const info = session.perceive(m, p, diff.hearing, diff.sight * 100);
  assert.ok(!info.seen, 'it saw a player through a wall');
});

test('a noise is a place to look, not a target to follow', () => {
  const { session } = startedSession(1);
  const m = session.monsters[0];
  m.state = 'patrol';
  m.exposure.clear();

  session.hearNoise(m.x + 2, m.y, 1);
  assert.strictEqual(m.state, 'search', 'a nearby noise did not start a search');
  assert.strictEqual(m.targetId, null, 'a noise locked on to a player');
});

test('losing a target sends it back to idle rather than hunting forever', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];

  m.state = 'search';
  m.searchTimer = 0.1;
  m.lastKnown = { x: m.x + 1, y: m.y };
  p.flags = F_CROUCH;
  p.x = m.x + 300; p.y = m.y + 300;                 // far outside the level

  run(session, 25);
  assert.ok(['idle', 'patrol'].includes(m.state), `expected it to give up, got ${m.state}`);
  assert.strictEqual(m.lastKnown, null, 'it kept a stale last known position');
});

// --- Movement ------------------------------------------------------------------------

test('it never walks through a wall', () => {
  const { session } = startedSession(1, { difficulty: 'nightmare' });
  const m = session.monsters[0];
  run(session, DIFFICULTY.nightmare.grace + 12);

  for (let i = 0; i < 900; i++) {
    session.update(1 / 30);
    assert.ok(!session.isSolidAt(m.x, m.y),
      `it ended up inside geometry at ${m.x.toFixed(2)},${m.y.toFixed(2)}`);
  }
});

test('a sprinting player outruns it, a walking one does not', () => {
  const diff = DIFFICULTY.normal;
  const { SPEED } = require('../server/game');
  assert.ok(SPEED.sprint > diff.chase, 'sprinting cannot escape it');
  assert.ok(SPEED.walk < diff.chase, 'you can stroll away from it');
  assert.ok(SPEED.crouch < diff.patrol, 'crouching is not slower than its patrol');
});

test('it gets faster and sharper as the generator comes up', () => {
  const { session, players } = startedSession(1, { size: 'large' });
  const [p] = players;
  const m = session.monsters[0];
  const diff = session.difficulty();

  const { d } = faceOff(session, diff.sight * 0.72);
  p.flags = 0;
  assert.ok(d > diff.sight * 0.65 && d < diff.sight * 0.78,
    `the test distance (${d.toFixed(1)}) is not just outside its ordinary reach`);
  assert.ok(!session.perceive(m, p, diff.hearing, diff.sight).seen,
    'this distance should be outside its sight to begin with');

  // Seat every fuse, which is what sharpens it.
  session.powered = session.map.fuseCount;
  const hearing = diff.hearing * 1.4, sight = diff.sight * 1.2;
  assert.ok(session.perceive(m, p, hearing, sight).seen,
    'seating every fuse did not extend its reach');
});
