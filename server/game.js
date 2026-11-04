/**
 * Orbit Wars — authoritative match simulation.
 *
 * A Game owns the planets, fleets and players of one match and advances in
 * fixed ticks (C.TICK_RATE per second). It knows nothing about sockets:
 * the Room feeds it inputs (launch) and asks it for per-viewer snapshots.
 *
 * Determinism notes
 *  - Planet positions depend only on (ring, a0, time).
 *  - Fleet positions depend only on (x0, y0, angle, t0, time).
 *  - Launch parameters are quantised to exactly what is sent over the wire,
 *    so clients reproduce the same positions the server simulates.
 */
'use strict';

const C = require('../shared/constants');

const round = (v, f) => Math.round(v * f) / f;

class Game {
  /**
   * @param {Array<{id:number,name:string,color:string,human:boolean}>} players
   *        id is the lobby slot (0..7) and doubles as the owner id.
   * @param {number} seed  map-setup seed (the only randomness in a match)
   */
  constructor(players, seed) {
    this.seed = seed >>> 0;
    this.rng = C.makeRng(this.seed);
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      human: !!p.human,
      alive: true,
      lastSeq: 0,          // last launch sequence number processed (for client prediction)
      launchTimes: [],     // rate limiting
      stats: { captured: 0, destroyed: 0, launched: 0, peakPlanets: 0 },
    }));
    this.playerById = [];
    for (const p of this.players) this.playerById[p.id] = p;

    this.planets = this.generateMap();
    this.fleets = new Map();
    this.nextFleetId = 1;
    this.removed = new Map(); // fleetId -> {reason, t} for recently removed fleets
    this.tick = 0;
    this.time = 0;
    this.nextFlare = C.nextFlareTime(0);
    this.ended = false;
    this.result = null;
    this._pos = { x: 0, y: 0 };
  }

  // ------------------------------------------------------------------ setup

  generateMap() {
    const rng = this.rng;
    const planets = [];
    C.RINGS.forEach((ring, ri) => {
      const offset = rng() * Math.PI * 2;
      for (let i = 0; i < ring.count; i++) {
        planets.push({
          id: planets.length,
          ring: ri,
          orbit: ring.radius,
          a0: round(offset + (i * Math.PI * 2) / ring.count, 1e6),
          w: ring.omega,
          size: ring.size,
          prod: ring.production,
          cap: ring.cap,
          owner: C.NEUTRAL,
          ships: C.NEUTRAL_MIN + Math.floor(rng() * (C.NEUTRAL_MAX - C.NEUTRAL_MIN + 1)),
        });
      }
    });
    // Players start on outer planets spaced as evenly as 8 slots allow.
    const outer = planets.filter((p) => p.ring === 2);
    const n = this.players.length;
    const shift = Math.floor(rng() * outer.length);
    this.players.forEach((pl, k) => {
      const planet = outer[(Math.round((k * outer.length) / n) + shift) % outer.length];
      planet.owner = pl.id;
      planet.ships = C.START_SHIPS;
    });
    return planets;
  }

  // ------------------------------------------------------------------ input

  /**
   * Validate and execute a launch order. Returns true when a fleet was created.
   * Every field is checked: a malicious client can send anything.
   */
  launch(pid, planetId, angle, pct, seq) {
    if (this.ended) return false;
    const pl = this.playerById[pid];
    if (!pl || !pl.alive) return false;
    if (Number.isInteger(seq) && seq > pl.lastSeq) pl.lastSeq = seq;
    if (!Number.isInteger(planetId) || planetId < 0 || planetId >= this.planets.length) return false;
    const p = this.planets[planetId];
    if (p.owner !== pid) return false;
    if (typeof angle !== 'number' || !Number.isFinite(angle)) return false;
    if (!C.LAUNCH_PCTS.includes(pct)) return false;

    // Flood protection: at most N launches per rolling second.
    const now = this.time;
    while (pl.launchTimes.length && pl.launchTimes[0] <= now - 1) pl.launchTimes.shift();
    if (pl.launchTimes.length >= C.MAX_LAUNCHES_PER_SEC) return false;

    const n = Math.floor(Math.floor(p.ships) * pct);
    if (n < 1) return false;
    pl.launchTimes.push(now);
    p.ships -= n;

    // Quantise exactly as the snapshot encodes them.
    let a = angle % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    a = round(a, 1e4);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const pos = C.planetPos(p, now);
    const off = p.size + C.FLEET_RADIUS + C.LAUNCH_GAP;
    const f = {
      id: this.nextFleetId++,
      owner: pid,
      n,
      a,
      dx,
      dy,
      x0: round(pos.x + dx * off, 10),
      y0: round(pos.y + dy * off, 10),
      t0: round(now, 1000),
      src: p.id,
      seq: Number.isInteger(seq) ? seq : 0,
      revealed: 0, // bitmask of player ids that may see this fleet's size
      x: 0,
      y: 0,
      pred: null, // cached trajectory prediction (used by bots)
    };
    f.x = f.x0;
    f.y = f.y0;
    this.fleets.set(f.id, f);
    pl.stats.launched++;
    return true;
  }

  // ------------------------------------------------------------- simulation

  removeFleet(f, reason) {
    this.fleets.delete(f.id);
    this.removed.set(f.id, { reason, t: round(this.time, 1000) });
  }

  /** Advance the world by one fixed tick. */
  step() {
    if (this.ended) return;
    this.tick++;
    const t = this.tick / C.TICK_RATE;
    this.time = t;
    const R = C.FLEET_RADIUS;

    // 1. Production (owned planets only, capped by planet size).
    for (const p of this.planets) {
      if (p.owner >= 0 && p.ships < p.cap) p.ships = Math.min(p.cap, p.ships + p.prod * C.DT);
    }

    // 2. Expanding sun swallows planets.
    const sunR = C.sunRadius(t);
    for (const p of this.planets) {
      if (p.owner !== C.DESTROYED && p.orbit <= sunR) {
        p.owner = C.DESTROYED;
        p.ships = 0;
      }
    }

    // 3. Move fleets; sun burn; out of map.
    const sunKill = (sunR + R) * (sunR + R);
    const mapR2 = C.MAP_RADIUS * C.MAP_RADIUS;
    for (const f of this.fleets.values()) {
      C.fleetPos(f, t, f);
      const r2 = f.x * f.x + f.y * f.y;
      if (r2 < sunKill) this.removeFleet(f, C.REMOVE.SUN);
      else if (r2 > mapR2) this.removeFleet(f, C.REMOVE.OUT);
    }

    // 4. Solar flare.
    if (t >= this.nextFlare) {
      const fr = C.flareRadius(t);
      for (const f of this.fleets.values()) {
        if (f.x * f.x + f.y * f.y < fr * fr) this.removeFleet(f, C.REMOVE.FLARE);
      }
      this.nextFlare = C.nextFlareTime(t);
    }

    // 5. Interception: enemy fleets that touch cancel 1-for-1.
    const list = Array.from(this.fleets.values());
    const hit2 = 4 * R * R;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.n <= 0) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.n <= 0 || a.owner === b.owner) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy > hit2) continue;
        const m = Math.min(a.n, b.n);
        a.n -= m;
        b.n -= m;
        this.playerById[a.owner].stats.destroyed += m;
        this.playerById[b.owner].stats.destroyed += m;
        if (b.n <= 0) this.removeFleet(b, C.REMOVE.INTERCEPT);
        if (a.n <= 0) {
          this.removeFleet(a, C.REMOVE.INTERCEPT);
          break;
        }
      }
    }

    // 6. Fleets landing on planets (the first planet a fleet touches).
    for (const f of this.fleets.values()) {
      for (const p of this.planets) {
        if (p.owner === C.DESTROYED) continue;
        if (p.id === f.src && t - f.t0 < 0.5) continue; // just launched
        const pp = C.planetPos(p, t, this._pos);
        const dx = f.x - pp.x;
        const dy = f.y - pp.y;
        const rr = p.size + R;
        if (dx * dx + dy * dy < rr * rr) {
          this.land(f, p);
          break;
        }
      }
    }

    // 7. Fleet-size visibility (sticky per player).
    this.updateReveals(t);

    // 8. Housekeeping & win conditions.
    if (this.tick % C.TICK_RATE === 0) {
      for (const [id, r] of this.removed) if (r.t < t - 5) this.removed.delete(id);
    }
    this.checkEnd();
  }

  land(f, p) {
    const atk = this.playerById[f.owner];
    if (p.owner === f.owner) {
      p.ships = Math.min(p.cap, p.ships + f.n); // reinforce
    } else {
      const def = p.owner >= 0 ? this.playerById[p.owner] : null;
      const killed = Math.min(f.n, Math.floor(p.ships));
      atk.stats.destroyed += killed;
      if (def) def.stats.destroyed += Math.min(f.n, Math.ceil(p.ships));
      const remaining = f.n - p.ships;
      if (remaining > 0) {
        p.owner = f.owner;
        p.ships = Math.min(p.cap, remaining);
        atk.stats.captured++;
      } else {
        p.ships = -remaining;
      }
    }
    this.removeFleet(f, C.REMOVE.LAND);
  }

  updateReveals(t) {
    if (this.fleets.size === 0) return;
    const owned = [];
    for (const p of this.planets) {
      if (p.owner >= 0) {
        const pp = C.planetPos(p, t);
        owned.push({ owner: p.owner, x: pp.x, y: pp.y, r: p.size + C.REVEAL_DISTANCE });
      }
    }
    for (const f of this.fleets.values()) {
      for (const o of owned) {
        const bit = 1 << o.owner;
        if (o.owner === f.owner || f.revealed & bit) continue;
        const dx = f.x - o.x;
        const dy = f.y - o.y;
        if (dx * dx + dy * dy < o.r * o.r) f.revealed |= bit;
      }
    }
  }

  /** Planets and ships (garrison + fleets) per player. */
  tally() {
    const planets = [];
    const ships = [];
    const fleets = [];
    for (const p of this.players) {
      planets[p.id] = 0;
      ships[p.id] = 0;
      fleets[p.id] = 0;
    }
    for (const p of this.planets) {
      if (p.owner >= 0) {
        planets[p.owner]++;
        ships[p.owner] += Math.floor(p.ships);
      }
    }
    for (const f of this.fleets.values()) {
      fleets[f.owner]++;
      ships[f.owner] += f.n;
    }
    return { planets, ships, fleets };
  }

  leader(candidates, tally) {
    let best = null;
    for (const p of candidates) {
      if (
        !best ||
        tally.planets[p.id] > tally.planets[best.id] ||
        (tally.planets[p.id] === tally.planets[best.id] && tally.ships[p.id] > tally.ships[best.id])
      ) best = p;
    }
    return best;
  }

  checkEnd() {
    const tally = this.tally();
    for (const p of this.players) {
      if (tally.planets[p.id] > p.stats.peakPlanets) p.stats.peakPlanets = tally.planets[p.id];
      if (p.alive && tally.planets[p.id] === 0 && tally.fleets[p.id] === 0) {
        p.alive = false;
        p.eliminatedAt = this.time;
      }
    }
    const alive = this.players.filter((p) => p.alive);
    const existing = this.planets.filter((p) => p.owner !== C.DESTROYED).length;
    const need = Math.ceil(existing * C.WIN_PLANET_FRACTION);
    for (const p of alive) {
      if (existing > 0 && tally.planets[p.id] >= need) return this.finish(p, 'domination', tally);
    }
    if (alive.length <= 1) return this.finish(alive[0] || null, 'elimination', tally);
    const humans = this.players.filter((p) => p.human);
    if (humans.length && humans.every((p) => !p.alive)) {
      return this.finish(this.leader(alive, tally), 'humans-out', tally);
    }
    if (this.time >= C.MATCH_DURATION) return this.finish(this.leader(alive, tally), 'time', tally);
  }

  finish(winner, reason, tally) {
    this.ended = true;
    this.result = {
      winner: winner ? winner.id : -1,
      reason,
      duration: round(this.time, 10),
      endTime: round(this.time, 1000),
      stats: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        human: p.human,
        alive: p.alive,
        planets: tally.planets[p.id],
        ships: tally.ships[p.id],
        captured: p.stats.captured,
        destroyed: p.stats.destroyed,
        launched: p.stats.launched,
        peakPlanets: p.stats.peakPlanets,
      })),
    };
  }

  // ------------------------------------------------------------ networking

  /** Static match data sent once on start / rejoin. */
  initFor(pid) {
    return {
      seed: this.seed,
      you: pid,
      t: round(this.time, 1000),
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      // [ring, a0] — everything else derives from shared constants.
      planets: this.planets.map((p) => [p.ring, p.a0]),
    };
  }

  /**
   * Build a compact, per-viewer delta snapshot.
   * viewer = { pid: number (-1 for spectators), known: Map<fleetId, visibleCount> }
   * Hidden enemy fleet sizes are sent as -1, so they never reach the browser.
   */
  snapshotFor(viewer) {
    const pl = viewer.pid >= 0 ? this.playerById[viewer.pid] : null;
    const seeAll = !pl || !pl.alive || this.ended;
    const bit = pl ? 1 << pl.id : 0;
    const p = new Array(this.planets.length * 2);
    for (let i = 0; i < this.planets.length; i++) {
      const pl2 = this.planets[i];
      p[i * 2] = pl2.owner;
      p[i * 2 + 1] = Math.floor(pl2.ships * 10) / 10; // 1 decimal: clients interpolate production
    }
    const a = [];
    const c = [];
    const r = [];
    const known = viewer.known;
    for (const f of this.fleets.values()) {
      const vis = seeAll || f.owner === viewer.pid || f.revealed & bit ? f.n : -1;
      const k = known.get(f.id);
      if (k === undefined) {
        a.push([f.id, f.owner, f.x0, f.y0, f.a, f.t0, vis, f.owner === viewer.pid ? f.seq : 0]);
        known.set(f.id, vis);
      } else if (k !== vis) {
        c.push(f.id, vis);
        known.set(f.id, vis);
      }
    }
    for (const id of known.keys()) {
      if (!this.fleets.has(id)) {
        const info = this.removed.get(id);
        r.push(id, info ? info.reason : C.REMOVE.OUT, info ? info.t : round(this.time, 1000));
        known.delete(id);
      }
    }
    let alive = 0;
    for (const x of this.players) if (x.alive) alive |= 1 << x.id;
    const snap = { t: round(this.time, 1000), p, al: alive };
    if (a.length) snap.a = a;
    if (c.length) snap.c = c;
    if (r.length) snap.r = r;
    if (pl) snap.k = pl.lastSeq;
    return snap;
  }
}

module.exports = Game;
