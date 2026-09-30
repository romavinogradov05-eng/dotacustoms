#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — сброс базы
   ──────────────────────────────────────────────────────────────────────
   Удаляет файл dotacustoms.db и создаёт заново (пустая схема + гайды из
   data/seed/guides). Нужен, когда хочется начать с чистого листа, не
   трогая остальные файлы приложения.

   Запуск:  npm run db:reset
   Флаги:   --force   не спрашивать подтверждения
            --keep    только пересоздать схему, файлы не трогать
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const { openDatabase, ensureFirstAdmin, userCount } = require('../backend/db');
const { defaultDataDir, ensureDir } = require('../backend/config');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const KEEP = args.has('--keep');

async function confirm(question) {
  if (FORCE) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const dataDir = defaultDataDir();
  const dbFile = path.join(dataDir, 'dotacustoms.db');

  console.log('[dotacustoms] каталог данных:', dataDir);

  if (fs.existsSync(dbFile)) {
    const size = (fs.statSync(dbFile).size / 1024).toFixed(1);
    console.log(`[dotacustoms] найдена база: ${dbFile} (${size} КБ)`);
    if (!KEEP) {
      const ok = await confirm('Удалить её вместе со всеми пользователями, билдами и ветками?');
      if (!ok) {
        console.log('[dotacustoms] отменено, ничего не трогаем');
        process.exitCode = 1;
        return;
      }
      fs.rmSync(dbFile, { force: true });
      for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
      console.log('[dotacustoms] старая база удалена');
    }
  } else {
    console.log('[dotacustoms] базы ещё нет — будет создана заново');
  }

  ensureDir(dataDir);
  const db = openDatabase(dataDir);

  // гайды восстановятся из markdown-файлов при следующем старте,
  // но для полноты покажем, сколько их видит backend
  try {
    const { seedInto } = require('../backend/seedGuides');
    const stats = seedInto(db);
    console.log(`[dotacustoms] гайды: +${stats.added}, обновлено ${stats.updated}`);
  } catch (err) {
    console.warn('[dotacustoms] гайды не засеяны:', err.message);
  }

  const users = userCount(db);
  const seeded = ensureFirstAdmin(db, 'admin', 'dotacustoms');

  db.close();

  console.log('[dotacustoms] готово. Пользователей в новой базе:', users);
  if (seeded) {
    console.log(`[dotacustoms] аварийный админ создан: ${seeded} / dotacustoms`);
  } else if (users === 0) {
    console.log('[dotacustoms] база пустая — первый, кто зарегистрируется, станет администратором');
  }
  console.log('[dotacustoms] запусти приложение: npm start');
}

main().catch(err => {
  console.error('[dotacustoms] сброс не удался:', err);
  process.exit(1);
});
