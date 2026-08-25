'use strict';

// Monster perception tests. These are the acceptance criteria from play: the
// exploration phase has to be long, crouching has to actually hide you, and the
// monster must never behave as though it can see through walls.

const test = require('node:test');
const assert = require('node:assert');

const { DIFFICULTY, Session } = require('../server/game');
const { hasLineOfSight } = require('../server/pathfind');

const F_MOVING = 1, F_SPRINT = 2, F_CROUCH = 4, F_LIGHT = 8;

function fakeConn() {
  const sent = [];
  return { open: true, sent, send: (o) => sent.push(o), sendRaw: (j) => sent.push(JSON.parse(j)), close: () => {} };
}

function startedSession(players = 1, cfg = {}, seed = 20240825) {
  // Fixed seed: these assertions are about perception rules, and must not
  // depend on where a patrol happens to wander this run.
  const session = new Session({ seed });
  Object.assign(session.cfg, { difficulty: 'normal', size: 'medium', fuses: 4 }, cfg);
  const list = [];
  for (let i = 0; i < players; i++) list.push(session.addPlayer(fakeConn(), 'P' + i));
  session.startRound();
  return { session, players: list };
}

const run = (session, seconds) => {
  for (let i = 0; i < seconds * 30; i++) session.update(1 / 30);
};

// Run the simulation with the monster held in place. These tests are about
// what it can perceive, not where its patrol happens to wander.
const runPinned = (session, m, seconds) => {
  const at = { x: m.x, z: m.z };
  for (let i = 0; i < seconds * 30; i++) {
    session.update(1 / 30);
    m.x = at.x; m.z = at.z;
  }
};

// --- The exploration phase ---------------------------------------------------

test('the monster sleeps long enough to explore on every difficulty', () => {
  for (const [name, d] of Object.entries(DIFFICULTY)) {
    assert.ok(d.grace >= 90,
      `${name}: only ${d.grace}s before the monster wakes - not enough to learn the map`);
  }
  assert.ok(DIFFICULTY.calm.grace > DIFFICULTY.nightmare.grace,
    'calm should give more breathing room than nightmare');
});

test('a sprinting player with their light on cannot wake it early', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];
  p.flags = F_MOVING | F_SPRINT | F_LIGHT;
  // Stand right next to it and make as much noise as the game allows.
  p.x = m.x + 1; p.z = m.z;

  run(session, 60);
  assert.strictEqual(m.state, 'sleeping',
    'a noisy player dragged the monster out of the exploration phase');
});

test('it wakes through a distinct waking beat, then patrols', () => {
  const { session } = startedSession(1, { difficulty: 'nightmare' });
  const m = session.monsters[0];
  assert.strictEqual(m.state, 'sleeping');

  run(session, DIFFICULTY.nightmare.grace + 1);
  assert.strictEqual(m.state, 'waking', 'it skipped straight past waking');

  run(session, 9);
  assert.ok(['patrol', 'search', 'idle'].includes(m.state),
    `expected it to be up and about, got ${m.state}`);
});

// --- Crouching ---------------------------------------------------------------

// Put a monster and a player in the same open room, with clear line of sight.
function faceOff(session, distance) {
  const m = session.monsters[0];
  const p = [...session.players.values()][0];
  const room = session.map.rooms.reduce((a, b) => (a.w * a.h > b.w * b.h ? a : b));
  const c = session.cellCenter({ cx: room.x + (room.w >> 1), cy: room.y + (room.h >> 1) });

  m.state = 'patrol';
  m.timer = 0;
  m.exposure.clear();
  m.lastKnown = null;
  m.targetId = null;
  m.x = c.x; m.z = c.z;
  p.x = c.x + distance; p.z = c.z;
  return { m, p };
}

test('crouching shrinks how far away the monster can pick you out', () => {
  const { session } = startedSession(1);
  const diff = session.difficulty();

  // Far enough that a standing player is visible but a crouching one is not.
  const { m, p } = faceOff(session, diff.sight * 0.5);
  p.flags = 0;                       // standing still, light off
  const standing = session.perceive(m, p, diff.hearing, diff.sight);

  p.flags = F_CROUCH;
  const crouched = session.perceive(m, p, diff.hearing, diff.sight);

  assert.ok(standing.seen, 'a standing player should be visible at half the sight range');
  assert.ok(!crouched.seen, 'crouching made no difference to being seen');
});

test('a crouching player is not locked on to instantly, even in view', () => {
  const { session } = startedSession(1);
  const { m, p } = faceOff(session, 3);
  p.flags = F_CROUCH;                 // close, in the open, but low

  // One tick is not enough: it has to hold them in view.
  session.update(1 / 30);
  assert.notStrictEqual(m.state, 'chase', 'locked on to a crouching player instantly');

  runPinned(session, m, 4);
  assert.strictEqual(m.state, 'chase',
    'a crouching player sat in the open at 3m should eventually be found');
});

