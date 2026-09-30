/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — обёртка над node-sqlite3-wasm
   ──────────────────────────────────────────────────────────────────────
   Зачем она нужна. У драйвера есть две неприятные особенности, из-за
   которых писать SQL «как в better-sqlite3» нельзя:

   1. Параметры принимаются ТОЛЬКО массивом. `stmt.run(a, b, c)` молча
      привязывает только первый аргумент (к position 1), остальные
      параметры получают NULL. Выглядит как «NOT NULL constraint failed»
      на второй колонке — очень неприятно искать.
   2. `undefined` в массиве параметров бросает ошибку, а после любой
      неудачной строки prepared-статмент больше нельзя переиспользовать.

   Обёртка приводит вызовы к нормальному виду:
       db.run(sql, a, b, c)      →  драйвер получает [a, b, c]
       db.get(sql, [a, b])       →  тоже работает
       db.run(sql)               →  без параметров
   Плюс переводит undefined → null и boolean → 0/1.

   Апсерт `on conflict … do update` драйвер тоже выполняет неверно
   (значения из excluded приходят пустыми), поэтому в проекте его нет:
   голоса пишутся через delete + insert, настройки — через update.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { Database } = require('node-sqlite3-wasm');

/**
 * Приводит аргументы вызова к массиву параметров.
 * Возвращает `undefined`, а не `null`: драйвер трактует скаляр (в том числе
 * null) как «привязать к первому параметру», и запрос без плейсхолдеров
 * падает с «column index out of range».
 */
function pack(args) {
  if (args.length === 0) return undefined;
  let values = args;
  if (args.length === 1 && (Array.isArray(args[0]) || ArrayBuffer.isView(args[0]))) {
    values = args[0];
  }
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) out[i] = null;
    else if (typeof v === 'boolean') out[i] = v ? 1 : 0;
    else if (v instanceof Date) out[i] = v.toISOString();
    else if (typeof v === 'object' && v !== null && typeof v.toISOString === 'function') {
      out[i] = v.toISOString();
    } else out[i] = v;
  }
  return out;
}

/** Обёртка над prepared-статментом: finalize() после первой ошибки. */
class Stmt {
  constructor(raw) {
    this.raw = raw;
    this.dead = false;
  }

  _guard() {
    if (this.dead) {
      throw new Error(
        'SQLite: prepared-статмент уже использован после ошибки и не может быть переиспользован',
      );
    }
  }

  _wrap(fn) {
    this._guard();
    try {
      return fn();
    } catch (err) {
      // драйвер не даёт переиспользовать сломанный статмент — закрываем сразу
      this.dead = true;
      try { this.raw.finalize(); } catch { /* уже закрыт */ }
      throw err;
    }
  }

  run(...args) { return this._wrap(() => this.raw.run(pack(args))); }
  get(...args) { return this._wrap(() => this.raw.get(pack(args))); }
  all(...args) { return this._wrap(() => this.raw.all(pack(args))); }
  iterate(...args) { return this._wrap(() => this.raw.iterate(pack(args))); }

  finalize() {
    if (this.dead) return;
    this.dead = true;
    this.raw.finalize();
  }
}

/** Обёртка над соединением. Тот же интерфейс, что у Database, но безопасный. */
class Db {
  constructor(file) {
    this.raw = new Database(file);
    this.file = file;
  }

  exec(sql) { return this.raw.exec(sql); }

  run(sql, ...args) { return this.raw.run(sql, pack(args)); }
  get(sql, ...args) { return this.raw.get(sql, pack(args)); }
  all(sql, ...args) { return this.raw.all(sql, pack(args)); }
  iterate(sql, ...args) { return this.raw.iterate(sql, pack(args)); }

  prepare(sql) { return new Stmt(this.raw.prepare(sql)); }

  /** Первое значение первой колонки — для `select count(*) …`. */
  pluck(sql, ...args) {
    const row = this.get(sql, ...args);
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
  }

  /** Выполняет функцию в транзакции, откатывая её при ошибке. */
  tx(fn) {
    this.exec('begin immediate');
    try {
      const result = fn();
      this.exec('commit');
      return result;
    } catch (err) {
      try { this.exec('rollback'); } catch { /* уже откатилась */ }
      throw err;
    }
  }

  close() { this.raw.close(); }
}

function open(file) {
  return new Db(file);
}

module.exports = { open, Db, Stmt, pack, Database };
