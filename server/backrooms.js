'use strict';

// The Backrooms: what is behind the emergency door.
//
// Deliberately not another maze. The facility is tight, dark and hunted; this
// is the opposite - flat yellow light everywhere, partitions that repeat until
// you lose track of which room you were in, and rooms big enough that the walls
// fall out of sight. Nothing lives here. The only thing to find is the way out,
// and there is no marker pointing at it.

const { makeRng } = require('./rng');

const CELL = 4;
const WALL_H = 3.0;          // low ceilings: the whole place presses down

const W = 63, H = 37;
const MAIN_W = 35;           // columns 1..MAIN_W are the wandering half
const ROCK = 0, FLOOR = 1;

// The Backrooms live in their own patch of world space, well clear of the
// facility, so one set of coordinates covers both and nothing ever overlaps.
const ORIGIN_X = 900, ORIGIN_Z = 0;

const idx = (x, y) => y * W + x;

function cellToWorld(cx, cy) {
  return {
    x: ORIGIN_X + (cx - (W - 1) / 2) * CELL,
    z: ORIGIN_Z + (cy - (H - 1) / 2) * CELL,
  };
}

function worldToCell(x, z) {
  return {
    cx: Math.round((x - ORIGIN_X) / CELL + (W - 1) / 2),
    cy: Math.round((z - ORIGIN_Z) / CELL + (H - 1) / 2),
  };
}

function generate(seed) {
  const rng = makeRng((seed ^ 0x9e37) >>> 0);
  const grid = new Uint8Array(W * H).fill(FLOOR);

  for (let x = 0; x < W; x++) { grid[idx(x, 0)] = ROCK; grid[idx(x, H - 1)] = ROCK; }
  for (let y = 0; y < H; y++) { grid[idx(0, y)] = ROCK; grid[idx(W - 1, y)] = ROCK; }

  // Everything past the divider is solid until the long corridor is cut out of
  // it, so the corridor is the only thing on that side of the wall.
  for (let y = 1; y < H - 1; y++) {
    for (let x = MAIN_W + 1; x < W - 1; x++) grid[idx(x, y)] = ROCK;
  }

  const corridorY = (H >> 1) - 1;
  for (let y = corridorY; y <= corridorY + 1; y++) {
    for (let x = MAIN_W + 2; x <= W - 2; x++) grid[idx(x, y)] = FLOOR;
  }
  // One opening in the divider. Finding it is the objective.
  grid[idx(MAIN_W + 1, corridorY)] = FLOOR;

  stampPartitions(grid, rng, corridorY);
  carveHalls(grid, rng);

  const entry = { cx: 3, cy: H >> 1 };
  clearBlock(grid, entry.cx - 1, entry.cy - 1, 3, 3);
  // Keep a pocket in front of the divider opening so the corridor is always
  // reachable, whatever the partitions did.
  clearBlock(grid, MAIN_W - 1, corridorY - 1, 2, 3);

  pruneUnreachable(grid, entry);

  const ladderCell = { cx: W - 2, cy: corridorY };
  const ladderAt = cellToWorld(ladderCell.cx, ladderCell.cy);
  const entryAt = cellToWorld(entry.cx, entry.cy);
  const doorAt = cellToWorld(MAIN_W + 1, corridorY);

  return {
    seed: (seed ^ 0x9e37) >>> 0,
    w: W, h: H, cell: CELL, wallH: WALL_H,
    origin: { x: ORIGIN_X, z: ORIGIN_Z },
    grid: Array.from(grid).join(''),
    // Where survivors arrive, and which way they are facing when they do.
    entry: { x: +entryAt.x.toFixed(2), z: +entryAt.z.toFixed(2), yaw: +(Math.PI / 2).toFixed(3) },
    // The way through the divider, for anyone who finds it.
    corridorDoor: { x: +doorAt.x.toFixed(2), z: +doorAt.z.toFixed(2) },
    corridor: {
      y: corridorY,
      from: MAIN_W + 2, to: W - 2,
      length: +((W - 2 - (MAIN_W + 2) + 1) * CELL).toFixed(1),
    },
    // The ladder stands against the dead end of the corridor; the vent is the
    // hole in the ceiling above it.
    ladder: {
      x: +(ladderAt.x + CELL / 2 - 0.34).toFixed(2),
      z: +ladderAt.z.toFixed(2),
      yaw: +(-Math.PI / 2).toFixed(3),
      top: WALL_H,
    },
  };
}

// The partitions that make the place read as endless: short wall runs on a
// coarse lattice, so corridors repeat without ever quite lining up.
function stampPartitions(grid, rng, corridorY) {
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = 2; x <= MAIN_W - 1; x += 2) {
      if (!rng.chance(0.58)) continue;
      const horizontal = rng.chance(0.5);
      const len = rng.int(2, 7);
      for (let i = 0; i < len; i++) {
        const cx = horizontal ? x + i : x;
        const cy = horizontal ? y : y + i;
        if (cx < 2 || cy < 2 || cx > MAIN_W - 1 || cy > H - 3) break;
        if (cy === corridorY && cx >= MAIN_W - 1) continue;
        grid[idx(cx, cy)] = ROCK;
      }
    }
  }
}

// Three or four halls with nothing in them at all. Walking into one after a
// hundred metres of partitions is the whole point.
function carveHalls(grid, rng) {
  const halls = rng.int(3, 4);
  for (let i = 0; i < halls; i++) {
    const hw = rng.int(9, 13), hh = rng.int(7, 11);
    const x = rng.int(2, Math.max(2, MAIN_W - hw - 1));
    const y = rng.int(2, Math.max(2, H - hh - 3));
    clearBlock(grid, x, y, hw, hh);
  }
}

function clearBlock(grid, x, y, w, h) {
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) continue;
      grid[idx(cx, cy)] = FLOOR;
    }
  }
}

// Anything the partitions walled off entirely is filled in rather than left as
// a sealed pocket nobody can ever stand in.
function pruneUnreachable(grid, entry) {
  const seen = new Uint8Array(W * H);
  const q = [entry];
  seen[idx(entry.cx, entry.cy)] = 1;
  for (let k = 0; k < q.length; k++) {
    const c = q[k];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const cx = c.cx + dx, cy = c.cy + dy;
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      const i = idx(cx, cy);
      if (seen[i] || grid[i] !== FLOOR) continue;
      seen[i] = 1;
      q.push({ cx, cy });
    }
  }
  for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR && !seen[i]) grid[i] = ROCK;
}

module.exports = { generate, cellToWorld, worldToCell, CELL, WALL_H, ORIGIN_X, ORIGIN_Z };
