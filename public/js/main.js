// SIGNAL LOST - client entry point.
//
// Owns the renderer, the round state machine and the glue between modules:
// input -> local simulation -> network, and network -> entities/HUD/audio.

import * as THREE from '../vendor/three.module.js';
import { Net } from './net.js';
import { Hud } from './hud.js';
import { Fx } from './fx.js';
import { AudioEngine } from './audio.js';
import { World, QUALITY } from './world.js';
import { Entities, MONSTER_STATE, PLAYER_STATE, FLAG } from './entities.js';
import { Input, LocalPlayer } from './player.js';

// How long each interaction takes. Longer actions are louder and riskier - the
// generator is the noisiest thing you can do, on purpose.
// Ambient is deliberately just above the threshold of visibility: enough to
// make out a wall edge two metres away, nowhere near enough to navigate by.
const AMBIENT_BASE = 0.5;

const HOLD_TIME = { fuse: 0.9, insert: 1.9, revive: 3.6, exit: 1.4 };
const REACH = { fuse: 2.6, insert: 3.4, revive: 2.6, exit: 4.0 };

class Game {
  constructor() {
    this.canvas = document.getElementById('scene');
    this.settings = this.loadSettings();

    this.hud = new Hud();
    this.fx = new Fx();
    this.audio = new AudioEngine();
    this.net = new Net();
    this.input = new Input(this.canvas);
    this.input.sensitivity = this.settings.sensitivity;

    this.phase = 'title';
    this.playerInfo = new Map();
    this.snapshot = null;
    this.powered = 0;
    this.need = 6;
    this.exitOpen = false;
    this.roundTime = 0;
    this.hold = { kind: null, id: null, time: 0, cooldown: 0 };
    this.heartTimer = 0;
    this.growlTimer = 6;
    this.remoteSteps = new Map();
    this.endCountdown = 0;
    this.spectating = null;

    this.setupRenderer();
    this.setupScene();
    this.bindHud();
    this.bindNet();
    this.bindKeys();

    this.hud.applySettings(this.settings);
    this.hud.showScreen('title');
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());

