# 🪐 Orbit Wars

A real-time multiplayer strategy game that runs in the browser. Planets orbit a sun and you capture them by launching fleets that fly in straight lines, so you have to **lead your shots** at moving targets. Watch out for the sun, the solar flares and the sun that starts growing at the end of the match.

- 2–8 players per match, with bots that can fill empty slots (Easy / Normal / Hard)
- Works on Chromebooks, laptops and phones, with mouse or touch
- One Node.js app with no build step: the server runs the game and also serves the web page

---

## How to play

1. **Drag** from one of your planets and let go to launch a fleet toward that point. While you drag, the label shows how many seconds the fleet needs to reach your cursor.
2. Choose how many ships to send: **25% / 50% / 100%** (on-screen buttons or keys **1 2 3**).
3. Planets keep orbiting, and inner rings move faster. **Aim ahead** of your target, because there is no auto-aim.
4. A fleet that lands fights the defenders 1-for-1. If attackers are left over, they capture the planet. A fleet that lands on your own planet adds its ships to the planet.
5. Enemy fleets that touch in space destroy each other 1-for-1. You can't see the size of an enemy fleet until it comes close to one of your planets.
6. The sun destroys any fleet that touches it. Fleets that miss and leave the map are lost.
7. Every 2 minutes a **solar flare** destroys every fleet near the sun. You get a 10-second warning first. After 6 minutes the **sun starts to grow** and swallows the inner ring.
8. You win by owning **60% of the planets**, by being the last player left, or by owning the most planets when the **10 minutes** are up.

| Ring   | Planets | Production | Max ships |
|--------|---------|------------|-----------|
| Inner  | 6 small, fast | 1 ship/s | 50 |
| Middle | 8 medium | 2 ships/s | 100 |
| Outer  | 8 large, slow | 3 ships/s | 160 |

Neutral planets start with 10–30 ships and don't produce until someone captures them.

---

## Deploy for free on Render (step by step)

You don't need to install anything. Everything below happens in the browser.

1. **Put the code on GitHub.** If it's already in your GitHub repo (for example `orbit-invasion`), skip this step.
2. Go to **https://render.com** and click **Get Started**. Sign up with your **GitHub** account.
3. In the Render dashboard click **New +** → **Web Service**.
4. Choose **Build and deploy from a Git repository**, then **Connect** your repo. If Render can't see the repo, click *Configure account* and give Render access to it.
5. Fill in the form:
   - **Name:** `orbit-wars` (this becomes part of your URL)
   - **Region:** whichever is closest to you
   - **Branch:** the branch that holds the game (usually `main`)
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
6. Click **Create Web Service**. The first build takes 1–3 minutes. When the log shows `Orbit Wars listening on ...`, the game is live.
7. Your game is at `https://orbit-wars-XXXX.onrender.com` (the link is at the top of the Render page).

> **Shortcut:** this repo includes a `render.yaml`. In Render you can choose **New + → Blueprint**, pick the repo, and click **Apply**. Render then fills in all the settings for you.

**Updating:** every time you push to that branch on GitHub, Render rebuilds and redeploys on its own.

**Free tier note:** a free Render service goes to sleep after about 15 minutes with no visitors. The next visitor waits around 30–60 seconds while it wakes up. Open the link a minute before you want to play.

---

## Playing with friends

1. Open your Render link, type a nickname and click **Create game**.
2. Click **Copy link** in the lobby and send it to your friends (chat, email, etc.). Opening the link takes them straight into your room. They can also type the 4-letter **room code** on the home screen.
3. As the host you can **add bots** (choose their difficulty) or remove them. When everyone is in, click **Start match**.
4. After the match, **Play again** takes everyone back to the same lobby.

Other things to know:
- If someone joins while a match is running, they watch until the next round.
- If someone's connection drops, a bot takes over their planets. When they open the link again (or reload the page), they get control back.
- **Practice vs bots** on the home screen starts a solo match right away.

---

## Run it in Codespaces / Claude Code / any cloud dev environment

```bash
npm install
npm start
```

The server listens on port **3000** (or on `$PORT` if that's set).

- **GitHub Codespaces:** when port 3000 pops up, click **Open in Browser**. To let friends join, open the **Ports** tab, right-click port 3000 and choose **Port Visibility → Public**, then share that URL.
- **Claude Code on the web / other cloud sandboxes:** you can run the server and the automated tests there. Most sandboxes don't give you a public URL, so to play with friends, deploy to Render as described above.

### Tests

```bash
npm test
```

This runs two scripts:
- `scripts/simulate.js`: plays full bot-vs-bot matches (2–8 players, all difficulties) as fast as possible. It checks game invariants and makes sure hidden fleet sizes never leak into snapshots.
- `scripts/socket-test.js`: starts the real server and connects real socket clients. It checks the lobby, host-only actions, validation of bad input, hidden fleet sizes, bot takeover when a player disconnects and then rejoins, spectators, the end screen and play again, practice mode, and 20 rooms running at the same time.

You can also run `npm run simulate -- 30` to simulate 30 matches.

---

## How it works (for the curious)

```
shared/constants.js   Rules + deterministic math (planet/fleet positions, sun size, flares) used by server AND browser
server/index.js       HTTP static server + Socket.IO + one global loop that runs every room
server/room.js        Lobby, slots/colours, host controls, reconnects, bots taking over, spectators
server/game.js        Authoritative 30 tick/s simulation, input validation, per-player filtered snapshots
server/bot.js         Bot AI: intercept solving, path checks (sun/flares/planets in the way), defence, attacks
public/index.html     The single page (home, lobby, HUD, end screen, how-to)
public/js/net.js      Socket wrapper, clock sync, snapshot buffer, instant launch prediction
public/js/render.js   Canvas 2D renderer + particle effects (tuned for low-end hardware)
public/js/input.js    Drag-to-aim with mouse/touch (Pointer Events), keys 1/2/3
public/js/ui.js       DOM screens and HUD
public/js/audio.js    Sound effects synthesized with the Web Audio API (no audio files)
public/js/main.js     Glue + 60 fps render loop
```

- **The server is authoritative.** Clients only send `launch [planetId, angle, pctIndex, seq]`. The server checks every field: you must own the planet, the percentage must be 25/50/100, the angle must be a finite number, and there's a limit on how fast you can launch.
- **Positions are deterministic.** A planet's position comes from its orbit radius, its angular speed (inner rings are faster, following Kepler: period ∝ r^1.5) and its starting angle. Fleets fly in straight lines at a fixed speed. The server sends a fleet's launch parameters once, and every client computes its position each frame. That's why movement is smooth at 60 fps and snapshots stay small (about 160 bytes, 15 per second).
- **Interpolation and time sync.** The client estimates the server clock with ping/pong (it trusts the sample with the lowest round-trip time). It then draws the world 100 ms in the past, so captures and fleet removals have always arrived by the time they're drawn.
- **Instant feedback.** When you launch, a "ghost" fleet appears right away and the ship count on your planet drops. When the server's real fleet arrives, it quietly replaces the ghost.
- **Hidden information is enforced on the server.** Each player gets their own snapshot. An enemy fleet's size is sent as `-1` until that fleet comes within range of one of your planets, so you can't read it in the browser's dev tools.

License: MIT
