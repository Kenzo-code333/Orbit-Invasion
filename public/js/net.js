/**
 * Orbit Wars client — networking, clock sync and the match state store.
 *
 * The server sends:
 *   'room'  lobby/room state
 *   'init'  static match data (planet orbits, players)
 *   's'     compact per-player delta snapshots ~15/sec
 *   'end'   match result
 *
 * Planets and fleets are deterministic functions of time, so the client only
 * needs a well-synced clock. We render slightly in the past (INTERP_DELAY) so
 * every ownership change / fleet removal is already known when it is drawn.
 */
(function () {
  'use strict';
  const C = window.OW;

  // ------------------------------------------------------------------ clock
  const Clock = {
    offset: 0, // serverTime = localTime + offset
    target: 0,
    samples: [],
    rtt: 0.1,
    synced: false,
    local() {
      return performance.now() / 1000;
    },
    now() {
      return this.local() + this.offset;
    },
    reset(serverT) {
      this.samples = [];
      this.offset = this.target = serverT - this.local();
      this.synced = false;
    },
    addSample(clientT, serverT) {
      const recv = this.local();
      const rtt = Math.max(0, recv - clientT);
      this.samples.push({ rtt, est: serverT + rtt / 2 - recv });
      if (this.samples.length > 8) this.samples.shift();
      let best = this.samples[0];
      for (const s of this.samples) if (s.rtt < best.rtt) best = s;
      this.target = best.est;
      this.rtt = best.rtt;
      if (!this.synced) {
        this.offset = this.target;
        this.synced = true;
      }
    },
    /** A snapshot stamped t proves the server clock is at least t. */
    lowerBound(t) {
      const lb = t - this.local();
      if (lb > this.target) this.target = lb + 0.01;
    },
    /** Slew towards the target offset so time never jumps visibly. */
    update(dt) {
      const diff = this.target - this.offset;
      if (Math.abs(diff) > 0.3) this.offset = this.target;
      else {
        const step = 0.05 * dt; // at most 5% faster/slower than real time
        this.offset += Math.max(-step, Math.min(step, diff));
      }
    },
  };

  // ------------------------------------------------------------------ store
  /** Holds everything about the current match as the client knows it. */
  function Store() {
    this.match = null;
    this.handlers = {}; // capture, destroyed, fleetRemoved, ack
  }
  Store.prototype.on = function (name, fn) {
    this.handlers[name] = fn;
  };
  Store.prototype.emit = function (name, a, b, c) {
    const fn = this.handlers[name];
    if (fn) fn(a, b, c);
  };

  Store.prototype.init = function (init) {
    const planets = init.planets.map(([ring, a0], id) => {
      const R = C.RINGS[ring];
      return { id, ring, a0, orbit: R.radius, w: R.omega, size: R.size, prod: R.production, cap: R.cap, owner: C.NEUTRAL, ships: 0, flash: 0 };
    });
    const players = [];
    for (const p of init.players) players[p.id] = Object.assign({ alive: true }, p);
    this.match = {
      id: init.matchId,
      you: init.you,
      players,
      playerList: init.players.map((p) => p.id),
      planets,
      fleets: new Map(),
      queue: [],
      ghosts: [],
      ackApplied: 0,
      gotFirst: false,
      ended: false,
      alive: 0xff,
    };
    Clock.reset(init.now);
  };

  /** Snapshot arrives: register fleets now, queue planet state for its time. */
  Store.prototype.receive = function (s) {
    const m = this.match;
    if (!m) return;
    Clock.lowerBound(s.t);
    if (s.a) {
      for (const e of s.a) {
        const [id, owner, x0, y0, a, t0, n, seq] = e;
        m.fleets.set(id, { id, owner, x0, y0, a, dx: Math.cos(a), dy: Math.sin(a), t0, n, seq, removeT: Infinity, reason: 0 });
        if (seq) {
          const g = m.ghosts.find((g) => g.seq === seq);
          if (g) g.real = id;
        }
      }
    }
    if (s.r) {
      for (let i = 0; i < s.r.length; i += 3) {
        const f = m.fleets.get(s.r[i]);
        if (f) {
          f.removeT = s.r[i + 2];
          f.reason = s.r[i + 1];
        }
      }
    }
    if (!m.gotFirst) {
      m.gotFirst = true;
      this.apply(s, true);
    } else {
      m.queue.push(s);
      // Background tabs don't run animation frames: fold old snapshots in silently.
      while (m.queue.length > 120) this.apply(m.queue.shift(), true);
    }
  };

  Store.prototype.apply = function (s, silent) {
    const m = this.match;
    const p = s.p;
    for (let i = 0; i < m.planets.length; i++) {
      const pl = m.planets[i];
      const owner = p[i * 2];
      const ships = p[i * 2 + 1];
      if (!silent && owner !== pl.owner) {
        if (owner === C.DESTROYED) this.emit('destroyed', pl);
        else this.emit('capture', pl, owner, pl.owner);
      }
      pl.owner = owner;
      pl.ships = ships;
    }
    if (s.c) {
      for (let i = 0; i < s.c.length; i += 2) {
        const f = m.fleets.get(s.c[i]);
        if (f) f.n = s.c[i + 1];
      }
    }
    if (s.k !== undefined) m.ackApplied = s.k;
    if (s.al !== undefined) {
      if (!silent) {
        for (const id of m.playerList) {
          const bit = 1 << id;
          if (m.alive & bit && !(s.al & bit)) this.emit('eliminated', id);
        }
      }
      m.alive = s.al;
      for (const id of m.playerList) m.players[id].alive = !!(s.al & (1 << id));
    }
  };

  /** Advance the visible state to render time t. */
  Store.prototype.advance = function (t) {
    const m = this.match;
    if (!m) return;
    while (m.queue.length && m.queue[0].t <= t) this.apply(m.queue.shift(), false);
    // Safety: never let the queue grow huge (e.g. tab in background).
    while (m.queue.length > 60) this.apply(m.queue.shift(), true);
    for (const f of m.fleets.values()) {
      if (f.removeT <= t) {
        m.fleets.delete(f.id);
        this.emit('fleetRemoved', f, f.reason, C.fleetPos(f, f.removeT));
      }
    }
    m.ghosts = m.ghosts.filter((g) => {
      if (g.seq <= m.ackApplied) return false;
      return t - g.created < 3; // give up on lost launches
    });
  };

  /** Ships on a planet as displayed, minus launches we predicted locally. */
  Store.prototype.displayShips = function (pl) {
    let s = pl.ships;
    const m = this.match;
    for (const g of m.ghosts) if (g.planet === pl.id) s -= g.n;
    return Math.max(0, s);
  };

  /** Planets / ships per player from what this client can see. */
  Store.prototype.scores = function () {
    const m = this.match;
    const rows = m.playerList.map((id) => ({ id, planets: 0, ships: 0, hidden: false, player: m.players[id] }));
    const byId = [];
    for (const r of rows) byId[r.id] = r;
    for (const pl of m.planets) {
      if (pl.owner >= 0 && byId[pl.owner]) {
        byId[pl.owner].planets++;
        byId[pl.owner].ships += pl.owner === m.you ? this.displayShips(pl) : pl.ships;
      }
    }
    for (const f of m.fleets.values()) {
      const r = byId[f.owner];
      if (!r) continue;
      if (f.n >= 0) r.ships += f.n;
      else r.hidden = true;
    }
    for (const g of m.ghosts) if (!g.real && byId[m.you]) byId[m.you].ships += g.n;
    rows.sort((a, b) => b.planets - a.planets || b.ships - a.ships);
    return rows;
  };

  // ------------------------------------------------------------------ socket
  const Net = {
    socket: null,
    store: new Store(),
    clock: Clock,
    seq: 0,
    token: null,
    connect(handlers) {
      this.token = getToken();
      // Prefer websockets; fall back to polling on restrictive school networks.
      this.socket = io({ transports: ['websocket', 'polling'] });
      const s = this.socket;
      s.on('connect', () => handlers.connect && handlers.connect());
      s.on('disconnect', () => handlers.disconnect && handlers.disconnect());
      s.on('room', (r) => handlers.room && handlers.room(r));
      s.on('init', (init) => {
        this.store.init(init);
        this.pingBurst();
        handlers.init && handlers.init(init);
      });
      s.on('s', (snap) => this.store.receive(snap));
      s.on('end', (res) => handlers.end && handlers.end(res));
      s.on('kicked', (msg) => handlers.kicked && handlers.kicked(msg));
      setInterval(() => {
        if (this.store.match && !this.store.match.ended) this.ping();
      }, 2000);
    },
    ping() {
      if (!this.socket || !this.socket.connected) return;
      this.socket.emit('ping2', Clock.local(), (r) => {
        if (Array.isArray(r) && this.store.match) Clock.addSample(r[0], r[1]);
      });
    },
    pingBurst() {
      for (let i = 0; i < 4; i++) setTimeout(() => this.ping(), i * 150);
    },
    request(event, data) {
      return new Promise((resolve) => {
        if (!this.socket || !this.socket.connected) return resolve({ ok: false, error: 'Not connected to the server yet' });
        const timer = setTimeout(() => resolve({ ok: false, error: 'Server did not answer' }), 6000);
        this.socket.emit(event, Object.assign({ token: this.token }, data || {}), (res) => {
          clearTimeout(timer);
          resolve(res || { ok: true });
        });
      });
    },
    send(event, data) {
      if (this.socket) this.socket.emit(event, data);
    },
    /**
     * Launch with instant local feedback: a "ghost" fleet appears at once and
     * the planet count drops; both reconcile with the server's snapshot.
     */
    launch(planet, angle, pctIndex, renderT) {
      const m = this.store.match;
      if (!m || planet.owner !== m.you) return false;
      const n = Math.floor(Math.floor(this.store.displayShips(planet)) * C.LAUNCH_PCTS[pctIndex]);
      if (n < 1) return false;
      this.seq = Math.max(this.seq, m.ackApplied) + 1;
      const seq = this.seq;
      // The server will launch roughly INTERP_DELAY + rtt/2 after what we see.
      const t0 = renderT + C.INTERP_DELAY + Clock.rtt / 2;
      const pos = C.planetPos(planet, t0);
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const off = planet.size + C.FLEET_RADIUS + C.LAUNCH_GAP;
      m.ghosts.push({ seq, planet: planet.id, n, owner: m.you, x0: pos.x + dx * off, y0: pos.y + dy * off, dx, dy, a: angle, t0, created: renderT, real: 0 });
      this.socket.emit('launch', [planet.id, Math.round(angle * 1e4) / 1e4, pctIndex, seq]);
      return true;
    },
  };

  function getToken() {
    let t = null;
    try {
      t = localStorage.getItem('ow_token');
    } catch (e) {}
    if (!t || !/^[A-Za-z0-9_-]{8,64}$/.test(t)) {
      t = '';
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      const arr = new Uint32Array(24);
      (window.crypto || window.msCrypto).getRandomValues(arr);
      for (const v of arr) t += chars[v % chars.length];
      try {
        localStorage.setItem('ow_token', t);
      } catch (e) {}
    }
    return t;
  }

  window.Net = Net;
})();
