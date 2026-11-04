/**
 * End-to-end test over real sockets: lobby, host rights, input validation,
 * hidden fleet sizes, disconnect -> bot takeover -> rejoin, spectators,
 * end screen -> play again, practice mode and many parallel rooms.
 * Usage: node scripts/socket-test.js
 */
'use strict';
process.env.PORT = process.env.PORT || '3917';
const { rooms, server } = require('../server/index');
const { io: ioc } = require('socket.io-client');
const C = require('../shared/constants');

const URL = 'http://localhost:' + process.env.PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
}

function client(token) {
  const s = ioc(URL, { transports: ['websocket'], forceNew: true });
  s.token = token;
  s.snaps = [];
  s.on('room', (r) => (s.room = r));
  s.on('init', (i) => {
    s.init = i;
    s.snaps = [];
  });
  s.on('s', (x) => s.snaps.push(x));
  s.on('end', (e) => (s.end = e));
  s.req = (ev, data) => new Promise((res) => s.emit(ev, Object.assign({ token: s.token }, data || {}), res));
  return new Promise((res) => s.on('connect', () => res(s)));
}

(async () => {
  await sleep(200);
  console.log('Lobby');
  const A = await client('tokenAAAAAAAA');
  const B = await client('tokenBBBBBBBB');
  const r1 = await A.req('create', { name: 'Alice<script>' });
  check(r1.ok && /^[A-Z]{4}$/.test(r1.code), 'create returns a room code ' + r1.code);
  const bad = await B.req('join', { code: 'ZZZZZZ', name: 'Bob' });
  check(!bad.ok, 'joining a missing room fails');
  const r2 = await B.req('join', { code: r1.code.toLowerCase(), name: 'Bob' });
  check(r2.ok, 'join with code (case-insensitive)');
  await sleep(100);
  check(A.room.slots.filter(Boolean).length === 2, 'both players listed');
  check(A.room.slots[0].name === 'Alicescript', 'nickname sanitised');
  check(A.room.isHost && !B.room.isHost, 'creator is host');
  const nb = await B.req('addBot', { difficulty: 'hard' });
  check(!nb.ok, 'non-host cannot add bots');
  await A.req('addBot', { difficulty: 'hard' });
  await A.req('addBot', { difficulty: 'easy' });
  await A.req('addBot', { difficulty: 'easy' });
  await sleep(50);
  const botSlot = A.room.slots.findIndex((s) => s && s.bot && s.difficulty === 'easy');
  await A.req('removeBot', { slot: botSlot });
  await A.req('botDiff', { slot: A.room.slots.findIndex((s) => s && s.bot), difficulty: 'normal' });
  await sleep(50);
  check(A.room.slots.filter(Boolean).length === 4, 'add/remove bots works (4 players)');
  check(A.room.slots.some((s) => s && s.bot && s.difficulty === 'normal'), 'bot difficulty change works');
  const ns = await B.req('start');
  check(!ns.ok, 'non-host cannot start');
  const st = await A.req('start');
  check(st.ok, 'host starts the match');
  await sleep(300);
  check(A.init && B.init && A.init.you === 0 && B.init.you === 1, 'both got init with their player id');
  check(A.init.planets.length === 22, '22 planets (6+8+8)');
  check(A.snaps.length >= 1, 'got initial snapshot during countdown');

  console.log('Match (waiting for countdown)');
  await sleep(3300);
  const room = rooms.get(r1.code);
  const game = room.game;
  check(room.state === 'playing' && game.time > 0, 'simulation running, t=' + game.time.toFixed(2));
  const aPlanet = game.planets.find((p) => p.owner === 0);
  const bPlanet = game.planets.find((p) => p.owner === 1);
  const before = game.fleets.size;
  // Validation: launching from someone else's planet / bad pct / junk.
  B.emit('launch', [aPlanet.id, 0, 1, 1]);
  B.emit('launch', [bPlanet.id, 0, 7, 2]);
  B.emit('launch', [bPlanet.id, NaN, 1, 3]);
  B.emit('launch', [bPlanet.id, 'x', 1, 4]);
  B.emit('launch', ['0', 1, 1, 5]);
  B.emit('launch', { evil: true });
  B.emit('launch', null);
  B.emit('addBot', null, () => {});
  await sleep(150);
  const bFleets = Array.from(game.fleets.values()).filter((f) => f.owner === 1);
  check(bFleets.length === 0, 'invalid launches rejected (B has no fleets)');
  // Valid launch by A: aim straight away from the sun so it flies out.
  const pos = C.planetPos(aPlanet, game.time);
  const ang = Math.atan2(pos.y, pos.x);
  const shipsBefore = Math.floor(aPlanet.ships);
  A.emit('launch', [aPlanet.id, ang, 1, 1]);
  await sleep(250);
  const aF = Array.from(game.fleets.values()).find((f) => f.owner === 0 && f.seq === 1);
  check(!!aF, 'valid launch creates a fleet');
  check(aF && aF.n === Math.floor(shipsBefore * 0.5), '50% of ships sent (' + (aF && aF.n) + ')');
  const aSaw = A.snaps.some((s) => s.a && s.a.some((e) => e[0] === aF.id && e[6] === aF.n && e[7] === 1));
  const bEntry = B.snaps.map((s) => s.a && s.a.find((e) => e[0] === aF.id)).find(Boolean);
  check(aSaw, 'owner sees own fleet size and seq');
  check(bEntry && bEntry[6] === -1 && bEntry[7] === 0, 'enemy sees fleet with hidden size (-1) and no seq');
  check(A.snaps.some((s) => s.k >= 1), 'snapshot acks launch seq');
  const avg = JSON.stringify(A.snaps).length / A.snaps.length;
  check(avg < 600, 'compact snapshots (avg ' + Math.round(avg) + ' bytes)');

  console.log('Disconnect / rejoin');
  B.disconnect();
  await sleep(150);
  check(room.bots.has(1), 'bot took over disconnected player');
  const B2 = await client('tokenBBBBBBBB');
  await B2.req('join', { code: r1.code, name: 'Bob' });
  await sleep(200);
  check(!room.bots.has(1), 'player took control back on rejoin');
  check(B2.init && B2.init.you === 1, 'rejoin gets init for the same player');
  check(B2.snaps.length > 0 && B2.snaps[0].p.length === 44, 'rejoin gets full state');

  console.log('Spectator');
  const S = await client('tokenSSSSSSSS');
  await S.req('join', { code: r1.code, name: 'Sam' });
  await sleep(200);
  check(S.init && S.init.you === -1, 'mid-match joiner spectates');

  console.log('End & play again');
  for (const p of game.planets) if (p.owner >= 0) p.owner = 0;
  await sleep(300);
  check(room.state === 'ended' && A.end && A.end.winner === 0, 'domination ends the match, winner announced');
  check(A.end && A.end.stats.length === 4 && 'captured' in A.end.stats[0], 'end stats included');
  S.emit('toLobby');
  await sleep(150);
  check(room.state === 'lobby', 'play again returns everyone to the same lobby');
  check(S.room && S.room.you !== null && S.room.slots[S.room.you], 'spectator got a slot for next round');

  console.log('Practice & many rooms');
  const players = [];
  for (let i = 0; i < 20; i++) {
    const c = await client('practice' + String(i).padStart(4, '0'));
    await c.req('practice', { name: 'P' + i, difficulty: C.DIFFICULTIES[i % 3], bots: 1 + (i % 7) });
    players.push(c);
  }
  await sleep(500);
  check(players.every((c) => c.init && c.init.you === 0), '20 practice rooms started at once');
  await sleep(4500);
  const minSnaps = Math.min(...players.map((c) => c.snaps.length));
  check(minSnaps > 15, 'all rooms streaming snapshots (min ' + minSnaps + ' received)');
  const t0 = Date.now();
  for (const r of rooms.values()) if (r.game) for (let i = 0; i < 300; i++) r.game.step();
  console.log('  (stepped every room 10s of game time in ' + (Date.now() - t0) + 'ms)');
  for (const c of players) c.disconnect();
  A.disconnect();
  B2.disconnect();
  S.disconnect();
  await sleep(200);

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll socket checks passed');
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
