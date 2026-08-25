'use strict';

// The facility, from above.
//
// A braided maze with rooms carved into it, then the objectives spread across
// it by walking distance rather than straight-line distance, so a fuse that
// looks close on the minimap can still be a long way round.
//
// Cell values: 0 rock, 1 floor, 2 the exit door, 3 the alcove behind it.

const { makeRng } = require('./rng');
const { bfsDistances, findPath } = require('./pathfind');

const ROCK = 0, FLOOR = 1, DOOR = 2, ALCOVE = 3;

const SIZES = { small: 31, medium: 41, large: 51 };
const BATTERY_COUNT = 24;

// How deep the sealed alcove behind the exit door runs.
const ALCOVE_DEPTH = 2;

const idx = (x, y, w) => y * w + x;

function generate(opts = {}) {
  const seed = (opts.seed ?? (Math.random() * 0xffffffff)) >>> 0;
  const rng = makeRng(seed);
  const size = SIZES[opts.size] || SIZES.medium;
  const w = size, h = size;
  const fuseCount = Math.max(3, Math.min(9, opts.fuseCount ?? 5));
  const batteryCount = Math.max(0, Math.min(64, opts.batteryCount ?? BATTERY_COUNT));

  const grid = new Uint8Array(w * h);
  carveMaze(grid, w, h, rng);
  braid(grid, w, h, rng, 0.45);
  const rooms = carveRooms(grid, w, h, rng);

  const open = (x, y) => grid[idx(x, y, w)] !== ROCK;
  const isFloor = (x, y) => grid[idx(x, y, w)] === FLOOR;

  rng.shuffle(rooms);
  const spawnRoom = rooms[0];
  const spawn = { cx: spawnRoom.cx, cy: spawnRoom.cy };

  let dist = bfsDistances(isFloor, w, h, spawn);
  let floors = collectFloors(grid, w, h);
  let maxDist = floors.reduce((m, c) => Math.max(m, dist[idx(c.cx, c.cy, w)]), 1);

  // The generator sits mid-distance, so every fuse run is a round trip.
  const genRoom = pickRoom(rooms.slice(1), dist, w, maxDist, 0.3, 0.65, rng) || rooms[1] || spawnRoom;
  const generator = { cx: genRoom.cx, cy: genRoom.cy };
  // The exit is as far from the entrance as the layout goes.
  const exitRoom = pickRoom(rooms.filter((r) => r !== genRoom && r !== spawnRoom), dist, w, maxDist, 0.7, 1.01, rng)
    || rooms[rooms.length - 1];

  const door = carveExitDoor(grid, w, h, doorCandidates(grid, w, h, exitRoom, dist, maxDist, rng), rng,
    protectedCells([spawn, generator]));

  // Boring the alcove can eat a cell, so everything is placed against the
  // layout as it finally stands.
  dist = bfsDistances(isFloor, w, h, spawn);
  floors = collectFloors(grid, w, h);
  maxDist = floors.reduce((m, c) => Math.max(m, dist[idx(c.cx, c.cy, w)]), 1);

  const taken = [spawn, generator, door.approach];
  const fuses = placeFuses(floors, dist, w, maxDist, fuseCount, taken, rng);
  const batteries = placeBatteries(floors, batteryCount, [...taken, ...fuses], rng);
  const props = placeProps(grid, w, h, rooms, rng, [...taken, ...fuses]);
  const lamps = placeLamps(grid, w, h, rooms, rng);

  return {
    seed, w, h,
    grid: Array.from(grid).join(''),
    rooms: rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    spawn: { ...spawn, ...centre(spawn) },
    spawnPoints: ringCells(grid, w, h, spawn, 8).map(centre),
    generator: { ...generator, ...centre(generator) },
    door: doorSpec(door, w),
    fuses: fuses.map((c, i) => ({ id: i, ...centre(c) })),
    batteries: batteries.map((c, i) => ({ id: i, ...centre(c) })),
    props,
    lamps,
    fuseCount: fuses.length,
    batteryCount: batteries.length,
  };
}

// Cells are one unit across, so the middle of one is half a unit in from its
// corner. Everything in the game speaks these coordinates.
function centre(cell) {
  return { x: cell.cx + 0.5, y: cell.cy + 0.5 };
}

function collectFloors(grid, w, h) {
  const out = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) if (grid[idx(x, y, w)] === FLOOR) out.push({ cx: x, cy: y });
  }
  return out;
}

// --- The maze ----------------------------------------------------------------

