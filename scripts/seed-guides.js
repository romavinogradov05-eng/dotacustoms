#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — перенос гайдов из data/seed/guides/*.md в базу
   ──────────────────────────────────────────────────────────────────────
   Обычно приложение вызывает это само при старте. Скрипт нужен, если
   хочется обновить гайды, не перезапуская программу.

   Запуск: node scripts/seed-guides.js [путь-к-папке-БД]
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { openDatabase } = require('../backend/db');
const { defaultDataDir } = require('../backend/config');
const { seedInto, guidesDir } = require('../backend/seedGuides');

const dataDir = process.argv[2] || defaultDataDir();
const db = openDatabase(dataDir);
const r = seedInto(db);
db.close();
console.log(`✓ Гайды (${guidesDir()}): добавлено ${r.added}, обновлено ${r.updated}, скрыто ${r.hidden}`);