    window.addEventListener('resize', () => this.resize());
  }

  // --- Boot -----------------------------------------------------------------

  loadSettings() {
    const defaults = { sensitivity: 1, volume: 0.8, fov: 75, quality: 'medium' };
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem('signal-lost:settings') || '{}') };
    } catch {
      return defaults;
    }
  }

  saveSettings() {
    try {
      localStorage.setItem('signal-lost:settings', JSON.stringify(this.settings));
    } catch { /* private mode - settings just will not persist */ }
  }

  setupRenderer() {
    const q = QUALITY[this.settings.quality] || QUALITY.medium;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.settings.quality === 'high',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.settings.quality === 'low' ? 1 : 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tone mapping keeps the torch hotspot from blowing out to white.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04060a);
    // Exponential fog is what sells the darkness: corridors fade out well
    // before the far plane, so the level never reveals its shape.
    this.scene.fog = new THREE.FogExp2(0x05070a, 0.072);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.05, 90);

    this.ambient = new THREE.AmbientLight(0x18222c, AMBIENT_BASE);
    this.scene.add(this.ambient);

    this.player = new LocalPlayer(this.camera, this.scene);
    this.player.setShadows(
      (QUALITY[this.settings.quality] || QUALITY.medium).shadows,
      (QUALITY[this.settings.quality] || QUALITY.medium).shadowSize
    );
    this.player.onFootstep = (info) => this.audio.footstep(0, 0, { ...info, own: true });
    this.player.onTorchToggle = (on, forced) => {
      this.audio.blip(on ? 620 : 400, 0.05, 'square', 0.08);
      if (forced) this.hud.banner('TORCH DEAD', 'bad', 2.4);
    };

    this.world = new World(this.scene, this.settings.quality);
    this.entities = new Entities(this.scene, this.settings.quality);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // --- Wiring ---------------------------------------------------------------

  bindHud() {
    this.hud
      .on('join', (name) => this.join(name))
      .on('start', () => this.net.start())
      .on('ready', () => this.net.ready())
      .on('chat', (text) => { this.net.chat(text); this.audio.radioBlip(); })
      .on('chatClosed', () => { this.input.captureText = false; })
      .on('requestLock', () => { this.audio.init(); this.input.requestLock(); })
      .on('resume', () => { this.input.requestLock(); })
      .on('leave', () => this.leave())
      .on('difficulty', (v) => this.net.setConfig({ difficulty: v }))
      .on('size', (v) => this.net.setConfig({ size: v }))
      .on('fuses', (v) => this.net.setConfig({ fuses: v }))
      .on('sensitivity', (v) => {
        this.settings.sensitivity = v / 100;
        this.input.sensitivity = this.settings.sensitivity;
        this.saveSettings();
      })
      .on('volume', (v) => {
        this.settings.volume = v / 100;
        this.audio.setVolume(this.settings.volume);
        this.saveSettings();
      })
      .on('fov', (v) => {
        this.settings.fov = v;
        this.camera.fov = v;
        this.camera.updateProjectionMatrix();
        this.saveSettings();
      })
      .on('quality', (v) => {
        this.settings.quality = v;
        this.saveSettings();
        this.hud.banner('GRAPHICS APPLY ON THE NEXT RUN', '', 3);
      });

    this.input.onLockChange = (locked) => {
      if (this.phase !== 'playing') return;
      if (locked) this.hud.showScreen(null);
      else if (!this.hud.chatOpen) this.hud.showScreen('pause');
    };
  }

  bindNet() {
    this.net
      .on('hello', (m) => {
        this.localId = m.id;
        this.need = m.cfg.fuses;
      })
      .on('lobby', (m) => {
        this.playerInfo = new Map(m.players.map((p) => [p.id, p]));
        this.entities.setPlayerInfo(this.playerInfo);
        if (this.phase === 'lobby' || this.phase === 'title') {
          this.phase = 'lobby';
          this.hud.showScreen('lobby');
          this.hud.setHudVisible(false);
        }
        this.hud.renderLobby(m, this.localId);
      })
      .on('begin', (m) => this.beginRound(m))
      .on('snap', (m) => this.onSnapshot(m))
      .on('ev', (m) => this.onEvent(m))
      .on('chat', (m) => this.hud.addChat(m.from, m.m, m.color))
      .on('end', (m) => this.endRound(m))
      .on('full', () => this.hud.setJoinError('That facility is full. Try again when someone leaves.'))
      .on('disconnected', () => {
        this.hud.setJoinError('Connection to the host was lost.');
        this.hud.setHudVisible(false);
        this.hud.showScreen('title');
        this.phase = 'title';
        this.audio.stopAll();
      });
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (this.hud.chatOpen) return;
      switch (e.code) {
        case 'KeyF':
          if (this.phase === 'playing' && this.player.state === PLAYER_STATE.ALIVE) this.player.toggleTorch();
          break;
        case 'KeyT':
        case 'Enter':
          if (this.phase === 'playing') {
            this.input.captureText = true;
            this.hud.openChat();
          }
          break;
        case 'KeyQ':
          if (this.phase === 'playing' && this.carrying) this.net.use('drop');
          break;
        case 'Tab':
          if (this.phase === 'playing') this.showScoreboard(true);
          break;
        default:
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.showScoreboard(false);
    });
  }

  async join(name) {
    this.audio.init();
    this.audio.setVolume(this.settings.volume);
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
    this.entities.reset();
    this.world.dispose();
    this.hud.setHudVisible(false);
    this.hud.showScreen('title');
    this.hud.setJoinError('');
    this.input.exitLock();
  }

  // --- Round lifecycle ------------------------------------------------------

  beginRound(m) {
    this.hud.setLoading(true, 'DESCENDING...');

    // Yield a frame so the loading card actually paints before the main thread
    // disappears into geometry building.
    requestAnimationFrame(() => {
      this.map = m.map;
      this.need = m.need;
      this.powered = 0;
      this.exitOpen = false;
      this.roundTime = 0;
      this.spectating = null;
      this.entities.reset();
      this.world.build(m.map);

      const spawn = m.map.spawnPoints[Math.floor(Math.random() * m.map.spawnPoints.length)] || m.map.spawn;
      this.player.spawn(spawn.x, spawn.z);
      this.player.yaw = this.bestFacing(spawn);

      this.phase = 'playing';
      this.hud.setHudVisible(true);
      this.hud.setFusePips(0, this.need);
      this.hud.setObjective('Find a fuse in the dark');
      this.hud.setCarrying(false);
      this.hud.setDowned(false);
      this.hud.setDead(false);
      this.hud.setLoading(false);
      this.hud.showScreen('click');
      this.hud.addSystem(`The facility is dark. ${this.need} fuses are somewhere down here.`);
      this.fx.reset();

      this.audio.init();
      this.audio.startAmbient();
      this.audio.setTension(0);
    });
  }

