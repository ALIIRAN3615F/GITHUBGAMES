// Every sound in the game, synthesised at runtime. No files, no downloads, and
// nothing to license: a facility built out of oscillators and noise buffers.
//
// Positioning is stereo pan plus distance attenuation rather than full HRTF.
// Seen from above, left and right and how far away is all the information there
// is, and a cheap pan keeps dozens of overlapping sounds affordable.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volume = 0.8;
    this.loops = new Map();
    this.listener = { x: 0, y: 0 };
    this.tension = 0;
  }

  // Must be called from a user gesture or the context stays suspended.
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;

    // A gentle limiter keeps a scream from clipping over the room tone.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp).connect(ctx.destination);

    // One shared concrete room.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(2.4, 2.6);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.45;
    this.convolver.connect(this.reverbGain).connect(this.master);

    this.noiseBuffer = this.makeNoise(2);
    this.ready = true;
  }

  makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Exponentially decaying noise, which is all a small concrete room is.
  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  setListener(x, y) { this.listener.x = x; this.listener.y = y; }

  // --- Routing ---------------------------------------------------------------

  // Route a source to the master, panned and attenuated by where it is, with a
  // share sent to the room. `ref` is the distance in tiles at which it is still
  // at full volume.
  route(node, gain, x, y, opts = {}) {
    const g = this.ctx.createGain();
    const wet = opts.wet ?? 0.35;

    if (x === undefined) {
      g.gain.value = gain;
      node.connect(g);
      g.connect(this.master);
      const send = this.ctx.createGain();
      send.gain.value = wet;
      g.connect(send).connect(this.convolver);
      return g;
    }

    const dx = x - this.listener.x, dy = y - this.listener.y;
    const d = Math.hypot(dx, dy);
    const ref = opts.ref ?? 6;
    const falloff = ref / (ref + Math.max(0, d - ref) * (opts.rolloff ?? 1.6));
    g.gain.value = gain * falloff;

    const pan = this.ctx.createStereoPanner
      ? this.ctx.createStereoPanner()
      : null;
    node.connect(g);
    if (pan) {
      pan.pan.value = clamp(dx / Math.max(4, d), -0.92, 0.92);
      g.connect(pan).connect(this.master);
      const send = this.ctx.createGain();
      send.gain.value = wet;
      pan.connect(send).connect(this.convolver);
    } else {
      g.connect(this.master);
    }
    return g;
  }

  noiseSource(duration, playbackRate = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.start();
    src.stop(this.ctx.currentTime + duration);
    return src;
  }

  // --- One-shots ---------------------------------------------------------------

  footstep(x, y, { sprint = false, crouch = false, own = false } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.16, crouch ? 0.55 : sprint ? 1.25 : 0.9);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = crouch ? 420 : 900 + Math.random() * 500;
    bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    const level = (crouch ? 0.08 : sprint ? 0.34 : 0.2) * (own ? 1 : 0.85);
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    n.connect(bp).connect(g);
    this.route(g, 1, own ? undefined : x, own ? undefined : y, { wet: 0.25, ref: 4 });
  }

  growl(x, y, intensity = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(48 + Math.random() * 14, t);
    o.frequency.linearRampToValueAtTime(34, t + 1.4);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.3 * intensity, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(lp).connect(g);
    this.route(g, 1, x, y, { wet: 0.6, ref: 10, rolloff: 0.8 });
    o.start(t); o.stop(t + 1.7);
  }

  scream(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [mult, gain] of [[1, 0.24], [1.5, 0.12], [2.51, 0.07]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(280 * mult, t);
      o.frequency.exponentialRampToValueAtTime(680 * mult, t + 0.22);
      o.frequency.exponentialRampToValueAtTime(180 * mult, t + 1.1);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g);
      this.route(g, 1, x, y, { wet: 0.75, ref: 12, rolloff: 0.7 });
      o.start(t); o.stop(t + 1.3);
    }
    const n = this.noiseSource(0.8, 1.6);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1400;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    n.connect(hp).connect(ng);
    this.route(ng, 1, x, y, { wet: 0.7, ref: 12 });
  }

  clang(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const f of [320, 517, 843, 1290]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f * (0.97 + Math.random() * 0.06);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g);
      this.route(g, 1, x, y, { wet: 0.8, ref: 8 });
      o.start(t); o.stop(t + 1.2);
    }
  }

  drip(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(900 + Math.random() * 500, t);
    o.frequency.exponentialRampToValueAtTime(280, t + 0.09);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g);
    this.route(g, 1, x, y, { wet: 0.85, ref: 6 });
    o.start(t); o.stop(t + 0.2);
  }

  whisper(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(1.5, 0.7);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(700, t);
    bp.frequency.linearRampToValueAtTime(1900, t + 1.2);
    bp.Q.value = 5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    n.connect(bp).connect(g);
    this.route(g, 1, x, y, { wet: 0.9, ref: 7 });
  }

  scrape(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.9, 0.35);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.linearRampToValueAtTime(600, t + 0.8);
    bp.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.13, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    n.connect(bp).connect(g);
    this.route(g, 1, x, y, { wet: 0.7, ref: 8 });
  }

  breath(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(1.1, 0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 1.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + 1);
    n.connect(lp).connect(g);
    this.route(g, 1, x, y, { wet: 0.6, ref: 5 });
  }

  heartbeat(intensity = 1) {
    if (!this.ready || intensity <= 0.02) return;
    const t = this.ctx.currentTime;
    for (const at of [0, 0.19]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t + at);
      o.frequency.exponentialRampToValueAtTime(34, t + at + 0.16);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, t + at);
      g.gain.linearRampToValueAtTime(0.24 * intensity * (at ? 0.7 : 1), t + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.24);
      o.connect(g).connect(this.master);
      o.start(t + at); o.stop(t + at + 0.3);
    }
  }

  blip(freq, dur, type = 'sine', gain = 0.2) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  pickup() { this.blip(880, 0.16, 'triangle', 0.18); }

  fuseInsert(x, y) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.3, 0.7);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 1.6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.38, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    n.connect(bp).connect(g);
    this.route(g, 1, x, y, { wet: 0.7, ref: 7 });
    this.blip(320, 0.2, 'square', 0.1);
  }

  powerUp() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [f, at] of [[110, 0], [165, 0.12], [220, 0.24], [330, 0.38]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1200;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.linearRampToValueAtTime(0.16, t + at + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 1.2);
      o.connect(lp).connect(g).connect(this.master);
      o.start(t + at); o.stop(t + at + 1.3);
    }
  }

  hit() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.5, 0.4);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    n.connect(lp).connect(g).connect(this.master);

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.4, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 0.4);
  }

  revived() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [f, at] of [[392, 0], [523, 0.1], [659, 0.2]]) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.linearRampToValueAtTime(0.14, t + at + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.5);
      o.connect(g).connect(this.master);
      o.start(t + at); o.stop(t + at + 0.6);
    }
  }

  // The button, and the door it drives.
  buttonPress(x, y, dead = false) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.09, 1.6);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = dead ? 1500 : 2600;
    bp.Q.value = 2.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(dead ? 0.2 : 0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    n.connect(bp).connect(g);
    this.route(g, 1, x, y, { wet: 0.3, ref: 3 });
    if (!dead) this.blip(180, 0.06, 'square', 0.14);
  }

  // Relay, lock bolts, motor, rattling steel, and the clunk at the top - laid
  // out in one go so it stays in step with the shutter the server is driving.
  doorSequence(x, y, seconds) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    for (const at of [0.05, 0.3]) {
      const n = this.noiseSource(0.3, 0.45);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 260; bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0 + at);
      g.gain.linearRampToValueAtTime(0.4, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.28);
      n.connect(bp).connect(g);
      this.route(g, 1, x, y, { wet: 0.75, ref: 6 });
    }

    const start = 0.5;
    const run = Math.max(0.5, seconds - start - 0.25);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t0 + start);
    out.gain.linearRampToValueAtTime(0.3, t0 + start + 0.3);
    out.gain.setValueAtTime(0.3, t0 + start + run - 0.2);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + start + run);
    this.route(out, 1, x, y, { wet: 0.5, ref: 7, rolloff: 0.9 });

    for (const [type, freq, gain] of [['sawtooth', 48, 0.5], ['square', 96, 0.16], ['sawtooth', 143, 0.09]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq * 0.82, t0 + start);
      o.frequency.linearRampToValueAtTime(freq, t0 + start + 0.4);
      o.frequency.linearRampToValueAtTime(freq * 0.95, t0 + start + run);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 620;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(lp).connect(g).connect(out);
      o.start(t0 + start);
      o.stop(t0 + start + run + 0.1);
    }

    for (let at = start + 0.25; at < start + run; at += 0.3) {
      const n = this.noiseSource(0.1, 1.4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2200 + Math.random() * 900; bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0 + at);
      g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, t0 + at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.09);
      n.connect(bp).connect(g);
      this.route(g, 1, x, y, { wet: 0.6, ref: 7 });
    }

    const end = t0 + seconds - 0.1;
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, end);
    thump.frequency.exponentialRampToValueAtTime(42, end + 0.3);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.001, end);
    tg.gain.linearRampToValueAtTime(0.5, end + 0.01);
    tg.gain.exponentialRampToValueAtTime(0.0001, end + 0.55);
    thump.connect(tg);
    this.route(tg, 1, x, y, { wet: 0.8, ref: 8 });
    thump.start(end); thump.stop(end + 0.6);
  }

  // --- Continuous layers ---------------------------------------------------------

  // Room tone: a sub rumble, a filtered hiss, and two oscillators beating
  // against each other so it never quite settles.
  startAmbient() {
    if (!this.ready || this.loops.has('ambient')) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + 3);
    out.connect(this.master);
    const nodes = [out];

    for (const f of [38, 41.5]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.1;
      o.connect(g).connect(out);
      o.start(t);
      nodes.push(o);
    }

    const air = this.noiseSource(1, 0.06);
    air.loop = true;
    air.stop(t + 3600);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.7;
    const ag = ctx.createGain();
    ag.gain.value = 0.09;
    air.connect(lp).connect(ag).connect(out);
    nodes.push(air);

    // The dread layer, brought in and out by setTension.
    const dread = ctx.createGain();
    dread.gain.value = 0.0001;
    dread.connect(this.master);
    for (const f of [58, 87, 116.5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass'; lp2.frequency.value = 400;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      o.connect(lp2).connect(g).connect(dread);
      o.start(t);
      nodes.push(o);
    }
    this.dread = dread;
    this.loops.set('ambient', { nodes, out });
  }

  setTension(value) {
    this.tension = clamp(value, 0, 1);
    if (!this.ready || !this.dread) return;
    this.dread.gain.setTargetAtTime(0.0001 + this.tension * 0.5, this.ctx.currentTime, 0.5);
  }

  // The generator, once it is running: a hum that gets louder as you approach.
  generatorHum(x, y, level) {
    if (!this.ready) return;
    if (level <= 0) { this.stopLoop('generator'); return; }
    let loop = this.loops.get('generator');
    if (!loop) {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const out = ctx.createGain();
      out.gain.value = 0.0001;
      out.connect(this.master);
      const nodes = [out];
      for (const [f, g0] of [[50, 0.25], [100, 0.12], [151, 0.06]]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 500;
        const g = ctx.createGain();
        g.gain.value = g0;
        o.connect(lp).connect(g).connect(out);
        o.start(t);
        nodes.push(o);
      }
      loop = { nodes, out };
      this.loops.set('generator', loop);
    }
    const d = Math.hypot(x - this.listener.x, y - this.listener.y);
    const near = clamp(1 - d / 22, 0, 1);
    loop.out.gain.setTargetAtTime(0.0001 + near * near * 0.4 * level, this.ctx.currentTime, 0.2);
  }

  stopLoop(name) {
    const loop = this.loops.get(name);
    if (!loop) return;
    loop.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    setTimeout(() => {
      for (const n of loop.nodes) { try { n.stop && n.stop(); n.disconnect(); } catch { /* gone */ } }
    }, 1200);
    this.loops.delete(name);
  }

  stopAll() {
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
  }
}
