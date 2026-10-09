#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — проверка каталога кастомных предметов
   ──────────────────────────────────────────────────────────────────────
   Источник истины — data/custom/chc-items.json (он же источник для
   npm run data:build). Раньше этот скрипт генерировал каталог заново из
   встроенного массива; после перехода на JSON-каталог перезапись стала
   опасной (можно было случайно стереть книги), поэтому здесь осталась
   только защита: скрипт проверяет инварианты и ничего не пишет.

   Инварианты:
     • у каждого предмета есть ключ, имя и группа из custom.groups;
     • id (FNV-1a, 900000 + h % 80000) не пересекаются — как в
       scripts/build-dataset.js;
     • legacy_id уникальны и не совпадают с новыми id;
     • цепочки апгрейдов замкнуты (upgrades ↔ upgrades_from);
     • если источник задан — у него есть url/title.

   Запуск:  npm run data:custom
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'data', 'custom', 'chc-items.json');
// Второй источник — предметы Ratten Run, собранные из VPK-аддона
// (scripts/build-rr-catalog.js). Проверяем оба вместе: id и группы
// считаются по объединённому списку, иначе валидатор ругался бы зря.
const RR_FILE = path.join(__dirname, '..', 'data', 'custom', 'rr-items.json');
const CUSTOM_ID_BASE = 900000;

const customId = key => {
  let h = 0x811c9dc5; // FNV-1a — та же формула, что в build-dataset.js
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return CUSTOM_ID_BASE + (h % 80000);
};

function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`[custom] нет ${path.relative(process.cwd(), FILE)}`);
    process.exit(1);
  }
  const cat = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const rr = fs.existsSync(RR_FILE) ? JSON.parse(fs.readFileSync(RR_FILE, 'utf8')) : { items: [], groups: [] };
  const items = [...(cat.items || []), ...(rr.items || [])];
  const groups = [...(cat.groups || []), ...(rr.groups || [])].map(g => g.key);
  const problems = [];

  if (!items.length) problems.push('каталог пуст');
  if (!groups.length) problems.push('нет групп');

  const seenIds = new Map();
  const seenKeys = new Set();
  const seenLegacy = new Map();
  let withCost = 0;

  for (const c of items) {
    if (!c.key) { problems.push('запись без key'); continue; }
    if (seenKeys.has(c.key)) problems.push(`дубль ключа ${c.key}`);
    seenKeys.add(c.key);

    if (!c.name) problems.push(`${c.key}: нет имени`);
    if (!groups.includes(c.group)) problems.push(`${c.key}: группа «${c.group}» не объявлена`);
    if (c.cost) withCost++;

    const id = customId(c.key);
    if (seenIds.has(id)) problems.push(`коллизия id ${id}: ${seenIds.get(id)} и ${c.key}`);
    seenIds.set(id, c.key);

    if (c.legacy_id) {
      if (seenLegacy.has(c.legacy_id)) problems.push(`дубль legacy_id ${c.legacy_id}`);
      seenLegacy.set(c.legacy_id, c.key);
      if (seenIds.has(c.legacy_id)) {
        problems.push(`${c.key}: legacy_id ${c.legacy_id} совпадает с текущим id`);
      }
    }

    if (c.upgrades_from && !seenKeys.has(c.upgrades_from)) {
      problems.push(`${c.key}: upgrades_from → ${c.upgrades_from}, но такого ключа нет`);
    }
    for (const k of c.upgrades || []) {
      if (!items.some(x => x.key === k)) problems.push(`${c.key}: апгрейд → ${k}, но такого ключа нет`);
    }
  }

  // апгрейды должны быть взаимными: если A улучшается в B, у B должен
  // быть upgrades_from = A (обратную проверку делает build-dataset)
  for (const c of items) {
    for (const k of c.upgrades || []) {
      const up = items.find(x => x.key === k);
      if (up && up.upgrades_from !== c.key) {
        problems.push(`${c.key} → ${k}: обратная ссылка у ${k} не указывает на ${c.key}`);
      }
    }
  }

  if (!cat.source || (!cat.source.url && !cat.source.title)) {
    problems.push('нет источника (source.url/source.title)');
  }

  if (problems.length) {
    console.error(`[custom] каталог не прошёл проверку: ${problems.length} замечаний`);
    for (const p of problems) console.error('  ! ' + p);
    process.exit(1);
  }

  console.log(`[custom] каталог в порядке: ${items.length} предметов, ${groups.length} групп, `
    + `с ценой ${withCost}, источники на месте`);
}

main();