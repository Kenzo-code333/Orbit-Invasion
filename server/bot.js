/**
 * Orbit Wars — bot AI.
 *
 * Bots play through exactly the same interface as humans (game.launch with a
 * 25/50/100% choice) and only use information a human could see: enemy fleet
 * sizes are estimated unless revealed to the bot's player.
 *
 * What a bot does every "think":
 *   1. Predicts where every fleet will land (straight-line + moving planets).
 *   2. Defends planets that would fall to incoming enemy fleets.
 *   3. Evacuates inner planets before the expanding sun swallows them.
 *   4. Scores capturable targets, computes a real intercept point for the
 *      moving target, verifies the path (no sun, no flare, no planet in the
 *      way) and launches the smallest percentage that wins.
 */
'use strict';

const C = require('../shared/constants');

const PROFILES = {
  // Easy: slow, sloppy aim, sometimes forgets the sun or under-sends.
  // exposure: fraction of the strongest nearby enemy garrison kept at home as a deterrent.
  easy: { think: 2.8, launches: 1, aimErr: 0.08, mistake: 0.3, defend: 0.35, margin: 2, minSend: 8, reserve: 0.3, exposure: 0, candidates: 4, multi: false, evacuate: false },
  normal: { think: 1.4, launches: 2, aimErr: 0.01, mistake: 0.04, defend: 0.9, margin: 4, minSend: 5, reserve: 0.1, exposure: 0.6, candidates: 8, multi: true, evacuate: true },
  hard: { think: 0.7, launches: 3, aimErr: 0, mistake: 0, defend: 1, margin: 3, minSend: 4, reserve: 0.05, exposure: 0.8, candidates: 14, multi: true, evacuate: true },
};

const HIDDEN_ESTIMATE = 20; // assumed size of an enemy fleet whose size is hidden
const PRED_STEP = 1 / 15;
const PRED_MAX = 16;
const tmp = { x: 0, y: 0 };

/**
 * Follow a fleet's straight line through the (deterministic) future and
 * report its fate: {fate:'planet', planet, t} | {fate:'sun'|'flare'|'out', t}.
 */
function predictPath(game, f, fromT) {
  const R = C.FLEET_RADIUS;
  const start = Math.max(f.t0, fromT);
  for (let t = start + PRED_STEP; t < start + PRED_MAX; t += PRED_STEP) {
    C.fleetPos(f, t, tmp);
    const x = tmp.x;
    const y = tmp.y;
    const r2 = x * x + y * y;
    const sunR = C.sunRadius(t);
    if (r2 < (sunR + R) * (sunR + R)) return { fate: 'sun', t };
    if (r2 > C.MAP_RADIUS * C.MAP_RADIUS) return { fate: 'out', t };
    const ft = C.nextFlareTime(t - PRED_STEP);
    if (ft <= t) {
      const fr = C.flareRadius(ft);
      if (r2 < fr * fr) return { fate: 'flare', t: ft };
    }
    for (const p of game.planets) {
      if (p.owner === C.DESTROYED || p.orbit <= sunR) continue;
      if (p.id === f.src && t - f.t0 < 0.5) continue;
      const a = p.a0 + p.w * t;
      const dx = x - Math.cos(a) * p.orbit;
      const dy = y - Math.sin(a) * p.orbit;
      const rr = p.size + R;
      if (dx * dx + dy * dy < rr * rr) return { fate: 'planet', planet: p, t };
    }
  }
  return { fate: 'out', t: start + PRED_MAX };
}

/** Lead a moving target: iterate flight time until it converges. */
function solveIntercept(src, tgt, t) {
  const s = C.planetPos(src, t);
  const off = src.size + C.FLEET_RADIUS + C.LAUNCH_GAP;
  let tp = C.planetPos(tgt, t);
  let T = Math.hypot(tp.x - s.x, tp.y - s.y) / C.FLEET_SPEED;
  for (let i = 0; i < 8; i++) {
    tp = C.planetPos(tgt, t + T);
    const d = Math.hypot(tp.x - s.x, tp.y - s.y);
    T = Math.max(0.05, (d - off - tgt.size * 0.5) / C.FLEET_SPEED);
  }
  tp = C.planetPos(tgt, t + T);
  return { angle: Math.atan2(tp.y - s.y, tp.x - s.x), T };
}

