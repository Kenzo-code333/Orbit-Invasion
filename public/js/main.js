/**
 * Orbit Wars client — glue: wires network events, UI buttons, input,
 * effects and the 60fps render loop together.
 */
(function () {
  'use strict';
  const C = window.OW;
  const { $ } = UI;
  const store = Net.store;
  const Fx = Render.Fx;

  const state = {
    room: null, // latest 'room' payload
    code: null, // room we believe we're in (for auto-rejoin after a drop)
    result: null,
    lastT: null, // previous render time (to detect flare crossings, countdown)
    lastHud: 0,
    lastTick: -1,
    practiceDiff: 'normal',
  };

  // ------------------------------------------------------------ helpers
  function getName() {
    const n = $('name').value.trim().slice(0, 16);
    try {
      localStorage.setItem('ow_name', n);
    } catch (e) {}
    return n || 'Pilot';
  }
  function homeError(msg) {
    $('home-error').textContent = msg || '';
  }
  function setUrlRoom(code) {
    const url = code ? '/?room=' + code : '/';
    if (location.pathname + location.search !== url) history.replaceState(null, '', url);
  }
  function goHome(msg) {
    state.code = null;
    state.room = null;
    store.match = null;
    Input.aim = null;
    setUrlRoom(null);
    try {
      sessionStorage.removeItem('ow_room');
    } catch (e) {}
    $('join-direct').classList.add('hidden');
    UI.show('home');
    homeError(msg);
  }
  async function enterRoom(event, data) {
    Sfx.unlock();
    Sfx.click();
    homeError('');
    const res = await Net.request(event, Object.assign({ name: getName() }, data));
    if (!res.ok) return homeError(res.error || 'Something went wrong');
    state.code = res.code;
    setUrlRoom(res.code);
    try {
      sessionStorage.setItem('ow_room', res.code);
    } catch (e) {}
  }

  // ------------------------------------------------------------ home
  try {
    $('name').value = localStorage.getItem('ow_name') || '';
  } catch (e) {}
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (urlRoom) {
    $('join-direct').classList.remove('hidden');
    $('direct-code').textContent = urlRoom;
    $('code').value = urlRoom;
  }
  $('btn-join-direct').onclick = () => enterRoom('join', { code: urlRoom });
  $('btn-create').onclick = () => enterRoom('create');
  $('btn-join').onclick = () => {
    const code = $('code').value.trim().toUpperCase();
    if (!code) return homeError('Type the room code first');
    enterRoom('join', { code });
  };
  $('code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());
  $('name').addEventListener('keydown', (e) => e.key === 'Enter' && (urlRoom ? $('btn-join-direct') : $('btn-create')).click());
  document.querySelectorAll('#practice-diff button').forEach((b) =>
    b.addEventListener('click', () => {
      state.practiceDiff = b.dataset.v;
      document.querySelectorAll('#practice-diff button').forEach((x) => x.classList.toggle('on', x === b));
    }));
  $('btn-practice').onclick = () => enterRoom('practice', { difficulty: state.practiceDiff, bots: parseInt($('practice-bots').value, 10) });
  $('btn-howto').onclick = () => $('howto').classList.remove('hidden');
  $('btn-howto-close').onclick = () => {
    $('howto').classList.add('hidden');
    try {
      localStorage.setItem('ow_seen_howto', '1');
    } catch (e) {}
  };
  try {
    if (!localStorage.getItem('ow_seen_howto')) $('howto').classList.remove('hidden');
  } catch (e) {}

  // ------------------------------------------------------------ lobby
  const lobbyHandlers = {
    removeBot: (slot) => Net.request('removeBot', { slot }),
    botDiff: (slot, difficulty) => Net.request('botDiff', { slot, difficulty }),
  };
  $('btn-add-bot').onclick = async () => {
    Sfx.click();
    const r = await Net.request('addBot', { difficulty: $('bot-diff').value });
    $('lobby-error').textContent = r.ok ? '' : r.error;
  };
  $('btn-start').onclick = async () => {
    Sfx.unlock();
    Sfx.click();
    const r = await Net.request('start');
    $('lobby-error').textContent = r.ok ? '' : r.error;
  };
  $('btn-copy').onclick = () => {
    const input = $('share-link');
    const done = () => {
      $('btn-copy').textContent = 'Copied!';
      setTimeout(() => ($('btn-copy').textContent = 'Copy link'), 1500);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, () => fallbackCopy(input, done));
    else fallbackCopy(input, done);
  };
  function fallbackCopy(input, done) {
    input.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {}
  }
  $('btn-leave-lobby').onclick = () => {
    Net.send('leave');
    goHome();
  };

  // ------------------------------------------------------------ in-game buttons
  document.querySelectorAll('#pcts button').forEach((b) =>
    b.addEventListener('click', () => Input.setPct(parseInt(b.dataset.i, 10))));
  Input.onPct = (i) => UI.setPct(i);
  UI.setPct(Input.pct);

  function syncMute() {
    $('btn-mute').textContent = Sfx.isMuted() ? '🔇' : '🔊';
  }
  $('btn-mute').onclick = () => {
    Sfx.setMuted(!Sfx.isMuted());
    syncMute();
  };
  syncMute();
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'm' || e.key === 'M') $('btn-mute').click();
  });

  const fsEl = document.documentElement;
  const canFs = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen;
  if (!canFs) $('btn-full').classList.add('hidden');
  $('btn-full').onclick = () => {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
  };
  document.addEventListener('fullscreenchange', () => setTimeout(Render.resize, 100));
  document.addEventListener('webkitfullscreenchange', () => setTimeout(Render.resize, 100));

  $('btn-menu').onclick = () => {
    const m = store.match;
    const playing = m && !m.ended && m.you >= 0 && m.players[m.you] && m.players[m.you].alive;
    if (playing && !confirm('Leave the match? A bot will take over your planets.')) return;
    Net.send('leave');
    goHome();
  };
  $('btn-again').onclick = () => {
    Sfx.click();
    Net.send('toLobby');
  };
  $('btn-end-leave').onclick = () => {
    Net.send('leave');
    goHome();
  };

  // ------------------------------------------------------------ network
  Net.connect({
    connect() {
      $('conn-status').textContent = 'Connected';
      // Reloaded the page mid-game? Jump straight back in.
      let last = null;
      try {
        last = sessionStorage.getItem('ow_room');
      } catch (e) {}
      if (!state.code && urlRoom && last === urlRoom) {
        enterRoom('join', { code: urlRoom });
        return;
      }
      // Socket.IO reconnected after a drop: re-attach to our room.
      if (state.code) Net.request('join', { code: state.code, name: getName() }).then((r) => !r.ok && goHome('The room closed.'));
    },
    disconnect() {
      $('conn-status').textContent = 'Reconnecting…';
      if (UI.screen === 'game') UI.toast('Connection lost — reconnecting…', 4000);
    },
    room(r) {
      const prev = state.room;
      state.room = r;
      state.code = r.code;
      setUrlRoom(r.code);
      if (r.state === 'lobby') {
        store.match = null;
        state.result = null;
        UI.show('lobby');
        UI.renderLobby(r, lobbyHandlers);
      } else if (UI.screen !== 'game' && store.match) UI.show('game');
      if (prev && r.state !== 'lobby' && prev.slots) {
        // Tell everyone when a player drops or comes back.
        r.slots.forEach((s, i) => {
          const p = prev.slots[i];
          if (s && p && !s.bot && p.connected !== s.connected) UI.toast(`${s.name} ${s.connected ? 'reconnected' : 'disconnected — a bot took over'}`);
        });
      }
    },
    init() {
      state.lastT = null;
      state.result = null;
      Input.aim = null;
      $('end').classList.add('hidden');
      UI.show('game');
      UI.banner(null);
      Render.resize();
    },
    end(res) {
      const m = store.match;
      if (!m) return;
      m.ended = true;
      m.endT = res.endTime;
      state.result = res;
      Input.aim = null;
      setTimeout(() => {
        if (state.result !== res) return;
        UI.banner(null);
        UI.showEnd(res, m.you);
        if (m.you >= 0 && res.winner === m.you) Sfx.win();
        else Sfx.lose();
      }, 900);
    },
    kicked(msg) {
      goHome(msg);
    },
  });

  // ------------------------------------------------------------ store events → effects
  store.on('capture', (pl, owner, prev) => {
    const m = store.match;
    const t = renderTime();
    const pos = C.planetPos(pl, t);
    const color = m.players[owner] ? m.players[owner].color : '#fff';
    Fx.ring(pos.x, pos.y, color, pl.size, pl.size * 3.2, 0.7, 4);
    Fx.burst(pos.x, pos.y, color, 26, 160, 0.9);
    pl.flash = 1;
    if (owner === m.you) Sfx.capture(true);
    else if (prev === m.you) Sfx.lost();
    else Sfx.capture(false);
  });
  store.on('destroyed', (pl) => {
    const pos = C.planetPos(pl, renderTime());
    const m = store.match;
    Fx.implode(pos.x, pos.y, '#ffb347', 40, pl.size * 2.5);
    Fx.ring(pos.x, pos.y, '#ff7b00', pl.size * 3, 0, 0.6, 3);
    Sfx.swallow();
    if (pl.owner === m.you) UI.toast('The sun swallowed one of your planets!');
  });
  store.on('fleetRemoved', (f, reason, pos) => {
    const m = store.match;
    const color = m.players[f.owner] ? m.players[f.owner].color : '#fff';
    switch (reason) {
      case C.REMOVE.SUN:
      case C.REMOVE.FLARE:
        Fx.burst(pos.x, pos.y, '#ff9a3c', 14, 120, 0.7);
        if (reason === C.REMOVE.SUN) Sfx.burn();
        break;
      case C.REMOVE.INTERCEPT:
        Fx.burst(pos.x, pos.y, '#ffffff', 16, 140, 0.5);
        Fx.burst(pos.x, pos.y, color, 10, 100, 0.6);
        Fx.ring(pos.x, pos.y, '#ffffff', 2, 22, 0.35, 2);
        Sfx.intercept();
        break;
      case C.REMOVE.LAND:
        Fx.burst(pos.x, pos.y, color, 8, 80, 0.4);
        break;
      default:
        break;
    }
  });
  store.on('eliminated', (id) => {
    const m = store.match;
    const p = m.players[id];
    if (!p) return;
    if (id === m.you) {
      Sfx.eliminated();
      UI.toast('You were eliminated — now spectating with full vision', 4000);
    } else UI.toast(p.name + ' was eliminated');
  });

  // ------------------------------------------------------------ input
  Input.getState = () => (store.match ? { store, t: renderTime() } : null);
  Input.onLaunch = (planet, angle, pctIndex) => {
    const m = store.match;
    if (!m || m.ended || renderTime() < 0) return;
    if (Net.launch(planet, angle, pctIndex, renderTime())) Sfx.launch();
    else UI.toast('Not enough ships on that planet', 1200);
  };

  // ------------------------------------------------------------ main loop
  function renderTime() {
    const m = store.match;
    let t = Net.clock.now() - C.INTERP_DELAY;
    if (m && m.ended && m.endT !== undefined) t = Math.min(t, m.endT);
    return t;
  }

  const canvas = $('game');
  Render.init(canvas);
  Input.attach(canvas);

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    Net.clock.update(dt);
    const m = store.match;
    let t = 0;
    if (m) {
      t = renderTime();
      store.advance(t);
      timeEvents(t);
      if (now - state.lastHud > 200) {
        state.lastHud = now;
        UI.updateHud(store, t, state.room);
      }
    }
    Render.draw(store, t, Input.aim && m && Input.aim.planet.owner === m.you ? Input.aim : null, dt, now / 1000);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** Countdown, flare warnings and flare/sun effects driven by match time. */
  function timeEvents(t) {
    const m = store.match;
    const prev = state.lastT === null ? t : state.lastT;
    state.lastT = t;
    if (m.ended) return;

    if (t < 0) {
      const n = Math.ceil(-t);
      UI.banner(String(n), 'big', m.you >= 0 ? 'Drag from your glowing planet to launch' : 'Spectating — you will join next round');
      if (Math.ceil(-prev) !== n) Sfx.countdown(false);
      return;
    }
    if (prev < 0 && t >= 0) {
      Sfx.countdown(true);
      UI.banner('GO!', 'big');
      state.goUntil = t + 1;
      return;
    }
    if (state.goUntil && t < state.goUntil) return;
    state.goUntil = 0;

    const nf = C.nextFlareTime(t);
    const left = nf - t;
    // Flare happened between prev and t?
    const crossed = C.nextFlareTime(prev);
    if (crossed !== Infinity && prev < crossed && t >= crossed) {
      const fr = C.flareRadius(crossed);
      Fx.ring(0, 0, '#ffb347', C.sunRadius(t), fr, 1.0, 10);
      Fx.ring(0, 0, '#ff5a1a', C.sunRadius(t), fr * 1.15, 1.3, 5);
      Fx.flash('#ff9a3c', 0.45);
      Sfx.flare();
    }
    if (left <= C.FLARE_WARNING) {
      const sec = Math.ceil(left);
      UI.banner('SOLAR FLARE IN ' + sec, 'flare', 'Fleets near the sun will be destroyed!');
      if (sec !== state.lastTick && sec <= 5) Sfx.flareTick(sec <= 1);
      state.lastTick = sec;
    } else if (t > C.SUN_EXPAND_START && t < C.SUN_EXPAND_START + 4) {
      UI.banner('THE SUN IS EXPANDING', 'flare', 'The inner ring will be swallowed');
    } else if (m.you < 0) {
      UI.banner(null, null, 'Spectating — you will join next round');
    } else if (m.players[m.you] && !m.players[m.you].alive) {
      UI.banner(null, null, 'Eliminated — spectating with full vision');
    } else UI.banner(null);
  }

  window.addEventListener('beforeunload', () => {
    /* tokens persist in localStorage, so a reload rejoins automatically via ?room= */
  });
})();
