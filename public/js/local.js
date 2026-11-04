/**
 * Orbit Wars — in-browser "server" for the offline single-file build.
 *
 * Only included by scripts/build-offline.js. It replaces Socket.IO's `io()`
 * with a tiny in-memory socket pair and runs the real server code
 * (lobby -> room -> game + bots, bundled as window.OWServer) inside this tab.
 * Messages are JSON-cloned and delivered asynchronously, exactly like a
 * network would, so the client code is identical in both builds.
 */
(function () {
  'use strict';
  const later = (fn) => setTimeout(fn, 0);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  /** Server-side half of a socket (the API the lobby/room code uses). */
  function ServerSocket(id, client) {
    this.id = id;
    this.data = {};
    this.rooms = new Set();
    this.handlers = {};
    this.client = client;
  }
  ServerSocket.prototype.on = function (ev, fn) {
    this.handlers[ev] = fn;
  };
  ServerSocket.prototype.use = function () {};
  ServerSocket.prototype.join = function (r) {
    this.rooms.add(r);
  };
  ServerSocket.prototype.leave = function (r) {
    this.rooms.delete(r);
  };
  ServerSocket.prototype.emit = function (ev, data) {
    const c = this.client;
    const d = clone(data);
    later(() => c._fire(ev, d));
  };

  const io = {
    sockets: { sockets: new Map() },
    to(room) {
      return {
        emit(ev, data) {
          for (const s of io.sockets.sockets.values()) if (s.rooms.has(room)) s.emit(ev, data);
        },
      };
    },
  };
  const lobby = window.OWServer.createLobby(io);
  setInterval(lobby.tick, 1000 / 60);
  let counter = 0;

  /** Client-side half, shaped like a Socket.IO client socket. */
  window.io = function () {
    const listeners = {};
    const client = {
      connected: false,
      on(ev, fn) {
        (listeners[ev] = listeners[ev] || []).push(fn);
      },
      _fire(ev, d) {
        (listeners[ev] || []).forEach((fn) => fn(d));
      },
      emit(ev, data, ack) {
        const d = clone(data);
        later(() => {
          const h = server.handlers[ev];
          if (!h) return;
          h(d, typeof ack === 'function' ? (res) => {
            const r = clone(res);
            later(() => ack(r));
          } : undefined);
        });
      },
    };
    const server = new ServerSocket('local-' + ++counter, client);
    io.sockets.sockets.set(server.id, server);
    lobby.attach(server);
    later(() => {
      client.connected = true;
      client._fire('connect');
    });
    return client;
  };
})();