/** Build the fleet a launch would create (same quantisation as Game.launch). */
function virtualFleet(src, angle, t) {
  let a = angle % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  a = Math.round(a * 1e4) / 1e4;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const pos = C.planetPos(src, t);
  const off = src.size + C.FLEET_RADIUS + C.LAUNCH_GAP;
  return {
    x0: Math.round((pos.x + dx * off) * 10) / 10,
    y0: Math.round((pos.y + dy * off) * 10) / 10,
    dx, dy, t0: Math.round(t * 1000) / 1000, src: src.id,
  };
}

/**
 * Project a planet's owner/ships forward through a list of arrivals
 * ({t, n, owner}) up to time `until`. Returns {owner, ships, minMine}.
 */
function project(p, now, until, arrivals) {
  let owner = p.owner;
  let ships = p.ships;
  let last = now;
  let fellAt = Infinity;
  const startOwner = p.owner;
  const evs = arrivals ? arrivals.filter((e) => e.t <= until).sort((a, b) => a.t - b.t) : [];
  for (const e of evs) {
    if (owner >= 0) ships = Math.min(p.cap, ships + p.prod * (e.t - last));
    last = e.t;
    if (e.owner === owner) ships = Math.min(p.cap, ships + e.n);
    else {
      ships -= e.n;
      if (ships < 0) {
        owner = e.owner;
        ships = Math.min(p.cap, -ships);
        if (owner !== startOwner && fellAt === Infinity) fellAt = e.t;
      }
    }
  }
  if (owner >= 0) ships = Math.min(p.cap, ships + p.prod * Math.max(0, until - last));
  return { owner, ships, fellAt };
}

class Bot {
  /**
   * @param {number} pid        the player id this bot controls
   * @param {string} difficulty easy|normal|hard
   * @param {number} seed       seeds the bot's private RNG (mistakes, timing)
   */
  constructor(pid, difficulty, seed) {
    this.pid = pid;
    this.setDifficulty(difficulty);
    this.rng = C.makeRng(seed);
    this.nextThink = 1 + this.rng() * this.profile.think; // small opening delay
    this.seq = 0;
  }

  setDifficulty(d) {
    this.difficulty = PROFILES[d] ? d : 'normal';
    this.profile = PROFILES[this.difficulty];
  }

  /** Called every tick by the room. */
  update(game) {
    if (game.ended || game.time < this.nextThink) return;
    this.nextThink = game.time + this.profile.think * (0.75 + this.rng() * 0.5);
    const pl = game.playerById[this.pid];
    if (!pl || !pl.alive) return;
    this.think(game);
  }

  launch(game, src, angle, pct) {
    const err = this.profile.aimErr;
    if (err) angle += (this.rng() - 0.5) * 2 * err;
    return game.launch(this.pid, src.id, angle, pct, ++this.seq);
  }

  /** Smallest allowed percentage that sends at least `need` ships without dipping into `keep`. */
  pickPct(src, need, keep) {
    const s = Math.floor(src.ships);
    for (const pct of C.LAUNCH_PCTS) {
      const n = Math.floor(s * pct);
      if (n >= need && s - n >= keep) return { pct, n };
    }
    return null;
  }

  /** Verify a planned shot actually reaches `tgt` first. Easy bots sometimes skip this. */
  pathOk(game, src, angle, tgt) {
    if (this.rng() < this.profile.mistake) return true;
    const pred = predictPath(game, virtualFleet(src, angle, game.time), game.time);
    return pred.fate === 'planet' && pred.planet === tgt;
  }