test('crouching in a chase lets the player break contact', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];

  // Start a genuine chase.
  faceOff(session, 16);
  p.flags = F_MOVING | F_SPRINT | F_LIGHT;
  runPinned(session, m, 2);
  assert.strictEqual(m.state, 'chase', 'the chase never started');
  const chasedFrom = { x: p.x, z: p.z };

  // Now break line of sight and go quiet: round a corner, crouch, light off.
  const hidden = findHiddenSpot(session, m);
  assert.ok(hidden, 'no spot hidden from the monster was available');
  p.x = hidden.x; p.z = hidden.z;
  p.flags = F_CROUCH;                 // crouched, still, dark

  run(session, LOSE_GRACE_PLUS);
  assert.notStrictEqual(m.state, 'chase',
    'the monster kept chasing a silent, hidden, crouching player');
  assert.ok(['search', 'idle', 'patrol'].includes(m.state),
    `expected it to search or give up, got ${m.state}`);

  // And what it is searching is where it last had them, not where they are.
  if (m.lastKnown) {
    const toOld = Math.hypot(m.lastKnown.x - chasedFrom.x, m.lastKnown.z - chasedFrom.z);
    const toNew = Math.hypot(m.lastKnown.x - p.x, m.lastKnown.z - p.z);
    assert.ok(toOld < toNew,
      'the last known position followed the player instead of staying put');
  }
});

const LOSE_GRACE_PLUS = 6;

// A floor cell the monster currently has no line of sight to.
function findHiddenSpot(session, m) {
  const map = session.map;
  for (let y = 1; y < map.h - 1; y++) {
    for (let x = 1; x < map.w - 1; x++) {
      if (session.grid[y * map.w + x] !== 1) continue;
      const c = session.cellCenter({ cx: x, cy: y });
      const d = Math.hypot(c.x - m.x, c.z - m.z);
      if (d < 12) continue;           // needs to be properly away, not just behind a lip
      if (hasLineOfSight(session.grid, map.w, map.h, map.cell, m.x, m.z, c.x, c.z)) continue;
      return c;
    }
  }
  return null;
}

// --- No wallhacks -------------------------------------------------------------

test('the monster never learns a position it cannot see or hear', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];

  faceOff(session, 16);
  p.flags = F_MOVING | F_SPRINT | F_LIGHT;
  runPinned(session, m, 2);
  assert.strictEqual(m.state, 'chase');

  // Teleport the player somewhere it definitely cannot perceive, and hold
  // still and silent there.
  const hidden = findHiddenSpot(session, m);
  p.x = hidden.x; p.z = hidden.z;
  p.flags = F_CROUCH;

  const before = m.lastKnown ? { ...m.lastKnown } : null;
  run(session, 8);

  if (m.lastKnown && before) {
    const moved = Math.hypot(m.lastKnown.x - before.x, m.lastKnown.z - before.z);
    assert.ok(moved < 0.01,
      `the last known position updated by ${moved.toFixed(2)}m with no line of sight`);
  }
  // And it must not have walked onto the player.
  const gap = Math.hypot(m.x - p.x, m.z - p.z);
  assert.ok(gap > 2.5,
    `the monster homed in to ${gap.toFixed(1)}m on a player it could not perceive`);
});

test('sight always requires line of sight', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];
  const diff = session.difficulty();

  const hidden = findHiddenSpot(session, m);
  assert.ok(hidden, 'no hidden cell found');
  p.x = hidden.x; p.z = hidden.z;
  p.flags = F_MOVING | F_LIGHT;      // as visible as it gets, but behind rock

  const info = session.perceive(m, p, diff.hearing, diff.sight * 100);
  assert.ok(!info.seen, 'the monster saw a player through a wall');
});

test('a noise gives the monster a place to look, not a target to follow', () => {
  const { session } = startedSession(1);
  const m = session.monsters[0];
  m.state = 'patrol';
  m.exposure.clear();

  session.hearNoise(m.x + 3, m.z, 1);
  assert.strictEqual(m.state, 'search', 'a nearby noise did not start a search');
  assert.strictEqual(m.targetId, null, 'a noise locked on to a player');
});

test('losing a target returns it to idle rather than hunting forever', () => {
  const { session, players } = startedSession(1);
  const [p] = players;
  const m = session.monsters[0];

  m.state = 'search';
  m.searchTimer = 0.1;
  m.lastKnown = { x: m.x + 1, z: m.z };
  p.flags = F_CROUCH;
  p.x = m.x + 500; p.z = m.z + 500;   // far outside the level, unperceivable

  run(session, 25);
  assert.ok(['idle', 'patrol'].includes(m.state),
    `expected it to give up, got ${m.state}`);
  assert.strictEqual(m.lastKnown, null, 'it kept a stale last known position');
});