// Recursive backtracker on the odd cells, which leaves a perfect maze: exactly
// one route between any two points, and far too many dead ends to play in.
function carveMaze(grid, w, h, rng) {
  const startX = 1, startY = 1;
  grid[idx(startX, startY, w)] = FLOOR;
  const stack = [{ x: startX, y: startY }];

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options = [];
    for (const [dx, dy] of [[0, -2], [2, 0], [0, 2], [-2, 0]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx <= 0 || ny <= 0 || nx >= w - 1 || ny >= h - 1) continue;
      if (grid[idx(nx, ny, w)] === FLOOR) continue;
      options.push({ x: nx, y: ny, dx, dy });
    }
    if (!options.length) { stack.pop(); continue; }
    const pick = rng.pick(options);
    grid[idx(cur.x + pick.dx / 2, cur.y + pick.dy / 2, w)] = FLOOR;
    grid[idx(pick.x, pick.y, w)] = FLOOR;
    stack.push({ x: pick.x, y: pick.y });
  }
}

// Open a share of the dead ends back up. A perfect maze is a series of traps;
// braiding it gives loops to run in, which is what makes being chased playable.
function braid(grid, w, h, rng, chance) {
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[idx(x, y, w)] !== FLOOR) continue;
      const walls = [];
      let exits = 0;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (nx <= 0 || ny <= 0 || nx >= w - 1 || ny >= h - 1) continue;
        if (grid[idx(nx, ny, w)] === FLOOR) exits++;
        else walls.push({ nx, ny });
      }
      if (exits > 1 || !walls.length) continue;
      if (!rng.chance(chance)) continue;
      const pick = rng.pick(walls);
      grid[idx(pick.nx, pick.ny, w)] = FLOOR;
    }
  }
}

// Rooms give the maze somewhere to breathe, and somewhere for a light to pool.
function carveRooms(grid, w, h, rng) {
  const rooms = [];
  const attempts = Math.floor((w * h) / 42);
  for (let i = 0; i < attempts; i++) {
    const rw = rng.int(2, 5) * 2 + 1;
    const rh = rng.int(2, 5) * 2 + 1;
    const x = (rng.int(1, Math.max(1, (w - rw - 2) >> 1)) * 2) - 1;
    const y = (rng.int(1, Math.max(1, (h - rh - 2) >> 1)) * 2) - 1;
    if (x < 1 || y < 1 || x + rw >= w - 1 || y + rh >= h - 1) continue;
    if (rooms.some((r) => x < r.x + r.w + 2 && x + rw + 2 > r.x && y < r.y + r.h + 2 && y + rh + 2 > r.y)) continue;

    for (let cy = y; cy < y + rh; cy++) {
      for (let cx = x; cx < x + rw; cx++) grid[idx(cx, cy, w)] = FLOOR;
    }
    rooms.push({ x, y, w: rw, h: rh, cx: x + (rw >> 1), cy: y + (rh >> 1) });
  }
  if (!rooms.length) rooms.push({ x: 1, y: 1, w: 3, h: 3, cx: 2, cy: 2 });
  return rooms;
}

// --- The exit door -------------------------------------------------------------

// The door is bored rather than placed: a floor cell is picked, a short dead-end
// alcove is drilled straight out of it, and everything the alcove touches is
// walled in. That makes the door an opening in a real wall with solid rock on
// both flanks and nothing reachable behind it - by construction, not by luck.
// Walling those flanks in can cut the maze in two, so each attempt is applied
// provisionally and rolled back unless the facility is still fully connected.
function carveExitDoor(grid, w, h, candidates, rng, protect) {
  for (const depth of [ALCOVE_DEPTH, 1]) {
    for (const from of candidates) {
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      rng.shuffle(dirs);
      for (const [dx, dy] of dirs) {
        const plan = planBore(grid, w, h, from, dx, dy, depth, protect);
        if (!plan) continue;
        const undo = applyBore(grid, w, h, plan);
        if (stillConnected(grid, w, h, from)) {
          return { approach: from, door: plan.bore[0], alcove: plan.bore.slice(1), dir: { dx, dy } };
        }
        for (const [i, v] of undo) grid[i] = v;
      }
    }
  }
  throw new Error('mapgen: nowhere to put the exit door');
}

