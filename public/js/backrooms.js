// The Backrooms.
//
// Built to a different budget than the facility. There is no monster here and
// nothing to fight, so the whole effect has to come from the room itself: flat
// buzzing yellow light everywhere, partitions that repeat until you lose track,
// and a silence with a hum under it.
//
// Everything is instanced or merged. The ceiling is covered in fluorescent
// panels, but they are emissive quads in a single draw call - only a handful of
// real lights exist, and they follow the camera.

import * as THREE from '../vendor/three.module.js';
import * as TEX from './textures.js';
import { mergeGeometries } from './world.js';

const LIGHT_POOL = { low: 0, medium: 2, high: 3 };

export class Backrooms {
  constructor(scene, quality = 'medium') {
    this.scene = scene;
    this.qualityName = quality;
    this.poolSize = LIGHT_POOL[quality] ?? 2;
    this.root = null;
    this.map = null;
    this.grid = null;
    this.fixtures = [];
    this.lights = [];
    this.disposables = [];
    this.phase = 0;
    this.built = false;
  }

  build(back) {
    this.dispose();
    this.map = back;
    this.grid = Uint8Array.from(back.grid, (c) => +c);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.materials = this.makeMaterials();
    this.buildShell();
    this.buildWalls();
    this.buildFixtures();
    this.buildLadder();
    this.built = true;
  }

  makeMaterials() {
    const { w, h } = this.map;
    const wall = TEX.backroomsWall(this.map.seed & 0xffff);
    wall.repeat.set(2, 1.4);

    const carpet = TEX.backroomsCarpet((this.map.seed >> 5) & 0xffff);
    carpet.repeat.set(w, h);

    const ceiling = TEX.backroomsCeiling((this.map.seed >> 9) & 0xffff);
    ceiling.repeat.set(w * 0.5, h * 0.5);

    const panel = TEX.fluorescentPanel();
    this.disposables.push(wall, carpet, ceiling, panel);

    return {
      wall: new THREE.MeshStandardMaterial({ map: wall, roughness: 0.94, metalness: 0 }),
      carpet: new THREE.MeshStandardMaterial({ map: carpet, roughness: 1, metalness: 0 }),
      ceiling: new THREE.MeshStandardMaterial({ map: ceiling, roughness: 1, metalness: 0 }),
      // The panels are the light, as far as the eye is concerned: unlit, always
      // full brightness, and free.
      panel: new THREE.MeshBasicMaterial({ map: panel, toneMapped: false }),
      trim: new THREE.MeshStandardMaterial({ color: 0x8d8468, roughness: 0.85 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.55, metalness: 0.6 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x14120c, roughness: 1 }),
    };
  }

