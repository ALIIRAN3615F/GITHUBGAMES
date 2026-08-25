'use strict';

// Collision and input-hardening tests, covering the bugs reported from play:
// the monster passing through blocks, players walking through generators and
// crates, and the camera snapping to a new heading on its own.

const test = require('node:test');
const assert = require('node:assert');

const { generate, worldToCell, idx } = require('../server/mapgen');
const { Session } = require('../server/game');

const gridOf = (map) => Uint8Array.from(map.grid, (c) => +c);

function fakeConn() {
  const sent = [];
  return { open: true, sent, send: (o) => sent.push(o), sendRaw: (j) => sent.push(JSON.parse(j)), close: () => {} };
}

function startedSession(players = 1, cfg = {}) {
  const session = new Session();
  Object.assign(session.cfg, { difficulty: 'nightmare', size: 'medium', fuses: 4 }, cfg);
  const list = [];
  for (let i = 0; i < players; i++) list.push(session.addPlayer(fakeConn(), 'P' + i));
  session.startRound();
  return { session, players: list };
}

// --- Obstacles shipped with the map -----------------------------------------

test('solid props are exported as obstacles, and stand on walkable floor', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const map = generate({ seed });
    const grid = gridOf(map);
    assert.ok(Array.isArray(map.obstacles), `seed ${seed}: no obstacle list`);
    assert.ok(map.obstacles.length > 0, `seed ${seed}: obstacle list is empty`);

    for (const o of map.obstacles) {
      assert.ok(o.r > 0 && o.r < 2, `seed ${seed}: implausible radius ${o.r}`);
      const cell = worldToCell(o.x, o.z, map.w, map.h);
      assert.strictEqual(grid[idx(cell.cx, cell.cy, map.w)], 1,
        `seed ${seed}: obstacle at ${o.x},${o.z} is embedded in rock`);
    }
  }
});

test('the generator has a footprint, and decoration does not', () => {
  const map = generate({ seed: 42 });
  const gen = map.obstacles.find((o) => Math.abs(o.x - map.generator.x) < 0.01 &&
    Math.abs(o.z - map.generator.z) < 0.01);
  assert.ok(gen, 'the generator is still walk-through');
  assert.ok(gen.r > 1, `generator footprint too small: ${gen.r}`);

  // Flat decals and wall fittings must not become invisible walls.
  const decorative = new Set(['blood', 'debris', 'corpse', 'vent', 'sign']);
  for (const p of map.props.filter((x) => decorative.has(x.t))) {
    const blocking = map.obstacles.some((o) => Math.abs(o.x - p.x) < 0.01 && Math.abs(o.z - p.z) < 0.01);
    assert.ok(!blocking, `${p.t} should not block movement`);
  }
});

test('an obstacle never seals a corridor', () => {
  // A prop wider than the gap it sits in would make objectives unreachable.
  for (let seed = 1; seed <= 20; seed++) {
    const map = generate({ seed });
    const half = map.cell / 2;
    for (const o of map.obstacles) {
      const cell = worldToCell(o.x, o.z, map.w, map.h);
      const center = {
        x: (cell.cx - (map.w - 1) / 2) * map.cell,
        z: (cell.cy - (map.h - 1) / 2) * map.cell,
      };
      // Widest clearance left on either side of the prop within its own cell.
      const gapX = Math.max((o.x - o.r) - (center.x - half), (center.x + half) - (o.x + o.r));
      const gapZ = Math.max((o.z - o.r) - (center.z - half), (center.z + half) - (o.z + o.r));
      assert.ok(Math.max(gapX, gapZ) > 0.8,
        `seed ${seed}: obstacle r=${o.r} leaves only ${Math.max(gapX, gapZ).toFixed(2)}m to squeeze past`);
    }
  }
});

// --- Monster body -----------------------------------------------------------

test('the monster body never overlaps rock, over a long chase', () => {
  const { session, players } = startedSession(2);
  const [a, b] = players;

  // Keep the players noisy and moving so the monster actually hunts.
  a.flags = 1 | 2 | 8;
  b.flags = 1 | 8;

  const RADIUS = 0.4;
  for (let i = 0; i < 30 * 120; i++) {
    session.update(1 / 30);
    if (i % 5 !== 0) continue;
    for (const m of session.monsters) {
      if (m.state === 'dormant') continue;
      // Sample the body outline, not just the centre point.
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2;
        const px = m.x + Math.cos(ang) * RADIUS * 0.92;
        const pz = m.z + Math.sin(ang) * RADIUS * 0.92;
        assert.ok(!session.isSolidAt(px, pz),
          `monster ${m.id} (${m.state}) has its body inside rock at ` +
          `${m.x.toFixed(2)},${m.z.toFixed(2)}`);
      }
    }
  }
});