  think(game) {
    const P = this.profile;
    const me = this.pid;
    const bit = 1 << me;
    const now = game.time;
    const mine = game.planets.filter((p) => p.owner === me);
    if (!mine.length) return;

    // --- 1. Where is every fleet going? ---
    const arrivals = new Map(); // planetId -> [{t, n, owner}]
    for (const f of game.fleets.values()) {
      if (!f.pred) f.pred = predictPath(game, f, now);
      const pr = f.pred;
      if (pr.fate !== 'planet' || pr.t < now) continue;
      const n = f.owner === me || f.revealed & bit ? f.n : HIDDEN_ESTIMATE;
      if (!arrivals.has(pr.planet.id)) arrivals.set(pr.planet.id, []);
      arrivals.get(pr.planet.id).push({ t: pr.t, n, owner: f.owner });
    }
    const addArrival = (p, t, n) => {
      if (!arrivals.has(p.id)) arrivals.set(p.id, []);
      arrivals.get(p.id).push({ t, n, owner: me });
    };

    // --- 2. Threat assessment for my planets ---
    const keep = new Map(); // planetId -> ships to keep home
    const threats = [];
    const enemyPlanets = game.planets.filter((q) => q.owner >= 0 && q.owner !== me);
    for (const p of mine) {
      const arr = arrivals.get(p.id);
      let k = Math.floor(p.ships * P.reserve);
      if (P.exposure) {
        // Deterrence: keep part of the strongest enemy garrison that could reach us quickly.
        const pp = C.planetPos(p, now);
        let danger = 0;
        for (const q of enemyPlanets) {
          const qp = C.planetPos(q, now);
          const d = Math.hypot(qp.x - pp.x, qp.y - pp.y);
          if (d < C.FLEET_SPEED * 6) danger = Math.max(danger, q.ships * (1 - d / (C.FLEET_SPEED * 8)));
        }
        k = Math.max(k, Math.floor(Math.min(p.ships, danger * P.exposure)));
      }
      if (arr && arr.some((e) => e.owner !== me)) {
        const lastT = Math.max(...arr.map((e) => e.t));
        const pr = project(p, now, lastT + 0.1, arr);
        const enemyIn = arr.filter((e) => e.owner !== me).reduce((s, e) => s + e.n, 0);
        k = Math.max(k, Math.min(Math.floor(p.ships), enemyIn + P.margin));
        if (pr.owner !== me) threats.push({ p, deficit: Math.ceil(pr.ships) + P.margin, deadline: pr.fellAt });
      }
      keep.set(p.id, k);
    }

    let launches = 0;

    // --- 3. Defend ---
    if (threats.length && this.rng() < P.defend) {
      for (const th of threats) {
        let deficit = th.deficit;
        const helpers = mine.filter((h) => h !== th.p && !threats.some((x) => x.p === h));
        helpers.sort((a, b) => b.ships - a.ships);
        for (const h of helpers) {
          if (deficit <= 0 || launches >= P.launches + 1) break;
          const spare = Math.floor(h.ships) - (keep.get(h.id) || 0);
          if (spare < 3) continue;
          const sol = solveIntercept(h, th.p, now);
          if (now + sol.T > th.deadline - 0.15) continue;
          const choice = this.pickPct(h, Math.min(deficit, spare), keep.get(h.id) || 0) ||
            this.pickPct(h, 1, keep.get(h.id) || 0);
          if (!choice) continue;
          if (!this.pathOk(game, h, sol.angle, th.p)) continue;
          if (this.launch(game, h, sol.angle, choice.pct)) {
            deficit -= choice.n;
            addArrival(th.p, now + sol.T, choice.n);
            launches++;
          }
        }
      }
    }

    // --- 4. Evacuate planets the sun is about to swallow ---
    if (P.evacuate) {
      for (const p of mine) {
        const sw = C.swallowTime(p.orbit);
        if (sw - now > 12 || p.ships < 2) continue;
        const best = this.bestDestination(game, p, now, arrivals, (q) => q.ring > 0);
        if (best && this.launch(game, p, best.angle, 1)) launches++;
      }
    }

    // --- 5. Attack ---
    if (launches >= P.launches) return;
    const tally = game.tally();
    let leaderId = -1;
    for (const pl of game.players) {
      if (pl.id !== me && pl.alive && (leaderId < 0 || tally.planets[pl.id] > tally.planets[leaderId])) leaderId = pl.id;
    }

    const cands = [];
    for (const src of mine) {
      const avail = Math.floor(src.ships) - (keep.get(src.id) || 0);
      if (avail < P.minSend) continue;
      const sp = C.planetPos(src, now);
      for (const tgt of game.planets) {
        if (tgt.owner === me || tgt.owner === C.DESTROYED) continue;
        if (C.swallowTime(tgt.orbit) < now + 30) continue;
        const tp = C.planetPos(tgt, now);
        const T0 = Math.hypot(tp.x - sp.x, tp.y - sp.y) / C.FLEET_SPEED;
        const pr = project(tgt, now, now + T0, arrivals.get(tgt.id));
        if (pr.owner === me) continue; // already being captured by us
        const need = Math.floor(pr.ships) + 1 + P.margin;
        let value = tgt.prod + (pr.owner >= 0 ? 1.5 : 0) + (pr.owner === leaderId ? 0.8 : 0);
        // Inner planets are doomed late in the game.
        if (C.swallowTime(tgt.orbit) < now + 90) value *= 0.4;
        const score = value / (need + T0 * 3 + 6);
        cands.push({ src, tgt, need, score, avail });
      }
    }
    cands.sort((a, b) => b.score - a.score);

    const usedTargets = new Set();
    const usedSources = new Set();
    let tries = 0;
    for (const cd of cands) {
      if (launches >= P.launches || tries >= P.candidates) break;
      if (usedTargets.has(cd.tgt.id) || usedSources.has(cd.src.id)) continue;
      tries++;
      const sol = solveIntercept(cd.src, cd.tgt, now);
      const pr = project(cd.tgt, now, now + sol.T, arrivals.get(cd.tgt.id));
      if (pr.owner === me) continue;
      let need = Math.floor(pr.ships) + 1 + P.margin;
      if (this.difficulty === 'easy' && this.rng() < P.mistake) need = Math.max(1, Math.floor(need * 0.6));
      const k = keep.get(cd.src.id) || 0;
      const choice = this.pickPct(cd.src, need, k);
      if (choice) {
        if (!this.pathOk(game, cd.src, sol.angle, cd.tgt)) continue;
        if (this.launch(game, cd.src, sol.angle, choice.pct)) {
          addArrival(cd.tgt, now + sol.T, choice.n);
          usedTargets.add(cd.tgt.id);
          usedSources.add(cd.src.id);
          launches++;
        }
      } else if (P.multi) {
        // Gang up: several of my planets send together.
        const plan = [];
        let sum = 0;
        const helpers = mine
          .filter((h) => !usedSources.has(h.id))
          .map((h) => ({ h, sol: solveIntercept(h, cd.tgt, now) }))
          .filter((x) => x.sol.T < 9)
          .sort((a, b) => a.sol.T - b.sol.T);
        for (const { h, sol: hs } of helpers) {
          const kk = keep.get(h.id) || 0;
          const c = this.pickPct(h, Math.max(1, need - sum), kk) || this.pickPct(h, 1, kk);
          if (!c || c.n < 3) continue;
          plan.push({ h, sol: hs, c });
          sum += c.n;
          if (sum >= need + plan.length * 2) break;
        }
        // Enemy planets keep producing while the slower fleets travel.
        const spread = plan.length ? Math.max(...plan.map((x) => x.sol.T)) - Math.min(...plan.map((x) => x.sol.T)) : 0;
        const extra = cd.tgt.owner >= 0 ? Math.ceil(spread * cd.tgt.prod) : 0;
        if (plan.length >= 2 && sum >= need + extra && plan.every((x) => this.pathOk(game, x.h, x.sol.angle, cd.tgt))) {
          for (const x of plan) {
            if (this.launch(game, x.h, x.sol.angle, x.c.pct)) {
              addArrival(cd.tgt, now + x.sol.T, x.c.n);
              usedSources.add(x.h.id);
            }
          }
          usedTargets.add(cd.tgt.id);
          launches++;
        }
      }
    }

    // --- 6. Don't waste production: full planets push ships forward ---
    if (launches < P.launches && this.difficulty !== 'easy') {
      for (const p of mine) {
        if (usedSources.has(p.id) || p.ships < p.cap * 0.95) continue;
        const best = this.bestDestination(game, p, now, arrivals, (q) => q !== p && q.owner === me && q.ships < q.cap * 0.6 && C.swallowTime(q.orbit) > now + 40);
        if (best && this.launch(game, p, best.angle, 0.5)) {
          launches++;
          break;
        }
      }
    }
  }

  /** Nearest reachable planet matching `filter` with a clean path. */
  bestDestination(game, src, now, arrivals, filter) {
    const opts = [];
    for (const q of game.planets) {
      if (q === src || q.owner === C.DESTROYED || !filter(q)) continue;
      if (C.swallowTime(q.orbit) < now + 20) continue;
      const sol = solveIntercept(src, q, now);
      // Prefer own planets, then cheap captures, then short flights.
      const pr = project(q, now, now + sol.T, arrivals.get(q.id));
      const cost = pr.owner === this.pid ? 0 : pr.ships;
      opts.push({ q, sol, score: sol.T + cost * 0.15 });
    }
    opts.sort((a, b) => a.score - b.score);
    for (const o of opts.slice(0, 6)) {
      const pred = predictPath(game, virtualFleet(src, o.sol.angle, now), now);
      if (pred.fate === 'planet' && pred.planet === o.q) return { planet: o.q, angle: o.sol.angle };
    }
    return null;
  }
}

Bot.PROFILES = PROFILES;
Bot.predictPath = predictPath;
Bot.solveIntercept = solveIntercept;
module.exports = Bot;
