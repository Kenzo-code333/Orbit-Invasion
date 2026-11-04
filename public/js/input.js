/**
 * Orbit Wars client — mouse / touch / keyboard input.
 *
 * Drag from one of your planets and release to launch toward the release
 * point. Pointer Events cover mouse, touch and pen with one code path.
 */
(function () {
  'use strict';
  const C = window.OW;

  const Input = {
    aim: null, // {planet, wx, wy, pct, pointerId}
    pct: 1, // index into C.LAUNCH_PCTS (default 50%)
    hover: null,
    onLaunch: null, // (planet, angle, pctIndex) => void
    onPct: null,
    getState: null, // () => {store, t}
  };

  function eventPos(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Own planet closest to a screen point (generous radius for fingers). */
  function pickOwnPlanet(sx, sy, touch) {
    const st = Input.getState();
    if (!st || !st.store.match) return null;
    const m = st.store.match;
    let best = null;
    let bestD = Infinity;
    for (const p of m.planets) {
      if (p.owner !== m.you || m.you < 0) continue;
      const wp = C.planetPos(p, st.t);
      const s = Render.toScreen(wp.x, wp.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      const reach = Render.planetPx(p) + (touch ? 26 : 12);
      if (d < reach && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best;
  }

  Input.attach = function (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      if (Input.aim) return; // one aim at a time
      const pos = eventPos(canvas, e);
      const planet = pickOwnPlanet(pos.x, pos.y, e.pointerType !== 'mouse');
      if (!planet) return;
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (err) {}
      const w = Render.toWorld(pos.x, pos.y);
      Input.aim = { planet, wx: w.x, wy: w.y, pct: Input.pct, pointerId: e.pointerId, sx: pos.x, sy: pos.y, moved: false };
      if (window.Sfx) Sfx.unlock();
    });

    canvas.addEventListener('pointermove', (e) => {
      const pos = eventPos(canvas, e);
      const a = Input.aim;
      if (a && e.pointerId === a.pointerId) {
        const w = Render.toWorld(pos.x, pos.y);
        a.wx = w.x;
        a.wy = w.y;
        a.pct = Input.pct;
        if (Math.hypot(pos.x - a.sx, pos.y - a.sy) > 6) a.moved = true;
      } else if (e.pointerType === 'mouse') {
        Input.hover = pickOwnPlanet(pos.x, pos.y, false);
        canvas.style.cursor = Input.hover ? 'grab' : 'default';
      }
    });

    const finish = (e, cancel) => {
      const a = Input.aim;
      if (!a || e.pointerId !== a.pointerId) return;
      Input.aim = null;
      if (cancel) return;
      const st = Input.getState();
      if (!st || a.planet.owner !== st.store.match.you) return;
      // Released on/near the planet itself = cancel.
      const wp = C.planetPos(a.planet, st.t);
      const s = Render.toScreen(wp.x, wp.y);
      const pos = eventPos(canvas, e);
      if (Math.hypot(pos.x - s.x, pos.y - s.y) < Render.planetPx(a.planet) + 8) return;
      const w = Render.toWorld(pos.x, pos.y);
      const angle = Math.atan2(w.y - wp.y, w.x - wp.x);
      if (Input.onLaunch) Input.onLaunch(a.planet, angle, Input.pct);
    };
    canvas.addEventListener('pointerup', (e) => finish(e, false));
    canvas.addEventListener('pointercancel', (e) => finish(e, true));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        Input.setPct(parseInt(e.key, 10) - 1);
      } else if (e.key === 'Escape') {
        Input.aim = null;
      }
    });
  };

  Input.setPct = function (i) {
    Input.pct = i;
    if (Input.aim) Input.aim.pct = i;
    if (Input.onPct) Input.onPct(i);
  };

  window.Input = Input;
})();
