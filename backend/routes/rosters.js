/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — ростеры героев кастомных игр
   ──────────────────────────────────────────────────────────────────────
   Справочник Dota содержит всех 127 героев, а в Custom Hero Chaos и
   Ratten Run играют не все. Раньше правильный список можно было задать
   только правкой data/custom/rosters.json и пересборкой датасета —
   внутри приложения настроить его было невозможно. Теперь список живёт
   в базе и меняется из интерфейса.

   Ключи героев, а не id: id меняется при пересборке справочника, ключ
   («antimage») — нет. Неизвестные ключи отбрасываются с предупреждением:
   опечатку должен видеть тот, кто её сделал.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { MODES } = require('../config');
const { str, bad, nowIso, parseJsonArray } = require('../util');
const { requireAuth, isCoachFor } = require('../auth');
const { wrap } = require('../http');

const MODE_KEYS = MODES.map(m => m.key);

/**
 * Итоговый ростер режима: строка из базы, иначе зашитый в датасет.
 * Пустой массив = ограничений нет.
 */
function rosterOf(db, dataset, mode) {
  const row = db.prepare('select keys, note, updated_at from hero_rosters where mode = ?').get(mode);
  if (row) return { mode, keys: parseJsonArray(row.keys), note: row.note || '', updated_at: row.updated_at, source: 'db' };
  const base = (dataset.rosters || {})[mode];
  return {
    mode,
    keys: Array.isArray(base) ? base : [],
    note: 'из data/custom/rosters.json',
    updated_at: null,
    source: 'file',
  };
}

module.exports = function rosterRoutes(ctx) {
  const { db, dataset } = ctx;
  const router = express.Router();

  /** Известные ключи героев — быстрый Set для проверки опечаток. */
  const knownKeys = new Set(dataset.heroes.map(h => h.key));

  // ── ростеры всех режимов ──────────────────────────────────────────────
  router.get('/', wrap((_req, res) => {
    const out = {};
    for (const m of MODE_KEYS) out[m] = rosterOf(db, dataset, m);
    res.json({ rosters: out, can_edit: MODE_KEYS.map(m => ({ mode: m })) });
  }));

  // ── поставить или снять ростер режима ─────────────────────────────────
  // Право есть у админа и у Coach с правом на этот режим: список героев —
  // это ровно тот факт, который Coach и проверяет.
  router.post('/:mode', requireAuth, wrap((req, res) => {
    const mode = str(req.params.mode, { field: 'режим', max: 8 });
    if (!MODE_KEYS.includes(mode)) throw bad('Неизвестный режим: ' + mode);
    if (!isCoachFor(db, req.user, mode)) {
      throw bad('Настраивать ростер режима может только админ или Coach с правом на него');
    }

    const raw = req.body.keys;
    if (!Array.isArray(raw)) throw bad('Нужен список героев — массив ключей');
    if (raw.length > 400) throw bad('Слишком много героев в ростере');

    // Чистим и проверяем: молча пропущенный герой выглядел бы как «работает»,
    // а на деле его нет в игре.
    const keys = [];
    const unknown = [];
    for (const k of raw) {
      const key = String(k || '').trim();
      if (!key) continue;
      if (!knownKeys.has(key)) { unknown.push(key); continue; }
      if (!keys.includes(key)) keys.push(key);
    }
    if (unknown.length) {
      throw bad('В справочнике нет героев: ' + unknown.join(', ')
        + '. Ключи берутся из data/dota.json → heroes[].key');
    }

    const note = str(req.body.note, { field: 'пометка', max: 300, required: false }).trim();
    const ts = nowIso();
    const prev = db.prepare('select 1 from hero_rosters where mode = ?').get(mode);

    if (prev) {
      // Upsert через find-then-update: драйвер node-sqlite3-wasm неверно
      // связывает параметры в «on conflict … do update», поэтому так надёжнее.
      db.prepare('update hero_rosters set keys = ?, note = ?, updated_at = ?, updated_by = ? where mode = ?')
        .run([JSON.stringify(keys), note, ts, req.user.id, mode]);
    } else {
      db.prepare('insert into hero_rosters (mode, keys, note, updated_at, updated_by) values (?, ?, ?, ?, ?)')
        .run([mode, JSON.stringify(keys), note, ts, req.user.id]);
    }

    res.json({
      ok: true,
      roster: { mode, keys, note, updated_at: ts, source: 'db' },
      // Сколько героев останется в выборе — сразу видно, сработало ли.
      heroes_visible: keys.length || dataset.heroes.length,
    });
  }));

  // ── сбросить ростер к зашитому в датасете ──────────────────────────────
  router.delete('/:mode', requireAuth, wrap((req, res) => {
    const mode = str(req.params.mode, { field: 'режим', max: 8 });
    if (!MODE_KEYS.includes(mode)) throw bad('Неизвестный режим: ' + mode);
    if (!isCoachFor(db, req.user, mode)) {
      throw bad('Сбрасывать ростер режима может только админ или Coach с правом на него');
    }
    db.prepare('delete from hero_rosters where mode = ?').run([mode]);
    res.json({ ok: true, roster: rosterOf(db, dataset, mode) });
  }));

  return router;
};

module.exports.rosterOf = rosterOf;