function planBore(grid, w, h, from, dx, dy, depth, protect) {
  const px = dy, py = -dx;
  const bore = [];
  const seal = [];

  const wallIn = (cx, cy) => {
    if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) return false;
    if (protect.has(cx + ',' + cy)) return false;
    if (grid[idx(cx, cy, w)] !== ROCK) seal.push({ cx, cy });
    return true;
  };

  for (let step = 1; step <= depth + 1; step++) {
    const cx = from.cx + dx * step, cy = from.cy + dy * step;
    if (cx < 2 || cy < 2 || cx >= w - 2 || cy >= h - 2) return null;
    if (protect.has(cx + ',' + cy)) return null;
    bore.push({ cx, cy });
  }
  if (!wallIn(from.cx + dx * (depth + 2), from.cy + dy * (depth + 2))) return null;
  for (const c of bore) {
    if (!wallIn(c.cx + px, c.cy + py)) return null;
    if (!wallIn(c.cx - px, c.cy - py)) return null;
  }
  const last = bore[bore.length - 1];
  if (!wallIn(last.cx + dx + px, last.cy + dy + py)) return null;
  if (!wallIn(last.cx + dx - px, last.cy + dy - py)) return null;
  return { bore, seal };
}

function applyBore(grid, w, h, plan) {
  const undo = [];
  const set = (cx, cy, v) => {
    const i = idx(cx, cy, w);
    undo.push([i, grid[i]]);
    grid[i] = v;
  };
  for (const c of plan.seal) set(c.cx, c.cy, ROCK);
  set(plan.bore[0].cx, plan.bore[0].cy, DOOR);
  for (let i = 1; i < plan.bore.length; i++) set(plan.bore[i].cx, plan.bore[i].cy, ALCOVE);
  return undo;
}

function stillConnected(grid, w, h, from) {
  let total = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR) total++;

  const seen = new Uint8Array(w * h);
  const queue = [from];
  seen[idx(from.cx, from.cy, w)] = 1;
  let reached = 1;
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const cx = c.cx + dx, cy = c.cy + dy;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const i = idx(cx, cy, w);
      if (seen[i] || grid[i] !== FLOOR) continue;
      seen[i] = 1;
      reached++;
      queue.push({ cx, cy });
    }
  }
  return reached === total;
}

function protectedCells(cells) {
  const out = new Set();
  for (const c of cells) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) out.add((c.cx + dx) + ',' + (c.cy + dy));
    }
  }
  return out;
}

function doorCandidates(grid, w, h, exitRoom, dist, maxDist, rng) {
  const out = [];
  const seen = new Set();
  const push = (cx, cy) => {
    const key = cx + ',' + cy;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cx, cy });
  };

  if (exitRoom) {
    const room = [];
    for (let y = exitRoom.y; y < exitRoom.y + exitRoom.h; y++) {
      for (let x = exitRoom.x; x < exitRoom.x + exitRoom.w; x++) {
        if (grid[idx(x, y, w)] === FLOOR) room.push({ cx: x, cy: y });
      }
    }
    rng.shuffle(room);
    for (const c of room) push(c.cx, c.cy);
  }

  const far = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[idx(x, y, w)] !== FLOOR) continue;
      const d = dist[idx(x, y, w)];
      if (d >= 0) far.push({ cx: x, cy: y, d });
    }
  }
  far.sort((a, b) => b.d - a.d);
  for (const c of far) if (c.d >= maxDist * 0.45) push(c.cx, c.cy);
  for (const c of far) push(c.cx, c.cy);
  return out;
}

// Everything both ends need to build the door and agree on where it is.
function doorSpec(d, w) {
  const last = d.alcove[d.alcove.length - 1];
  const px = d.dir.dy, py = -d.dir.dx;
  // The panel hangs on the wall beside the door, on the side of the approach.
  const panelCell = { cx: d.door.cx + px, cy: d.door.cy + py };
  void w;
  return {
    cx: d.door.cx, cy: d.door.cy,
    ...centre(d.door),
    nx: d.dir.dx, ny: d.dir.dy,
    approach: { cx: d.approach.cx, cy: d.approach.cy, ...centre(d.approach) },
    alcove: d.alcove.map((c) => ({ cx: c.cx, cy: c.cy })),
    threshold: centre(last),
    panel: {
      cx: panelCell.cx, cy: panelCell.cy,
      // Pull it onto the face of that wall, facing back into the facility.
      x: +(panelCell.cx + 0.5 - d.dir.dx * 0.5).toFixed(3),
      y: +(panelCell.cy + 0.5 - d.dir.dy * 0.5).toFixed(3),
    },
  };
}

// --- Placement -----------------------------------------------------------------

function pickRoom(rooms, dist, w, maxDist, lo, hi, rng) {
  const scored = rooms.filter((r) => {
    const d = dist[idx(r.cx, r.cy, w)];
    return d >= 0 && d >= maxDist * lo && d <= maxDist * hi;
  });
  return scored.length ? rng.pick(scored) : null;
}

