#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — сборка каталога предметов Ratten Run из VPK-аддона.

   Источник — файлы добавочного каталога (`scripts/npc/items/<группа>/ability`)
   и русская локализация (`resource/addon_russian`). Из них берём:
   название, описание (с подстановкой значений), лор, цену, числа и
   иконку (иконки уже извлечены scripts/extract-rr-icons.js в
   app/images/custom/).

   В итоговый data/custom/rr-items.json попадают ТОЛЬКО предметы, которых
   ещё нет ни в обычном справочнике Dota, ни в ручном каталоге
   chc-items.json (рецепты и базовые предметы тоже пропускаем). Так
   ручной каталог остаётся источником красивых описаний, а VPK дополняет
   его до полного набора.

   Запуск:
     node scripts/build-rr-catalog.js [--extract <dir>]
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseKv } = require('./kv');

const ROOT = path.join(__dirname, '..');
const DEFAULT_EXTRACT = path.join(ROOT, '.data', 'rr-extract', 'txt');
const OUT = path.join(ROOT, 'data', 'custom', 'rr-items.json');
const ICON_DIR = path.join(ROOT, 'app', 'images', 'custom');
const CDN_DIR = path.join(ROOT, 'app', 'images', 'items');

/* Соответствие «имя предмета в VPK → ключ в ручном каталоге».
   Названия не совпадают (aluneth ↔ kast_greatstaff_of_the_magna),
   поэтому дубликаты ищем по этой таблице, а не по строке. */
const ALIASES = {
  item_aluneth: 'kast_greatstaff_of_the_magna',
  item_azure_song: 'azuresong_mageblade',
  item_star_design: 'star_design',
  item_stargazing_staff: 'stargazer',
  item_bloodstone_2: 'bloodstone_ii',
  item_torture_pipe_1_datadriven: 'torture_pipe',
  item_torture_pipe_2_datadriven: 'torture_pipe_2',
  item_felling_axe_1_lua: 'bitter_lineage',
  item_felling_axe_2_lua: 'bitter_lineage_2',
  item_felling_axe_3_lua: 'bitter_lineage_3',
  item_felling_axe_4_lua: 'bitter_lineage_4',
  item_felling_axe_5_lua: 'bitter_lineage_5',
  item_felling_shield_lua_2: 'incomplete_breastplate',
  item_felling_shield_lua_3: 'cois_breastplate',
  item_dark_moon_shard: 'dark_moon_shard',
  item_saw_wheel: 'timber_saw_wheel',
  item_ranged_cleave: 'replica_rackatee',
  item_ranged_cleave_2: 'beadies_boomstick',
  item_gang_letter: 'gang_letter',
  item_gang_senior_letter: 'gang_executive_letter',
  item_gang_ghost_letter: 'gang_ghost_stories',
  item_gang_dinner_invitation_letter: 'gang_meal_voucher',
  item_gang_gauntlet: 'gang_challenge',
  item_gang_plane_ticket: 'gang_plane_ticket',
  item_book_of_strength: 'book_of_strength',
  item_book_of_agility: 'book_of_agility',
  item_book_of_intelligence: 'book_of_intellect',
  item_relearn_book_lua: 'tome_of_retraining',
  item_relearn_torn_page_lua: 'fragment_of_relearning',
  item_paragon_book: 'book_of_paragon',
};

/* Группа VPK → группа нашего каталога. Новые группы объявляем ниже,
   чтобы предметы не выпадали из справочника. */
const GROUP_MAP = {
  extra_creature: 'creatures',
  base_artifacts: 'magic',
  custom_artifacts: 'magic',
  books: 'books',
  aegis: 'magic',
};
const GROUPS = [
  { key: 'creatures', title: 'Призыв существ', color: 'green' },
];

function parseArgs(argv) {
  const a = { extract: DEFAULT_EXTRACT };
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--extract') a.extract = argv[++i];
  return a;
}

function loadTokens(file) {
  if (!fs.existsSync(file)) return {};
  const kv = parseKv(fs.readFileSync(file, 'utf8'));
  return (kv.lang && kv.lang.Tokens) || {};
}

/** Раскрывает ссылки вида `#DOTA_Tooltip_...` на другие токены локализации. */
function resolveRefs(text, ...tokenSets) {
  if (!text) return '';
  const lookup = (k) => {
    for (const t of tokenSets) if (t && t[k] !== undefined) return String(t[k]);
    return '';
  };
  let s = String(text);
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/#([A-Za-z0-9_]+)/g, (_m, k) => lookup(k));
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Подставляет значения `%token%` из AbilityValues в описание. */
function renderText(text, values) {
  if (!text) return '';
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(h1|h2|div|p)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/%([a-z0-9_]+)%/gi, (m, k) => {
      if (!values || values[k] === undefined) return m;
      const v = values[k];
      // Вложенные блоки (например `summon_duration { value 65 }`) берём по полю value.
      if (v !== null && typeof v === 'object') {
        const inner = v.value !== undefined ? v.value : v.Value;
        return inner !== undefined && (typeof inner === 'string' || typeof inner === 'number')
          ? String(inner) : m;
      }
      return String(v);
    })
    // В движке `%%` — экранированный знак процента.
    .replace(/%%/g, '%')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Числовые значения способности (AbilityValues) → объект stats. */
function numbers(values) {
  const out = {};
  if (!values || typeof values !== 'object') return out;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'string') continue;
    if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
  }
  return out;
}

