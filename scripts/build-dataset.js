#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — сборка офлайн-датасета
   ──────────────────────────────────────────────────────────────────────
   Берёт data/base/*.json (англ.) + data/locale/ru.json (рус. названия)
   и собирает единый data/dota.json, который раздаёт backend.

   Русские названия талантов генерируются по шаблону (special_bonus_*),
   остальное — из ru.json, при отсутствии остаётся английский вариант.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'data', 'base');
const LOCALE_FILE = path.join(ROOT, 'data', 'locale', 'ru.json');
const OUT = path.join(ROOT, 'data', 'dota.json');

const read = f => JSON.parse(fs.readFileSync(path.join(BASE, f), 'utf8'));

/** Файл может отсутствовать (старый checkout) — тогда работаем без него. */
function readOptional(f) {
  const p = path.join(BASE, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/* ── генератор русских названий талантов ────────────────────────────────
   Ключи Valve вида special_bonus_<stat>_<value>.                    */
const STAT_RU = [
  // точный шаблон префикса
  [/^special_bonus_attack_speed_/, '% к скорости атаки'],
  [/^special_bonus_castrange_/, 'к дальности заклинаний'],
  [/^special_bonus_max_health_/, 'к максимальному здоровью'],
  [/^special_bonus_movement_speed_/, '% к скорости передвижения'],
  [/^special_bonus_spell_amp_/, '% к урону заклинаний'],
  [/^special_bonus_magic_resist_/, '% к сопротивлению магии'],
  [/^special_bonus_attack_damage_/, 'к урону атаки'],
  [/^special_bonus_cooldown_reduction_/, '% сокращения перезарядки'],
  [/^special_bonus_mana_regen_/, 'к регенерации маны'],
  [/^special_bonus_health_regen_/, 'к регенерации здоровья'],
  [/^special_bonus_lifesteal_/, '% вампиризма'],
  [/^special_bonus_armor_/, 'к броне'],
  [/^special_bonus_all_stats_/, 'ко всем характеристикам'],
  [/^special_bonus_all_/, '% ко всему'],
  [/^special_bonus_strength_/, 'к силе'],
  [/^special_bonus_agility_/, 'к ловкости'],
  [/^special_bonus_intelligence_/, 'к интеллекту'],
  [/^special_bonus_cdamage_/, '% к урону критических ударов'],
  [/^special_bonus_bonus_damage_/, 'к урону атаки (для всех)'],
  [/^special_bonus_bonus_armor_/, 'к броне (для всех)'],
  [/^special_bonus_bonus_attack_speed_/, '% к скорости атаки (для всех)'],
  [/^special_bonus_bonus_health_/, 'к здоровью (для всех)'],
  [/^special_bonus_bonus_mana_/, 'к мане (для всех)'],
  [/^special_bonus_bonus_visions_/, 'к обзору'],
  [/^special_bonus_gold_/, 'к золоту'],
  [/^special_bonus_hp_/, 'к максимальному здоровью'],
  [/^special_bonus_hp_regen_/, 'к регенерации здоровья'],
  [/^special_bonus_extra_/, ''],
  [/^special_bonus_unique_/, ''],
];

function talentRu(key) {
  for (const [re, tail] of STAT_RU) {
    if (re.test(key)) {
      const value = key.replace(re, '');
      if (!value) continue;
      const num = value.replace(/_/g, ' ').trim();
      return tail ? `+${num} ${tail}` : null;
    }
  }
  return null;
}

/* ручная переопределяющая таблица для талантов */
const TALENT_OVERRIDES = require('./talent-ru-overrides.json');

/**
 * odota отдаёт поле `hero` пустым, но ключ способности всегда начинается
 * с ключа героя: `antimage_blink`. У талантов схема другая —
 * `special_bonus_unique_antimage_3`. По ключу однозначно восстанавливаем
 * владельца, иначе поиск способностей по герою не работает.
 */
function inferHero(key, heroKeys, isTalent) {
  // у талантов между префиксом и героем стоят служебные слова:
  // special_bonus_unique_antimage_3, special_bonus_antimage_mana_10
  const body = isTalent
    ? key.replace(/^special_bonus_(?:unique_)?/, '')
    : key;
  const parts = body.split('_');
  // отбрасываем хвостовой номер варианта (`_3`, `_6`, `_2`)
  if (isTalent && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
  // самый длинный префикс, совпадающий с ключом героя:
  // shadow_shaman_serpentine → shadow_shaman, antimage_blink → antimage
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('_');
    if (heroKeys.has(candidate)) return candidate;
  }
  return null;
}

function main() {
  const heroes = read('heroes.json');
  const items = read('items.json');
  const abilities = read('abilities.json');
  const neutrals = read('neutrals.json');
  const patches = read('patches.json');
  const meta = read('meta.json');

  const heroKeys = new Set(heroes.map(h => h.key));

  let ru = { heroes: {}, items: {}, neutrals: {}, abilities: {} };
  if (fs.existsSync(LOCALE_FILE)) {
    ru = { ...ru, ...JSON.parse(fs.readFileSync(LOCALE_FILE, 'utf8')) };
  }

  const pick = (section, key, en) => ru[section]?.[key] || en;

  /* odota отдаёт в img голое имя файла, а папка зависит от сущности:
     предметы и нейтралки лежат в items/, способности — в abilities/,
     иконки героев — в heroes/icons/. Дописываем папку сразу, чтобы
     renderer просто склеивал cdn + img и не знал про разницу. */
  const withFolder = (folder, file) => {
    if (!file) return null;
    return file.includes('/') ? file : `${folder}/${file}`;
  };

  /* Список настоящих способностей и талантов каждого героя (herodata).
     Без него пришлось бы угадывать по имени ключа, и в билд-редакторе
     оказывались бы внутренние способности вроде `antimage_ebb`. */
  const heroData = readOptional('herodata.json') || {};
  const realAbilities = new Map();   // heroKey → [key, …] в порядке игры
  const realTalents = new Map();
  for (const [heroKey, d] of Object.entries(heroData)) {
    if (Array.isArray(d.abilities)) realAbilities.set(heroKey, d.abilities);
    if (Array.isArray(d.talents)) realTalents.set(heroKey, d.talents);
  }
  const orderOf = (list, key) => (list ? list.indexOf(key) : -1);

  /* обратная карта «ключ способности → герой»: у части талантов
     (`special_bonus_hp_regen_3`) имени героя в ключе нет вообще,
     и без неё они остались бы бесхозными */
  const ownerOf = new Map();
  for (const [heroKey, d] of Object.entries(heroData)) {
    for (const key of d.abilities || []) ownerOf.set(key, heroKey);
    for (const key of d.talents || []) ownerOf.set(key, heroKey);
  }

  const outHeroes = heroes.map(h => ({
    id: h.id,
    key: h.key,
    name: pick('heroes', h.key, h.name_en),
    name_en: h.name_en,
    attr: h.attr,
    roles: h.roles,
    complexity: h.complexity,
    img: withFolder('heroes/icons', h.img || `${h.key}.png`),
  }));

  const outItems = items.map(i => ({
    id: i.id,
    key: i.key,
    name: pick('items', i.key, i.name_en),
    name_en: i.name_en,
    cost: i.cost,
    quality: i.quality,
    category: i.category,
    img: withFolder('items', i.img),
  }));

  const outNeutrals = neutrals.map(n => ({
    id: n.id,
    key: n.key,
    name: pick('neutrals', n.key, n.name_en),
    name_en: n.name_en,
    tier: n.tier,
    img: withFolder('items', n.img),
  }));

  const outAbilities = abilities.map(a => {
    const manual = ru.abilities?.[a.key] || TALENT_OVERRIDES[a.key] || null;
    const generated = a.is_talent ? talentRu(a.key) : null;
    // herodata — источник истины; угадывание по ключу лишь запасной вариант
    const guessed = ownerOf.get(a.key) || a.hero || inferHero(a.key, heroKeys, !!a.is_talent);
    const source = a.is_talent ? realTalents : realAbilities;
    const list = guessed ? source.get(guessed) : null;
    const idx = orderOf(list, a.key);
    return {
      id: a.id,
      key: a.key,
      name: manual || generated || a.name_en,
      name_en: a.name_en,
      hero: guessed,
      is_talent: !!a.is_talent,
      // idx >= 0 — способность/талант реально доступны в игре
      playable: idx >= 0,
      order: idx >= 0 ? idx : 999,
      img: withFolder('abilities', a.img),
    };
  });

  // сколько уровней талантов: herodata говорит «8 талантов» → 4 уровня
  const talentLevels = Array.isArray(meta.talent_levels) && meta.talent_levels.length
    ? meta.talent_levels
    : [8, 10, 15, 20, 25];

  /* ── кастомные предметы (Custom Hero Chaos) ──────────────────────────
     У них нет id в обычном справочнике Dota, поэтому и в общий список
     предметов они не попадают — иначе редактор билда их не найдёт.
     Даём синтетические id из отдельного диапазона: 9xxxxx, чтобы никогда
     не пересечься с настоящими (максимум Valve — около 35 000). */
  const custom = readOptional('../custom/chc-items.json') || { items: [], groups: [] };

  /* Каталог Ratten Run собран из VPK-аддона скриптом build-rr-catalog.js:
     там уже отфильтрованы рецепты и предметы, которые есть в ручном
     справочнике или в обычной Доте. Здесь только докладываем остаток. */
  const rrCustom = readOptional('../custom/rr-items.json') || { items: [], groups: [] };
  const customGroups = [...(custom.groups || [])];
  for (const g of rrCustom.groups || []) {
    if (!customGroups.some(x => x.key === g.key)) customGroups.push(g);
  }
  const customList = [...(custom.items || []), ...(rrCustom.items || [])];

  /* id кастомных предметов — из диапазона 9xxxxx, чтобы никогда не
     пересечься с настоящими (максимум Valve — около 35 000).

     Раньше id считался по индексу в списке, и это была мина: стоило
     добавить или убрать один предмет, и все id после него сдвигались,
     а сохранённые в билдах предметы молча превращались в другие. Теперь
     id выводится из ключа, поэтому он не меняется никогда: добавили
     предмет — у старых ids остались те же значения.

     Старые (индексные) id сохраняем в custom_id_aliases, чтобы сборки,
     созданные до перехода, продолжили показывать правильный предмет. */
  const CUSTOM_ID_BASE = 900000;
  const customId = key => {
    let h = 0x811c9dc5;                 // FNV-1a
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return CUSTOM_ID_BASE + (h % 80000);
  };

  const ICON_DIR = path.join(ROOT, 'app', 'images', 'custom');
  const hasIcon = key => fs.existsSync(path.join(ICON_DIR, `${key}.png`));

  const customIdAliases = {};
  const customItems = customList.map(c => {
    const id = customId(c.key);
    if (customIdAliases[id]) {
      throw new Error(`[custom] коллизия id ${id}: ${customIdAliases[id]} и ${c.key}`);
    }
    if (c.legacy_id) customIdAliases[c.legacy_id] = c.key;
    return {
      id,
      key: c.key,
      name: c.name,
      name_en: c.name_en || c.name,
      group: c.group,
      // в каком режиме предмет доступен: 'chc' | 'rr' | '*' (оба)
      mode: c.mode || '*',
      tier: c.tier || 0,
      cost: c.cost || 0,
      currency: c.currency || null,
      quality: 'custom',
      category: 'custom',
      custom: 1,
      summary: c.summary || '',
      // короткая подпись для слота: у кастомных нет цены в слоте,
      // вместо неё показываем суть эффекта
      sub: c.summary || '',
      body: c.body || '',
      ability_type: c.ability_type || null,
      acts_on: c.acts_on || null,
      damage_type: c.damage || null,
      stats: c.stats || {},
      upgrades_from: c.upgrades_from || null,
      upgrades: c.upgrades || [],
      related_items: c.related_items || [],
      related_abilities: c.related_abilities || [],
      // иконки нет не у всех: без неё в пикере будет заглушка,
      // а не битая картинка. У предметов RR путь известен заранее
      // (иконка из VPK извлечена отдельно) и приходит в поле img.
      img: c.img || (hasIcon(c.key) ? `custom/${c.key}.png` : ''),
    };
  });

  /* ── ростер героев кастомных игр ─────────────────────────────────────
     Справочник Dota содержит всех героев, а в CHC и Ratten Run играют
     не все. Список берётся из data/custom/rosters.json: пустой массив =
     ограничений нет, поэтому по умолчанию ничего не отсекается. Правки
     в интерфейсе подхватываются через store.roster(mode). */
  const rosters = readOptional('../custom/rosters.json') || {};
  const rosterSet = mode => {
    const list = Array.isArray(rosters[mode]) ? rosters[mode] : [];
    return list.length ? new Set(list) : null;
  };
  const excluded = new Set(Array.isArray(rosters.excluded) ? rosters.excluded : []);

  const rostersOut = {};
  for (const m of ['chc', 'rr']) {
    const set = rosterSet(m);
    rostersOut[m] = set ? [...set] : [];
    // Считаем, сколько героев ростер закрывает, и ругаемся на опечатки:
    // герой, которого нет в справочнике, — почти всегда опечатка в ключе.
    if (set) {
      const known = new Set(outHeroes.map(h2 => h2.key));
      for (const k of set) {
        if (!known.has(k)) {
          console.warn(`  ! ростер ${m}: герой «${k}» не найден в справочнике Dota`);
          excluded.add(k);
        }
      }
      console.log(`  ростер ${m}: ${set.size} героев`);
    }
  }

  // проверяем, что ссылки на предметы и способности ведут куда-то
  const itemKeys = new Set(outItems.map(i => i.key));
  const abilityKeys = new Set(outAbilities.map(a => a.key));
  const customKeys = new Set(customItems.map(c => c.key));
  const broken = [];
  for (const c of customItems) {
    for (const k of c.related_items) {
      // related_items может указывать и на обычный предмет Dota,
      // и на другой кастомный — обе ссылки валидны
      if (!itemKeys.has(k) && !customKeys.has(k)) broken.push(`${c.key} → предмет ${k}`);
    }
    for (const k of c.related_abilities) {
      if (!abilityKeys.has(k)) broken.push(`${c.key} → способность ${k}`);
    }
    if (c.upgrades_from && !customKeys.has(c.upgrades_from)) {
      broken.push(`${c.key} → апгрейд с ${c.upgrades_from}`);
    }
    for (const k of c.upgrades) {
      if (!customKeys.has(k)) broken.push(`${c.key} → апгрейд в ${k}`);
    }
  }
  if (broken.length) {
    console.warn('  ! битые ссылки в каталоге кастомных предметов:');
    for (const b of broken) console.warn('    ', b);
  }

  // `npm run data:build` перезаписывает data/dota.json, поэтому про
  // решение «иконки лежат локально» надо помнить отдельно — иначе
  // пересборка молча вернёт CDN Valve и часть картинок отвалится.
  const IMAGE_MODE = path.join(ROOT, 'data', 'base', 'image-mode.json');
  const imageMode = fs.existsSync(IMAGE_MODE)
    ? JSON.parse(fs.readFileSync(IMAGE_MODE, 'utf8'))
    : {};

  const dataset = {
    meta: {
      ...meta,
      built_at: new Date().toISOString(),
      locale: 'ru',
      talent_levels: talentLevels,
      patch: patches.length ? patches[patches.length - 1].name : meta.patch,
      custom_patch: custom.patch || null,
      cdn: imageMode.local ? 'images' : meta.cdn,
      ...(imageMode.local ? { images_local: true } : {}),
    },
    patches,
    heroes: outHeroes,
    items: outItems,
    neutrals: outNeutrals,
    abilities: outAbilities,
    rosters: rostersOut,
    custom_items: customItems,
    custom_groups: customGroups,
    custom_source: custom.source || null,
    custom_rr_source: rrCustom.source || null,
    custom_modes: custom.modes || null,
    // старое (индексное) id → ключ, чтобы билды, созданные до перехода
    // на ключевые id, продолжили показывать правильный предмет
    custom_id_aliases: customIdAliases,
  };

  fs.writeFileSync(OUT, JSON.stringify(dataset), 'utf8');

  const ruCount = (list, field) => list.filter(x => x.name !== x.name_en).length;
  console.log(`✓ data/dota.json — ${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ`);
  console.log(`  героев ${outHeroes.length} (RU: ${ruCount(outHeroes)})`);
  console.log(`  предметов ${outItems.length} (RU: ${ruCount(outItems)})`);
  console.log(`  нейтралок ${outNeutrals.length} (RU: ${ruCount(outNeutrals)})`);
  console.log(`  способностей ${outAbilities.length} (RU: ${ruCount(outAbilities)})`);
  console.log(`  кастомных предметов ${customItems.length} (патч ${custom.patch || '—'})`);
  console.log(`  патч ${dataset.meta.patch}`);
}

main();
