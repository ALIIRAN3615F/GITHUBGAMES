'use strict';

// Authoritative session state for SIGNAL LOST.
//
// Split of responsibility: clients own their own movement (LAN latency is low
// and this is a co-op game, so it feels far better than server-side prediction),
// while the server owns everything that can be cheated or must agree across
// machines - the monster, the fuses, the generator, downs and revives.
//
// Wire protocol
//   C -> S  join {name} | input {p,y,f} | use {k,id} | chat {m} | cfg {...}
//           ready {} | start {} | ping {c}
//   S -> C  hello | lobby | begin {map} | snap | ev | chat | end | pong
//
// Player flag bits packed into `f` on the input message:
const F_MOVING = 1, F_SPRINT = 2, F_CROUCH = 4, F_LIGHT = 8, F_BUSY = 16;

const { generate, worldToCell, bfsDistances, idx } = require('./mapgen');
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

const DIFFICULTY = {
  calm:      { patrol: 2.0, chase: 4.05, hearing: 17, sight: 17, grace: 40, bleed: 60, monsters: 1, label: 'Calm' },
  normal:    { patrol: 2.4, chase: 4.70, hearing: 23, sight: 21, grace: 25, bleed: 45, monsters: 1, label: 'Normal' },
  nightmare: { patrol: 2.9, chase: 5.30, hearing: 31, sight: 26, grace: 12, bleed: 30, monsters: 2, label: 'Nightmare' },
};

const PLAYER_COLORS = [
  0x6fd3ff, 0xffb347, 0x9be36b, 0xff7b7b,
  0xc79bff, 0xffe066, 0x66e8c8, 0xff8fd0,
];

const ST_ALIVE = 0, ST_DOWN = 1, ST_DEAD = 2, ST_ESCAPED = 3;

let nextPlayerId = 1;

class Session {
  constructor() {
    this.players = new Map();       // id -> player
    this.phase = 'lobby';           // lobby | playing | ended
    this.hostId = null;
    this.cfg = { size: 'medium', fuses: 6, difficulty: 'normal' };
    this.map = null;
    this.grid = null;
    this.monsters = [];
    this.fuses = [];
    this.powered = 0;
    this.exitOpen = false;
    this.tick = 0;
    this.roundTime = 0;
    this.endsAt = 0;
    this.outcome = null;
    this.rng = makeRng((Date.now() ^ 0x5f3a) >>> 0);
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
      x: 0, y: 0, z: 0, yaw: 0,
      flags: 0,
      carrying: null,
      downTimer: 0,
      downs: 0,
      bleedTotal: 0,
      stats: { fuses: 0, revives: 0, escaped: false },
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

    // Movement clamp: allow a generous margin for latency spikes, but nothing
    // resembling a teleport.
    const budget = SPEED.sprint * 1.6 * dt + 0.6;
    const dx = nx - player.x, dz = nz - player.z;
    const moved = Math.hypot(dx, dz);
    if (moved > budget) {
      const s = budget / moved;
      player.x += dx * s;
      player.z += dz * s;
    } else if (this.isSolidAt(nx, nz)) {
      // Inside geometry - ignore and keep the last legal position.
    } else {
      player.x = nx;
      player.z = nz;
    }
    player.y = Math.max(-2, Math.min(4, ny));
    player.yaw = Number.isFinite(msg.y) ? msg.y : player.yaw;
    player.flags = (msg.f | 0) & 31;
    if (player.state !== ST_ALIVE) player.flags &= ~(F_SPRINT | F_MOVING);
  }

  onUse(player, msg) {
    if (this.phase !== 'playing') return;
    switch (msg.k) {
      case 'fuse':   return this.pickUpFuse(player, msg.id);
      case 'insert': return this.insertFuse(player);
      case 'revive': return this.revive(player, msg.id);
      case 'exit':   return this.escape(player);
      case 'drop':   return this.dropFuse(player);
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
    this.powered = 0;
    this.exitOpen = false;
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
      p.stats = { fuses: 0, revives: 0, escaped: false };
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
      state: 'dormant',
      timer: diff.grace + index * 6,
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
    this.map = null;
    this.grid = null;
    for (const p of this.players.values()) { p.ready = false; p.state = ST_ALIVE; p.carrying = null; }
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
    this.event({ k: 'pickup', x: fuse.x, z: fuse.z, by: player.name });
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
      this.exitOpen = true;
      this.event({ k: 'power', x: this.map.exit.x, z: this.map.exit.z });
      for (const m of this.monsters) { m.state = 'hunt'; m.lastKnown = { x: gen.x, z: gen.z }; m.repathIn = 0; }
    }
  }

