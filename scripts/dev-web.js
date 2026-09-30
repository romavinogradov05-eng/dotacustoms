#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — веб-режим для разработки
   ──────────────────────────────────────────────────────────────────────
   Поднимает тот же backend и раздаёт renderer по http://127.0.0.1:5173,
   чтобы править интерфейс в браузере с горячей перезагрузкой и F12.
   Запросы /api/* проксируются на backend, поэтому renderer видит ровно
   тот же origin, что и в приложении.

   ВНИМАНИЕ: режим только для разработки. Пароль админки здесь ничем
   не защищён, наружу ничего не отдаётся — сервер слушает 127.0.0.1.

   Запуск:  npm run start:web
   Флаги:   --port 5173   порт веб-морды
            --api 0       порт API (0 = случайный, он и не виден наружу)
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createBackend } = require('../backend/index');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const API_PREFIX = '/api';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
};

function argValue(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}

/* ── прокси на API ───────────────────────────────────────────────────── */
function proxyApi(req, res, origin) {
  const upstream = http.request(
    { host: origin.host, port: origin.port, method: req.method, path: req.url, headers: { ...req.headers, host: `${origin.host}:${origin.port}` } },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'API недоступен', detail: err.message }));
  });
  req.pipe(upstream);
}

/* ── статика renderer-а ──────────────────────────────────────────────── */
function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  // защита от выхода за пределы app/
  const rel = path.normalize(urlPath).replace(/^([/\\])+/, '');
  const target = path.join(APP_DIR, rel);
  if (target !== APP_DIR && !target.startsWith(APP_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — такого файла нет в app/');
    return;
  }

  // В браузере нет window.dotacustoms — его даёт preload. Поэтому в
  // веб-режиме дописываем шим в начало api.js: файл остаётся «своим»
  // для CSP (script-src 'self' без unsafe-inline), а адрес API известен.
  if (target === path.join(APP_DIR, 'js', 'api.js')) {
    const body = fs.readFileSync(target, 'utf8');
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(webShim() + body);
    return;
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(target).pipe(res);
}

/* ── подмена окружения Electron ──────────────────────────────────────── */
let apiBase = API_PREFIX;

function webShim() {
  return [
    '/* ── шим веб-режима, добавляется scripts/dev-web.js ── */',
    'window.dotacustoms = Object.assign(window.dotacustoms || {}, {',
    '  web: true,',
    `  apiBase: ${JSON.stringify(apiBase)},`,
    "  platform: 'browser',",
    "  info: function () { return Promise.resolve({ packaged: false, dataDir: null, dbFile: null }); },",
    "  openDataDir: function () { return Promise.reject(new Error('только в приложении')); },",
    '});',
    '',
  ].join('\n');
}

/* ── запуск ──────────────────────────────────────────────────────────── */
async function main() {
  const webPort = argValue('port', 5173);
  const apiPort = argValue('api', 0);

  const backend = createBackend();
  await backend.listen(apiPort);
  const apiOrigin = { host: '127.0.0.1', port: backend.port };

  const server = http.createServer((req, res) => {
    if (req.url === API_PREFIX || req.url.startsWith(API_PREFIX + '/')) return proxyApi(req, res, apiOrigin);
    if (req.url === '/' || req.url.startsWith('/?')) return serveStatic(req, res);
    return serveStatic(req, res);
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(webPort, '127.0.0.1', resolve);
  });

  const lan = Object.values(os.networkInterfaces()).flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log('');
  console.log('  DotaCustoms — веб-режим разработки');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  интерфейс:  http://127.0.0.1:${webPort}`);
  for (const ip of lan) console.log(`  по сети:    http://${ip}:${webPort}   (F12 работает, но не нужен)`);
  console.log(`  API:        ${API_PREFIX} → 127.0.0.1:${apiOrigin.port}`);
  console.log(`  база:       ${backend.dbFile}`);
  console.log('');
  console.log('  ВНИМАНИЕ: режим разработки. Пароль админки здесь не защищает данные.');
  console.log('  Ctrl+C — остановить.');
  console.log('');

  const shutdown = () => {
    console.log('\n[dotacustoms] останавливаюсь…');
    server.close();
    try { backend.close(); } catch { /* уже закрыта */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[dotacustoms] веб-режим не поднялся:', err);
  process.exit(1);
});
