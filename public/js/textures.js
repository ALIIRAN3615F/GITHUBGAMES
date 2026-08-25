// Procedural textures.
//
// The game ships no image assets: every surface is painted into a canvas at
// startup. That keeps the download tiny, means a LAN host needs no CDN, and
// lets the facility look slightly different from a fresh seed.

import * as THREE from '../vendor/three.module.js';

// --- Noise ------------------------------------------------------------------

function hash2(x, y, seed) {
  // Integer avalanche via Math.imul: stays exact in 32-bit space, where a plain
  // multiply would silently lose the low bits that make the noise look random.
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t) { return t * t * (3 - 2 * t); }

// Bilinear value noise, sampled on a lattice of `scale` cells across the image.
function valueNoise(x, y, scale, seed) {
  const xs = x * scale, ys = y * scale;
  const x0 = Math.floor(xs), y0 = Math.floor(ys);
  const fx = smoothstep(xs - x0), fy = smoothstep(ys - y0);
  // Wrap the lattice so the resulting texture tiles seamlessly.
  const wrap = (v) => ((v % scale) + scale) % scale;
  const a = hash2(wrap(x0), wrap(y0), seed);
  const b = hash2(wrap(x0 + 1), wrap(y0), seed);
  const c = hash2(wrap(x0), wrap(y0 + 1), seed);
  const d = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function fbm(x, y, seed, octaves = 4, baseScale = 8) {
  let sum = 0, amp = 0.5, scale = baseScale, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, y, scale, seed + i * 101) * amp;
    norm += amp;
    amp *= 0.5;
    scale *= 2;
  }
  return sum / norm;
}

function makeCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d') };
}

function finish(canvas, repeat = 1, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Paint per-pixel fbm over whatever is already on the canvas.
function grime(ctx, size, seed, strength, tint = [0, 0, 0]) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size, y / size, seed, 5, 6);
      const k = (n - 0.5) * strength;
      const i = (y * size + x) * 4;
      d[i] = clamp255(d[i] + k * 255 + tint[0] * (1 - n) * 40);
      d[i + 1] = clamp255(d[i + 1] + k * 255 + tint[1] * (1 - n) * 40);
      d[i + 2] = clamp255(d[i + 2] + k * 255 + tint[2] * (1 - n) * 40);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// --- Surfaces ---------------------------------------------------------------

// Poured concrete with expansion joints, water stains and old spatter.
export function concreteFloor(seed = 7, size = 256) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#6d6e67';
  ctx.fillRect(0, 0, size, size);

  grime(ctx, size, seed, 0.42, [0.2, 0.15, 0.05]);

  // Expansion joints
  ctx.strokeStyle = 'rgba(10,10,12,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.stroke();

  // Damp patches
  for (let i = 0; i < 14; i++) {
    const x = hash2(i, 3, seed) * size;
    const y = hash2(i, 9, seed) * size;
    const r = 12 + hash2(i, 17, seed) * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(12,14,16,0.5)');
    g.addColorStop(1, 'rgba(12,14,16,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Grit
  for (let i = 0; i < 1400; i++) {
    const x = hash2(i, 31, seed) * size;
    const y = hash2(i, 47, seed) * size;
    const v = hash2(i, 59, seed);
    ctx.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.13)';
    ctx.fillRect(x, y, 1, 1);
  }
  return finish(canvas, 1);
}

