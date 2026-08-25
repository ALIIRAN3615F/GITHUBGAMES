// DEAD AIR - client entry point.
//
// Owns the canvas, the round state machine, and the glue between the modules:
// input -> local simulation -> network, and network -> entities, HUD, audio.

import { Net } from './net.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { AudioEngine } from './audio.js';
import { Renderer, TILE } from './render.js';

// The same numbers the server clamps against. Tiles and tiles per second.
const SPEED = { walk: 3.4, sprint: 5.9, crouch: 1.75 };
const RADIUS = 0.30;
const ACCEL = 26;                       // how fast a body reaches its speed
const STAMINA_DRAIN = 17;
const STAMINA_REGEN = 11;
const STAMINA_MIN_TO_SPRINT = 9;
const CHARGE_DRAIN = 1.0;

const F_MOVING = 1, F_SPRINT = 2, F_CROUCH = 4, F_LIGHT = 8, F_BUSY = 16;

// Render remote players this far in the past and interpolate between the two
// snapshots either side of it, so nobody ever teleports between frames.
const INTERP_DELAY = 110;

const HOLD_TIME = { fuse: 0.7, insert: 1.4, revive: 3.0, battery: 0.3, power: 1.0, button: 0.25 };
const REACH = { fuse: 1.5, insert: 1.9, revive: 1.5, battery: 1.5, power: 1.9, button: 1.5 };

