// Networked entities: the monster, other survivors, and the fuses.
//
// Snapshots arrive at 15 Hz. Rendering them raw would stutter, so everything is
// drawn ~110 ms in the past and interpolated between the two snapshots that
// bracket that moment. On a LAN that delay is imperceptible, and it means a
// sprinting monster never teleports between frames.

import * as THREE from '../vendor/three.module.js';
import * as TEX from './textures.js';

const INTERP_DELAY = 110;    // ms
const BUFFER_MAX = 24;

export const MONSTER_STATE = { DORMANT: 0, PATROL: 1, IDLE: 2, HUNT: 3, CHASE: 4, RETREAT: 5 };
export const PLAYER_STATE = { ALIVE: 0, DOWN: 1, DEAD: 2, ESCAPED: 3 };

// Mirrors the server's input flag bits.
export const FLAG = { MOVING: 1, SPRINT: 2, CROUCH: 4, LIGHT: 8, BUSY: 16 };

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
  }

  reset() {
    for (const map of [this.players, this.monsters, this.fuses]) {
      for (const e of map.values()) this.root.remove(e.group);
      map.clear();
    }
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

  update(dt, localId, torchPool) {
    this.time += dt;
    const s = this.sample();
    if (!s) return;

    this.syncPlayers(s, localId, dt);
    this.syncMonsters(s, dt);
    this.syncFuses(s, dt);
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

      const x = lerp(rowA[1], rowB[1], s.alpha);
      const z = lerp(rowA[3], rowB[3], s.alpha);
      const yaw = lerpAngle(rowA[4], rowB[4], s.alpha);
      const flags = rowB[5];
      const state = rowB[6];
      const carrying = rowB[7] >= 0;

      entity.group.position.set(x, 0, z);
      entity.group.rotation.y = yaw;
      entity.data = { flags, state, carrying, downTimer: rowB[8] };
      this.animateSurvivor(entity, dt, flags, state);
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
    // apart when all you have is a torch beam.
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

    // Their torch, drawn as a translucent cone rather than a real light: eight
    // shadow-casting spotlights would halve the frame rate for no gain.
    const coneGeo = new THREE.ConeGeometry(1.4, 7, 14, 1, true);
    // Vertex colours fade the shaft to black along its length; under additive
    // blending black is invisible, so the beam dissolves instead of ending in a
    // hard rim.
    const pos = coneGeo.attributes.position;
    const shade = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = (pos.getY(i) + 3.5) / 7;          // 1 at the apex, 0 at the mouth
      const v = Math.pow(t, 2.2);
      shade[i * 3] = v; shade[i * 3 + 1] = v * 0.92; shade[i * 3 + 2] = v * 0.74;
    }
    coneGeo.setAttribute('color', new THREE.BufferAttribute(shade, 3));
    coneGeo.translate(0, -3.5, 0);
    // Lay the beam along local -Z so the avatar's forward matches the camera
    // convention its yaw comes from; +Z would aim every torch backwards.
    coneGeo.rotateX(Math.PI / 2);
    const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.05,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
    }));
    cone.position.set(0, 1.5, 0);
    cone.visible = false;

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffd9a0, transparent: true,
      opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(1.1, 1.1, 1);
    halo.position.set(0, 1.5, -0.2);
    halo.visible = false;

    const label = this.makeNameTag(info ? info.name : 'Survivor', color);
    label.position.y = 2.05;

    group.add(torso, head, band, legL, legR, armL, armR, cone, halo, label);
    return {
      group,
      parts: { torso, head, band, legL, legR, armL, armR, cone, halo, label },
      phase: Math.random() * 10,
      data: {},
    };
  }

  animateSurvivor(entity, dt, flags, state) {
    const { parts } = entity;
    const moving = (flags & FLAG.MOVING) !== 0;
    const sprint = (flags & FLAG.SPRINT) !== 0;
    const crouch = (flags & FLAG.CROUCH) !== 0;
    const light = (flags & FLAG.LIGHT) !== 0;

    parts.cone.visible = light && state === PLAYER_STATE.ALIVE;
    parts.halo.visible = parts.cone.visible;

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
      entity.group.visible = state !== MONSTER_STATE.DORMANT;
      this.animateMonster(entity, dt, state);
    }

    for (const [id, entity] of this.monsters) {
      if (seen.has(id)) continue;
      this.root.remove(entity.group);
      this.monsters.delete(id);
    }
  }

  // Tall, starved, wrong proportions: long arms, short torso, a head that hangs
  // too low. Almost black so the torch only ever catches parts of it.
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
    if (this.quality !== 'low') {
      aura = new THREE.PointLight(0xff2a12, 0, 7, 2.0);
      aura.position.set(0, 1.6, 0);
      group.add(aura);
    }

    return { group, parts: { torso, head, jaw, eyeL, eyeR, eyeGlow, armL, armR, legL, legR, aura }, phase: 0, data: {} };
  }

  animateMonster(entity, dt, state) {
    const { parts } = entity;
    const chasing = state === MONSTER_STATE.CHASE;
    const moving = state !== MONSTER_STATE.IDLE && state !== MONSTER_STATE.DORMANT;

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

    const eyeBright = chasing ? 1 : state === MONSTER_STATE.HUNT ? 0.7 : 0.4;
    parts.eyeL.material.color.setRGB(eyeBright, eyeBright * 0.24, eyeBright * 0.14);
    parts.eyeGlow.material.opacity = 0.3 + eyeBright * 0.5;
    parts.eyeGlow.scale.setScalar(0.55 + eyeBright * 0.35);

    if (parts.aura) {
      parts.aura.intensity = chasing ? 9 + Math.sin(this.time * 12) * 3 : state === MONSTER_STATE.HUNT ? 3 : 0;
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

  // Nearest monster distance, used to drive tension audio and the fear vignette.
  nearestMonster(pos) {
    let best = Infinity, state = MONSTER_STATE.DORMANT;
    for (const m of this.monsters.values()) {
      if (!m.data || m.data.state === MONSTER_STATE.DORMANT) continue;
      const d = Math.hypot(m.data.x - pos.x, m.data.z - pos.z);
      if (d < best) { best = d; state = m.data.state; }
    }
    return { distance: best, state };
  }

  // Everything the local player could interact with right now.
  interactables() {
    const out = [];
    for (const f of this.fuses.values()) {
      if (f.data.state === 0) out.push({ kind: 'fuse', id: f.data.id, x: f.data.x, z: f.data.z });
    }
    for (const [id, p] of this.players) {
      if (p.data.state === PLAYER_STATE.DOWN) {
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
