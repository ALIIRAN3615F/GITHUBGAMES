'use strict';

// Grid navigation for the monster: BFS routing plus a DDA line-of-sight test.
// The map is at most ~1600 cells, so a full BFS costs microseconds and we can
// afford to re-plan several times a second while chasing.

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// Breadth-first search from `start` to `goal`. Returns the cell path including
// the goal, or null when the goal is unreachable.
function findPath(grid, w, h, start, goal) {
  if (!inBounds(w, h, goal.cx, goal.cy) || grid[goal.cy * w + goal.cx] !== 1) return null;
  if (start.cx === goal.cx && start.cy === goal.cy) return [];

  const prev = new Int32Array(w * h).fill(-1);
  const seen = new Uint8Array(w * h);
  const startIdx = start.cy * w + start.cx;
  seen[startIdx] = 1;

  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  queue[tail++] = startIdx;

  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx === goal.cx && cy === goal.cy) return unwind(prev, cur, w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(w, h, nx, ny)) continue;
      const ni = ny * w + nx;
      if (seen[ni] || grid[ni] !== 1) continue;
      seen[ni] = 1;
      prev[ni] = cur;
      queue[tail++] = ni;
    }
  }
  return null;
}

function unwind(prev, endIdx, w) {
  const path = [];
  let cur = endIdx;
  while (cur !== -1) {
    path.push({ cx: cur % w, cy: (cur / w) | 0 });
    cur = prev[cur];
  }
  path.pop();          // drop the start cell - we are already standing on it
  return path.reverse();
}

function inBounds(w, h, x, y) {
  return x >= 0 && y >= 0 && x < w && y < h;
}

// Amanatides & Woo style grid march in world space. Used both for "can the
// monster see you" and for muffling sound through walls.
function hasLineOfSight(grid, w, h, cell, ax, az, bx, bz) {
  const half = cell / 2;
  const originX = -((w - 1) / 2) * cell - half;
  const originZ = -((h - 1) / 2) * cell - half;

  let x = Math.floor((ax - originX) / cell);
  let y = Math.floor((az - originZ) / cell);
  const endX = Math.floor((bx - originX) / cell);
  const endY = Math.floor((bz - originZ) / cell);

  const dx = bx - ax, dz = bz - az;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dz > 0 ? 1 : -1;

  const tDeltaX = dx === 0 ? Infinity : Math.abs(cell / dx);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(cell / dz);

  const nextBoundX = originX + (x + (stepX > 0 ? 1 : 0)) * cell;
  const nextBoundZ = originZ + (y + (stepY > 0 ? 1 : 0)) * cell;
  let tMaxX = dx === 0 ? Infinity : (nextBoundX - ax) / dx;
  let tMaxZ = dz === 0 ? Infinity : (nextBoundZ - az) / dz;

  let guard = (w + h) * 2;
  while (guard-- > 0) {
    if (x === endX && y === endY) return true;
    if (tMaxX < tMaxZ) { x += stepX; tMaxX += tDeltaX; }
    else { y += stepY; tMaxZ += tDeltaZ; }
    if (!inBounds(w, h, x, y)) return false;
    if (grid[y * w + x] !== 1) return false;   // a wall blocks the ray
  }
  return false;
}

module.exports = { findPath, hasLineOfSight };
