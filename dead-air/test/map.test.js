'use strict';

// The facility has to be walkable, connected, and sealed where it says it is.

const test = require('node:test');
const assert = require('node:assert');

const { generate, idx, ROCK, FLOOR, DOOR } = require('../server/mapgen');
const { findPath, bfsDistances, hasLineOfSight } = require('../server/pathfind');

const sizes = ['small', 'medium', 'large'];
const gridOf = (map) => Uint8Array.from(map.grid, (c) => +c);

// Everything reachable on foot from a cell, over floor only.
function reachable(map, grid, from) {
  const seen = new Uint8Array(map.w * map.h);
  const queue = [from];
  seen[idx(from.cx, from.cy, map.w)] = 1;
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const cx = c.cx + dx, cy = c.cy + dy;
      if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) continue;
      const i = idx(cx, cy, map.w);
      if (seen[i] || grid[i] !== FLOOR) continue;
      seen[i] = 1;
      queue.push({ cx, cy });
    }
  }
  return seen;
}

test('every map is enclosed by solid rock', () => {
  for (const size of sizes) {
    const map = generate({ seed: 11, size });
    const grid = gridOf(map);
    for (let x = 0; x < map.w; x++) {
      assert.strictEqual(grid[idx(x, 0, map.w)], ROCK, `${size}: top edge leaks`);
      assert.strictEqual(grid[idx(x, map.h - 1, map.w)], ROCK, `${size}: bottom edge leaks`);
    }
    for (let y = 0; y < map.h; y++) {
      assert.strictEqual(grid[idx(0, y, map.w)], ROCK, `${size}: left edge leaks`);
      assert.strictEqual(grid[idx(map.w - 1, y, map.w)], ROCK, `${size}: right edge leaks`);
    }
  }
});

test('nothing is ever generated behind a wall it cannot be walked to', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const map = generate({ seed, size: sizes[seed % 3] });
    const grid = gridOf(map);
    const seen = reachable(map, grid, map.spawn);

    let stranded = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR && !seen[i]) stranded++;
    assert.strictEqual(stranded, 0, `seed ${seed}: ${stranded} floor cells cut off from the spawn`);

    assert.ok(seen[idx(map.generator.cx, map.generator.cy, map.w)], `seed ${seed}: generator unreachable`);
    assert.ok(seen[idx(map.door.approach.cx, map.door.approach.cy, map.w)],
      `seed ${seed}: the floor in front of the door is unreachable`);
    for (const f of map.fuses) {
      const cx = Math.floor(f.x), cy = Math.floor(f.y);
      assert.strictEqual(grid[idx(cx, cy, map.w)], FLOOR, `seed ${seed}: fuse ${f.id} is inside rock`);
      assert.ok(seen[idx(cx, cy, map.w)], `seed ${seed}: fuse ${f.id} unreachable`);
    }
    for (const b of map.batteries) {
      const cx = Math.floor(b.x), cy = Math.floor(b.y);
      assert.strictEqual(grid[idx(cx, cy, map.w)], FLOOR, `seed ${seed}: a battery is inside rock`);
    }
  }
});

test('the exit door is an opening in a real wall with a sealed alcove behind it', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const map = generate({ seed, size: sizes[seed % 3] });
    const grid = gridOf(map);
    const d = map.door;

    let doors = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] === DOOR) doors++;
    assert.strictEqual(doors, 1, `seed ${seed}: expected exactly one door cell`);

    // Rock on both flanks of the door and of every cell behind it.
    const px = d.ny, py = -d.nx;
    for (const c of [{ cx: d.cx, cy: d.cy }, ...d.alcove]) {
      for (const s of [-1, 1]) {
        assert.strictEqual(grid[idx(c.cx + px * s, c.cy + py * s, map.w)], ROCK,
          `seed ${seed}: the alcove is open at the side of ${c.cx},${c.cy}`);
      }
    }
    const last = d.alcove[d.alcove.length - 1];
    assert.strictEqual(grid[idx(last.cx + d.nx, last.cy + d.ny, map.w)], ROCK,
      `seed ${seed}: the alcove is not a dead end`);

    // And nothing can walk to it while the door is shut.
    const seen = reachable(map, grid, map.spawn);
    for (const c of d.alcove) {
      assert.ok(!seen[idx(c.cx, c.cy, map.w)],
        `seed ${seed}: the alcove is walkable with the door shut`);
    }
  }
});

