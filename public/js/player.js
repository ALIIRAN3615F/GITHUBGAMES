// Local player: input, movement, torch, and the resources that make the game a
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

// three.js r155+ measures point and spot lights in physical units, so a torch
// needs a value in the tens rather than the low single digits.
const TORCH_INTENSITY = 14;
const EYE_CROUCH = 1.02;

const STAMINA_DRAIN = 17;
const STAMINA_REGEN = 11;
const STAMINA_MIN_TO_SPRINT = 9;
const BATTERY_DRAIN = 1.15;
const BATTERY_REGEN = 0.5;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.sensitivity = 1;
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
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
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
  takeLook() {
    const dx = this.mouseDX, dy = this.mouseDY;
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
    this.battery = 100;
    this.nerve = 0;              // 0 calm .. 1 panicking
    this.torchOn = true;
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
    this.onTorchToggle = null;

    this.buildTorch();
  }

  buildTorch() {
    // The torch hangs off a holder that lags the camera slightly, so the beam
    // swings a beat behind your head instead of being welded to it.
    this.torchTarget = new THREE.Object3D();
    this.scene.add(this.torchTarget);

    this.torch = new THREE.SpotLight(0xffe8c4, 0, 32, 0.5, 0.62, 1.25);
    this.torch.position.set(0, 0, 0);
    this.torch.target = this.torchTarget;
    this.scene.add(this.torch);

    // A weak bubble of light so you are never rendering a completely black
    // frame - players read that as a bug, not as darkness.
    this.presence = new THREE.PointLight(0x9fb4c8, 0.8, 5.0, 2.0);
    this.scene.add(this.presence);

    this.torchLag = new THREE.Vector3();
  }

  setShadows(enabled, size) {
    this.torch.castShadow = enabled;
    if (enabled) {
      this.torch.shadow.mapSize.set(size, size);
      this.torch.shadow.camera.near = 0.2;
      this.torch.shadow.camera.far = 26;
      this.torch.shadow.bias = -0.0016;
      this.torch.shadow.normalBias = 0.03;
    }
  }

  spawn(x, z) {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.stamina = 100;
    this.battery = 100;
    this.nerve = 0;
    this.torchOn = true;
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

    // --- Torch --------------------------------------------------------------
    if (this.torchOn) {
      this.battery = Math.max(0, this.battery - BATTERY_DRAIN * dt);
      if (this.battery === 0) {
        this.torchOn = false;
        if (this.onTorchToggle) this.onTorchToggle(false, true);
      }
    } else {
      this.battery = Math.min(100, this.battery + BATTERY_REGEN * dt);
    }

    // --- Movement -----------------------------------------------------------
    const speed = this.state !== 0 ? 0
      : this.crouching ? SPEED.crouch
      : this.sprinting ? SPEED.sprint
      : SPEED.walk;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Camera-relative: forward is -Z rotated by yaw.
    const wishX = axis.x * cos - axis.z * sin;
    const wishZ = axis.x * sin + axis.z * cos;

    const accel = 42;
    const friction = 12;
    this.velocity.x += (wishX * speed - this.velocity.x) * Math.min(1, accel * dt / Math.max(speed, 0.001));
    this.velocity.z += (wishZ * speed - this.velocity.z) * Math.min(1, accel * dt / Math.max(speed, 0.001));
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
    this.updateTorch(dt);
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

  updateTorch(dt) {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const aim = this.camera.position.clone().addScaledVector(forward, 8);

    // Lag the aim point so the beam sweeps rather than snaps.
    this.torchLag.lerp(aim, Math.min(1, dt * 11));
    this.torchTarget.position.copy(this.torchLag);
    this.torch.position.copy(this.camera.position).addScaledVector(forward, 0.15);
    this.presence.position.copy(this.camera.position);

    let intensity = 0;
    if (this.torchOn && this.state !== 2) {
      intensity = TORCH_INTENSITY;
      // Dying battery stutters; below 15% it is actively unreliable.
      if (this.battery < 15) {
        const f = Math.sin(performance.now() / 60) * Math.sin(performance.now() / 23);
        intensity *= 0.45 + 0.55 * (this.battery / 15) + f * 0.25;
        if (Math.random() < 0.02) intensity *= 0.15;
      }
    }
    this.torch.intensity += (intensity - this.torch.intensity) * Math.min(1, dt * 14);
    this.presence.intensity = this.state === 2 ? 0 : 0.8;
  }

  toggleTorch() {
    if (this.battery <= 1) return false;
    this.torchOn = !this.torchOn;
    if (this.onTorchToggle) this.onTorchToggle(this.torchOn, false);
    return this.torchOn;
  }

  // Nerve rises in the dark and near the monster, and settles in lit rooms or
  // next to a teammate. It drives audio, grain and the vignette - never damage.
  updateNerve(dt, { monsterDistance, monsterChasing, allyNear, lit }) {
    let target = 0.25;
    if (!this.torchOn) target += 0.25;
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
    if (this.torchOn) f |= FLAG.LIGHT;
    if (this.busy) f |= FLAG.BUSY;
    return f;
  }

  kick(amount) { this.shake = Math.min(3, this.shake + amount); }
}

export { SPEED, RADIUS, EYE_STAND };
