#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   Смоук синхронного PG-моста без живого PostgreSQL.
   ──────────────────────────────────────────────────────────────────────
   Проверяет обвязку backend/pg.js + воркер (postMessage → Atomics.wait →
   SharedArrayBuffer → JSON) на мок-воркере scripts/pg-worker-mock.js и
   перевод SQLite→Postgres. Живой драйвер проверяется отдельно на Neon.

   Первый аргумент: 0 = только мок (без сетевых попыток),
                    1 = ещё и реальный воркер без DATABASE_URL (ожидаем
                        аккуратный отказ «не задан DATABASE_URL»).
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

// ── перевод диалекта ───────────────────────────────────────────────────
const { translate } = require('../backend/pg');

check('перевод плейсхолдеров ? → $n', () => {
  assert.strictEqual(
    translate('select * from t where a = ? and b = ? limit ?'),
    'select * from t where a = $1 and b = $2 limit $3',
  );
});

check('insert or ignore → on conflict do nothing', () => {
  assert.ok(
    translate('insert or ignore into coach_scopes (user_id, scope) values (?,?)')
      .includes('on conflict do nothing'),
  );
});

// ── мост на мок-воркере ────────────────────────────────────────────────
process.env.PG_WORKER_PATH = path.join(__dirname, '_pg-worker-mock.js');
const { open } = require('../backend/pg');

check('мок: db.all возвращает строки', () => {
  const db = open();
  const rows = db.all('select * from t', 'пробный параметр');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].name, 'второй');
  db.close();
});

check('мок: db.get отдаёт первую строку', () => {
  const db = open();
  const row = db.get('select * from t where id = ?', 1);
  assert.strictEqual(row.id, 7);
  assert.strictEqual(row.c, 3);
  db.close();
});

check('мок: run возвращает changes и lastInsertRowid', () => {
  const db = open();
  const info = db.run('insert into t (a) values (?)', 'x');
  assert.strictEqual(info.lastInsertRowid, 42);
  assert.strictEqual(info.changes, 1);
  db.close();
});

check('мок: prepare().get работает', () => {
  const db = open();
  const stmt = db.prepare('select * from t where id = ?');
  const row = stmt.get(5);
  assert.strictEqual(row.id, 7);
  stmt.finalize();
  db.close();
});

check('мок: pluck отдаёт первую колонку первой строки', () => {
  const db = open();
  assert.strictEqual(db.pluck('select id from t limit 1'), 7);
  db.close();
});

check('мок: транзакция begin/commit', () => {
  const db = open();
  const result = db.tx(() => 'ок');
  assert.strictEqual(result, 'ок');
  db.close();
});

// ── реальный воркер без базы: аккуратный отказ ─────────────────────────
const withReal = process.argv[2] === '1';
if (withReal) {
  delete process.env.PG_WORKER_PATH;
  delete process.env.DATABASE_URL;
  check('реальный воркер без DATABASE_URL → понятная ошибка', () => {
    const db = open();
    let thrown = null;
    try {
      db.get('select 1');
    } catch (err) {
      thrown = err;
    } finally {
      try { db.close(); } catch { /* воркер мог упасть */ }
    }
    assert.ok(thrown, 'ошибка не выброшена');
    assert.match(thrown.message, /DATABASE_URL/);
  });
}

console.log(failures ? `\nПровалено: ${failures}` : '\nСмоук-мост чист.');
process.exit(failures ? 1 : 0);