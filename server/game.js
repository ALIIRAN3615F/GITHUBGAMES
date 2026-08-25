'use strict';

// Authoritative session state for SIGNAL LOST.
//
// Split of responsibility: clients own their own movement (LAN latency is low
// and this is a co-op game, so it feels far better than server-side prediction),
// while the server owns everything that can be cheated or must agree across
// machines - the monster, the fuses, the generator, downs and revives.
//
// Wire protocol
//   C -> S  join {name} | input {p,y,pt,f} | use {k,id} | shoot {d} | rl {}
//           chat {m} | cfg {...} | ready {} | start {} | ping {c}
//   S -> C  hello | lobby | begin {map} | snap | ev | chat | end | pong
//
// Player flag bits packed into `f` on the input message:
const F_MOVING = 1, F_SPRINT = 2, F_CROUCH = 4, F_LIGHT = 8, F_BUSY = 16;
// Weapon and climb state ride the same field so remote clients can pose a
// player correctly from a snapshot alone.
const F_GUN = 32, F_RELOAD = 64, F_CLIMB = 128;
const CLIENT_FLAGS = F_MOVING | F_SPRINT | F_CROUCH | F_LIGHT | F_BUSY;

const { generate, worldToCell, bfsDistances, idx, DOOR } = require('./mapgen');
const BACKROOMS = require('./backrooms');
const { findPath, hasLineOfSight } = require('./pathfind');
const { makeRng } = require('./rng');

const TICK_HZ = 30;
const SNAP_EVERY = 2;                 // snapshots at 15 Hz
const MAX_PLAYERS = 8;

// Player movement speeds; the client enforces the same numbers, the server
// clamps against them so a tampered client cannot outrun the monster.
const SPEED = { walk: 3.2, sprint: 5.6, crouch: 1.65 };

// The monster's collision radius. Narrower than its reach, so it can still
// follow a one-cell corridor without grinding along both walls.
const MONSTER_RADIUS = 0.4;

// Flashlight economy. Charge is a percentage; one spare battery restores a
// full charge, and there is no trickle recharge - light is a consumable you
// have to go looking for.
const FLASHLIGHT_DRAIN = 1.0;      // percent per second while lit
const MAX_RESERVE = 24;

// Monster perception timings.
//
// grace (above) is the exploration phase - long enough to actually learn the
// map, find batteries and locate the generator before anything hunts you.
const WAKE_DURATION = 8;        // it gets up noisily before it starts moving
const STAND_EXPOSURE = 0.3;     // seconds in view before a standing player is locked
const CROUCH_EXPOSURE = 1.6;    // a crouching player has to be stared at
const LOSE_GRACE = 2.5;         // how long a chase survives with no perception
const SEARCH_TIME = 14;         // how long it hunts around a last known position

// The sabotage ending. Deliberately slow: the point is the dread between
// pouring the fuel and the bang.
const UNSTABLE_TIME = 8;        // generator labouring, sparking, before it goes
const BURN_TIME = 20;           // the facility burning before the ending lands

// The emergency door. It is a roller shutter on a slow industrial motor, and
// once it is up it stays up - nothing in the round puts it back down.
const DOOR_OPEN_TIME = 6.5;
const DOOR_SHUT = 0, DOOR_OPENING = 1, DOOR_OPEN = 2;

// Zones. A player is either in the facility or through the door; the monster
// only exists in the facility.
const Z_FACILITY = 0, Z_BACKROOMS = 1;

// Climbing the ladder out is a fixed, uninterruptible move, not a teleport.
const CLIMB_TIME = 5.0;

// The rifle. One in the facility, sixty rounds in total, and nothing anywhere
// that tops it back up: enough to buy your way past the monster twice if every
// shot lands, and nowhere near enough to hunt it.
const MAG_SIZE = 30;
const AMMO_RESERVE = 30;
const FIRE_INTERVAL = 0.096;         // ~625 rpm
// A client rendering at ten frames a second can only ask to fire ten times a
// second, which would quietly halve the rifle's rate of fire on exactly the
// machines that can least afford it. Instead the cadence is owed rather than
// polled: a stuttering client may bank this much of it and catch up.
const FIRE_CATCHUP = 0.58;
const RELOAD_TIME = 2.6;
const AK_RANGE = 60;
const AK_DAMAGE_MONSTER = 12;
const AK_DAMAGE_PLAYER = 26;
const MONSTER_HP = 120;
const MONSTER_DOWN_TIME = 55;        // how long a killed monster stays down
const MONSTER_STAGGER = 0.35;        // seconds of flinch per hit
const PLAYER_HP = 100;

const DIFFICULTY = {
  calm:      { patrol: 2.0, chase: 4.05, hearing: 17, sight: 17, grace: 210, bleed: 60, monsters: 1, label: 'Calm' },
  normal:    { patrol: 2.4, chase: 4.70, hearing: 23, sight: 21, grace: 150, bleed: 45, monsters: 1, label: 'Normal' },
  nightmare: { patrol: 2.9, chase: 5.30, hearing: 31, sight: 26, grace: 90, bleed: 30, monsters: 2, label: 'Nightmare' },
};

const PLAYER_COLORS = [
  0x6fd3ff, 0xffb347, 0x9be36b, 0xff7b7b,
  0xc79bff, 0xffe066, 0x66e8c8, 0xff8fd0,
];

const ST_ALIVE = 0, ST_DOWN = 1, ST_DEAD = 2, ST_ESCAPED = 3;

let nextPlayerId = 1;

class Session {
  // `seed` makes a session's randomness reproducible, which is what lets the
  // monster tests assert on behaviour instead of on luck.
  constructor(opts = {}) {
    this.players = new Map();       // id -> player
    this.phase = 'lobby';           // lobby | playing | ended
    this.hostId = null;
    this.cfg = { size: 'medium', fuses: 6, difficulty: 'normal' };
    this.map = null;
    this.grid = null;
    this.monsters = [];
    this.fuses = [];
    this.batteries = [];
    this.gas = null;
    this.sabotage = null;
    this.fire = 0;
    this.ending = null;
    this.powered = 0;
    this.generatorOn = false;
    this.door = { phase: DOOR_SHUT, timer: 0, by: null };
    this.back = null;               // the Backrooms layout, once a round starts
    this.backGrid = null;
    this.weapon = null;
    this.tick = 0;
    this.roundTime = 0;
    this.endsAt = 0;
    this.outcome = null;
    this.rng = makeRng(opts.seed !== undefined ? opts.seed : ((Date.now() ^ 0x5f3a) >>> 0));
    this.ambientTimer = 8;
  }

  // --- Connection lifecycle ------------------------------------------------

