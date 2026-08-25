'use strict';

// Procedural generator for the facility: a braided maze of service corridors
// punched through with chambers, then dressed with props, lamps and objectives.
// The server generates it once per round and ships the result to every client,
// so all players walk an identical building.

const { makeRng } = require('./rng');

const CELL = 4;        // world units per grid cell
const WALL_H = 3.4;    // wall height in world units

const SIZES = { small: 23, medium: 31, large: 39 };

// Grid cell values. Anything above 0 is open space of some kind; ROCK is the
// only thing that is unconditionally solid.
const ROCK = 0, FLOOR = 1, DOOR = 2, VESTIBULE = 3;

// How deep the sealed passage behind the emergency door runs, in cells.
const VESTIBULE_DEPTH = 3;

// Half-width of the walkable opening in the door cell. The cell is CELL wide,
// so this leaves a jamb either side that you cannot squeeze past.
const APERTURE_HALF = 1.6;

// How many spare flashlight batteries are hidden in the facility.
const BATTERY_COUNT = 24;

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
  const batteryCount = Math.max(0, Math.min(64, opts.batteryCount ?? BATTERY_COUNT));

  // 0 = solid rock, 1 = walkable floor.
  const grid = new Uint8Array(w * h);

  carveMaze(grid, w, h, rng);
  braid(grid, w, h, rng, 0.42);            // open dead ends so play is not a trap
  const rooms = carveRooms(grid, w, h, rng);

  // --- Objective placement -------------------------------------------------
  // Spawn in one room, then use walking distance (not straight-line) to spread
  // the generator, the exit and the fuses as far apart as the layout allows.
  rng.shuffle(rooms);
  const spawnRoom = rooms[0];
  const spawnCell = { cx: spawnRoom.cx, cy: spawnRoom.cy };

  const layoutDist = bfsDistances(grid, w, h, spawnCell);
  const layoutFloors = collectFloors(grid, w, h);
  const layoutMax = layoutFloors.reduce((m, c) => Math.max(m, layoutDist[idx(c.cx, c.cy, w)] ?? 0), 1);

  // Generator: a mid-distance hub, so every fuse run is a round trip.
  const genRoom = pickRoom(rooms.slice(1), layoutDist, w, layoutMax, 0.3, 0.65, rng) || rooms[1] || spawnRoom;
  // Exit: as far from the spawn as the facility goes.
  const exitRoom = pickRoom(rooms.filter((r) => r !== genRoom && r !== spawnRoom), layoutDist, w, layoutMax, 0.7, 1.01, rng)
    || rooms[rooms.length - 1];

  const genCell = { cx: genRoom.cx, cy: genRoom.cy };

  // The emergency door is bored through a wall rather than dropped into a room,
  // so it is always an opening in a real wall with a sealed dead end behind it.
  // See carveExitDoorway.
  const doorway = carveExitDoorway(
    grid, w, h,
    doorCandidates(grid, w, h, exitRoom, layoutDist, layoutMax, rng),
    rng,
    protectedCells(w, h, [spawnCell, genCell])
  );
  const exitCell = doorway.door;

  // Boring the passage can consume a cell or seal a flank, so everything that
  // gets placed is placed against the layout as it finally stands.
  const distFromSpawn = bfsDistances(grid, w, h, spawnCell);
  const floors = collectFloors(grid, w, h);
  const maxDist = floors.reduce((m, c) => Math.max(m, distFromSpawn[idx(c.cx, c.cy, w)] ?? 0), 1);

  const fuseCells = placeFuses(floors, distFromSpawn, w, maxDist, fuseCount, [spawnCell, genCell, exitCell], rng);
  const batteryCells = placeBatteries(floors, batteryCount, [spawnCell, genCell, exitCell, ...fuseCells], rng);
  // A single fuel can, deliberately far from the entrance: the second ending
  // should be something you stumble on while exploring, not trip over.
  const gasCell = placeGasoline(floors, distFromSpawn, w, maxDist,
    [spawnCell, genCell, exitCell, ...fuseCells, ...batteryCells], rng);
  // One rifle, somewhere in the middle distance. It is the only thing in the
  // facility that can hurt what lives there, and there is only ever one.
  const weaponCell = placeWeapon(floors, distFromSpawn, w, maxDist,
    [spawnCell, genCell, exitCell, ...fuseCells, ...batteryCells, gasCell].filter(Boolean), rng);

  // --- Dressing ------------------------------------------------------------
  const props = placeProps(grid, w, h, rooms, rng, [spawnCell, genCell, exitCell, doorway.approach]);
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
    // Everything the door needs to be built and collided against identically
    // on both ends: which cell it fills, which way it faces, how wide the
    // opening is, where its control panel hangs, and where the passage behind
    // it gives out into the Backrooms.
    door: doorSpec(doorway, w, h),
    fuses: fuseCells.map((c, i) => ({ id: i, ...worldPoint(c, w, h) })),
    batteries: batteryCells.map((c, i) => ({ id: i, ...worldPoint(c, w, h) })),
    gasoline: gasCell ? worldPoint(gasCell, w, h) : null,
    weapon: weaponCell ? worldPoint(weaponCell, w, h) : null,
    props,
    lamps,
    fuseCount,
    batteryCount: batteryCells.length,
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