  revive(player, targetId) {
    if (player.state !== ST_ALIVE) return;
    const target = this.players.get(targetId);
    if (!target || target.state !== ST_DOWN) return;
    if (dist2(player.x, player.z, target.x, target.z) > 3.0 * 3.0) return;
    target.state = ST_ALIVE;
    target.downTimer = 0;
    player.stats.revives++;
    this.event({ k: 'revive', by: player.name, who: target.name, id: target.id, x: target.x, z: target.z });
    this.hearNoise(target.x, target.z, 0.9);
  }

  escape(player) {
    if (player.state !== ST_ALIVE || !this.exitOpen) return;
    const exit = this.map.exit;
    if (dist2(player.x, player.z, exit.x, exit.z) > 4.5 * 4.5) return;
    player.state = ST_ESCAPED;
    player.stats.escaped = true;
    player.carrying = null;
    this.event({ k: 'escape', who: player.name, id: player.id });
    this.checkRoundOver();
  }

  downPlayer(player, monster) {
    if (player.state !== ST_ALIVE) return;
    player.state = ST_DOWN;
    player.downs++;
    // Each rescue buys less time than the last: the third mistake is usually fatal.
    player.downTimer = this.difficulty().bleed * Math.pow(0.72, player.downs - 1);
    if (player.carrying !== null) this.dropFuse(player);
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

    for (const m of this.monsters) this.updateMonster(m, dt);
    this.updateDirector(dt);

    if (this.tick % SNAP_EVERY === 0) this.sendSnapshot();
  }

  updateMonster(m, dt) {
    const diff = this.difficulty();
    const aggro = this.map.fuseCount ? this.powered / this.map.fuseCount : 0;
    const speedMul = 1 + aggro * 0.16 + (this.exitOpen ? 0.1 : 0);
    const hearing = diff.hearing * (1 + aggro * 0.55);
    const sight = diff.sight * (1 + aggro * 0.25);

    m.attackCooldown = Math.max(0, m.attackCooldown - dt);
    m.screamCooldown = Math.max(0, m.screamCooldown - dt);

    if (m.state === 'dormant') {
      m.timer -= dt;
      if (m.timer <= 0) { m.state = 'patrol'; m.path = []; this.event({ k: 'wake', x: m.x, z: m.z }); }
      return;
    }

    // --- Perception ---------------------------------------------------------
    let best = null;
    for (const p of this.players.values()) {
      if (p.state !== ST_ALIVE && p.state !== ST_DOWN) continue;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      const los = hasLineOfSight(this.grid, this.map.w, this.map.h, this.map.cell, m.x, m.z, p.x, p.z);

      let noise = 0.06;
      if (p.state === ST_DOWN) noise = 0.5;                     // whimpering gives you away
      else if ((p.flags & F_SPRINT) && (p.flags & F_MOVING)) noise = 1.0;
      else if (p.flags & F_CROUCH) noise = (p.flags & F_MOVING) ? 0.22 : 0.05;
      else if (p.flags & F_MOVING) noise = 0.6;
      if (p.flags & F_BUSY) noise = Math.max(noise, 0.85);
      if (p.flags & F_LIGHT) noise += los ? 0.55 : 0.12;        // light is a beacon
      if (this.exitOpen) noise += 0.5;                          // the alarm draws it to you

      const heard = d < hearing * noise;
      const seen = los && d < sight && ((p.flags & F_LIGHT) || d < sight * 0.6);
      if (!heard && !seen) continue;

      const score = (seen ? 1000 : 0) + (1000 - d) + noise * 200;
      if (!best || score > best.score) best = { p, d, los, seen, heard, score };
    }

    if (best) {
      m.lastKnown = { x: best.p.x, z: best.p.z };
      const shouldChase = best.p.state === ST_ALIVE && (best.seen || (best.heard && best.d < hearing * 0.5));
      if (shouldChase && m.state !== 'retreat') {
        if (m.state !== 'chase') {
          m.state = 'chase';
          m.repathIn = 0;
          if (m.screamCooldown <= 0) {
            m.screamCooldown = 12;
            this.event({ k: 'scream', x: m.x, z: m.z, id: m.id, target: best.p.id });
          }
        }
        m.targetId = best.p.id;
        m.loseTimer = 6;
      } else if (m.state === 'patrol' || m.state === 'idle') {
        m.state = 'hunt';
        m.repathIn = 0;
      }
    }

    // --- State machine ------------------------------------------------------
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
      case 'hunt': {
        speed = (diff.patrol + diff.chase) * 0.5 * speedMul;
        m.repathIn -= dt;
        if (m.lastKnown && (!m.path.length || m.repathIn <= 0)) {
          m.repathIn = 1.2;
          this.repath(m, worldToCell(m.lastKnown.x, m.lastKnown.z, this.map.w, this.map.h));
        }
        if (!m.path.length) { m.state = 'idle'; m.timer = 2.5 + this.rng() * 2; m.lastKnown = null; }
        break;
      }
      case 'chase': {
        speed = diff.chase * speedMul;
        const target = this.players.get(m.targetId);
        if (!target || (target.state !== ST_ALIVE && target.state !== ST_DOWN)) {
          m.state = 'hunt'; m.repathIn = 0; break;
        }
        m.loseTimer -= dt;
        if (!best && m.loseTimer <= 0) { m.state = 'hunt'; m.repathIn = 0; break; }

        m.repathIn -= dt;
        if (m.repathIn <= 0) {
          m.repathIn = 0.35;
          this.repath(m, worldToCell(target.x, target.z, this.map.w, this.map.h));
        }
        const d = Math.hypot(target.x - m.x, target.z - m.z);
        if (d < 1.9 && m.attackCooldown <= 0 && target.state === ST_ALIVE) {
          m.attackCooldown = 3;
          this.downPlayer(target, m);
          return;
        }
        break;
      }
      case 'retreat': {
        speed = diff.chase * 0.9 * speedMul;
        m.timer -= dt;
        if (!m.path.length) this.repath(m, this.randomFarCell(m));
        if (m.timer <= 0) { m.state = 'patrol'; m.path = []; m.lastKnown = null; }
        break;
      }
      default:
        m.state = 'patrol';
    }

