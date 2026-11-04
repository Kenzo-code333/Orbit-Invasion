/**
 * Orbit Wars — rooms: lobby, membership, bots, reconnects and the match loop.
 *
 * A Room maps people (identified by a random token stored in their browser)
 * to lobby slots. Slot index == player id == colour index in the match.
 */
'use strict';

const C = require('../shared/constants');
const Game = require('./game');
const Bot = require('./bot');

const BOT_NAMES = ['Nova', 'Vega', 'Orion', 'Lyra', 'Rigel', 'Sirius', 'Altair', 'Deneb', 'Castor', 'Pollux'];
const START_COUNTDOWN_MS = 3000;
const EMPTY_ROOM_TTL_MS = 60000;

class Room {
  constructor(code, io, onEmpty) {
    this.code = code;
    this.io = io;
    this.onEmpty = onEmpty;
    this.members = new Map(); // token -> {token, name, socket, connected, slot}
    this.slots = new Array(C.MAX_PLAYERS).fill(null); // {type:'human', token} | {type:'bot', name, difficulty}
    this.hostToken = null;
    this.state = 'lobby'; // lobby | playing | ended
    this.game = null;
    this.bots = new Map(); // pid -> Bot (bot slots + disconnected humans)
    this.viewers = new Map(); // socket.id -> {pid, known}
    this.startWall = 0;
    this.matchId = 0;
    this.result = null;
    this.emptySince = null;
    this.botCounter = 0;
  }

  // ---------------------------------------------------------------- members

  /** Add or re-attach a person. Returns the member. */
  join(socket, token, name) {
    let m = this.members.get(token);
    if (m) {
      if (m.socket && m.socket !== socket) {
        // Same person opened a second tab: the old one is kicked out of the room.
        this.viewers.delete(m.socket.id);
        m.socket.emit('kicked', 'You joined from another tab.');
        m.socket.leave(this.code);
        m.socket.data.room = null;
      }
      m.socket = socket;
      m.connected = true;
      if (name) m.name = name;
    } else {
      m = { token, name, socket, connected: true, slot: null };
      this.members.set(token, m);
      if (this.state === 'lobby') m.slot = this.freeSlot(); // null if full => spectator
      if (m.slot !== null) this.slots[m.slot] = { type: 'human', token };
    }
    if (!this.hostToken || !this.isConnected(this.hostToken)) this.hostToken = token;
    socket.join(this.code);
    socket.data.room = this;
    socket.data.token = token;
    this.emptySince = null;

    if (this.state !== 'lobby' && this.game) {
      // Rejoin: take control back from the stand-in bot.
      const pid = this.playerIdFor(m);
      if (pid >= 0 && this.slots[pid] && this.slots[pid].type === 'human') this.bots.delete(pid);
      this.sendInit(m);
      if (this.state === 'ended' && this.result) socket.emit('end', this.result);
    }
    this.broadcastRoom();
    return m;
  }

  /** Socket disconnected or left voluntarily. */
  leave(socket) {
    const token = socket.data.token;
    const m = this.members.get(token);
    socket.leave(this.code);
    socket.data.room = null;
    this.viewers.delete(socket.id);
    if (!m || m.socket !== socket) return;
    m.socket = null;
    m.connected = false;
    if (this.state === 'lobby') {
      this.removeMember(m);
    } else if (m.slot !== null && this.game) {
      // A bot takes over until they come back.
      const pl = this.game.playerById[m.slot];
      if (pl && !this.bots.has(m.slot)) this.bots.set(m.slot, new Bot(m.slot, 'normal', (Math.random() * 1e9) | 0));
    }
    if (this.hostToken === token) this.pickNewHost();
    if (!this.connectedCount()) this.emptySince = Date.now();
    this.broadcastRoom();
  }

  removeMember(m) {
    if (m.slot !== null && this.slots[m.slot] && this.slots[m.slot].token === m.token) this.slots[m.slot] = null;
    this.members.delete(m.token);
  }

