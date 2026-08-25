// Local player: input, movement, flashlight, and the resources that make the game a
// game (stamina, battery, nerve).
//
// The client simulates its own movement and tells the server where it ended up.
// The server clamps that against the same speed constants, so the worst a
// tampered client can do is walk through its own budget slightly early.

import * as THREE from '../vendor/three.module.js';
import { FLAG } from './entities.js';

const SPEED = { walk: 3.2, sprint: 5.6, crouch: 1.65 };
const RADIUS = 0.32;
const EYE_STAND = 1.62;

// three.js r155+ measures point and spot lights in physical units, so a flashlight
// needs a value in the tens rather than the low single digits.
const FLASHLIGHT_INTENSITY = 14;
const EYE_CROUCH = 1.02;

const STAMINA_DRAIN = 17;
const STAMINA_REGEN = 11;
const STAMINA_MIN_TO_SPRINT = 9;
// Matches the server's drain rate so the local bar stays in step between
// snapshots. There is no regeneration: light is a consumable now.
const CHARGE_DRAIN = 1.0;

// Turn WASD axes into a world-space direction for a given yaw.
//
// three rotates about Y as [x' = x cos + z sin, z' = -x sin + z cos], which is
// the opposite handedness to the textbook 2D rotation. Using the textbook form
// mirrors movement about the Z axis: forward is only correct when facing due
// north or south, and veers off sideways at every other angle.
export function moveVector(axis, yaw) {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return {
    x: axis.x * cos + axis.z * sin,
    z: -axis.x * sin + axis.z * cos,
  };
}

// Largest mouse delta accepted from one event, and from one frame's worth of
// accumulated events. Both are far above any real flick at normal sensitivity.
const MAX_MOVE_PER_EVENT = 260;
const MAX_LOOK_PER_FRAME = 700;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampDelta = (v) =>
  (Number.isFinite(v) ? clamp(v, -MAX_MOVE_PER_EVENT, MAX_MOVE_PER_EVENT) : 0);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.sensitivity = 1;
    this.swallowNextMove = false;
    this.captureText = false;      // true while the chat box has focus
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (this.captureText) return;
      // Keep the browser from scrolling or tabbing away mid-run.
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Browsers report one enormous movementX/Y on the first event after
      // pointer lock engages - the jump from the cursor's old screen position.
      // Acting on it whips the camera round, so the first event is dropped.
      if (this.swallowNextMove) { this.swallowNextMove = false; return; }

      // Clamp per event as well: a dropped frame or an alt-tab can otherwise
      // deliver a single delta worth several full turns.
      this.mouseDX += clampDelta(e.movementX);
      this.mouseDY += clampDelta(e.movementY);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      // Never carry motion across a lock change, in either direction.
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.swallowNextMove = this.locked;
      if (!this.locked) this.keys.clear();
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  requestLock() {
    if (this.canvas.requestPointerLock) this.canvas.requestPointerLock();
  }
  exitLock() {
    if (document.exitPointerLock) document.exitPointerLock();
  }

  down(code) { return this.keys.has(code); }

  // Consume accumulated mouse movement for this frame.
  //
  // Deltas pile up between frames, so a long hitch would otherwise apply every
  // event at once and snap the view somewhere else entirely. Cap what a single
  // frame can turn; anything beyond that is a stall artefact, not intent.
  takeLook() {
    const dx = clamp(this.mouseDX, -MAX_LOOK_PER_FRAME, MAX_LOOK_PER_FRAME);
    const dy = clamp(this.mouseDY, -MAX_LOOK_PER_FRAME, MAX_LOOK_PER_FRAME);
    this.mouseDX = 0; this.mouseDY = 0;
    return { dx, dy };
  }

  axis() {
    let x = 0, z = 0;
    if (this.down('KeyW') || this.down('ArrowUp')) z -= 1;
    if (this.down('KeyS') || this.down('ArrowDown')) z += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    const len = Math.hypot(x, z);
    return len > 0 ? { x: x / len, z: z / len } : { x: 0, z: 0 };
  }
}

export class LocalPlayer {
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.stamina = 100;
    this.charge = 100;
    this.reserve = 0;
    this.nerve = 0;              // 0 calm .. 1 panicking
    this.flashlightOn = true;
    this.crouching = false;
    this.sprinting = false;
    this.moving = false;
    this.busy = false;
    this.state = 0;              // mirrors server PLAYER_STATE
    this.alive = true;

    this.bobPhase = 0;
    this.strideAccum = 0;
    this.sprintRelease = 0;
    this.eyeHeight = EYE_STAND;
    this.shake = 0;
    this.recoilPitch = 0;

    this.onFootstep = null;
    this.onFlashlightToggle = null;