// Riveted steel panelling with rust bleeding down from the seams.
export function wallPanel(seed = 13, size = 256) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#7b8188';
  ctx.fillRect(0, 0, size, size);

  const panelH = size / 2;
  for (let py = 0; py < 2; py++) {
    const y = py * panelH;
    const shade = 0.9 + hash2(py, 5, seed) * 0.2;
    ctx.fillStyle = `rgba(${Math.round(123 * shade)},${Math.round(129 * shade)},${Math.round(136 * shade)},1)`;
    ctx.fillRect(2, y + 2, size - 4, panelH - 4);
    // bevel
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.strokeRect(2.5, y + 2.5, size - 5, panelH - 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(1.5, y + 1.5, size - 3, panelH - 3);
  }

  grime(ctx, size, seed + 3, 0.3, [0.35, 0.2, 0.05]);

  // Rivets along the seams
  for (let py = 0; py <= 2; py++) {
    for (let x = 14; x < size; x += 30) {
      const y = py * panelH + 8;
      ctx.fillStyle = 'rgba(20,20,22,0.85)';
      ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(180,185,190,0.16)';
      ctx.beginPath(); ctx.arc(x - 0.7, y - 0.7, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Rust weeping downwards
  for (let i = 0; i < 10; i++) {
    const x = hash2(i, 71, seed) * size;
    const y = hash2(i, 83, seed) * size;
    const len = 24 + hash2(i, 97, seed) * 90;
    const g = ctx.createLinearGradient(x, y, x, y + len);
    g.addColorStop(0, 'rgba(120,62,28,0.42)');
    g.addColorStop(1, 'rgba(90,45,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, 2 + hash2(i, 11, seed) * 5, len);
  }
  return finish(canvas, 1);
}

// Ceiling: darker plate with a run of conduit crossing it.
export function ceilingPlate(seed = 23, size = 256) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#474d53';
  ctx.fillRect(0, 0, size, size);
  grime(ctx, size, seed, 0.3, [0.1, 0.1, 0.12]);

  ctx.fillStyle = 'rgba(46,48,52,0.9)';
  ctx.fillRect(0, size * 0.34, size, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(0, size * 0.34, size, 3);
  ctx.fillStyle = 'rgba(38,32,28,0.85)';
  ctx.fillRect(0, size * 0.68, size, 7);

  for (let i = 0; i < 400; i++) {
    const x = hash2(i, 5, seed) * size, y = hash2(i, 13, seed) * size;
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x, y, 1, 1);
  }
  return finish(canvas, 1);
}

// Painted metal for crates, lockers and machinery.
export function paintedMetal(hex = '#828a78', seed = 31, size = 128) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, size, size);
  grime(ctx, size, seed, 0.34, [0.4, 0.22, 0.06]);

  // Chipped paint along the edges
  for (let i = 0; i < 60; i++) {
    const x = hash2(i, 3, seed) * size;
    const y = hash2(i, 7, seed) * size;
    const r = 1 + hash2(i, 11, seed) * 3;
    ctx.fillStyle = 'rgba(96,58,32,0.5)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
  return finish(canvas, 1);
}

// A dried blood decal with a soft alpha edge, used on floors.
export function bloodDecal(seed = 41, size = 128) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;

  for (let i = 0; i < 9; i++) {
    const a = hash2(i, 3, seed) * Math.PI * 2;
    const d = hash2(i, 5, seed) * size * 0.24;
    const r = size * (0.1 + hash2(i, 7, seed) * 0.2);
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(72,10,8,0.92)');
    g.addColorStop(0.7, 'rgba(52,8,6,0.6)');
    g.addColorStop(1, 'rgba(40,6,5,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Spatter
  for (let i = 0; i < 40; i++) {
    const a = hash2(i, 13, seed) * Math.PI * 2;
    const d = size * (0.2 + hash2(i, 17, seed) * 0.3);
    const r = 0.6 + hash2(i, 19, seed) * 2.6;
    ctx.fillStyle = 'rgba(64,9,7,0.75)';
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft radial falloff used for light glows, fuse halos and the flashlight cone.
export function glowSprite(color = '#ffd08a', size = 128) {
  const { canvas, ctx } = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.25, hexToRgba(color, 0.42));
  g.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Diagonal hazard stripes for the emergency door frame.
export function hazardStripes(size = 128) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#d8b023';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#16161a';
  ctx.lineWidth = size / 8;
  ctx.beginPath();
  for (let i = -size; i < size * 2; i += size / 4) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
  }
  ctx.stroke();
  grime(ctx, size, 61, 0.28, [0.3, 0.2, 0.05]);
  return finish(canvas, 1);
}

// The lit EMERGENCY EXIT panel above the door.
export function exitSign(size = 256) {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#0b1a10';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#0f2d1a';
  ctx.fillRect(6, size * 0.28, size - 12, size * 0.44);

  ctx.fillStyle = '#4dff88';
  ctx.font = 'bold ' + Math.round(size * 0.15) + 'px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('EMERGENCY', size / 2, size * 0.41);
  ctx.fillText('EXIT', size / 2, size * 0.59);

  // Arrows either side, the way real signage carries them.
  ctx.fillStyle = '#2f9c5a';
  for (const dir of [-1, 1]) {
    const cx = size / 2 + dir * size * 0.38;
    ctx.beginPath();
    ctx.moveTo(cx + dir * 14, size / 2);
    ctx.lineTo(cx - dir * 8, size / 2 - 14);
    ctx.lineTo(cx - dir * 8, size / 2 + 14);
    ctx.closePath();
    ctx.fill();
  }
  return finish(canvas, 1);
}

// A soft flame gradient, scrolled and scaled to fake fire cheaply.
export function flameSprite(size = 128) {
  const { canvas, ctx } = makeCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size * 0.68, 0, size / 2, size * 0.6, size * 0.5);
  g.addColorStop(0, 'rgba(255,240,190,0.95)');
  g.addColorStop(0.25, 'rgba(255,168,52,0.85)');
  g.addColorStop(0.6, 'rgba(198,64,18,0.45)');
  g.addColorStop(1, 'rgba(90,20,8,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Torn edges, so the billboards do not read as identical circles.
  for (let i = 0; i < 30; i++) {
    const a = hash2(i, 7, 31) * Math.PI * 2;
    const r = size * (0.2 + hash2(i, 11, 31) * 0.28);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * r, size * 0.6 + Math.sin(a) * r * 0.7,
      size * 0.05 * hash2(i, 13, 31), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Monochrome static, animated by the film-grain overlay.
export function noiseDataURL(size = 180) {
  const { canvas, ctx } = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export { fbm, hash2 };
