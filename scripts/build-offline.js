/**
 * Builds a single self-contained HTML file of Orbit Wars that runs with no
 * server: the real server code (lobby, rooms, simulation, bots) is bundled
 * in and talks to the client through an in-memory socket (public/js/local.js).
 *
 * Use it for a quick preview (e.g. a claude.ai artifact) or to play vs bots
 * offline. Online multiplayer still needs `npm start` / a Render deploy.
 *
 * Usage: node scripts/build-offline.js [output.html]   (default dist/orbit-wars-offline.html)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'orbit-wars-offline.html'));

// CommonJS server modules wrapped in a tiny require() shim.
const serverModules = ['game', 'bot', 'room', 'lobby'];
const bundle = `(function () {
  var defs = {}, cache = {};
  function req(p) {
    var k = p.replace(/^.*\\//, '').replace(/\\.js$/, '');
    if (k === 'constants') return window.OW;
    if (cache[k]) return cache[k].exports;
    var module = { exports: {} };
    cache[k] = module;
    defs[k](module, module.exports, req);
    return module.exports;
  }
${serverModules.map((m) => `  defs[${JSON.stringify(m)}] = function (module, exports, require) {\n${read('server/' + m + '.js')}\n};`).join('\n')}
  window.OWServer = { createLobby: req('lobby') };
})();`;

const scripts = [
  read('shared/constants.js'),
  'window.OW_OFFLINE = true;',
  bundle,
  read('public/js/local.js'),
  ...['audio', 'net', 'render', 'input', 'ui', 'main'].map((f) => read('public/js/' + f + '.js')),
];
const inline = (src) => '<script>\n' + src.replace(/<\/script/gi, '<\\/script') + '\n</script>';

const html = read('public/index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/\s*<script[^>]*><\/script>/g, '');
const css = read('public/css/style.css');

// The artifact host supplies <!doctype>/<html>/<head>/<body>; emit content only.
const page = `<title>Orbit Wars</title>
<meta name="description" content="Capture planets orbiting a sun. Offline preview vs bots.">
<style>
:root { color-scheme: dark; }
${css}
</style>
${body.trim()}
${scripts.map(inline).join('\n')}
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(page.length / 1024)} KB)`);