  addPlayer(conn, rawName) {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send({ t: 'full' });
      conn.close(1000, 'server full');
      return null;
    }
    const id = nextPlayerId++;
    const usedColors = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) ?? PLAYER_COLORS[id % PLAYER_COLORS.length];

    const player = {
      id, conn,
      name: sanitiseName(rawName, id),
      color,
      ready: false,
      state: ST_ALIVE,
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
      flags: 0,
      zone: Z_FACILITY,
      hp: PLAYER_HP,
      climb: 0,             // 0..1 up the ladder, > 0 means control is taken
      charge: 100,          // flashlight charge, 0-100
      reserve: 0,           // spare batteries carried

      carrying: null,
      carryingGas: false,
      downTimer: 0,
      downs: 0,
      bleedTotal: 0,
      stats: { fuses: 0, revives: 0, escaped: false, batteries: 0 },
      lastInput: Date.now(),
      joinedMidRound: false,
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
      // Drop-in co-op: latecomers materialise at the entrance, mid-round.
      player.joinedMidRound = true;
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
    if (player.carryingGas) this.dropGasoline(player);
    if (this.weapon && this.weapon.holder === player.id) this.dropWeapon(player);
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.players.keys().next().value ?? null;
    this.event({ k: 'left', name: player.name });
    this.broadcastLobby();
    if (this.phase === 'playing') this.checkRoundOver();
    if (this.players.size === 0) this.resetToLobby();
  }

  // --- Inbound messages ----------------------------------------------------

  handle(player, msg) {
    switch (msg.t) {
      case 'input':   return this.onInput(player, msg);
      case 'use':     return this.onUse(player, msg);
      case 'shoot':   return this.onShoot(player, msg);
      case 'rl':      return this.reloadWeapon(player);
      case 'chat':    return this.onChat(player, msg);
      case 'ready':   return this.onReady(player);
      case 'cfg':     return this.onConfig(player, msg);
      case 'start':   return this.onStart(player);
      case 'name':    return this.onRename(player, msg);
      case 'ping':    return player.conn.send({ t: 'pong', c: msg.c });
      default:        return undefined;
    }
  }

  onInput(player, msg) {
    if (this.phase !== 'playing' || !Array.isArray(msg.p)) return;
    const [nx, ny, nz] = msg.p;
    if (![nx, ny, nz].every(Number.isFinite)) return;

    const now = Date.now();
    const dt = Math.min(0.5, (now - player.lastInput) / 1000);
    player.lastInput = now;

    // Aim is always the client's to give. Position is not, once the ladder has
    // taken over: the climb is a fixed move and nothing about it is negotiable.
    player.yaw = Number.isFinite(msg.y) ? msg.y : player.yaw;
    if (Number.isFinite(msg.pt)) player.pitch = Math.max(-1.6, Math.min(1.6, msg.pt));

    if (player.climb > 0) {
      player.flags = (player.flags & ~CLIENT_FLAGS) | F_CLIMB;
      return;
    }

    // Movement clamp: allow a generous margin for latency spikes, but nothing
    // resembling a teleport.
    const budget = SPEED.sprint * 1.6 * dt + 0.6;
    const dx = nx - player.x, dz = nz - player.z;
    const moved = Math.hypot(dx, dz);
    if (moved > budget) {
      const s = budget / moved;
      player.x += dx * s;
      player.z += dz * s;
    } else if (this.isSolidAt(nx, nz, player.zone) || this.crossesSolid(player, nx, nz)) {
      // Inside geometry, or a step that would pass through it on the way -
      // ignore, and keep the last legal position.
    } else {
      player.x = nx;
      player.z = nz;
    }
    // A player who has walked through the doorway must not still be standing in
    // the facility as far as the server is concerned.
    if (moved > 0) this.clampToAperture(player);
    player.y = Math.max(-2, Math.min(4, ny));
    // The client owns stance and light; the server owns everything that can be
    // claimed rather than chosen.
    player.flags = (player.flags & ~CLIENT_FLAGS) | ((msg.f | 0) & CLIENT_FLAGS);
    if (player.state !== ST_ALIVE) player.flags &= ~(F_SPRINT | F_MOVING);
  }

  onUse(player, msg) {
    if (this.phase !== 'playing') return;
    switch (msg.k) {
      case 'fuse':   return this.pickUpFuse(player, msg.id);
      case 'insert': return this.insertFuse(player);
      case 'revive': return this.revive(player, msg.id);
      case 'drop':   return this.dropFuse(player);
      case 'battery': return this.takeBattery(player, msg.id);
      case 'reload': return this.reloadFlashlight(player);
      case 'power':  return this.toggleGenerator(player);
      case 'gas':    return this.takeGasoline(player);
      case 'pour':   return this.pourGasoline(player);
      case 'button': return this.pressDoorButton(player);
      case 'weapon': return this.takeWeapon(player);
      case 'dropgun': return this.dropWeapon(player);
      case 'ladder': return this.startClimb(player);
      default:       return undefined;
    }
  }

  onChat(player, msg) {
    const text = String(msg.m ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180).trim();
    if (!text) return;
    this.broadcast({ t: 'chat', from: player.name, color: player.color, m: text });
  }

  onReady(player) {
    player.ready = !player.ready;
    this.broadcastLobby();
  }

  onRename(player, msg) {
    player.name = sanitiseName(msg.name, player.id);
    this.broadcastLobby();
  }

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

  // --- Round lifecycle -----------------------------------------------------

  startRound() {
    this.map = generate({
      seed: (this.rng() * 0xffffffff) >>> 0,
      size: this.cfg.size,
      fuseCount: this.cfg.fuses,
    });
    this.grid = Uint8Array.from(this.map.grid, (c) => +c);
    this.distFromSpawn = bfsDistances(this.grid, this.map.w, this.map.h, { cx: this.map.spawn.cx, cy: this.map.spawn.cy });
    this.floorCells = [];
    for (let y = 1; y < this.map.h - 1; y++) {
      for (let x = 1; x < this.map.w - 1; x++) {
        if (this.grid[idx(x, y, this.map.w)] === 1) this.floorCells.push({ cx: x, cy: y });
      }
    }

    this.fuses = this.map.fuses.map((f) => ({ id: f.id, x: f.x, z: f.z, state: 0, holder: null }));
    this.batteries = this.map.batteries.map((b) => ({ id: b.id, x: b.x, z: b.z, taken: false }));
    this.gas = this.map.gasoline
      ? { x: this.map.gasoline.x, z: this.map.gasoline.z, state: 0, holder: null }
      : null;
    this.gun = null;
    this.weapon = this.map.weapon
      ? {
        x: this.map.weapon.x, z: this.map.weapon.z,
        state: 0, holder: null,
        mag: MAG_SIZE, reserve: AMMO_RESERVE,
        nextShot: 0, reloading: 0,
      }
      : null;

    // What is behind the door. Built up front so every client gets it with the
    // map, and so nothing has to be generated at the moment of transition.
    this.back = BACKROOMS.generate(this.map.seed);
    this.backGrid = Uint8Array.from(this.back.grid, (c) => +c);

    this.sabotage = null;
    this.fire = 0;
    this.ending = null;
    this.powered = 0;
    this.door = { phase: DOOR_SHUT, timer: 0, by: null };
    this.generatorOn = false;
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
      p.bleedTotal = 0;
      p.ready = false;
      p.joinedMidRound = false;
      p.stats = { fuses: 0, revives: 0, escaped: false, batteries: 0 };
      p.charge = 100;
      p.reserve = 0;
      p.carryingGas = false;
      p.zone = Z_FACILITY;
      p.hp = PLAYER_HP;
      p.climb = 0;
      p.flags = 0;
      this.placeAtSpawn(p);
    }

    this.broadcast(this.beginPayload());
  }

  beginPayload() {
    return {
      t: 'begin',
      map: this.map,
      back: this.back,
      cfg: this.cfg,
      difficulty: this.difficulty().label,
      need: this.map.fuseCount,
    };
  }

  placeAtSpawn(player) {
    const points = this.map.spawnPoints;
    const p = points[(player.id + this.tick) % points.length];
    player.x = p.x + (this.rng() - 0.5) * 1.2;
    player.z = p.z + (this.rng() - 0.5) * 1.2;
    player.y = 0;
  }

  spawnMonster(index, diff) {
    // Monsters wake up as far from the survivors' entrance as the map allows.
    const far = this.floorCells
      .filter((c) => (this.distFromSpawn[idx(c.cx, c.cy, this.map.w)] ?? 0) > 0)
      .sort((a, b) => this.distFromSpawn[idx(b.cx, b.cy, this.map.w)] - this.distFromSpawn[idx(a.cx, a.cy, this.map.w)]);
    const cell = far[Math.min(far.length - 1, index * 3)] || { cx: 1, cy: 1 };
    const pos = this.cellCenter(cell);
    return {
      id: index,
      x: pos.x, z: pos.z, yaw: 0,
      state: 'sleeping',
      timer: diff.grace + index * 15,
      exposure: new Map(),      // per-player seconds held in view
      searchTimer: 0,
      hp: MONSTER_HP,
      stagger: 0,
      rage: 0,               // it comes back faster every time it is put down
      path: [], pathIdx: 0, repathIn: 0,
      targetId: null,
      lastKnown: null,
      loseTimer: 6,
      attackCooldown: 0,
      screamCooldown: 0,
    };
  }

  resetToLobby() {
    this.phase = 'lobby';
    this.monsters = [];
    this.fuses = [];
    this.batteries = [];
    this.generatorOn = false;
    this.door = { phase: DOOR_SHUT, timer: 0, by: null };
    this.gas = null;
    this.weapon = null;
    this.sabotage = null;
    this.fire = 0;
    this.ending = null;
    this.map = null;
    this.grid = null;
    this.back = null;
    this.backGrid = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.state = ST_ALIVE;
      p.carrying = null;
      p.zone = Z_FACILITY;
      p.climb = 0;
      p.flags = 0;
    }
    this.broadcastLobby();
  }

  difficulty() { return DIFFICULTY[this.cfg.difficulty] || DIFFICULTY.normal; }

  // --- Objectives ----------------------------------------------------------

  pickUpFuse(player, fuseId) {
    if (player.state !== ST_ALIVE || player.carrying !== null) return;
    const fuse = this.fuses.find((f) => f.id === fuseId);
    if (!fuse || fuse.state !== 0) return;
    if (dist2(player.x, player.z, fuse.x, fuse.z) > 3.2 * 3.2) return;
    fuse.state = 1;
    fuse.holder = player.id;
    player.carrying = fuse.id;
    // A fuse is a live cell: handling one tops the flashlight right up. That
    // is the reward for the risk of carrying it across the map.
    const recharged = player.charge < 99.5;
    player.charge = 100;
    this.event({ k: 'pickup', x: fuse.x, z: fuse.z, by: player.name, id: player.id, recharged });
    this.hearNoise(player.x, player.z, 0.55);
  }

  dropFuse(player) {
    if (player.carrying === null) return;
    const fuse = this.fuses.find((f) => f.id === player.carrying);
    player.carrying = null;
    if (!fuse) return;
    fuse.state = 0;
    fuse.holder = null;
    fuse.x = player.x;
    fuse.z = player.z;
    this.event({ k: 'drop', x: fuse.x, z: fuse.z });
  }

  insertFuse(player) {
    if (player.state !== ST_ALIVE || player.carrying === null) return;
    const gen = this.map.generator;
    if (dist2(player.x, player.z, gen.x, gen.z) > 4.0 * 4.0) return;

    const fuse = this.fuses.find((f) => f.id === player.carrying);
    if (fuse) { fuse.state = 2; fuse.holder = null; }
    player.carrying = null;
    player.stats.fuses++;
    this.powered++;

    const complete = this.powered >= this.map.fuseCount;
    this.event({ k: 'fuse', n: this.powered, need: this.map.fuseCount, by: player.name, x: gen.x, z: gen.z });

    // Slamming a fuse home is loud, and the generator surge is louder still.
    this.hearNoise(gen.x, gen.z, complete ? 3.0 : 1.6);

    if (complete) {
      this.generatorOn = true;
      // Power reaches the door's control panel. It does not open the door -
      // somebody still has to walk over there and press the button.
      this.event({ k: 'door-power', on: true, x: this.map.door.panel.x, z: this.map.door.panel.z });
      this.event({ k: 'power', on: true, x: gen.x, z: gen.z });
      for (const m of this.monsters) {
        if (m.state === 'sleeping' || m.state === 'waking' || m.state === 'downed') continue;
        m.state = 'search';
        m.searchTimer = SEARCH_TIME;
        m.lastKnown = { x: gen.x, z: gen.z };
        m.repathIn = 0;
      }
    }
  }