// Look down the longest unobstructed run from a spawn point, so nobody opens
  // their eyes pressed against a wall.
  bestFacing(spawn) {
    const cell = this.world.worldToCell(spawn.x, spawn.z);
    const dirs = [
      // A camera looks down its local -Z, so yaw 0 faces -Z (grid north).
      { dx: 0, dy: -1, yaw: 0 },
      { dx: 1, dy: 0, yaw: -Math.PI / 2 },
      { dx: 0, dy: 1, yaw: Math.PI },
      { dx: -1, dy: 0, yaw: Math.PI / 2 },
    ];
    let best = dirs[0], bestRun = -1;
    for (const dir of dirs) {
      let run = 0;
      while (run < 12 && !this.world.isSolidCell(cell.cx + dir.dx * (run + 1), cell.cy + dir.dy * (run + 1))) run++;
      if (run > bestRun) { bestRun = run; best = dir; }
    }
    return best.yaw;
  }

  endRound(m) {
    this.phase = 'ended';
    this.endCountdown = 14;
    this.hud.setHudVisible(false);
    this.hud.renderEnd(m);
    this.hud.showScreen('end');
    this.hud.setDowned(false);
    this.hud.setDead(false);
    this.input.exitLock();
    this.audio.setTension(0);
    this.audio.stopLoop('generator');
    this.fx.reset();
    if (m.outcome === 'escaped') this.audio.revived();
    else this.audio.hit();
  }

  // --- Server messages ------------------------------------------------------

  onSnapshot(m) {
    this.snapshot = m;
    this.entities.push(m);
    this.powered = m.g;
    this.exitOpen = !!m.x;
    this.roundTime = m.tm;

    const mine = (m.p || []).find((row) => row[0] === this.localId);
    if (mine) {
      const wasState = this.player.state;
      this.player.state = mine[6];
      this.carrying = mine[7] >= 0;
      this.downTimer = mine[8];

      if (wasState !== this.player.state) this.onOwnStateChange(wasState, this.player.state);
      // The server is the authority on where a downed body lies.
      if (this.player.state !== PLAYER_STATE.ALIVE) {
        this.player.position.x = mine[1];
        this.player.position.z = mine[3];
      }
    }
  }

  onOwnStateChange(from, to) {
    if (to === PLAYER_STATE.DOWN) {
      this.audio.hit();
      this.fx.hitFlash(0.75, 1.1);
      this.player.kick(3);
      this.hud.banner('IT HAS YOU', 'bad', 3);
    } else if (to === PLAYER_STATE.ALIVE && from === PLAYER_STATE.DOWN) {
      this.audio.revived();
      this.fx.hitFlash(0.25, 0.5, '#2b7a4b');
      this.hud.banner('BACK ON YOUR FEET', 'good', 2.4);
    } else if (to === PLAYER_STATE.DEAD) {
      this.hud.banner('YOU BLED OUT', 'bad', 4);
      this.audio.setTension(0);
    } else if (to === PLAYER_STATE.ESCAPED) {
      this.hud.banner('YOU MADE IT OUT', 'good', 4);
    }
    this.hud.setDowned(to === PLAYER_STATE.DOWN, this.downTimer);
    this.hud.setDead(to === PLAYER_STATE.DEAD);
  }

  onEvent(ev) {
    switch (ev.k) {
      case 'ambient': {
        const fn = { clang: 'clang', drip: 'drip', whisper: 'whisper', scrape: 'scrape', breath: 'breath' }[ev.kind];
        if (fn && this.audio[fn]) this.audio[fn](ev.x, ev.z);
        break;
      }
      case 'wake':
        this.hud.banner('SOMETHING IS AWAKE', 'bad', 3.4);
        this.audio.growl(ev.x, ev.z, 1.2);
        break;
      case 'scream':
        this.audio.scream(ev.x, ev.z);
        if (ev.target === this.localId) {
          this.hud.banner('IT SEES YOU - RUN', 'bad', 3);
          this.fx.hitFlash(0.3, 0.5);
          this.player.kick(1.2);
        }
        break;
      case 'fuse':
        this.audio.fuseInsert(ev.x, ev.z);
        this.hud.setFusePips(ev.n, ev.need);
        this.hud.addSystem(`${ev.by} seated a fuse (${ev.n}/${ev.need}).`);
        if (ev.n < ev.need) this.hud.banner(`${ev.n} / ${ev.need} FUSES`, '', 2.4);
        break;
      case 'power':
        this.audio.powerUp();
        this.audio.doorOpen(ev.x, ev.z);
        this.hud.banner('POWER RESTORED - GET TO THE EXIT', 'good', 5);
        this.hud.addSystem('The blast door is open. It knows exactly where you are now.');
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
      case 'pickup':
        if (ev.by) this.hud.addSystem(`${ev.by} picked up a fuse.`);
        break;
      case 'joined':
        this.hud.addSystem(`${ev.name} joined.`);
        break;
      case 'left':
        this.hud.addSystem(`${ev.name} left.`);
        break;
      default:
        break;
    }
  }

  // --- Frame ----------------------------------------------------------------

  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.hud.tick(dt);

    if (this.phase === 'playing') this.updatePlaying(dt);
    else if (this.phase === 'ended') this.updateEnded(dt);

    this.renderer.render(this.scene, this.camera);
  }

  updateEnded(dt) {
    this.endCountdown -= dt;
    this.hud.setEndCountdown(Math.ceil(this.endCountdown));
    // Keep the world drifting behind the results card rather than freezing.
    this.entities.update(dt, this.localId);
    this.world.update(dt, this.camera.position, this.powered, this.exitOpen);
  }

  updatePlaying(dt) {
    const frozen = this.hud.chatOpen || !!this.hud.current;
    this.player.update(dt, this.input, this.world, { frozen });

    if (this.player.state === PLAYER_STATE.DEAD) this.spectate(dt);

    this.entities.update(dt, this.localId);
    this.world.update(dt, this.player.position, this.powered, this.exitOpen);

    const threat = this.entities.nearestMonster(this.player.position);
    this.updateFear(dt, threat);
    this.updateInteraction(dt);
    this.updateAudio(dt, threat);
    this.updateHud(dt);

    this.net.sendInput(this.player.position, this.player.yaw, this.player.flags());
  }

  // Dead players ride along with whoever is still breathing.
  spectate(dt) {
    const alive = [...this.entities.players.entries()]
      .filter(([, e]) => e.data.state === PLAYER_STATE.ALIVE);
    if (!alive.length) return;
    if (!this.spectating || !alive.some(([id]) => id === this.spectating)) {
      this.spectating = alive[0][0];
    }
    const target = this.entities.players.get(this.spectating);
    if (!target) return;
    const p = target.group.position;
    this.camera.position.lerp(new THREE.Vector3(p.x, 2.4, p.z), Math.min(1, dt * 2.5));
  }

  updateFear(dt, threat) {
    const litNearby = this.exitOpen || this.powered > 0;
    let allyNear = false;
    for (const e of this.entities.players.values()) {
      if (e.data.state !== PLAYER_STATE.ALIVE) continue;
      if (e.group.position.distanceTo(this.player.position) < 7) { allyNear = true; break; }
    }
    this.player.updateNerve(dt, {
      monsterDistance: threat.distance,
      monsterChasing: threat.state === MONSTER_STATE.CHASE,
      allyNear,
      lit: litNearby && this.exitOpen,
    });
    this.fx.update(dt, this.player.nerve);

    // The room brightens a little once the generator carries load.
    const targetAmbient = AMBIENT_BASE + (this.powered / Math.max(1, this.need)) * AMBIENT_BASE * 0.8;
    this.ambient.intensity += (targetAmbient - this.ambient.intensity) * Math.min(1, dt);
    const targetFog = this.exitOpen ? 0.055 : 0.072;
    this.scene.fog.density += (targetFog - this.scene.fog.density) * Math.min(1, dt * 0.5);
  }

  // --- Interaction ----------------------------------------------------------

  updateInteraction(dt) {
    this.hold.cooldown = Math.max(0, this.hold.cooldown - dt);

    if (this.player.state !== PLAYER_STATE.ALIVE || this.hud.chatOpen || this.hud.current) {
      this.cancelHold();
      return;
    }

    const target = this.findTarget();
    if (!target) {
      this.cancelHold();
      this.hud.hidePrompt();
      return;
    }

    const holding = this.input.down('KeyE') && this.hold.cooldown === 0;
    if (holding) {
      // Changing target mid-hold restarts it, so you cannot bank progress.
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
        if (target.kind === 'fuse') this.audio.pickup();
        this.hold.cooldown = 0.7;
        this.cancelHold();
        this.hud.hidePrompt();
        return;
      }
      this.hud.showPrompt('E', target.label, this.hold.time / needed);
    } else {
      this.cancelHold();
      this.hud.showPrompt('E', target.label, 0);
    }
  }

  cancelHold() {
    this.hold.kind = null;
    this.hold.id = null;
    this.hold.time = 0;
    this.player.busy = false;
  }

  // Pick the closest thing worth pressing E on, preferring whatever the player
  // is actually looking at.
  findTarget() {
    const pos = this.player.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const candidates = [];

    if (this.carrying && this.map) {
      const g = this.map.generator;
      candidates.push({ kind: 'insert', id: 0, x: g.x, z: g.z, label: 'Seat the fuse' });
    }
    if (this.exitOpen && this.map) {
      const e = this.map.exit;
      candidates.push({ kind: 'exit', id: 0, x: e.x, z: e.z, label: 'Escape' });
    }
    if (!this.carrying) {
      for (const item of this.entities.interactables()) {
        if (item.kind === 'fuse') candidates.push({ ...item, label: 'Take the fuse' });
      }
    }
    for (const item of this.entities.interactables()) {
      if (item.kind !== 'revive') continue;
      const info = this.playerInfo.get(item.id);
      candidates.push({ ...item, label: `Pull ${info ? info.name : 'them'} up` });
    }

    let best = null;
    for (const c of candidates) {
      const dx = c.x - pos.x, dz = c.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > REACH[c.kind]) continue;
      // Facing test, relaxed when you are almost on top of the thing.
      const facing = dist < 0.9 ? 1 : (dx * forward.x + dz * forward.z) / Math.max(dist, 0.001);
      if (facing < 0.25) continue;
      const score = dist - facing * 1.5;
      if (!best || score < best.score) best = { ...c, score };
    }
    return best;
  }

  // --- Audio & HUD ----------------------------------------------------------

  updateAudio(dt, threat) {
    this.audio.updateListener(this.camera);

    // Dread layer scales with how close the thing is and whether it is hunting.
    let tension = 0;
    if (Number.isFinite(threat.distance)) {
      const proximity = Math.max(0, 1 - threat.distance / 32);
      const weight = threat.state === MONSTER_STATE.CHASE ? 1
        : threat.state === MONSTER_STATE.HUNT ? 0.5 : 0.25;
      tension = proximity * weight;
    }
    if (this.player.state === PLAYER_STATE.DOWN) tension = Math.max(tension, 0.7);
    this.audio.setTension(tension);

    if (this.map) {
      const g = this.map.generator;
      this.audio.generatorHum(g.x, g.z, this.powered / Math.max(1, this.need));
    }

    // Heartbeat, paced by nerve.
    if (this.player.nerve > 0.34 && this.player.state !== PLAYER_STATE.DEAD) {
      this.heartTimer -= dt;
      if (this.heartTimer <= 0) {
        this.heartTimer = 1.25 - this.player.nerve * 0.8;
        this.audio.heartbeat(0.35 + this.player.nerve * 0.65);
      }
    } else {
      this.heartTimer = 0;
    }

    // An occasional growl when it is near but not yet chasing: the sound that
    // makes people turn their torch off.
    this.growlTimer -= dt;
    if (this.growlTimer <= 0) {
      this.growlTimer = 7 + Math.random() * 9;
      if (Number.isFinite(threat.distance) && threat.distance < 22 && threat.state !== MONSTER_STATE.CHASE) {
        for (const m of this.entities.monsters.values()) {
          if (m.data.state === MONSTER_STATE.DORMANT) continue;
          this.audio.growl(m.data.x, m.data.z, 0.8);
          break;
        }
      }
    }

    this.updateRemoteFootsteps(dt);
  }

  // Remote players have no simulated velocity here, only flags - so their steps
  // are timed from their gait instead, which is close enough to sell direction.
  updateRemoteFootsteps(dt) {
    for (const [id, entity] of this.entities.players) {
      if (!entity.data || entity.data.state !== PLAYER_STATE.ALIVE) continue;
      if (!(entity.data.flags & FLAG.MOVING)) continue;

      const dist = entity.group.position.distanceTo(this.player.position);
      if (dist > 26) continue;

      let timer = this.remoteSteps.get(id) ?? 0;
      timer -= dt;
      if (timer <= 0) {
        const sprint = (entity.data.flags & FLAG.SPRINT) !== 0;
        const crouch = (entity.data.flags & FLAG.CROUCH) !== 0;
        timer = sprint ? 0.31 : crouch ? 0.66 : 0.46;
        this.audio.footstep(entity.group.position.x, entity.group.position.z, { sprint, crouch });
      }
      this.remoteSteps.set(id, timer);
    }
  }

  updateHud(dt) {
    this.hud.setMeters(this.player.stamina, this.player.battery);
    this.hud.setCarrying(!!this.carrying);
    this.hud.setFusePips(this.powered, this.need);
    this.hud.setPing(this.net.ping);

    if (this.player.state === PLAYER_STATE.DOWN) this.hud.setDowned(true, this.downTimer);

    if (this.exitOpen) {
      this.hud.setObjective('RUN. The exit is open.', true);
    } else if (this.carrying) {
      this.hud.setObjective('Carry the fuse to the generator');
    } else if (this.powered > 0) {
      this.hud.setObjective(`Find another fuse (${this.powered}/${this.need} seated)`);
    } else {
      this.hud.setObjective('Find a fuse in the dark');
    }

    const roster = [];
    for (const [id, info] of this.playerInfo) {
      const row = this.snapshot ? (this.snapshot.p || []).find((r) => r[0] === id) : null;
      roster.push({
        id, name: info.name, color: info.color,
        state: row ? row[6] : 0,
        carrying: row ? row[7] >= 0 : false,
        downTimer: row ? row[8] : 0,
      });
    }
    this.hud.updateRoster(roster, this.localId);
    this.rosterCache = roster;
  }

  showScoreboard(show) {
    this.hud.toggleScoreboard(show, this.rosterCache || [], this.powered, this.need, this.roundTime);
  }
}

// Fail loudly rather than leaving a black screen with no explanation.
try {
  window.game = new Game();
} catch (err) {
  console.error(err);
  document.body.innerHTML =
    `<div style="color:#c9d3dc;font-family:ui-monospace,monospace;padding:12vh 8vw;line-height:1.8">
       <h1 style="letter-spacing:.2em">SIGNAL LOST</h1>
       <p style="color:#c8452f">This browser could not start the game.</p>
       <p style="color:#6d7a86">${String(err && err.message ? err.message : err)}</p>
       <p style="color:#6d7a86">WebGL is required. Try a recent Chrome, Edge, Firefox or Safari.</p>
     </div>`;
}