    this.moveAlongPath(m, speed, dt);
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

  isSolidAt(x, z) {
    if (!this.grid) return false;
    const c = worldToCell(x, z, this.map.w, this.map.h);
    if (c.cx < 0 || c.cy < 0 || c.cx >= this.map.w || c.cy >= this.map.h) return true;
    return this.grid[idx(c.cx, c.cy, this.map.w)] !== 1;
  }

  // A noise loud enough to be worth investigating pulls nearby monsters in.
  hearNoise(x, z, strength) {
    for (const m of this.monsters) {
      if (m.state === 'dormant' || m.state === 'chase' || m.state === 'retreat') continue;
      const d = Math.hypot(m.x - x, m.z - z);
      if (d > this.difficulty().hearing * strength) continue;
      m.lastKnown = { x, z };
      m.state = 'hunt';
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
    // Player rows: [id, x, y, z, yaw, flags, state, carrying, downTimer]
    const players = [];
    for (const p of this.players.values()) {
      players.push([
        p.id,
        round2(p.x), round2(p.y), round2(p.z),
        round2(p.yaw),
        p.flags,
        p.state,
        p.carrying === null ? -1 : p.carrying,
        p.state === ST_DOWN ? Math.max(0, Math.round(p.downTimer)) : 0,
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
      g: this.powered,
      x: this.exitOpen ? 1 : 0,
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

const MONSTER_STATE_CODE = { dormant: 0, patrol: 1, idle: 2, hunt: 3, chase: 4, retreat: 5 };

function sanitiseName(name, id) {
  const clean = String(name ?? '').replace(/[^\w \-.'\[\]]/g, '').trim().slice(0, 16);
  return clean || 'Survivor ' + id;
}

function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function round2(v) { return Math.round(v * 100) / 100; }
function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

module.exports = { Session, TICK_HZ, MAX_PLAYERS, DIFFICULTY, F_MOVING, F_SPRINT, F_CROUCH, F_LIGHT, F_BUSY, SPEED };
