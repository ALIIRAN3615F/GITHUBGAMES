// Networked entities: the monster, other survivors, and the fuses.
//
// Snapshots arrive at 15 Hz. Rendering them raw would stutter, so everything is
// drawn ~110 ms in the past and interpolated between the two snapshots that
// bracket that moment. On a LAN that delay is imperceptible, and it means a
// sprinting monster never teleports between frames.

import * as THREE from '../vendor/three.module.js';
import * as TEX from './textures.js';

const INTERP_DELAY = 110;    // ms

// Brightness of another player's flashlight. Slightly under your own, so your
// beam still reads as yours, but bright enough to light a room for you.
const FLASHLIGHT_INTENSITY = 12;
const BUFFER_MAX = 24;

// Mirrors MONSTER_STATE_CODE on the server. SLEEPING means 'not in the level
// yet' as far as the client is concerned.
export const MONSTER_STATE = {
  SLEEPING: 0, PATROL: 1, IDLE: 2, SEARCH: 3, CHASE: 4, RETREAT: 5, WAKING: 6, ATTACK: 7, DOWNED: 8,
};
export const PLAYER_STATE = { ALIVE: 0, DOWN: 1, DEAD: 2, ESCAPED: 3 };

// Mirrors the server's input flag bits.
export const FLAG = {
  MOVING: 1, SPRINT: 2, CROUCH: 4, LIGHT: 8, BUSY: 16,
  GUN: 32, RELOAD: 64, CLIMB: 128,
};
export const ZONE = { FACILITY: 0, BACKROOMS: 1 };

export class Entities {
  constructor(scene, quality = 'medium') {
    this.scene = scene;
    this.quality = quality;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.buffer = [];
    this.players = new Map();     // id -> { group, parts, data }
    this.monsters = new Map();    // id -> { group, parts, data }
    this.fuses = new Map();       // id -> { group, data }

    this.latest = null;           // most recent raw snapshot (authoritative state)
    this.glowTex = TEX.glowSprite('#ffca7a');
    this.eyeGlowTex = TEX.glowSprite('#ff5544');
    this.nameCache = new Map();
    this.time = 0;
    this.zone = 0;
    this.facilityVisible = true;
    this.weaponPickup = null;
    this.weaponState = 0;

    // Other players' flashlights have to actually light the room - a translucent
    // cone alone reads as a bug. Real spotlights are expensive, so a small pool
    // is shared out to the nearest flashlight-bearers each frame. No shadows: the
    // shadow map is what costs, not the light.
    this.flashlightPool = [];
    const poolSize = quality === 'low' ? 0 : quality === 'high' ? 3 : 2;
    for (let i = 0; i < poolSize; i++) {
      const light = new THREE.SpotLight(0xffe8c4, 0, 26, 0.5, 0.62, 1.25);
      light.castShadow = false;
      light.visible = false;
      const target = new THREE.Object3D();
      this.root.add(light, target);
      light.target = target;
      this.flashlightPool.push({ light, target });
    }
  }

