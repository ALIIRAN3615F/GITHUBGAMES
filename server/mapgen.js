'use strict';

// Procedural generator for the facility: a braided maze of service corridors
// punched through with chambers, then dressed with props, lamps and objectives.
// The server generates it once per round and ships the result to every client,
// so all players walk an identical building.

const { makeRng } = require('./rng');

const CELL = 4;        // world units per grid cell
const WALL_H = 3.4;    // wall height in world units

const SIZES = { small: 23, medium: 31, large: 39 };

function idx(x, y, w) { return y * w + x; }

// Grid <-> world helpers. The map is centred on the origin.
function cellToWorld(cx, cy, w, h) {
  return {
    x: (cx - (w - 1) / 2) * CELL,
    z: (cy - (h - 1) / 2) * CELL,
  };
}
function worldToCell(x, z, w, h) {
  return {
    cx: Math.round(x / CELL + (w - 1) / 2),
    cy: Math.round(z / CELL + (h - 1) / 2),
  };
}

function generate(opts = {}) {
  const seed = (opts.seed ?? (Math.random() * 0xffffffff)) >>> 0;
  const rng = makeRng(seed);
  const size = SIZES[opts.size] || SIZES.medium;
  const w = size, h = size;
  const fuseCount = Math.max(3, Math.min(9, opts.fuseCount ?? 6));

  // 0 = solid rock, 1 = walkable floor.
  const grid = new Uint8Array(w * h);

  carveMaze(grid, w, h, rng);
  braid(grid, w, h, rng, 0.42);            // open dead ends so play is not a trap
  const rooms = carveRooms(grid, w, h, rng);
  const floors = collectFloors(grid, w, h);

  // --- Objective placement -------------------------------------------------
  // Spawn in one room, then use walking distance (not straight-line) to spread
  // the generator, the exit and the fuses as far apart as the layout allows.
  rng.shuffle(rooms);
  const spawnRoom = rooms[0];
  const spawnCell = { cx: spawnRoom.cx, cy: spawnRoom.cy };
  const distFromSpawn = bfsDistances(grid, w, h, spawnCell);

  const maxDist = floors.reduce((m, c) => Math.max(m, distFromSpawn[idx(c.cx, c.cy, w)] ?? 0), 1);

  // Generator: a mid-distance hub, so every fuse run is a round trip.
  const genRoom = pickRoom(rooms.slice(1), distFromSpawn, w, maxDist, 0.3, 0.65, rng) || rooms[1] || spawnRoom;
  // Exit: as far from the spawn as the facility goes.
  const exitRoom = pickRoom(rooms.filter((r) => r !== genRoom && r !== spawnRoom), distFromSpawn, w, maxDist, 0.7, 1.01, rng)
    || rooms[rooms.length - 1];

  const genCell = { cx: genRoom.cx, cy: genRoom.cy };
  const exitCell = { cx: exitRoom.cx, cy: exitRoom.cy };

  const fuseCells = placeFuses(floors, distFromSpawn, w, maxDist, fuseCount, [spawnCell, genCell, exitCell], rng);

  // --- Dressing ------------------------------------------------------------
  const props = placeProps(grid, w, h, rooms, rng, [spawnCell, genCell, exitCell]);
  const lamps = placeLamps(grid, w, h, rooms, rng);

  const spawnPoints = ringCells(grid, w, h, spawnCell, 8).map((c) => {
    const p = cellToWorld(c.cx, c.cy, w, h);
    return { x: p.x, z: p.z };
  });

  return {
    seed,
    w, h,
    cell: CELL,
    wallH: WALL_H,
    // Transported as a compact string of '0'/'1' rather than a 1000-entry array.
    grid: Array.from(grid).join(''),
    rooms: rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    spawn: worldPoint(spawnCell, w, h),
    spawnPoints,
    generator: worldPoint(genCell, w, h),
    exit: worldPoint(exitCell, w, h),
    fuses: fuseCells.map((c, i) => ({ id: i, ...worldPoint(c, w, h) })),
    props,
    lamps,
    fuseCount,
    // Circular footprints players must walk around. Derived here, not on the
    // client, so both ends collide against identical numbers.
    obstacles: buildObstacles(props, genCell, w, h),
  };
}

// Props with a footprint, plus the generator housing. The exit door is left
// passable on purpose - you walk into it to escape.
function buildObstacles(props, genCell, w, h) {
  const out = [];
  for (const p of props) {
    const base = PROP_RADIUS[p.t];
    if (!base) continue;
    out.push({ x: p.x, z: p.z, r: +(base * (p.s || 1)).toFixed(2) });
  }
  const gen = cellToWorld(genCell.cx, genCell.cy, w, h);
  // Generator body is 2.1 x 1.2; a 1.15 circle keeps players off it while
  // still letting them reach the fuse slots.
  out.push({ x: +gen.x.toFixed(2), z: +gen.z.toFixed(2), r: 1.15 });
  return out;
}