    this.buildFlashlight();
  }

  buildFlashlight() {
    // The flashlight hangs off a holder that lags the camera slightly, so the beam
    // swings a beat behind your head instead of being welded to it.
    this.flashlightTarget = new THREE.Object3D();
    this.scene.add(this.flashlightTarget);

    this.flashlight = new THREE.SpotLight(0xffe8c4, 0, 32, 0.5, 0.62, 1.25);
    this.flashlight.position.set(0, 0, 0);
    this.flashlight.target = this.flashlightTarget;
    this.scene.add(this.flashlight);

    // A weak bubble of light so you are never rendering a completely black
    // frame - players read that as a bug, not as darkness.
    this.presence = new THREE.PointLight(0x9fb4c8, 0.8, 5.0, 2.0);
    this.scene.add(this.presence);

    this.flashlightLag = new THREE.Vector3();
  }

  setShadows(enabled, size) {
    this.flashlight.castShadow = enabled;
    if (enabled) {
      this.flashlight.shadow.mapSize.set(size, size);
      this.flashlight.shadow.camera.near = 0.2;
      this.flashlight.shadow.camera.far = 26;
      this.flashlight.shadow.bias = -0.0016;
      this.flashlight.shadow.normalBias = 0.03;
    }
  }

  spawn(x, z) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.stamina = 100;
    this.charge = 100;
    this.reserve = 0;
    this.nerve = 0;
    this.flashlightOn = true;
    this.crouching = false;
    this.state = 0;
    this.alive = true;
    this.shake = 0;
  }

  look(input) {
    if (!input.locked) return;
    const { dx, dy } = input.takeLook();
    const scale = 0.0022 * input.sensitivity;
    this.yaw -= dx * scale;
    this.pitch -= dy * scale;
    const limit = Math.PI / 2 - 0.05;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  update(dt, input, world, opts = {}) {
    this.look(input);

    const canAct = this.state === 0 && !opts.frozen;
    const axis = canAct ? input.axis() : { x: 0, z: 0 };

    // --- Stance -------------------------------------------------------------
    this.crouching = canAct && (input.down('ControlLeft') || input.down('ControlRight') || input.down('KeyC'));
    const wantsSprint = canAct && !this.crouching &&
      (input.down('ShiftLeft') || input.down('ShiftRight')) &&
      (axis.x !== 0 || axis.z !== 0) && this.stamina > STAMINA_MIN_TO_SPRINT;
    this.sprinting = wantsSprint;

    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      this.sprintRelease = 0.8;
    } else {
      this.sprintRelease = Math.max(0, this.sprintRelease - dt);
      if (this.sprintRelease === 0) this.stamina = Math.min(100, this.stamina + STAMINA_REGEN * dt);
    }

    // --- Flashlight --------------------------------------------------------------
    // The server owns the charge; this is local prediction so the beam and the
    // bar react at once rather than stepping 15 times a second.
    if (this.flashlightOn) {
      this.charge = Math.max(0, this.charge - CHARGE_DRAIN * dt);
      if (this.charge === 0) {
        this.flashlightOn = false;
        if (this.onFlashlightToggle) this.onFlashlightToggle(false, true);
      }
    }

    // --- Movement -----------------------------------------------------------
    const speed = this.state !== 0 ? 0
      : this.crouching ? SPEED.crouch
      : this.sprinting ? SPEED.sprint
      : SPEED.walk;

    const wish = moveVector(axis, this.yaw);

    const accel = 42;
    const friction = 12;
    this.velocity.x += (wish.x * speed - this.velocity.x) * Math.min(1, accel * dt / Math.max(speed, 0.001));
    this.velocity.z += (wish.z * speed - this.velocity.z) * Math.min(1, accel * dt / Math.max(speed, 0.001));
    if (!axis.x && !axis.z) {
      const damp = Math.max(0, 1 - friction * dt);
      this.velocity.x *= damp;
      this.velocity.z *= damp;
    }

    const nextX = this.position.x + this.velocity.x * dt;
    const nextZ = this.position.z + this.velocity.z * dt;
    if (world && world.map) {
      const resolved = world.resolveCollision(nextX, nextZ, RADIUS);
      // Kill the velocity component we just lost to a wall, or the player keeps
      // grinding into it and the head bob never settles.
      if (Math.abs(resolved.x - nextX) > 1e-4) this.velocity.x = 0;
      if (Math.abs(resolved.z - nextZ) > 1e-4) this.velocity.z = 0;
      this.position.x = resolved.x;
      this.position.z = resolved.z;
    } else {
      this.position.x = nextX;
      this.position.z = nextZ;
    }

    const planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moving = planarSpeed > 0.35;

    // --- Footsteps ----------------------------------------------------------
    if (this.moving && this.state === 0) {
      this.strideAccum += planarSpeed * dt;
      const stride = this.crouching ? 1.15 : this.sprinting ? 1.5 : 1.25;
      if (this.strideAccum >= stride) {
        this.strideAccum = 0;
        if (this.onFootstep) {
          this.onFootstep({ sprint: this.sprinting, crouch: this.crouching });
        }
      }
    } else {
      this.strideAccum = Math.min(this.strideAccum, 0.9);
    }

    this.updateCamera(dt, planarSpeed, opts);
    this.updateFlashlight(dt);
  }

  updateCamera(dt, planarSpeed, opts) {
    const targetEye = this.state === 1 ? 0.42 : this.crouching ? EYE_CROUCH : EYE_STAND;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 9);

    // Head bob, scaled by gait. Vertical is twice the horizontal frequency,
    // which is what makes it read as footfalls rather than a wobble.
    this.bobPhase += planarSpeed * dt * 3.4;
    const bobAmount = Math.min(planarSpeed / SPEED.sprint, 1) * (this.crouching ? 0.02 : 0.045);
    const bobY = Math.sin(this.bobPhase * 2) * bobAmount;
    const bobX = Math.cos(this.bobPhase) * bobAmount * 0.6;

    // Breathing gets shallow and fast when the nerve goes.
    const breathe = Math.sin(performance.now() / (this.nerve > 0.5 ? 380 : 1400)) * (0.006 + this.nerve * 0.014);

    this.shake = Math.max(0, this.shake - dt * 2.2);
    const shakeX = (Math.random() - 0.5) * this.shake * 0.06;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.06;

    this.camera.position.set(
      this.position.x + bobX,
      this.eyeHeight + bobY + breathe,
      this.position.z
    );

    const forcedPitch = opts.forcedPitch ?? 0;
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw + shakeX);
    this.camera.rotateX(this.pitch + forcedPitch + shakeY);
    // Slight roll into the direction of travel; free weight in the movement.
    this.camera.rotateZ(-bobX * 0.5 + (this.state === 1 ? 0.6 : 0));
  }

  updateFlashlight(dt) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const aim = this.camera.position.clone().addScaledVector(forward, 8);

    // Lag the aim point so the beam sweeps rather than snaps.
    this.flashlightLag.lerp(aim, Math.min(1, dt * 11));
    this.flashlightTarget.position.copy(this.flashlightLag);
    this.flashlight.position.copy(this.camera.position).addScaledVector(forward, 0.15);
    this.presence.position.copy(this.camera.position);

    let intensity = 0;
    if (this.flashlightOn && this.state !== 2) {
      intensity = FLASHLIGHT_INTENSITY;
      // Dying battery stutters; below 15% it is actively unreliable.
      if (this.charge < 15) {
        const f = Math.sin(performance.now() / 60) * Math.sin(performance.now() / 23);
        intensity *= 0.45 + 0.55 * (this.charge / 15) + f * 0.25;
        if (Math.random() < 0.02) intensity *= 0.15;
      }
    }
    this.flashlight.intensity += (intensity - this.flashlight.intensity) * Math.min(1, dt * 14);
    this.presence.intensity = this.state === 2 ? 0 : 0.8;
  }

  toggleFlashlight() {
    if (this.charge <= 0) return false;
    this.flashlightOn = !this.flashlightOn;
    if (this.onFlashlightToggle) this.onFlashlightToggle(this.flashlightOn, false);
    return this.flashlightOn;
  }

  // Nerve rises in the dark and near the monster, and settles in lit rooms or
  // next to a teammate. It drives audio, grain and the vignette - never damage.
  updateNerve(dt, { monsterDistance, monsterChasing, allyNear, lit }) {
    let target = 0.25;
    if (!this.flashlightOn) target += 0.25;
    if (lit) target -= 0.3;
    if (allyNear) target -= 0.2;
    if (Number.isFinite(monsterDistance)) {
      if (monsterDistance < 26) target += (1 - monsterDistance / 26) * 0.55;
      if (monsterChasing) target += 0.4;
    }
    if (this.state === 1) target = 1;
    target = Math.max(0, Math.min(1, target));
    // Fear spikes fast and fades slowly.
    const rate = target > this.nerve ? 1.4 : 0.35;
    this.nerve += (target - this.nerve) * Math.min(1, dt * rate);
  }

  flags() {
    let f = 0;
    if (this.moving) f |= FLAG.MOVING;
    if (this.sprinting) f |= FLAG.SPRINT;
    if (this.crouching) f |= FLAG.CROUCH;
    if (this.flashlightOn) f |= FLAG.LIGHT;
    if (this.busy) f |= FLAG.BUSY;
    return f;
  }

  kick(amount) { this.shake = Math.min(3, this.shake + amount); }
}

export { SPEED, RADIUS, EYE_STAND };