  // Batteries are static world objects whose only state is taken/not taken, so
  // they are drawn as a single instanced mesh and hidden by zeroing the scale
  // of a taken instance. 24 pickups therefore cost one draw call, not 24.
  setMap(map) {
    if (this.batteryMesh) {
      this.root.remove(this.batteryMesh);
      this.batteryMesh.geometry.dispose();
      this.batteryMesh = null;
    }
    this.batteryPoints = map.batteries || [];
    if (!this.batteryPoints.length) return;

    const cellGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.2, 8);
    const capGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.04, 8);
    capGeo.translate(0, 0.12, 0);
    const geo = mergeSimple([cellGeo, capGeo]);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x2f6b4a, roughness: 0.45, metalness: 0.6,
      emissive: 0x27c07a, emissiveIntensity: 0.55,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, this.batteryPoints.length);
    mesh.frustumCulled = false;
    this.batteryMesh = mesh;
    this.batteryMatrix = new THREE.Matrix4();
    this.root.add(mesh);
    this.syncBatteries(null);
  }

  // Hide collected batteries by collapsing the instance to nothing.
  syncBatteries(rows) {
    if (!this.batteryMesh) return;
    const taken = new Set();
    for (const row of rows || []) if (row[3]) taken.add(row[0]);
    this.takenBatteries = taken;

    const m = this.batteryMatrix;
    this.batteryPoints.forEach((b, i) => {
      if (taken.has(b.id)) {
        m.makeScale(0, 0, 0);
      } else {
        const bob = Math.sin(this.time * 1.5 + b.id) * 0.05;
        m.makeRotationY(this.time * 0.7 + b.id);
        m.setPosition(b.x, 0.42 + bob, b.z);
      }
      this.batteryMesh.setMatrixAt(i, m);
    });
    this.batteryMesh.instanceMatrix.needsUpdate = true;
  }

  reset() {
    for (const slot of this.flashlightPool) { slot.light.visible = false; slot.light.intensity = 0; }
    for (const map of [this.players, this.monsters, this.fuses]) {
      for (const e of map.values()) this.root.remove(e.group);
      map.clear();
    }
    if (this.weaponPickup) {
      this.root.remove(this.weaponPickup.group);
      this.weaponPickup = null;
    }
    if (this.impacts) {
      for (const i of this.impacts) this.root.remove(i.sprite);
      this.impacts = null;
    }
    this.weaponState = 0;
    this.zone = 0;
    this.facilityVisible = true;
    this.buffer.length = 0;
    this.latest = null;
  }

  // --- Snapshot plumbing ----------------------------------------------------

  push(snap) {
    this.latest = snap;
    this.buffer.push({ t: performance.now(), snap });
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
  }

  // Find the pair of snapshots bracketing the render time, plus the blend factor.
  sample() {
    const target = performance.now() - INTERP_DELAY;
    if (this.buffer.length === 0) return null;
    if (this.buffer.length === 1) return { a: this.buffer[0].snap, b: this.buffer[0].snap, alpha: 0 };

    for (let i = this.buffer.length - 1; i > 0; i--) {
      const b = this.buffer[i], a = this.buffer[i - 1];
      if (a.t <= target && target <= b.t) {
        const span = b.t - a.t;
        return { a: a.snap, b: b.snap, alpha: span > 0 ? (target - a.t) / span : 0 };
      }
    }
    // Target is older or newer than everything buffered: clamp to an end.
    if (target < this.buffer[0].t) return { a: this.buffer[0].snap, b: this.buffer[0].snap, alpha: 0 };
    const last = this.buffer[this.buffer.length - 1].snap;
    return { a: last, b: last, alpha: 0 };
  }

  update(dt, localId, viewerPos, zone = 0) {
    this.time += dt;
    this.zone = zone;
    const s = this.sample();
    if (!s) return;

    this.syncPlayers(s, localId, dt);
    // Everything below only exists in the facility. Once you are through the
    // door there is nothing to draw and nothing to sync.
    const inFacility = zone === 0;
    this.setFacilityVisible(inFacility);
    if (inFacility) {
      this.syncMonsters(s, dt);
      this.syncFuses(s, dt);
      this.syncBatteries(s.b.b);
      this.syncGas(s.b.gs);
      this.syncWeapon(s.b.wp);
    }
    this.assignFlashlights(viewerPos);
    this.updateImpacts(dt);
  }

  setFacilityVisible(on) {
    if (this.facilityVisible === on) return;
    this.facilityVisible = on;
    for (const e of this.monsters.values()) e.group.visible = on;
    for (const f of this.fuses.values()) f.group.visible = on && f.data.state === 0;
    if (this.batteryMesh) this.batteryMesh.visible = on;
    if (this.gasCan) this.gasCan.group.visible = on && this.gasState === 0;
    if (this.weaponPickup) this.weaponPickup.group.visible = on && this.weaponState === 0;
  }

  // Hand the light pool to the nearest teammates whose flashlight is on.
  assignFlashlights(viewerPos) {
    if (!this.flashlightPool.length) return;

    const lit = [];
    for (const entity of this.players.values()) {
      if (!entity.data || entity.data.state !== PLAYER_STATE.ALIVE) continue;
      if ((entity.data.zone ?? 0) !== (this.zone ?? 0)) continue;
      if (!(entity.data.flags & FLAG.LIGHT)) continue;
      const d = viewerPos
        ? entity.group.position.distanceTo(viewerPos)
        : 0;
      lit.push({ entity, d });
    }
    lit.sort((a, b) => a.d - b.d);

    for (let i = 0; i < this.flashlightPool.length; i++) {
      const slot = this.flashlightPool[i];
      const owner = lit[i];
      if (!owner) { slot.light.visible = false; slot.light.intensity = 0; continue; }

      const g = owner.entity.group;
      // Compose yaw and pitch the same way the owner's camera does (rotateY
      // then rotateX, i.e. YXZ), so the beam points where they are actually
      // looking rather than always sitting level.
      const euler = new THREE.Euler(owner.entity.data.pitch || 0, g.rotation.y, 0, 'YXZ');
      const forward = new THREE.Vector3(0, 0, -1).applyEuler(euler);

      slot.light.visible = true;
      slot.light.intensity = FLASHLIGHT_INTENSITY;
      // Cast from the lens, not from the middle of the body, or the beam
      // starts inside their own chest.
      slot.light.position.set(g.position.x, g.position.y + 1.5, g.position.z);
      slot.light.position.addScaledVector(forward, 0.35);
      slot.target.position.copy(slot.light.position).addScaledVector(forward, 10);
    }
  }

  // --- Survivors ------------------------------------------------------------

  syncPlayers(s, localId, dt) {
    const rowsA = indexRows(s.a.p);
    const rowsB = indexRows(s.b.p);
    const seen = new Set();

    for (const [id, rowB] of rowsB) {
      if (id === localId) continue;      // you are drawn by the camera, not a mesh
      seen.add(id);
      const rowA = rowsA.get(id) || rowB;

      let entity = this.players.get(id);
      if (!entity) {
        entity = this.makeSurvivor(id);
        this.players.set(id, entity);
        this.root.add(entity.group);
      }

      // Row: [id, x, y, z, yaw, pitch, flags, state, carrying, downTimer, charge, reserve]
      const x = lerp(rowA[1], rowB[1], s.alpha);
      const z = lerp(rowA[3], rowB[3], s.alpha);
      const yaw = lerpAngle(rowA[4], rowB[4], s.alpha);
      const pitch = lerp(rowA[5], rowB[5], s.alpha);
      const flags = rowB[6];
      const state = rowB[7];
      const carrying = rowB[8] >= 0;
      const zone = rowB[12] ?? 0;
      const climb = rowB[13] ?? 0;
      const y = lerp(rowA[2], rowB[2], s.alpha);

      // Somebody in the other zone is somewhere else entirely: do not draw them.
      entity.group.visible = zone === this.zone;
      entity.group.position.set(x, 0, z);
      entity.group.rotation.y = yaw;
      entity.data = {
        flags, state, carrying, pitch, zone, climb, y,
        downTimer: rowB[9], charge: rowB[10], reserve: rowB[11],
      };
      if (entity.group.visible) this.animateSurvivor(entity, dt, flags, state, entity.data);
    }

    for (const [id, entity] of this.players) {
      if (seen.has(id)) continue;
      this.root.remove(entity.group);
      this.players.delete(id);
    }
  }

  makeSurvivor(id) {
    const info = this.playerInfo ? this.playerInfo.get(id) : null;
    const color = info ? info.color : 0x8899aa;
    const group = new THREE.Group();

    const suit = new THREE.MeshStandardMaterial({ color: 0x5a636e, roughness: 0.85 });
    const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.12 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.5, 4, 8), suit);
    torso.position.y = 1.05;
    torso.castShadow = true;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), suit);
    head.position.y = 1.56;

    // Shoulder flash in the player's colour - the only way to tell each other
    // apart when all you have is a flashlight beam.
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.035, 6, 14), accent);
    band.rotation.x = Math.PI / 2;
    band.position.y = 1.28;

    // Limb geometry is shifted down by half its length so the mesh rotates about
    // the joint. Rotating a centred capsule makes the limb pass through the body.
    const legGeo = new THREE.CapsuleGeometry(0.09, 0.42, 3, 6);
    legGeo.translate(0, -0.3, 0);
    const legL = new THREE.Mesh(legGeo, suit);
    legL.position.set(-0.12, 0.74, 0);
    const legR = legL.clone();
    legR.position.x = 0.12;

    const armGeo = new THREE.CapsuleGeometry(0.075, 0.4, 3, 6);
    armGeo.translate(0, -0.28, 0);
    const armL = new THREE.Mesh(armGeo, suit);
    armL.position.set(-0.29, 1.33, 0);
    const armR = armL.clone();
    armR.position.x = 0.29;

    // No beam geometry on the avatar. A long cone mesh reads as a solid object
    // jutting out of the player rather than as light; the illumination comes
    // from a real spotlight in the shared pool. All that is drawn here is the
    // lens itself glowing, so you can tell at a glance whose light is on.
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffd9a0, transparent: true,
      opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(0.9, 0.9, 1);
    halo.position.set(0, 1.5, -0.28);
    halo.visible = false;

    const label = this.makeNameTag(info ? info.name : 'Survivor', color);
    label.position.y = 2.05;

    // The rifle in their hands, when they have it. Hung off a small pivot at
    // chest height so it swings with the body rather than floating beside it.
    const gunPivot = new THREE.Group();
    gunPivot.position.set(0.2, 1.26, 0);
    const gun = this.makeWorldRifle(new THREE.MeshStandardMaterial({
      color: 0x4a4238, roughness: 0.6, metalness: 0.5,
    }));
    gun.position.set(0, 0, -0.1);
    gunPivot.add(gun);
    gunPivot.visible = false;

    // Their muzzle flash, so a teammate firing in the dark is unmistakable.
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffcf8a, transparent: true,
      opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    flash.scale.set(0.7, 0.7, 1);
    flash.position.set(0, 0, -0.62);
    flash.visible = false;
    gunPivot.add(flash);

    group.add(torso, head, band, legL, legR, armL, armR, halo, label, gunPivot);
    return {
      group,
      parts: { torso, head, band, legL, legR, armL, armR, halo, label, gunPivot, flash },
      phase: Math.random() * 10,
      recoil: 0,
      data: {},
    };
  }

  animateSurvivor(entity, dt, flags, state, data = {}) {
    const { parts } = entity;
    const moving = (flags & FLAG.MOVING) !== 0;
    const sprint = (flags & FLAG.SPRINT) !== 0;
    const crouch = (flags & FLAG.CROUCH) !== 0;
    const light = (flags & FLAG.LIGHT) !== 0;
    const armed = (flags & FLAG.GUN) !== 0;
    const reloading = (flags & FLAG.RELOAD) !== 0;
    const climbing = (flags & FLAG.CLIMB) !== 0;

    parts.halo.visible = light && state === PLAYER_STATE.ALIVE;

    // The rifle, and whatever it is doing. Recoil decays here so a burst reads
    // as a burst from across a room rather than as a single twitch.
    parts.gunPivot.visible = armed && state === PLAYER_STATE.ALIVE;
    entity.recoil = Math.max(0, entity.recoil - dt * 7);
    parts.flash.visible = entity.recoil > 0.55;
    parts.flash.material.opacity = Math.max(0, (entity.recoil - 0.55) * 2);
    if (parts.gunPivot.visible) {
      parts.gunPivot.rotation.x = (data.pitch || 0) * -0.8 + entity.recoil * 0.5
        + (reloading ? Math.sin(this.time * 5) * 0.25 - 0.3 : 0);
      parts.gunPivot.rotation.z = reloading ? 0.5 : 0.06;
      parts.gunPivot.position.z = -0.12 + entity.recoil * 0.06;
    }

    // On the ladder: turned to the rungs, rising, hands over hands.
    if (climbing) {
      entity.group.rotation.z = 0;
      entity.group.position.y = data.y || 0;
      entity.phase += dt * 4.5;
      parts.armL.rotation.x = -1.9 + Math.sin(entity.phase) * 0.6;
      parts.armR.rotation.x = -1.9 - Math.sin(entity.phase) * 0.6;
      parts.legL.rotation.x = Math.sin(entity.phase) * 0.4;
      parts.legR.rotation.x = -Math.sin(entity.phase) * 0.4;
      parts.label.visible = true;
      return;
    }

    if (state === PLAYER_STATE.DOWN) {
      // Collapsed on their side, one arm up. Unmistakable from a distance.
      entity.group.rotation.z = -Math.PI / 2.1;
      entity.group.position.y = 0.28;
      parts.band.material.emissiveIntensity = 0.5 + Math.sin(this.time * 6) * 0.4;
      parts.label.visible = true;
      return;
    }
    entity.group.rotation.z = 0;
    entity.group.position.y = crouch ? -0.35 : 0;
    parts.band.material.emissiveIntensity = 0.12;
    parts.label.visible = state !== PLAYER_STATE.DEAD && state !== PLAYER_STATE.ESCAPED;
    entity.group.visible = state !== PLAYER_STATE.DEAD && state !== PLAYER_STATE.ESCAPED;

    entity.phase += dt * (moving ? (sprint ? 13 : 8) : 1.5);
    const swing = moving ? Math.sin(entity.phase) * (sprint ? 0.7 : 0.45) : Math.sin(entity.phase) * 0.03;
    parts.legL.rotation.x = swing;
    parts.legR.rotation.x = -swing;
    parts.armL.rotation.x = -swing * 0.7;
    parts.armR.rotation.x = swing * 0.7;
    parts.torso.position.y = 1.05 + (moving ? Math.abs(Math.sin(entity.phase)) * 0.035 : 0);
  }

  // --- The monster ----------------------------------------------------------

  syncMonsters(s, dt) {
    const rowsA = indexRows(s.a.m);
    const rowsB = indexRows(s.b.m);
    const seen = new Set();

    for (const [id, rowB] of rowsB) {
      seen.add(id);
      const rowA = rowsA.get(id) || rowB;
      let entity = this.monsters.get(id);
      if (!entity) {
        entity = this.makeMonster();
        this.monsters.set(id, entity);
        this.root.add(entity.group);
      }

      const x = lerp(rowA[1], rowB[1], s.alpha);
      const z = lerp(rowA[2], rowB[2], s.alpha);
      const yaw = lerpAngle(rowA[3], rowB[3], s.alpha);
      const state = rowB[4];

      entity.group.position.set(x, 0, z);
      entity.group.rotation.y = yaw;
      entity.data = { state, x, z };
      // Dormant monsters are not in the level yet - do not spoil the surprise.
      entity.group.visible = state !== MONSTER_STATE.SLEEPING && this.zone === 0;
      this.animateMonster(entity, dt, state);
    }

    for (const [id, entity] of this.monsters) {
      if (seen.has(id)) continue;
      this.root.remove(entity.group);
      this.monsters.delete(id);
    }
  }

  // Tall, starved, wrong proportions: long arms, short torso, a head that hangs
  // too low. Almost black so the flashlight only ever catches parts of it.
  makeMonster() {
    const group = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x2e2f33, roughness: 0.94, metalness: 0.05 });
    const sinew = new THREE.MeshStandardMaterial({ color: 0x4a3538, roughness: 0.8 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.72, 5, 10), skin);
    torso.position.y = 1.5;
    torso.rotation.x = 0.28;                       // permanent hunch
    torso.castShadow = true;

    const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.2, 4, 8), skin);
    hips.position.y = 1.0;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), skin);
    head.position.set(0, 1.92, 0.16);
    head.scale.set(0.85, 1.15, 1.05);
    head.castShadow = true;

    const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 6), sinew);
    jaw.position.set(0, 1.79, 0.24);
    jaw.rotation.x = Math.PI;

    // The eyes are the one thing that reads across a dark corridor.
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff4a2a });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), eyeMat);
    eyeL.position.set(-0.07, 1.95, 0.3);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.07;

    const eyeGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.eyeGlowTex, color: 0xff4028, transparent: true,
      opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    eyeGlow.scale.set(0.7, 0.4, 1);
    eyeGlow.position.set(0, 1.95, 0.32);

    // Shoulder- and hip-pivoted, so the long arms hang and swing correctly.
    const armGeo = new THREE.CapsuleGeometry(0.06, 0.95, 4, 8);
    armGeo.translate(0, -0.54, 0);
    const armL = new THREE.Mesh(armGeo, skin);
    armL.position.set(-0.29, 1.74, 0.04);
    const armR = armL.clone();
    armR.position.x = 0.29;

    const legGeo = new THREE.CapsuleGeometry(0.08, 0.72, 4, 8);
    legGeo.translate(0, -0.44, 0);
    const legL = new THREE.Mesh(legGeo, skin);
    legL.position.set(-0.13, 1.0, 0);
    const legR = legL.clone();
    legR.position.x = 0.13;

    group.add(torso, hips, head, jaw, eyeL, eyeR, eyeGlow, armL, armR, legL, legR);

    // A dim red bounce light while hunting: enough to catch a wall edge behind
    // it and tell you something is there before you see it.
    let aura = null;
    // One more per-pixel light for a mood cue: worth it only on high.
    if (this.quality === 'high') {
      aura = new THREE.PointLight(0xff2a12, 0, 7, 2.0);
      aura.position.set(0, 1.6, 0);
      group.add(aura);
    }

    return { group, parts: { torso, head, jaw, eyeL, eyeR, eyeGlow, armL, armR, legL, legR, aura }, phase: 0, data: {} };
  }

  animateMonster(entity, dt, state) {
    const { parts } = entity;

    // Shot enough times to go down. It lies where it fell, and it is breathing.
    if (state === MONSTER_STATE.DOWNED) {
      entity.phase += dt;
      entity.group.rotation.z = -Math.PI / 2.15;
      entity.group.position.y = 0.42;
      const breath = Math.sin(entity.phase * 1.4) * 0.5 + 0.5;
      parts.legL.rotation.x = 0.3; parts.legR.rotation.x = -0.2;
      parts.armL.rotation.x = -0.4; parts.armR.rotation.x = 0.5;
      parts.jaw.rotation.x = Math.PI + 0.25;
      parts.eyeL.material.color.setRGB(0.16 * breath, 0.03 * breath, 0.02 * breath);
      parts.eyeGlow.material.opacity = 0.1 * breath;
      if (parts.aura) parts.aura.intensity = 0;
      return;
    }
    entity.group.rotation.z = 0;

    const chasing = state === MONSTER_STATE.CHASE;
    const moving = state !== MONSTER_STATE.IDLE && state !== MONSTER_STATE.SLEEPING;

    entity.phase += dt * (chasing ? 11 : moving ? 4.5 : 1.2);
    const swing = Math.sin(entity.phase);

    parts.legL.rotation.x = swing * (chasing ? 1.0 : 0.55);
    parts.legR.rotation.x = -swing * (chasing ? 1.0 : 0.55);
    // Arms swing counter to the legs, and lift when it is running you down.
    parts.armL.rotation.x = -swing * 0.8 - (chasing ? 0.7 : 0);
    parts.armR.rotation.x = swing * 0.8 - (chasing ? 0.7 : 0);
    parts.torso.rotation.x = 0.28 + (chasing ? 0.3 : 0) + Math.abs(swing) * 0.05;
    parts.head.rotation.z = Math.sin(entity.phase * 0.5) * 0.12;
    parts.jaw.rotation.x = Math.PI + (chasing ? Math.abs(swing) * 0.35 : 0.04);

    const eyeBright = chasing ? 1 : state === MONSTER_STATE.SEARCH ? 0.7 : 0.4;
    parts.eyeL.material.color.setRGB(eyeBright, eyeBright * 0.24, eyeBright * 0.14);
    parts.eyeGlow.material.opacity = 0.3 + eyeBright * 0.5;
    parts.eyeGlow.scale.setScalar(0.55 + eyeBright * 0.35);

    if (parts.aura) {
      parts.aura.intensity = chasing ? 9 + Math.sin(this.time * 12) * 3 : state === MONSTER_STATE.SEARCH ? 3 : 0;
    }
    entity.group.position.y = Math.abs(swing) * (chasing ? 0.07 : 0.02);
  }

  // --- Fuses ----------------------------------------------------------------

  syncFuses(s, dt) {
    const rows = s.b.f || [];
    const seen = new Set();

    for (const row of rows) {
      const [id, x, z, state, holder] = row;
      seen.add(id);
      let entity = this.fuses.get(id);
      if (!entity) {
        entity = this.makeFuse();
        this.fuses.set(id, entity);
        this.root.add(entity.group);
      }
      entity.data = { id, x, z, state, holder };
      // state 0 = on the floor, 1 = carried, 2 = installed in the generator.
      entity.group.visible = state === 0;
      if (state === 0) {
        entity.group.position.set(x, 0.55 + Math.sin(this.time * 1.6 + id) * 0.07, z);
        entity.group.rotation.y += dt * 0.8;
        entity.parts.halo.material.opacity = 0.28 + Math.sin(this.time * 2.4 + id) * 0.12;
      }
    }

    for (const [id, entity] of this.fuses) {
      if (seen.has(id)) continue;
      this.root.remove(entity.group);
      this.fuses.delete(id);
    }
  }

  // The fuel can: one per map, and it has to be obvious what it is from across
  // a dark room - red, chunky, with a warning band and a spout.
  makeGasCan() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.42, 0.19),
      new THREE.MeshStandardMaterial({
        color: 0xa8221a, roughness: 0.55, metalness: 0.45,
        emissive: 0x521008, emissiveIntensity: 0.35,
      })
    );
    body.position.y = 0.21;

    const band = new THREE.Mesh(
      new THREE.BoxGeometry(0.335, 0.09, 0.205),
      new THREE.MeshStandardMaterial({
        color: 0xe0c23a, roughness: 0.6,
        emissive: 0x6a5410, emissiveIntensity: 0.5,
      })
    );
    band.position.y = 0.2;

    const spout = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.045, 0.16, 8),
      new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.7, metalness: 0.4 })
    );
    spout.position.set(0.1, 0.47, 0);
    spout.rotation.z = -0.5;

    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(0.08, 0.018, 6, 10, Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x2a2c2e, roughness: 0.7, metalness: 0.4 })
    );
    handle.position.set(-0.06, 0.44, 0);
    handle.rotation.y = Math.PI / 2;

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xff6a3a, transparent: true,
      opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(1.1, 1.1, 1);
    halo.position.y = 0.25;

    group.add(body, band, spout, handle, halo);
    return { group, parts: { body, halo }, data: {} };
  }

  // The can lives in the world until somebody pours it into the generator.
  syncGas(row) {
    if (!row) {
      if (this.gasCan) this.gasCan.group.visible = false;
      return;
    }
    if (!this.gasCan) {
      this.gasCan = this.makeGasCan();
      this.root.add(this.gasCan.group);
    }
    const [x, z, state] = row;
    this.gasState = state;
    // state 0 on the floor, 1 carried, 2 already poured in.
    this.gasCan.group.visible = state === 0;
    if (state === 0) {
      this.gasCan.group.position.set(x, 0.03 + Math.sin(this.time * 1.3) * 0.03, z);
      this.gasCan.group.rotation.y += 0.004;
      this.gasCan.parts.halo.material.opacity = 0.22 + Math.sin(this.time * 2) * 0.1;
    }
  }

  makeFuse() {
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.3, 10),
      new THREE.MeshStandardMaterial({ color: 0x6a5a3a, roughness: 0.5, metalness: 0.6,
        emissive: 0xffb03a, emissiveIntensity: 0.7 })
    );
    const capTop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.06, 10),
      new THREE.MeshStandardMaterial({ color: 0xb9a06a, roughness: 0.35, metalness: 0.85 })
    );
    capTop.position.y = 0.17;
    const capBot = capTop.clone();
    capBot.position.y = -0.17;

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffc25a, transparent: true,
      opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(0.85, 0.85, 1);

    group.add(body, capTop, capBot, halo);
    return { group, parts: { body, halo }, data: {} };
  }

  // --- The rifle ---------------------------------------------------------------

  // The rifle as it lies on the floor waiting to be found, and as it looks
  // slung in a teammate's hands. Both are the same low-detail model on one
  // shared geometry - the detailed one only ever exists in its holder's own
  // view pass.
  makeWorldRifle(materials) {
    if (!this.rifleGeo) this.rifleGeo = buildRifleGeometry();
    return new THREE.Mesh(this.rifleGeo, materials);
  }

  syncWeapon(row) {
    if (!row) return;
    if (!this.weaponPickup) {
      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.6, metalness: 0.5 });
      const rifle = this.makeWorldRifle(mat);
      rifle.rotation.z = Math.PI / 2 - 0.15;
      rifle.rotation.y = 0.4;
      rifle.position.y = 0.09;
      group.add(rifle);

      // A glint, so it is findable without being a waypoint.
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, color: 0xffd08a, transparent: true,
        opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      halo.scale.set(1.1, 1.1, 1);
      halo.position.y = 0.3;
      group.add(halo);

      this.root.add(group);
      this.weaponPickup = { group, halo };
    }

    const [x, z, state] = row;
    this.weaponState = state;
    this.weaponPickup.group.visible = state === 0;
    this.weaponPickup.group.position.set(x, 0, z);
    this.weaponPickup.halo.material.opacity = 0.25 + Math.sin(this.time * 2.4) * 0.12;
  }

  // --- Helpers --------------------------------------------------------------

  setPlayerInfo(map) {
    this.playerInfo = map;
    // Refresh name tags and colours for anyone already spawned.
    for (const [id, entity] of this.players) {
      const info = map.get(id);
      if (!info) continue;
      entity.parts.band.material.color.setHex(info.color);
      entity.parts.band.material.emissive.setHex(info.color);
      entity.group.remove(entity.parts.label);
      const label = this.makeNameTag(info.name, info.color);
      label.position.y = 2.05;
      entity.group.add(label);
      entity.parts.label = label;
    }
  }

  makeNameTag(name, color) {
    const key = name + ':' + color;
    let tex = this.nameCache.get(key);
    if (!tex) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.font = '600 30px ui-monospace, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.fillText(name, 128, 34);
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.nameCache.set(key, tex);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 0.85,
    }));
    sprite.scale.set(1.5, 0.38, 1);
    return sprite;
  }

  // A small pool of impact flashes. One shared additive material, and they are
  // only ever visible for a fifth of a second, so the cost is a handful of
  // sprites at most however fast anyone is firing.
  impact(x, y, z, kind) {
    if (!this.impacts) {
      this.impacts = [];
      for (let i = 0; i < 5; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTex, transparent: true, opacity: 0,
          depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        sprite.visible = false;
        this.root.add(sprite);
        this.impacts.push({ sprite, life: 0 });
      }
    }
    const free = this.impacts.find((i) => i.life <= 0) || this.impacts[0];
    free.life = 0.22;
    free.sprite.visible = true;
    free.sprite.position.set(x, y, z);
    // Concrete throws grey dust; anything alive throws something darker.
    free.sprite.material.color.setHex(kind === 0 ? 0xd8cbb4 : 0x9a2c22);
    free.sprite.scale.setScalar(kind === 0 ? 0.5 : 0.75);
  }

  updateImpacts(dt) {
    if (!this.impacts) return;
    for (const i of this.impacts) {
      if (i.life <= 0) continue;
      i.life -= dt;
      if (i.life <= 0) { i.sprite.visible = false; continue; }
      i.sprite.material.opacity = (i.life / 0.22) * 0.85;
      i.sprite.scale.multiplyScalar(1 + dt * 2.5);
    }
  }

  // A teammate fired: kick their rifle so the shot is visible, not just audible.
  remoteFire(id) {
    const entity = this.players.get(id);
    if (entity) entity.recoil = 1;
  }

  // Nearest monster distance, used to drive tension audio and the fear vignette.
  nearestMonster(pos) {
    let best = Infinity, state = MONSTER_STATE.SLEEPING;
    for (const m of this.monsters.values()) {
      if (!m.data) continue;
      if (m.data.state === MONSTER_STATE.SLEEPING || m.data.state === MONSTER_STATE.DOWNED) continue;
      const d = Math.hypot(m.data.x - pos.x, m.data.z - pos.z);
      if (d < best) { best = d; state = m.data.state; }
    }
    return { distance: best, state };
  }

  // Everything the local player could interact with right now. Nothing in the
  // facility is reachable once you are through the door.
  interactables() {
    const out = [];
    if (this.zone !== 0) {
      for (const [id, p] of this.players) {
        if (p.data.state === PLAYER_STATE.DOWN && (p.data.zone ?? 0) === this.zone) {
          out.push({ kind: 'revive', id, x: p.group.position.x, z: p.group.position.z });
        }
      }
      return out;
    }
    if (this.gasCan && this.gasState === 0 && this.gasCan.group.visible) {
      out.push({
        kind: 'gas', id: 0,
        x: this.gasCan.group.position.x, z: this.gasCan.group.position.z,
      });
    }
    for (const b of this.batteryPoints || []) {
      if (!this.takenBatteries || !this.takenBatteries.has(b.id)) {
        out.push({ kind: 'battery', id: b.id, x: b.x, z: b.z });
      }
    }
    for (const f of this.fuses.values()) {
      if (f.data.state === 0) out.push({ kind: 'fuse', id: f.data.id, x: f.data.x, z: f.data.z });
    }
    if (this.weaponPickup && this.weaponState === 0 && this.weaponPickup.group.visible) {
      out.push({
        kind: 'weapon', id: 0,
        x: this.weaponPickup.group.position.x, z: this.weaponPickup.group.position.z,
      });
    }
    for (const [id, p] of this.players) {
      if (p.data.state === PLAYER_STATE.DOWN && (p.data.zone ?? 0) === (this.zone ?? 0)) {
        out.push({ kind: 'revive', id, x: p.group.position.x, z: p.group.position.z });
      }
    }
    return out;
  }

  dispose() {
    this.reset();
    this.scene.remove(this.root);
  }
}

