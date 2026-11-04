/**
 * Orbit Wars client — DOM screens: home, lobby, HUD, end screen, overlays.
 * Pure view code: main.js decides when to call these.
 */
(function () {
  'use strict';
  const C = window.OW;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (sec) => {
    sec = Math.max(0, Math.ceil(sec));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  const UI = {
    $,
    esc,
    fmt,
    screen: 'home',

    show(screen) {
      this.screen = screen;
      $('home').classList.toggle('hidden', screen !== 'home');
      $('lobby').classList.toggle('hidden', screen !== 'lobby');
      $('hud').classList.toggle('hidden', screen !== 'game');
      if (screen !== 'game') $('end').classList.add('hidden');
    },

    // ------------------------------------------------------------ lobby
    renderLobby(room, handlers) {
      $('lobby-code').textContent = room.code;
      const link = location.origin + '/?room=' + room.code;
      $('share-link').value = link;
      const list = $('player-list');
      const filled = room.slots.filter(Boolean);
      $('player-count').textContent = `(${filled.length}/${C.MAX_PLAYERS})`;
      let html = '';
      room.slots.forEach((s, i) => {
        if (!s) return;
        const tags = [];
        if (s.i === room.you && !s.bot) tags.push('<span class="tag you">you</span>');
        if (s.host) tags.push('<span class="tag host">host</span>');
        if (s.bot) {
          if (room.isHost) {
            tags.push(`<select data-slot="${i}" class="bot-diff">${C.DIFFICULTIES.map((d) => `<option value="${d}"${d === s.difficulty ? ' selected' : ''}>${d}</option>`).join('')}</select>`);
            tags.push(`<button class="x-btn" data-remove="${i}" title="Remove bot" aria-label="Remove bot">✕</button>`);
          } else tags.push(`<span class="tag">bot · ${s.difficulty}</span>`);
        } else if (!s.connected) tags.push('<span class="tag">offline</span>');
        html += `<li><span class="swatch" style="background:${s.color};color:${s.color}"></span><span class="pname">${esc(s.name)}</span>${tags.join('')}</li>`;
      });
      const empty = C.MAX_PLAYERS - filled.length;
      if (empty > 0) html += `<li class="empty">${empty} open slot${empty > 1 ? 's' : ''} — share the link or add bots</li>`;
      list.innerHTML = html;
      list.querySelectorAll('[data-remove]').forEach((b) =>
        b.addEventListener('click', () => handlers.removeBot(parseInt(b.dataset.remove, 10))));
      list.querySelectorAll('select.bot-diff').forEach((sel) =>
        sel.addEventListener('change', () => handlers.botDiff(parseInt(sel.dataset.slot, 10), sel.value)));
      $('spectator-line').textContent = room.spectators.length ? 'Spectating: ' + room.spectators.join(', ') : '';
      $('host-controls').classList.toggle('hidden', !room.isHost);
      $('waiting-host').classList.toggle('hidden', room.isHost);
      $('btn-start').disabled = filled.length < C.MIN_PLAYERS;
      $('btn-add-bot').disabled = filled.length >= C.MAX_PLAYERS;
    },

    // ------------------------------------------------------------ HUD
    updateHud(store, t, room) {
      const m = store.match;
      const tt = Math.max(0, t);
      $('hud-timer').textContent = fmt(C.MATCH_DURATION - tt);
      const nf = C.nextFlareTime(tt);
      const flareEl = $('hud-flare');
      if (nf === Infinity) {
        flareEl.textContent = 'No more flares';
        flareEl.classList.remove('warn');
      } else {
        flareEl.textContent = 'Flare in ' + fmt(nf - tt);
        flareEl.classList.toggle('warn', nf - tt <= C.FLARE_WARNING);
      }
      const sunEl = $('hud-sun');
      if (tt > C.SUN_EXPAND_START - 30) {
        sunEl.classList.remove('hidden');
        if (tt < C.SUN_EXPAND_START) sunEl.textContent = '☀ Sun expands in ' + fmt(C.SUN_EXPAND_START - tt);
        else if (C.sunRadius(tt) < C.SUN_MAX_RADIUS) sunEl.textContent = '☀ Sun expanding!';
        else sunEl.textContent = '☀ Sun at full size';
      } else sunEl.classList.add('hidden');

      // Scoreboard (only what this player can actually know).
      const rows = store.scores();
      const slots = room && room.slots ? room.slots : [];
      let html = '<div class="sr head"><span></span><span>Player</span><span>🪐</span><span>Ships</span></div>';
      for (const r of rows) {
        const s = slots[r.id];
        const tag = s && !s.bot && s.botControlled ? ' 🤖' : '';
        const ships = r.ships + (r.hidden && r.id !== m.you ? '+?' : '');
        html += `<div class="sr${r.player.alive ? '' : ' dead'}${r.id === m.you ? ' me' : ''}"><span class="dot" style="background:${r.player.color}"></span><span class="sn">${esc(r.player.name)}${tag}</span><span class="sp">${r.planets}</span><span class="ss">${ships}</span></div>`;
      }
      $('scoreboard').innerHTML = html;
      $('pcts').classList.toggle('hidden', m.you < 0 || !(m.players[m.you] && m.players[m.you].alive) || m.ended);
    },

    setPct(i) {
      document.querySelectorAll('#pcts button').forEach((b) => b.classList.toggle('on', parseInt(b.dataset.i, 10) === i));
    },

    banner(text, cls, sub) {
      const b = $('banner');
      if (!text) {
        b.classList.add('hidden');
      } else {
        b.textContent = text;
        b.className = 'banner' + (cls ? ' ' + cls : '');
      }
      const s = $('hud-sub');
      if (sub) {
        s.textContent = sub;
        s.classList.remove('hidden');
      } else s.classList.add('hidden');
    },

    toast(msg, ms) {
      const el = $('toast');
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2500);
    },

    // ------------------------------------------------------------ end
    showEnd(res, you) {
      const winner = res.stats.find((s) => s.id === res.winner);
      const title = $('end-title');
      if (you >= 0 && res.winner === you) {
        title.textContent = 'Victory!';
        title.style.color = '#ffd166';
      } else if (winner) {
        title.textContent = winner.name + ' wins';
        title.style.color = winner.color;
      } else {
        title.textContent = 'Draw';
        title.style.color = '#fff';
      }
      const reasons = {
        domination: 'controlled 60% of the planets',
        elimination: 'last one standing',
        time: 'most planets when time ran out',
        'humans-out': 'all human players were eliminated',
      };
      $('end-sub').textContent = (winner ? winner.name + ' — ' : '') + (reasons[res.reason] || '') + ' · ' + fmt(res.duration);
      const rows = res.stats.slice().sort((a, b) => (b.id === res.winner) - (a.id === res.winner) || b.planets - a.planets || b.captured - a.captured);
      $('end-stats').innerHTML = rows
        .map((s) => `<tr class="${s.id === res.winner ? 'winner' : ''}"><td><span class="swatch" style="background:${s.color}"></span>${esc(s.name)}${s.id === you ? ' (you)' : ''}${s.human ? '' : ' 🤖'}</td><td>${s.planets}</td><td>${s.captured}</td><td>${s.destroyed}</td><td>${s.launched}</td></tr>`)
        .join('');
      $('end').classList.remove('hidden');
    },
  };

  window.UI = UI;
})();
