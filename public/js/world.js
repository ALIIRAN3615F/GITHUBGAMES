// Level construction.
//
// The server sends a grid plus a prop list; everything visible is built here.
// Two rules drive the structure: batch aggressively (instanced meshes, merged
// prop geometry) because a maze is thousands of boxes, and spend the very small
// light budget where it changes how the game plays - the flashlight, the generator,
// the exit.

import * as THREE from '../vendor/three.module.js';
import * as TEX from './textures.js';

const QUALITY = {
  low:    { shadows: false, shadowSize: 512,  lampLights: 0, propDetail: false, anisotropy: 1 },
  medium: { shadows: true,  shadowSize: 1024, lampLights: 2, propDetail: true,  anisotropy: 4 },
  high:   { shadows: true,  shadowSize: 2048, lampLights: 5, propDetail: true,  anisotropy: 8 },
};

export class World {
  constructor(scene, quality = 'medium') {
    this.scene = scene;
    this.quality = QUALITY[quality] || QUALITY.medium;
    this.qualityName = quality;
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.lamps = [];
    this.lampLights = [];
    this.disposables = [];
    this.obstacles = [];
    this.obstacleBuckets = new Map();
    this.map = null;
    this.grid = null;
    this.powered = 0;
    this.flickerPhase = 0;
  }

  // --- Build ---------------------------------------------------------------

  build(map) {
    this.dispose();
    this.map = map;
    this.grid = Uint8Array.from(map.grid, (c) => +c);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.indexObstacles(map.obstacles || []);
    this.materials = this.makeMaterials();
    this.buildShell();
    this.buildWalls();
    this.buildProps();
    this.buildLamps();
    this.buildGenerator();
    this.buildExit();
  }

