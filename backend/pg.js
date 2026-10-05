/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — синхронный адаптер PostgreSQL поверх pg
   ──────────────────────────────────────────────────────────────────────
   Интерфейс совпадает с backend/sqlite.js (Db и Stmt), поэтому слои
   выше — роуты, auth, notify, mailer, db.js — не меняются:
     db.run(sql, a, b)     — как раньше
     db.get / db.all       — ряды как раньше
     db.prepare(sql)       — Stmt с run/get/all/iterate/finalize
     db.pluck, db.tx, db.exec — как раньше

   Различия SQLite→Postgres прячем здесь:
     • `?`-плейсхолдеры  →  $1, $2, …
     • `insert or ignore` →  `on conflict do nothing`
     • `lastInsertRowid`  →  INSERT … RETURNING id
     • транзакции — begin/commit/rollback (а не begin immediate)

   Выполнение — через воркер backend/_pg-worker.js: главный поток ждёт
   ответ на Atomics.wait, поэтому весь код вокруг остаётся синхронным.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const BUF_SIZE = 64 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

let worker = null;
let sab = null;
let flag = null;
let lenView = null;
let bytes = null;
let seq = 0;

/** Выполнить запрос в воркере и дождаться ответа. Возвращает `res` с ok. */
function call(mode, sql, params) {
  ensureWorker();
  Atomics.store(flag, 0, 0);
  worker.postMessage({ mode, sql: sql || '', params: params || null });
  const status = Atomics.wait(flag, 0, 0, TIMEOUT_MS);
  if (status === 'timed-out') {
    throw new Error(`PG: воркер не ответил за ${TIMEOUT_MS / 1000} с (${mode})`);
  }
  const len = lenView[0];
  if (!Number.isInteger(len) || len <= 0) {
    throw new Error('PG: ответ не поместился в буфер синхронного моста');
  }
  const json = Buffer.from(bytes.subarray(0, len)).toString('utf8');
  const res = JSON.parse(json);
  if (!res.ok) {
    const err = new Error((res.error && res.error.message) || 'PG: ошибка запроса');
    if (res.error && res.error.code) err.code = res.error.code;
    throw err;
  }
  return res;
}

function ensureWorker() {
  if (worker) return;
  sab = new SharedArrayBuffer(BUF_SIZE);
  flag = new Int32Array(sab, 0, 1);
  lenView = new Int32Array(sab, 4, 1);
  bytes = new Uint8Array(sab, 8);
  const workerPath = process.env.PG_WORKER_PATH
    ? path.resolve(process.env.PG_WORKER_PATH)
    : path.join(__dirname, '_pg-worker.js');
  worker = new Worker(workerPath, { workerData: { sab } });
  worker.on('error', err => console.error('[dotacustoms][pg] воркер упал:', err && err.message));
  worker.on('exit', () => { worker = null; });
}

/* ── перевод SQLite-диалекта ─────────────────────────────────────────── */

function translate(sql) {
  let source = String(sql);
  let ignore = false;
  if (/\binsert\s+or\s+ignore\s+into\b/i.test(source)) {
    source = source.replace(/\binsert\s+or\s+ignore\s+into\b/i, 'insert into');
    ignore = true;
  }
  let n = 0;
  source = source.replace(/\?/g, () => `$${++n}`);
  if (ignore) source += ' on conflict do nothing';
  return source;
}

const isInsertSql = sql => /^\s*insert\s+(into|or)/i.test(sql);

/** Приводит аргументы вызова к массиву параметров (как в sqlite.js). */
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
    else if (typeof v === 'number' && !Number.isFinite(v)) out[i] = null;
    else out[i] = v;
  }
  return out;
}

const idColumnCache = new Map(); // таблица → есть ли колонка id

/** Имя первой таблицы в INSERT (для решения, добавлять ли `returning id`). */
function tableNameOf(sql) {
  const m = /^\s*insert\s+(?:or\s+[a-z]+\s+)?into\s+([^\s(]+)/i.exec(sql);
  return m ? m[1].replace(/"/g, '') : null;
}

/**
 * Есть ли у таблицы колонка id. Проверяем один раз и кэшируем: не у всех
 * таблиц она есть (sessions, build_votes, coach_scopes, modes, settings…),
 * а `insert … returning id` без неё — ошибка 42703 на Postgres.
 */
function hasIdColumn(table) {
  if (idColumnCache.has(table)) return idColumnCache.get(table);
  let has = false;
  try {
    const r = call('all',
      `select column_name from information_schema.columns
        where table_name = $1 and column_name = 'id'`, [table]);
    has = !!(r.rows && r.rows.length);
  } catch { /* считаем, что колонки нет — запрос без returning id пройдёт */ }
  idColumnCache.set(table, has);
  return has;
}

function runSql(translatedSql, params, insert) {
  let sql = translatedSql;
  if (insert) {
    const table = tableNameOf(translatedSql);
    if (table && hasIdColumn(table)) sql = `${translatedSql} returning id`;
  }
  const r = call('run', sql, params || []);
  return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
}

function rowsSql(translatedSql, params, kind) {
  const r = call(kind, translatedSql, params || []);
  return r.rows;
}

/* ── prepared-статмент ────────────────────────────────────────────────── */

class Stmt {
  constructor(rawSql) {
    this.sql = translate(rawSql);
    this.insert = isInsertSql(this.sql);
  }

  run(...args) { return runSql(this.sql, pack(args) || [], this.insert); }
  get(...args) {
    const rows = rowsSql(this.sql, pack(args) || [], 'get');
    return rows && rows.length ? rows[0] : null;
  }
  all(...args) { return rowsSql(this.sql, pack(args) || [], 'all'); }
  iterate(...args) {
    const rows = rowsSql(this.sql, pack(args) || [], 'all');
    return rows[Symbol.iterator]();
  }
  finalize() { /* не требуется: выполняем на лету */ }
}

/* ── соединение ──────────────────────────────────────────────────────── */

class Db {
  constructor() {
    this.dialect = 'pg';
  }

  exec(sql) { return call('exec', sql); }
  run(sql, ...args) { return runSql(translate(sql), pack(args) || [], isInsertSql(sql)); }
  get(sql, ...args) {
    const rows = rowsSql(translate(sql), pack(args) || [], 'get');
    return rows && rows.length ? rows[0] : null;
  }
  all(sql, ...args) { return rowsSql(translate(sql), pack(args) || [], 'all'); }
  iterate(sql, ...args) {
    return rowsSql(translate(sql), pack(args) || [], 'all')[Symbol.iterator]();
  }
  prepare(sql) { return new Stmt(sql); }

  /** Первое значение первой колонки. */
  pluck(sql, ...args) {
    const row = this.get(sql, ...args);
    if (!row) return null;
    const keys = Object.keys(row);
    return keys.length ? row[keys[0]] : null;
  }

  /** Выполняет функцию в транзакции, откатывая её при ошибке. */
  tx(fn) {
    call('begin');
    try {
      const result = fn();
      call('commit');
      return result;
    } catch (err) {
      try { call('rollback'); } catch { /* уже откатилась */ }
      throw err;
    }
  }

  close() {
    if (worker) {
      try { worker.terminate(); } catch { /* уже */ }
      worker = null;
    }
  }
}

function open() {
  return new Db();
}

module.exports = { open, Db, Stmt, translate, pack };