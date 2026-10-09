#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — извлечение иконок предметов и способностей Ratten Run
   из VPK-аддона (vtex_c → PNG).

   Иконки в аддоне лежат как текстуры Source 2:
     vtex_c/panorama/images/items/<key>_png
     vtex_c/panorama/images/spellicons/<...>_png
   Файла без расширения; суффикс `_png` — часть игрового имени.

   Раскладываем:
     items/*          → app/images/custom/<key>.png
     spellicons/**    → app/images/custom/spellicons/<...>.png

   Запуск:
     node scripts/extract-rr-icons.js [--vpk <path>] [--force]
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openVpk } = require('./vpk');
const { decodeVtex, encodePng } = require('./vtex');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VPK = process.env.RR_VPK || 'D:\\Steam\\steamapps\\workshop\\content\\570\\3777520860\\3777520860.vpk';
const OUT_ITEMS = path.join(ROOT, 'app', 'images', 'custom');
const OUT_SPELLS = path.join(OUT_ITEMS, 'spellicons');

function parseArgs(argv) {
  const a = { vpk: DEFAULT_VPK, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vpk') a.vpk = argv[++i];
    else if (argv[i] === '--force') a.force = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.vpk)) {
    console.error('VPK не найден:', args.vpk);
    process.exit(1);
  }
  const vpk = openVpk(args.vpk);
  fs.mkdirSync(OUT_SPELLS, { recursive: true });

  // Отбираем только текстуры иконок предметов и способностей.
  const jobs = [];
  for (const f of vpk.files) {
    const mItems = /^vtex_c\/panorama\/images\/items\/(.+)$/i.exec(f.path);
    if (mItems) {
      const key = mItems[1].replace(/_png$/i, '');
      if (key && !key.includes('/')) jobs.push({ f, out: path.join(OUT_ITEMS, key + '.png'), kind: 'item', key });
      continue;
    }
    const mSpells = /^vtex_c\/panorama\/images\/spellicons\/(.+)$/i.exec(f.path);
    if (mSpells) {
      const rest = mSpells[1].replace(/_png$/i, '');
      if (rest) jobs.push({ f, out: path.join(OUT_SPELLS, rest + '.png'), kind: 'spell', key: rest });
    }
  }

  let ok = 0, skipped = 0, failed = 0;
  const failures = [];
  for (const j of jobs) {
    if (!args.force && fs.existsSync(j.out)) { skipped++; continue; }
    const buf = vpk.read(j.f);
    const tex = decodeVtex(buf);
    if (!tex) { failed++; failures.push(j.f.path + ' (неизвестный формат)'); continue; }
    fs.mkdirSync(path.dirname(j.out), { recursive: true });
    fs.writeFileSync(j.out, encodePng(tex.width, tex.height, tex.rgba));
    ok++;
  }

  console.log(`предметов:  ${jobs.filter(j => j.kind === 'item').length}`);
  console.log(`способностей: ${jobs.filter(j => j.kind === 'spell').length}`);
  console.log(`записано:   ${ok}, пропущено (уже есть): ${skipped}, ошибок: ${failed}`);
  if (failures.length) console.log('не удалось:', failures.join('; '));
}

main();
