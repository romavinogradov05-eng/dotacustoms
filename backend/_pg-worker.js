/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — PostgreSQL-воркер для синхронного моста (backend/pg.js)
   ──────────────────────────────────────────────────────────────────────
   Зачем. Весь бэкенд написан синхронно (db.get(), db.all() без await), а
   драйвер pg — асинхронный. Переписывать сотни вызовов в async не хочется:
   это сломало бы десктопное приложение и все тесты. Поэтому запросы
   выполняются в воркере (там pg работает как обычно), а главный поток
   ждёт ответ, заблокировавшись на Atomics.wait — результат пересылается
   через SharedArrayBuffer, без участия event loop.

   Ограничение по протоколу — это наш собственный договор с pg.js:
     { mode: 'exec' }            — несколько statement'ов, без параметров
     { mode: 'run' }             — один statement c параметрами, вернуть
                                   changes и lastInsertRowid
     { mode: 'get' | 'all' }     — выборка строк
     { mode: 'begin'|'commit'|'rollback' } — транзакция на «прибитом» клиенте
     { mode: 'shutdown' }        — закрыть пул и завершить воркер

   Ответ — JSON в буфере: { ok, rows?, changes?, lastInsertRowid? } или
   { ok:false, error: { message, code } }.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { Pool, types } = require('pg');

// count(*) и sum(...) в Postgres приходят bigint-строками, а в SQLite —
// числами. Приводим bigint (OID 20) к Number, чтобы интерфейсы совпадали.
types.setTypeParser(20, v => (v === null ? null : Number(v)));

const { sab } = workerData;
const flag = new Int32Array(sab, 0, 1);
const lengthView = new Int32Array(sab, 4, 1);
const bytes = new Uint8Array(sab, 8);

let pool = null;
let pinned = null; // клиент открытой транзакции: все запросы идут через него

function client() {
  if (pinned) return Promise.resolve(pinned);
  const dsn = process.env.DATABASE_URL;
  if (!dsn) return Promise.reject(new Error('PG: не задан DATABASE_URL'));
  if (!pool) pool = new Pool({ connectionString: dsn, max: 5 });
  return pool.connect();
}

function release(c) {
  if (c !== pinned) c.release();
}

async function exec(sql) {
  const c = await client();
  try {
    await c.query(sql); // без параметров — можно несколько statement'ов
    return { ok: true };
  } finally {
    release(c);
  }
}

async function runQuery(sql, params) {
  const c = await client();
  try {
    const r = await c.query(sql, params || []);
    const row = r.rows && r.rows[0];
    return { ok: true, changes: r.rowCount, lastInsertRowid: row ? row.id : null };
  } finally {
    release(c);
  }
}

async function rowsQuery(sql, params) {
  const c = await client();
  try {
    const r = await c.query(sql, params || []);
    return { ok: true, rows: r.rows };
  } finally {
    release(c);
  }
}

async function txCmd(mode) {
  const c = await client();
  await c.query(mode);
  if (mode === 'commit' || mode === 'rollback') {
    pinned = null;
    c.release();
  } else {
    pinned = c; // begin: держим клиент, пока транзакция не закроется
  }
  return { ok: true };
}

async function shutdown() {
  if (pinned) { try { pinned.release(); } catch { /* уже */ } }
  pinned = null;
  if (pool) { try { await pool.end(); } catch { /* уже */ } }
  process.exit(0);
}

/** Отдать ответ на главный поток через SharedArrayBuffer. */
function reply(result) {
  let json;
  try {
    json = JSON.stringify(result);
  } catch {
    json = JSON.stringify({ ok: false, error: { message: 'PG: ответ не сериализуется' } });
  }
  const buf = Buffer.from(json, 'utf8');
  const n = Math.min(buf.length, bytes.length);
  bytes.set(buf.subarray(0, n));
  lengthView[0] = buf.length > bytes.length ? 0 : n; // 0 = переполнение
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0, 1);
}

parentPort.on('message', async (msg) => {
  const { mode, sql, params } = msg || {};
  try {
    let result;
    switch (mode) {
      case 'exec':    result = await exec(sql); break;
      case 'run':     result = await runQuery(sql, params); break;
      case 'get':
      case 'all':     result = await rowsQuery(sql, params); break;
      case 'begin':
      case 'commit':
      case 'rollback': result = await txCmd(mode); break;
      case 'shutdown': return shutdown();
      default:
        result = { ok: false, error: { message: `PG: неизвестный режим «${mode}»` } };
    }
    reply(result);
  } catch (err) {
    reply({ ok: false, error: { message: String((err && err.message) || err), code: err && err.code } });
  }
});