function worldPoint(cell, w, h) {
  const p = cellToWorld(cell.cx, cell.cy, w, h);
  return { x: p.x, z: p.z, cx: cell.cx, cy: cell.cy };
}

// --- Maze ------------------------------------------------------------------

// Recursive backtracker over odd-numbered cells: classic perfect maze, carved
// iteratively so a big map cannot blow the call stack.
function carveMaze(grid, w, h, rng) {
  const start = { x: 1, y: 1 };
  grid[idx(start.x, start.y, w)] = 1;
  const stack = [start];
  const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]];

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options = [];
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 && grid[idx(nx, ny, w)] === 0) {
        options.push({ nx, ny, dx, dy });
      }
    }
    if (!options.length) { stack.pop(); continue; }
    const pick = rng.pick(options);
    grid[idx(cur.x + pick.dx / 2, cur.y + pick.dy / 2, w)] = 1; // knock out the wall
    grid[idx(pick.nx, pick.ny, w)] = 1;
    stack.push({ x: pick.nx, y: pick.ny });
  }
}

// A perfect maze has exactly one route between any two points, which makes the
// monster unavoidable. Braiding punches loops so players can circle and escape.
function braid(grid, w, h, rng, amount) {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[idx(x, y, w)] !== 1) continue;
      const open = dirs.filter(([dx, dy]) => grid[idx(x + dx, y + dy, w)] === 1);
      if (open.length !== 1) continue;           // not a dead end
      if (!rng.chance(amount)) continue;
      const walls = dirs.filter(([dx, dy]) => {
        const nx = x + dx * 2, ny = y + dy * 2;
        return nx > 0 && ny > 0 && nx < w - 1 && ny < h - 1 &&
          grid[idx(x + dx, y + dy, w)] === 0 && grid[idx(nx, ny, w)] === 1;
      });
      if (!walls.length) continue;
      const [dx, dy] = rng.pick(walls);
      grid[idx(x + dx, y + dy, w)] = 1;
    }
  }
}

// Chambers: bigger open spaces that break up the corridor grind and give the
// objectives somewhere to live.
function carveRooms(grid, w, h, rng) {
  const rooms = [];
  const target = Math.round((w * h) / 90);
  let attempts = 0;
  while (rooms.length < target && attempts < 400) {
    attempts++;
    const rw = rng.int(2, 4) * 2 + 1;
    const rh = rng.int(2, 4) * 2 + 1;
    const x = rng.int(1, Math.max(1, w - rw - 2)) | 1;
    const y = rng.int(1, Math.max(1, h - rh - 2)) | 1;
    if (x + rw >= w - 1 || y + rh >= h - 1) continue;
    // Keep chambers from merging into one cavern.
    if (rooms.some((r) => x < r.x + r.w + 2 && x + rw + 2 > r.x && y < r.y + r.h + 2 && y + rh + 2 > r.y)) continue;
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) grid[idx(xx, yy, w)] = 1;
    }
    rooms.push({ x, y, w: rw, h: rh, cx: x + (rw >> 1), cy: y + (rh >> 1) });
  }
  return rooms;
}

function collectFloors(grid, w, h) {
  const out = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) if (grid[idx(x, y, w)] === 1) out.push({ cx: x, cy: y });
  }
  return out;
}

// --- Distances & placement -------------------------------------------------

function bfsDistances(grid, w, h, from) {
  const dist = new Int32Array(w * h).fill(-1);
  const q = [from];
  dist[idx(from.cx, from.cy, w)] = 0;
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let head = 0; head < q.length; head++) {
    const c = q[head];
    const d = dist[idx(c.cx, c.cy, w)];
    for (const [dx, dy] of dirs) {
      const nx = c.cx + dx, ny = c.cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = idx(nx, ny, w);
      if (grid[i] !== 1 || dist[i] !== -1) continue;
      dist[i] = d + 1;
      q.push({ cx: nx, cy: ny });
    }
  }
  return dist;
}

function pickRoom(rooms, dist, w, maxDist, lo, hi, rng) {
  const inBand = rooms.filter((r) => {
    const d = dist[idx(r.cx, r.cy, w)];
    return d >= 0 && d >= maxDist * lo && d < maxDist * hi;
  });
  if (inBand.length) return rng.pick(inBand);
  return null;
}

