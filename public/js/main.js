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
import { Backrooms } from './backrooms.js';
import { ViewWeapon } from './weapon.js';
import { Entities, MONSTER_STATE, PLAYER_STATE, FLAG } from './entities.js';
import { Input, LocalPlayer } from './player.js';

// How long each interaction takes. Longer actions are louder and riskier - the
// generator is the noisiest thing you can do, on purpose.
// Ambient is deliberately just above the threshold of visibility: enough to
// make out a wall edge two metres away, nowhere near enough to navigate by.
const AMBIENT_BASE = 0.5;

// With the generator running the facility is genuinely lit: this is what makes
// every room bright, not only the one with the lamps you can see.
const AMBIENT_LIT = 9;

// Never drop below this fraction of a device pixel per screen pixel: past
// here the picture is mush and the game stops being readable in the dark.
const MIN_RENDER_SCALE = 0.55;

// The Backrooms are the opposite of the facility: flatly, evenly lit, with
// nowhere for anything to hide. That is the horror of them. Bright enough to
// see every corner, dim enough that the walls stay a dirty mustard rather than
// blowing out to white.
const AMBIENT_BACKROOMS = 5.5;

// The rifle's rate of fire, in seconds between rounds, and how many rounds a
// magazine holds. The server enforces both, so this is prediction, not
// permission.
const FIRE_INTERVAL = 0.096;
const MAG_SIZE = 30;

