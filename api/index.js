/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — вход для Vercel
   ──────────────────────────────────────────────────────────────────────
   Vercel отдаёт статику из app/ (см. rewrites в vercel.json), а все
   запросы /api/* направляет сюда. Здесь поднимается обычный backend
   (backend/index.js): при заданном DATABASE_URL используется PostgreSQL
   через синхронный мост backend/pg.js, иначе — файл SQLite.

   Функция экспортирует Express-приложение целиком — Vercel умеет
   вызывать его как handler'а на каждый запрос.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { createBackend } = require('../backend');

if (!process.env.DATABASE_URL) {
  // На Vercel backend обязан работать на Postgres (Neon): файловой SQLite
  // там нет — файловая система функции эфемерная. Без явной строки
  // подключения деплой не имеет смысла: падаем сразу и с понятным текстом.
  throw new Error(
    '[dotacustoms] Vercel: не задан DATABASE_URL (Neon Postgres). ' +
    'Создай проект в Neon, скопируй строку подключения и добавь её в переменные окружения проекта.',
  );
}

const backend = createBackend();

// Экспресс в виртуальном окружении Vercel сам отвечает за статику и
// SPA-fallback — здесь они бесполезны (их раздаёт Vercel), но не мешают.
module.exports = backend.app;