// Batteries are the flashlight's ammunition: collected into a reserve, never
  // spent on the spot.
  takeBattery(player, batteryId) {
    if (player.state !== ST_ALIVE) return;
    const battery = this.batteries.find((b) => b.id === batteryId);
    if (!battery || battery.taken) return;
    if (dist2(player.x, player.z, battery.x, battery.z) > 3.2 * 3.2) return;
    if (player.reserve >= MAX_RESERVE) return;

    battery.taken = true;
    player.reserve++;
    player.stats.batteries++;
    this.event({ k: 'battery', by: player.name, id: player.id, x: battery.x, z: battery.z, n: player.reserve });
  }

  // One battery, one full charge. Never the whole reserve at once.
  reloadFlashlight(player) {
    if (player.state !== ST_ALIVE) return;
    if (player.reserve <= 0) return;
    if (player.charge >= 99.5) return;      // nothing to gain, keep the battery
    player.reserve--;
    player.charge = 100;
    this.event({ k: 'reload', id: player.id, n: player.reserve });
    this.hearNoise(player.x, player.z, 0.35);
  }

  // The building's power switch. Only throwable once every fuse is seated,
  // and authoritative: one flag, broadcast to everyone, so nobody disagrees
  // about whether the lights are on.
  toggleGenerator(player) {
    if (player.state !== ST_ALIVE) return;
    if (this.powered < this.map.fuseCount) return;
    const gen = this.map.generator;
    if (dist2(player.x, player.z, gen.x, gen.z) > 4.0 * 4.0) return;

    this.generatorOn = !this.generatorOn;
    this.event({ k: 'power', on: this.generatorOn, by: player.name, x: gen.x, z: gen.z });
    // The panel beside the door lights up or dies with the supply. A door that
    // is already up stays up: the motor has done its work.
    this.event({ k: 'door-power', on: this.generatorOn, x: this.map.door.panel.x, z: this.map.door.panel.z });
    // Throwing the switch either way is loud.
    this.hearNoise(gen.x, gen.z, 2.0);
  }

