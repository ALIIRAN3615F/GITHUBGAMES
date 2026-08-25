// Drawing the facility from above.
//
// The level never changes, so floor, walls and props are painted once into an
// offscreen canvas the size of the whole map and blitted each frame. What is
// left per frame is a handful of moving things, the light mask, and the grain -
// which is what lets this hold sixty frames on a machine that would struggle
// with anything three-dimensional.

import { ShadowCaster } from './shadow.js';

export const TILE = 34;                 // pixels per tile at scale 1

const ROCK = 0, FLOOR = 1, DOOR = 2, ALCOVE = 3;

// How dark a room with no light in it is, and how much a remembered one lifts.
const AMBIENT = '#0a0c11';
const MEMORY_LEVEL = 0.13;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.shadow = new ShadowCaster();
    this.time = 0;
    this.map = null;
    this.explored = null;
    this.grainPhase = 0;
  }

  build(map, doorOpen) {
    this.map = map;
    this.grid = Uint8Array.from(map.grid, (c) => +c);
    this.explored = new Uint8Array(map.w * map.h);
    this.doorOpen = doorOpen;

    this.paintLevel();
    this.buildMemory();
    this.rebuildShadows(doorOpen);
  }

  // Anything that stops light. The shutter blocks it until it is fully up.
  rebuildShadows(doorOpen) {
    this.doorOpen = doorOpen;
    const { w, h } = this.map;
    this.shadow.build(w, h, (cx, cy) => {
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return true;
      const v = this.grid[cy * w + cx];
      if (v === DOOR) return !doorOpen;
      return v === ROCK;
    });
  }

  // --- The static level -------------------------------------------------------

  paintLevel() {
    const { w, h } = this.map;
    const canvas = document.createElement('canvas');
    canvas.width = w * TILE;
    canvas.height = h * TILE;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#07080b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        const v = this.grid[cy * w + cx];
        if (v === ROCK) continue;
        this.paintFloorTile(ctx, cx, cy, v);
      }
    }
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        if (this.grid[cy * w + cx] !== ROCK) continue;
        this.paintWallTile(ctx, cx, cy);
      }
    }
    for (const prop of this.map.props) this.paintProp(ctx, prop);

    this.level = canvas;
  }

  paintFloorTile(ctx, cx, cy, v) {
    const x = cx * TILE, y = cy * TILE;
    // Deterministic speckle: the same tile is the same shade every session, so
    // the floor reads as a surface rather than as noise.
    const n = hash2(cx, cy, this.map.seed);
    const base = v === ALCOVE ? 30 : 44;
    const shade = base + Math.floor(n * 14);
    ctx.fillStyle = `rgb(${shade},${shade + 3},${shade + 6})`;
    ctx.fillRect(x, y, TILE, TILE);

    // Grout lines, and a scatter of grit.
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(x, y, TILE, 1);
    ctx.fillRect(x, y, 1, TILE);
    const grit = Math.floor(n * 5);
    ctx.fillStyle = `rgba(${shade + 26},${shade + 28},${shade + 30},0.5)`;
    for (let i = 0; i < grit; i++) {
      const gx = x + hash2(cx * 7 + i, cy * 13, 91) * TILE;
      const gy = y + hash2(cx * 11, cy * 5 + i, 57) * TILE;
      ctx.fillRect(gx, gy, 2, 2);
    }
  }

  paintWallTile(ctx, cx, cy) {
    const { w, h } = this.map;
    const x = cx * TILE, y = cy * TILE;
    const open = (dx, dy) => {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
      return this.grid[ny * w + nx] !== ROCK;
    };
    // Rock nobody can ever see is not worth drawing.
    const exposed = open(1, 0) || open(-1, 0) || open(0, 1) || open(0, -1)
      || open(1, 1) || open(-1, -1) || open(1, -1) || open(-1, 1);
    if (!exposed) return;

    const n = hash2(cx, cy, this.map.seed ^ 0x9e);
    const shade = 96 + Math.floor(n * 22);
    ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 9})`;
    ctx.fillRect(x, y, TILE, TILE);

    // A lip on the faces that front open space, so walls read as blocks with
    // height rather than as flat squares.
    ctx.fillStyle = 'rgba(196,206,218,0.34)';
    if (open(0, -1)) ctx.fillRect(x, y, TILE, 3);
    if (open(-1, 0)) ctx.fillRect(x, y, 3, TILE);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    if (open(0, 1)) ctx.fillRect(x, y + TILE - 4, TILE, 4);
    if (open(1, 0)) ctx.fillRect(x + TILE - 4, y, 4, TILE);

    // Panel seams.
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + TILE / 2);
    ctx.lineTo(x + TILE, y + TILE / 2);
    ctx.stroke();
  }

  paintProp(ctx, prop) {
    const x = prop.x * TILE, y = prop.y * TILE;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(prop.r);
    ctx.scale(prop.s, prop.s);
    switch (prop.t) {
      case 'crate':
        ctx.fillStyle = '#6b5a3e'; ctx.fillRect(-11, -11, 22, 22);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(-11, -11, 22, 22);
        ctx.beginPath(); ctx.moveTo(-11, -11); ctx.lineTo(11, 11); ctx.moveTo(11, -11); ctx.lineTo(-11, 11); ctx.stroke();
        break;
      case 'barrel':
        ctx.fillStyle = '#7a4032';
        ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.stroke();
        break;
      case 'locker':
        ctx.fillStyle = '#4d5560'; ctx.fillRect(-8, -13, 16, 26);
        ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(-1, -13, 2, 26);
        break;
      case 'desk':
        ctx.fillStyle = '#5a4a35'; ctx.fillRect(-16, -9, 32, 18);
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(-16, 3, 32, 6);
        break;
      case 'pipe':
        ctx.fillStyle = '#575f68'; ctx.fillRect(-14, -4, 28, 8);
        ctx.fillStyle = 'rgba(220,230,240,0.18)'; ctx.fillRect(-14, -4, 28, 2);
        break;
      case 'stain':
        ctx.fillStyle = 'rgba(74,16,14,0.55)';
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          const r = 7 + hash2(Math.round(prop.x * 4), i, 33) * 9;
          ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
        break;
      default:                       // debris
        ctx.fillStyle = 'rgba(150,150,160,0.30)';
        for (let i = 0; i < 5; i++) {
          const a = hash2(i, Math.round(prop.y * 4), 71) * Math.PI * 2;
          const r = 4 + hash2(i, 3, 19) * 8;
          ctx.fillRect(Math.cos(a) * r, Math.sin(a) * r, 3, 3);
        }
        break;
    }
    ctx.restore();
  }

  // --- What the survivors remember ---------------------------------------------

  // One pixel per tile, blitted scaled up and smoothed. It costs a single
  // drawImage a frame and gives the layout you have already walked a faint
  // presence in the dark, which is the difference between tense and tedious.
  buildMemory() {
    const { w, h } = this.map;
    this.memory = document.createElement('canvas');
    this.memory.width = w;
    this.memory.height = h;
    this.memoryCtx = this.memory.getContext('2d');
    this.memoryDirty = true;
  }

  // Mark everything the player can currently see. A cell counts as seen when
  // there is a clear line to it, which is the same test the monster uses.
  observe(px, py, radius) {
    const { w, h } = this.map;
    const minX = Math.max(0, Math.floor(px - radius));
    const maxX = Math.min(w - 1, Math.ceil(px + radius));
    const minY = Math.max(0, Math.floor(py - radius));
    const maxY = Math.min(h - 1, Math.ceil(py + radius));
    const r2 = radius * radius;

    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const i = cy * w + cx;
        if (this.explored[i]) continue;
        const dx = cx + 0.5 - px, dy = cy + 0.5 - py;
        if (dx * dx + dy * dy > r2) continue;
        if (!this.visible(px, py, cx, cy)) continue;
        this.explored[i] = 1;
        this.memoryDirty = true;
      }
    }
    if (!this.memoryDirty) return;
    this.memoryDirty = false;
    const img = this.memoryCtx.createImageData(w, h);
    for (let i = 0; i < this.explored.length; i++) {
      if (!this.explored[i]) continue;
      const o = i * 4;
      img.data[o] = 90; img.data[o + 1] = 104; img.data[o + 2] = 126;
      img.data[o + 3] = 255;
    }
    this.memoryCtx.putImageData(img, 0, 0);
  }

  // A grid march from the player to a cell. Walls stop it; the cell holding the
  // wall still counts as seen, or every room would have invisible edges.
  visible(px, py, cx, cy) {
    const { w, h } = this.map;
    const tx = cx + 0.5, ty = cy + 0.5;
    const dx = tx - px, dy = ty - py;
    const steps = Math.ceil(Math.hypot(dx, dy) * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const sx = Math.floor(px + dx * t), sy = Math.floor(py + dy * t);
      if (sx === cx && sy === cy) return true;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
      if (this.grid[sy * w + sx] === ROCK) return false;
    }
    return true;
  }

  // --- Per-frame ----------------------------------------------------------------

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.dpr = dpr;
  }

  // `scene` carries everything that moves. Drawing order is floor, then the
  // things standing on it, then the light, then the film on top of the lens.
  draw(dt, scene) {
    this.time += dt;
    const ctx = this.ctx;
    const width = this.canvas.width, height = this.canvas.height;
    const scale = TILE * (this.dpr || 1) * scene.zoom;
    const view = { x: scene.camera.x, y: scene.camera.y, scale, width, height };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(scale / TILE, scale / TILE);
    ctx.translate(-view.x * TILE, -view.y * TILE);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.level, 0, 0);
    ctx.imageSmoothingEnabled = true;

    this.drawObjectives(ctx, scene);
    this.drawEntities(ctx, scene);
    ctx.restore();

    this.composite(ctx, view, scene);
    this.drawGrain(ctx, dt, scene);
  }

  drawObjectives(ctx, scene) {
    const map = this.map;

    // The generator: a housing with a row of fuse slots that fill up as they
    // are seated, and a beacon that turns green when it is running.
    const g = map.generator;
    ctx.save();
    ctx.translate(g.x * TILE, g.y * TILE);
    ctx.fillStyle = '#3f464e';
    ctx.fillRect(-22, -16, 44, 32);
    ctx.fillStyle = '#2a3037';
    ctx.fillRect(-22, 6, 44, 10);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-22, -16, 44, 32);
    const need = map.fuseCount;
    for (let i = 0; i < need; i++) {
      ctx.fillStyle = i < scene.powered ? '#ffc24a' : '#241a12';
      ctx.fillRect(-18 + i * (36 / need), -12, 36 / need - 3, 7);
    }
    const on = scene.generatorOn;
    const pulse = 0.6 + Math.sin(this.time * (on ? 7 : 2.2)) * 0.4;
    ctx.fillStyle = on
      ? `rgba(110,255,150,${pulse})`
      : scene.powered ? `rgba(255,168,60,${pulse})` : `rgba(255,80,60,${pulse})`;
    ctx.beginPath(); ctx.arc(0, 1, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // The exit shutter, and the panel that drives it.
    this.drawDoor(ctx, scene);

    // Fuses lying on the floor, and batteries.
    for (const f of scene.fuses) {
      if (f.state !== 0) continue;
      ctx.save();
      ctx.translate(f.x * TILE, f.y * TILE);
      const bob = Math.sin(this.time * 2.4 + f.id) * 1.6;
      ctx.fillStyle = '#c9a227';
      ctx.fillRect(-5, -9 + bob, 10, 18);
      ctx.fillStyle = '#f5e6a8';
      ctx.fillRect(-5, -9 + bob, 10, 4);
      ctx.fillRect(-5, 5 + bob, 10, 4);
      ctx.restore();
    }
    for (const b of scene.batteries) {
      if (b.taken) continue;
      ctx.save();
      ctx.translate(b.x * TILE, b.y * TILE);
      ctx.fillStyle = '#2f7d4f';
      ctx.fillRect(-3, -7, 6, 14);
      ctx.fillStyle = '#9be36b';
      ctx.fillRect(-3, -7, 6, 3);
      ctx.restore();
    }
  }

  drawDoor(ctx, scene) {
    const d = this.map.door;
    const lift = scene.door[1];
    ctx.save();
    ctx.translate(d.x * TILE, d.y * TILE);
    // The frame, drawn across the opening.
    const across = d.nx !== 0;
    ctx.fillStyle = '#2b3138';
    if (across) ctx.fillRect(-TILE / 2, -TILE / 2, TILE, TILE);
    else ctx.fillRect(-TILE / 2, -TILE / 2, TILE, TILE);
    // Hazard striping on the jambs.
    ctx.fillStyle = '#c8a11e';
    for (let i = -2; i <= 2; i++) {
      if (across) ctx.fillRect(-TILE / 2, i * 7 - 2, 4, 4);
      else ctx.fillRect(i * 7 - 2, -TILE / 2, 4, 4);
    }
    // The shutter itself, retracting as it winds up.
    const open = 1 - lift;
    ctx.fillStyle = '#7a828b';
    if (across) {
      ctx.fillRect(-6, -TILE / 2, 12, TILE * open);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let s = 0; s < TILE * open; s += 5) ctx.fillRect(-6, -TILE / 2 + s, 12, 1);
    } else {
      ctx.fillRect(-TILE / 2, -6, TILE * open, 12);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let s = 0; s < TILE * open; s += 5) ctx.fillRect(-TILE / 2 + s, -6, 1, 12);
    }
    ctx.restore();

    // The control panel on the wall beside it.
    const p = this.map.door.panel;
    ctx.save();
    ctx.translate(p.x * TILE, p.y * TILE);
    ctx.fillStyle = '#39414a';
    ctx.fillRect(-9, -7, 18, 14);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-9, -7, 18, 14);
    const live = scene.generatorOn;
    ctx.fillStyle = live ? '#5dff8e' : '#ff3a24';
    ctx.fillRect(-6, -4, 12, 3);
    ctx.fillStyle = live ? '#b3231a' : '#4a1a15';
    ctx.beginPath(); ctx.arc(0, 3, 3.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  drawEntities(ctx, scene) {
    for (const m of scene.monsters) this.drawMonster(ctx, m);
    for (const p of scene.players) this.drawSurvivor(ctx, p, scene);
  }

  drawSurvivor(ctx, p, scene) {
    if (p.state === 2 || p.state === 3) return;
    const colour = '#' + p.color.toString(16).padStart(6, '0');
    ctx.save();
    ctx.translate(p.x * TILE, p.y * TILE);

    if (p.state === 1) {
      // Down: a crumpled shape, pulsing so it is findable in the dark.
      const pulse = 0.5 + Math.sin(this.time * 5) * 0.5;
      ctx.fillStyle = `rgba(255,70,60,${0.25 + pulse * 0.35})`;
      ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = colour;
      ctx.beginPath(); ctx.ellipse(0, 0, 11, 7, 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      this.drawLabel(ctx, p, scene);
      return;
    }

    ctx.rotate(p.aim);
    const crouch = (p.flags & 4) !== 0;
    const r = crouch ? 7.5 : 9.5;
    // Body, then a shoulder wedge so which way they face is unmistakable.
    ctx.fillStyle = '#20262d';
    ctx.beginPath(); ctx.arc(0, 0, r + 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(r + 5, 0); ctx.lineTo(r - 3, -4.5); ctx.lineTo(r - 3, 4.5);
    ctx.closePath(); ctx.fill();
    if (p.carrying) {
      ctx.fillStyle = '#ffc24a';
      ctx.fillRect(-4, -r - 7, 8, 5);
    }
    ctx.restore();
    this.drawLabel(ctx, p, scene);
  }

  drawLabel(ctx, p, scene) {
    if (p.id === scene.localId) return;
    ctx.save();
    ctx.translate(p.x * TILE, p.y * TILE - 20);
    ctx.font = '600 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(p.name, 0, 1);
    ctx.fillStyle = '#' + p.color.toString(16).padStart(6, '0');
    ctx.fillText(p.name, 0, 0);
    ctx.restore();
  }

  drawMonster(ctx, m) {
    if (m.state === 0) return;              // still asleep: not in the level yet
    ctx.save();
    ctx.translate(m.x * TILE, m.y * TILE);
    ctx.rotate(m.aim);
    const chasing = m.state === 4;
    const wobble = Math.sin(this.time * (chasing ? 14 : 5)) * (chasing ? 2.4 : 1);

    // Limbs first, so the body sits on top of them.
    ctx.strokeStyle = '#16181c';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, side * 5);
      ctx.lineTo(13, side * 11 + wobble * side);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, side * 5);
      ctx.lineTo(-14, side * 9 - wobble * side);
      ctx.stroke();
    }
    ctx.fillStyle = '#191c21';
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 9, 0, 0, Math.PI * 2); ctx.fill();
    // Two small eyes, brighter the more certain it is about you.
    const heat = chasing ? 1 : m.state === 3 ? 0.65 : 0.3;
    ctx.fillStyle = `rgba(255,${Math.round(60 * heat)},${Math.round(40 * heat)},${0.5 + heat * 0.5})`;
    ctx.beginPath(); ctx.arc(8, -3, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(8, 3, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // --- Light ----------------------------------------------------------------

  composite(ctx, view, scene) {
    this.shadow.begin(view, AMBIENT);

    // What the survivors remember of the layout, under everything else.
    const mctx = this.shadow.maskCtx;
    mctx.globalCompositeOperation = 'lighter';
    mctx.globalAlpha = MEMORY_LEVEL;
    mctx.imageSmoothingEnabled = true;
    const w = this.map.w * view.scale, h = this.map.h * view.scale;
    mctx.drawImage(this.memory,
      -view.x * view.scale + view.width / 2, -view.y * view.scale + view.height / 2, w, h);
    mctx.globalAlpha = 1;

    for (const light of scene.lights) this.shadow.addLight(light);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.shadow.canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  // A little moving grain and a vignette. Both are drawn as transforms of one
  // pre-rendered tile, so neither costs anything per pixel of the screen.
  drawGrain(ctx, dt, scene) {
    if (!this.grain) this.grain = makeGrain(128);
    this.grainPhase += dt;
    const width = this.canvas.width, height = this.canvas.height;

    ctx.save();
    ctx.globalAlpha = 0.05 + scene.nerve * 0.09;
    ctx.globalCompositeOperation = 'lighter';
    const ox = (this.grainPhase * 733) % 128;
    const oy = (this.grainPhase * 517) % 128;
    ctx.translate(-ox, -oy);
    const pattern = ctx.createPattern(this.grain, 'repeat');
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width + 128, height + 128);
    ctx.restore();

    if (!this.vignette || this.vignetteFor !== width + 'x' + height) {
      this.vignette = makeVignette(width, height);
      this.vignetteFor = width + 'x' + height;
    }
    ctx.globalAlpha = 0.55 + scene.nerve * 0.35;
    ctx.drawImage(this.vignette, 0, 0);
    ctx.globalAlpha = 1;
  }
}

function makeGrain(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.random() * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 26;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function makeVignette(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.72);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.92)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  return c;
}

// Integer avalanche, exact in 32-bit space, so the same tile is the same shade
// on every machine.
function hash2(x, y, seed) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