  makeMaterials() {
    const floorTex = TEX.concreteFloor(this.map.seed & 0xffff);
    floorTex.repeat.set(this.map.w, this.map.h);
    floorTex.anisotropy = this.quality.anisotropy;

    const ceilTex = TEX.ceilingPlate((this.map.seed >> 3) & 0xffff);
    ceilTex.repeat.set(this.map.w * 0.5, this.map.h * 0.5);

    const wallTex = TEX.wallPanel((this.map.seed >> 7) & 0xffff);
    wallTex.anisotropy = this.quality.anisotropy;

    this.disposables.push(floorTex, ceilTex, wallTex);

    return {
      floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.96, metalness: 0.04 }),
      ceiling: new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 1, metalness: 0.05 }),
      wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.82, metalness: 0.22 }),
      metal: new THREE.MeshStandardMaterial({ map: TEX.paintedMetal('#828a78', 5), roughness: 0.72, metalness: 0.35 }),
      rust: new THREE.MeshStandardMaterial({ map: TEX.paintedMetal('#9c7358', 9), roughness: 0.9, metalness: 0.3 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x3d4348, roughness: 0.9, metalness: 0.3 }),
      flesh: new THREE.MeshStandardMaterial({ color: 0x6b4f49, roughness: 0.95 }),
      blood: new THREE.MeshBasicMaterial({
        map: TEX.bloodDecal(11), transparent: true, depthWrite: false,
        opacity: 0.85, blending: THREE.NormalBlending,
      }),
      glow: new THREE.MeshBasicMaterial({ color: 0xffd08a }),
    };
  }

  buildShell() {
    const { w, h, cell, wallH } = this.map;
    const W = w * cell, H = h * cell;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.materials.floor);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = this.quality.shadows;
    this.root.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.materials.ceiling);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = wallH;
    this.root.add(ceiling);

    this.disposables.push(floor.geometry, ceiling.geometry);
  }

  // Only walls that touch walkable space are drawn - the solid rock behind them
  // is never visible, and skipping it roughly halves the instance count.
  buildWalls() {
    const { w, h, cell, wallH } = this.map;
    const visible = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (this.grid[y * w + x] === 1) continue;
        let exposed = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (this.grid[ny * w + nx] === 1) { exposed = true; break; }
        }
        if (exposed) visible.push([x, y]);
      }
    }

    const geo = new THREE.BoxGeometry(cell, wallH, cell);
    const mesh = new THREE.InstancedMesh(geo, this.materials.wall, visible.length);
    mesh.castShadow = this.quality.shadows;
    mesh.receiveShadow = this.quality.shadows;

    const m = new THREE.Matrix4();
    visible.forEach(([x, y], i) => {
      const p = this.cellToWorld(x, y);
      m.makeTranslation(p.x, wallH / 2, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;   // one instanced draw call; culling it is pointless
    this.root.add(mesh);
    this.disposables.push(geo);
    this.wallMesh = mesh;
  }

  buildProps() {
    const byType = new Map();
    for (const prop of this.map.props) {
      if (!byType.has(prop.t)) byType.set(prop.t, []);
      byType.get(prop.t).push(prop);
    }

    for (const [type, list] of byType) {
      const spec = this.propGeometry(type);
      if (!spec) continue;
      const mesh = new THREE.InstancedMesh(spec.geo, spec.mat, list.length);
      mesh.castShadow = this.quality.shadows && spec.shadow !== false;
      mesh.receiveShadow = this.quality.shadows;

      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      list.forEach((p, i) => {
        pos.set(p.x, spec.y ?? 0, p.z);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.r || 0);
        if (spec.flat) {
          // Decals lie on the floor, so they rotate about X first.
          const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
          q.multiply(flat);
        }
        scl.set(p.s || 1, p.s || 1, p.s || 1);
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
      this.disposables.push(spec.geo);
    }
  }

  // Prop shapes are merged box/cylinder clusters so each type is one draw call.
  propGeometry(type) {
    const M = this.materials;
    switch (type) {
      case 'crate':
        return { geo: new THREE.BoxGeometry(0.95, 0.95, 0.95), mat: M.metal, y: 0.48 };
      case 'barrel':
        return { geo: new THREE.CylinderGeometry(0.36, 0.36, 1.05, 12), mat: M.rust, y: 0.53 };
      case 'locker':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(0.74, 1.9, 0.46), 0, 0.95, 0),
          transformed(new THREE.BoxGeometry(0.78, 0.06, 0.5), 0, 1.93, 0),
        ]), mat: M.metal };
      case 'shelf':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(0.08, 1.8, 0.42), -0.55, 0.9, 0),
          transformed(new THREE.BoxGeometry(0.08, 1.8, 0.42), 0.55, 0.9, 0),
          transformed(new THREE.BoxGeometry(1.2, 0.05, 0.42), 0, 0.45, 0),
          transformed(new THREE.BoxGeometry(1.2, 0.05, 0.42), 0, 1.0, 0),
          transformed(new THREE.BoxGeometry(1.2, 0.05, 0.42), 0, 1.55, 0),
        ]), mat: M.rust };
      case 'pipes':
        return { geo: mergeGeometries([
          transformed(new THREE.CylinderGeometry(0.1, 0.1, 3.3, 8), -0.14, 1.65, 0),
          transformed(new THREE.CylinderGeometry(0.07, 0.07, 3.3, 8), 0.12, 1.65, 0.05),
        ]), mat: M.rust };
      case 'vent':
        return { geo: new THREE.BoxGeometry(0.72, 0.5, 0.09), mat: M.dark, y: 2.2 };
      case 'sign':
        return { geo: new THREE.BoxGeometry(0.52, 0.36, 0.04), mat: M.rust, y: 1.9 };
      case 'table':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(1.35, 0.07, 0.78), 0, 0.76, 0),
          transformed(new THREE.BoxGeometry(0.07, 0.75, 0.07), -0.6, 0.38, -0.32),
          transformed(new THREE.BoxGeometry(0.07, 0.75, 0.07), 0.6, 0.38, -0.32),
          transformed(new THREE.BoxGeometry(0.07, 0.75, 0.07), -0.6, 0.38, 0.32),
          transformed(new THREE.BoxGeometry(0.07, 0.75, 0.07), 0.6, 0.38, 0.32),
        ]), mat: M.rust };
      case 'chair':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(0.45, 0.06, 0.45), 0, 0.46, 0),
          transformed(new THREE.BoxGeometry(0.45, 0.5, 0.06), 0, 0.72, -0.2),
          transformed(new THREE.BoxGeometry(0.05, 0.45, 0.05), -0.18, 0.23, -0.18),
          transformed(new THREE.BoxGeometry(0.05, 0.45, 0.05), 0.18, 0.23, -0.18),
          transformed(new THREE.BoxGeometry(0.05, 0.45, 0.05), -0.18, 0.23, 0.18),
          transformed(new THREE.BoxGeometry(0.05, 0.45, 0.05), 0.18, 0.23, 0.18),
        ]), mat: M.dark };
      case 'gurney':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(0.72, 0.08, 1.9), 0, 0.78, 0),
          transformed(new THREE.BoxGeometry(0.06, 0.75, 0.06), -0.3, 0.38, -0.85),
          transformed(new THREE.BoxGeometry(0.06, 0.75, 0.06), 0.3, 0.38, -0.85),
          transformed(new THREE.BoxGeometry(0.06, 0.75, 0.06), -0.3, 0.38, 0.85),
          transformed(new THREE.BoxGeometry(0.06, 0.75, 0.06), 0.3, 0.38, 0.85),
        ]), mat: M.metal };
      case 'debris':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(0.5, 0.14, 0.36), 0, 0.07, 0),
          transformed(new THREE.BoxGeometry(0.3, 0.1, 0.44), 0.22, 0.05, 0.2),
        ]), mat: M.dark };
      case 'corpse':
        return { geo: mergeGeometries([
          transformed(new THREE.BoxGeometry(0.42, 0.24, 1.1), 0, 0.13, 0),
          transformed(new THREE.SphereGeometry(0.16, 8, 6), 0, 0.16, 0.66),
          transformed(new THREE.BoxGeometry(0.14, 0.14, 0.62), -0.3, 0.09, 0.1),
          transformed(new THREE.BoxGeometry(0.14, 0.14, 0.5), 0.32, 0.09, -0.1),
        ]), mat: M.flesh };
      case 'blood':
        return { geo: new THREE.PlaneGeometry(1.5, 1.5), mat: M.blood, y: 0.02, flat: true, shadow: false };
      default:
        return null;
    }
  }

  // Caged bulbs hanging from the ceiling. Geometry always exists; the light
  // itself is a scarce resource handed to whichever lamps are nearest.
  buildLamps() {
    const { wallH } = this.map;
    const housing = mergeGeometries([
      transformed(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 6), 0, 0.17, 0),
      transformed(new THREE.CylinderGeometry(0.17, 0.11, 0.14, 8), 0, -0.06, 0),
    ]);
    const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0x2a2620 });

    const housingMesh = new THREE.InstancedMesh(housing, this.materials.dark, this.map.lamps.length);
    const bulbMesh = new THREE.InstancedMesh(bulbGeo, bulbMat, this.map.lamps.length);
    bulbMesh.frustumCulled = false;

    const m = new THREE.Matrix4();
    this.map.lamps.forEach((lamp, i) => {
      m.makeTranslation(lamp.x, wallH - 0.2, lamp.z);
      housingMesh.setMatrixAt(i, m);
      m.makeTranslation(lamp.x, wallH - 0.33, lamp.z);
      bulbMesh.setMatrixAt(i, m);
      this.lamps.push({ x: lamp.x, z: lamp.z, y: wallH - 0.33, on: false, flicker: Math.random() * 10 });
    });
    housingMesh.instanceMatrix.needsUpdate = true;
    bulbMesh.instanceMatrix.needsUpdate = true;
    this.root.add(housingMesh, bulbMesh);
    this.bulbMat = bulbMat;
    this.disposables.push(housing, bulbGeo);

    for (let i = 0; i < this.quality.lampLights; i++) {
      const light = new THREE.PointLight(0xffc978, 0, 15, 1.7);
      light.visible = false;
      this.root.add(light);
      this.lampLights.push(light);
    }
  }

  // The generator: the one place everybody has to keep coming back to, so it
  // gets a silhouette you can recognise from across a dark room.
  buildGenerator() {
    const g = this.map.generator;
    const group = new THREE.Group();
    group.position.set(g.x, 0, g.z);

    const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.5, 1.2), this.materials.metal);
    body.position.y = 0.75;
    body.castShadow = this.quality.shadows;
    group.add(body);

    const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 0.9), this.materials.rust);
    top.position.y = 1.65;
    group.add(top);

    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.5, 8), this.materials.rust);
    stack.position.set(0.72, 2.3, 0);
    group.add(stack);

    // One slot per required fuse, so progress is readable at a glance.
    this.fuseSlots = [];
    const need = this.map.fuseCount;
    const slotGeo = new THREE.BoxGeometry(0.14, 0.24, 0.08);
    for (let i = 0; i < need; i++) {
      const t = need === 1 ? 0.5 : i / (need - 1);
      const slot = new THREE.Mesh(slotGeo, new THREE.MeshBasicMaterial({ color: 0x2b1d16 }));
      slot.position.set(-0.7 + t * 1.4, 1.12, 0.62);
      group.add(slot);
      this.fuseSlots.push(slot);
    }

    this.generatorLight = new THREE.PointLight(0xff5a34, 8, 11, 1.9);
    this.generatorLight.position.set(0, 1.9, 0);
    group.add(this.generatorLight);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff5a34 }));
    beacon.position.set(-0.9, 1.75, 0);
    group.add(beacon);
    this.generatorBeacon = beacon;

    this.root.add(group);
    this.generatorGroup = group;
  }

  // The exit: a blast door that stays shut and red until the power is on.
  buildExit() {
    const e = this.map.exit;
    const group = new THREE.Group();
    group.position.set(e.x, 0, e.z);

    const frame = mergeGeometries([
      transformed(new THREE.BoxGeometry(0.3, 3.2, 0.5), -1.55, 1.6, 0),
      transformed(new THREE.BoxGeometry(0.3, 3.2, 0.5), 1.55, 1.6, 0),
      transformed(new THREE.BoxGeometry(3.4, 0.3, 0.5), 0, 3.05, 0),
    ]);
    const frameMesh = new THREE.Mesh(frame, this.materials.metal);
    group.add(frameMesh);

    const door = new THREE.Mesh(new THREE.BoxGeometry(2.9, 3.0, 0.22), this.materials.rust);
    door.position.y = 1.5;
    door.castShadow = this.quality.shadows;
    group.add(door);
    this.exitDoor = door;

    this.exitLight = new THREE.PointLight(0xff2a1a, 10, 13, 1.9);
    this.exitLight.position.set(0, 2.6, 0.7);
    group.add(this.exitLight);

    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    lamp.position.set(0, 3.05, 0.32);
    group.add(lamp);
    this.exitLamp = lamp;

    this.root.add(group);
    this.exitGroup = group;
    this.disposables.push(frame);
  }

  // --- Per-frame -----------------------------------------------------------

  update(dt, playerPos, powered, exitOpen, generatorOn) {
    this.flickerPhase += dt;
    const need = this.map ? this.map.fuseCount : 1;
    const ratio = need ? powered / need : 0;

    // Generator: red while starved, amber as it takes load, green once running.
    if (this.generatorLight) {
      const color = generatorOn ? 0x66ff8a : ratio > 0 ? 0xffa23a : 0xff5a34;
      this.generatorLight.color.setHex(color);
      this.generatorBeacon.material.color.setHex(color);
      const pulse = 0.75 + Math.sin(this.flickerPhase * (generatorOn ? 7 : 2.2)) * 0.35;
      this.generatorLight.intensity = (7 + ratio * 13) * pulse;
    }
    for (let i = 0; i < this.fuseSlots.length; i++) {
      this.fuseSlots[i].material.color.setHex(i < powered ? 0xffc24a : 0x2b1d16);
    }

    // Exit: the door lifts and the lamp turns when the power lands.
    if (this.exitDoor) {
      // The blast door stays open once it has been opened - cutting the power
      // must not seal survivors in.
      const target = exitOpen ? 4.4 : 1.5;
      this.exitDoor.position.y += (target - this.exitDoor.position.y) * Math.min(1, dt * 0.9);
      const c = exitOpen ? 0x3dff77 : 0xff2a1a;
      this.exitLight.color.setHex(c);
      this.exitLamp.material.color.setHex(c);
      this.exitLight.intensity = exitOpen ? 24 + Math.sin(this.flickerPhase * 3) * 6 : 9;
    }

    this.updateLamps(dt, playerPos, ratio, generatorOn);
  }

  // Lamps come on in step with the generator, and only the handful nearest the
  // camera are given a real light.
  // The generator is a building-wide switch: every lamp in the facility runs
  // off it, not just the ones in the generator room. The lamps nearest the
  // camera get real point lights for local pools of light; the rest are lit by
  // the ambient lift applied in main.js, which costs nothing per pixel.
  updateLamps(dt, playerPos, ratio, generatorOn) {
    if (!this.lamps.length) return;
    let anyOn = false;

    for (let i = 0; i < this.lamps.length; i++) {
      const lamp = this.lamps[i];
      lamp.on = generatorOn;
      if (lamp.on) anyOn = true;
    }

    if (this.bulbMat) {
      this.bulbMat.color.setHex(anyOn ? 0xffd79a : 0x2a2620);
    }
    if (!this.lampLights.length || !playerPos) return;

    // Nearest-N assignment: cheap, and stable enough not to pop visibly.
    const active = this.lamps.filter((l) => l.on);
    active.sort((a, b) =>
      (a.x - playerPos.x) ** 2 + (a.z - playerPos.z) ** 2 -
      ((b.x - playerPos.x) ** 2 + (b.z - playerPos.z) ** 2));

    for (let i = 0; i < this.lampLights.length; i++) {
      const light = this.lampLights[i];
      const lamp = active[i];
      if (!lamp) { light.visible = false; continue; }
      light.visible = true;
      light.position.set(lamp.x, lamp.y, lamp.z);
      // Failing ballast: an irregular stutter, not a clean sine.
      const f = Math.sin(this.flickerPhase * 11 + lamp.flicker) * Math.sin(this.flickerPhase * 3.1 + lamp.flicker * 2);
      light.intensity = 16 + f * 6 + (Math.random() < 0.01 ? -13 : 0);
    }
  }

  // --- Queries -------------------------------------------------------------