function readItem(name) {
  return name.replace(/^item_/, '').replace(/_lua$/, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const NPC = path.join(args.extract, 'scripts', 'npc');
  const ru = loadTokens(path.join(args.extract, 'resource', 'addon_russian'));
  const en = loadTokens(path.join(args.extract, 'resource', 'addon_english'));

  const dota = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dota.json'), 'utf8'));
  const baseKeys = new Set(dota.items.map(i => i.key));
  const chc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'custom', 'chc-items.json'), 'utf8'));
  const chcKeys = new Set(chc.items.map(i => i.key));

  const itemsDir = path.join(NPC, 'items');
  const items = new Map();
  for (const g of fs.readdirSync(itemsDir)) {
    const f = path.join(itemsDir, g, 'ability');
    if (!fs.existsSync(f)) continue;
    const kv = parseKv(fs.readFileSync(f, 'utf8'));
    for (const [n, v] of Object.entries(kv.DOTAAbilities || {})) {
      if (v && typeof v === 'object') items.set(n, { vpk_group: g, ...v });
    }
  }

  const outItems = [];
  const skipped = { recipe: 0, base: 0, alias: 0 };
  for (const [name, data] of items) {
    if (/^item_recipe/.test(name)) { skipped.recipe++; continue; }
    const alias = ALIASES[name];
    if (alias && chcKeys.has(alias)) { skipped.alias++; continue; }
    const bare = readItem(name);
    if (baseKeys.has(bare)) { skipped.base++; continue; }
    if (chcKeys.has(bare)) { skipped.alias++; continue; }

    const values = data.AbilityValues && typeof data.AbilityValues === 'object' ? data.AbilityValues : null;
    const ruName = ru[`DOTA_Tooltip_ability_${name}`] || '';
    const enName = en[`DOTA_Tooltip_ability_${name}`] || '';
    const title = renderText(ruName || enName || bare).trim();
    const descRaw = ru[`DOTA_Tooltip_ability_${name}_Description`] || en[`DOTA_Tooltip_ability_${name}_Description`] || '';
    const text = renderText(resolveRefs(descRaw, ru, en), values);
    const lore = renderText(resolveRefs(
      ru[`DOTA_Tooltip_ability_${name}_Lore`] || ru[`DOTA_Tooltip_ability_${name}_lore`] ||
      en[`DOTA_Tooltip_ability_${name}_Lore`] || en[`DOTA_Tooltip_ability_${name}_lore`] || '', ru, en), values);

    // Тип воздействия вытаскиваем из первого заголовка описания:
    // «Активное: …», «Пассивное: …», «Использование: …».
    const firstLine = text.split('\n')[0];
    const headMatch = /^(Активное|Пассивное|Использование|Active|Passive|Use)\s*:?\s*(.*)$/i.exec(firstLine);
    const abilityType = headMatch
      ? ({ 'Активное': 'Активная', 'Пассивное': 'Пассивная', 'Использование': 'Активная (использование)',
           Active: 'Активная', Passive: 'Пассивная', Use: 'Активная (использование)' }[headMatch[1]] || null)
      : null;
    const abilityName = headMatch ? headMatch[2].split('\n')[0].trim() : '';
    const passive = /^(Пассивное|Passive)$/i.test(headMatch ? headMatch[1] : '');
    const summary = abilityName ? `${passive ? 'Пассивно' : 'Активно'}: ${abilityName}` : title;

    // Иконка: сперва в VPK-извлечении (по имени текстуры), затем базовая CDN.
    const tex = String(data.AbilityTextureName || '').replace(/^item_/, '');
    let img = '';
    if (tex && fs.existsSync(path.join(ICON_DIR, tex + '.png'))) img = `custom/${tex}.png`;
    else if (tex && fs.existsSync(path.join(CDN_DIR, tex + '.png'))) img = `items/${tex}.png`;

    outItems.push({
      key: readItem(name),
      name: title || bare,
      group: GROUP_MAP[data.vpk_group] || 'magic',
      mode: 'rr',
      tier: 0,
      cost: Number(data.ItemCost) || 0,
      ability_type: abilityType,
      summary,
      body: lore && !text.includes(lore) ? `${text}\n\n${lore}` : text,
      stats: numbers(values),
      img,
      rr_name: name,
      vpk_group: data.vpk_group,
    });
  }

  outItems.sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));

  const result = {
    source: {
      title: 'Ratten Run (VPK-аддон)',
      note: 'Каталог собран из игровых скриптов и русской локализации аддона. Дополняет ручной справочник chc-items.json.',
      updated: new Date().toISOString().slice(0, 10),
    },
    groups: GROUPS,
    items: outItems,
  };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`предметов RR всего: ${items.size}`);
  console.log(`пропущено: рецептов ${skipped.recipe}, базовых ${skipped.base}, уже в каталоге ${skipped.alias}`);
  console.log(`добавлено новых: ${outItems.length} → ${path.relative(ROOT, OUT)}`);
  const noIcon = outItems.filter(i => !i.img);
  if (noIcon.length) console.log('без иконки:', noIcon.map(i => i.key).join(', '));
}

main();