test('the control panel is beside the door and reachable from the floor', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const map = generate({ seed });
    const grid = gridOf(map);
    const p = map.door.panel;

    const offset = Math.hypot(p.x - map.door.x, p.y - map.door.y);
    assert.ok(offset > 0.6 && offset < 2.5, `seed ${seed}: the panel is ${offset.toFixed(2)} tiles from the door`);

    // Somewhere a body can stand within arm's reach of it.
    let closest = Infinity;
    for (let cy = 1; cy < map.h - 1; cy++) {
      for (let cx = 1; cx < map.w - 1; cx++) {
        if (grid[idx(cx, cy, map.w)] !== FLOOR) continue;
        closest = Math.min(closest, Math.hypot(cx + 0.5 - p.x, cy + 0.5 - p.y));
      }
    }
    assert.ok(closest <= 1.5, `seed ${seed}: nothing can stand within reach of the panel (${closest.toFixed(2)})`);
  }
});

test('fuses are spread out rather than piled in one corner', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const map = generate({ seed, size: 'medium', fuseCount: 5 });
    const grid = gridOf(map);
    const dist = bfsDistances((x, y) => grid[idx(x, y, map.w)] === FLOOR, map.w, map.h, map.spawn);
    const walks = map.fuses.map((f) => dist[idx(Math.floor(f.x), Math.floor(f.y), map.w)]);
    const spread = Math.max(...walks) - Math.min(...walks);
    assert.ok(spread > 6, `seed ${seed}: every fuse is about the same distance away (spread ${spread})`);
  }
});

test('pathfinding and line of sight agree with the grid', () => {
  const map = generate({ seed: 5, size: 'small' });
  const grid = gridOf(map);
  const walkable = (x, y) => grid[idx(x, y, map.w)] === FLOOR;
  const opaque = (x, y) => grid[idx(x, y, map.w)] !== FLOOR;

  const path = findPath(walkable, map.w, map.h, map.spawn, {
    cx: map.generator.cx, cy: map.generator.cy,
  });
  assert.ok(path && path.length, 'no route from the spawn to the generator');
  for (const step of path) {
    assert.ok(walkable(step.cx, step.cy), 'the route runs through a wall');
  }
  // Consecutive steps are always neighbours - no diagonal shortcuts.
  let prev = map.spawn;
  for (const step of path) {
    assert.strictEqual(Math.abs(step.cx - prev.cx) + Math.abs(step.cy - prev.cy), 1, 'the route jumps');
    prev = step;
  }

  // A cell can always see itself, and never sees through the rock beside it.
  assert.ok(hasLineOfSight(opaque, map.w, map.h, map.spawn.x, map.spawn.y, map.spawn.x, map.spawn.y));
  let blockedFound = false;
  for (let cy = 1; cy < map.h - 1 && !blockedFound; cy++) {
    for (let cx = 1; cx < map.w - 1; cx++) {
      if (grid[idx(cx, cy, map.w)] !== FLOOR) continue;
      const d = Math.hypot(cx + 0.5 - map.spawn.x, cy + 0.5 - map.spawn.y);
      if (d < 6) continue;
      if (!hasLineOfSight(opaque, map.w, map.h, map.spawn.x, map.spawn.y, cx + 0.5, cy + 0.5)) {
        blockedFound = true;
        break;
      }
    }
  }
  assert.ok(blockedFound, 'nothing on this map blocks a line of sight, which cannot be right');
});