// Fuses spread across the distance bands, so the run is never all in one
// direction and never all at the far end.
function placeFuses(floors, dist, w, maxDist, count, avoid, rng) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const lo = 0.25 + (i / count) * 0.6;
    const hi = Math.min(1.01, lo + 0.4);
    const pool = floors.filter((c) => {
      const d = dist[idx(c.cx, c.cy, w)];
      if (d < 0 || d < maxDist * lo || d > maxDist * hi) return false;
      return ![...avoid, ...out].some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 5);
    });
    const fallback = floors.filter((c) =>
      ![...avoid, ...out].some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 4));
    const pick = pool.length ? rng.pick(pool) : (fallback.length ? rng.pick(fallback) : null);
    if (pick) out.push(pick);
  }
  return out;
}

function placeBatteries(floors, count, avoid, rng) {
  const out = [];
  const pool = floors.filter((c) =>
    !avoid.some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 3));
  rng.shuffle(pool);
  for (const cell of pool) {
    if (out.length >= count) break;
    if (out.some((o) => Math.abs(o.cx - cell.cx) + Math.abs(o.cy - cell.cy) < 3)) continue;
    out.push(cell);
  }
  return out;
}

// Crates, barrels, desks and bloodstains. Solid ones become collision; the
// stains are only there to be found.
const PROP_KINDS = [
  { t: 'crate', r: 0.34, solid: true },
  { t: 'barrel', r: 0.30, solid: true },
  { t: 'locker', r: 0.34, solid: true },
  { t: 'desk', r: 0.40, solid: true },
  { t: 'pipe', r: 0.22, solid: true },
  { t: 'stain', r: 0, solid: false },
  { t: 'debris', r: 0, solid: false },
];

function placeProps(grid, w, h, rooms, rng, avoid) {
  const props = [];
  const blocked = new Set(avoid.map((a) => a.cx + ',' + a.cy));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[idx(x, y, w)] !== FLOOR) continue;
      if (blocked.has(x + ',' + y)) continue;
      if (!rng.chance(0.11)) continue;
      const kind = rng.pick(PROP_KINDS);
      props.push({
        t: kind.t,
        x: +(x + rng.range(0.25, 0.75)).toFixed(2),
        y: +(y + rng.range(0.25, 0.75)).toFixed(2),
        r: +rng.range(0, Math.PI * 2).toFixed(2),
        s: +rng.range(0.85, 1.2).toFixed(2),
      });
    }
  }
  void rooms;
  return props;
}

// Ceiling lamps, which do nothing at all until the generator is running.
function placeLamps(grid, w, h, rooms, rng) {
  const lamps = [];
  for (const room of rooms) {
    const count = Math.max(1, Math.floor((room.w * room.h) / 20));
    for (let i = 0; i < count; i++) {
      const cx = room.x + rng.int(1, Math.max(1, room.w - 2));
      const cy = room.y + rng.int(1, Math.max(1, room.h - 2));
      if (grid[idx(cx, cy, w)] !== FLOOR) continue;
      lamps.push({ x: cx + 0.5, y: cy + 0.5, f: +rng.range(0, 6.28).toFixed(2) });
    }
  }
  // A scatter down the corridors too, so the lit facility is lit everywhere.
  for (let y = 2; y < h - 2; y += 3) {
    for (let x = 2; x < w - 2; x += 3) {
      if (grid[idx(x, y, w)] !== FLOOR) continue;
      if (!rng.chance(0.35)) continue;
      lamps.push({ x: x + 0.5, y: y + 0.5, f: +rng.range(0, 6.28).toFixed(2) });
    }
  }
  return lamps;
}

// Walkable cells near a point, for spreading a team's spawn out.
function ringCells(grid, w, h, centreCell, count) {
  const out = [];
  for (let r = 0; r < 6 && out.length < count; r++) {
    for (let dy = -r; dy <= r && out.length < count; dy++) {
      for (let dx = -r; dx <= r && out.length < count; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = centreCell.cx + dx, cy = centreCell.cy + dy;
        if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) continue;
        if (grid[idx(cx, cy, w)] !== FLOOR) continue;
        out.push({ cx, cy });
      }
    }
  }
  return out.length ? out : [centreCell];
}

module.exports = {
  generate, idx, ROCK, FLOOR, DOOR, ALCOVE, SIZES, BATTERY_COUNT,
  findPath, bfsDistances,
};