// --- Ending 2: the fuel can ----------------------------------------------

  takeGasoline(player) {
    if (player.state !== ST_ALIVE || !this.gas || this.gas.state !== 0) return;
    if (player.carrying !== null || player.carryingGas) return;   // one thing at a time
    if (dist2(player.x, player.z, this.gas.x, this.gas.z) > 3.2 * 3.2) return;

    this.gas.state = 1;
    this.gas.holder = player.id;
    player.carryingGas = true;
    this.event({ k: 'gas-taken', by: player.name, id: player.id });
    this.hearNoise(player.x, player.z, 0.5);
  }

  dropGasoline(player) {
    if (!player.carryingGas || !this.gas) return;
    player.carryingGas = false;
    this.gas.state = 0;
    this.gas.holder = null;
    this.gas.x = player.x;
    this.gas.z = player.z;
    this.event({ k: 'gas-dropped', x: this.gas.x, z: this.gas.z });
  }

  // Emptying the can into the generator. This does not explode anything on its
  // own - it starts a timeline the whole server then plays out together.
  pourGasoline(player) {
    if (player.state !== ST_ALIVE || !player.carryingGas) return;
    if (this.sabotage || this.ending) return;
    const gen = this.map.generator;
    if (dist2(player.x, player.z, gen.x, gen.z) > 4.0 * 4.0) return;

    player.carryingGas = false;
    this.gas.state = 2;
    this.gas.holder = null;
    this.sabotage = { phase: 'unstable', timer: UNSTABLE_TIME, sparkIn: 0 };

    this.event({ k: 'sabotage', by: player.name, x: gen.x, z: gen.z, seconds: UNSTABLE_TIME });
    // Pouring is loud, and the generator labouring is louder.
    this.hearNoise(gen.x, gen.z, 2.5);
  }

  // Runs the unstable -> explosion -> burning -> ending sequence.
  updateSabotage(dt) {
    if (!this.sabotage) return;
    const gen = this.map.generator;
    const s = this.sabotage;
    s.timer -= dt;

    if (s.phase === 'unstable') {
      // Sparks and lurching, at a pace the clients can render cheaply.
      s.sparkIn -= dt;
      if (s.sparkIn <= 0) {
        s.sparkIn = 0.6 + this.rng() * 0.7;
        this.event({ k: 'spark', x: gen.x, z: gen.z, left: Math.max(0, Math.round(s.timer)) });
      }
      if (s.timer <= 0) {
        s.phase = 'burning';
        s.timer = BURN_TIME;
        // The generator tears itself apart, and the panel by the door goes dark
        // with it. A shutter already raised stays raised.
        this.generatorOn = false;
        this.fire = 0.001;
        this.event({ k: 'door-power', on: false, x: this.map.door.panel.x, z: this.map.door.panel.z });
        this.event({ k: 'explosion', x: gen.x, z: gen.z });
        // Everything in the building hears that.
        for (const m of this.monsters) {
          if (m.state === 'sleeping' || m.state === 'waking') continue;
          m.state = 'search';
          m.searchTimer = SEARCH_TIME;
          m.lastKnown = { x: gen.x, z: gen.z };
          m.repathIn = 0;
        }
      }
      return;
    }

    if (s.phase === 'burning') {
      // Fire spreads outward from the generator over the burn window.
      this.fire = Math.min(1, 1 - s.timer / BURN_TIME);
      if (s.timer <= 0) this.endRound('burned');
    }
  }

  revive(player, targetId) {
    if (player.state !== ST_ALIVE) return;
    const target = this.players.get(targetId);
    if (!target || target.state !== ST_DOWN) return;
    if (dist2(player.x, player.z, target.x, target.z) > 3.0 * 3.0) return;
    target.state = ST_ALIVE;
    target.downTimer = 0;
    target.hp = PLAYER_HP;
    player.stats.revives++;
    this.event({ k: 'revive', by: player.name, who: target.name, id: target.id, x: target.x, z: target.z });
    this.hearNoise(target.x, target.z, 0.9);
  }

  // --- The emergency door -----------------------------------------------------

  // The button on the panel beside the door. Nothing else opens it: not the
  // generator coming up, not standing near it, not the round ending.
  pressDoorButton(player) {
    if (player.state !== ST_ALIVE || player.zone !== Z_FACILITY) return;
    if (this.door.phase !== DOOR_SHUT) return;
    const panel = this.map.door.panel;
    if (dist2(player.x, player.z, panel.x, panel.z) > 3.0 * 3.0) return;
    if (!this.generatorOn) {
      // Dead panel. Worth a click so the player knows they pressed it.
      this.event({ k: 'door-dead', id: player.id, x: panel.x, z: panel.z });
      return;
    }

    this.door.phase = DOOR_OPENING;
    this.door.timer = DOOR_OPEN_TIME;
    this.door.by = player.name;
    this.event({
      k: 'door-open', by: player.name, id: player.id,
      seconds: DOOR_OPEN_TIME, x: this.map.door.x, z: this.map.door.z,
    });
    // Six seconds of motor and rattling steel, in a building with something
    // listening in it.
    this.hearNoise(this.map.door.x, this.map.door.z, 3.4);
  }

  updateDoor(dt) {
    if (this.door.phase !== DOOR_OPENING) return;
    this.door.timer -= dt;
    if (this.door.timer > 0) return;
    this.door.timer = 0;
    this.door.phase = DOOR_OPEN;
    this.event({ k: 'door-opened', x: this.map.door.x, z: this.map.door.z });
  }

  doorProgress() {
    if (this.door.phase === DOOR_OPEN) return 1;
    if (this.door.phase !== DOOR_OPENING) return 0;
    return Math.max(0, Math.min(1, 1 - this.door.timer / DOOR_OPEN_TIME));
  }

  // --- Through the door --------------------------------------------------------

  // Reaching the end of the passage behind the door. Not an ending - the round
  // carries on, somewhere else.
  updateTransitions() {
    if (this.door.phase !== DOOR_OPEN || !this.back) return;
    const t = this.map.door.threshold;
    for (const p of this.players.values()) {
      if (p.zone !== Z_FACILITY || p.state !== ST_ALIVE) continue;
      if (dist2(p.x, p.z, t.x, t.z) > 2.4 * 2.4) continue;
      this.enterBackrooms(p);
    }
  }

  enterBackrooms(player) {
    const entry = this.back.entry;
    // Spread arrivals so two people never land inside each other.
    const spread = ((player.id % 4) - 1.5) * 1.1;
    player.zone = Z_BACKROOMS;
    // There is nothing to see by in here that is not already lit. Putting the
    // flashlight out on the way through means nobody burns the last of a
    // battery on a corridor that is brighter than the beam.
    player.flags &= ~F_LIGHT;
    player.x = entry.x;
    player.z = entry.z + spread;
    player.y = 0;
    player.yaw = entry.yaw;
    // Nothing follows you through, and nothing you were carrying matters here.
    // The rifle stays behind too - there is nothing to shoot on this side, and
    // taking the only one out of the facility would strand whoever is left.
    if (player.carrying !== null) this.dropFuse(player);
    if (player.carryingGas) this.dropGasoline(player);
    if (this.weapon && this.weapon.holder === player.id) this.dropWeapon(player);
    for (const m of this.monsters) {
      if (m.targetId === player.id) { m.targetId = null; m.lastKnown = null; }
      m.exposure.delete(player.id);
    }
    this.event({
      k: 'backrooms', id: player.id, who: player.name,
      x: player.x, z: player.z, yaw: player.yaw,
    });
  }

  // --- The ladder --------------------------------------------------------------

  startClimb(player) {
    if (player.state !== ST_ALIVE || player.zone !== Z_BACKROOMS) return;
    if (player.climb > 0 || !this.back) return;
    const l = this.back.ladder;
    if (dist2(player.x, player.z, l.x, l.z) > 2.2 * 2.2) return;
    // Snap to the rungs, then the climb owns the player until it finishes.
    player.x = l.x - Math.sin(l.yaw) * 0.55;
    player.z = l.z - Math.cos(l.yaw) * 0.55;
    player.yaw = l.yaw;
    player.climb = 0.0001;
    player.flags = (player.flags & ~CLIENT_FLAGS) | F_CLIMB;
    this.event({ k: 'climb', id: player.id, who: player.name, seconds: CLIMB_TIME });
  }

  updateClimbs(dt) {
    if (!this.back) return;
    for (const p of this.players.values()) {
      if (p.climb <= 0) continue;
      if (p.state !== ST_ALIVE) { p.climb = 0; p.flags &= ~F_CLIMB; continue; }
      p.climb = Math.min(1, p.climb + dt / CLIMB_TIME);
      p.y = this.back.ladder.top * p.climb;
      if (p.climb < 1) continue;

      // Into the vent. This is the way out.
      p.climb = 0;
      p.flags &= ~F_CLIMB;
      p.state = ST_ESCAPED;
      p.stats.escaped = true;
      this.event({ k: 'vent', who: p.name, id: p.id });
      this.checkRoundOver();
    }
  }

  // --- The rifle ---------------------------------------------------------------

  takeWeapon(player) {
    if (player.state !== ST_ALIVE || !this.weapon || this.weapon.state !== 0) return;
    if (player.zone !== Z_FACILITY) return;
    if (dist2(player.x, player.z, this.weapon.x, this.weapon.z) > 3.2 * 3.2) return;
    this.weapon.state = 1;
    this.weapon.holder = player.id;
    this.weapon.reloading = 0;
    this.weapon.nextShot = this.roundTime;
    player.flags |= F_GUN;
    this.event({ k: 'gun-taken', by: player.name, id: player.id });
    this.hearNoise(player.x, player.z, 0.4);
  }

  dropWeapon(player) {
    if (!this.weapon || this.weapon.holder !== player.id) return;
    this.weapon.state = 0;
    this.weapon.holder = null;
    this.weapon.reloading = 0;
    this.weapon.x = player.x;
    this.weapon.z = player.z;
    player.flags &= ~(F_GUN | F_RELOAD);
    this.event({ k: 'gun-dropped', x: this.weapon.x, z: this.weapon.z, id: player.id });
  }

  reloadWeapon(player) {
    const gun = this.weapon;
    if (!gun || gun.holder !== player.id || player.state !== ST_ALIVE) return;
    if (gun.reloading > 0 || gun.mag >= MAG_SIZE || gun.reserve <= 0) return;
    gun.reloading = RELOAD_TIME;
    player.flags |= F_RELOAD;
    this.event({ k: 'gun-reload', id: player.id, seconds: RELOAD_TIME });
    this.hearNoise(player.x, player.z, 0.5);
  }

  updateWeapon(dt) {
    const gun = this.weapon;
    if (!gun || gun.reloading <= 0) return;
    gun.reloading -= dt;
    if (gun.reloading > 0) return;
    gun.reloading = 0;
    const holder = this.players.get(gun.holder);
    const take = Math.min(MAG_SIZE - gun.mag, gun.reserve);
    gun.mag += take;
    gun.reserve -= take;
    if (holder) holder.flags &= ~F_RELOAD;
    this.event({ k: 'gun-reloaded', id: gun.holder, mag: gun.mag, reserve: gun.reserve });
  }

  // Every shot is judged here. The client sends where it was pointing; it does
  // not get to say what it hit, how far the bullet travelled, or whether it had
  // a round to fire in the first place.
  onShoot(player, msg) {
    if (this.phase !== 'playing' || player.state !== ST_ALIVE) return;
    const gun = this.weapon;
    if (!gun || gun.holder !== player.id || gun.reloading > 0) return;
    if (!Array.isArray(msg.d) || msg.d.length !== 3) return;

    // Rate limit first, so a client that spams cannot even generate events.
    // Anything owed from before the catch-up window is forfeited, so a client
    // that holds its fire cannot bank a magazine's worth of instant shots.
    gun.nextShot = Math.max(gun.nextShot, this.roundTime - FIRE_CATCHUP);
    if (this.roundTime < gun.nextShot) return;
    gun.nextShot += FIRE_INTERVAL;

    if (gun.mag <= 0) {
      // Dry clicks are worth hearing, but not eleven times a second.
      gun.nextShot = this.roundTime + 0.4;
      this.event({ k: 'dry', id: player.id });
      return;
    }

    const dir = normalise(msg.d);
    if (!dir) return;
    gun.mag--;

    const eye = (player.flags & F_CROUCH) ? 1.02 : 1.62;
    const origin = { x: player.x, y: eye, z: player.z };
    const wall = this.rayWallDistance(origin, dir, AK_RANGE, player.zone);
    const hit = this.rayTarget(origin, dir, wall, player);

    const at = hit ? hit.t : wall;
    this.event({
      k: 'shot', id: player.id,
      x: round2(origin.x), y: round2(origin.y), z: round2(origin.z),
      dx: round2(dir.x), dy: round2(dir.y), dz: round2(dir.z),
      d: round2(at),
      h: hit ? hit.kind : 0,
      mag: gun.mag,
    });

    if (hit && hit.kind === 1) this.damageMonster(hit.target, AK_DAMAGE_MONSTER, player);
    if (hit && hit.kind === 2) this.damagePlayer(hit.target, AK_DAMAGE_PLAYER, player);

    // A rifle going off in a concrete building is the loudest thing in the game.
    this.hearNoise(player.x, player.z, 4.0);
    for (const m of this.monsters) {
      if (m.state !== 'sleeping') continue;
      // It does not sleep through gunfire, wherever it was in its own good time.
      m.timer = Math.min(m.timer, 10);
    }
  }

  // Marches the shot through the grid and returns how far it gets before it
  // buries itself in something solid.
  rayWallDistance(origin, dir, maxDist, zone) {
    const step = 0.22;
    for (let t = step; t <= maxDist; t += step) {
      const x = origin.x + dir.x * t;
      const z = origin.z + dir.z * t;
      const y = origin.y + dir.y * t;
      if (y <= 0.02 || y >= this.zoneHeight(zone)) return t;
      if (this.isSolidAt(x, z, zone)) return t;
    }
    return maxDist;
  }

  // The nearest body the shot passes through on its way to the wall. Monsters
  // and survivors alike: there is no friendly-fire exemption.
  rayTarget(origin, dir, maxDist, shooter) {
    const horiz = Math.hypot(dir.x, dir.z);
    let best = null;

    const test = (tx, tz, radius, base, height, kind, target) => {
      if (horiz < 1e-4) return;
      const t = ((tx - origin.x) * dir.x + (tz - origin.z) * dir.z) / (horiz * horiz);
      if (t <= 0.4 || t > maxDist) return;
      const px = origin.x + dir.x * t, pz = origin.z + dir.z * t;
      if (Math.hypot(px - tx, pz - tz) > radius) return;
      const py = origin.y + dir.y * t;
      if (py < base || py > base + height) return;
      if (!best || t < best.t) best = { t, kind, target };
    };

    if (shooter.zone === Z_FACILITY) {
      for (const m of this.monsters) {
        if (m.state === 'downed') continue;
        test(m.x, m.z, 0.62, 0, 2.3, 1, m);
      }
    }
    for (const p of this.players.values()) {
      if (p.id === shooter.id || p.zone !== shooter.zone) continue;
      if (p.state !== ST_ALIVE && p.state !== ST_DOWN) continue;
      const crouched = (p.flags & F_CROUCH) !== 0;
      test(p.x, p.z, 0.42, 0, crouched ? 1.25 : 1.85, 2, p);
    }
    return best;
  }

  damageMonster(m, amount, shooter) {
    if (m.state === 'downed') return;
    m.hp -= amount;
    m.stagger = MONSTER_STAGGER;
    // Being shot tells it exactly where you are. That is the trade.
    m.lastKnown = { x: shooter.x, z: shooter.z };
    m.exposure.set(shooter.id, 99);

    if (m.hp > 0) {
      if (m.state === 'sleeping' || m.state === 'waking') {
        m.state = 'waking';
        m.timer = Math.min(m.timer, 2);
      } else if (m.state !== 'chase' && m.state !== 'attack') {
        m.state = 'chase';
        m.targetId = shooter.id;
        m.loseTimer = LOSE_GRACE;
        m.repathIn = 0;
      }
      this.event({ k: 'monster-hit', id: m.id, x: round2(m.x), z: round2(m.z), hp: Math.max(0, m.hp) });
      return;
    }

    // Put down, not killed. It gets back up, and it is faster afterwards.
    m.state = 'downed';
    m.timer = MONSTER_DOWN_TIME;
    m.path = [];
    m.targetId = null;
    m.lastKnown = null;
    m.exposure.clear();
    this.event({ k: 'monster-down', id: m.id, x: round2(m.x), z: round2(m.z), by: shooter.name });
  }

  damagePlayer(target, amount, shooter) {
    if (target.state !== ST_ALIVE) return;
    target.hp -= amount;
    this.event({
      k: 'friendly', id: target.id, by: shooter.name, who: target.name,
      hp: Math.max(0, target.hp), x: round2(target.x), z: round2(target.z),
    });
    if (target.hp > 0) return;
    target.hp = 0;
    this.downPlayer(target, null);
  }

  downPlayer(player, monster) {
    if (player.state !== ST_ALIVE) return;
    // Once the facility is burning the ending is committed; the monster must
    // not be able to make it unreachable.
    if (this.ending || (this.sabotage && this.sabotage.phase === 'burning')) return;
    player.state = ST_DOWN;
    player.downs++;
    // Each rescue buys less time than the last: the third mistake is usually fatal.
    player.downTimer = this.difficulty().bleed * Math.pow(0.72, player.downs - 1);
    player.hp = 0;
    player.climb = 0;
    player.flags &= ~F_CLIMB;
    if (player.carrying !== null) this.dropFuse(player);
    if (player.carryingGas) this.dropGasoline(player);
    if (this.weapon && this.weapon.holder === player.id) this.dropWeapon(player);
    this.event({ k: 'down', who: player.name, id: player.id, x: player.x, z: player.z });
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
    const anyActive = all.some((p) => p.state === ST_ALIVE || p.state === ST_DOWN);
    if (anyActive) return;
    const anyEscaped = all.some((p) => p.state === ST_ESCAPED);
    this.endRound(anyEscaped ? 'escaped' : 'lost');
  }

  endRound(outcome) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.outcome = outcome;
    this.ending = outcome;
    this.endsAt = Date.now() + 14000;
    this.broadcast({
      t: 'end',
      outcome,
      time: Math.round(this.roundTime),
      powered: this.powered,
      need: this.map ? this.map.fuseCount : this.cfg.fuses,
      players: [...this.players.values()].map((p) => ({
        name: p.name, color: p.color, ...p.stats,
        state: p.state, downs: p.downs,
      })),
    });
  }

  // --- Simulation ----------------------------------------------------------

  update(dt) {
    if (this.phase === 'ended' && Date.now() > this.endsAt) { this.resetToLobby(); return; }
    if (this.phase !== 'playing') return;

    this.tick++;
    this.roundTime += dt;

    for (const p of this.players.values()) {
      if (p.state === ST_DOWN) {
        p.downTimer -= dt;
        p.bleedTotal += dt;
        if (p.downTimer <= 0) this.killPlayer(p);
      }
    }

    this.updateSabotage(dt);
    this.updateDoor(dt);
    this.updateTransitions();
    this.updateClimbs(dt);
    this.updateWeapon(dt);
    this.drainFlashlights(dt);
    for (const m of this.monsters) this.updateMonster(m, dt);
    this.updateDirector(dt);

    if (this.tick % SNAP_EVERY === 0) this.sendSnapshot();
  }

