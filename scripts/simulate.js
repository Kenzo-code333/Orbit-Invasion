/**
 * Headless stress test: runs full bot-only matches as fast as possible and
 * checks invariants. Usage: node scripts/simulate.js [matches]
 */
'use strict';
const C = require('../shared/constants');
const Game = require('../server/game');
const Bot = require('../server/bot');

function runMatch(nPlayers, diffs, seed) {
  const players = [];
  for (let i = 0; i < nPlayers; i++) players.push({ id: i, name: 'Bot' + i, color: C.COLORS[i], human: false });
  const game = new Game(players, seed);
  const bots = players.map((p, i) => new Bot(p.id, diffs[i % diffs.length], seed + i));
  const viewers = players.map((p) => ({ pid: p.id, known: new Map() }));
  viewers.push({ pid: -1, known: new Map() });
  let bytes = 0, snaps = 0, maxFleets = 0, burned = 0;
  const t0 = Date.now();
  while (!game.ended) {
    for (const b of bots) b.update(game);
    game.step();
    maxFleets = Math.max(maxFleets, game.fleets.size);
    // invariants
    for (const p of game.planets) {
      if (!(p.ships >= 0) || p.ships > p.cap + 1e-9) throw new Error('bad ships ' + JSON.stringify(p));
    }
    for (const f of game.fleets.values()) if (!(f.n > 0)) throw new Error('bad fleet ' + JSON.stringify(f));
    if (game.tick % C.SNAPSHOT_EVERY === 0) {
      for (const v of viewers) {
        const s = game.snapshotFor(v);
        // hidden-info check: enemy fleets not revealed must be -1
        if (v.pid >= 0 && game.playerById[v.pid].alive && s.a) for (const a of s.a) {
          const f = game.fleets.get(a[0]);
          if (f && f.owner !== v.pid && !(f.revealed & (1 << v.pid)) && a[6] !== -1) throw new Error('leak');
        }
        if (s.r) for (let i = 1; i < s.r.length; i += 3) if (s.r[i] === C.REMOVE.SUN || s.r[i] === C.REMOVE.FLARE) burned++;
        if (v.pid === 0) { bytes += JSON.stringify(s).length; snaps++; }
      }
    }
    if (game.tick > C.MATCH_DURATION * C.TICK_RATE + 10) throw new Error('match did not end');
  }
  return { game, ms: Date.now() - t0, avgSnap: Math.round(bytes / snaps), maxFleets, burned };
}

const n = parseInt(process.argv[2] || '12', 10);
const setups = [
  [2, ['hard', 'easy']], [2, ['normal', 'easy']], [3, ['hard', 'normal', 'easy']], [4, ['normal']],
  [5, ['hard', 'normal']], [6, ['easy', 'normal', 'hard']], [8, ['hard']], [8, ['normal', 'easy']],
];
const wins = {};
for (let i = 0; i < n; i++) {
  const [np, diffs] = setups[i % setups.length];
  const r = runMatch(np, diffs, 1000 + i * 7919);
  const res = r.game.result;
  const w = res.winner >= 0 ? diffs[res.winner % diffs.length] : 'none';
  wins[w] = (wins[w] || 0) + 1;
  console.log(`#${i} ${np}p [${diffs}] winner=${res.winner}(${w}) reason=${res.reason} t=${res.duration}s sim=${r.ms}ms avgSnap=${r.avgSnap}B maxFleets=${r.maxFleets} burned=${r.burned}`);
  console.log('   ' + res.stats.map((s) => `${s.id}:${s.planets}p/${s.captured}c/${s.launched}l/${s.destroyed}d`).join(' '));
}
console.log('wins by difficulty', wins);
console.log('OK');
