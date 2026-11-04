/**
 * Orbit Wars — lobby service: room registry, socket event handlers and the
 * tick that advances every room.
 *
 * It only needs a Socket.IO-like `io`/`socket` API, so the same code runs on
 * the Node server (server/index.js) and inside the offline single-file build,
 * where a tiny in-browser socket shim stands in for the network.
 */
'use strict';

const C = require('../shared/constants');
const Room = require('./room');

function createLobby(io) {
  const rooms = new Map();
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

  function newCode() {
    for (let len = 4; ; len++) {
      for (let tries = 0; tries < 50; tries++) {
        let code = '';
        for (let i = 0; i < len; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
        if (!rooms.has(code)) return code;
      }
    }
  }

  function createRoom() {
    const code = newCode();
    const room = new Room(code, io, (r) => {
      rooms.delete(r.code);
      console.log(`[room ${r.code}] closed (${rooms.size} open)`);
    });
    rooms.set(code, room);
    console.log(`[room ${code}] created (${rooms.size} open)`);
    return room;
  }

  // ------------------------------------------------------------ input sanitising

  function cleanName(v) {
    if (typeof v !== 'string') return 'Pilot';
    const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
    return s || 'Pilot';
  }
  function cleanToken(v) {
    return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
  }
  function cleanCode(v) {
    return typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) : '';
  }

  function attach(socket) {
    // Simple per-socket flood guard: max 40 messages per second.
    let budget = 40;
    const refill = setInterval(() => (budget = 40), 1000);
    socket.use((packet, next) => (--budget >= 0 ? next() : undefined));

    const ack = (fn, payload) => typeof fn === 'function' && fn(payload);
    const room = () => socket.data.room;

    function enter(r, data, fn) {
      const token = cleanToken(data && data.token);
      if (!token) return ack(fn, { ok: false, error: 'Bad token' });
      if (room() && room() !== r) room().leave(socket);
      r.join(socket, token, cleanName(data.name));
      ack(fn, { ok: true, code: r.code });
    }

    socket.on('create', (data, fn) => enter(createRoom(), data, fn));

    socket.on('join', (data, fn) => {
      const r = rooms.get(cleanCode(data && data.code));
      if (!r) return ack(fn, { ok: false, error: 'Room not found. Check the code?' });
      enter(r, data, fn);
    });

    socket.on('practice', (data, fn) => {
      const r = createRoom();
      enter(r, data, fn);
      if (r.members.size !== 1) return;
      const diff = C.DIFFICULTIES.includes(data && data.difficulty) ? data.difficulty : 'normal';
      const n = Math.max(1, Math.min(7, parseInt(data && data.bots, 10) || 3));
      for (let i = 0; i < n; i++) r.addBot(diff);
      r.start();
    });

    // Host-only lobby controls.
    const hostOnly = (handler) => (data, fn) => {
      const r = room();
      if (!r || !r.isHost(socket)) return ack(fn, { ok: false, error: 'Only the host can do that' });
      const err = handler(r, data || {});
      ack(fn, err ? { ok: false, error: err } : { ok: true });
    };
    socket.on('addBot', hostOnly((r, d) => (r.addBot(d.difficulty) ? null : 'Lobby is full')));
    socket.on('removeBot', hostOnly((r, d) => (r.removeBot(d.slot) ? null : 'Cannot remove')));
    socket.on('botDiff', hostOnly((r, d) => (r.setBotDifficulty(d.slot, d.difficulty) ? null : 'Cannot change')));
    socket.on('start', hostOnly((r) => r.start()));

    socket.on('toLobby', () => room() && room().backToLobby());
    socket.on('launch', (data) => room() && room().handleLaunch(socket, data));
    socket.on('leave', () => room() && room().leave(socket));

    // Clock sync: reply with the room's match time (or 0 outside a match).
    socket.on('ping2', (clientT, fn) => {
      if (typeof fn !== 'function') return;
      const r = room();
      fn([clientT, r && r.game ? Math.round(r.matchTime() * 1000) / 1000 : 0]);
    });

    socket.on('disconnect', () => {
      clearInterval(refill);
      if (room()) room().leave(socket);
    });
  }

  // ------------------------------------------------------------ global loop

  function tick() {
    const now = Date.now();
    for (const r of rooms.values()) {
      try {
        r.update(now);
      } catch (e) {
        console.error(`[room ${r.code}] crashed:`, e);
        rooms.delete(r.code);
        io.to(r.code).emit('kicked', 'The server hit an error in this room. Please start a new game.');
      }
    }
  }

  return { rooms, createRoom, attach, tick };
}

module.exports = createLobby;
