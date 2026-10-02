#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — перенос данных: локальный SQLite → PostgreSQL (Neon)
   ──────────────────────────────────────────────────────────────────────
   Использование:
     DATABASE_URL=postgres://… node scripts/migrate-sqlite-to-pg.js [путь-к-базе]

   По умолчанию источник — база приложения: %APPDATA%\dotacustoms\data
   (Electron) либо .data\dotacustoms.db. Приложение должно быть закрыто:
   иначе драйвер не откроет базу из-за блокировки.

   Что делает:
     1. открывает SQLite-источник и читает все таблицы;
     2. в Neon применяет SCHEMA_PG (create table if not exists);
     3. в одной транзакции с set constraints all deferred копирует строки
        с сохранением id (нужно для самоссылок posts.parent_id);
     4. передвигает serial-последовательности на max(id);
     5. сверяет количество строк и показывает расхождения.

   Отказывается работать, если целевая база уже не пустая.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('node:path');
const { Pool } = require('pg');
const { open: openSqlite } = require('../backend/sqlite');
const { SCHEMA_PG } = require('../backend/schema-pg');

/** Порядок вставки: родители раньше детей (внешние ключи). */
const TABLES = [
  'users',
  'coach_scopes',
  'sessions',
  'modes',
  'hero_rosters',
  'builds',
  'build_votes',
  'build_comments',
  'meta_tops',
  'meta_top_entries',
  'top_votes',
  'threads',
  'posts',
  'thread_votes',
  'post_votes',
  'guides',
  'flags',
  'mod_log',
  'settings',
  'notifications',
  'reports',
  'email_queue',
  'migrations',
];

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function columnsOf(db, table) {
  return db.all(`pragma table_info(${table})`).map(r => r.name);
}

function fmt(n) {
  return String(n).padStart(5);
}

async function main() {
  const dsn = process.env.DATABASE_URL;
  if (!dsn) fail('Не задан DATABASE_URL. Пример: DATABASE_URL=postgres://user:pass@… node scripts/migrate-sqlite-to-pg.js');

  const source = process.argv[2]
    || process.env.DOTACUSTOMS_LIVE_DB
    || path.join(process.env.APPDATA || '', 'dotacustoms', 'data', 'dotacustoms.db');

  console.log('Источник:', source);
  console.log('Цель:    PostgreSQL (Neon)\n');

  let src;
  try {
    src = openSqlite(source);
  } catch (err) {
    fail(`Не удалось открыть источник: ${err.message}\nЗакрой приложение DotaCustoms (иначе база заблокирована) и повтори.`);
  }

  const pool = new Pool({ connectionString: dsn, max: 4 });
  const pg = await pool.connect();

  try {
    // ── схемы ──────────────────────────────────────────────────────────
    await pg.query(SCHEMA_PG);
    const existing = await pg.query('select count(*) as c from users');
    if (Number(existing.rows[0].c) > 0) {
      fail('Целевая база уже не пустая (в users есть строки). Переносить нечего — сначала очисти или используй свежий проект Neon.');
    }
    const migrations = await pg.query('select count(*) as c from migrations');
    if (Number(migrations.rows[0].c) > 0) {
      fail('Целевая база уже прошла миграции — перенос данных отменён.');
    }

    // ── перенос в одной транзакции ─────────────────────────────────────
    await pg.query('begin');
    await pg.query('set constraints all deferred');
    try {
      let inserted = 0;
      for (const table of TABLES) {
        const cols = columnsOf(src, table);
        if (!cols.length) {
          console.log(`  — ${table.padEnd(18)} (нет в источнике)`);
          continue;
        }
        const rows = src.all(`select * from ${table}`);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `insert into ${table} (${cols.join(', ')}) values (${placeholders})`;
        for (const row of rows) {
          await pg.query(sql, cols.map(c => (row[c] === undefined ? null : row[c])));
        }
        inserted += rows.length;
        console.log(`  ✓ ${table.padEnd(18)} ${fmt(rows.length)} строк`);
      }
      console.log(`\n  Перенесено строк: ${inserted}`);

      // последовательности → следующий id продолжит с max(id)+1
      for (const table of TABLES) {
        if (!columnsOf(src, table).includes('id')) continue;
        await pg.query(
          `select setval(pg_get_serial_sequence($1, 'id'),
             coalesce((select max(id) from ${table}), 0),
             (select max(id) from ${table}) is not null)`,
          [table],
        );
      }
      await pg.query('commit');
      console.log('  Транзакция зафиксирована.\n');

      // ── сверка ───────────────────────────────────────────────────────
      let mismatched = 0;
      for (const table of TABLES) {
        const want = src.pluck(`select count(*) from ${table}`);
        const got = Number((await pg.query(`select count(*) as c from ${table}`)).rows[0].c);
        if (want !== got) {
          mismatched++;
          console.log(`  ⚠ ${table}: источник ${want}, Neon ${got}`);
        }
      }
      console.log(mismatched ? `\nРасхождений: ${mismatched}` : 'Сверка количества строк: совпадает.');
      console.log('Перенос завершён. База на Neon готова к деплою на Vercel.');
    } catch (err) {
      await pg.query('rollback');
      throw err;
    }
  } finally {
    try { pg.release(); } catch { /* уже */ }
    await pool.end();
    try { src.close(); } catch { /* уже */ }
  }
}

main().catch(err => {
  console.error('\n✗ Перенос не удался:', err.message);
  process.exit(1);
});