  pickNewHost() {
    this.hostToken = null;
    for (const m of this.members.values()) {
      if (m.connected) {
        this.hostToken = m.token;
        return;
      }
    }
  }

  isConnected(token) {
    const m = this.members.get(token);
    return !!(m && m.connected);
  }

  connectedCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.connected) n++;
    return n;
  }

  freeSlot() {
    const i = this.slots.indexOf(null);
    return i < 0 ? null : i;
  }

  playerIdFor(m) {
    if (!this.game || m.slot === null) return -1;
    return this.game.playerById[m.slot] ? m.slot : -1;
  }

  isHost(socket) {
    return socket.data.token === this.hostToken;
  }

  // ---------------------------------------------------------------- lobby ops

  addBot(difficulty) {
    if (this.state !== 'lobby') return false;
    const i = this.freeSlot();
    if (i === null) return false;
    const used = new Set(this.slots.filter((s) => s && s.type === 'bot').map((s) => s.name));
    let name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + ++this.botCounter;
    this.slots[i] = { type: 'bot', name, difficulty: C.DIFFICULTIES.includes(difficulty) ? difficulty : 'normal' };
    this.broadcastRoom();
    return true;
  }

  removeBot(slot) {
    if (this.state !== 'lobby' || !Number.isInteger(slot)) return false;
    const s = this.slots[slot];
    if (!s || s.type !== 'bot') return false;
    this.slots[slot] = null;
    this.broadcastRoom();
    return true;
  }

  setBotDifficulty(slot, difficulty) {
    if (this.state !== 'lobby' || !Number.isInteger(slot) || !C.DIFFICULTIES.includes(difficulty)) return false;
    const s = this.slots[slot];
    if (!s || s.type !== 'bot') return false;
    s.difficulty = difficulty;
    this.broadcastRoom();
    return true;
  }

  filledSlots() {
    const out = [];
    this.slots.forEach((s, i) => {
      if (s) out.push(i);
    });
    return out;
  }

  // ---------------------------------------------------------------- match

  start() {
    if (this.state !== 'lobby') return 'Match already running';
    const ids = this.filledSlots();
    if (ids.length < C.MIN_PLAYERS) return 'Need at least 2 players (add a bot!)';
    const players = ids.map((i) => {
      const s = this.slots[i];
      const m = s.type === 'human' ? this.members.get(s.token) : null;
      return { id: i, name: s.type === 'bot' ? s.name : m ? m.name : 'Pilot', color: C.COLORS[i], human: s.type === 'human' };
    });
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.game = new Game(players, seed);
    this.bots.clear();
    for (const i of ids) {
      const s = this.slots[i];
      if (s.type === 'bot') this.bots.set(i, new Bot(i, s.difficulty, seed + i * 101));
      else if (!this.isConnected(s.token)) this.bots.set(i, new Bot(i, 'normal', seed + i * 101));
    }
    this.matchId++;
    this.result = null;
    this.state = 'playing';
    this.startWall = Date.now() + START_COUNTDOWN_MS;
    this.viewers.clear();
    for (const m of this.members.values()) if (m.connected) this.sendInit(m);
    this.broadcastRoom();
    return null;
  }

  /** Seconds of match time right now (negative during the start countdown). */
  matchTime(now = Date.now()) {
    return (now - this.startWall) / 1000;
  }

  sendInit(m) {
    if (!m.socket || !this.game) return;
    const pid = this.playerIdFor(m);
    this.viewers.set(m.socket.id, { pid, known: new Map() });
    const init = this.game.initFor(pid);
    init.matchId = this.matchId;
    init.now = Math.round(this.matchTime() * 1000) / 1000;
    init.state = this.state;
    m.socket.emit('init', init);
    // Immediately follow with a full snapshot so the client has planet owners
    // and every fleet in flight (the viewer's "known" map is empty).
    m.socket.emit('s', this.game.snapshotFor(this.viewers.get(m.socket.id)));
  }

  handleLaunch(socket, data) {
    if (this.state !== 'playing' || !this.game || this.matchTime() < 0) return;
    const v = this.viewers.get(socket.id);
    if (!v || v.pid < 0) return;
    if (!Array.isArray(data) || data.length !== 4) return;
    const [planetId, angle, pctIndex, seq] = data;
    if (!Number.isInteger(pctIndex) || pctIndex < 0 || pctIndex >= C.LAUNCH_PCTS.length) return;
    this.game.launch(v.pid, planetId, angle, C.LAUNCH_PCTS[pctIndex], Number.isInteger(seq) ? seq : 0);
  }

  backToLobby() {
    if (this.state !== 'ended') return false;
    this.state = 'lobby';
    this.game = null;
    this.bots.clear();
    this.viewers.clear();
    // Drop people who left; seat spectators in free slots.
    for (const m of Array.from(this.members.values())) if (!m.connected) this.removeMember(m);
    for (const m of this.members.values()) {
      if (m.slot === null) {
        m.slot = this.freeSlot();
        if (m.slot !== null) this.slots[m.slot] = { type: 'human', token: m.token };
      }
    }
    if (!this.isConnected(this.hostToken)) this.pickNewHost();
    this.broadcastRoom();
    return true;
  }

  /** Called by the global loop ~60 times per second. */
  update(now) {
    if (this.emptySince && now - this.emptySince > EMPTY_ROOM_TTL_MS) {
      this.onEmpty(this);
      return;
    }
    if (this.state !== 'playing') return;
    const game = this.game;
    const elapsed = this.matchTime(now);
    let steps = 0;
    while (!game.ended && (game.tick + 1) / C.TICK_RATE <= elapsed && steps < 10) {
      for (const bot of this.bots.values()) bot.update(game);
      game.step();
      steps++;
      if (game.tick % C.SNAPSHOT_EVERY === 0 || game.ended) this.broadcastSnapshot();
    }
    // If the server stalled badly, slide the clock instead of fast-forwarding.
    const lag = elapsed - game.tick / C.TICK_RATE;
    if (lag > 0.5) this.startWall += lag * 1000;
    if (game.ended) this.endMatch();
  }

  broadcastSnapshot() {
    for (const [sid, viewer] of this.viewers) {
      const s = this.io.sockets.sockets.get(sid);
      if (!s) {
        this.viewers.delete(sid);
        continue;
      }
      s.emit('s', this.game.snapshotFor(viewer));
    }
  }

  endMatch() {
    this.state = 'ended';
    this.result = Object.assign({ matchId: this.matchId }, this.game.result);
    this.io.to(this.code).emit('end', this.result);
    this.broadcastRoom();
  }

  // ---------------------------------------------------------------- state out

  roomStateFor(m) {
    const game = this.game;
    return {
      code: this.code,
      state: this.state,
      isHost: m.token === this.hostToken,
      you: m.slot,
      spectator: this.state !== 'lobby' && this.playerIdFor(m) < 0,
      slots: this.slots.map((s, i) => {
        if (!s) return null;
        if (s.type === 'bot') return { i, name: s.name, color: C.COLORS[i], bot: true, difficulty: s.difficulty, connected: true };
        const mm = this.members.get(s.token);
        return {
          i,
          name: mm ? mm.name : 'Pilot',
          color: C.COLORS[i],
          bot: false,
          connected: !!(mm && mm.connected),
          host: s.token === this.hostToken,
          botControlled: !!(game && this.bots.has(i)),
        };
      }),
      spectators: Array.from(this.members.values())
        .filter((x) => x.connected && (x.slot === null || (this.state !== 'lobby' && this.playerIdFor(x) < 0)))
        .map((x) => x.name),
    };
  }

  broadcastRoom() {
    for (const m of this.members.values()) if (m.socket) m.socket.emit('room', this.roomStateFor(m));
  }
}

module.exports = Room;
