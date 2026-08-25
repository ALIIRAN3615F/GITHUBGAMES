'use strict';

// Authoritative session state for DEAD AIR.
//
// The split is the same one that works over a LAN: clients own their own
// movement and tell the server where they ended up, and the server clamps that
// against the same constants and refuses anything inside geometry. Everything
// that can be cheated or has to agree across machines - the monster, the fuses,
// the generator, the door, who is down - is decided here and broadcast.
//
// Wire protocol
//   C -> S  join {name} | input {p,a,f} | use {k,id} | chat {m} | cfg {...}
//           ready {} | start {} | ping {c}
//   S -> C  hello | lobby | begin {map} | snap | ev | chat | end | pong

const F_MOVING = 1, F_SPRINT = 2, F_CROUCH = 4, F_LIGHT = 8, F_BUSY = 16;
const CLIENT_FLAGS = F_MOVING | F_SPRINT | F_CROUCH | F_LIGHT | F_BUSY;

const { generate, idx, FLOOR, DOOR, ALCOVE, findPath, bfsDistances } = require('./mapgen');
const { hasLineOfSight } = require('./pathfind');
const { makeRng } = require('./rng');

const TICK_HZ = 30;
const SNAP_EVERY = 2;                  // snapshots at 15 Hz
const MAX_PLAYERS = 8;

// Everything below is in tiles and tiles per second. A tile is about a metre
// and a half of facility, which is what makes 3.4 a walk and 5.9 a sprint.
const SPEED = { walk: 3.4, sprint: 5.9, crouch: 1.75 };
const PLAYER_RADIUS = 0.30;
const MONSTER_RADIUS = 0.34;

// Light is a consumable that only ever goes down. Batteries are its ammunition.
const FLASHLIGHT_DRAIN = 1.0;          // percent per second while lit
const MAX_RESERVE = 24;

// Perception. `grace` is the exploration phase: long enough to learn the
// layout and find the generator before anything is hunting you.
const WAKE_DURATION = 7;
const STAND_EXPOSURE = 0.3;            // seconds held in view before it commits
const CROUCH_EXPOSURE = 1.6;           // a crouching player has to be stared at
const LOSE_GRACE = 2.5;                // how long a chase survives on memory
const SEARCH_TIME = 14;

// The exit door: a shutter on a motor, and once it is up it stays up.
const DOOR_OPEN_TIME = 4.5;
const DOOR_SHUT = 0, DOOR_OPENING = 1, DOOR_OPEN = 2;

// Chase speed sits between a walk and a sprint, always. Faster than 3.4 means
// strolling away does not work; slower than 5.9 means sprinting does, at the
// cost of every stamina point and all the noise in the world.
const DIFFICULTY = {
  calm:      { patrol: 1.5, chase: 3.75, hearing: 12, sight: 12, grace: 180, bleed: 60, monsters: 1, label: 'Calm' },
  normal:    { patrol: 1.8, chase: 4.25, hearing: 16, sight: 15, grace: 130, bleed: 45, monsters: 1, label: 'Normal' },
  nightmare: { patrol: 2.2, chase: 4.75, hearing: 21, sight: 18, grace: 85,  bleed: 30, monsters: 2, label: 'Nightmare' },
};

const PLAYER_COLORS = [
  0x6fd3ff, 0xffb347, 0x9be36b, 0xff7b7b,
  0xc79bff, 0xffe066, 0x66e8c8, 0xff8fd0,
];

const ST_ALIVE = 0, ST_DOWN = 1, ST_DEAD = 2, ST_ESCAPED = 3;

const MONSTER_STATE_CODE = {
  sleeping: 0, patrol: 1, idle: 2, search: 3, chase: 4, retreat: 5, waking: 6, attack: 7,
};

let nextPlayerId = 1;

class Session {
  // A seed makes a session reproducible, which is what lets the monster tests
  // assert on behaviour rather than on luck.
  constructor(opts = {}) {
    this.players = new Map();
    this.phase = 'lobby';              // lobby | playing | ended
    this.hostId = null;
    this.cfg = { size: 'medium', fuses: 5, difficulty: 'normal' };
    this.map = null;
    this.grid = null;
    this.monsters = [];
    this.fuses = [];
    this.batteries = [];
    this.powered = 0;
    this.generatorOn = false;
    this.door = { phase: DOOR_SHUT, timer: 0 };
    this.tick = 0;
    this.roundTime = 0;
    this.endsAt = 0;
    this.outcome = null;
    this.rng = makeRng(opts.seed !== undefined ? opts.seed : ((Date.now() ^ 0x5f3a) >>> 0));
    this.ambientTimer = 8;
  }

  // --- Connections -----------------------------------------------------------

  addPlayer(conn, rawName) {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send({ t: 'full' });
      conn.close(1000, 'server full');
      return null;
    }
    const id = nextPlayerId++;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[id % PLAYER_COLORS.length];

