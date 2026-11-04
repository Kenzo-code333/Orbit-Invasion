/**
 * Orbit Wars — shared constants and deterministic world math.
 *
 * This file is loaded by BOTH the Node server (require) and the browser
 * (plain <script>, exposes window.OW). Everything that decides "where is
 * thing X at time t" lives here so the server and clients agree exactly.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OW = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    // ---- Netcode ----
    TICK_RATE: 30,            // simulation ticks per second
    SNAPSHOT_EVERY: 2,        // broadcast a snapshot every N ticks (=15/sec)
    INTERP_DELAY: 0.1,        // client renders this many seconds in the past

    // ---- Match ----
    MATCH_DURATION: 600,      // hard limit, seconds (10 minutes)
    WIN_PLANET_FRACTION: 0.6, // control 60% of existing planets to win
    MIN_PLAYERS: 2,
    MAX_PLAYERS: 8,
    START_SHIPS: 40,
    NEUTRAL_MIN: 10,
    NEUTRAL_MAX: 30,
    LAUNCH_PCTS: [0.25, 0.5, 1],
    MAX_LAUNCHES_PER_SEC: 12, // server-side flood protection per player

    // ---- World geometry (world units, sun at 0,0) ----
    SUN_RADIUS: 60,
    MAP_RADIUS: 900,          // fleets further than this from the sun are lost
    VIEW_RADIUS: 800,         // the camera fits this radius on screen
    FLEET_SPEED: 110,         // units per second, constant
    FLEET_RADIUS: 7,          // collision radius of a fleet
    LAUNCH_GAP: 3,            // fleets spawn this far outside their planet
    REVEAL_DISTANCE: 200,     // enemy fleet sizes revealed within this distance of your planet's surface

    // ---- Sun events ----
    FLARE_INTERVAL: 120,      // a solar flare every 2 minutes
    FLARE_WARNING: 10,        // countdown shown this many seconds before
    SUN_EXPAND_START: 360,    // after 6 minutes the sun starts growing
    SUN_EXPAND_RATE: 1.9,     // units per second
    SUN_MAX_RADIUS: 300,

    // Orbital period of the outer ring. Other rings follow Kepler's third
    // law (period ∝ r^1.5), so inner rings orbit faster.
    OUTER_PERIOD: 240,

    RINGS: [
      { name: 'inner',  radius: 250, count: 6, size: 18, production: 1, cap: 50 },
      { name: 'middle', radius: 480, count: 8, size: 26, production: 2, cap: 100 },
      { name: 'outer',  radius: 740, count: 8, size: 34, production: 3, cap: 160 },
    ],

    // Player colours by slot. Chosen to be distinct on dark backgrounds.
    COLORS: ['#4cc9f0', '#ff4d6d', '#9ef01a', '#ffb703', '#c77dff', '#ff7b00', '#2ee6c5', '#ff8fd8'],
    NEUTRAL_COLOR: '#7d8597',

    DIFFICULTIES: ['easy', 'normal', 'hard'],

    // Fleet removal reasons (sent as small ints)
    REMOVE: { LAND: 1, SUN: 2, FLARE: 3, OUT: 4, INTERCEPT: 5 },
    // Planet owner sentinels
    NEUTRAL: -1,
    DESTROYED: -2,
  };

  C.DT = 1 / C.TICK_RATE;
  const outerR = C.RINGS[2].radius;
  for (const ring of C.RINGS) {
    ring.period = C.OUTER_PERIOD * Math.pow(ring.radius / outerR, 1.5);
    ring.omega = (2 * Math.PI) / ring.period; // rad/s, counter-clockwise
  }

  // ---------- Deterministic world functions ----------

  /** Position of a planet at time t. Planet needs {orbit, a0, w}. */
  function planetPos(p, t, out) {
    const a = p.a0 + p.w * t;
    out = out || { x: 0, y: 0 };
    out.x = Math.cos(a) * p.orbit;
    out.y = Math.sin(a) * p.orbit;
    return out;
  }

  /** Position of a fleet at time t. Fleet needs {x0,y0,dx,dy,t0}. */
  function fleetPos(f, t, out) {
    const d = C.FLEET_SPEED * Math.max(0, t - f.t0);
    out = out || { x: 0, y: 0 };
    out.x = f.x0 + f.dx * d;
    out.y = f.y0 + f.dy * d;
    return out;
  }

  /** Sun radius at time t (grows after SUN_EXPAND_START). */
  function sunRadius(t) {
    if (t <= C.SUN_EXPAND_START) return C.SUN_RADIUS;
    return Math.min(C.SUN_MAX_RADIUS, C.SUN_RADIUS + (t - C.SUN_EXPAND_START) * C.SUN_EXPAND_RATE);
  }

  /** Flare kill radius at time t: the inner ring area, or a bit past the grown sun. */
  function flareRadius(t) {
    return Math.max(C.RINGS[0].radius + 30, sunRadius(t) + 90);
  }

  /** Time of the next flare strictly after t (Infinity if after the match ends). */
  function nextFlareTime(t) {
    const n = Math.floor(t / C.FLARE_INTERVAL) + 1;
    const ft = n * C.FLARE_INTERVAL;
    return ft < C.MATCH_DURATION ? ft : Infinity;
  }

  /** Time when the expanding sun swallows a planet on an orbit of radius r. */
  function swallowTime(orbit) {
    if (orbit > C.SUN_MAX_RADIUS) return Infinity;
    return C.SUN_EXPAND_START + (orbit - C.SUN_RADIUS) / C.SUN_EXPAND_RATE;
  }

  /** Small deterministic PRNG (mulberry32) used for map setup and bot decisions. */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  C.planetPos = planetPos;
  C.fleetPos = fleetPos;
  C.sunRadius = sunRadius;
  C.flareRadius = flareRadius;
  C.nextFlareTime = nextFlareTime;
  C.swallowTime = swallowTime;
  C.makeRng = makeRng;
  return C;
});