class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.settings = this.loadSettings();

    this.hud = new Hud();
    this.net = new Net();
    this.audio = new AudioEngine();
    this.input = new Input(this.canvas);
    this.renderer = new Renderer(this.canvas);

    this.phase = 'title';
    this.playerInfo = new Map();
    this.snapshots = [];
    this.latest = null;
    this.powered = 0;
    this.need = 5;
    this.generatorOn = false;
    this.door = [0, 0];
    this.roundTime = 0;
    this.endCountdown = 0;
    this.hold = { kind: null, id: null, time: 0, cooldown: 0 };
    this.heartTimer = 0;
    this.stepAccum = 0;
    this.remoteSteps = new Map();
    this.camera = { x: 0, y: 0 };

    this.player = {
      x: 0, y: 0, vx: 0, vy: 0, aim: 0,
      stamina: 100, charge: 100, reserve: 0,
      flashlightOn: true, crouching: false, sprinting: false, moving: false,
      state: 0, nerve: 0, busy: false,
    };

    this.bindHud();
    this.bindNet();
    this.bindKeys();

    this.hud.applySettings(this.settings);
    this.hud.showScreen('title');
    this.renderer.resize();
    window.addEventListener('resize', () => this.renderer.resize());

    this.lastFrame = performance.now();
    requestAnimationFrame(() => this.frame());
  }

  // --- Boot --------------------------------------------------------------------

  loadSettings() {
    const defaults = { volume: 0.8, zoom: 1, name: '' };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('dead-air:settings') || '{}') };
    } catch { return defaults; }
  }

  saveSettings() {
    try { localStorage.setItem('dead-air:settings', JSON.stringify(this.settings)); }
    catch { /* private mode - settings just will not persist */ }
  }

  bindHud() {
    this.hud
      .on('join', (name) => this.join(name))
      .on('ready', () => this.net.ready())
      .on('start', () => this.net.start())
      .on('leave', () => this.leave())
      .on('resume', () => { this.hud.showScreen(null); this.audio.resume(); })
      .on('chat', (text) => this.net.chat(text))
      .on('chatClosed', () => { this.input.captureText = false; })
      .on('config', (cfg) => this.net.setConfig(cfg))
      .on('setting', (s) => {
        Object.assign(this.settings, s);
        if (s.volume !== undefined) this.audio.setVolume(s.volume);
        this.saveSettings();
      });
  }

  bindNet() {
    this.net
      .on('hello', (m) => {
        this.localId = m.id;
        this.hud.buildDifficulties(m.difficulties);
        this.hud.showScreen('lobby');
      })
      .on('lobby', (m) => {
        this.playerInfo = new Map(m.players.map((p) => [p.id, p]));
        this.hud.renderLobby(m, this.localId);
        if (this.phase !== 'playing' && m.phase !== 'playing') this.hud.showScreen('lobby');
      })
      .on('begin', (m) => this.beginRound(m))
      .on('snap', (m) => this.onSnapshot(m))
      .on('ev', (m) => this.onEvent(m))
      .on('end', (m) => this.endRound(m))
      .on('chat', (m) => this.hud.addChat(m.from, m.m, '#' + m.color.toString(16).padStart(6, '0')))
      .on('full', () => this.hud.setJoinError('The facility is full.'))
      .on('closed', () => {
        if (this.phase === 'title') return;
        this.leave();
        this.hud.setJoinError('The host closed the session.');
      });
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (this.hud.chatOpen) {
        if (e.code === 'Escape') this.hud.closeChat();
        return;
      }
      switch (e.code) {
        case 'KeyF':
          if (this.phase === 'playing' && this.player.state === 0) this.toggleFlashlight();
          break;
        case 'KeyC':
          if (this.phase === 'playing') this.input.crouchToggled = !this.input.crouchToggled;
          break;
        case 'KeyR':
          if (this.phase === 'playing' && this.player.state === 0) this.reload();
          break;
        case 'KeyQ':
          if (this.phase === 'playing' && this.carrying) this.net.use('drop');
          break;
        case 'KeyT':
        case 'Enter':
          if (this.phase === 'playing') { this.input.captureText = true; this.hud.openChat(); }
          break;
        case 'Tab':
          if (this.phase === 'playing') this.showScoreboard(true);
          break;
        case 'Escape':
          if (this.phase === 'playing') {
            this.hud.showScreen(this.hud.current === 'pause' ? null : 'pause');
          }
          break;
        default: break;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.showScoreboard(false);
    });
  }

  toggleFlashlight() {
    if (!this.player.flashlightOn && this.player.charge <= 0) {
      this.hud.banner('THE BATTERY IS DEAD', 'bad', 2);
      return;
    }
    this.player.flashlightOn = !this.player.flashlightOn;
    this.audio.blip(this.player.flashlightOn ? 620 : 400, 0.05, 'square', 0.08);
  }

  reload() {
    if (this.player.reserve <= 0) {
      this.hud.banner('NO SPARE BATTERIES', 'bad', 1.8);
      this.audio.blip(240, 0.08, 'square', 0.09);
      return;
    }
    if (this.player.charge >= 99.5) {
      this.hud.banner('FLASHLIGHT ALREADY FULL', '', 1.6);
      return;
    }
    this.net.use('reload');
  }

  async join(name) {
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
    this.settings.name = name;
    this.saveSettings();
    try {
      await this.net.connect(name);
      this.hud.setJoinError('');
    } catch (err) {
      this.hud.setJoinError(err.message || 'Could not reach the host.');
    }
  }

  leave() {
    this.net.disconnect();
    this.audio.stopAll();
    this.phase = 'title';
    this.snapshots.length = 0;
    this.latest = null;
    this.hud.setHudVisible(false);
    this.hud.showScreen('title');
  }

  // --- Round -------------------------------------------------------------------

  beginRound(m) {
    this.hud.setLoading(true, 'DESCENDING...');
    requestAnimationFrame(() => {
      this.map = m.map;
      this.need = m.need;
      this.powered = 0;
      this.generatorOn = false;
      this.door = [0, 0];
      this.roundTime = 0;
      this.snapshots.length = 0;
      this.latest = null;
      this.doorBuilt = false;

      this.renderer.build(m.map, false);

      const spawn = m.map.spawnPoints[Math.floor(Math.random() * m.map.spawnPoints.length)] || m.map.spawn;
      Object.assign(this.player, {
        x: spawn.x, y: spawn.y, vx: 0, vy: 0,
        stamina: 100, charge: 100, reserve: 0,
        flashlightOn: true, state: 0, nerve: 0,
      });
      this.camera.x = spawn.x;
      this.camera.y = spawn.y;

      this.phase = 'playing';
      this.hud.setHudVisible(true);
      this.hud.setFusePips(0, this.need);
      this.hud.setObjective('Find a fuse in the dark');
      this.hud.setCarrying(false);
      this.hud.setDowned(false);
      this.hud.setDead(false);
      this.hud.setLoading(false);
      this.hud.showScreen(null);
      this.hud.addSystem(`The facility is dark. ${this.need} fuses are somewhere down here.`);

      this.audio.init();
      this.audio.startAmbient();
      this.audio.setTension(0);
    });
  }

  endRound(m) {
    this.phase = 'ended';
    this.endCountdown = 14;
    this.hud.setHudVisible(false);
    this.hud.renderEnd(m);
    this.hud.showScreen('end');
    this.hud.setDowned(false);
    this.hud.setDead(false);
    this.audio.setTension(0);
    this.audio.stopLoop('generator');
    if (m.outcome === 'escaped') this.audio.revived();
    else this.audio.hit();
  }

  // --- Server messages -----------------------------------------------------------

  onSnapshot(m) {
    this.latest = m;
    this.snapshots.push({ at: performance.now(), snap: m });
    while (this.snapshots.length > 24) this.snapshots.shift();

    this.powered = m.g;
    this.generatorOn = !!m.o;
    this.roundTime = m.tm;

    const wasOpen = this.door[0] === 2;
    this.door = m.dr || [0, 0];
    // The shutter stops blocking light the instant it is fully up, and the
    // shadow map has to be rebuilt to match.
    if (!wasOpen && this.door[0] === 2 && this.renderer.map) this.renderer.rebuildShadows(true);

    const mine = (m.p || []).find((row) => row[0] === this.localId);
    if (!mine) return;
    const wasState = this.player.state;
    this.player.state = mine[5];
    this.carrying = mine[6] >= 0;
    this.downTimer = mine[7];

    // The server owns charge and reserve. Local prediction keeps the bar
    // smooth between snapshots; this is the correction.
    const serverCharge = mine[8];
    if (Math.abs(serverCharge - this.player.charge) > 2) this.player.charge = serverCharge;
    else this.player.charge = Math.min(this.player.charge, serverCharge + 1);
    this.player.reserve = mine[9];
    if (this.player.charge <= 0) this.player.flashlightOn = false;

    if (wasState !== this.player.state) this.onOwnStateChange(wasState, this.player.state);
    // The server is the authority on where a body that cannot walk is lying.
    if (this.player.state !== 0) { this.player.x = mine[1]; this.player.y = mine[2]; }
  }

  onOwnStateChange(from, to) {
    if (to === 1) {
      this.audio.hit();
      this.hud.flash(0.75, 1.1);
      this.hud.banner('IT HAS YOU', 'bad', 3);
    } else if (to === 0 && from === 1) {
      this.audio.revived();
      this.hud.banner('BACK ON YOUR FEET', 'good', 2.4);
    } else if (to === 2) {
      this.hud.banner('YOU BLED OUT', 'bad', 4);
      this.audio.setTension(0);
    } else if (to === 3) {
      this.hud.banner('YOU MADE IT OUT', 'good', 4);
    }
    this.hud.setDowned(to === 1, this.downTimer);
    this.hud.setDead(to === 2);
  }

  onEvent(ev) {
    switch (ev.k) {
      case 'ambient': {
        const fn = { clang: 'clang', drip: 'drip', whisper: 'whisper', scrape: 'scrape', breath: 'breath' }[ev.kind];
        if (fn && this.audio[fn]) this.audio[fn](ev.x, ev.y);
        break;
      }
      case 'waking':
        this.hud.banner('SOMETHING IS STIRRING', 'bad', 4);
        this.hud.addSystem('Somewhere down here, something just woke up.');
        this.audio.growl(ev.x, ev.y, 1.3);
        break;
      case 'awake':
        this.hud.banner('IT IS HUNTING NOW', 'bad', 3.4);
        this.audio.scream(ev.x, ev.y);
        break;
      case 'scream':
        this.audio.scream(ev.x, ev.y);
        if (ev.target === this.localId) {
          this.hud.banner('IT SEES YOU - RUN', 'bad', 3);
          this.hud.flash(0.3, 0.5);
        }
        break;
      case 'fuse':
        this.audio.fuseInsert(ev.x, ev.y);
        this.hud.setFusePips(ev.n, ev.need);
        this.hud.addSystem(`${ev.by} seated a fuse (${ev.n}/${ev.need}).`);
        if (ev.n < ev.need) this.hud.banner(`${ev.n} / ${ev.need} FUSES`, '', 2.4);
        break;
      case 'power':
        if (ev.on) {
          this.audio.powerUp();
          this.hud.banner('POWER ON', 'good', 4);
          this.hud.addSystem(ev.by
            ? `${ev.by} started the generator. The lights are on - and it knows.`
            : 'The generator caught. Every light in the facility is on, and it knows where you are.');
        } else {
          this.audio.blip(180, 0.5, 'sawtooth', 0.16);
          this.hud.banner('POWER CUT - DARK AGAIN', 'bad', 3.5);
          this.hud.addSystem(`${ev.by || 'Someone'} cut the power.`);
        }
        break;
      case 'door-power':
        if (ev.on) this.hud.addSystem('The panel by the exit reads POWER: ON. Somebody has to press it.');
        break;
      case 'door-dead':
        this.audio.buttonPress(ev.x, ev.y, true);
        if (ev.id === this.localId) this.hud.banner('NO POWER TO THE DOOR', 'bad', 2.4);
        break;
      case 'door-open':
        this.audio.buttonPress(ev.x, ev.y, false);
        this.audio.doorSequence(ev.x, ev.y, ev.seconds);
        this.hud.banner('THE SHUTTER IS COMING UP', '', 3.6);
        this.hud.addSystem(`${ev.by} pressed the button. Everything down here just heard it.`);
        break;
      case 'door-opened':
        this.hud.banner('THE WAY IS OPEN', 'good', 3.4);
        break;
      case 'battery':
        if (ev.id === this.localId) {
          this.audio.pickup();
          this.hud.banner(`BATTERY TAKEN - ${ev.n} IN RESERVE`, '', 1.8);
        }
        break;
      case 'reload':
        if (ev.id === this.localId) {
          this.audio.blip(520, 0.12, 'square', 0.12);
          this.hud.banner('FRESH BATTERY LOADED', 'good', 1.8);
        }
        break;
      case 'dead-battery':
        if (ev.id === this.localId) {
          this.hud.banner('FLASHLIGHT DEAD - PRESS R', 'bad', 3.2);
          this.hud.addSystem('Your flashlight is out. Load a spare with R.');
        }
        break;
      case 'pickup':
        if (ev.by) this.hud.addSystem(`${ev.by} picked up a fuse.`);
        if (ev.id === this.localId && ev.recharged) {
          this.audio.blip(700, 0.18, 'triangle', 0.14);
          this.hud.banner('FUSE CELL - FLASHLIGHT FULL', 'good', 2.6);
        }
        break;
      case 'down':
        if (ev.id !== this.localId) {
          this.hud.banner(`${ev.who.toUpperCase()} IS DOWN`, 'bad', 3);
          this.hud.addSystem(`${ev.who} went down. Get to them.`);
        }
        break;
      case 'revive':
        if (ev.id !== this.localId) this.hud.addSystem(`${ev.by} pulled ${ev.who} back up.`);
        break;
      case 'death':
        this.hud.addSystem(`${ev.who} did not make it.`);
        break;
      case 'escape':
        this.hud.addSystem(`${ev.who} reached the surface.`);
        if (ev.id !== this.localId) this.hud.banner(`${ev.who.toUpperCase()} IS OUT`, 'good', 2.4);
        break;
      case 'joined': this.hud.addSystem(`${ev.name} joined.`); break;
      case 'left': this.hud.addSystem(`${ev.name} left.`); break;
      default: break;
    }
  }

  // --- Frame -----------------------------------------------------------------------

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.hud.tick(dt);

    if (this.phase === 'playing') this.updatePlaying(dt);
    else if (this.phase === 'ended') this.updateEnded(dt);

    requestAnimationFrame(() => this.frame());
  }

  updateEnded(dt) {
    this.endCountdown -= dt;
    this.hud.setEndCountdown(Math.ceil(this.endCountdown));
    if (this.map) this.renderer.draw(dt, this.buildScene(dt));
  }

  updatePlaying(dt) {
    const frozen = this.hud.chatOpen || !!this.hud.current;
    this.movePlayer(dt, frozen);
    this.updateCamera(dt);

    const scene = this.buildScene(dt);
    this.renderer.observe(this.player.x, this.player.y, this.player.flashlightOn ? 11 : 4.5);
    this.renderer.draw(dt, scene);

    this.updateInteraction(dt, scene);
    this.updateAudio(dt, scene);

    this.hudTimer = (this.hudTimer ?? 0) - dt;
    if (this.hudTimer <= 0) { this.hudTimer = 0.1; this.updateHud(scene); }

    this.net.sendInput(this.player.x, this.player.y, this.player.aim, this.flags());
  }

  // --- Local simulation ---------------------------------------------------------

  movePlayer(dt, frozen) {
    const p = this.player;
    const canAct = !frozen && p.state === 0;

    // Aim follows the cursor. Seen from above, that is the whole of looking.
    if (canAct) {
      const dpr = this.renderer.dpr || 1;
      const scale = TILE * dpr * this.settings.zoom;
      const wx = this.camera.x + (this.input.mouse.x * dpr - this.canvas.width / 2) / scale;
      const wy = this.camera.y + (this.input.mouse.y * dpr - this.canvas.height / 2) / scale;
      p.aim = Math.atan2(wy - p.y, wx - p.x);
    }

    const axis = canAct ? this.input.axis() : { x: 0, y: 0 };
    const wants = axis.x !== 0 || axis.y !== 0;

    p.crouching = canAct && (this.input.down('ControlLeft') || this.input.down('ControlRight') || this.input.crouchToggled);
    const wantsSprint = canAct && !p.crouching && wants
      && (this.input.down('ShiftLeft') || this.input.down('ShiftRight'));
    p.sprinting = wantsSprint && p.stamina > (p.sprinting ? 0 : STAMINA_MIN_TO_SPRINT);

    if (p.sprinting) p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * dt);
    else p.stamina = Math.min(100, p.stamina + STAMINA_REGEN * dt * (wants ? 0.6 : 1));
    if (p.stamina <= 0) p.sprinting = false;

    const speed = p.state !== 0 ? 0
      : p.crouching ? SPEED.crouch
        : p.sprinting ? SPEED.sprint : SPEED.walk;

    // Accelerate toward the wanted velocity rather than snapping to it, so
    // stopping and turning have a little weight.
    const targetX = axis.x * speed, targetY = axis.y * speed;
    p.vx += (targetX - p.vx) * Math.min(1, ACCEL * dt);
    p.vy += (targetY - p.vy) * Math.min(1, ACCEL * dt);

    if (Math.abs(p.vx) > 1e-4 || Math.abs(p.vy) > 1e-4) {
      const moved = this.resolveCollision(p.x + p.vx * dt, p.y + p.vy * dt, RADIUS);
      p.x = moved.x;
      p.y = moved.y;
    }

    const planar = Math.hypot(p.vx, p.vy);
    p.moving = planar > 0.35;

    // Footsteps are spaced by distance, not by time, so they stay in step with
    // however fast the body is actually going.
    if (p.moving && p.state === 0) {
      this.stepAccum += planar * dt;
      const stride = p.crouching ? 1.05 : p.sprinting ? 1.5 : 1.2;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this.audio.footstep(p.x, p.y, { sprint: p.sprinting, crouch: p.crouching, own: true });
      }
    }

    // Local prediction of the flashlight drain, corrected by every snapshot.
    if (p.flashlightOn && p.state === 0) {
      p.charge = Math.max(0, p.charge - CHARGE_DRAIN * dt);
      if (p.charge <= 0) p.flashlightOn = false;
    }

    this.updateNerve(dt);
  }

  // Nerve drives the grain and the heartbeat. It climbs when something is
  // close and hunting, and settles when it is not.
  updateNerve(dt) {
    const p = this.player;
    const threat = this.nearestMonster();
    let target = 0;
    if (Number.isFinite(threat.distance)) {
      target = Math.max(0, 1 - threat.distance / 16);
      if (threat.state === 4) target = Math.min(1, target * 1.6 + 0.25);
    }
    if (p.state === 1) target = Math.max(target, 0.8);
    const rate = target > p.nerve ? 2.4 : 0.55;
    p.nerve += (target - p.nerve) * Math.min(1, rate * dt);
  }

  updateCamera(dt) {
    // The camera leads slightly toward where the cursor is, so aiming down a
    // corridor shows you more of it.
    const lead = 1.6;
    const tx = this.player.x + Math.cos(this.player.aim) * lead;
    const ty = this.player.y + Math.sin(this.player.aim) * lead;
    this.camera.x += (tx - this.camera.x) * Math.min(1, dt * 7);
    this.camera.y += (ty - this.camera.y) * Math.min(1, dt * 7);
  }

  // Circle against the axis-aligned boxes of the solid cells around it. Kept in
  // step with the server's own push-out so both ends agree where a body fits.
  resolveCollision(x, y, radius) {
    let outX = x, outY = y;
    for (let pass = 0; pass < 3; pass++) {
      const prevX = outX, prevY = outY;
      const cx = Math.floor(outX), cy = Math.floor(outY);
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
      if (Math.abs(outX - prevX) < 1e-6 && Math.abs(outY - prevY) < 1e-6) break;
    }
    return { x: outX, y: outY };
  }

  isSolidCell(cx, cy) {
    const map = this.map;
    if (!map || cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) return true;
    const v = this.renderer.grid[cy * map.w + cx];
    if (v === 2) return this.door[0] !== 2;     // the shutter, until it is up
    return v === 0;
  }

  flags() {
    const p = this.player;
    let f = 0;
    if (p.moving) f |= F_MOVING;
    if (p.sprinting) f |= F_SPRINT;
    if (p.crouching) f |= F_CROUCH;
    if (p.flashlightOn && p.charge > 0) f |= F_LIGHT;
    if (p.busy) f |= F_BUSY;
    return f;
  }

  // --- Building the frame ---------------------------------------------------------

  // Two snapshots either side of the render time, and how far between them we
  // are. Remote bodies are drawn from that rather than from the newest packet.
  sample() {
    if (this.snapshots.length < 2) return null;
    const target = performance.now() - INTERP_DELAY;
    let a = this.snapshots[0], b = this.snapshots[this.snapshots.length - 1];
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].at <= target && this.snapshots[i + 1].at >= target) {
        a = this.snapshots[i];
        b = this.snapshots[i + 1];
        break;
      }
    }
    const span = b.at - a.at;
    return { a: a.snap, b: b.snap, alpha: span > 0 ? clamp((target - a.at) / span, 0, 1) : 1 };
  }

  buildScene(dt) {
    void dt;
    const s = this.sample();
    const players = [];
    const monsters = [];
    const fuses = [];
    const batteries = [];

    if (s) {
      const rowsA = index(s.a.p), rowsB = index(s.b.p);
      for (const [id, rb] of rowsB) {
        const ra = rowsA.get(id) || rb;
        const info = this.playerInfo.get(id) || { name: 'Survivor', color: 0x8899aa };
        const local = id === this.localId;
        players.push({
          id, name: info.name, color: info.color,
          // Your own body is where you put it, not where the last packet said.
          x: local ? this.player.x : lerp(ra[1], rb[1], s.alpha),
          y: local ? this.player.y : lerp(ra[2], rb[2], s.alpha),
          aim: local ? this.player.aim : lerpAngle(ra[3], rb[3], s.alpha),
          flags: local ? this.flags() : rb[4],
          state: rb[5],
          carrying: rb[6] >= 0,
          downTimer: rb[7],
        });
      }
      const monA = index(s.a.m), monB = index(s.b.m);
      for (const [id, rb] of monB) {
        const ra = monA.get(id) || rb;
        monsters.push({
          id,
          x: lerp(ra[1], rb[1], s.alpha),
          y: lerp(ra[2], rb[2], s.alpha),
          aim: lerpAngle(ra[3], rb[3], s.alpha),
          state: rb[4],
        });
      }
      for (const row of s.b.f) fuses.push({ id: row[0], x: row[1], y: row[2], state: row[3], holder: row[4] });
      for (const row of s.b.b) {
        const b = this.map.batteries[row[0]];
        if (b) batteries.push({ id: row[0], x: b.x, y: b.y, taken: !!row[1] });
      }
    }

    return {
      localId: this.localId,
      camera: this.camera,
      zoom: this.settings.zoom,
      players, monsters, fuses, batteries,
      powered: this.powered,
      generatorOn: this.generatorOn,
      door: this.door,
      nerve: this.player.nerve,
      lights: this.buildLights(players),
    };
  }

  // The light budget. Everything here casts real shadows, so the list is kept
  // deliberately short: your own torch, a small halo on every body, and the
  // nearest few ceiling lamps once the generator is running.
  buildLights(players) {
    const lights = [];
    const p = this.player;

    if (p.state === 0) {
      if (p.flashlightOn && p.charge > 0) {
        // A dying battery is a dimmer, shorter, unsteadier beam.
        const health = clamp(p.charge / 30, 0.25, 1);
        const flicker = p.charge < 20 ? 0.75 + Math.random() * 0.25 : 1;
        lights.push({
          x: p.x, y: p.y, radius: 12 * health, angle: p.aim, spread: 0.95,
          colour: '#ffe8c4', intensity: 1.05 * flicker,
        });
      }
      // You can always make out your own feet.
      lights.push({ x: p.x, y: p.y, radius: 3.2, colour: '#8fa6c0', intensity: 0.42 });
    }

    for (const other of players) {
      if (other.id === this.localId || other.state === 2 || other.state === 3) continue;
      const colour = '#' + other.color.toString(16).padStart(6, '0');
      lights.push({ x: other.x, y: other.y, radius: 2.6, colour, intensity: 0.32 });
      if (other.flags & F_LIGHT) {
        lights.push({
          x: other.x, y: other.y, radius: 11, angle: other.aim, spread: 0.95,
          colour: '#ffe8c4', intensity: 0.95,
        });
      }
    }

    const gen = this.map.generator;
    if (this.generatorOn) {
      lights.push({ x: gen.x, y: gen.y, radius: 7, colour: '#9effc0', intensity: 0.8 });
      // Nearest lamps only: a facility full of real lights would be a facility
      // nobody could run.
      const near = this.map.lamps
        .map((l) => ({ l, d: (l.x - p.x) ** 2 + (l.y - p.y) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 7);
      for (const { l } of near) {
        const stutter = Math.sin(this.renderer.time * 11 + l.f) * Math.sin(this.renderer.time * 3.1 + l.f * 2);
        lights.push({
          x: l.x, y: l.y, radius: 6.5 + stutter * 0.6,
          colour: '#ffe2ad', intensity: 0.62 + stutter * 0.12,
        });
      }
    } else if (this.powered > 0) {
      const beat = 0.35 + Math.sin(this.renderer.time * 2.2) * 0.2;
      lights.push({ x: gen.x, y: gen.y, radius: 4.5, colour: '#ffa23a', intensity: beat });
    }

    return lights;
  }

  nearestMonster() {
    if (!this.latest) return { distance: Infinity, state: 0 };
    let best = Infinity, state = 0;
    for (const row of this.latest.m || []) {
      if (row[4] === 0) continue;               // still asleep
      const d = Math.hypot(row[1] - this.player.x, row[2] - this.player.y);
      if (d < best) { best = d; state = row[4]; }
    }
    return { distance: best, state };
  }

  // --- Interaction -----------------------------------------------------------------

  updateInteraction(dt, scene) {
    this.hold.cooldown = Math.max(0, this.hold.cooldown - dt);
    if (this.player.state !== 0 || this.hud.chatOpen || this.hud.current) {
      this.cancelHold();
      this.hud.hidePrompt();
      return;
    }

    const target = this.findTarget(scene);
    if (!target) {
      this.cancelHold();
      this.hud.hidePrompt();
      return;
    }
    if (target.kind === 'locked') {
      this.cancelHold();
      this.hud.showPrompt('!', target.label, 0);
      return;
    }

    const holding = this.input.down('KeyE') && this.hold.cooldown === 0;
    if (!holding) {
      this.cancelHold();
      this.hud.showPrompt('E', target.label, 0);
      return;
    }

    // Changing target mid-hold restarts it, so progress cannot be banked.
    if (this.hold.kind !== target.kind || this.hold.id !== target.id) {
      this.hold.kind = target.kind;
      this.hold.id = target.id;
      this.hold.time = 0;
    }
    this.hold.time += dt;
    this.player.busy = true;

    const needed = HOLD_TIME[target.kind];
    if (this.hold.time >= needed) {
      this.net.use(target.kind, target.id);
      if (target.kind === 'fuse' || target.kind === 'battery') this.audio.pickup();
      this.hold.cooldown = 0.6;
      this.cancelHold();
      this.hud.hidePrompt();
      return;
    }
    this.hud.showPrompt('E', target.label, this.hold.time / needed);
  }

  cancelHold() {
    this.hold.kind = null;
    this.hold.id = null;
    this.hold.time = 0;
    this.player.busy = false;
  }

  // The nearest thing worth pressing E on.
  findTarget(scene) {
    const p = this.player;
    const out = [];
    const gen = this.map.generator;

    if (this.carrying) {
      out.push({ kind: 'insert', id: 0, x: gen.x, y: gen.y, label: 'Seat the fuse' });
    } else {
      for (const f of scene.fuses) {
        if (f.state !== 0) continue;
        out.push({ kind: 'fuse', id: f.id, x: f.x, y: f.y, label: 'Take the fuse' });
      }
      if (this.powered >= this.need) {
        out.push({
          kind: 'power', id: 0, x: gen.x, y: gen.y,
          label: this.generatorOn ? 'Cut the power' : 'Start the generator',
        });
      }
    }
    for (const b of scene.batteries) {
      if (b.taken) continue;
      out.push({ kind: 'battery', id: b.id, x: b.x, y: b.y, label: 'Take the battery' });
    }
    for (const other of scene.players) {
      if (other.id === this.localId || other.state !== 1) continue;
      out.push({ kind: 'revive', id: other.id, x: other.x, y: other.y, label: `Pull ${other.name} up` });
    }

    const panel = this.map.door.panel;
    if (this.door[0] === 0) {
      out.push({
        kind: 'button', id: 0, x: panel.x, y: panel.y,
        label: this.generatorOn ? 'Press the door button' : 'Press it anyway',
      });
    } else if (this.door[0] === 1) {
      out.push({ kind: 'locked', id: 0, x: panel.x, y: panel.y, label: 'The shutter is coming up' });
    }

    let best = null;
    for (const c of out) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d > (REACH[c.kind] ?? 1.5)) continue;
      if (!best || d < best.d) best = { ...c, d };
    }
    return best;
  }

  // --- Audio and HUD ------------------------------------------------------------------

  updateAudio(dt, scene) {
    this.audio.setListener(this.player.x, this.player.y);

    const threat = this.nearestMonster();
    let tension = 0;
    if (Number.isFinite(threat.distance)) {
      const proximity = Math.max(0, 1 - threat.distance / 20);
      const weight = threat.state === 4 ? 1 : threat.state === 3 ? 0.5 : 0.25;
      tension = proximity * weight;
    }
    if (this.player.state === 1) tension = Math.max(tension, 0.7);
    this.audio.setTension(tension);
    this.audio.generatorHum(this.map.generator.x, this.map.generator.y, this.generatorOn ? 1 : 0);

    this.heartTimer -= dt;
    if (this.heartTimer <= 0 && this.player.nerve > 0.25) {
      this.heartTimer = 1.1 - this.player.nerve * 0.55;
      this.audio.heartbeat(this.player.nerve);
    }

    // Other people's boots, so a teammate moving nearby is audible.
    for (const other of scene.players) {
      if (other.id === this.localId || other.state !== 0) continue;
      if (!(other.flags & F_MOVING)) continue;
      const last = this.remoteSteps.get(other.id) ?? 0;
      const interval = (other.flags & F_SPRINT) ? 0.28 : (other.flags & F_CROUCH) ? 0.62 : 0.42;
      if (performance.now() - last < interval * 1000) continue;
      this.remoteSteps.set(other.id, performance.now());
      this.audio.footstep(other.x, other.y, {
        sprint: !!(other.flags & F_SPRINT), crouch: !!(other.flags & F_CROUCH),
      });
    }
  }

  updateHud(scene) {
    this.hud.setMeters(this.player.stamina, this.player.charge);
    this.hud.setReserve(this.player.reserve);
    this.hud.setCarrying(!!this.carrying);
    this.hud.setFusePips(this.powered, this.need);
    this.hud.setPing(this.net.ping);
    if (this.player.state === 1) this.hud.setDowned(true, this.downTimer);

    if (this.door[0] === 2) this.hud.setObjective('RUN. The way out is open.', true);
    else if (this.door[0] === 1) this.hud.setObjective('The shutter is winding up', true);
    else if (this.generatorOn) this.hud.setObjective('Find the exit panel and press it', true);
    else if (this.powered >= this.need) this.hud.setObjective('Start the generator');
    else if (this.carrying) this.hud.setObjective('Carry the fuse to the generator');
    else if (this.powered > 0) this.hud.setObjective(`Find another fuse (${this.powered}/${this.need} seated)`);
    else this.hud.setObjective('Find a fuse in the dark');

    this.hud.updateRoster(scene.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, state: p.state,
      carrying: p.carrying, downTimer: p.downTimer,
    })), this.localId);
  }

  showScoreboard(show) {
    const scene = this.latest ? this.buildScene(0) : null;
    this.hud.toggleScoreboard(show, scene ? scene.players : [], this.powered, this.need, this.roundTime);
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function index(rows) {
  const map = new Map();
  for (const row of rows || []) map.set(row[0], row);
  return map;
}

window.game = new Game();
