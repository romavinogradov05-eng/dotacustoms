/* ══════════════════════════════════════════════════════════════════════
   Смоук-воркер: мок backend/pg-worker.js с тем же SAB-протоколом.
   Используется только scripts/smoke-pg-bridge.js для проверки обвязки
   синхронного моста без живого PostgreSQL.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { parentPort, workerData } = require('node:worker_threads');

const { sab } = workerData;
const flag = new Int32Array(sab, 0, 1);
const lengthView = new Int32Array(sab, 4, 1);
const bytes = new Uint8Array(sab, 8);

function reply(result) {
  const buf = Buffer.from(JSON.stringify(result), 'utf8');
  const n = Math.min(buf.length, bytes.length);
  bytes.set(buf.subarray(0, n));
  lengthView[0] = buf.length > bytes.length ? 0 : n;
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0, 1);
}

parentPort.on('message', (msg) => {
  const { mode } = msg || {};
  switch (mode) {
    case 'exec':      return reply({ ok: true });
    case 'run':       return reply({ ok: true, changes: 1, lastInsertRowid: 42 });
    case 'get':       return reply({
      ok: true,
      rows: [{ id: 7, name: 'тест', c: 3 }],
    });
    case 'all':       return reply({
      ok: true,
      rows: [
        { id: 1, name: 'первый', c: 1 },
        { id: 2, name: 'второй', c: 2 },
      ],
    });
    case 'begin':
    case 'commit':
    case 'rollback':  return reply({ ok: true });
    case 'shutdown':  return process.exit(0);
    default:          return reply({ ok: false, error: { message: `мок: режим «${mode}»` } });
  }
});