// Bucket the solid props by cell so collision only ever tests the handful
  // within reach, rather than every crate in the facility.
  indexObstacles(obstacles) {
    this.obstacles = obstacles;
    this.obstacleBuckets = new Map();
    for (const o of obstacles) {
      const c = this.worldToCell(o.x, o.z);
      // A prop can overhang into a neighbouring cell, so register it in each
      // cell its radius touches.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = (c.cx + dx) + ',' + (c.cy + dy);
          let list = this.obstacleBuckets.get(key);
          if (!list) { list = []; this.obstacleBuckets.set(key, list); }
          list.push(o);
        }
      }
    }
  }

  cellToWorld(cx, cy) {
    const { w, h, cell } = this.map;
    return { x: (cx - (w - 1) / 2) * cell, z: (cy - (h - 1) / 2) * cell };
  }

  worldToCell(x, z) {
    const { w, h, cell } = this.map;
    return { cx: Math.round(x / cell + (w - 1) / 2), cy: Math.round(z / cell + (h - 1) / 2) };
  }

  isSolidCell(cx, cy) {
    const { w, h } = this.map;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return true;
    return this.grid[cy * w + cx] !== 1;
  }

  isSolidAt(x, z) {
    const c = this.worldToCell(x, z);
    return this.isSolidCell(c.cx, c.cy);
  }

  // Resolve a circle against the level: rock first, then props.
  //
  // The two constraints have to be satisfied together. Doing one pass of each
  // let the prop push-out undo the wall push-out and deposit the player inside
  // rock, so iterate until the position stops moving. Realistic layouts settle
  // in one or two passes; the cap stops a pathological corner from spinning.
  resolveCollision(x, z, radius) {
    let outX = x, outZ = z;
    for (let pass = 0; pass < 4; pass++) {
      const prevX = outX, prevZ = outZ;
      ({ x: outX, z: outZ } = this.pushOutOfWalls(outX, outZ, radius));
      ({ x: outX, z: outZ } = this.pushOutOfProps(outX, outZ, radius));
      if (Math.abs(outX - prevX) < 1e-6 && Math.abs(outZ - prevZ) < 1e-6) break;
    }
    return { x: outX, z: outZ };
  }

  // Circle against the axis-aligned boxes of the solid cells around it.
  pushOutOfWalls(x, z, radius) {
    const { cell } = this.map;
    const c = this.worldToCell(x, z);
    let outX = x, outZ = z;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = c.cx + dx, cy = c.cy + dy;
        if (!this.isSolidCell(cx, cy)) continue;
        const center = this.cellToWorld(cx, cy);
        const half = cell / 2;
        const minX = center.x - half, maxX = center.x + half;
        const minZ = center.z - half, maxZ = center.z + half;

        const closestX = Math.max(minX, Math.min(outX, maxX));
        const closestZ = Math.max(minZ, Math.min(outZ, maxZ));
        const dxp = outX - closestX, dzp = outZ - closestZ;
        const distSq = dxp * dxp + dzp * dzp;
        if (distSq >= radius * radius) continue;

        if (distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          outX = closestX + (dxp / dist) * radius;
          outZ = closestZ + (dzp / dist) * radius;
        } else {
          // Dead centre inside the box: eject along the shallowest axis.
          const penX = Math.min(outX - minX, maxX - outX);
          const penZ = Math.min(outZ - minZ, maxZ - outZ);
          if (penX < penZ) outX = outX < center.x ? minX - radius : maxX + radius;
          else outZ = outZ < center.z ? minZ - radius : maxZ + radius;
        }
      }
    }
    return { x: outX, z: outZ };
  }

  // Circle against the crates, barrels, lockers and the generator housing.
  pushOutOfProps(x, z, radius) {
    let outX = x, outZ = z;
    const here = this.worldToCell(outX, outZ);
    const near = this.obstacleBuckets.get(here.cx + ',' + here.cy);
    if (!near) return { x: outX, z: outZ };

    for (const o of near) {
      const dx = outX - o.x, dz = outZ - o.z;
      const min = o.r + radius;
      const distSq = dx * dx + dz * dz;
      if (distSq >= min * min) continue;
      if (distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        outX = o.x + (dx / dist) * min;
        outZ = o.z + (dz / dist) * min;
      } else {
        outX = o.x + min;   // exactly concentric: shove along +X
      }
    }
    return { x: outX, z: outZ };
  }

  dispose() {
    if (this.root) this.scene.remove(this.root);
    for (const d of this.disposables) { try { d.dispose(); } catch { /* not disposable */ } }
    this.disposables = [];
    this.lamps = [];
    this.lampLights = [];
    this.fuseSlots = [];
    this.obstacles = [];
    this.obstacleBuckets = new Map();
    this.root = new THREE.Group();
  }
}

// --- Geometry helpers ------------------------------------------------------

function transformed(geo, x, y, z) {
  geo.translate(x, y, z);
  return geo;
}

// Merge indexed BufferGeometries that share the standard attribute set.
// three's BufferGeometryUtils would do this, but pulling in an examples module
// just for one function is not worth the extra vendored file.
function mergeGeometries(geoms) {
  let vertexCount = 0, indexCount = 0;
  for (const g of geoms) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint32Array(indexCount);

  let vOffset = 0, iOffset = 0;
  for (const g of geoms) {
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const tex = g.attributes.uv;
    position.set(pos.array, vOffset * 3);
    if (nrm) normal.set(nrm.array, vOffset * 3);
    if (tex) uv.set(tex.array, vOffset * 2);

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[iOffset + i] = g.index.array[i] + vOffset;
      iOffset += g.index.count;
    } else {
      for (let i = 0; i < pos.count; i++) index[iOffset + i] = i + vOffset;
      iOffset += pos.count;
    }
    vOffset += pos.count;
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

export { QUALITY, mergeGeometries };