// Fuses are spread with a greedy furthest-point pass so no two ever sit in the
// same corner of the map: every one is its own expedition.
function placeFuses(floors, dist, w, maxDist, count, avoid, rng) {
  const candidates = floors.filter((c) => {
    const d = dist[idx(c.cx, c.cy, w)];
    if (d < maxDist * 0.28) return false;
    return !avoid.some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 5);
  });
  rng.shuffle(candidates);

  const chosen = [];
  let minSpacing = 9;
  while (chosen.length < count && minSpacing > 1) {
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.some((p) => Math.abs(p.cx - c.cx) + Math.abs(p.cy - c.cy) < minSpacing)) continue;
      chosen.push(c);
    }
    minSpacing -= 2; // relax if the layout is too tight to honour the spacing
  }
  while (chosen.length < count && candidates.length) chosen.push(rng.pick(candidates));
  return chosen.slice(0, count);
}

function ringCells(grid, w, h, center, max) {
  const out = [];
  for (let r = 0; r <= 3 && out.length < max; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = center.cx + dx, cy = center.cy + dy;
        if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) continue;
        if (grid[idx(cx, cy, w)] !== 1) continue;
        out.push({ cx, cy });
        if (out.length >= max) break;
      }
    }
  }
  return out.length ? out : [center];
}

// --- Dressing --------------------------------------------------------------

// Solid footprint radius per prop type. Anything absent from this table is
// decoration you can walk over (decals, corpses, wall vents, signs).
const PROP_RADIUS = {
  crate: 0.48, barrel: 0.38, locker: 0.44, shelf: 0.5,
  table: 0.6, chair: 0.3, gurney: 0.55, pipes: 0.18,
};

const WALL_PROPS = ['locker', 'shelf', 'pipes', 'vent', 'sign'];
const FLOOR_PROPS = ['crate', 'barrel', 'debris', 'table', 'chair', 'gurney'];

function placeProps(grid, w, h, rooms, rng, avoid) {
  const props = [];
  const occupied = new Set();
  const key = (x, y) => x + ',' + y;
  for (const a of avoid) occupied.add(key(a.cx, a.cy));

  const solid = (x, y) => x < 0 || y < 0 || x >= w || y >= h || grid[idx(x, y, w)] === 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[idx(x, y, w)] !== 1 || occupied.has(key(x, y))) continue;

      const neighbours = [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dy]) => solid(x + dx, y + dy));
      const openCount = 4 - neighbours.length;

      // Corridors get sparse clutter; junctions stay clear so players can run.
      if (neighbours.length && rng.chance(openCount <= 2 ? 0.14 : 0.07)) {
        const [dx, dy] = rng.pick(neighbours);
        const p = cellToWorld(x, y, w, h);
        const type = rng.chance(0.55) ? rng.pick(WALL_PROPS) : rng.pick(FLOOR_PROPS);
        props.push({
          t: type,
          x: +(p.x + dx * (CELL * 0.34) + rng.range(-0.3, 0.3)).toFixed(2),
          z: +(p.z + dy * (CELL * 0.34) + rng.range(-0.3, 0.3)).toFixed(2),
          r: +(Math.atan2(dx, dy) + rng.range(-0.12, 0.12)).toFixed(3),
          s: +rng.range(0.85, 1.15).toFixed(2),
        });
        occupied.add(key(x, y));
      } else if (rng.chance(0.03)) {
        const p = cellToWorld(x, y, w, h);
        props.push({
          t: rng.chance(0.5) ? 'blood' : 'debris',
          x: +(p.x + rng.range(-1, 1)).toFixed(2),
          z: +(p.z + rng.range(-1, 1)).toFixed(2),
          r: +rng.range(0, Math.PI * 2).toFixed(3),
          s: +rng.range(0.8, 1.4).toFixed(2),
        });
      }
    }
  }

  // A handful of set-dressing corpses, because someone was here before you.
  for (const room of rooms) {
    if (!rng.chance(0.4)) continue;
    const p = cellToWorld(room.cx + rng.int(-1, 1), room.cy + rng.int(-1, 1), w, h);
    props.push({ t: 'corpse', x: +p.x.toFixed(2), z: +p.z.toFixed(2), r: +rng.range(0, 6.28).toFixed(3), s: 1 });
  }
  return props;
}

// Ceiling lamps: dead until the generator runs, then they stutter to life.
function placeLamps(grid, w, h, rooms, rng) {
  const lamps = [];
  for (const room of rooms) {
    const p = cellToWorld(room.cx, room.cy, w, h);
    lamps.push({ x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
  }
  for (let y = 1; y < h - 1; y += 3) {
    for (let x = 1; x < w - 1; x += 3) {
      if (grid[idx(x, y, w)] !== 1) continue;
      if (!rng.chance(0.5)) continue;
      if (lamps.some((l) => Math.abs(l.x - (x - (w - 1) / 2) * CELL) < CELL * 2)) continue;
      const p = cellToWorld(x, y, w, h);
      lamps.push({ x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
    }
  }
  return lamps;
}

module.exports = { generate, cellToWorld, worldToCell, bfsDistances, CELL, WALL_H, SIZES, idx };