// --- The emergency doorway ---------------------------------------------------

// A door has to be an opening in a wall, not a slab standing in a room. Rather
// than hoping the maze happens to produce one, we bore it: pick a floor cell,
// drill a short dead-end passage straight out from it, and wall in everything
// the passage touches. The result is a door with solid rock on both flanks, a
// sealed space behind, and no way around the sides - the passage exists only
// because the door is there.
//
// Walling the flanks in can cut the maze in two, so every bore is applied
// provisionally and rolled back unless the facility is still fully connected.
function carveExitDoorway(grid, w, h, candidates, rng, protect) {
  for (const depth of [VESTIBULE_DEPTH, 2, 1]) {
    for (const from of candidates) {
      const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      rng.shuffle(dirs);
      for (const [dx, dy] of dirs) {
        const plan = planBore(grid, w, h, from, dx, dy, depth, protect);
        if (!plan) continue;
        const undo = applyBore(grid, w, h, plan);
        if (stillConnected(grid, w, h, from)) {
          return describeDoorway(grid, w, h, from, dx, dy, plan.bore);
        }
        for (const [i, v] of undo) grid[i] = v;
      }
    }
  }
  throw new Error('mapgen: nowhere to put the emergency door');
}

// Works out which cells the passage occupies and which have to be walled in
// around it, without touching anything yet.
function planBore(grid, w, h, from, dx, dy, depth, protect) {
  const px = dy, py = -dx;                 // perpendicular to the bore
  const bore = [];
  const seal = [];

  // Cells that must end up solid. The outer shell of the map is off limits, as
  // is anything protected (the spawn and the generator and their surrounds).
  const wallIn = (cx, cy) => {
    if (cx < 1 || cy < 1 || cx >= w - 1 || cy >= h - 1) return false;
    if (protect.has(cx + ',' + cy)) return false;
    if (grid[idx(cx, cy, w)] !== ROCK) seal.push({ cx, cy });
    return true;
  };

  for (let step = 1; step <= depth + 1; step++) {
    const cx = from.cx + dx * step, cy = from.cy + dy * step;
    // Two cells of margin keeps the facility's outer shell intact.
    if (cx < 2 || cy < 2 || cx >= w - 2 || cy >= h - 2) return null;
    if (protect.has(cx + ',' + cy)) return null;
    bore.push({ cx, cy });
  }

  // A dead end, not a through route.
  if (!wallIn(from.cx + dx * (depth + 2), from.cy + dy * (depth + 2))) return null;
  for (const c of bore) {
    if (!wallIn(c.cx + px, c.cy + py)) return null;
    if (!wallIn(c.cx - px, c.cy - py)) return null;
  }
  // ...including its corners, so nothing can be seen or squeezed past the end.
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
  for (let i = 1; i < plan.bore.length; i++) set(plan.bore[i].cx, plan.bore[i].cy, VESTIBULE);
  return undo;
}

// Every walkable cell still reachable on foot from the door's approach. The
// passage itself is deliberately not counted: it is meant to be sealed off.
function stillConnected(grid, w, h, from) {
  let total = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === FLOOR) total++;

  const seen = new Uint8Array(w * h);
  const q = [from];
  seen[idx(from.cx, from.cy, w)] = 1;
  let reached = 1;
  for (let k = 0; k < q.length; k++) {
    const c = q[k];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const cx = c.cx + dx, cy = c.cy + dy;
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const i = idx(cx, cy, w);
      if (seen[i] || grid[i] !== FLOOR) continue;
      seen[i] = 1;
      reached++;
      q.push({ cx, cy });
    }
  }
  return reached === total;
}

function describeDoorway(grid, w, h, from, dx, dy, bore) {
  // The control panel hangs on the wall beside the door, on a side a player can
  // actually stand next to.
  const px = dy, py = -dx;
  const standable = [1, -1].filter((s) => {
    const cx = from.cx + px * s, cy = from.cy + py * s;
    return cx >= 0 && cy >= 0 && cx < w && cy < h && grid[idx(cx, cy, w)] === FLOOR;
  });
  const side = standable.length ? standable[0] : 1;

  return {
    approach: from,
    door: bore[0],
    vestibule: bore.slice(1),
    dir: { dx, dy },
    panelCell: { cx: bore[0].cx + px * side, cy: bore[0].cy + py * side },
  };
}