    const player = {
      id, conn,
      name: sanitiseName(rawName, id),
      color,
      ready: false,
      state: ST_ALIVE,
      x: 0, y: 0,
      aim: 0,                          // radians, where they are facing
      flags: 0,
      charge: 100,
      reserve: 0,
      carrying: null,
      downTimer: 0,
      downs: 0,
      stats: { fuses: 0, revives: 0, batteries: 0, escaped: false },
      lastInput: Date.now(),
    };
    this.players.set(id, player);
    if (this.hostId === null) this.hostId = id;

    conn.send({
      t: 'hello',
      id,
      phase: this.phase,
      cfg: this.cfg,
      difficulties: Object.fromEntries(Object.entries(DIFFICULTY).map(([k, v]) => [k, v.label])),
      maxPlayers: MAX_PLAYERS,
    });

    if (this.phase === 'playing') {
      this.placeAtSpawn(player);
      conn.send(this.beginPayload());
    }
    this.broadcastLobby();
    this.event({ k: 'joined', name: player.name });
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    if (player.carrying !== null) this.dropFuse(player);
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.players.keys().next().value ?? null;
    this.event({ k: 'left', name: player.name });
    this.broadcastLobby();
    if (this.phase === 'playing') this.checkRoundOver();
    if (this.players.size === 0) this.resetToLobby();
  }

  // --- Inbound ---------------------------------------------------------------

  handle(player, msg) {
    switch (msg.t) {
      case 'input': return this.onInput(player, msg);
      case 'use':   return this.onUse(player, msg);
      case 'chat':  return this.onChat(player, msg);
      case 'ready': return this.onReady(player);
      case 'cfg':   return this.onConfig(player, msg);
      case 'start': return this.onStart(player);
      case 'name':  return this.onRename(player, msg);
      case 'ping':  return player.conn.send({ t: 'pong', c: msg.c });
      default:      return undefined;
    }
  }

  onInput(player, msg) {
    if (this.phase !== 'playing' || !Array.isArray(msg.p)) return;
    const [nx, ny] = msg.p;
    if (![nx, ny].every(Number.isFinite)) return;

    const now = Date.now();
    const dt = Math.min(0.5, (now - player.lastInput) / 1000);
    player.lastInput = now;

    if (Number.isFinite(msg.a)) player.aim = msg.a;

    // Movement clamp: generous enough for a latency spike, nowhere near a
    // teleport, and every step of the way has to be legal - not just where it
    // ended up, or one long step could cross a wall outright.
    const budget = SPEED.sprint * 1.6 * dt + 0.6;
    const dx = nx - player.x, dy = ny - player.y;
    const moved = Math.hypot(dx, dy);

    // Anything past the budget is pulled back to it rather than rejected, so a
    // laggy client still moves. What it must not do is skip the geometry
    // check: a clamped move is still a move, and a body sliding five tiles
    // toward a far-off point would otherwise slide straight through a wall.
    let tx = nx, ty = ny;
    if (moved > budget) {
      const s = budget / moved;
      tx = player.x + dx * s;
      ty = player.y + dy * s;
    }
    if (!this.isSolidAt(tx, ty) && !this.crossesSolid(player, tx, ty)) {
      player.x = tx;
      player.y = ty;
    }

    player.flags = (player.flags & ~CLIENT_FLAGS) | ((msg.f | 0) & CLIENT_FLAGS);
    if (player.state !== ST_ALIVE) player.flags &= ~(F_SPRINT | F_MOVING);
  }

  onUse(player, msg) {
    if (this.phase !== 'playing') return;
    switch (msg.k) {
      case 'fuse':    return this.pickUpFuse(player, msg.id);
      case 'insert':  return this.insertFuse(player);
      case 'revive':  return this.revive(player, msg.id);
      case 'drop':    return this.dropFuse(player);
      case 'battery': return this.takeBattery(player, msg.id);
      case 'reload':  return this.reloadFlashlight(player);
      case 'power':   return this.toggleGenerator(player);
      case 'button':  return this.pressDoorButton(player);
      default:        return undefined;
    }
  }

  onChat(player, msg) {
    const text = String(msg.m ?? '').replace(new RegExp('[\u0000-\u001f\u007f]', 'g'), '').slice(0, 180).trim();
    if (!text) return;
    this.broadcast({ t: 'chat', from: player.name, color: player.color, m: text });
  }

  onReady(player) { player.ready = !player.ready; this.broadcastLobby(); }
  onRename(player, msg) { player.name = sanitiseName(msg.name, player.id); this.broadcastLobby(); }

  onConfig(player, msg) {
    if (player.id !== this.hostId || this.phase === 'playing') return;
    if (['small', 'medium', 'large'].includes(msg.size)) this.cfg.size = msg.size;
    if (Number.isFinite(msg.fuses)) this.cfg.fuses = Math.max(3, Math.min(9, msg.fuses | 0));
    if (DIFFICULTY[msg.difficulty]) this.cfg.difficulty = msg.difficulty;
    this.broadcastLobby();
  }

  onStart(player) {
    if (player.id !== this.hostId || this.phase === 'playing') return;
    this.startRound();
  }

  // --- Round -----------------------------------------------------------------

  startRound() {
    this.map = generate({
      seed: (this.rng() * 0xffffffff) >>> 0,
      size: this.cfg.size,
      fuseCount: this.cfg.fuses,
    });
    this.grid = Uint8Array.from(this.map.grid, (c) => +c);
    this.floorCells = [];
    for (let y = 1; y < this.map.h - 1; y++) {
      for (let x = 1; x < this.map.w - 1; x++) {
        if (this.grid[idx(x, y, this.map.w)] === FLOOR) this.floorCells.push({ cx: x, cy: y });
      }
    }
    this.distFromSpawn = bfsDistances(
      (x, y) => this.grid[idx(x, y, this.map.w)] === FLOOR,
      this.map.w, this.map.h, this.map.spawn
    );

    this.fuses = this.map.fuses.map((f) => ({ id: f.id, x: f.x, y: f.y, state: 0, holder: null }));
    this.batteries = this.map.batteries.map((b) => ({ id: b.id, x: b.x, y: b.y, taken: false }));
    this.powered = 0;
    this.generatorOn = false;
    this.door = { phase: DOOR_SHUT, timer: 0 };
    this.roundTime = 0;
    this.outcome = null;
    this.phase = 'playing';
    this.tick = 0;

    const diff = this.difficulty();
    this.monsters = [];
    for (let i = 0; i < diff.monsters; i++) this.monsters.push(this.spawnMonster(i, diff));

    for (const p of this.players.values()) {
      p.state = ST_ALIVE;
      p.carrying = null;
      p.downs = 0;
      p.downTimer = 0;
      p.ready = false;
      p.charge = 100;
      p.reserve = 0;
      p.flags = 0;
      p.stats = { fuses: 0, revives: 0, batteries: 0, escaped: false };
      this.placeAtSpawn(p);
    }

    this.broadcast(this.beginPayload());
  }

  beginPayload() {
    return {
      t: 'begin',
      map: this.map,
      cfg: this.cfg,
      difficulty: this.difficulty().label,
      need: this.map.fuseCount,
    };
  }

  placeAtSpawn(player) {
    const points = this.map.spawnPoints;
    const p = points[(player.id + this.tick) % points.length];
    player.x = p.x + (this.rng() - 0.5) * 0.5;
    player.y = p.y + (this.rng() - 0.5) * 0.5;
  }

  spawnMonster(index, diff) {
    // It wakes up as far from the survivors' entrance as the layout allows.
    const far = this.floorCells
      .filter((c) => (this.distFromSpawn[idx(c.cx, c.cy, this.map.w)] ?? -1) > 0)
      .sort((a, b) => this.distFromSpawn[idx(b.cx, b.cy, this.map.w)] - this.distFromSpawn[idx(a.cx, a.cy, this.map.w)]);
    const cell = far[Math.min(far.length - 1, index * 3)] || { cx: 1, cy: 1 };
    return {
      id: index,
      x: cell.cx + 0.5, y: cell.cy + 0.5,
      aim: 0,
      state: 'sleeping',
      timer: diff.grace + index * 15,
      exposure: new Map(),
      searchTimer: 0,
      path: [], pathIdx: 0, repathIn: 0,
      targetId: null,
      lastKnown: null,
      loseTimer: LOSE_GRACE,
      attackCooldown: 0,
      screamCooldown: 0,
      timerIdle: 0,
    };
  }

  resetToLobby() {
    this.phase = 'lobby';
    this.monsters = [];
    this.fuses = [];
    this.batteries = [];
    this.generatorOn = false;
    this.door = { phase: DOOR_SHUT, timer: 0 };
    this.map = null;
    this.grid = null;
    for (const p of this.players.values()) {
      p.ready = false; p.state = ST_ALIVE; p.carrying = null; p.flags = 0;
    }
    this.broadcastLobby();
  }

  difficulty() { return DIFFICULTY[this.cfg.difficulty] || DIFFICULTY.normal; }

  // --- Objectives ------------------------------------------------------------

  pickUpFuse(player, fuseId) {
    if (player.state !== ST_ALIVE || player.carrying !== null) return;
    const fuse = this.fuses.find((f) => f.id === fuseId);
    if (!fuse || fuse.state !== 0) return;
    if (dist2(player.x, player.y, fuse.x, fuse.y) > 1.8 * 1.8) return;
    fuse.state = 1;
    fuse.holder = player.id;
    player.carrying = fuse.id;
    // A fuse is a live cell: handling one tops the flashlight right up. That is
    // the compensation for carrying the most dangerous object in the building.
    const recharged = player.charge < 99.5;
    player.charge = 100;
    this.event({ k: 'pickup', x: fuse.x, y: fuse.y, by: player.name, id: player.id, recharged });
    this.hearNoise(player.x, player.y, 0.55);
  }

  dropFuse(player) {
    if (player.carrying === null) return;
    const fuse = this.fuses.find((f) => f.id === player.carrying);
    player.carrying = null;
    if (!fuse) return;
    fuse.state = 0;
    fuse.holder = null;
    fuse.x = player.x;
    fuse.y = player.y;
    this.event({ k: 'drop', x: fuse.x, y: fuse.y });
  }

  insertFuse(player) {
    if (player.state !== ST_ALIVE || player.carrying === null) return;
    const gen = this.map.generator;
    if (dist2(player.x, player.y, gen.x, gen.y) > 2.2 * 2.2) return;

    const fuse = this.fuses.find((f) => f.id === player.carrying);
    if (fuse) { fuse.state = 2; fuse.holder = null; }
    player.carrying = null;
    player.stats.fuses++;
    this.powered++;

    const complete = this.powered >= this.map.fuseCount;
    this.event({ k: 'fuse', n: this.powered, need: this.map.fuseCount, by: player.name, x: gen.x, y: gen.y });
    this.hearNoise(gen.x, gen.y, complete ? 3.0 : 1.6);

    if (complete) {
      this.generatorOn = true;
      // Power reaches the panel by the door. It does not open the door.
      this.event({ k: 'power', on: true, x: gen.x, y: gen.y });
      this.event({ k: 'door-power', on: true, x: this.map.door.panel.x, y: this.map.door.panel.y });
      this.alertMonsters(gen.x, gen.y);
    }
  }

  takeBattery(player, batteryId) {
    if (player.state !== ST_ALIVE) return;
    const battery = this.batteries.find((b) => b.id === batteryId);
    if (!battery || battery.taken) return;
    if (dist2(player.x, player.y, battery.x, battery.y) > 1.8 * 1.8) return;
    if (player.reserve >= MAX_RESERVE) return;
    battery.taken = true;
    player.reserve++;
    player.stats.batteries++;
    this.event({ k: 'battery', by: player.name, id: player.id, n: player.reserve });
  }

  // One battery, one full charge, never the whole reserve at once.
  reloadFlashlight(player) {
    if (player.state !== ST_ALIVE || player.reserve <= 0 || player.charge >= 99.5) return;
    player.reserve--;
    player.charge = 100;
    this.event({ k: 'reload', id: player.id, n: player.reserve });
    this.hearNoise(player.x, player.y, 0.35);
  }

  // Once every fuse is seated the generator is a switch, and it stays one:
  // anyone can put the building back into the dark, and sometimes you want to.
  toggleGenerator(player) {
    if (player.state !== ST_ALIVE || this.powered < this.map.fuseCount) return;
    const gen = this.map.generator;
    if (dist2(player.x, player.y, gen.x, gen.y) > 2.2 * 2.2) return;
    this.generatorOn = !this.generatorOn;
    this.event({ k: 'power', on: this.generatorOn, by: player.name, x: gen.x, y: gen.y });
    this.event({ k: 'door-power', on: this.generatorOn, x: this.map.door.panel.x, y: this.map.door.panel.y });
    this.hearNoise(gen.x, gen.y, 2.0);
  }

  // --- The door --------------------------------------------------------------

  pressDoorButton(player) {
    if (player.state !== ST_ALIVE || this.door.phase !== DOOR_SHUT) return;
    const panel = this.map.door.panel;
    if (dist2(player.x, player.y, panel.x, panel.y) > 1.7 * 1.7) return;
    if (!this.generatorOn) {
      this.event({ k: 'door-dead', id: player.id, x: panel.x, y: panel.y });
      return;
    }
    this.door.phase = DOOR_OPENING;
    this.door.timer = DOOR_OPEN_TIME;
    this.event({
      k: 'door-open', by: player.name, id: player.id,
      seconds: DOOR_OPEN_TIME, x: this.map.door.x, y: this.map.door.y,
    });
    // Several seconds of motor, in a building with something listening in it.
    this.hearNoise(this.map.door.x, this.map.door.y, 3.4);
  }

  updateDoor(dt) {
    if (this.door.phase !== DOOR_OPENING) return;
    this.door.timer -= dt;
    if (this.door.timer > 0) return;
    this.door.timer = 0;
    this.door.phase = DOOR_OPEN;
    this.event({ k: 'door-opened', x: this.map.door.x, y: this.map.door.y });
  }

  doorProgress() {
    if (this.door.phase === DOOR_OPEN) return 1;
    if (this.door.phase !== DOOR_OPENING) return 0;
    return Math.max(0, Math.min(1, 1 - this.door.timer / DOOR_OPEN_TIME));
  }

  // Reaching the far end of the alcove is out.
  updateEscapes() {
    if (this.door.phase !== DOOR_OPEN) return;
    const t = this.map.door.threshold;
    for (const p of this.players.values()) {
      if (p.state !== ST_ALIVE) continue;
      if (dist2(p.x, p.y, t.x, t.y) > 0.9 * 0.9) continue;
      p.state = ST_ESCAPED;
      p.stats.escaped = true;
      if (p.carrying !== null) this.dropFuse(p);
      this.event({ k: 'escape', who: p.name, id: p.id });
      this.checkRoundOver();
    }
  }

  // --- Downs -----------------------------------------------------------------

  revive(player, targetId) {
    if (player.state !== ST_ALIVE) return;
    const target = this.players.get(targetId);
    if (!target || target.state !== ST_DOWN) return;
    if (dist2(player.x, player.y, target.x, target.y) > 1.7 * 1.7) return;
    target.state = ST_ALIVE;
    target.downTimer = 0;
    player.stats.revives++;
    this.event({ k: 'revive', by: player.name, who: target.name, id: target.id, x: target.x, y: target.y });
    this.hearNoise(target.x, target.y, 0.9);
  }

  downPlayer(player, monster) {
    if (player.state !== ST_ALIVE) return;
    player.state = ST_DOWN;
    player.downs++;
    // Each rescue buys less time than the last: the third mistake sticks.
    player.downTimer = this.difficulty().bleed * Math.pow(0.72, player.downs - 1);
    if (player.carrying !== null) this.dropFuse(player);
    this.event({ k: 'down', who: player.name, id: player.id, x: player.x, y: player.y });
    if (monster) {
      monster.state = 'retreat';
      monster.timer = 7;
      monster.targetId = null;
      monster.path = [];
      monster.repathIn = 0;
    }
    this.checkRoundOver();
  }

  killPlayer(player) {
    player.state = ST_DEAD;
    this.event({ k: 'death', who: player.name, id: player.id });
    this.checkRoundOver();
  }

  checkRoundOver() {
    if (this.phase !== 'playing') return;
    const all = [...this.players.values()];
    if (!all.length) return;
    if (all.some((p) => p.state === ST_ALIVE || p.state === ST_DOWN)) return;
    this.endRound(all.some((p) => p.state === ST_ESCAPED) ? 'escaped' : 'lost');
  }

  endRound(outcome) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.outcome = outcome;
    this.endsAt = Date.now() + 14000;
    this.broadcast({
      t: 'end',
      outcome,
      time: Math.round(this.roundTime),
      powered: this.powered,
      need: this.map ? this.map.fuseCount : this.cfg.fuses,
      players: [...this.players.values()].map((p) => ({
        name: p.name, color: p.color, ...p.stats, state: p.state, downs: p.downs,
      })),
    });
  }

  // --- Simulation ------------------------------------------------------------

  update(dt) {
    if (this.phase === 'ended' && Date.now() > this.endsAt) { this.resetToLobby(); return; }
    if (this.phase !== 'playing') return;

    this.tick++;
    this.roundTime += dt;

    for (const p of this.players.values()) {
      if (p.state !== ST_DOWN) continue;
      p.downTimer -= dt;
      if (p.downTimer <= 0) this.killPlayer(p);
    }

    this.updateDoor(dt);
    this.updateEscapes();
    this.drainFlashlights(dt);
    for (const m of this.monsters) this.updateMonster(m, dt);
    this.updateDirector(dt);

    if (this.tick % SNAP_EVERY === 0) this.sendSnapshot();
  }

  // Charge is spent here so every client agrees how much light a player has
  // left, and so a tampered client cannot grant itself an infinite battery.
  drainFlashlights(dt) {
    for (const p of this.players.values()) {
      if (!(p.flags & F_LIGHT) || p.state !== ST_ALIVE || p.charge <= 0) continue;
      p.charge = Math.max(0, p.charge - FLASHLIGHT_DRAIN * dt);
      if (p.charge > 0) continue;
      p.flags &= ~F_LIGHT;
      this.event({ k: 'dead-battery', id: p.id });
    }
  }

  // How loud and how visible a player is. Crouching is the whole stealth
  // system: it cuts what can be heard to almost nothing and, more importantly,
  // shrinks how far away the monster can pick you out at all.
  stanceOf(p) {
    if (p.state === ST_DOWN) return { noise: 0.45, visibility: 0.70 };
    const moving = (p.flags & F_MOVING) !== 0;
    if (p.flags & F_CROUCH) {
      return moving ? { noise: 0.14, visibility: 0.30 } : { noise: 0.02, visibility: 0.18 };
    }
    if (!moving) return { noise: 0.04, visibility: 0.65 };
    if (p.flags & F_SPRINT) return { noise: 1.00, visibility: 1.00 };
    return { noise: 0.55, visibility: 0.85 };
  }

  // What one monster can tell about one player. Nothing here reaches through
  // geometry: sight needs line of sight, and hearing yields a place to look,
  // never a lock.
  perceive(m, p, hearing, sight) {
    const d = Math.hypot(p.x - m.x, p.y - m.y);
    const stance = this.stanceOf(p);
    let noise = stance.noise;
    let visibility = stance.visibility;

    if (p.flags & F_BUSY) noise = Math.max(noise, 0.8);
    // A lit flashlight is the loudest thing you can do to your own profile.
    if (p.flags & F_LIGHT) { noise += 0.25; visibility *= 2.0; }
    if (this.generatorOn) visibility *= 1.35;

    const heard = d < hearing * noise;
    const los = (heard || d < sight * visibility) ? this.lineOfSight(m.x, m.y, p.x, p.y) : false;
    return { d, los, heard, seen: los && d < sight * visibility };
  }

  lineOfSight(ax, ay, bx, by) {
    return hasLineOfSight(
      (x, y) => this.grid[idx(x, y, this.map.w)] !== FLOOR,
      this.map.w, this.map.h, ax, ay, bx, by
    );
  }

  updateMonster(m, dt) {
    const diff = this.difficulty();
    const aggro = this.map.fuseCount ? this.powered / this.map.fuseCount : 0;
    const speedMul = 1 + aggro * 0.16;
    const hearing = diff.hearing * (1 + aggro * 0.4);
    const sight = diff.sight * (1 + aggro * 0.2);

    m.attackCooldown = Math.max(0, m.attackCooldown - dt);
    m.screamCooldown = Math.max(0, m.screamCooldown - dt);

    if (m.state === 'sleeping') {
      m.timer -= dt;
      if (m.timer > 0) return;
      m.state = 'waking';
      m.timer = WAKE_DURATION;
      this.event({ k: 'waking', x: m.x, y: m.y, id: m.id });
      return;
    }

    if (m.state === 'waking') {
      m.timer -= dt;
      if (m.timer > 0) return;
      m.state = 'patrol';
      m.path = [];
      this.event({ k: 'awake', x: m.x, y: m.y, id: m.id });
      return;
    }

    // --- What it can tell right now ------------------------------------------
    let best = null;
    for (const p of this.players.values()) {
      if (p.state !== ST_ALIVE && p.state !== ST_DOWN) continue;
      const info = this.perceive(m, p, hearing, sight);
      if (!info.heard && !info.seen) {
        // Exposure decays out of view, so ducking behind a crate genuinely helps.
        const cur = m.exposure.get(p.id) || 0;
        if (cur > 0) m.exposure.set(p.id, Math.max(0, cur - dt * 1.5));
        continue;
      }
      if (info.seen) {
        const need = (p.flags & F_CROUCH) ? CROUCH_EXPOSURE : STAND_EXPOSURE;
        const cur = (m.exposure.get(p.id) || 0) + dt;
        m.exposure.set(p.id, cur);
        info.acquired = cur >= need;
      } else {
        info.acquired = false;
      }
      const score = (info.acquired ? 1000 : 0) + (info.heard ? 200 : 0) + (400 - info.d);
      if (!best || score > best.score) best = { p, ...info, score };
    }

    if (best && m.state !== 'retreat' && m.state !== 'attack') {
      if (best.acquired && best.p.state === ST_ALIVE) {
        if (m.state !== 'chase') {
          m.state = 'chase';
          m.repathIn = 0;
          if (m.screamCooldown <= 0) {
            m.screamCooldown = 12;
            this.event({ k: 'scream', x: m.x, y: m.y, id: m.id, target: best.p.id });
          }
        }
        m.targetId = best.p.id;
        m.lastKnown = { x: best.p.x, y: best.p.y };
        m.loseTimer = LOSE_GRACE;
      } else if (best.heard) {
        // A noise is a place to look, not a target to follow.
        m.lastKnown = { x: best.p.x, y: best.p.y };
        if (m.state === 'patrol' || m.state === 'idle') {
          m.state = 'search';
          m.searchTimer = SEARCH_TIME;
          m.repathIn = 0;
        }
      }
    }

    let speed = diff.patrol * speedMul;

    switch (m.state) {
      case 'patrol':
        if (!m.path.length) this.repath(m, this.randomFarCell(m));
        break;

      case 'idle':
        m.timer -= dt;
        m.aim += dt * 1.6;
        if (m.timer <= 0) { m.state = 'patrol'; m.path = []; }
        return;

      case 'search': {
        speed = (diff.patrol + diff.chase) * 0.5 * speedMul;
        m.searchTimer -= dt;
        m.repathIn -= dt;
        if (m.lastKnown && (!m.path.length || m.repathIn <= 0)) {
          m.repathIn = 1.2;
          this.repath(m, cellOf(m.lastKnown));
        }
        if (!m.path.length) {
          if (m.searchTimer > 0) {
            const probe = this.randomNearbyCell(m, 4);
            if (probe) this.repath(m, probe);
            else m.searchTimer = 0;
          } else {
            m.state = 'idle';
            m.timer = 2 + this.rng() * 2;
            m.lastKnown = null;
            m.targetId = null;
            m.exposure.clear();
            this.event({ k: 'lost', id: m.id });
          }
        }
        break;
      }

      case 'chase': {
        speed = diff.chase * speedMul;
        const target = this.players.get(m.targetId);
        if (!target || (target.state !== ST_ALIVE && target.state !== ST_DOWN)) {
          m.state = 'search'; m.searchTimer = SEARCH_TIME; m.repathIn = 0; break;
        }
        // Only a live perception refreshes what it knows. Break contact and it
        // is running at a memory, and that memory goes stale.
        const stillOn = best && best.p.id === m.targetId && (best.acquired || best.heard);
        if (stillOn) {
          m.lastKnown = { x: best.p.x, y: best.p.y };
          m.loseTimer = LOSE_GRACE;
        } else {
          m.loseTimer -= dt;
          if (m.loseTimer <= 0) {
            m.state = 'search';
            m.searchTimer = SEARCH_TIME;
            m.repathIn = 0;
            m.exposure.clear();
            this.event({ k: 'lost', id: m.id });
            break;
          }
        }
        m.repathIn -= dt;
        if (m.repathIn <= 0 && m.lastKnown) {
          m.repathIn = 0.4;
          this.repath(m, cellOf(m.lastKnown));
        }
        // It can only swing at what it is actually next to.
        const d = Math.hypot(target.x - m.x, target.y - m.y);
        if (d < 1.0 && m.attackCooldown <= 0 && target.state === ST_ALIVE) {
          m.attackCooldown = 3;
          m.state = 'attack';
          m.timer = 0.6;
          this.downPlayer(target, m);
          return;
        }
        break;
      }

      case 'attack':
        m.timer -= dt;
        if (m.timer <= 0) { m.state = 'retreat'; m.timer = 7; m.path = []; }
        return;

      case 'retreat':
        speed = diff.chase * 0.9 * speedMul;
        m.timer -= dt;
        if (!m.path.length) this.repath(m, this.randomFarCell(m));
        if (m.timer <= 0) {
          m.state = 'patrol';
          m.path = [];
          m.lastKnown = null;
          m.targetId = null;
          m.exposure.clear();
        }
        break;

      default:
        m.state = 'patrol';
    }

    this.moveAlongPath(m, speed, dt);
  }

  repath(m, goalCell) {
    if (!goalCell) return;
    const walkable = (x, y) => this.grid[idx(x, y, this.map.w)] === FLOOR;
    const path = findPath(walkable, this.map.w, this.map.h,
      this.nearestFloor(cellOf(m)), this.nearestFloor(goalCell));
    m.path = path || [];
    m.pathIdx = 0;
  }

  moveAlongPath(m, speed, dt) {
    if (!m.path.length) return;
    const next = m.path[m.pathIdx];
    if (!next) { m.path = []; m.pathIdx = 0; return; }
    const tx = next.cx + 0.5, ty = next.cy + 0.5;
    const dx = tx - m.x, dy = ty - m.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.12) {
      m.pathIdx++;
      if (m.pathIdx >= m.path.length) { m.path = []; m.pathIdx = 0; }
      return;
    }
    const step = Math.min(d, speed * dt);
    const fixed = this.resolveCircle(m.x + (dx / d) * step, m.y + (dy / d) * step, MONSTER_RADIUS);
    m.x = fixed.x;
    m.y = fixed.y;
    m.aim += angleDelta(m.aim, Math.atan2(dy, dx)) * Math.min(1, dt * 6);
  }

  randomFarCell(m) {
    let best = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const c = this.floorCells[Math.floor(this.rng() * this.floorCells.length)];
      if (!c) continue;
      const d = Math.hypot(c.cx + 0.5 - m.x, c.cy + 0.5 - m.y);
      if (d > bestScore) { bestScore = d; best = c; }
    }
    return best;
  }

  randomNearbyCell(m, radius) {
    if (!m.lastKnown) return null;
    const centre = cellOf(m.lastKnown);
    for (let attempt = 0; attempt < 12; attempt++) {
      const cx = centre.cx + Math.round((this.rng() - 0.5) * radius * 2);
      const cy = centre.cy + Math.round((this.rng() - 0.5) * radius * 2);
      if (cx < 1 || cy < 1 || cx >= this.map.w - 1 || cy >= this.map.h - 1) continue;
      if (this.grid[idx(cx, cy, this.map.w)] !== FLOOR) continue;
      return { cx, cy };
    }
    return null;
  }

  nearestFloor(cell) {
    const { w, h } = this.map;
    const cx = Math.max(0, Math.min(w - 1, cell.cx));
    const cy = Math.max(0, Math.min(h - 1, cell.cy));
    if (this.grid[idx(cx, cy, w)] === FLOOR) return { cx, cy };
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (this.grid[idx(nx, ny, w)] === FLOOR) return { cx: nx, cy: ny };
        }
      }
    }
    return { cx: 1, cy: 1 };
  }

  // --- Geometry --------------------------------------------------------------

  // The door cell is solid right up until the shutter is all the way up. Both
  // ends agree on this, cell for cell.
  isSolidCell(cx, cy) {
    const { w, h } = this.map;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return true;
    const v = this.grid[idx(cx, cy, w)];
    if (v === DOOR) return this.door.phase !== DOOR_OPEN;
    return v !== FLOOR && v !== ALCOVE;
  }

  isSolidAt(x, y) {
    if (!this.grid) return false;
    return this.isSolidCell(Math.floor(x), Math.floor(y));
  }

  // A budgeted step can be a couple of tiles long after a latency spike, which
  // is enough to clear a wall if only the destination is checked.
  crossesSolid(player, nx, ny) {
    const dx = nx - player.x, dy = ny - player.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.4) return false;
    const steps = Math.ceil(d / 0.3);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.isSolidAt(player.x + dx * t, player.y + dy * t)) return true;
    }
    return false;
  }

  // Push a circle out of any solid cell it overlaps. Kept in step with the
  // client's own collision so both ends agree where a body can stand.
  resolveCircle(x, y, radius) {
    let outX = x, outY = y;
    const cx = Math.floor(x), cy = Math.floor(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (!this.isSolidCell(tx, ty)) continue;
        const closestX = Math.max(tx, Math.min(outX, tx + 1));
        const closestY = Math.max(ty, Math.min(outY, ty + 1));
        const px = outX - closestX, py = outY - closestY;
        const distSq = px * px + py * py;
        if (distSq >= radius * radius) continue;
        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          outX = closestX + (px / dist) * radius;
          outY = closestY + (py / dist) * radius;
        } else {
          const penX = Math.min(outX - tx, tx + 1 - outX);
          const penY = Math.min(outY - ty, ty + 1 - outY);
          if (penX < penY) outX = outX < tx + 0.5 ? tx - radius : tx + 1 + radius;
          else outY = outY < ty + 0.5 ? ty - radius : ty + 1 + radius;
        }
      }
    }
    return { x: outX, y: outY };
  }

  // --- Noise and atmosphere ---------------------------------------------------

  hearNoise(x, y, strength) {
    for (const m of this.monsters) {
      if (['sleeping', 'waking', 'chase', 'retreat', 'attack'].includes(m.state)) continue;
      if (Math.hypot(m.x - x, m.y - y) > this.difficulty().hearing * strength) continue;
      m.lastKnown = { x, y };
      m.state = 'search';
      m.searchTimer = SEARCH_TIME;
      m.repathIn = 0;
    }
  }

  alertMonsters(x, y) {
    for (const m of this.monsters) {
      if (m.state === 'sleeping' || m.state === 'waking') continue;
      m.state = 'search';
      m.searchTimer = SEARCH_TIME;
      m.lastKnown = { x, y };
      m.repathIn = 0;
    }
  }

  // The director spawns nothing. It just makes the building sound inhabited,
  // so silence never feels safe.
  updateDirector(dt) {
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 14 + this.rng() * 26;
    const alive = [...this.players.values()].filter((p) => p.state === ST_ALIVE);
    if (!alive.length) return;
    const anchor = alive[Math.floor(this.rng() * alive.length)];
    const angle = this.rng() * Math.PI * 2;
    const radius = 6 + this.rng() * 10;
    const kinds = ['clang', 'drip', 'whisper', 'scrape', 'breath'];
    this.event({
      k: 'ambient',
      kind: kinds[Math.floor(this.rng() * kinds.length)],
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
    });
  }

  // --- Outbound ---------------------------------------------------------------

  sendSnapshot() {
    // Player rows: [id, x, y, aim, flags, state, carrying, downTimer, charge, reserve]
    const players = [];
    for (const p of this.players.values()) {
      players.push([
        p.id, round2(p.x), round2(p.y), round2(p.aim),
        p.flags, p.state,
        p.carrying === null ? -1 : p.carrying,
        p.state === ST_DOWN ? Math.max(0, Math.round(p.downTimer)) : 0,
        Math.round(p.charge), p.reserve,
      ]);
    }
    this.broadcast({
      t: 'snap',
      k: this.tick,
      tm: Math.round(this.roundTime),
      p: players,
      // Monster rows: [id, x, y, aim, stateCode]
      m: this.monsters.map((m) => [m.id, round2(m.x), round2(m.y), round2(m.aim), MONSTER_STATE_CODE[m.state] ?? 0]),
      // Fuse rows: [id, x, y, state, holder]
      f: this.fuses.map((f) => [f.id, round2(f.x), round2(f.y), f.state, f.holder ?? -1]),
      // Battery rows: [id, taken]
      b: this.batteries.map((b) => [b.id, b.taken ? 1 : 0]),
      g: this.powered,
      o: this.generatorOn ? 1 : 0,
      // The door: [phase, progress]
      dr: [this.door.phase, Math.round(this.doorProgress() * 100) / 100],
    });
  }

  broadcastLobby() {
    this.broadcast({
      t: 'lobby',
      host: this.hostId,
      phase: this.phase,
      cfg: this.cfg,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, ready: p.ready, state: p.state,
      })),
    });
  }

  event(ev) { this.broadcast({ t: 'ev', ...ev }); }

  broadcast(obj) {
    const json = JSON.stringify(obj);
    for (const p of this.players.values()) if (p.conn.open) p.conn.sendRaw(json);
  }
}

function sanitiseName(name, id) {
  const clean = String(name ?? '').replace(/[^\w \-.'[\]]/g, '').trim().slice(0, 16);
  return clean || 'Survivor ' + id;
}

const cellOf = (p) => ({ cx: Math.floor(p.x), cy: Math.floor(p.y) });
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function round2(v) { return Math.round(v * 100) / 100; }
function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

module.exports = {
  Session, TICK_HZ, MAX_PLAYERS, DIFFICULTY, SPEED, PLAYER_RADIUS, MONSTER_RADIUS,
  F_MOVING, F_SPRINT, F_CROUCH, F_LIGHT, F_BUSY,
  DOOR_SHUT, DOOR_OPENING, DOOR_OPEN, DOOR_OPEN_TIME, MAX_RESERVE,
};