  buildShell() {
    const { w, h, cell, wallH, origin } = this.map;
    const W = w * cell, H = h * cell;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.materials.carpet);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(origin.x, 0, origin.z);
    this.root.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(W, H), this.materials.ceiling);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(origin.x, wallH, origin.z);
    this.root.add(ceiling);

    this.disposables.push(floor.geometry, ceiling.geometry);
  }

  buildWalls() {
    const { w, h, cell, wallH } = this.map;
    const visible = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (this.grid[y * w + x] !== 0) continue;
        let exposed = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (this.grid[ny * w + nx] !== 0) { exposed = true; break; }
        }
        if (exposed) visible.push([x, y]);
      }
    }

    const geo = new THREE.BoxGeometry(cell, wallH, cell);
    const mesh = new THREE.InstancedMesh(geo, this.materials.wall, visible.length);
    const m = new THREE.Matrix4();
    visible.forEach(([x, y], i) => {
      const p = this.cellToWorld(x, y);
      m.makeTranslation(p.x, wallH / 2, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.wallMesh = mesh;
    this.disposables.push(geo);
  }

  // Ceiling fixtures on a fixed lattice. Hundreds of them, one draw call, and
  // no lighting cost at all - the glow is the material.
  buildFixtures() {
    const { w, h, cell, wallH } = this.map;
    const spots = [];
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        if (this.grid[y * w + x] === 0) continue;
        const p = this.cellToWorld(x, y);
        // A deterministic scatter of dead tubes: no RNG, so every client sees
        // exactly the same ones out.
        const dead = ((x * 73856093) ^ (y * 19349663)) % 11 === 0;
        spots.push({ x: p.x, z: p.z, dead });
      }
    }

    const geo = new THREE.PlaneGeometry(cell * 0.55, cell * 0.55);
    const mesh = new THREE.InstancedMesh(geo, this.materials.panel, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    const scale = new THREE.Vector3(1, 1, 1);
    const colour = new THREE.Color();
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);

    spots.forEach((s, i) => {
      m.compose(new THREE.Vector3(s.x, wallH - 0.03, s.z), q, scale);
      mesh.setMatrixAt(i, m);
      // A dead tube is an unlit diffuser, not a hole in the ceiling.
      colour.setScalar(s.dead ? 0.45 : 1);
      mesh.setColorAt(i, colour);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.fixtureMesh = mesh;
    this.fixtures = spots.filter((s) => !s.dead);
    this.disposables.push(geo);

    for (let i = 0; i < this.poolSize; i++) {
      const light = new THREE.PointLight(0xfff0c4, 0, 15, 1.6);
      light.visible = false;
      this.root.add(light);
      this.lights.push(light);
    }
  }

  // The ladder at the dead end of the long corridor, and the vent above it.
  // There is no marker on it and nothing points the way: you find it or you
  // walk the corridor again.
  buildLadder() {
    const l = this.map.ladder;
    const group = new THREE.Group();
    group.position.set(l.x, 0, l.z);
    group.rotation.y = l.yaw;

    const rails = [];
    for (const side of [-0.28, 0.28]) {
      rails.push(transformedGeo(new THREE.BoxGeometry(0.07, l.top + 0.5, 0.07), side, (l.top + 0.5) / 2, 0));
    }
    for (let y = 0.3; y < l.top + 0.4; y += 0.32) {
      rails.push(transformedGeo(new THREE.BoxGeometry(0.62, 0.045, 0.045), 0, y, 0));
    }
    // Brackets holding it off the wall.
    for (const y of [0.6, l.top - 0.4]) {
      rails.push(transformedGeo(new THREE.BoxGeometry(0.06, 0.06, 0.3), -0.28, y, 0.16));
      rails.push(transformedGeo(new THREE.BoxGeometry(0.06, 0.06, 0.3), 0.28, y, 0.16));
    }
    const merged = mergeGeometries(rails);
    group.add(new THREE.Mesh(merged, this.materials.steel));
    this.disposables.push(merged);

    // The vent: a black hole in the ceiling with a hinged grille beside it.
    const hole = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 1.0),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    hole.rotation.x = Math.PI / 2;
    hole.position.set(0, this.map.wallH - 0.02, -0.35);
    group.add(hole);
    this.disposables.push(hole.geometry, hole.material);

    const frame = mergeGeometries([
      transformedGeo(new THREE.BoxGeometry(1.2, 0.06, 0.1), 0, this.map.wallH - 0.05, -0.87),
      transformedGeo(new THREE.BoxGeometry(1.2, 0.06, 0.1), 0, this.map.wallH - 0.05, 0.17),
      transformedGeo(new THREE.BoxGeometry(0.1, 0.06, 1.14), -0.55, this.map.wallH - 0.05, -0.35),
      transformedGeo(new THREE.BoxGeometry(0.1, 0.06, 1.14), 0.55, this.map.wallH - 0.05, -0.35),
    ]);
    group.add(new THREE.Mesh(frame, this.materials.steel));
    this.disposables.push(frame);

    // The grille, swung open and hanging.
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.04, 1.1), this.materials.steel);
    grille.position.set(0.9, this.map.wallH - 0.5, -0.35);
    grille.rotation.z = 1.1;
    group.add(grille);
    this.disposables.push(grille.geometry);

    this.root.add(group);
    this.ladderGroup = group;
  }

  // --- Per-frame -------------------------------------------------------------

  update(dt, playerPos) {
    if (!this.built) return;
    this.phase += dt;

    // The buzz. One global brightness value drives every panel at once, so the
    // flicker costs a single uniform write rather than anything per fixture.
    const hum = 0.82 + Math.sin(this.phase * 31) * 0.03 + Math.sin(this.phase * 7.3) * 0.02;
    const stutter = Math.random() < 0.004 ? 0.4 : 1;
    const level = hum * stutter;
    this.materials.panel.color.setRGB(level, level * 0.975, level * 0.9);

    if (!this.lights.length || !playerPos) return;
    // Nearest-N, same as the facility's lamps.
    const near = this.fixtures
      .map((f) => ({ f, d: (f.x - playerPos.x) ** 2 + (f.z - playerPos.z) ** 2 }))
      .sort((a, b) => a.d - b.d);

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const pick = near[i];
      if (!pick) { light.visible = false; continue; }
      light.visible = true;
      light.position.set(pick.f.x, this.map.wallH - 0.2, pick.f.z);
      light.intensity = 13 * level;
    }
  }

  // --- Queries ---------------------------------------------------------------

  cellToWorld(cx, cy) {
    const { w, h, cell, origin } = this.map;
    return {
      x: origin.x + (cx - (w - 1) / 2) * cell,
      z: origin.z + (cy - (h - 1) / 2) * cell,
    };
  }

  worldToCell(x, z) {
    const { w, h, cell, origin } = this.map;
    return {
      cx: Math.round((x - origin.x) / cell + (w - 1) / 2),
      cy: Math.round((z - origin.z) / cell + (h - 1) / 2),
    };
  }

  isSolidCell(cx, cy) {
    const { w, h } = this.map;
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return true;
    return this.grid[cy * w + cx] === 0;
  }

  isSolidAt(x, z) {
    const c = this.worldToCell(x, z);
    return this.isSolidCell(c.cx, c.cy);
  }

  // Same circle-against-boxes push-out the facility uses. There are no props
  // here, so one pass is always enough.
  resolveCollision(x, z, radius) {
    const { cell } = this.map;
    const c = this.worldToCell(x, z);
    let outX = x, outZ = z;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = c.cx + dx, cy = c.cy + dy;
        if (!this.isSolidCell(cx, cy)) continue;
        const centre = this.cellToWorld(cx, cy);
        const half = cell / 2;
        const minX = centre.x - half, maxX = centre.x + half;
        const minZ = centre.z - half, maxZ = centre.z + half;

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
          if (penX < penZ) outX = outX < centre.x ? minX - radius : maxX + radius;
          else outZ = outZ < centre.z ? minZ - radius : maxZ + radius;
        }
      }
    }
    return { x: outX, z: outZ };
  }

  dispose() {
    if (this.root) this.scene.remove(this.root);
    for (const d of this.disposables) { try { d.dispose(); } catch { /* not disposable */ } }
    this.disposables = [];
    this.fixtures = [];
    this.lights = [];
    this.root = null;
    this.built = false;
  }
}

function transformedGeo(geo, x, y, z) {
  geo.translate(x, y, z);
  return geo;
}
