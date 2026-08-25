// Procedural audio.
//
// There are no sound files. Every footstep, growl and door slam is synthesised
// from oscillators and noise buffers, fed through a generated impulse-response
// reverb so the whole facility sounds like the same concrete box. Positional
// sources use HRTF panning, which is what makes "it is behind you" legible.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.volume = 0.8;
    this.loops = new Map();
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

    // A gentle limiter keeps a scream from clipping over the ambient bed.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;

    this.master.connect(this.comp).connect(ctx.destination);

    // Reverb bus - one shared concrete room.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulse(2.6, 2.4);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.5;
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

  // Exponentially decaying noise makes a serviceable large-room impulse.
  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Slight per-channel decorrelation widens the stereo image.
        const jitter = ch === 0 ? 1 : 0.94;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay * jitter);
      }
    }
    return buf;
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // --- Spatialisation -------------------------------------------------------

  panner(x, z, opts = {}) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'exponential';
    p.refDistance = opts.ref ?? 3;
    p.rolloffFactor = opts.rolloff ?? 1.4;
    p.maxDistance = opts.max ?? 70;
    p.positionX.value = x;
    p.positionY.value = opts.y ?? 1.2;
    p.positionZ.value = z;
    return p;
  }

  // Keep the WebAudio listener glued to the camera each frame.
  updateListener(camera) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const fwd = camera.getWorldDirection(this._fwd || (this._fwd = new (camera.position.constructor)()));
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02);
      l.positionY.setTargetAtTime(p.y, t, 0.02);
      l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  // Route a source: dry to master, a share to the reverb bus.
  route(node, gain, x, z, opts = {}) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    node.connect(g);
    if (x === undefined) {
      g.connect(this.master);
      const send = this.ctx.createGain();
      send.gain.value = opts.wet ?? 0.25;
      g.connect(send).connect(this.convolver);
    } else {
      const pan = this.panner(x, z, opts);
      g.connect(pan).connect(this.master);
      const send = this.ctx.createGain();
      send.gain.value = opts.wet ?? 0.4;
      pan.connect(send).connect(this.convolver);
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

  // --- One-shots ------------------------------------------------------------

  // Boot heel on wet concrete: a short filtered noise burst with a body thump.
  footstep(x, z, { sprint = false, crouch = false, own = false } = {}) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 0.16;
    const src = this.noiseSource(dur, 0.8 + Math.random() * 0.4);

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = crouch ? 620 : sprint ? 1500 : 1050;
    bp.Q.value = 1.1;
    src.connect(bp);

    const env = this.ctx.createGain();
    const peak = (crouch ? 0.1 : sprint ? 0.42 : 0.26) * (own ? 0.55 : 1);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    bp.connect(env);

    this.route(env, 1, own ? undefined : x, z, { wet: own ? 0.16 : 0.4, ref: 2 });

    // Low thump for weight
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(56, t + 0.1);
    const oenv = this.ctx.createGain();
    oenv.gain.setValueAtTime(peak * 0.5, t);
    oenv.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(oenv);
    this.route(oenv, 1, own ? undefined : x, z, { wet: 0.2 });
    osc.start(t); osc.stop(t + 0.14);
  }

  // Low, wet, animal. Two detuned saws through a moving lowpass.
  growl(x, z, intensity = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 1.1 + Math.random() * 0.6;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.34 * intensity, t + 0.18);
    out.gain.setValueAtTime(0.3 * intensity, t + dur * 0.6);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(360, t);
    lp.frequency.linearRampToValueAtTime(180, t + dur);
    lp.Q.value = 4;

    for (const detune of [0, 7, -11]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 48 + Math.random() * 10;
      o.detune.value = detune;
      // Ragged breathing modulation
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 5.5 + Math.random() * 3;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 9;
      lfo.connect(lfoGain).connect(o.frequency);
      lfo.start(t); lfo.stop(t + dur);
      o.connect(lp);
      o.start(t); o.stop(t + dur);
    }
    lp.connect(out);
    this.route(out, 1, x, z, { wet: 0.55, ref: 5, rolloff: 1.1 });
  }

  // The chase cue. Should be genuinely unpleasant.
  scream(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 1.5;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const dist = this.ctx.createWaveShaper();
    dist.curve = makeDistortion(28);

    for (let i = 0; i < 3; i++) {
      const o = this.ctx.createOscillator();
      o.type = i === 2 ? 'square' : 'sawtooth';
      const base = 420 + i * 190 + Math.random() * 60;
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 2.1, t + 0.22);
      o.frequency.exponentialRampToValueAtTime(base * 0.55, t + dur);
      o.connect(dist);
      o.start(t); o.stop(t + dur);
    }
    // Breath layer
    const n = this.noiseSource(dur, 1.4);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900;
    const nEnv = this.ctx.createGain();
    nEnv.gain.setValueAtTime(0.22, t);
    nEnv.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp).connect(nEnv).connect(out);

    dist.connect(out);
    this.route(out, 1, x, z, { wet: 0.65, ref: 8, rolloff: 0.9 });
  }

  // Metal on metal, somewhere off in the dark.
  clang(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0.3, t);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    // Inharmonic partials are what make it read as metal rather than a note.
    for (const ratio of [1, 1.71, 2.43, 3.17, 4.61]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 220 * ratio * (0.9 + Math.random() * 0.2);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3 / ratio, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4 / ratio);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 1.6);
    }
    this.route(out, 1, x, z, { wet: 0.8, ref: 6, rolloff: 1.1 });
  }

  drip(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(900 + Math.random() * 500, t);
    o.frequency.exponentialRampToValueAtTime(260, t + 0.09);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g);
    this.route(g, 1, x, z, { wet: 0.85, ref: 4 });
    o.start(t); o.stop(t + 0.25);
  }

  whisper(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 1.9;
    const n = this.noiseSource(dur, 0.7);
    // Two sweeping formants approximate a voice without saying anything.
    const f1 = this.ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.Q.value = 9;
    f1.frequency.setValueAtTime(520, t);
    f1.frequency.linearRampToValueAtTime(880, t + dur * 0.6);
    f1.frequency.linearRampToValueAtTime(400, t + dur);
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.Q.value = 12;
    f2.frequency.setValueAtTime(1500, t);
    f2.frequency.linearRampToValueAtTime(2300, t + dur);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(f1).connect(g);
    n.connect(f2).connect(g);
    this.route(g, 1, x, z, { wet: 0.7, ref: 3, rolloff: 2.2 });
  }

  scrape(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 0.9;
    const n = this.noiseSource(dur, 0.35);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 6;
    bp.frequency.setValueAtTime(1800, t);
    bp.frequency.linearRampToValueAtTime(520, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp).connect(g);
    this.route(g, 1, x, z, { wet: 0.6, ref: 5 });
  }

  breath(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 1.4;
    const n = this.noiseSource(dur, 0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2, t + 0.5);
    g.gain.linearRampToValueAtTime(0.0, t + dur);
    n.connect(lp).connect(g);
    this.route(g, 1, x, z, { wet: 0.5, ref: 3, rolloff: 2 });
  }

  // Heartbeat: two thumps, faster and louder as fear rises.
  heartbeat(intensity = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [offset, amp] of [[0, 1], [0.19, 0.62]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(72, t + offset);
      o.frequency.exponentialRampToValueAtTime(38, t + offset + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + offset);
      g.gain.linearRampToValueAtTime(0.4 * amp * intensity, t + offset + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.24);
      o.connect(g);
      this.route(g, 1, undefined, undefined, { wet: 0.05 });
      o.start(t + offset); o.stop(t + offset + 0.26);
    }
  }

  pickup() { this.blip(880, 0.16, 'triangle', 0.18); }
  radioBlip() { this.blip(1400, 0.06, 'square', 0.07); }

  blip(freq, dur, type = 'sine', gain = 0.2) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.route(g, 1, undefined, undefined, { wet: 0.2 });
    o.start(t); o.stop(t + dur + 0.02);
  }

  // Fuse slamming into the breaker: clunk, then the coils take the load.
  fuseInsert(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.clang(x, z);
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(60, t + 0.1);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.6);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t + 0.1);
    g.gain.linearRampToValueAtTime(0.22, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g);
    this.route(g, 1, x, z, { wet: 0.5 });
    o.start(t + 0.1); o.stop(t + 0.95);
  }

  // Everything comes on at once. Should feel like relief and a mistake.
  powerUp() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(40, t);
    o.frequency.exponentialRampToValueAtTime(420, t + 1.6);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(5200, t + 1.6);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    o.connect(lp).connect(g);
    this.route(g, 1, undefined, undefined, { wet: 0.6 });
    o.start(t); o.stop(t + 2.5);
  }

  // Being downed: impact, then the room drops away.
  hit() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.5, 0.6);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    n.connect(lp).connect(g);
    this.route(g, 1, undefined, undefined, { wet: 0.5 });

    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.7);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(og);
    this.route(og, 1, undefined, undefined, { wet: 0.3 });
    o.start(t); o.stop(t + 0.85);
  }

  revived() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [i, f] of [220, 330, 440].entries()) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.18, t + i * 0.09 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.5);
      o.connect(g);
      this.route(g, 1, undefined, undefined, { wet: 0.4 });
      o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.55);
    }
  }

  doorOpen(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(2.4, 0.25);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34, t + 0.4);
    g.gain.setValueAtTime(0.3, t + 1.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    n.connect(lp).connect(g);
    this.route(g, 1, x, z, { wet: 0.7, ref: 10, rolloff: 0.8 });
  }

  // The generator tearing itself apart.
  explosion(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;

    // Body: a long noise burst swept from bright to sub.
    const n = this.noiseSource(3.2, 0.7);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(6000, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 2.4);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.9, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 3);
    n.connect(lp).connect(env);
    this.route(env, 1, x, z, { wet: 0.85, ref: 14, rolloff: 0.6 });

    // Punch underneath it.
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 1.2);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.85, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(og);
    this.route(og, 1, undefined, undefined, { wet: 0.5 });
    o.start(t); o.stop(t + 1.7);

    // Debris raining down afterwards.
    for (let i = 0; i < 7; i++) {
      const delay = 0.3 + Math.random() * 1.9;
      setTimeout(() => this.clang(x + (Math.random() - 0.5) * 6, z + (Math.random() - 0.5) * 6), delay * 1000);
    }
  }

  // An electrical arc while the generator labours.
  sparkArc(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const dur = 0.16 + Math.random() * 0.14;
    const n = this.noiseSource(dur, 1.6);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + Math.random() * 2200;
    bp.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp).connect(g);
    this.route(g, 1, x, z, { wet: 0.5, ref: 5 });
  }

  // The generator struggling before it goes: pitch dragging, load rising.
  generatorStrain(x, z, seconds) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(52, t);
    o.frequency.linearRampToValueAtTime(96, t + seconds * 0.7);
    o.frequency.linearRampToValueAtTime(38, t + seconds);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 1);
    g.gain.setValueAtTime(0.34, t + seconds - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.connect(lp).connect(g);
    this.route(g, 1, x, z, { wet: 0.55, ref: 6 });
    o.start(t); o.stop(t + seconds + 0.1);
  }

  // Bolts withdrawing, then the leaf lifting.
  doorUnlock(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const [delay, freq] of [[0, 180], [0.22, 150]]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(freq, t + delay);
      o.frequency.exponentialRampToValueAtTime(freq * 0.4, t + delay + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3, t + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.2);
      o.connect(g);
      this.route(g, 1, x, z, { wet: 0.6, ref: 6 });
      o.start(t + delay); o.stop(t + delay + 0.25);
    }
    setTimeout(() => this.doorOpen(x, z), 420);
  }

  // A continuous fire bed, scaled by how far the blaze has spread. One looping
  // noise source, not a sound per flame.
  fireBed(level) {
    if (!this.ready) return;
    let loop = this.loops.get('fire');
    if (!loop) {
      const t = this.ctx.currentTime;
      const out = this.ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);

      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.7;
      // Slow wobble so the roar breathes instead of hissing flatly.
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.35;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 320;
      lfo.connect(lfoGain).connect(lp.frequency);
      src.connect(lp).connect(out);
      src.start(t); lfo.start(t);

      const send = this.ctx.createGain();
      send.gain.value = 0.4;
      out.connect(send).connect(this.convolver);

      loop = { nodes: [out, src, lfo], out };
      this.loops.set('fire', loop);
    }
    loop.out.gain.setTargetAtTime(clamp(level, 0, 1) * 0.45, this.ctx.currentTime, 0.8);
  }

  // Original ending music, written here rather than sampled: a slow A minor
  // lament. Sustained low strings, a descending four-note figure, no
  // percussion and no resolution - survival, not victory.
  startEndingMusic() {
    if (!this.ready || this.loops.has('ending')) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.2;

    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.gain.exponentialRampToValueAtTime(0.5, t0 + 3);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.75;         // drenched in the room's reverb
    out.connect(send).connect(this.convolver);

    const nodes = [out];

    // Drone on the tonic, two octaves down.
    for (const f of [55, 55.3]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.16;
      o.connect(g).connect(out);
      o.start(t0);
      nodes.push(o);
    }

    // Am pad, entering slowly.
    const pad = ctx.createBiquadFilter();
    pad.type = 'lowpass';
    pad.frequency.setValueAtTime(400, t0);
    pad.frequency.linearRampToValueAtTime(1400, t0 + 16);
    pad.connect(out);
    for (const f of [220, 261.63, 329.63]) {    // A3 C4 E4
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 6);
      o.connect(g).connect(pad);
      o.start(t0);
      nodes.push(o);
    }

    // The figure: A - G - F - E, falling, then repeated a fifth below.
    const melody = [
      [440.00, 0], [392.00, 3.5], [349.23, 7], [329.63, 10.5],
      [293.66, 15], [261.63, 18.5], [246.94, 22], [220.00, 25.5],
      [329.63, 31], [293.66, 34.5], [261.63, 38], [220.00, 41.5],
    ];
    for (const [freq, at] of melody) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      const g = ctx.createGain();
      const start = t0 + at;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.13, start + 0.7);   // slow bow
      g.gain.exponentialRampToValueAtTime(0.0001, start + 3.4);
      o.connect(g).connect(out);
      o.start(start); o.stop(start + 3.6);
      nodes.push(o);
    }

    this.loops.set('ending', { nodes, out });
  }

  // --- The emergency door -----------------------------------------------------

  // The button. A hard mechanical snap with a little spring under it.
  buttonPress(x, z, dead = false) {
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
    this.route(g, 1, x, z, { wet: 0.3, ref: 3 });

    // A dead panel gives you the click and nothing else.
    if (dead) return;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.05);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.14, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(og);
    this.route(og, 1, x, z, { wet: 0.25, ref: 3 });
    o.start(t); o.stop(t + 0.08);
  }

  // The whole opening sequence, laid out in one go so the layers stay in step
  // with the shutter the server is driving: contactor, lock bolts, motor,
  // rattling steel, and the clunk when it tops out.
  doorSequence(x, z, seconds) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    // A relay closing somewhere in the wall.
    for (const [at, freq] of [[0.06, 320], [0.14, 240]]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0 + at);
      g.gain.linearRampToValueAtTime(0.13, t0 + at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.07);
      o.connect(g);
      this.route(g, 1, x, z, { wet: 0.5, ref: 5 });
      o.start(t0 + at); o.stop(t0 + at + 0.09);
    }

    // Lock bolts withdrawing: two heavy metal knocks.
    for (const at of [0.35, 0.62]) {
      const n = this.noiseSource(0.3, 0.45);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 260; bp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0 + at);
      g.gain.linearRampToValueAtTime(0.42, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.28);
      n.connect(bp).connect(g);
      this.route(g, 1, x, z, { wet: 0.75, ref: 6 });
    }

    // The motor: a loaded hum that starts, labours, and cuts out at the top.
    const motorStart = 0.75;
    const motorRun = Math.max(0.5, seconds - motorStart - 0.3);
    const motorOut = ctx.createGain();
    motorOut.gain.setValueAtTime(0.0001, t0 + motorStart);
    motorOut.gain.linearRampToValueAtTime(0.3, t0 + motorStart + 0.35);
    motorOut.gain.setValueAtTime(0.3, t0 + motorStart + motorRun - 0.25);
    motorOut.gain.exponentialRampToValueAtTime(0.0001, t0 + motorStart + motorRun);
    this.route(motorOut, 1, x, z, { wet: 0.5, ref: 7, rolloff: 0.9 });

    for (const [type, freq, gain] of [['sawtooth', 48, 0.5], ['square', 96, 0.16], ['sawtooth', 143, 0.09]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq * 0.82, t0 + motorStart);
      o.frequency.linearRampToValueAtTime(freq, t0 + motorStart + 0.5);
      // It drags a little under load, the way a real one does.
      o.frequency.linearRampToValueAtTime(freq * 0.95, t0 + motorStart + motorRun);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 620;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(lp).connect(g).connect(motorOut);
      o.start(t0 + motorStart);
      o.stop(t0 + motorStart + motorRun + 0.1);
    }

    // Steel slats clattering through the guides for as long as it is moving.
    const rattle = this.noiseSource(motorRun + 0.2, 0.9);
    const rbp = ctx.createBiquadFilter();
    rbp.type = 'bandpass'; rbp.frequency.value = 1700; rbp.Q.value = 0.8;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t0 + motorStart);
    rg.gain.linearRampToValueAtTime(0.1, t0 + motorStart + 0.4);
    rg.gain.setValueAtTime(0.1, t0 + motorStart + motorRun - 0.2);
    rg.gain.exponentialRampToValueAtTime(0.0001, t0 + motorStart + motorRun);
    rattle.connect(rbp).connect(rg);
    this.route(rg, 1, x, z, { wet: 0.65, ref: 7 });

    // Individual slats knocking as they come off the drum.
    for (let at = motorStart + 0.3; at < motorStart + motorRun; at += 0.34) {
      const n = this.noiseSource(0.1, 1.4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2200 + Math.random() * 900; bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.001, t0 + at);
      g.gain.linearRampToValueAtTime(0.06 + Math.random() * 0.04, t0 + at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.09);
      n.connect(bp).connect(g);
      this.route(g, 1, x, z, { wet: 0.6, ref: 7 });
    }

    // And the clunk when it reaches the top and the drum stops dead.
    const end = t0 + seconds - 0.12;
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, end);
    thump.frequency.exponentialRampToValueAtTime(42, end + 0.3);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.001, end);
    tg.gain.linearRampToValueAtTime(0.5, end + 0.01);
    tg.gain.exponentialRampToValueAtTime(0.0001, end + 0.55);
    thump.connect(tg);
    this.route(tg, 1, x, z, { wet: 0.8, ref: 8 });
    thump.start(end); thump.stop(end + 0.6);

    const crash = this.noiseSource(0.5, 0.6);
    const cbp = ctx.createBiquadFilter();
    cbp.type = 'bandpass'; cbp.frequency.value = 900; cbp.Q.value = 0.7;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.001, end);
    cg.gain.linearRampToValueAtTime(0.3, end + 0.008);
    cg.gain.exponentialRampToValueAtTime(0.0001, end + 0.45);
    crash.connect(cbp).connect(cg);
    this.route(cg, 1, x, z, { wet: 0.8, ref: 8 });
  }

  // --- The rifle ---------------------------------------------------------------

  // A shot is four layers: the mechanical crack of the action, the muzzle blast,
  // the supersonic snap, and the tail slapping back off the concrete. Every one
  // is jittered per shot, so a magazine never sounds like one sample repeated.
  gunshot(x, z, own = false) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = 0.88 + Math.random() * 0.24;          // per-shot variation
    const level = own ? 1 : 0.85;

    // Blast: a hard noise burst swept down.
    const blast = this.noiseSource(0.4, 0.8 + Math.random() * 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(7000 * v, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.22);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.9 * level * v, t);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    blast.connect(lp).connect(bg);
    this.route(bg, 1, x, z, { wet: 0.55, ref: 12, rolloff: 0.7 });

    // Body: a fast pitch drop that gives the shot its weight.
    const body = ctx.createOscillator();
    body.type = 'sawtooth';
    body.frequency.setValueAtTime(220 * v, t);
    body.frequency.exponentialRampToValueAtTime(48, t + 0.13);
    const dist = ctx.createWaveShaper();
    dist.curve = makeDistortion(24);
    const yg = ctx.createGain();
    yg.gain.setValueAtTime(0.42 * level, t);
    yg.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    body.connect(dist).connect(yg);
    this.route(yg, 1, x, z, { wet: 0.4, ref: 12, rolloff: 0.7 });
    body.start(t); body.stop(t + 0.2);

    // Crack: the very short, very bright transient on top.
    const crack = this.noiseSource(0.06, 2.6);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 3400;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.5 * level * v, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    crack.connect(hp).connect(cg);
    this.route(cg, 1, x, z, { wet: 0.3, ref: 12 });

    // Action: bolt cycling, a beat behind the shot.
    const mech = this.noiseSource(0.12, 1.9);
    const mbp = ctx.createBiquadFilter();
    mbp.type = 'bandpass'; mbp.frequency.value = 2400 + Math.random() * 700; mbp.Q.value = 2.2;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(0.001, t + 0.03);
    mg.gain.linearRampToValueAtTime(0.14 * level, t + 0.038);
    mg.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    mech.connect(mbp).connect(mg);
    this.route(mg, 1, x, z, { wet: 0.35, ref: 8 });

    // Tail: the building answering back.
    const tail = this.noiseSource(0.9, 0.35);
    const tbp = ctx.createBiquadFilter();
    tbp.type = 'bandpass'; tbp.frequency.value = 520; tbp.Q.value = 0.5;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.001, t + 0.02);
    tg.gain.linearRampToValueAtTime(0.16 * level, t + 0.07);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    tail.connect(tbp).connect(tg);
    this.route(tg, 1, x, z, { wet: 0.95, ref: 20, rolloff: 0.5 });
  }

  // Hammer falling on an empty chamber.
  dryFire(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.07, 2.2);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 3100; bp.Q.value = 3.5;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(bp).connect(g);
    this.route(g, 1, x, z, { wet: 0.25, ref: 4 });
  }

  // The reload, matched beat for beat to what the hands are doing on screen.
  gunReload(x, z, seconds) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime;
    const beats = [
      [0.08, 1800, 0.22, 0.09],    // magazine catch released
      [0.45, 900, 0.26, 0.16],     // magazine clear of the well
      [1.25, 1400, 0.3, 0.12],     // fresh magazine offered up
      [1.55, 700, 0.42, 0.18],     // rocked home
      [1.85, 2600, 0.3, 0.1],      // charging handle back
      [2.05, 1200, 0.44, 0.14],    // and released
    ];
    for (const [at, freq, gain, dur] of beats) {
      if (at > seconds) continue;
      const n = this.noiseSource(dur + 0.05, 1.2);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq * (0.94 + Math.random() * 0.12);
      bp.Q.value = 2.6;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.001, t0 + at);
      g.gain.linearRampToValueAtTime(gain, t0 + at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      n.connect(bp).connect(g);
      this.route(g, 1, x, z, { wet: 0.3, ref: 5 });
    }
  }

  // A round finding something soft.
  fleshHit(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.22, 0.5);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    n.connect(lp).connect(g);
    this.route(g, 1, x, z, { wet: 0.4, ref: 8 });
  }

  // And a round finding concrete.
  ricochet(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.16, 1.8);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2600 + Math.random() * 1800, t);
    bp.frequency.exponentialRampToValueAtTime(700, t + 0.14);
    bp.Q.value = 6;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    n.connect(bp).connect(g);
    this.route(g, 1, x, z, { wet: 0.5, ref: 10 });
  }

  // --- Continuous layers ----------------------------------------------------

  // Room tone: sub rumble, a filtered hiss, and a slow beating between two
  // oscillators that never quite settles.
  startAmbient() {
    if (!this.ready || this.loops.has('ambient')) return;
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.34, t + 4);
    out.connect(this.master);

    const nodes = [out];
    for (const f of [37, 55.3]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.value = 0.16;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.05 + Math.random() * 0.06;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 0.09;
      lfo.connect(lfoGain).connect(g.gain);
      o.connect(g).connect(out);
      o.start(t); lfo.start(t);
      nodes.push(o, lfo);
    }

    const hiss = this.ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer;
    hiss.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'bandpass'; hp.frequency.value = 420; hp.Q.value = 0.6;
    const hg = this.ctx.createGain();
    hg.gain.value = 0.035;
    hiss.connect(hp).connect(hg).connect(out);
    hiss.start(t);
    nodes.push(hiss);

    this.loops.set('ambient', { nodes, out });
  }

  // Dread layer driven by how close the monster is to catching someone.
  setTension(value) {
    if (!this.ready) return;
    this.tension = clamp(value, 0, 1);
    let loop = this.loops.get('tension');
    if (!loop) {
      const t = this.ctx.currentTime;
      const out = this.ctx.createGain();
      out.gain.value = 0;
      out.connect(this.master);
      const nodes = [out];
      // A tritone drone: unstable on purpose.
      for (const f of [58, 82, 116.5]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        const g = this.ctx.createGain();
        g.gain.value = 0.09;
        o.connect(g).connect(out);
        o.start(t);
        nodes.push(o);
      }
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      loop = { nodes, out, lp };
      this.loops.set('tension', loop);
    }
    const t = this.ctx.currentTime;
    loop.out.gain.setTargetAtTime(this.tension * 0.3, t, 0.35);
  }

  // The generator, once it is running, is an audible landmark.
  generatorHum(x, z, level) {
    if (!this.ready) return;
    let loop = this.loops.get('generator');
    if (!loop) {
      const t = this.ctx.currentTime;
      const out = this.ctx.createGain();
      out.gain.value = 0;
      const pan = this.panner(x, z, { ref: 4, rolloff: 1.5, max: 45, y: 1 });
      out.connect(pan).connect(this.master);
      const send = this.ctx.createGain();
      send.gain.value = 0.4;
      pan.connect(send).connect(this.convolver);

      const nodes = [out];
      for (const f of [50, 100, 151]) {
        const o = this.ctx.createOscillator();
        o.type = f === 50 ? 'sawtooth' : 'sine';
        o.frequency.value = f;
        const g = this.ctx.createGain();
        g.gain.value = f === 50 ? 0.1 : 0.05;
        o.connect(g).connect(out);
        o.start(t);
        nodes.push(o);
      }
      loop = { nodes, out, pan };
      this.loops.set('generator', loop);
    }
    loop.pan.positionX.value = x;
    loop.pan.positionZ.value = z;
    loop.out.gain.setTargetAtTime(clamp(level, 0, 1) * 0.5, this.ctx.currentTime, 0.6);
  }

  // --- The Backrooms ----------------------------------------------------------

  // The bed here is almost nothing: mains hum off the fluorescents, a distant
  // air handler, and long stretches with neither. The silence is the point, so
  // the sparse layers are scheduled minutes apart rather than seconded out.
  startBackroomsAmbient() {
    if (!this.ready || this.loops.has('backrooms')) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.5, t + 3.5);
    out.connect(this.master);
    const nodes = [out];

    // Mains hum and its harmonics: the sound of a room full of tubes.
    for (const [freq, gain, type] of [[60, 0.055, 'sine'], [120, 0.038, 'sine'], [180, 0.016, 'triangle'], [240, 0.008, 'sine']]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      // A slow drift so it never sits perfectly still.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07 + Math.random() * 0.06;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = gain * 0.35;
      lfo.connect(lfoGain);
      const g = ctx.createGain();
      g.gain.value = gain;
      lfoGain.connect(g.gain);
      o.connect(g).connect(out);
      o.start(t); lfo.start(t);
      nodes.push(o, lfo);
    }

    // Air handling, three rooms away.
    const air = this.noiseSource(1, 0.05);
    air.loop = true;
    air.stop(t + 3600);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 190; lp.Q.value = 0.6;
    const ag = ctx.createGain();
    ag.gain.value = 0.13;
    air.connect(lp).connect(ag).connect(out);
    nodes.push(air);

    this.loops.set('backrooms', { nodes, out });
    this.backroomsNext = 14 + Math.random() * 26;
  }

  // Called once a frame while a player is through the door. Long gaps, then one
  // small thing far away, then nothing again.
  updateBackrooms(dt) {
    if (!this.ready || !this.loops.has('backrooms')) return;
    this.backroomsNext -= dt;
    if (this.backroomsNext > 0) return;
    this.backroomsNext = 20 + Math.random() * 45;
    const pick = Math.random();
    if (pick < 0.34) this.tubeTick();
    else if (pick < 0.62) this.distantThud();
    else if (pick < 0.85) this.ventShift();
    // The rest of the time: nothing at all.
  }

  // A failing ballast ticking somewhere out of sight.
  tubeTick() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const count = 3 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const at = t0 + i * (0.08 + Math.random() * 0.12);
      const n = this.noiseSource(0.05, 2.4);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 4200 + Math.random() * 2000; bp.Q.value = 8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
      n.connect(bp).connect(g);
      this.route(g, 1, undefined, undefined, { wet: 0.55 });
    }
  }

  // Something heavy, a very long way off, in a direction you cannot place.
  distantThud() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(58, t);
    o.frequency.exponentialRampToValueAtTime(31, t + 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    o.connect(g);
    this.route(g, 1, undefined, undefined, { wet: 0.95 });
    o.start(t); o.stop(t + 1.4);
  }

  // The air handler changing note, then settling.
  ventShift() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = this.noiseSource(4.5, 0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(150, t);
    bp.frequency.linearRampToValueAtTime(320, t + 1.8);
    bp.frequency.linearRampToValueAtTime(140, t + 4.4);
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.11, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.4);
    n.connect(bp).connect(g);
    this.route(g, 1, undefined, undefined, { wet: 0.8 });
  }

  // Climbing the ladder: hands and boots on steel rungs, one at a time.
  ladderRung(x, z) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const n = this.noiseSource(0.2, 1.1);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100 + Math.random() * 900;
    bp.Q.value = 3.2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(bp).connect(g);
    this.route(g, 1, x, z, { wet: 0.5, ref: 4 });
  }

  // The way out. Deliberately not the same music as the fire: this one resolves.
  startFinalMusic() {
    if (!this.ready || this.loops.has('final')) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.3;

    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.gain.exponentialRampToValueAtTime(0.55, t0 + 4);
    out.connect(this.master);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    out.connect(send).connect(this.convolver);
    const nodes = [out];

    // A D pedal underneath the whole thing.
    for (const f of [73.42, 73.6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.14;
      o.connect(g).connect(out);
      o.start(t0);
      nodes.push(o);
    }

    // Warm pad that opens up rather than closing in.
    const pad = ctx.createBiquadFilter();
    pad.type = 'lowpass';
    pad.frequency.setValueAtTime(300, t0);
    pad.frequency.linearRampToValueAtTime(2200, t0 + 20);
    pad.connect(out);
    for (const f of [146.83, 220.00, 293.66]) {      // D3 A3 D4
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.045, t0 + 7);
      o.connect(g).connect(pad);
      o.start(t0);
      nodes.push(o);
    }

    // A figure that climbs, where the fire ending's fell.
    const melody = [
      [293.66, 1], [349.23, 4], [440.00, 7], [493.88, 10],
      [587.33, 14], [493.88, 18], [440.00, 21.5], [587.33, 25],
      [659.25, 30], [587.33, 34], [440.00, 38],
    ];
    for (const [freq, at] of melody) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = ctx.createGain();
      const start = t0 + at;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.11, start + 0.9);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 3.8);
      o.connect(g).connect(out);
      o.start(start); o.stop(start + 4);
      nodes.push(o);
    }

    this.loops.set('final', { nodes, out });
  }

  stopLoop(name) {
    const loop = this.loops.get(name);
    if (!loop) return;
    const t = this.ctx.currentTime;
    loop.out.gain.setTargetAtTime(0, t, 0.3);
    setTimeout(() => {
      for (const n of loop.nodes) { try { n.stop && n.stop(); n.disconnect(); } catch { /* already stopped */ } }
    }, 1200);
    this.loops.delete(name);
  }

  stopAll() {
    for (const name of [...this.loops.keys()]) this.stopLoop(name);
  }
}

// Soft-clip curve for the scream, so it tears rather than simply gets louder.
function makeDistortion(amount) {
  const n = 512;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * Math.PI) / (Math.PI + amount * Math.abs(x)) / 20;
  }
  return curve;
}
