// Shadows, in two dimensions.
//
// Every solid cell contributes the edges that border open space; collinear runs
// are merged, so a long corridor wall is one segment rather than forty. For a
// light, each segment facing it is projected away from it and the resulting
// quad is punched out of that light's shape. Accumulate every light into one
// mask and multiply it over the scene, and the result is a facility where the
// dark is genuinely dark and a torch genuinely carves a wedge out of it.
//
// Two offscreen canvases do all of it, reused every frame: one to build a
// single light in, one to accumulate them into.

const SHADOW_LENGTH = 60;      // tiles - far enough to leave the screen

export class ShadowCaster {
  constructor() {
    this.segments = [];
    this.buckets = new Map();  // cell key -> segments touching that cell
    this.scratch = document.createElement('canvas');
    this.scratchCtx = this.scratch.getContext('2d');
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d');
  }

  // `opaque(cx, cy)` decides what casts a shadow. It is re-run whenever that
  // changes - which in practice means when the exit shutter finishes opening.
  build(w, h, opaque) {
    this.w = w;
    this.h = h;
    const segs = [];

    // Horizontal edges: walk each row and merge runs that share a boundary.
    for (let y = 0; y <= h; y++) {
      let runTop = null, runBottom = null;
      for (let x = 0; x <= w; x++) {
        const above = y > 0 && opaque(x, y - 1);
        const below = y < h && opaque(x, y);
        const inBounds = x < w;
        // A face exists where solid meets open.
        const top = inBounds && below && !above;
        const bottom = inBounds && above && !below;
        runTop = extend(segs, runTop, top, x, y, true);
        runBottom = extend(segs, runBottom, bottom, x, y, true);
      }
    }
    // Vertical edges: the same walk, down the columns.
    for (let x = 0; x <= w; x++) {
      let runLeft = null, runRight = null;
      for (let y = 0; y <= h; y++) {
        const left = x > 0 && opaque(x - 1, y);
        const right = x < w && opaque(x, y);
        const inBounds = y < h;
        runLeft = extend(segs, runLeft, inBounds && right && !left, x, y, false);
        runRight = extend(segs, runRight, inBounds && left && !right, x, y, false);
      }
    }

    this.segments = segs;
    this.index();
  }

  // Bucket segments by the cells they span, so a light only ever tests the
  // handful of walls actually near it rather than every wall in the facility.
  index() {
    this.buckets = new Map();
    for (const s of this.segments) {
      const minX = Math.floor(Math.min(s.x1, s.x2)) - 1;
      const maxX = Math.floor(Math.max(s.x1, s.x2)) + 1;
      const minY = Math.floor(Math.min(s.y1, s.y2)) - 1;
      const maxY = Math.floor(Math.max(s.y1, s.y2)) + 1;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const key = x + ',' + y;
          let list = this.buckets.get(key);
          if (!list) { list = []; this.buckets.set(key, list); }
          list.push(s);
        }
      }
    }
  }

  near(lx, ly, radius) {
    const out = new Set();
    const minX = Math.floor(lx - radius), maxX = Math.ceil(lx + radius);
    const minY = Math.floor(ly - radius), maxY = Math.ceil(ly + radius);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const list = this.buckets.get(x + ',' + y);
        if (list) for (const s of list) out.add(s);
      }
    }
    return out;
  }

  // --- Per-frame -------------------------------------------------------------

  // `view` is the camera: {x, y, scale, width, height} in tiles and pixels.
  begin(view, ambient) {
    const { width, height } = view;
    if (this.mask.width !== width || this.mask.height !== height) {
      this.mask.width = this.scratch.width = width;
      this.mask.height = this.scratch.height = height;
    }
    this.view = view;
    const ctx = this.maskCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = ambient;
    ctx.fillRect(0, 0, width, height);
  }

  // A cone of light, or a full circle when `spread` is a whole turn. Everything
  // is drawn into the scratch canvas, the shadows are punched out of it, and
  // the result is added to the mask.
  addLight(light) {
    const { x, y, radius, colour = '#ffffff', intensity = 1 } = light;
    const spread = light.spread ?? Math.PI * 2;
    const angle = light.angle ?? 0;
    const v = this.view;
    const ctx = this.scratchCtx;

    const sx = (x - v.x) * v.scale + v.width / 2;
    const sy = (y - v.y) * v.scale + v.height / 2;
    const sr = radius * v.scale;
    // Nothing to do if the light cannot reach the screen at all.
    if (sx + sr < 0 || sy + sr < 0 || sx - sr > v.width || sy - sr > v.height) return;

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, v.width, v.height);

    const grad = ctx.createRadialGradient(sx, sy, sr * 0.04, sx, sy, sr);
    grad.addColorStop(0, colour);
    grad.addColorStop(0.45, mixAlpha(colour, 0.62 * intensity));
    grad.addColorStop(1, mixAlpha(colour, 0));
    ctx.fillStyle = grad;

    ctx.beginPath();
    if (spread >= Math.PI * 2 - 0.01) {
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    } else {
      // A cone with its apex a little behind the holder, so the beam has a
      // throat rather than springing out of a single point.
      ctx.moveTo(sx - Math.cos(angle) * sr * 0.08, sy - Math.sin(angle) * sr * 0.08);
      ctx.arc(sx, sy, sr, angle - spread / 2, angle + spread / 2);
      ctx.closePath();
    }
    ctx.fill();

    // Punch the shadows out of it.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (const s of this.near(x, y, radius)) {
      // Only faces turned toward the light cast anything.
      const nx = s.y2 - s.y1, ny = s.x1 - s.x2;
      if ((s.x1 - x) * nx + (s.y1 - y) * ny <= 0) continue;

      const a = project(s.x1, s.y1, x, y);
      const b = project(s.x2, s.y2, x, y);
      ctx.moveTo((s.x1 - v.x) * v.scale + v.width / 2, (s.y1 - v.y) * v.scale + v.height / 2);
      ctx.lineTo((s.x2 - v.x) * v.scale + v.width / 2, (s.y2 - v.y) * v.scale + v.height / 2);
      ctx.lineTo((b.x - v.x) * v.scale + v.width / 2, (b.y - v.y) * v.scale + v.height / 2);
      ctx.lineTo((a.x - v.x) * v.scale + v.width / 2, (a.y - v.y) * v.scale + v.height / 2);
    }
    ctx.fill();

    this.maskCtx.globalCompositeOperation = 'lighter';
    this.maskCtx.drawImage(this.scratch, 0, 0);
  }

  // The finished mask, ready to be multiplied over the scene.
  get canvas() { return this.mask; }
}

// Grow the current run by one cell, or close it off and start another.
function extend(segs, run, present, x, y, horizontal) {
  if (present) {
    if (run) { run.end = horizontal ? x + 1 : y + 1; return run; }
    return horizontal
      ? { start: x, end: x + 1, at: y, horizontal }
      : { start: y, end: y + 1, at: x, horizontal };
  }
  if (run) segs.push(toSegment(run));
  return null;
}

function toSegment(run) {
  return run.horizontal
    ? { x1: run.start, y1: run.at, x2: run.end, y2: run.at }
    : { x1: run.at, y1: run.start, x2: run.at, y2: run.end };
}

function project(px, py, lx, ly) {
  const dx = px - lx, dy = py - ly;
  const len = Math.hypot(dx, dy) || 1;
  return { x: px + (dx / len) * SHADOW_LENGTH, y: py + (dy / len) * SHADOW_LENGTH };
}

// Turn '#rrggbb' into 'rgba(...)' at the given alpha, so one colour string can
// drive every stop of a falloff.
function mixAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
