'use strict';

// Grid navigation, in tile space. The 2D facility puts the origin at the
// top-left corner and makes every cell exactly one unit across, so a world
// position and a cell index are the same number with the fraction knocked off.
// That keeps every routine in here free of the centring arithmetic a 3D level
// needs, and it is the reason the renderer and the server never disagree about
// where a wall is.

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// Breadth-first search from `start` to `goal`, over cells the caller says are
// walkable. Returns the cell path including the goal, or null if unreachable.
function findPath(walkable, w, h, start, goal) {
  if (!inBounds(w, h, goal.cx, goal.cy) || !walkable(goal.cx, goal.cy)) return null;
  if (start.cx === goal.cx && start.cy === goal.cy) return [];

  const prev = new Int32Array(w * h).fill(-1);
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;

  const startIdx = start.cy * w + start.cx;
  seen[startIdx] = 1;
  queue[tail++] = startIdx;

  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx === goal.cx && cy === goal.cy) return unwind(prev, cur, w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(w, h, nx, ny)) continue;
      const ni = ny * w + nx;
      if (seen[ni] || !walkable(nx, ny)) continue;
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
  path.pop();               // drop the start cell - we are standing on it
  return path.reverse();
}

// Walking distance from one cell to every other, or -1 where unreachable.
function bfsDistances(walkable, w, h, start) {
  const dist = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;

  const startIdx = start.cy * w + start.cx;
  dist[startIdx] = 0;
  queue[tail++] = startIdx;

  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w, cy = (cur / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inBounds(w, h, nx, ny)) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== -1 || !walkable(nx, ny)) continue;
      dist[ni] = dist[cur] + 1;
      queue[tail++] = ni;
    }
  }
  return dist;
}

function inBounds(w, h, x, y) {
  return x >= 0 && y >= 0 && x < w && y < h;
}

// Amanatides & Woo grid march between two points in tile space. Used for "can
// it see you" and for deciding how much of a sound came through a wall.
function hasLineOfSight(opaque, w, h, ax, ay, bx, by) {
  let x = Math.floor(ax), y = Math.floor(ay);
  const endX = Math.floor(bx), endY = Math.floor(by);
  if (!inBounds(w, h, x, y) || !inBounds(w, h, endX, endY)) return false;

  const dx = bx - ax, dy = by - ay;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);

  let tMaxX = dx === 0 ? Infinity : ((x + (stepX > 0 ? 1 : 0)) - ax) / dx;
  let tMaxY = dy === 0 ? Infinity : ((y + (stepY > 0 ? 1 : 0)) - ay) / dy;

  let guard = (w + h) * 2;
  while (guard-- > 0) {
    if (x === endX && y === endY) return true;
    if (tMaxX < tMaxY) { x += stepX; tMaxX += tDeltaX; }
    else { y += stepY; tMaxY += tDeltaY; }
    if (!inBounds(w, h, x, y)) return false;
    if (opaque(x, y)) return false;
  }
  return false;
}

module.exports = { findPath, bfsDistances, hasLineOfSight };
