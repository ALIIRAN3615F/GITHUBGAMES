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