function indexRows(rows) {
  const map = new Map();
  for (const row of rows || []) map.set(row[0], row);
  return map;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Minimal geometry merge for the battery pickup: two cylinders into one buffer
// so every battery in the level is a single instanced draw.
// Small builders for the world-space rifle, which is the same shape in a
// teammate's hands as it is lying on the floor.
// The low-detail rifle: enough to read as an AK from across a room, without
// the detail the holder's own view pass carries.
function buildRifleGeometry() {
  return mergeSimple([
    boxAt(0.06, 0.075, 0.28, 0, 0, -0.04),        // receiver
    boxAt(0.055, 0.024, 0.24, 0, 0.05, -0.04),    // dust cover
    cylAt(0.011, 0.36, 0, 0.012, -0.34),          // barrel
    cylAt(0.014, 0.2, 0, 0.05, -0.28),            // gas tube
    boxAt(0.05, 0.05, 0.18, 0, -0.004, -0.27),    // handguard
    boxAt(0.032, 0.05, 0.03, 0, 0.045, -0.5),     // front sight
    boxAt(0.048, 0.16, 0.055, 0, -0.1, -0.01),    // magazine
    boxAt(0.034, 0.1, 0.05, 0, -0.09, 0.06),      // grip
    boxAt(0.04, 0.065, 0.22, 0, -0.03, 0.21),     // stock
  ]);
}

function boxAt(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cylAt(r, len, x, y, z) {
  const g = new THREE.CylinderGeometry(r, r, len, 6);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function mergeSimple(geoms) {
  let verts = 0, indices = 0;
  for (const g of geoms) {
    verts += g.attributes.position.count;
    indices += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(verts * 3);
  const normal = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const index = new Uint16Array(indices);

  let vo = 0, io = 0;
  for (const g of geoms) {
    position.set(g.attributes.position.array, vo * 3);
    if (g.attributes.normal) normal.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const src = g.index ? g.index.array : null;
    const count = src ? src.length : g.attributes.position.count;
    for (let i = 0; i < count; i++) index[io + i] = (src ? src[i] : i) + vo;
    io += count;
    vo += g.attributes.position.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  merged.computeBoundingSphere();
  return merged;
}