const HOLD_TIME = {
  fuse: 0.9, insert: 1.9, revive: 3.6,
  battery: 0.4, power: 1.2,
  gas: 0.7,
  // Pouring is deliberately the longest thing you can do, and the loudest.
  pour: 3.2,
  // The door button is a button: you press it, you do not wrestle with it.
  button: 0.25,
  weapon: 0.8,
  ladder: 0.5,
};
const REACH = {
  fuse: 2.6, insert: 3.4, revive: 2.6,
  battery: 2.4, power: 3.6, gas: 2.6, pour: 3.6,
  button: 2.4, weapon: 2.6, ladder: 2.0,
};

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
    this.roundTime = 0;
    this.zone = 0;
    this.door = [0, 0];
    this.back = null;
    this.armed = false;
    this.ammo = { mag: 0, reserve: 0, reloading: 0 };
    this.climb = 0;
    this.transitioning = false;
    this.fireHeld = false;
    this.shotDebt = 0;
    this.dryTimer = 0;
    this.climbStep = 0;
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
    // Filmic tone mapping keeps the flashlight hotspot from blowing out to white.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    // The rifle is drawn in a second pass over a cleared depth buffer, so the
    // frame clears itself once, explicitly, instead of once per render call.
    this.renderer.autoClear = false;
    // ...which also means the render counters have to be reset by hand, or the
    // second pass wipes the first pass's numbers before anyone can read them.
    this.renderer.info.autoReset = false;
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
    this.player.onFlashlightToggle = (on, forced) => {
      this.audio.blip(on ? 620 : 400, 0.05, 'square', 0.08);
      if (forced) this.hud.banner('FLASHLIGHT DEAD', 'bad', 2.4);
    };

    this.world = new World(this.scene, this.settings.quality);
    this.backrooms = new Backrooms(this.scene, this.settings.quality);
    this.viewWeapon = new ViewWeapon(this.settings.quality);
    this.viewWeapon.resize(window.innerWidth / window.innerHeight);
    this.entities = new Entities(this.scene, this.settings.quality);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    if (this.renderScale) this.renderer.setPixelRatio(this.renderScale);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.viewWeapon) this.viewWeapon.resize(window.innerWidth / window.innerHeight);
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
          if (this.phase === 'playing' && this.player.state === PLAYER_STATE.ALIVE) this.player.toggleFlashlight();
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
        case 'KeyR':
          if (this.phase === 'playing' && this.player.state === PLAYER_STATE.ALIVE) this.reload();
          break;
        case 'KeyG':
          if (this.phase === 'playing' && this.armed) this.net.use('dropgun');
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

    // The rifle is fired with the mouse, held down: it is an automatic.
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.fireHeld = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    window.addEventListener('blur', () => { this.fireHeld = false; });
  }

  // R feeds whatever is empty. The rifle takes priority when it is the thing
  // that needs it, because that is the one you are about to want.
  reload() {
    if (this.armed && this.ammo.mag < MAG_SIZE && this.ammo.reserve > 0 && !this.ammo.reloading) {
      this.net.send({ t: 'rl' });
      return;
    }
    if (this.armed && this.ammo.mag < MAG_SIZE && this.ammo.reserve === 0 && this.player.charge >= 99.5) {
      this.hud.banner('NO MAGAZINES LEFT', 'bad', 1.8);
      this.audio.blip(240, 0.08, 'square', 0.09);
      return;
    }
    if (this.player.reserve <= 0) {
      this.hud.banner('NO SPARE BATTERIES', 'bad', 1.8);
      this.audio.blip(240, 0.08, 'square', 0.09);
      return;
    }
    if (this.player.charge >= 99.5) {
      this.hud.banner('FLASHLIGHT ALREADY FULL', '', 1.6);
      return;
    }
    this.net.reload();
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
    this.zone = 0;
    this.armed = false;
    this.climb = 0;
    this.transitioning = false;
    this.entities.reset();
    this.world.dispose();
    this.backrooms.dispose();
    this.viewWeapon.equip(false);
    this.hud.setFade(false);
    this.hud.setAmmo(false, 0, 0, 0);
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
      this.back = m.back || null;
      this.need = m.need;
      this.powered = 0;
      this.roundTime = 0;
      this.spectating = null;
      this.generatorOn = false;
      this.door = [0, 0];
      this.zone = 0;
      this.armed = false;
      this.climb = 0;
      this.transitioning = false;
      this.ammo = { mag: 0, reserve: 0, reloading: 0 };
      this.entities.reset();
      this.backrooms.dispose();
      this.viewWeapon.equip(false);
      this.hud.setFade(false);
      this.hud.setAmmo(false, 0, 0, 0);
      this.world.build(m.map);
      this.entities.setMap(m.map);

      const spawn = m.map.spawnPoints[Math.floor(Math.random() * m.map.spawnPoints.length)] || m.map.spawn;
      this.player.spawn(spawn.x, spawn.z);
      this.player.yaw = this.bestFacing(spawn);

      this.phase = 'playing';
      this.hud.setHudVisible(true);
      this.hud.setFusePips(0, this.need);
      this.hud.setObjective('Find a fuse in the dark');
      this.hud.setCarrying(null);
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
    this.audio.stopLoop('backrooms');
    // The fade is only ever there to cover a transition; the results card is
    // the thing that should be on screen now.
    this.hud.setFade(false);
    this.fx.reset();
    // Whichever ending music is already running keeps running over the card.
    if (this.audio.loops.has('final') || this.audio.loops.has('ending')) return;
    if (m.outcome === 'escaped') this.audio.revived();
    else this.audio.hit();
  }

  // --- Server messages ------------------------------------------------------

  onSnapshot(m) {
    this.snapshot = m;
    this.entities.push(m);
    this.powered = m.g;
    this.door = m.dr || [0, 0];
    // Collision must follow the server's door state immediately, not on the
    // next rendered frame: on a machine drawing at a few frames a second that
    // is the difference between a doorway that is open and one that is not.
    this.world.doorOpen = this.door[0] === 2;
    this.generatorOn = !!m.o;
    this.sabotage = m.sb || null;
    this.fire = m.fi || 0;
    // The fuel can's holder is in the snapshot, so no extra player field.
    this.carryingGas = !!(m.gs && m.gs[2] === 1 && m.gs[3] === this.localId);
    this.roundTime = m.tm;

    // The rifle. It is one object in the whole round, so the snapshot carries
    // its ammunition rather than each player carrying their own.
    const gun = m.wp;
    const wasArmed = this.armed;
    this.armed = !!(gun && gun[2] === 1 && gun[3] === this.localId);
    if (gun) this.ammo = { mag: gun[4], reserve: gun[5], reloading: gun[6] };
    if (this.armed !== wasArmed) {
      this.viewWeapon.equip(this.armed);
      if (this.armed) this.hud.addSystem('Rifle. Sixty rounds, and nothing down here that reloads it.');
    }

    // Row: [id, x, y, z, yaw, pitch, flags, state, carrying, downTimer, charge,
    //       reserve, zone, climb]
    const mine = (m.p || []).find((row) => row[0] === this.localId);
    if (mine) {
      const wasState = this.player.state;
      const serverZone = mine[12] ?? 0;
      this.climb = mine[13] ?? 0;
      // The server decides when you have crossed over; the client just plays
      // the transition it is told to play.
      if (serverZone !== this.zone && !this.transitioning) this.crossOver(serverZone, mine);
      this.player.state = mine[7];
      this.carrying = mine[8] >= 0;
      this.downTimer = mine[9];

      // The server owns charge and reserve. Local prediction keeps the bar
      // smooth between snapshots; this is the correction.
      const serverCharge = mine[10];
      if (Math.abs(serverCharge - this.player.charge) > 2) this.player.charge = serverCharge;
      else this.player.charge = Math.min(this.player.charge, serverCharge + 1);
      this.player.reserve = mine[11];
      if (this.player.charge <= 0) this.player.flashlightOn = false;

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

  // Whichever level the player is actually standing in. Both classes answer
  // the same three questions the local simulation asks of them.
  activeWorld() {
    return this.zone === 1 && this.backrooms.built ? this.backrooms : this.world;
  }

  // The one transition in the game. The fade covers building the Backrooms and
  // tearing the facility down, so the swap costs nothing while anyone is
  // looking at it - and the weaker the machine, the more that matters.
  crossOver(zone, row) {
    if (zone !== 1 || !this.back) return;
    this.transitioning = true;
    this.hud.setFade(true);
    this.audio.stopLoop('ambient');
    this.audio.stopLoop('generator');
    this.audio.setTension(0);

    setTimeout(() => {
      // Leaving or ending the round mid-fade must not bring it back.
      if (this.phase !== 'playing' || !this.back) { this.transitioning = false; return; }
      this.zone = 1;
      this.backrooms.build(this.back);
      // Nothing in the facility is reachable again, so nothing in it needs to
      // stay in memory or in the draw list.
      this.world.dispose();
      this.player.teleport(row[1], row[3]);
      this.player.yaw = row[4];
      this.player.pitch = 0;
      this.scene.fog.density = 0.024;
      this.scene.fog.color.setHex(0xbda86a);
      this.scene.background = new THREE.Color(0xbda86a);
      this.ambient.color.setHex(0xfff0c0);
      this.fx.reset();

      this.audio.startBackroomsAmbient();
      this.hud.setObjective('Find the way out', false);
      this.hud.setFusePips(0, 0);
      this.hud.addSystem('The corridor smells of damp carpet. The lights do not stop.');
      this.hud.banner('WHERE IS THIS', '', 4);
      this.hud.setFade(false);
      this.transitioning = false;
    }, 1100);
  }

  // The ladder. The server owns the climb, so all the client does is put the
  // camera where the server says it is and make it feel like climbing.
  updateClimb(dt) {
    const ladder = this.back && this.back.ladder;
    if (!ladder) return;
    this.player.look(this.input);
    this.player.position.x = ladder.x - Math.sin(ladder.yaw) * 0.55;
    this.player.position.z = ladder.z - Math.cos(ladder.yaw) * 0.55;

    const eye = 1.62 + this.climb * (ladder.top + 0.9);
    const sway = Math.sin(this.climb * 34) * 0.045;
    this.camera.position.set(
      this.player.position.x + Math.cos(ladder.yaw) * sway,
      eye,
      this.player.position.z - Math.sin(ladder.yaw) * sway
    );
    this.camera.rotation.set(this.player.pitch + sway * 0.3, this.player.yaw, sway * 0.12, 'YXZ');

    // One sound per rung, keyed off how far up they are rather than a timer,
    // so it stays in step with what is on screen.
    const step = Math.floor(this.climb * 11);
    if (step !== this.climbStep) {
      this.climbStep = step;
      this.audio.ladderRung(this.player.position.x, this.player.position.z);
    }
  }

  // Firing. The client picks the direction and plays the flash; the server
  // decides whether anything was hit.
  updateShooting(dt) {
    const holding = this.armed && this.fireHeld && this.input.locked
      && this.player.state === PLAYER_STATE.ALIVE
      && !this.hud.chatOpen && !this.hud.current && !this.ammo.reloading;

    if (!holding) {
      this.shotDebt = 0;
      this.lastFireTick = performance.now();
      this.dryTimer = Math.max(0, (this.dryTimer ?? 0) - dt);
      return;
    }

    if (this.ammo.mag <= 0) {
      // Dry. Deliberately slower than the trigger, so holding it down on an
      // empty rifle is a click rather than a machine gun of clicks.
      this.shotDebt = 0;
      this.dryTimer = Math.max(0, (this.dryTimer ?? 0) - dt);
      if (this.dryTimer > 0) return;
      this.dryTimer = 0.45;
      this.viewWeapon.dryFire();
      this.audio.dryFire(this.player.position.x, this.player.position.z);
      return;
    }

    // The rifle's cadence is measured in seconds, not in frames. On a machine
    // rendering at five frames a second, one shot per frame would quietly halve
    // its rate of fire, so what is owed accumulates and is paid out here - and
    // it accumulates in real time, not in the frame delta, which is clamped for
    // the sake of the physics. The cap stops a long hitch from emptying the
    // magazine in a single frame.
    const now = performance.now();
    const real = Math.min(0.5, (now - (this.lastFireTick ?? now)) / 1000);
    this.lastFireTick = now;
    this.shotDebt = Math.min((this.shotDebt ?? 0) + real, FIRE_INTERVAL * 6);

    let fired = 0;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    while (this.shotDebt >= FIRE_INTERVAL && this.ammo.mag > 0) {
      this.shotDebt -= FIRE_INTERVAL;
      // Predict the round locally so the shot feels instant; the count the
      // server sends back in the next snapshot is the one that counts.
      this.ammo.mag--;
      this.net.shoot(dir);
      this.audio.gunshot(this.player.position.x, this.player.position.z, true);
      fired++;
    }
    if (!fired) return;

    // One flash and one kick a frame however many rounds went out in it -
    // there is only one frame to show them in.
    this.viewWeapon.fire();
    this.player.kick(0.85 * Math.min(2, fired));
    this.fx.hitFlash(0.06, 0.09, '#ffd9a0');
  }

  onEvent(ev) {
    switch (ev.k) {
      case 'ambient': {
        const fn = { clang: 'clang', drip: 'drip', whisper: 'whisper', scrape: 'scrape', breath: 'breath' }[ev.kind];
        if (fn && this.audio[fn]) this.audio[fn](ev.x, ev.z);
        break;
      }
      case 'waking':
        // The exploration phase is over, and you get told so.
        this.hud.banner('SOMETHING IS STIRRING', 'bad', 4);
        this.hud.addSystem('Somewhere below you, something just woke up.');
        this.audio.growl(ev.x, ev.z, 1.3);
        break;
      case 'awake':
        this.hud.banner('IT IS HUNTING NOW', 'bad', 3.4);
        this.audio.scream(ev.x, ev.z);
        break;
      case 'lost':
        // Only meaningful to whoever was being chased; kept quiet on purpose.
        break;
      case 'gas-taken':
        this.hud.addSystem(`${ev.by} picked up the gasoline.`);
        if (ev.id === this.localId) {
          this.hud.banner('GASOLINE', '', 2.4);
          this.hud.addSystem('Heavy. There is another way out of here.');
        }
        break;
      case 'gas-dropped':
        this.hud.addSystem('The gasoline hit the floor.');
        break;
      // --- The emergency door -------------------------------------------------
      case 'door-power':
        if (ev.on) {
          this.audio.doorUnlock(ev.x, ev.z);
          this.hud.banner('DOOR PANEL LIVE', 'good', 3.6);
          this.hud.addSystem('The panel by the bulkhead reads POWER: ON. Somebody has to press it.');
        } else {
          this.hud.addSystem('The door panel went dark.');
        }
        break;
      case 'door-dead':
        this.audio.buttonPress(ev.x, ev.z, true);
        if (ev.id === this.localId) this.hud.banner('NO POWER TO THE DOOR', 'bad', 2.4);
        break;
      case 'door-open':
        this.audio.buttonPress(ev.x, ev.z, false);
        this.audio.doorSequence(ev.x, ev.z, ev.seconds);
        this.hud.banner('THE SHUTTER IS COMING UP', '', 4);
        this.hud.addSystem(`${ev.by} pressed the button. Every floor of this building just heard it.`);
        break;
      case 'door-opened':
        this.hud.banner('THE WAY IS OPEN', 'good', 3.4);
        this.hud.addSystem('There is a passage behind the bulkhead. It does not look like the rest of the building.');
        break;
      case 'backrooms':
        if (ev.id !== this.localId) this.hud.addSystem(`${ev.who} went through.`);
        break;
      case 'climb':
        if (ev.id === this.localId) {
          this.climbStep = -1;
          this.hud.banner('CLIMBING', '', 2);
        } else {
          this.hud.addSystem(`${ev.who} started up the ladder.`);
        }
        break;
      case 'vent':
        if (ev.id === this.localId) {
          this.hud.setFade(true, 'YOU ARE OUT', 'The grille closes behind you');
          this.audio.stopLoop('backrooms');
          this.audio.startFinalMusic();
        } else {
          this.hud.addSystem(`${ev.who} got into the vent.`);
        }
        break;

      // --- The rifle -----------------------------------------------------------
      case 'gun-taken':
        this.hud.addSystem(`${ev.by} picked up the rifle.`);
        if (ev.id === this.localId) this.hud.banner('AK-47', '', 2.4);
        break;
      case 'gun-dropped':
        this.hud.addSystem('The rifle hit the floor.');
        break;
      case 'gun-reload':
        if (ev.id === this.localId) this.viewWeapon.reload();
        this.audio.gunReload(
          ev.id === this.localId ? this.player.position.x : 0,
          ev.id === this.localId ? this.player.position.z : 0,
          ev.seconds
        );
        break;
      case 'gun-reloaded':
        if (ev.id === this.localId) this.ammo = { mag: ev.mag, reserve: ev.reserve, reloading: 0 };
        break;
      case 'dry':
        if (ev.id !== this.localId) this.audio.dryFire(this.player.position.x, this.player.position.z);
        break;
      case 'shot':
        // Somebody else firing. The muzzle flash, the recoil and the report all
        // come from here, so a teammate shooting is unmistakable across a room.
        if (ev.id !== this.localId) {
          this.entities.remoteFire(ev.id);
          this.audio.gunshot(ev.x, ev.z, false);
        }
        this.impact(ev);
        break;
      case 'monster-hit':
        this.audio.fleshHit(ev.x, ev.z);
        break;
      case 'monster-down':
        this.audio.scream(ev.x, ev.z);
        this.hud.banner('IT WENT DOWN', 'good', 3.4);
        this.hud.addSystem(`${ev.by} put it down. It is not dead.`);
        break;
      case 'monster-rise':
        this.audio.growl(ev.x, ev.z, 1.6);
        this.hud.banner('IT IS UP AGAIN', 'bad', 4);
        this.hud.addSystem('It got back up. It is faster now.');
        break;
      case 'friendly':
        if (ev.id === this.localId) {
          this.fx.hitFlash(0.6, 0.9);
          this.player.kick(2);
          this.hud.banner(`${ev.by.toUpperCase()} IS SHOOTING YOU`, 'bad', 3);
        } else {
          this.hud.addSystem(`${ev.by} shot ${ev.who}.`);
        }
        break;
      case 'sabotage':
        this.audio.generatorStrain(ev.x, ev.z, ev.seconds);
        this.hud.banner('THE GENERATOR IS LABOURING', 'bad', 4);
        this.hud.addSystem(`${ev.by} poured the gasoline in. Get away from it.`);
        break;
      case 'spark':
        this.audio.sparkArc(ev.x, ev.z);
        this.fx.hitFlash(0.1, 0.12, '#ffb46a');
        break;
      case 'explosion':
        this.audio.explosion(ev.x, ev.z);
        this.audio.startEndingMusic();
        this.fx.hitFlash(0.95, 1.4, '#ffd08a');
        this.player.kick(3);
        this.hud.banner('THE GENERATOR IS GONE', 'bad', 5);
        this.hud.addSystem('Fire. The facility is burning.');
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
        if (ev.on) {
          this.audio.powerUp();
          this.audio.doorOpen(ev.x, ev.z);
          this.hud.banner('POWER ON - THE BUILDING IS LIT', 'good', 4.5);
          this.hud.addSystem(ev.by
            ? `${ev.by} started the generator. Every light in the facility is on.`
            : 'The generator caught. Every light in the facility is on - and it knows where you are.');
        } else {
          this.audio.blip(180, 0.5, 'sawtooth', 0.16);
          this.hud.banner('POWER CUT - DARK AGAIN', 'bad', 3.5);
          this.hud.addSystem(`${ev.by || 'Someone'} cut the power. The lights are out.`);
        }
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

      case 'pickup':
        if (ev.by) this.hud.addSystem(`${ev.by} picked up a fuse.`);
        if (ev.id === this.localId && ev.recharged) {
          this.audio.blip(700, 0.18, 'triangle', 0.14);
          this.hud.banner('FUSE CELL - FLASHLIGHT FULL', 'good', 2.6);
        }
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

  // Where a round ended up, drawn once. A puff of dust off concrete, or a
  // brief red mark on something that bleeds.
  impact(ev) {
    const x = ev.x + ev.dx * ev.d;
    const y = ev.y + ev.dy * ev.d;
    const z = ev.z + ev.dz * ev.d;
    if (ev.h === 0) this.audio.ricochet(x, z);
    this.entities.impact(x, y, z, ev.h);
  }

  // --- Frame ----------------------------------------------------------------

  frame() {
    const dt = Math.min(0.1, this.clock.getDelta());
    this.hud.tick(dt);
    this.adaptResolution(dt);

    if (this.phase === 'playing') this.updatePlaying(dt);
    else if (this.phase === 'ended') this.updateEnded(dt);

    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // The rifle, over a cleared depth buffer: no wall can reach into it.
    this.viewWeapon.render(this.renderer);
  }

// Scale the render resolution to hit the frame budget.
  //
  // This scene is fill-rate bound - several per-pixel lights and a shadow map -
  // so pixels are what a weak GPU runs out of first. Rather than asking players
  // to find the graphics setting, watch the frame time and quietly trade
  // resolution for smoothness, then give it back when there is headroom.
  adaptResolution(dt) {
    if (this.phase !== 'playing') return;

    // Exponential moving average: one slow frame should not trigger a change.
    this.frameAvg = this.frameAvg === undefined ? dt : this.frameAvg * 0.92 + dt * 0.08;
    this.resCooldown = (this.resCooldown ?? 0) - dt;
    if (this.resCooldown > 0) return;

    const cap = Math.min(window.devicePixelRatio, this.settings.quality === 'low' ? 1 : 1.5);
    const current = this.renderScale ?? cap;
    let next = current;

    if (this.frameAvg > 1 / 40) next = current - 0.15;        // under 40 fps: back off
    else if (this.frameAvg < 1 / 58 && current < cap) next = current + 0.1;

    next = Math.max(MIN_RENDER_SCALE, Math.min(cap, next));
    if (Math.abs(next - current) < 0.02) return;

    this.renderScale = next;
    this.resCooldown = 1.5;   // resizing the drawing buffer is not free either
    this.renderer.setPixelRatio(next);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  updateEnded(dt) {
    this.endCountdown -= dt;
    this.hud.setEndCountdown(Math.ceil(this.endCountdown));
    // Keep the world drifting behind the results card rather than freezing.
    this.entities.update(dt, this.localId, this.camera.position, this.zone);
    if (this.zone === 1) this.backrooms.update(dt, this.camera.position);
    else this.world.update(dt, this.camera.position, this.powered, this.door,
      this.generatorOn, this.fire, this.camera);
  }

  updatePlaying(dt) {
    const frozen = this.hud.chatOpen || !!this.hud.current || this.transitioning;
    // On the ladder the server owns your feet; all you keep is where you look.
    if (this.climb > 0) this.updateClimb(dt);
    else this.player.update(dt, this.input, this.activeWorld(), { frozen });

    if (this.player.state === PLAYER_STATE.DEAD) this.spectate(dt);

    this.entities.update(dt, this.localId, this.camera.position, this.zone);
    if (this.zone === 1) {
      this.backrooms.update(dt, this.player.position);
      this.audio.updateBackrooms(dt);
    } else {
      this.world.update(dt, this.player.position, this.powered, this.door,
        this.generatorOn, this.fire, this.camera);
    }

    this.viewWeapon.update(dt, {
      moveSpeed: this.player.planarSpeed || 0,
      lookDelta: this.input.lastLook || { x: 0, y: 0 },
      crouched: this.player.crouching,
    });
    this.updateShooting(dt);

    const threat = this.entities.nearestMonster(this.player.position);
    this.updateFear(dt, threat);
    this.updateInteraction(dt);
    this.updateAudio(dt, threat);
    // The HUD is text and bars; refreshing it ten times a second is plenty
    // and keeps DOM work out of the frame budget.
    this.hudTimer = (this.hudTimer ?? 0) - dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.updateHud(dt);
    }

    this.net.sendInput(this.player.position, this.player.yaw, this.player.pitch, this.player.flags());
  }

  // Dead players ride along with whoever is still breathing.
  spectate(dt) {
    const alive = [...this.entities.players.entries()]
      .filter(([, e]) => e.data.state === PLAYER_STATE.ALIVE && (e.data.zone ?? 0) === this.zone);
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
    // Nothing hunts you in the Backrooms, so none of the dread machinery runs
    // there. The place has to be unsettling on its own merits.
    if (this.zone === 1) return this.updateBackroomsMood(dt);

    const litNearby = this.generatorOn || this.powered > 0;
    let allyNear = false;
    for (const e of this.entities.players.values()) {
      if (e.data.state !== PLAYER_STATE.ALIVE) continue;
      if (e.group.position.distanceTo(this.player.position) < 7) { allyNear = true; break; }
    }
    this.player.updateNerve(dt, {
      monsterDistance: threat.distance,
      monsterChasing: threat.state === MONSTER_STATE.CHASE,
      allyNear,
      lit: litNearby && this.generatorOn,
    });
    this.fx.update(dt, this.player.nerve);

    // Running the generator lights the whole facility, not just its own room.
    // Doing that with real lights would mean dozens of them; lifting ambient
    // does it for every room at once and costs nothing per pixel, while the
    // nearest ceiling lamps still supply local pools of light.
    const burning = this.fire > 0;
    const targetAmbient = burning
      ? AMBIENT_BASE + this.fire * 2.5          // firelight, not floodlight
      : this.generatorOn ? AMBIENT_LIT : AMBIENT_BASE;
    this.ambient.intensity += (targetAmbient - this.ambient.intensity) * Math.min(1, dt * 1.5);

    // Smoke thickens as the fire spreads, and the room tone turns orange.
    const targetFog = burning
      ? 0.072 + this.fire * 0.09
      : this.generatorOn ? 0.038 : 0.072;
    this.scene.fog.density += (targetFog - this.scene.fog.density) * Math.min(1, dt * 0.8);
    if (burning) {
      this.ambient.color.setRGB(0.45 + this.fire * 0.25, 0.22, 0.1);
      this.scene.fog.color.setRGB(0.09 + this.fire * 0.08, 0.045, 0.03);
    } else if (this.ambient.color.g < 0.5) {
      this.ambient.color.setHex(0x18222c);
      this.scene.fog.color.setHex(0x05070a);
    }
    this.audio.fireBed(this.fire);
  }

  // The Backrooms have their own weather: no fog to speak of, flat warm light
  // and nothing chasing anybody. The unease is supposed to come from the room.
  updateBackroomsMood(dt) {
    this.ambient.intensity += (AMBIENT_BACKROOMS - this.ambient.intensity) * Math.min(1, dt * 1.2);
    this.scene.fog.density += (0.024 - this.scene.fog.density) * Math.min(1, dt * 0.8);
    this.player.updateNerve(dt, {
      monsterDistance: Infinity, monsterChasing: false, allyNear: true, lit: true,
    });
    this.fx.update(dt, this.player.nerve * 0.35);
  }

  // --- Interaction ----------------------------------------------------------

  updateInteraction(dt) {
    this.hold.cooldown = Math.max(0, this.hold.cooldown - dt);

    if (this.player.state !== PLAYER_STATE.ALIVE || this.hud.chatOpen || this.hud.current
      || this.climb > 0 || this.transitioning) {
      this.cancelHold();
      this.hud.hidePrompt();
      return;
    }

    const target = this.findTarget();
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
        if (target.kind === 'fuse' || target.kind === 'battery' || target.kind === 'gas'
          || target.kind === 'weapon') this.audio.pickup();
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
    // The door's button. It only ever exists on the panel, never on the door.
    if (this.map && this.map.door && this.zone === 0) {
      const panel = this.map.door.panel;
      if (this.door[0] === 0) {
        candidates.push({
          kind: 'button', id: 0, x: panel.x, z: panel.z,
          label: this.generatorOn ? 'Press the door button' : 'Press it anyway',
        });
      }
    }
    // The ladder at the end of the corridor. No marker leads to it.
    if (this.zone === 1 && this.back && this.climb <= 0) {
      const l = this.back.ladder;
      candidates.push({ kind: 'ladder', id: 0, x: l.x, z: l.z, label: 'Climb' });
    }
    // Once every fuse is seated the generator becomes a switch for the whole
    // building, and it can be thrown either way.
    if (!this.carrying && this.map && this.powered >= this.need) {
      const g = this.map.generator;
      candidates.push({
        kind: 'power', id: 0, x: g.x, z: g.z,
        label: this.generatorOn ? 'Cut the power' : 'Start the generator',
      });
    }
    for (const item of this.entities.interactables()) {
      if (item.kind === 'battery') candidates.push({ ...item, label: 'Take the battery' });
      if (item.kind === 'gas') candidates.push({ ...item, label: 'Take the gasoline' });
      if (item.kind === 'weapon') candidates.push({ ...item, label: 'Take the rifle' });
    }
    // Carrying the can turns the generator into a second, very different option.
    if (this.carryingGas && this.map && !this.sabotage) {
      const g = this.map.generator;
      candidates.push({ kind: 'pour', id: 0, x: g.x, z: g.z, label: 'Pour the gasoline in' });
    }
    // The door itself is never the interaction. Standing at it while it is shut
    // just tells you where the button is.
    if (this.map && this.map.door && this.zone === 0 && this.door[0] !== 2) {
      const d = this.map.door;
      candidates.push({
        kind: 'locked', id: 0, x: d.x, z: d.z,
        label: this.door[0] === 1 ? 'The shutter is coming up' : 'Bulkhead - control panel to the side',
      });
    }
    if (!this.carrying && !this.carryingGas) {
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
      if (dist > (REACH[c.kind] ?? 3.0)) continue;
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
        : threat.state === MONSTER_STATE.SEARCH ? 0.5 : 0.25;
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
    // makes people turn their flashlight off.
    this.growlTimer -= dt;
    if (this.growlTimer <= 0) {
      this.growlTimer = 7 + Math.random() * 9;
      if (Number.isFinite(threat.distance) && threat.distance < 22 && threat.state !== MONSTER_STATE.CHASE) {
        for (const m of this.entities.monsters.values()) {
          if (m.data.state === MONSTER_STATE.SLEEPING) continue;
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
    this.hud.setMeters(this.player.stamina, this.player.charge);
    this.hud.setReserve(this.player.reserve);
    this.hud.setCarrying(this.carryingGas ? 'gas' : this.carrying ? 'fuse' : null);
    // Fuses are a facility problem. On the other side of the door there is no
    // counter, no marker and nothing to track.
    this.hud.setFusePips(this.zone === 1 ? 0 : this.powered, this.zone === 1 ? 0 : this.need);
    this.hud.setPing(this.net.ping);

    if (this.player.state === PLAYER_STATE.DOWN) this.hud.setDowned(true, this.downTimer);

    this.hud.setAmmo(this.armed, this.ammo.mag, this.ammo.reserve, this.ammo.reloading);

    if (this.zone === 1) {
      this.hud.setObjective('Find the way out', false);
    } else if (this.door[0] === 2) {
      this.hud.setObjective('The bulkhead is open', true);
    } else if (this.door[0] === 1) {
      this.hud.setObjective('The shutter is winding up', true);
    } else if (this.generatorOn) {
      this.hud.setObjective('The door panel has power');
    } else if (this.powered >= this.need) {
      this.hud.setObjective(this.generatorOn ? 'The building is lit' : 'Start the generator');
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
        state: row ? row[7] : 0,
        carrying: row ? row[8] >= 0 : false,
        downTimer: row ? row[9] : 0,
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
