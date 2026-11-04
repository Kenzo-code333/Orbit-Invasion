/**
 * Orbit Wars client — Canvas 2D rendering and visual effects.
 *
 * Performance notes (low-end Chromebooks / phones):
 *  - The starfield is pre-rendered once per resize.
 *  - Glows are pre-rendered sprites drawn with 'lighter', never shadowBlur.
 *  - Device pixel ratio is capped and lowered automatically if frames are slow.
 *  - Particles come from a fixed-size pool.
 */
(function () {
  'use strict';
  const C = window.OW;
  const TAU = Math.PI * 2;

  const view = { w: 0, h: 0, dpr: 1, scale: 1, cx: 0, cy: 0, ui: 1, topPad: 0, bottomPad: 0 };
  let canvas, ctx, stars, glowCache = {}, spriteCache = {};
  let frameDt = 1 / 60;
  let maxDpr = Math.min(window.devicePixelRatio || 1, (navigator.hardwareConcurrency || 4) <= 4 ? 1.5 : 2);
  let quality = 1; // 1 = full, 0 = reduced effects
  const perf = { acc: 0, frames: 0, slow: 0 };

  // ------------------------------------------------------------------ setup
  function init(cv) {
    canvas = cv;
    ctx = canvas.getContext('2d', { alpha: false });
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    view.w = Math.max(1, rect.width);
    view.h = Math.max(1, rect.height);
    view.dpr = maxDpr;
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    // Leave room for the HUD bars on top/bottom of narrow (portrait) screens.
    const portrait = view.h > view.w * 1.15;
    view.topPad = portrait ? 92 : 8;
    view.bottomPad = portrait ? 78 : 8;
    const availH = view.h - view.topPad - view.bottomPad;
    view.scale = Math.min(view.w, availH) / (2 * C.VIEW_RADIUS);
    view.cx = view.w / 2;
    view.cy = view.topPad + availH / 2;
    view.ui = Math.max(0.8, Math.min(1.35, view.scale * 2));
    spriteCache = {};
    buildStars();
  }

  function buildStars() {
    const w = canvas.width;
    const h = canvas.height;
    stars = document.createElement('canvas');
    stars.width = w;
    stars.height = h;
    const g = stars.getContext('2d');
    const bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#0d1026');
    bg.addColorStop(1, '#03040b');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const rng = C.makeRng(1234);
    // Soft nebula clouds.
    const nebulae = [['rgba(110,60,200,0.10)'], ['rgba(40,120,220,0.08)'], ['rgba(200,60,120,0.06)']];
    for (const [col] of nebulae) {
      const x = rng() * w;
      const y = rng() * h;
      const r = (0.3 + rng() * 0.4) * Math.max(w, h);
      const ng = g.createRadialGradient(x, y, 0, x, y, r);
      ng.addColorStop(0, col);
      ng.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = ng;
      g.fillRect(0, 0, w, h);
    }
    // Three depth layers of stars.
    const count = Math.min(1600, Math.round((w * h) / 1400));
    for (let i = 0; i < count; i++) {
      const layer = rng();
      const size = layer < 0.7 ? 0.6 : layer < 0.95 ? 1.1 : 1.8;
      const a = layer < 0.7 ? 0.25 + rng() * 0.3 : 0.5 + rng() * 0.5;
      const tint = rng();
      g.fillStyle = tint < 0.15 ? `rgba(170,200,255,${a})` : tint < 0.25 ? `rgba(255,220,180,${a})` : `rgba(255,255,255,${a})`;
      g.fillRect(rng() * w, rng() * h, size * view.dpr, size * view.dpr);
    }
    view.twinkles = [];
    for (let i = 0; i < 40; i++) view.twinkles.push({ x: rng() * view.w, y: rng() * view.h, p: rng() * TAU, s: 0.5 + rng() * 1.5 });
  }

  /** Radial glow sprite for a colour, cached. */
  function glow(color) {
    if (glowCache[color]) return glowCache[color];
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, hexA(color, 0.9));
    gr.addColorStop(0.35, hexA(color, 0.35));
    gr.addColorStop(1, hexA(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    glowCache[color] = c;
    return c;
  }

  /**
   * Pre-rendered planet body (lit from the left). Drawn rotated so the lit
   * side faces the sun: one drawImage per planet instead of a new gradient.
   */
  function planetSprite(color, owned, r) {
    const key = color + (owned ? '1' : '0') + Math.round(r * 4);
    let c = spriteCache[key];
    if (c) return c;
    const d = view.dpr;
    const size = Math.ceil((r * 2 + 2) * d);
    c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const m = size / 2;
    const rr = r * d;
    const gr = g.createRadialGradient(m - rr * 0.45, m, rr * 0.1, m, m, rr);
    gr.addColorStop(0, owned ? hexA(color, 0.95) : '#9aa3b5');
    gr.addColorStop(0.7, owned ? hexA(color, 0.45) : '#3c4456');
    gr.addColorStop(1, '#141826');
    g.fillStyle = '#141826';
    g.beginPath();
    g.arc(m, m, rr, 0, TAU);
    g.fill();
    g.fillStyle = gr;
    g.fill();
    spriteCache[key] = c;
    return c;
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ------------------------------------------------------------------ coords
  const toScreen = (x, y) => ({ x: view.cx + x * view.scale, y: view.cy + y * view.scale });
  const toWorld = (sx, sy) => ({ x: (sx - view.cx) / view.scale, y: (sy - view.cy) / view.scale });
  /** On-screen radius of a planet; small screens get a minimum so planets stay tappable. */
  const MIN_PX = [8, 11, 14];
  const planetPx = (p) => Math.max(p.size * view.scale, MIN_PX[p.ring] * view.ui);

  // ------------------------------------------------------------------ effects
  const POOL = 400;
  const parts = [];
  for (let i = 0; i < POOL; i++) parts.push({ life: 0 });
  const rings = [];
  let flash = { a: 0, color: '#fff' };

  const Fx = {
    burst(x, y, color, count, speed, life) {
      count = Math.round(count * (quality ? 1 : 0.4));
      for (let i = 0, n = 0; i < POOL && n < count; i++) {
        const p = parts[i];
        if (p.life > 0) continue;
        const a = Math.random() * TAU;
        const v = speed * (0.3 + Math.random() * 0.7);
        p.x = x;
        p.y = y;
        p.vx = Math.cos(a) * v;
        p.vy = Math.sin(a) * v;
        p.life = p.max = (life || 0.8) * (0.6 + Math.random() * 0.4);
        p.color = color;
        p.size = 1.5 + Math.random() * 2;
        n++;
      }
    },
    /** Implosion: particles fly inward to a point. */
    implode(x, y, color, count, radius) {
      for (let i = 0, n = 0; i < POOL && n < count; i++) {
        const p = parts[i];
        if (p.life > 0) continue;
        const a = Math.random() * TAU;
        const r = radius * (0.8 + Math.random() * 0.6);
        p.x = x + Math.cos(a) * r;
        p.y = y + Math.sin(a) * r;
        p.vx = -Math.cos(a) * r * 1.6;
        p.vy = -Math.sin(a) * r * 1.6;
        p.life = p.max = 0.6;
        p.color = color;
        p.size = 2;
        n++;
      }
    },
    ring(x, y, color, r0, r1, dur, width) {
      if (rings.length > 40) rings.shift();
      rings.push({ x, y, color, r0, r1, t: 0, dur, width: width || 3 });
    },
    flash(color, a) {
      flash = { color, a: a || 0.6 };
    },
    update(dt) {
      for (const p of parts) {
        if (p.life <= 0) continue;
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - 1.5 * dt;
        p.vy *= 1 - 1.5 * dt;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        rings[i].t += dt;
        if (rings[i].t >= rings[i].dur) rings.splice(i, 1);
      }
      flash.a = Math.max(0, flash.a - dt * 1.2);
    },
  };

  // ------------------------------------------------------------------ draw
  /**
   * @param store  Net.store
   * @param t      render time (server match seconds, already delayed)
   * @param aim    null | {planet, wx, wy, pct}
   * @param dt     frame delta seconds
   */
  function draw(store, t, aim, dt, wallT) {
    const m = store.match;
    frameDt = dt;
    adaptQuality(dt);
    Fx.update(dt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(stars, 0, 0);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawTwinkles(wallT);
    if (!m) return drawBackdrop(wallT);

    const S = view.scale;
    const sun = toScreen(0, 0);
    const sunR = C.sunRadius(t);

    // Orbit rings (faint guides for leading shots).
    ctx.lineWidth = 1;
    for (const ring of C.RINGS) {
      if (ring.radius <= sunR) continue;
      ctx.strokeStyle = 'rgba(140,170,255,0.10)';
      ctx.beginPath();
      ctx.arc(sun.x, sun.y, ring.radius * S, 0, TAU);
      ctx.stroke();
    }
    // Map edge.
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, C.MAP_RADIUS * S, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    // Flare danger zone during the warning.
    const nf = C.nextFlareTime(t);
    const toFlare = nf - t;
    if (toFlare <= C.FLARE_WARNING && t > 0) {
      const fr = C.flareRadius(nf) * S;
      const pulse = 0.5 + 0.5 * Math.sin(wallT * (toFlare < 3 ? 18 : 8));
      ctx.fillStyle = `rgba(255,90,20,${0.05 + 0.06 * pulse})`;
      ctx.beginPath();
      ctx.arc(sun.x, sun.y, fr, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,120,40,${0.4 + 0.4 * pulse})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.lineDashOffset = -wallT * 30;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawSun(sun, sunR * S, t, wallT, toFlare);

    // Fleets.
    for (const f of m.fleets.values()) {
      if (f.t0 > t) continue;
      drawFleet(C.fleetPos(f, t), f, m.players[f.owner], t, 1);
    }
    for (const g of m.ghosts) {
      const real = g.real && m.fleets.get(g.real);
      if (real && real.t0 <= t) continue;
      drawFleet(C.fleetPos(g, Math.max(t, g.t0)), g, m.players[g.owner], Math.max(t, g.t0), 0.85);
    }

    // Planets.
    for (const p of m.planets) {
      if (p.owner === C.DESTROYED) continue;
      drawPlanet(p, t, m, store, aim && aim.planet === p);
    }

    // Particles & rings.
    ctx.globalCompositeOperation = 'lighter';
    for (const p of parts) {
      if (p.life <= 0) continue;
      const s = toScreen(p.x, p.y);
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(s.x - p.size / 2, s.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const r of rings) {
      const k = r.t / r.dur;
      const s = toScreen(r.x, r.y);
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = r.width * (1 - k * 0.6);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0, (r.r0 + (r.r1 - r.r0) * easeOut(k)) * S), 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (aim) drawAim(aim, t, m, store, sunR);

    if (flash.a > 0) {
      ctx.fillStyle = flash.color;
      ctx.globalAlpha = flash.a;
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.globalAlpha = 1;
    }
  }

  /** Menu background: a slowly turning demo system. */
  function drawBackdrop(wallT) {
    const sun = toScreen(0, 0);
    const S = view.scale;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(140,170,255,0.08)';
    C.RINGS.forEach((ring, ri) => {
      ctx.beginPath();
      ctx.arc(sun.x, sun.y, ring.radius * S, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < ring.count; i++) {
        const a = (i / ring.count) * TAU + wallT * ring.omega * 2 + ri;
        const x = sun.x + Math.cos(a) * ring.radius * S;
        const y = sun.y + Math.sin(a) * ring.radius * S;
        ctx.fillStyle = i % 3 === 0 ? hexA(C.COLORS[(i + ri) % C.COLORS.length], 0.55) : 'rgba(150,160,190,0.35)';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(3, ring.size * S), 0, TAU);
        ctx.fill();
      }
    });
    drawSun(sun, C.SUN_RADIUS * S, 0, wallT, 99);
  }

  const easeOut = (k) => 1 - (1 - k) * (1 - k);

  function drawTwinkles(wallT) {
    ctx.fillStyle = '#fff';
    for (const s of view.twinkles) {
      ctx.globalAlpha = 0.25 + 0.6 * Math.max(0, Math.sin(wallT * s.s + s.p));
      ctx.fillRect(s.x, s.y, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;
  }

  function drawSun(c, r, t, wallT, toFlare) {
    const warn = toFlare <= C.FLARE_WARNING && t > 0;
    const expanding = t > C.SUN_EXPAND_START && C.sunRadius(t) < C.SUN_MAX_RADIUS;
    const pulse = 1 + 0.04 * Math.sin(wallT * 2) + (warn ? 0.06 * Math.sin(wallT * 20) : 0);
    // Outer glow.
    ctx.globalCompositeOperation = 'lighter';
    const gs = r * 4.2 * pulse;
    ctx.globalAlpha = warn ? 0.85 : 0.6;
    ctx.drawImage(glow(warn ? '#ff6a1a' : '#ffaa33'), c.x - gs / 2, c.y - gs / 2, gs, gs);
    // Corona spikes.
    if (quality) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = warn ? '#ff7b2e' : '#ffc24d';
      ctx.beginPath();
      const spikes = 14;
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * TAU + wallT * 0.15;
        const len = r * (1.25 + 0.25 * Math.sin(wallT * 1.7 + i * 2.3) + (warn ? 0.3 : 0));
        ctx.moveTo(c.x + Math.cos(a - 0.12) * r, c.y + Math.sin(a - 0.12) * r);
        ctx.lineTo(c.x + Math.cos(a) * len, c.y + Math.sin(a) * len);
        ctx.lineTo(c.x + Math.cos(a + 0.12) * r, c.y + Math.sin(a + 0.12) * r);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Core.
    const g = ctx.createRadialGradient(c.x - r * 0.2, c.y - r * 0.2, r * 0.1, c.x, c.y, r * pulse);
    g.addColorStop(0, '#fffbe6');
    g.addColorStop(0.45, warn ? '#ffb347' : '#ffd166');
    g.addColorStop(1, warn ? '#ff4500' : '#ff8c1a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * pulse, 0, TAU);
    ctx.fill();
    // Heat shimmer ring while expanding.
    if (expanding) {
      ctx.strokeStyle = `rgba(255,120,40,${0.3 + 0.2 * Math.sin(wallT * 6)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * pulse + 6 + 3 * Math.sin(wallT * 4), 0, TAU);
      ctx.stroke();
    }
  }

  function drawPlanet(p, t, m, store, aiming) {
    const wp = C.planetPos(p, t);
    const s = toScreen(wp.x, wp.y);
    const r = planetPx(p);
    const owned = p.owner >= 0 && m.players[p.owner];
    const color = owned ? m.players[p.owner].color : C.NEUTRAL_COLOR;
    if (owned) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45;
      const gs = r * 3.4;
      ctx.drawImage(glow(color), s.x - gs / 2, s.y - gs / 2, gs, gs);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    // Body, lit from the sun (cached sprite, rotated toward the sun).
    const spr = planetSprite(color, !!owned, r);
    const half = spr.width / view.dpr / 2;
    const rot = Math.atan2(-wp.y, -wp.x) - Math.PI;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(rot);
    ctx.drawImage(spr, -half, -half, half * 2, half * 2);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, TAU);
    ctx.lineWidth = owned ? 2.2 : 1;
    ctx.strokeStyle = owned ? color : 'rgba(200,210,230,0.35)';
    ctx.stroke();

    // Your planets get an extra dashed halo; the aiming one pulses.
    if (p.owner === m.you) {
      ctx.strokeStyle = aiming ? '#ffffff' : hexA(color, 0.5);
      ctx.lineWidth = aiming ? 2 : 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 5, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Capture flash.
    if (p.flash > 0) {
      p.flash = Math.max(0, p.flash - frameDt);
      ctx.strokeStyle = `rgba(255,255,255,${p.flash})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 3 + (1 - p.flash) * 10, 0, TAU);
      ctx.stroke();
    }
    // Ship count.
    const ships = Math.floor(store.displayShips(p));
    const fs = Math.max(10, Math.min(22, r * 0.8));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(ships, s.x + 1, s.y + 1.5);
    ctx.fillStyle = ships >= p.cap && owned ? '#ffe08a' : '#fff';
    ctx.fillText(ships, s.x, s.y + 0.5);
    // Production pips under the planet.
    if (r > 9) {
      ctx.fillStyle = owned ? hexA(color, 0.9) : 'rgba(200,210,230,0.4)';
      for (let i = 0; i < p.prod; i++) {
        ctx.fillRect(s.x - (p.prod - 1) * 3.5 + i * 7 - 1.5, s.y + r + 5, 3, 3);
      }
    }
  }

  function drawFleet(wp, f, player, t, alpha) {
    const s = toScreen(wp.x, wp.y);
    const color = player ? player.color : '#fff';
    const known = f.n >= 0;
    const size = (known ? 4 + Math.min(7, Math.sqrt(f.n) * 0.7) : 6) * view.ui;
    const ang = f.a;
    // Trail.
    const traveled = Math.max(0, t - f.t0) * C.FLEET_SPEED * view.scale;
    const tl = Math.min(traveled, 30 * view.ui);
    if (tl > 1) {
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.35 * alpha;
      ctx.lineWidth = size * 0.7;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - f.dx * tl * 0.5, s.y - f.dy * tl * 0.5);
      ctx.stroke();
      ctx.globalAlpha = 0.15 * alpha;
      ctx.lineWidth = size * 0.4;
      ctx.beginPath();
      ctx.moveTo(s.x - f.dx * tl * 0.5, s.y - f.dy * tl * 0.5);
      ctx.lineTo(s.x - f.dx * tl, s.y - f.dy * tl);
      ctx.stroke();
    }
    // Glow.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * alpha;
    const gs = size * 4;
    ctx.drawImage(glow(color), s.x - gs / 2, s.y - gs / 2, gs, gs);
    ctx.globalCompositeOperation = 'source-over';
    // Triangle.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(s.x + ca * size * 1.3, s.y + sa * size * 1.3);
    ctx.lineTo(s.x - ca * size * 0.8 - sa * size * 0.75, s.y - sa * size * 0.8 + ca * size * 0.75);
    ctx.lineTo(s.x - ca * size * 0.8 + sa * size * 0.75, s.y - sa * size * 0.8 - ca * size * 0.75);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Size label (or "?" when hidden by fog).
    ctx.font = `600 ${Math.round(10 * view.ui)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = known ? '#fff' : 'rgba(255,255,255,0.6)';
    ctx.fillText(known ? f.n : '?', s.x + size + 3, s.y - size);
    ctx.globalAlpha = 1;
  }

  /** Aim preview: line + flight time to the cursor. No auto-aim! */
  function drawAim(aim, t, m, store, sunR) {
    const p = aim.planet;
    const pp = C.planetPos(p, t);
    const ang = Math.atan2(aim.wy - pp.y, aim.wx - pp.x);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const off = p.size + C.FLEET_RADIUS + C.LAUNCH_GAP;
    const ox = pp.x + dx * off;
    const oy = pp.y + dy * off;
    const color = m.players[m.you] ? m.players[m.you].color : '#fff';
    const cursorDist = Math.max(0, (aim.wx - ox) * dx + (aim.wy - oy) * dy);
    // Ray vs current sun and map edge.
    const b = ox * dx + oy * dy;
    const cc = ox * ox + oy * oy;
    let sunHit = Infinity;
    const disc = b * b - (cc - (sunR + C.FLEET_RADIUS) ** 2);
    if (disc > 0) {
      const d = -b - Math.sqrt(disc);
      if (d > 0) sunHit = d;
    }
    const edge = -b + Math.sqrt(Math.max(0, b * b - (cc - C.MAP_RADIUS ** 2)));
    const end = Math.min(sunHit, edge);
    const o = toScreen(ox, oy);
    const cur = toScreen(ox + dx * Math.min(cursorDist, end), oy + dy * Math.min(cursorDist, end));
    const e = toScreen(ox + dx * end, oy + dy * end);
    ctx.lineCap = 'round';
    // Faint continuation past the cursor.
    ctx.strokeStyle = sunHit < Infinity ? 'rgba(255,80,60,0.35)' : hexA(color, 0.25);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(cur.x, cur.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    // Main segment to the cursor.
    ctx.strokeStyle = sunHit < cursorDist ? '#ff5a4a' : color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -performance.now() / 40;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (sunHit < Infinity) {
      const h = toScreen(ox + dx * sunHit, oy + dy * sunHit);
      ctx.strokeStyle = '#ff5a4a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(h.x - 7, h.y - 7);
      ctx.lineTo(h.x + 7, h.y + 7);
      ctx.moveTo(h.x + 7, h.y - 7);
      ctx.lineTo(h.x - 7, h.y + 7);
      ctx.stroke();
    }
    // Cursor reticle + labels.
    const cs = toScreen(aim.wx, aim.wy);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cs.x, cs.y, 9, 0, TAU);
    ctx.stroke();
    const eta = cursorDist / C.FLEET_SPEED;
    const n = Math.floor(Math.floor(store.displayShips(p)) * C.LAUNCH_PCTS[aim.pct]);
    const label1 = sunHit < cursorDist ? 'SUN!' : eta.toFixed(1) + 's';
    const label2 = n + ' ships';
    ctx.font = `700 ${Math.round(14 * view.ui)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    let lx = cs.x + 14;
    if (lx > view.w - 80) lx = cs.x - 84;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(lx - 4, cs.y - 34 * view.ui, 76 * view.ui, 34 * view.ui);
    ctx.fillStyle = sunHit < cursorDist ? '#ff6b5b' : '#fff';
    ctx.fillText(label1, lx, cs.y - 17 * view.ui);
    ctx.font = `500 ${Math.round(11 * view.ui)}px system-ui, sans-serif`;
    ctx.fillStyle = n >= 1 ? '#cfe3ff' : '#ff9b8f';
    ctx.fillText(label2, lx, cs.y - 3 * view.ui);
  }

  /** Lower resolution / effects automatically when frames are slow. */
  function adaptQuality(dt) {
    perf.acc += dt;
    perf.frames++;
    if (perf.acc < 1.5) return;
    const avg = perf.acc / perf.frames;
    perf.acc = 0;
    perf.frames = 0;
    if (avg > 1 / 40) {
      perf.slow++;
      if (perf.slow >= 2) {
        perf.slow = 0;
        if (maxDpr > 1) {
          maxDpr = Math.max(1, maxDpr - 0.25);
          resize();
        } else quality = 0;
      }
    } else perf.slow = 0;
  }

  window.Render = { init, resize, draw, view, toScreen, toWorld, planetPx, Fx, hexA };
})();