// Charge is spent on the server so every client agrees how much light a
  // player has left, and so a tampered client cannot grant itself infinite
  // battery. Clients predict the same drain locally to keep the bar smooth.
  drainFlashlights(dt) {
    for (const p of this.players.values()) {
      if (!(p.flags & F_LIGHT)) continue;
      if (p.state !== ST_ALIVE) continue;
      if (p.zone !== Z_FACILITY) continue;      // nothing here needs a torch
      if (p.charge <= 0) continue;
      p.charge = Math.max(0, p.charge - FLASHLIGHT_DRAIN * dt);
      if (p.charge === 0) {
        // Out of power: the light is off until they load a fresh battery.
        p.flags &= ~F_LIGHT;
        this.event({ k: 'dead-battery', id: p.id });
      }
    }
  }

  // How loud and how visible a player is, by stance. Crouching is the whole
  // stealth system: it cuts what the monster can hear to almost nothing and,
  // crucially, shrinks how far away it can pick you out at all.
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

  // What one monster can currently tell about one player. Nothing here reaches
  // through geometry: sight needs line of sight, and hearing is a range check
  // that yields a position, never a lock.
  perceive(m, p, hearing, sight) {
    const d = Math.hypot(p.x - m.x, p.z - m.z);
    const stance = this.stanceOf(p);
    let noise = stance.noise;
    let visibility = stance.visibility;

    // Working on something - seating a fuse, pouring fuel - is loud.
    if (p.flags & F_BUSY) noise = Math.max(noise, 0.8);
    // A lit flashlight is the single loudest thing you can do to your profile.
    if (p.flags & F_LIGHT) { noise += 0.25; visibility *= 2.0; }
    // Lit rooms make you easier to see. They do not make you noisier.
    if (this.generatorOn) visibility *= 1.35;

    const heard = d < hearing * noise;
    // Sight is gated behind line of sight, always.
    const los = (heard || d < sight * visibility)
      ? hasLineOfSight(this.grid, this.map.w, this.map.h, this.map.cell, m.x, m.z, p.x, p.z)
      : false;
    const seen = los && d < sight * visibility;
    return { d, los, heard, seen, noise, visibility };
  }

  updateMonster(m, dt) {
    const diff = this.difficulty();
    const aggro = this.map.fuseCount ? this.powered / this.map.fuseCount : 0;
    // Rage is what a magazine buys you: it comes back harder each time.
    const speedMul = (1 + aggro * 0.16) * (1 + m.rage * 0.1);
    const hearing = diff.hearing * (1 + aggro * 0.4);
    const sight = diff.sight * (1 + aggro * 0.2);

    m.attackCooldown = Math.max(0, m.attackCooldown - dt);
    m.screamCooldown = Math.max(0, m.screamCooldown - dt);
    m.stagger = Math.max(0, m.stagger - dt);

    // --- Put down by gunfire -------------------------------------------------
    if (m.state === 'downed') {
      m.timer -= dt;
      if (m.timer <= 0) {
        m.state = 'waking';
        m.timer = WAKE_DURATION * 0.6;
        m.hp = MONSTER_HP;
        m.rage = Math.min(4, m.rage + 1);
        m.path = [];
        this.event({ k: 'monster-rise', id: m.id, x: round2(m.x), z: round2(m.z) });
      }
      return;
    }

    // --- Sleeping: the exploration phase ------------------------------------
    if (m.state === 'sleeping') {
      m.timer -= dt;
      if (m.timer <= 0) {
        m.state = 'waking';
        m.timer = WAKE_DURATION;
        // An event in its own right, not a silent flag flip.
        this.event({ k: 'waking', x: m.x, z: m.z, id: m.id });
      }
      return;
    }

    // --- Waking: it gets up, and everyone hears it ---------------------------
    if (m.state === 'waking') {
      m.timer -= dt;
      if (m.timer <= 0) {
        m.state = 'patrol';
        m.path = [];
        this.event({ k: 'awake', x: m.x, z: m.z, id: m.id });
      }
      return;
    }

    // --- Perception ----------------------------------------------------------
    let best = null;
    for (const p of this.players.values()) {
      if (p.state !== ST_ALIVE && p.state !== ST_DOWN) continue;
      // Nothing on the other side of the door registers at all.
      if (p.zone !== Z_FACILITY) continue;
      const info = this.perceive(m, p, hearing, sight);
      if (!info.heard && !info.seen) {
        // Exposure decays while it cannot see you, so slipping behind a crate
        // for a moment genuinely helps.
        const cur = m.exposure.get(p.id) || 0;
        if (cur > 0) m.exposure.set(p.id, Math.max(0, cur - dt * 1.5));
        continue;
      }

      // Being visible is not instant recognition. A crouching player has to be
      // held in view far longer before the monster is sure enough to commit.
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

    // --- Acquisition ---------------------------------------------------------
    if (best && m.state !== 'retreat' && m.state !== 'attack') {
      if (best.acquired && best.p.state === ST_ALIVE) {
        // Seen clearly enough to commit: lock on.
        if (m.state !== 'chase') {
          m.state = 'chase';
          m.repathIn = 0;
          if (m.screamCooldown <= 0) {
            m.screamCooldown = 12;
            this.event({ k: 'scream', x: m.x, z: m.z, id: m.id, target: best.p.id });
          }
        }
        m.targetId = best.p.id;
        m.lastKnown = { x: best.p.x, z: best.p.z };
        m.loseTimer = LOSE_GRACE;
      } else if (best.heard) {
        // Heard something. That gives a place to look, not a target to follow.
        m.lastKnown = { x: best.p.x, z: best.p.z };
        if (m.state === 'patrol' || m.state === 'idle') {
          m.state = 'search';
          m.searchTimer = SEARCH_TIME;
          m.repathIn = 0;
        }
      }
    }

    // --- State machine -------------------------------------------------------
    let speed = diff.patrol * speedMul;

    switch (m.state) {
      case 'patrol': {
        if (!m.path.length) this.repath(m, this.randomFarCell(m));
        break;
      }

      case 'idle': {
        m.timer -= dt;
        m.yaw += dt * 1.6;
        if (m.timer <= 0) { m.state = 'patrol'; m.path = []; }
        return;
      }

      case 'search': {
        // Go to where the player was last known to be - not where they are.
        speed = (diff.patrol + diff.chase) * 0.5 * speedMul;
        m.searchTimer -= dt;
        m.repathIn -= dt;

        if (m.lastKnown && (!m.path.length || m.repathIn <= 0)) {
          m.repathIn = 1.2;
          this.repath(m, worldToCell(m.lastKnown.x, m.lastKnown.z, this.map.w, this.map.h));
        }
        if (!m.path.length) {
          // Arrived and found nothing: cast about nearby before giving up.
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
        if (!target || target.zone !== Z_FACILITY ||
            (target.state !== ST_ALIVE && target.state !== ST_DOWN)) {
          m.state = 'search'; m.searchTimer = SEARCH_TIME; m.repathIn = 0; break;
        }

        // Only a live perception refreshes what it knows. Once the player
        // breaks contact - round a corner, drop into a crouch - the monster is
        // running at a memory, and that memory goes stale.
        const stillOn = best && best.p.id === m.targetId && (best.acquired || best.heard);
        if (stillOn) {
          m.lastKnown = { x: best.p.x, z: best.p.z };
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
          this.repath(m, worldToCell(m.lastKnown.x, m.lastKnown.z, this.map.w, this.map.h));
        }

        // It can only swing at what it is actually next to.
        const d = Math.hypot(target.x - m.x, target.z - m.z);
        if (d < 1.9 && m.attackCooldown <= 0 && target.state === ST_ALIVE) {
          m.attackCooldown = 3;
          m.state = 'attack';
          m.timer = 0.6;
          this.downPlayer(target, m);
          return;
        }
        break;
      }

      case 'attack': {
        m.timer -= dt;
        if (m.timer <= 0) { m.state = 'retreat'; m.timer = 7; m.path = []; }
        return;
      }

      case 'retreat': {
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
      }

      default:
        m.state = 'patrol';
    }

    this.moveAlongPath(m, m.stagger > 0 ? speed * 0.15 : speed, dt);
  }

  // A cell within `radius` of the monster's last known point, for casting about
  // during a search.
  randomNearbyCell(m, radius) {
    if (!m.lastKnown) return null;
    const centre = worldToCell(m.lastKnown.x, m.lastKnown.z, this.map.w, this.map.h);
    for (let attempt = 0; attempt < 12; attempt++) {
      const cx = centre.cx + Math.round((this.rng() - 0.5) * radius * 2);
      const cy = centre.cy + Math.round((this.rng() - 0.5) * radius * 2);
      if (cx < 1 || cy < 1 || cx >= this.map.w - 1 || cy >= this.map.h - 1) continue;
      if (this.grid[idx(cx, cy, this.map.w)] !== 1) continue;
      return { cx, cy };
    }
    return null;
  }


  repath(m, goalCell) {
    if (!goalCell) return;
    const from = worldToCell(m.x, m.z, this.map.w, this.map.h);
    const path = findPath(this.grid, this.map.w, this.map.h, this.nearestFloor(from), this.nearestFloor(goalCell));
    m.path = path || [];
    m.pathIdx = 0;
  }

  moveAlongPath(m, speed, dt) {
    if (!m.path.length) return;
    const next = m.path[m.pathIdx];
    if (!next) { m.path = []; m.pathIdx = 0; return; }
    const target = this.cellCenter(next);
    const dx = target.x - m.x, dz = target.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) {
      m.pathIdx++;
      if (m.pathIdx >= m.path.length) { m.path = []; m.pathIdx = 0; }
      return;
    }
    const step = Math.min(d, speed * dt);
    const nx = m.x + (dx / d) * step;
    const nz = m.z + (dz / d) * step;
    // It follows cell centres, but a re-path mid-stride used to let it cut the
    // corner of a block. Push the body out of any rock it overlaps, exactly as
    // players are pushed, so it hugs walls instead of passing through them.
    const fixed = this.resolveCircle(nx, nz, MONSTER_RADIUS);
    m.x = fixed.x;
    m.z = fixed.z;
    const wanted = Math.atan2(dx, dz);
    m.yaw += angleDelta(m.yaw, wanted) * Math.min(1, dt * 6);
  }

  randomFarCell(m) {
    let bestCell = null, bestScore = -1;
    for (let i = 0; i < 12; i++) {
      const c = this.floorCells[Math.floor(this.rng() * this.floorCells.length)];
      if (!c) continue;
      const pos = this.cellCenter(c);
      const d = Math.hypot(pos.x - m.x, pos.z - m.z);
      if (d > bestScore) { bestScore = d; bestCell = c; }
    }
    return bestCell;
  }

  nearestFloor(cell) {
    const { w, h } = this.map;
    const cx = Math.max(0, Math.min(w - 1, cell.cx));
    const cy = Math.max(0, Math.min(h - 1, cell.cy));
    if (this.grid[idx(cx, cy, w)] === 1) return { cx, cy };
    for (let r = 1; r <= 3; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (this.grid[idx(nx, ny, w)] === 1) return { cx: nx, cy: ny };
        }
      }
    }
    return { cx: 1, cy: 1 };
  }

  cellCenter(cell) {
    const { w, h, cell: size } = this.map;
    return { x: (cell.cx - (w - 1) / 2) * size, z: (cell.cy - (h - 1) / 2) * size };
  }

