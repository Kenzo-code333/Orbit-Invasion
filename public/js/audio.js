/**
 * Orbit Wars client — tiny synthesized sound effects (Web Audio API, no files).
 * The AudioContext is created on the first user gesture (browser policy).
 */
(function () {
  'use strict';
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  try {
    muted = localStorage.getItem('ow_muted') === '1';
  } catch (e) {}
  const lastPlayed = {};

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    // One second of white noise, reused by noisy effects.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  /** Throttle so 20 simultaneous captures don't deafen anyone. */
  function allow(name, gapMs) {
    const now = performance.now();
    if (lastPlayed[name] && now - lastPlayed[name] < gapMs) return false;
    lastPlayed[name] = now;
    return true;
  }

  function tone(freq, dur, opts) {
    if (!ctx || muted) return;
    opts = opts || {};
    const t = ctx.currentTime + (opts.delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    const vol = opts.vol || 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function noise(dur, opts) {
    if (!ctx || muted) return;
    opts = opts || {};
    const t = ctx.currentTime + (opts.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.filter || 'lowpass';
    filter.frequency.setValueAtTime(opts.freq || 1200, t);
    if (opts.to) filter.frequency.exponentialRampToValueAtTime(opts.to, t + dur);
    const g = ctx.createGain();
    const vol = opts.vol || 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.03, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  const Sfx = {
    unlock: ensure,
    isMuted: () => muted,
    setMuted(v) {
      muted = !!v;
      try {
        localStorage.setItem('ow_muted', muted ? '1' : '0');
      } catch (e) {}
      if (master) master.gain.value = muted ? 0 : 0.5;
    },
    click() {
      tone(660, 0.06, { type: 'triangle', vol: 0.15 });
    },
    launch() {
      if (allow('launch', 40)) tone(420, 0.16, { type: 'triangle', to: 880, vol: 0.18 });
    },
    capture(mine) {
      if (!allow('capture', 90)) return;
      if (mine) {
        tone(523, 0.12, { type: 'triangle', vol: 0.2 });
        tone(784, 0.2, { type: 'triangle', vol: 0.2, delay: 0.08 });
      } else tone(330, 0.15, { type: 'sine', vol: 0.12 });
    },
    lost() {
      if (!allow('lost', 150)) return;
      tone(392, 0.15, { type: 'sawtooth', vol: 0.12 });
      tone(262, 0.3, { type: 'sawtooth', vol: 0.12, delay: 0.1 });
    },
    intercept() {
      if (allow('intercept', 60)) noise(0.12, { freq: 3000, to: 500, vol: 0.18, filter: 'bandpass' });
    },
    burn() {
      if (allow('burn', 80)) noise(0.3, { freq: 900, to: 200, vol: 0.15 });
    },
    flareTick(final) {
      tone(final ? 1046 : 880, 0.1, { type: 'square', vol: 0.08 });
    },
    flare() {
      noise(1.6, { freq: 2500, to: 120, vol: 0.45 });
      tone(110, 1.2, { type: 'sawtooth', to: 40, vol: 0.2 });
    },
    swallow() {
      if (allow('swallow', 300)) tone(90, 1.0, { type: 'sine', to: 30, vol: 0.35 });
    },
    eliminated() {
      tone(220, 0.5, { type: 'triangle', to: 110, vol: 0.2 });
    },
    win() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.2, delay: i * 0.12 }));
    },
    lose() {
      [392, 330, 262].forEach((f, i) => tone(f, 0.35, { type: 'sine', vol: 0.2, delay: i * 0.18 }));
    },
    countdown(go) {
      tone(go ? 880 : 440, go ? 0.35 : 0.12, { type: 'triangle', vol: 0.2 });
    },
  };

  window.Sfx = Sfx;
})();
