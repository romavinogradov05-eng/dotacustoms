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

const express = require('express');

if (!process.env.DATABASE_URL) {
  // На Vercel backend обязан работать на Postgres (Neon): файловой SQLite
  // там нет — файловая система функции эфемерная. Не бросаем исключение
  // на уровне модуля (Vercel отдал бы голый FUNCTION_INVOCATION_FAILED),
  // а отвечаем понятным JSON на каждый запрос — пока строка подключения
  // не появится, фронт увидит ровно то, что случилось.
  const noDb = express();
  noDb.use((_req, res) => {
    res.status(503).json({
      error: {
        message: 'База данных не подключена. На Vercel нужен Postgres (Neon): задай DATABASE_URL в переменных окружения проекта и передеплой.',
      },
    });
  });
  module.exports = noDb;
} else {
  // Ленивый require: тянем весь backend (и место с ним пул драйверов)
  // только когда база реально есть.
  const { createBackend } = require('../backend');
  const backend = createBackend();
  // Экспресс в виртуальном окружении Vercel сам отвечает за статику и
  // SPA-fallback — здесь они бесполезны (их раздаёт Vercel), но не мешают.
  module.exports = backend.app;
}