// Push a circle out of any solid cell it overlaps. Kept deliberately in step
  // with World.resolveCollision on the client so both ends agree on where a
  // body can stand. Walls only: props are not in the monster's path graph, so
  // colliding it against them would just wedge it against a crate.
  resolveCircle(x, z, radius) {
    const cell = this.map.cell;
    const c = worldToCell(x, z, this.map.w, this.map.h);
    let outX = x, outZ = z;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = c.cx + dx, cy = c.cy + dy;
        if (cx < 0 || cy < 0 || cx >= this.map.w || cy >= this.map.h) continue;
        if (this.grid[idx(cx, cy, this.map.w)] === 1) continue;

        const center = this.cellCenter({ cx, cy });
        const half = cell / 2;
        const minX = center.x - half, maxX = center.x + half;
        const minZ = center.z - half, maxZ = center.z + half;

        const closestX = Math.max(minX, Math.min(outX, maxX));
        const closestZ = Math.max(minZ, Math.min(outZ, maxZ));
        const px = outX - closestX, pz = outZ - closestZ;
        const distSq = px * px + pz * pz;
        if (distSq >= radius * radius) continue;

        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          outX = closestX + (px / dist) * radius;
          outZ = closestZ + (pz / dist) * radius;
        } else {
          const penX = Math.min(outX - minX, maxX - outX);
          const penZ = Math.min(outZ - minZ, maxZ - outZ);
          if (penX < penZ) outX = outX < center.x ? minX - radius : maxX + radius;
          else outZ = outZ < center.z ? minZ - radius : maxZ + radius;
        }
      }
    }
    return { x: outX, z: outZ };
  }

  // --- Zones ------------------------------------------------------------------

  // Which grid a body is standing on, and how it is laid out. One coordinate
  // space covers both zones - the Backrooms simply live somewhere else in it -
  // so a position alone is never ambiguous.
  zoneOf(zone) {
    if (zone === Z_BACKROOMS && this.back) {
      return { grid: this.backGrid, w: this.back.w, h: this.back.h, cell: this.back.cell, back: true };
    }
    return { grid: this.grid, w: this.map.w, h: this.map.h, cell: this.map.cell, back: false };
  }

  zoneHeight(zone) {
    return zone === Z_BACKROOMS && this.back ? this.back.wallH : (this.map ? this.map.wallH : 3.4);
  }

  cellOf(x, z, zone) {
    const g = this.zoneOf(zone);
    if (g.back) {
      const c = BACKROOMS.worldToCell(x, z);
      return { ...c, g };
    }
    return { ...worldToCell(x, z, g.w, g.h), g };
  }

  centreOf(cx, cy, zone) {
    const g = this.zoneOf(zone);
    if (g.back) return BACKROOMS.cellToWorld(cx, cy);
    return { x: (cx - (g.w - 1) / 2) * g.cell, z: (cy - (g.h - 1) / 2) * g.cell };
  }

  isSolidAt(x, z, zone = Z_FACILITY) {
    if (!this.grid) return false;
    const { cx, cy, g } = this.cellOf(x, z, zone);
    if (cx < 0 || cy < 0 || cx >= g.w || cy >= g.h) return true;
    const v = g.grid[cy * g.w + cx];
    if (v === 0) return true;
    // The door cell is a wall right up until the shutter is all the way up.
    if (!g.back && v === DOOR) return this.door.phase !== DOOR_OPEN;
    return false;
  }

  // A budgeted step can be several metres long after a latency spike, which is
  // long enough to clear a wall in one go if only the destination is checked.
  // Walk the segment instead: a move is legal only if the whole of it is.
  crossesSolid(player, nx, nz) {
    const dx = nx - player.x, dz = nz - player.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.5) return false;                 // shorter than any wall is thick
    const steps = Math.ceil(d / 0.4);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.isSolidAt(player.x + dx * t, player.z + dz * t, player.zone)) return true;
    }
    return false;
  }

  // The opening in the door cell is narrower than the cell, so a body cannot
  // drift past the jambs and end up inside the wall beside the door. Applied on
  // the server as well as the client, so a tampered client gains nothing.
  clampToAperture(player) {
    if (!this.map || !this.map.door || player.zone !== Z_FACILITY) return;
    const d = this.map.door;
    const { cx, cy } = worldToCell(player.x, player.z, this.map.w, this.map.h);
    if (cx !== d.cx || cy !== d.cy) return;
    const limit = d.half - 0.34;                      // player radius
    if (d.nx !== 0) {
      player.z = Math.max(d.z - limit, Math.min(d.z + limit, player.z));
    } else {
      player.x = Math.max(d.x - limit, Math.min(d.x + limit, player.x));
    }
  }

  // A noise loud enough to be worth investigating pulls nearby monsters in.
  hearNoise(x, z, strength) {
    for (const m of this.monsters) {
      if (m.state === 'sleeping' || m.state === 'waking' || m.state === 'downed') continue;
      if (m.state === 'chase' || m.state === 'retreat' || m.state === 'attack') continue;
      const d = Math.hypot(m.x - x, m.z - z);
      if (d > this.difficulty().hearing * strength) continue;
      m.lastKnown = { x, z };
      m.state = 'search';
      m.searchTimer = SEARCH_TIME;
      m.repathIn = 0;
    }
  }

  // The director does not spawn anything - it just makes the building sound
  // inhabited, so silence never feels safe.
  updateDirector(dt) {
    this.ambientTimer -= dt;
    if (this.ambientTimer > 0) return;
    this.ambientTimer = 14 + this.rng() * 26;
    const alive = [...this.players.values()].filter((p) => p.state === ST_ALIVE);
    if (!alive.length) return;
    const anchor = alive[Math.floor(this.rng() * alive.length)];
    const angle = this.rng() * Math.PI * 2;
    const radius = 10 + this.rng() * 18;
    const kinds = ['clang', 'drip', 'whisper', 'scrape', 'breath'];
    this.event({
      k: 'ambient',
      kind: kinds[Math.floor(this.rng() * kinds.length)],
      x: anchor.x + Math.cos(angle) * radius,
      z: anchor.z + Math.sin(angle) * radius,
    });
  }

  // --- Outbound ------------------------------------------------------------

  sendSnapshot() {
    // Player rows:
    //   [id, x, y, z, yaw, pitch, flags, state, carrying, downTimer, charge,
    //    reserve, zone, climb]
    const players = [];
    for (const p of this.players.values()) {
      players.push([
        p.id,
        round2(p.x), round2(p.y), round2(p.z),
        round2(p.yaw), round2(p.pitch),
        p.flags,
        p.state,
        p.carrying === null ? -1 : p.carrying,
        p.state === ST_DOWN ? Math.max(0, Math.round(p.downTimer)) : 0,
        Math.round(p.charge),
        p.reserve,
        p.zone,
        round2(p.climb),
      ]);
    }
    this.broadcast({
      t: 'snap',
      k: this.tick,
      tm: Math.round(this.roundTime),
      p: players,
      // Monster rows: [id, x, z, yaw, stateCode]
      m: this.monsters.map((m) => [m.id, round2(m.x), round2(m.z), round2(m.yaw), MONSTER_STATE_CODE[m.state] ?? 0]),
      // Fuse rows: [id, x, z, state, holder]
      f: this.fuses.map((f) => [f.id, round2(f.x), round2(f.z), f.state, f.holder ?? -1]),
      // Battery rows: [id, x, z, taken]
      b: this.batteries.map((b) => [b.id, round2(b.x), round2(b.z), b.taken ? 1 : 0]),
      // Gasoline: [x, z, state, holder]. state 0 floor, 1 carried, 2 poured.
      gs: this.gas ? [round2(this.gas.x), round2(this.gas.z), this.gas.state, this.gas.holder ?? -1] : null,
      // The rifle: [x, z, state, holder, mag, reserve, reloading]
      wp: this.weapon ? [
        round2(this.weapon.x), round2(this.weapon.z),
        this.weapon.state, this.weapon.holder ?? -1,
        this.weapon.mag, this.weapon.reserve,
        this.weapon.reloading > 0 ? 1 : 0,
      ] : null,
      g: this.powered,
      // The door: [phase, progress 0..1]. Phase is authoritative; progress is
      // what drives the shutter on every client at once.
      dr: [this.door.phase, Math.round(this.doorProgress() * 100) / 100],
      o: this.generatorOn ? 1 : 0,
      sb: this.sabotage ? this.sabotage.phase : null,
      fi: Math.round(this.fire * 100) / 100,
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
    for (const p of this.players.values()) {
      if (p.conn.open) p.conn.sendRaw(json);
    }
  }
}

// Wire codes for monster state. 0 is 'not in the level yet' as far as the
// client is concerned; waking is its own visible beat.
const MONSTER_STATE_CODE = {
  sleeping: 0, patrol: 1, idle: 2, search: 3, chase: 4, retreat: 5, waking: 6, attack: 7,
  downed: 8,
};

function sanitiseName(name, id) {
  const clean = String(name ?? '').replace(/[^\w \-.'\[\]]/g, '').trim().slice(0, 16);
  return clean || 'Survivor ' + id;
}

function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }

// A unit vector from whatever a client sent, or null if it sent nonsense.
function normalise(v) {
  const [x, y, z] = v;
  if (![x, y, z].every(Number.isFinite)) return null;
  const len = Math.hypot(x, y, z);
  if (len < 1e-4) return null;
  return { x: x / len, y: y / len, z: z / len };
}
function round2(v) { return Math.round(v * 100) / 100; }
function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

module.exports = {
  Session, TICK_HZ, MAX_PLAYERS, DIFFICULTY, SPEED,
  F_MOVING, F_SPRINT, F_CROUCH, F_LIGHT, F_BUSY, F_GUN, F_RELOAD, F_CLIMB,
  DOOR_SHUT, DOOR_OPENING, DOOR_OPEN, DOOR_OPEN_TIME,
  Z_FACILITY, Z_BACKROOMS, CLIMB_TIME,
  MAG_SIZE, AMMO_RESERVE, MONSTER_HP, PLAYER_HP, AK_DAMAGE_MONSTER, AK_DAMAGE_PLAYER, AK_RANGE,
};