test('resolveCircle pushes a body out of rock and leaves open floor alone', () => {
  const { session } = startedSession(1);
  const map = session.map;

  // Find a wall cell with floor beside it.
  let wall = null;
  for (let y = 1; y < map.h - 1 && !wall; y++) {
    for (let x = 1; x < map.w - 1; x++) {
      if (session.grid[idx(x, y, map.w)] !== 0) continue;
      if (session.grid[idx(x + 1, y, map.w)] === 1) { wall = { cx: x, cy: y }; break; }
    }
  }
  assert.ok(wall, 'no wall with adjacent floor found');

  // Nudge a body from the open floor slightly into the wall's face, which is
  // the only way movement can penetrate: a step's worth, not a whole cell.
  const center = session.cellCenter(wall);
  const faceX = center.x + session.map.cell / 2;      // boundary with the floor cell
  const probeX = faceX - 0.15;                        // 15cm inside the rock
  const fixed = session.resolveCircle(probeX, center.z, 0.4);
  assert.ok(fixed.x > probeX, 'the body was not pushed back out of the wall');
  assert.ok(!session.isSolidAt(fixed.x, fixed.z), 'ejected into another solid cell');
  assert.ok(fixed.x >= faceX + 0.4 - 0.01,
    `body still overlapping the wall face: ${fixed.x.toFixed(2)} vs ${(faceX + 0.4).toFixed(2)}`);

  // A point in open floor must be left exactly where it is.
  const open = session.cellCenter({ cx: map.spawn.cx, cy: map.spawn.cy });
  const same = session.resolveCircle(open.x, open.z, 0.4);
  assert.ok(Math.abs(same.x - open.x) < 1e-9 && Math.abs(same.z - open.z) < 1e-9,
    'open floor was disturbed');
});

// --- Client-side collision --------------------------------------------------

const loadWorld = async () => {
  const THREE = await import('../public/vendor/three.module.js');
  const { World } = await import('../public/js/world.js');
  return { THREE, World };
};

// Build just the collision half of World, without touching WebGL.
function collisionOnly(World, map) {
  const w = Object.create(World.prototype);
  w.map = map;
  w.grid = gridOf(map);
  w.obstacles = [];
  w.obstacleBuckets = new Map();
  w.indexObstacles(map.obstacles);
  return w;
}

test('players are pushed out of crates, barrels and the generator', async () => {
  const { World } = await loadWorld();
  const map = generate({ seed: 77 });
  const world = collisionOnly(World, map);
  const RADIUS = 0.32;

  for (const o of map.obstacles) {
    // Walk straight at the middle of the prop.
    const r = world.resolveCollision(o.x, o.z, RADIUS);
    const dist = Math.hypot(r.x - o.x, r.z - o.z);
    assert.ok(dist >= o.r + RADIUS - 0.01,
      `stood inside a prop (r=${o.r}): ended ${dist.toFixed(2)}m from its centre`);
  }
});

test('collision leaves you alone when you are nowhere near anything', async () => {
  const { World } = await loadWorld();
  const map = generate({ seed: 77 });
  const world = collisionOnly(World, map);

  const spawn = map.spawn;
  const r = world.resolveCollision(spawn.x, spawn.z, 0.32);
  assert.ok(Math.hypot(r.x - spawn.x, r.z - spawn.z) < 1e-9,
    'an unobstructed position was moved');
});

test('walls still win when a prop is pressed against one', async () => {
  const { World } = await loadWorld();
  const map = generate({ seed: 5 });
  const world = collisionOnly(World, map);

  // Approach each prop from open floor and press into it. The result must
  // clear both the prop and the rock, never one at the other's expense.
  let tested = 0;
  for (const o of map.obstacles) {
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const standX = o.x + Math.cos(ang) * (o.r + 0.5);
      const standZ = o.z + Math.sin(ang) * (o.r + 0.5);
      if (world.isSolidAt(standX, standZ)) continue;   // that side is a wall
      // Push 30cm further into the prop than they can legally stand.
      const intoX = standX - Math.cos(ang) * 0.3;
      const intoZ = standZ - Math.sin(ang) * 0.3;
      const r = world.resolveCollision(intoX, intoZ, 0.32);
      tested++;
      assert.ok(!world.isSolidAt(r.x, r.z),
        `escaping the prop at ${o.x},${o.z} pushed the player into rock`);
      assert.ok(Math.hypot(r.x - o.x, r.z - o.z) >= o.r + 0.32 - 0.02,
        `player ended up inside the prop at ${o.x},${o.z}`);
    }
  }
  assert.ok(tested > 50, `only ${tested} approaches were testable`);
});

// --- Look input -------------------------------------------------------------

test('a single frame cannot spin the view arbitrarily far', async () => {
  const { Input } = await import('../public/js/player.js');
  const input = Object.create(Input.prototype);
  input.mouseDX = 1e6;      // a stall dumping thousands of pixels at once
  input.mouseDY = -1e6;
  const { dx, dy } = input.takeLook();
  assert.ok(Math.abs(dx) <= 700, `dx not clamped: ${dx}`);
  assert.ok(Math.abs(dy) <= 700, `dy not clamped: ${dy}`);
  assert.strictEqual(input.mouseDX, 0, 'accumulator not drained');
  assert.strictEqual(input.mouseDY, 0, 'accumulator not drained');
});

test('ordinary mouse movement passes through untouched', async () => {
  const { Input } = await import('../public/js/player.js');
  const input = Object.create(Input.prototype);
  input.mouseDX = 42;
  input.mouseDY = -17;
  const { dx, dy } = input.takeLook();
  assert.strictEqual(dx, 42);
  assert.strictEqual(dy, -17);
});

test('the source still swallows the pointer-lock spike', async () => {
  // The spike arrives as one huge movementX on the first event after lock;
  // this is behaviour of a DOM listener, so pin it at the source.
  const src = require('fs').readFileSync(require.resolve('../public/js/player.js'), 'utf8');
  assert.ok(src.includes('if (this.swallowNextMove) { this.swallowNextMove = false; return; }'),
    'the first-move guard is gone');
  assert.ok(src.includes('this.swallowNextMove = this.locked;'),
    'the guard is no longer armed on lock change');
  assert.ok(/this\.mouseDX \+= clampDelta\(e\.movementX\)/.test(src),
    'per-event clamping is gone');
});
