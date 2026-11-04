/**
 * Orbit Wars — HTTP + Socket.IO entry point.
 *
 * Serves the static client (public/ and shared/), hosts many rooms at once
 * and runs one global loop that advances every active room.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const createLobby = require('./lobby');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = path.join(__dirname, '..');
const STATIC = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// ------------------------------------------------------------ static files

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  for (const { prefix, dir } of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    const file = path.normalize(path.join(dir, pathname.slice(prefix.length)));
    if (!file.startsWith(dir + path.sep)) break; // path traversal guard
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ------------------------------------------------------------ rooms

const io = new Server(server, {
  perMessageDeflate: false, // snapshots are tiny; save CPU on free hosting
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 4096, // clients only send tiny messages
});

const lobby = createLobby(io);
const rooms = lobby.rooms;
io.on('connection', (socket) => lobby.attach(socket));
setInterval(lobby.tick, 1000 / 60);

server.listen(PORT, () => console.log(`Orbit Wars listening on http://localhost:${PORT}`));

module.exports = { server, io, rooms };