// Cells no bore may consume or wall in: the spawn, the generator, and the ring
// around each so their interaction radius stays walkable.
function protectedCells(w, h, cells) {
  const out = new Set();
  for (const c of cells) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) out.add((c.cx + dx) + ',' + (c.cy + dy));
    }
  }
  return out;
}

// Candidate cells for the door, best first: the room the exit was assigned to,
// then anywhere in the far half of the facility, then anywhere at all.
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

// Flattened for the wire: both ends build and collide the door from this.
function doorSpec(d, w, h) {
  const at = cellToWorld(d.door.cx, d.door.cy, w, h);
  const approach = cellToWorld(d.approach.cx, d.approach.cy, w, h);
  const last = d.vestibule[d.vestibule.length - 1];
  const end = cellToWorld(last.cx, last.cy, w, h);
  const flank = cellToWorld(d.panelCell.cx, d.panelCell.cy, w, h);

  return {
    cx: d.door.cx, cy: d.door.cy,
    x: +at.x.toFixed(2), z: +at.z.toFixed(2),
    // Outward normal, pointing from the facility into the passage. Grid dx/dy
    // map straight onto world x/z, so this is both at once.
    nx: d.dir.dx, nz: d.dir.dy,
    // Half-width of the opening, and the axis it spans.
    half: APERTURE_HALF,
    height: WALL_H - 0.4,
    approach: { x: +approach.x.toFixed(2), z: +approach.z.toFixed(2) },
    // Where the passage gives out. Crossing this is the way into the Backrooms.
    threshold: { x: +end.x.toFixed(2), z: +end.z.toFixed(2) },
    vestibule: d.vestibule.map((c) => ({ cx: c.cx, cy: c.cy })),
    // The control panel, set into the wall beside the door and facing back
    // into the facility.
    panel: {
      x: +(flank.x - d.dir.dx * (CELL / 2 - 0.08)).toFixed(2),
      z: +(flank.z - d.dir.dy * (CELL / 2 - 0.08)).toFixed(2),
      y: 1.36,
      yaw: +Math.atan2(-d.dir.dx, -d.dir.dy).toFixed(3),
    },
  };
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

// Batteries are the flashlight's ammunition, so they are spread far more
// liberally than fuses: no distance requirement from the spawn, just enough
// mutual spacing that they never cluster into one lucky pile.
// The fuel can goes in the far half of the facility, well clear of anything
// else worth walking to.
function placeGasoline(floors, dist, w, maxDist, avoid, rng) {
  const candidates = floors.filter((c) => {
    const d = dist[idx(c.cx, c.cy, w)];
    if (d < maxDist * 0.5) return false;
    return !avoid.some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 4);
  });
  if (!candidates.length) return null;
  return rng.pick(candidates);
}

// The rifle sits at a middle distance: far enough that going for it is a
// decision, near enough that it is not the last thing you ever find.
function placeWeapon(floors, dist, w, maxDist, avoid, rng) {
  for (const [lo, hi] of [[0.3, 0.7], [0.2, 0.85], [0, 1.01]]) {
    const candidates = floors.filter((c) => {
      const d = dist[idx(c.cx, c.cy, w)];
      if (d < 0 || d < maxDist * lo || d > maxDist * hi) return false;
      return !avoid.some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 4);
    });
    if (candidates.length) return rng.pick(candidates);
  }
  return null;
}

function placeBatteries(floors, count, avoid, rng) {
  const candidates = floors.filter((c) =>
    !avoid.some((a) => Math.abs(a.cx - c.cx) + Math.abs(a.cy - c.cy) < 2));
  rng.shuffle(candidates);

  const chosen = [];
  let spacing = 5;
  while (chosen.length < count && spacing >= 0) {
    for (const c of candidates) {
      if (chosen.length >= count) break;
      if (chosen.some((p) => Math.abs(p.cx - c.cx) + Math.abs(p.cy - c.cy) < spacing)) continue;
      if (chosen.some((p) => p.cx === c.cx && p.cy === c.cy)) continue;
      chosen.push(c);
    }
    spacing -= 1;   // relax until the map can hold them all
  }
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

module.exports = {
  generate, BATTERY_COUNT, cellToWorld, worldToCell, bfsDistances,
  CELL, WALL_H, SIZES, idx, ROCK, FLOOR, DOOR, VESTIBULE, APERTURE_HALF,
};
