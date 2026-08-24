// Screen effects layered over the WebGL canvas.
//
// All of it is DOM: a grain tile, a vignette, a colour flash. Doing this in CSS
// rather than a post-processing chain keeps the render path to a single pass,
// which matters because the torch already costs a shadow map.

import { noiseDataURL } from './textures.js';

export class Fx {
  constructor() {
    this.grain = document.getElementById('grain');
    this.vignette = document.getElementById('vignette');
    this.flash = document.getElementById('flash');
    this.scanline = document.getElementById('scanline');
    this.canvas = document.getElementById('scene');

    // A handful of pre-rendered noise tiles, cycled: cheaper than regenerating
    // and far less regular than scrolling a single tile.
    this.frames = [];
    for (let i = 0; i < 4; i++) this.frames.push(noiseDataURL(180));
    this.frameIndex = 0;
    this.grainTimer = 0;
    this.flashTimer = 0;
    this.nerve = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  update(dt, nerve) {
    this.nerve = nerve;

    if (!this.reduced) {
      // Swap the grain tile a few times a second; any faster reads as noise
      // rather than film, any slower reads as a static overlay.
      this.grainTimer -= dt;
      if (this.grainTimer <= 0) {
        this.grainTimer = 0.055;
        this.frameIndex = (this.frameIndex + 1) % this.frames.length;
        this.grain.style.backgroundImage = `url(${this.frames[this.frameIndex]})`;
        this.grain.style.transform =
          `translate(${(Math.random() * 8 - 4).toFixed(1)}px, ${(Math.random() * 8 - 4).toFixed(1)}px)`;
      }
      this.grain.style.opacity = (0.035 + nerve * 0.075).toFixed(3);
    }

    this.vignette.classList.toggle('fear', nerve > 0.62);

    // Saturation drains and contrast rises as nerve climbs.
    const sat = (1 - nerve * 0.55).toFixed(2);
    const contrast = (1 + nerve * 0.22).toFixed(2);
    this.canvas.style.filter = nerve > 0.05 ? `saturate(${sat}) contrast(${contrast})` : '';

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.flash.style.opacity = Math.max(0, this.flashTimer / this.flashDuration * this.flashPeak).toFixed(3);
      if (this.flashTimer <= 0) this.flash.style.opacity = '0';
    }
  }

  hitFlash(peak = 0.55, duration = 0.7, color = '#b21f10') {
    this.flash.style.background = color;
    this.flashPeak = peak;
    this.flashDuration = duration;
    this.flashTimer = duration;
  }

  reset() {
    this.flash.style.opacity = '0';
    this.canvas.style.filter = '';
    this.vignette.classList.remove('fear');
  }
}
