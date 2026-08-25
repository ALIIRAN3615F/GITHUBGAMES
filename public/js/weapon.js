// The rifle, as the person holding it sees it.
//
// Rendered in its own scene with its own camera, in a second pass after the
// world. That is what stops it clipping through walls: the world is drawn,
// the depth buffer is cleared, and the gun is drawn on top of it. It costs one
// extra pass over a handful of merged meshes and two lights that never move.
//
// The model is built from merged boxes and cylinders grouped by material, so
// the whole rifle is four draw calls. Anything that has to move on its own -
// the magazine, the charging handle, the trigger - is its own small group.

import * as THREE from '../vendor/three.module.js';
import * as TEX from './textures.js';
import { mergeGeometries } from './world.js';

const RELOAD_TIME = 2.6;
const EQUIP_TIME = 0.55;

// Where the rifle sits relative to the eye: down and to the right, angled in
// towards the centre of the screen the way a shouldered rifle actually sits.
// The butt is behind the camera, which is correct - the eye is at the cheek.
const REST = new THREE.Vector3(0.132, -0.158, -0.30);

export class ViewWeapon {
  constructor(quality = 'medium') {
    this.quality = quality;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.008, 6);
    this.scene.add(this.camera);

    // Three fixed lights, never updated: this pass is a still life, so they
    // cost nothing beyond the shading itself.
    const key = new THREE.DirectionalLight(0xfff0dc, 3.6);
    key.position.set(0.7, 1.1, 0.5);
    this.scene.add(key);
    // A rim from the left so the receiver's top edge reads against the dark.
    const rim = new THREE.DirectionalLight(0xbdd2e8, 1.5);
    rim.position.set(-0.9, 0.3, -0.6);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0x9fb4c8, 0x2b241c, 1.9));

    this.root = new THREE.Group();
    this.root.position.copy(REST);
    this.scene.add(this.root);

    this.disposables = [];
    this.build();

    this.equipped = false;
    this.equipT = 0;
    this.reloadT = 0;
    this.recoil = 0;
    this.recoilVel = 0;
    this.kickYaw = 0;
    this.kickPitch = 0;
    this.sway = new THREE.Vector2();
    this.bob = 0;
    this.time = 0;
    this.flashT = 0;
    this.triggerT = 0;
  }

  // --- The model -------------------------------------------------------------

  build() {
    const wood = TEX.gunWood();
    const metal = TEX.gunMetal();
    this.disposables.push(wood, metal);

    const M = {
      wood: new THREE.MeshStandardMaterial({ map: wood, roughness: 0.66, metalness: 0.05 }),
      metal: new THREE.MeshStandardMaterial({ map: metal, roughness: 0.44, metalness: 0.82 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.7, metalness: 0.4 }),
      poly: new THREE.MeshStandardMaterial({ color: 0x54331c, roughness: 0.55, metalness: 0.1 }),
    };
    this.materials = M;

    // Receiver, top cover, barrel, gas system, sights, muzzle.
    const steel = mergeGeometries([
      part(new THREE.BoxGeometry(0.072, 0.086, 0.30), 0, 0, -0.05),                  // receiver
      part(new THREE.BoxGeometry(0.066, 0.028, 0.265), 0, 0.056, -0.05),             // dust cover
      part(new THREE.BoxGeometry(0.070, 0.02, 0.05), 0, 0.052, 0.09),                // rear of cover
      part(new THREE.CylinderGeometry(0.0115, 0.0115, 0.40, 10), 0, 0.014, -0.38, Math.PI / 2, 0, 0),
      part(new THREE.CylinderGeometry(0.0155, 0.0155, 0.235, 8), 0, 0.055, -0.315, Math.PI / 2, 0, 0),
      part(new THREE.BoxGeometry(0.038, 0.052, 0.048), 0, 0.045, -0.435),            // gas block
      part(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 8), 0, 0.032, -0.45, 0.55, 0, 0),
      part(new THREE.BoxGeometry(0.034, 0.055, 0.032), 0, 0.045, -0.545),            // front sight block
      part(new THREE.CylinderGeometry(0.004, 0.004, 0.036, 6), 0, 0.072, -0.545),    // front post
      part(new THREE.BoxGeometry(0.046, 0.018, 0.05), 0, 0.052, -0.185),             // rear sight base
      part(new THREE.BoxGeometry(0.042, 0.022, 0.012), 0, 0.068, -0.20),             // rear leaf
      part(new THREE.CylinderGeometry(0.017, 0.017, 0.07, 10), 0, 0.014, -0.60, Math.PI / 2, 0, 0),
      part(new THREE.BoxGeometry(0.03, 0.028, 0.03), 0.004, 0.02, -0.625),           // slant brake port
      part(new THREE.BoxGeometry(0.064, 0.05, 0.10), 0, -0.05, 0.005),               // magazine well
      part(new THREE.BoxGeometry(0.05, 0.012, 0.075), 0, -0.088, 0.055),             // trigger guard floor
      part(new THREE.BoxGeometry(0.012, 0.04, 0.012), 0, -0.07, 0.018),              // guard front post
      part(new THREE.BoxGeometry(0.012, 0.04, 0.012), 0, -0.07, 0.092),              // guard rear post
      part(new THREE.BoxGeometry(0.014, 0.05, 0.055), 0.042, 0.012, -0.03),          // selector lever
      part(new THREE.BoxGeometry(0.026, 0.03, 0.014), -0.03, -0.005, 0.12),          // sling loop
    ]);
    this.addMesh(steel, M.metal);

    // Woodwork: handguards, grip and stock.
    const timber = mergeGeometries([
      part(new THREE.BoxGeometry(0.052, 0.05, 0.19), 0, -0.004, -0.30),              // lower handguard
      part(new THREE.BoxGeometry(0.044, 0.032, 0.155), 0, 0.052, -0.285),            // upper handguard
      part(new THREE.BoxGeometry(0.036, 0.115, 0.052), 0, -0.10, 0.062, 0.30, 0, 0), // pistol grip
      part(new THREE.BoxGeometry(0.042, 0.072, 0.235), 0, -0.028, 0.235, -0.09, 0, 0), // stock
      part(new THREE.BoxGeometry(0.046, 0.088, 0.018), 0, -0.05, 0.352),             // butt plate
    ]);
    this.addMesh(timber, M.wood);

    // The magazine. Four blocks stepped along an arc, so it reads as the curve
    // it is rather than a straight box.
    this.magGroup = new THREE.Group();
    const mag = mergeGeometries([
      part(new THREE.BoxGeometry(0.052, 0.055, 0.062), 0, -0.03, 0.004, 0.06, 0, 0),
      part(new THREE.BoxGeometry(0.050, 0.05, 0.06), 0, -0.075, -0.006, 0.22, 0, 0),
      part(new THREE.BoxGeometry(0.048, 0.05, 0.058), 0, -0.118, -0.028, 0.42, 0, 0),
      part(new THREE.BoxGeometry(0.046, 0.04, 0.056), 0, -0.155, -0.062, 0.62, 0, 0),
      part(new THREE.BoxGeometry(0.05, 0.012, 0.05), 0, -0.176, -0.086, 0.62, 0, 0),
    ]);
    const magMesh = new THREE.Mesh(mag, M.poly);
    this.magGroup.add(magMesh);
    this.root.add(this.magGroup);
    this.disposables.push(mag);

    // Charging handle, which slides with the bolt.
    this.chargeGroup = new THREE.Group();
    const charge = mergeGeometries([
      part(new THREE.BoxGeometry(0.03, 0.016, 0.05), 0.048, 0.03, -0.075),
      part(new THREE.BoxGeometry(0.014, 0.014, 0.10), 0.04, 0.03, -0.11),
    ]);
    this.chargeGroup.add(new THREE.Mesh(charge, M.metal));
    this.root.add(this.chargeGroup);
    this.disposables.push(charge);

    // Trigger.
    this.triggerGroup = new THREE.Group();
    const trig = part(new THREE.BoxGeometry(0.01, 0.036, 0.014), 0, -0.058, 0.052, 0.12, 0, 0);
    this.triggerGroup.add(new THREE.Mesh(trig, M.dark));
    this.root.add(this.triggerGroup);
    this.disposables.push(trig);

    this.buildMuzzle();
    this.buildCasings();
  }

  addMesh(geo, mat) {
    const mesh = new THREE.Mesh(geo, mat);
    this.root.add(mesh);
    this.disposables.push(geo);
    return mesh;
  }

  buildMuzzle() {
    // Flash: two crossed quads so it has some depth from any angle.
    const tex = TEX.glowSprite('#ffd9a0');
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0,
    });
    this.flashMat = mat;
    this.flash = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), mat);
      quad.rotation.z = i * Math.PI / 2;
      this.flash.add(quad);
      this.disposables.push(quad.geometry);
    }
    this.flash.position.set(0, 0.014, -0.66);
    this.flash.visible = false;
    this.root.add(this.flash);
    this.disposables.push(tex);

    this.flashLight = new THREE.PointLight(0xffc06a, 0, 2.2, 2);
    this.flashLight.position.set(0, 0.05, -0.6);
    this.flashLight.visible = false;
    this.root.add(this.flashLight);

    // Smoke: a few additive puffs that drift off the muzzle and fade.
    this.smoke = [];
    if (this.quality !== 'low') {
      const smokeTex = TEX.glowSprite('#8f8a82');
      const smokeMat = new THREE.MeshBasicMaterial({
        map: smokeTex, transparent: true, depthWrite: false, opacity: 0,
      });
      this.smokeMat = smokeMat;
      for (let i = 0; i < 3; i++) {
        const puff = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), smokeMat.clone());
        puff.visible = false;
        this.root.add(puff);
        this.smoke.push({ mesh: puff, life: 0, vx: 0, vy: 0, vz: 0 });
        this.disposables.push(puff.geometry, puff.material);
      }
      this.disposables.push(smokeTex);
    }
  }

  // A small pool of brass, thrown out to the right and tumbling. One instanced
  // mesh, so however many are in the air it is a single draw call - and they
  // live in the view scene, so they never touch the world's draw list at all.
  buildCasings() {
    this.casings = [];
    if (this.quality === 'low') return;
    const count = 8;
    const geo = new THREE.CylinderGeometry(0.005, 0.0055, 0.039, 6);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.35, metalness: 0.9 });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.root.add(mesh);
    this.casingMesh = mesh;
    this.casingMatrix = new THREE.Matrix4();
    this.casingHidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, this.casingHidden);
      this.casings.push({
        life: 0,
        pos: new THREE.Vector3(),
        rot: new THREE.Euler(),
        v: new THREE.Vector3(),
        spin: new THREE.Vector3(),
      });
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.disposables.push(geo, mat);
  }

  // --- Control ---------------------------------------------------------------

  equip(on) {
    if (on === this.equipped) return;
    this.equipped = on;
    if (on) this.equipT = 0;
    this.reloadT = 0;
    this.root.visible = on;
  }

  fire() {
    this.recoilVel += 5.6 + Math.random() * 1.2;
    this.kickYaw += (Math.random() - 0.5) * 0.035;
    this.kickPitch += 0.028 + Math.random() * 0.014;
    this.flashT = 0.045;
    this.triggerT = 0.09;
    this.ejectCasing();
    this.puff();
  }

  dryFire() { this.triggerT = 0.12; }

  reload() { this.reloadT = RELOAD_TIME; }

  ejectCasing() {
    const free = this.casings.find((c) => c.life <= 0);
    if (!free) return;
    free.life = 1.1;
    free.pos.set(0.05, 0.05, -0.06);
    free.rot.set(0, 0, 0);
    free.v.set(0.9 + Math.random() * 0.5, 1.5 + Math.random() * 0.6, 0.5 + Math.random() * 0.4);
    free.spin.set(Math.random() * 14, Math.random() * 14, Math.random() * 14);
  }

  puff() {
    if (!this.smoke.length) return;
    const free = this.smoke.find((s) => s.life <= 0);
    if (!free) return;
    free.life = 0.75;
    free.mesh.visible = true;
    free.mesh.position.set(0, 0.02, -0.63);
    free.vx = (Math.random() - 0.5) * 0.12;
    free.vy = 0.12 + Math.random() * 0.1;
    free.vz = -0.25 - Math.random() * 0.2;
  }

  // --- Per-frame -------------------------------------------------------------

  update(dt, opts = {}) {
    if (!this.equipped) return;
    this.time += dt;

    const { moveSpeed = 0, lookDelta = { x: 0, y: 0 }, crouched = false } = opts;

    // Equip: the rifle comes up from below and to the right.
    this.equipT = Math.min(1, this.equipT + dt / EQUIP_TIME);
    const rise = 1 - Math.pow(1 - this.equipT, 3);

    // Recoil is a spring: an impulse in, then damped back to rest.
    this.recoilVel -= this.recoil * 128 * dt;
    this.recoilVel *= Math.exp(-13 * dt);
    this.recoil += this.recoilVel * dt;
    this.kickYaw *= Math.exp(-9 * dt);
    this.kickPitch *= Math.exp(-9 * dt);

    // Sway lags the mouse, so whipping the view drags the gun behind it.
    this.sway.x += (clamp(-lookDelta.x * 0.00035, -0.05, 0.05) - this.sway.x) * Math.min(1, dt * 9);
    this.sway.y += (clamp(-lookDelta.y * 0.00030, -0.05, 0.05) - this.sway.y) * Math.min(1, dt * 9);

    // Walk bob, and the slow breathing drift when standing still.
    this.bob += dt * (3.4 + moveSpeed * 1.5);
    const walk = Math.min(1, moveSpeed / 3.2);
    const bobX = Math.sin(this.bob) * 0.008 * walk;
    const bobY = Math.abs(Math.cos(this.bob)) * 0.007 * walk;
    const breathX = Math.sin(this.time * 0.9) * 0.0022;
    const breathY = Math.sin(this.time * 1.27) * 0.0026;

    const r = this.reloadPose(dt);

    this.root.position.set(
      REST.x + this.sway.x + bobX + breathX + r.x + (1 - rise) * 0.12,
      REST.y + this.sway.y - bobY + breathY + r.y - (1 - rise) * 0.24 + (crouched ? 0.012 : 0),
      REST.z + this.recoil * 0.075 + r.z
    );
    this.root.rotation.set(
      this.kickPitch + r.pitch + this.sway.y * 1.6 - (1 - rise) * 0.5,
      0.055 + this.kickYaw + r.yaw + this.sway.x * 2.2,
      r.roll + this.sway.x * 3.2 + (1 - rise) * 0.6
    );

    this.triggerT = Math.max(0, this.triggerT - dt);
    this.triggerGroup.rotation.x = this.triggerT > 0 ? -0.35 : 0;

    this.updateFlash(dt);
    this.updateCasings(dt);
    this.updateSmoke(dt);
  }

  // The reload, as a timeline. Every phase moves a real part: the magazine
  // rocks out and falls away, a fresh one rocks in, and the bolt is worked.
  reloadPose(dt) {
    const out = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
    this.chargeGroup.position.z = 0;
    if (this.reloadT <= 0) {
      this.magGroup.visible = true;
      this.magGroup.position.set(0, 0, 0);
      this.magGroup.rotation.x = 0;
      return out;
    }

    this.reloadT = Math.max(0, this.reloadT - dt);
    const t = 1 - this.reloadT / RELOAD_TIME;      // 0 -> 1 through the reload

    // The rifle tilts over so the magazine well faces the off hand.
    const tilt = bump(t, 0.05, 0.9);
    out.roll = tilt * 0.55;
    out.yaw = tilt * 0.22;
    out.x = tilt * -0.03;
    out.y = tilt * -0.035;
    out.pitch = tilt * 0.12;

    if (t < 0.22) {
      // Rocking the old magazine forward out of the well.
      const k = t / 0.22;
      this.magGroup.visible = true;
      this.magGroup.rotation.x = k * 0.5;
      this.magGroup.position.set(0, -k * 0.02, -k * 0.01);
    } else if (t < 0.46) {
      // Gone, and falling.
      const k = (t - 0.22) / 0.24;
      this.magGroup.visible = true;
      this.magGroup.rotation.x = 0.5 + k * 1.2;
      this.magGroup.position.set(k * 0.02, -0.02 - k * 0.55, -0.01 - k * 0.1);
    } else if (t < 0.7) {
      // Fresh magazine coming up from below.
      const k = (t - 0.46) / 0.24;
      this.magGroup.visible = true;
      this.magGroup.rotation.x = 0.62 * (1 - k);
      this.magGroup.position.set(0, -0.34 * (1 - k), -0.04 * (1 - k));
    } else {
      this.magGroup.visible = true;
      this.magGroup.rotation.x = 0;
      this.magGroup.position.set(0, 0, 0);
      if (t < 0.88) {
        // Working the charging handle: back hard, then let it fly.
        const k = (t - 0.7) / 0.18;
        this.chargeGroup.position.z = Math.sin(k * Math.PI) * 0.075;
      }
    }
    return out;
  }

  updateFlash(dt) {
    if (this.flashT > 0) {
      this.flashT -= dt;
      const on = this.flashT > 0;
      this.flash.visible = on;
      this.flashLight.visible = on;
      if (on) {
        const k = 0.6 + Math.random() * 0.4;
        this.flashMat.opacity = k;
        this.flashLight.intensity = 5 * k;
        this.flash.rotation.z = Math.random() * Math.PI;
        const s = 0.85 + Math.random() * 0.45;
        this.flash.scale.setScalar(s);
      }
    } else if (this.flash.visible) {
      this.flash.visible = false;
      this.flashLight.visible = false;
    }
  }

  updateCasings(dt) {
    if (!this.casingMesh) return;
    let any = false;
    const m = this.casingMatrix;
    for (let i = 0; i < this.casings.length; i++) {
      const c = this.casings[i];
      if (c.life <= 0) { this.casingMesh.setMatrixAt(i, this.casingHidden); continue; }
      c.life -= dt;
      if (c.life <= 0) { this.casingMesh.setMatrixAt(i, this.casingHidden); continue; }
      any = true;
      c.v.y -= 5.2 * dt;
      c.pos.addScaledVector(c.v, dt);
      c.rot.set(c.rot.x + c.spin.x * dt, c.rot.y + c.spin.y * dt, c.rot.z + c.spin.z * dt);
      m.makeRotationFromEuler(c.rot);
      m.setPosition(c.pos);
      this.casingMesh.setMatrixAt(i, m);
    }
    this.casingMesh.visible = any;
    this.casingMesh.instanceMatrix.needsUpdate = true;
  }

  updateSmoke(dt) {
    for (const s of this.smoke) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.material.opacity = Math.max(0, s.life / 0.75) * 0.22;
      s.mesh.scale.setScalar(1 + (0.75 - s.life) * 2.2);
    }
  }

  // Drawn after the world, over a cleared depth buffer, so no wall can ever
  // reach into it.
  render(renderer) {
    if (!this.equipped) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    for (const d of this.disposables) { try { d.dispose(); } catch { /* not disposable */ } }
    this.disposables = [];
  }
}

// --- Helpers -----------------------------------------------------------------

function part(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

// 0 outside [a,b], easing up to 1 across the middle of it.
function bump(t, a, b) {
  if (t <= a || t >= b) return 0;
  const k = (t - a) / (b - a);
  return Math.sin(k * Math.PI);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
