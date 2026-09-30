#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — запуск сервера отдельно от приложения
   ──────────────────────────────────────────────────────────────────────
   Нужен, если хочешь открыть хаб в общей сети (например, чтобы друзья
   заходили с других компьютеров) или положить его на хостинг.

   По умолчанию слушает 127.0.0.1:8770 — только с этой машины.
   Чтобы открыть наружу:  HOST=0.0.0.0 PORT=8770 npm run server
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { createBackend, FIRST_ADMIN } = require('./index');
const { defaultDataDir } = require('./config');
const os = require('node:os');

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 8770;

const backend = createBackend({ dataDir: process.env.DOTACUSTOMS_DATA || defaultDataDir() });

backend.listen(port, host).then(server => {
  const addr = server.address();
  const shown = host === '0.0.0.0' ? Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address) : [host];

  console.log('');
  console.log('  ⚔  DotaCustoms — сервер запущен');
  console.log(`     адрес:   http://${shown[0]}:${addr.port}`);
  console.log(`     база:    ${backend.dbFile}`);
  console.log(`     патч:    ${backend.dataset.meta?.patch || '—'}`);
  if (host !== '127.0.0.1') {
    console.log(`     доступен в сети: ${shown.map(a => `http://${a}:${addr.port}`).join(', ')}`);
  }
  if (backend.seededAdmin) {
    console.log('');
    console.log(`     ⚑ База была пуста. Создан администратор:`);
    console.log(`       ник:  ${FIRST_ADMIN.username}`);
    console.log(`       пароль: ${FIRST_ADMIN.password}`);
    console.log('       Смени пароль в профиле сразу после входа.');
  }
  console.log('');
  console.log('  Ctrl+C — остановить');
  console.log('');
}).catch(err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Порт ${port} уже занят. Запусти с другим: PORT=${port + 1} npm run server`);
  } else {
    console.error('Не удалось запустить сервер:', err);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    backend.close();
    process.exit(0);
  });
}
