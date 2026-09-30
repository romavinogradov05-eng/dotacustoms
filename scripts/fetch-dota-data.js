#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — загрузка базовых данных Dota 2 (английские названия)
   ──────────────────────────────────────────────────────────────────────
   Источники:
     • dotaconstants (odota) — герои, предметы, способности, патчи
     • dota2.com datafeed    — актуальные нейтральные предметы по тирам

   Результат: data/base/*.json  (англ. база + список ключей для локализации)
   Запуск:    npm run data:fetch
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'data', 'base');
const DC = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build';
const DD = 'https://www.dota2.com/datafeed';
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';

const ATTR = ['str', 'agi', 'int'];
const ROLE_MAP = {
  carry: 'carry', support: 'support', nuker: 'nuker', disabler: 'disabler',
  initiator: 'initiator', durable: 'durable', escape: 'escape', pusher: 'pusher',
};
const HERO_KEY = /^npc_dota_hero_/;

async function getJson(url, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dotacustoms-fetch' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt >= tries) throw new Error(`${err.message} — ${url}`);
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
}

/** Сколько запросов к dota2.com летим одновременно — не наглушаем. */
const CONCURRENCY = 6;

/** Очередь с ограничением по параллелизму. */
async function pool(list, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      await worker(list[i], i);
    }
  });
  await Promise.all(runners);
}

const basename = (u) => (u ? String(u).split('?')[0].split('/').pop() : null);

function write(name, obj) {
  fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 1), 'utf8');
  const n = Array.isArray(obj) ? obj.length : Object.keys(obj).length;
  console.log(`  ✓ ${name} (${n})`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Скачиваем базовые данные Dota 2…');

  const [heroesRaw, itemsRaw, abilitiesRaw, abilityIds, patches] = await Promise.all([
    getJson(`${DC}/heroes.json`),
    getJson(`${DC}/items.json`),
    getJson(`${DC}/abilities.json`),
    getJson(`${DC}/ability_ids.json`),
    getJson(`${DC}/patch.json`),
  ]);

  // ── герои ───────────────────────────────────────────────────────────
  // heroes.json: { "1": { id, name: "npc_dota_hero_antimage", primary_attr: "agi", roles, img } }
  // Английские имена берём из dota2.com datafeed (там они читаемым текстом)
  let heroNamesEn = {};
  try {
    const feed = await getJson(`${DD}/herolist?language=english`);
    for (const h of feed?.result?.data?.heroes || []) {
      const key = String(h.name || '').replace(HERO_KEY, '');
      if (key) heroNamesEn[key] = h.name_english_loc || h.name_loc || key;
    }
  } catch (e) {
    console.warn('  ! английские имена героев не получены:', e.message);
  }

  const heroes = Object.values(heroesRaw)
    .filter(h => h && h.id && h.name && HERO_KEY.test(h.name))
    .map(h => {
      const key = h.name.replace(HERO_KEY, '');
      return {
        id: h.id,
        key,
        name_en: heroNamesEn[key] || key.replace(/_/g, ' '),
        attr: (typeof h.primary_attr === 'number' ? ATTR[h.primary_attr] : h.primary_attr) === 'all'
          ? 'uni' : (typeof h.primary_attr === 'number' ? ATTR[h.primary_attr] : h.primary_attr),
        roles: (h.roles || []).map(r => ROLE_MAP[String(r).toLowerCase()]).filter(Boolean),
        complexity: h.complexity || 1,
        img: basename(h.img) || `${key}.png`,
      };
    })
    .sort((a, b) => a.id - b.id);

  // ── предметы ────────────────────────────────────────────────────────
  // items.json: { "blink": { dname: "Blink Dagger", cost, qual, img } }
  // id лежит в item_ids.json (key → id) — тянем отдельно
  let itemIds = {};
  try { itemIds = await getJson(`${DC}/item_ids.json`); } catch { /* не критично */ }
  const SKIP_ITEM = /^(recipe|__|gift_|game_)/;
  const items = Object.entries(itemsRaw)
    .filter(([key, it]) => it && it.dname && !SKIP_ITEM.test(key))
    .map(([key, it]) => ({
      id: itemIds[key] ?? it.id ?? null,
      key,
      name_en: it.dname,
      cost: typeof it.cost === 'number' ? it.cost : 0,
      quality: it.quality || null,
      category: (it.qual || '').toLowerCase() || 'component',
      img: basename(it.img),
    }))
    .filter(it => it.id != null)
    .sort((a, b) => a.id - b.id);

  // ── способности + таланты ───────────────────────────────────────────
  // abilities.json: { key: { dname, img } };  ability_ids.json: { id: key }
  const idByKey = new Map(Object.entries(abilityIds).map(([id, key]) => [key, Number(id)]));
  const abilities = [];
  for (const [key, a] of Object.entries(abilitiesRaw)) {
    if (!a) continue;
    const id = idByKey.get(key);
    if (id == null) continue;
    const isTalent = /^special_bonus_/.test(key) || a.type === 'talent';
    const heroMatch = /npc_dota_hero_([a-z0-9_]+)/.exec(key);
    abilities.push({
      id,
      key,
      name_en: a.dname || key,
      hero: heroMatch ? heroMatch[1] : null,
      is_talent: isTalent,
      img: basename(a.img),
    });
  }
  abilities.sort((a, b) => a.id - b.id);
  const itemById = new Map(items.map(i => [i.id, i]));
  const abilityById = new Map(abilities.map(a => [a.id, a]));

  // ── нейтральные предметы (актуальный формат: trinket по тирам) ──────
  let neutrals = [];
  try {
    const feed = await getJson(`${DD}/neutralitems?language=english`);
    const tiers = feed?.result?.data?.tier || [];
    const seen = new Set();
    for (const t of tiers) {
      for (const tr of t.trinkets || []) {
        const id = tr.ability_id;
        if (seen.has(id)) continue;
        seen.add(id);
        // нейтралки лежат в items.json (item id), способность — в abilities.json
        const asItem = itemById.get(id);
        const asAbility = abilityById.get(id);
        const key = asItem?.key || asAbility?.key || `neutral_${id}`;
        neutrals.push({
          id,
          key,
          name_en: asItem?.name_en || asAbility?.name_en || key,
          tier: t.tier + 1, // 1..5 — «уровень ярости»
          img: (asItem?.img || asAbility?.img) || `${key}.png`,
        });
      }
    }
    neutrals.sort((a, b) => a.tier - b.tier || a.id - b.id);
  } catch (e) {
    console.warn('  ! нейтралки не получены:', e.message);
  }

  // ── патчи ───────────────────────────────────────────────────────────
  const patchList = patches.map(p => ({ name: p.name, date: p.date }));

  // ── настоящие способности и таланты каждого героя ───────────────────
  // odota не разделяет боевые способности и внутренние (`antimage_ebb`,
  // `juggernaut_bladeform`), а у части героев таланты вообще без имени
  // героя. Список боевых даёт dota2.com — по нему и строим редактор билда.
  console.log(`Скачиваем herodata для ${heroes.length} героев…`);
  const herodata = {};
  const misses = [];
  await pool(heroes, CONCURRENCY, async (hero) => {
    try {
      const feed = await getJson(`${DD}/herodata?language=english&hero_id=${hero.id}`);
      const hd = feed?.result?.data?.heroes?.[0];
      if (!hd) throw new Error('пустой ответ');
      herodata[hero.key] = {
        abilities: (hd.abilities || []).map(a => a.name).filter(Boolean),
        talents: (hd.talents || []).map(t => t.name).filter(Boolean),
        facets: (hd.facet_abilities || []).map(f => f.name).filter(Boolean),
      };
    } catch (e) {
      misses.push(`${hero.key}: ${e.message}`);
    }
  });
  if (misses.length) {
    console.warn(`  ! без herodata осталось ${misses.length} героев:`);
    for (const m of misses.slice(0, 10)) console.warn('    ', m);
  }

  // сколько уровней талантов на самом деле: 8 талантов = 4 уровня по два
  const talentCounts = Object.values(herodata).map(h => h.talents.length);
  const talentsPerHero = talentCounts.length ? Math.max(...talentCounts) : 8;
  const talentLevels = [8, 10, 15, 20, 25].slice(0, Math.round(talentsPerHero / 2));
  console.log(`  талантов на героя: ${talentsPerHero} → уровни ${talentLevels.join(', ')}`);

  write('heroes.json', heroes);
  write('items.json', items);
  write('abilities.json', abilities);
  write('neutrals.json', neutrals);
  write('patches.json', patchList);
  write('herodata.json', herodata);
  write('meta.json', {
    generated_at: new Date().toISOString(),
    patch: patchList.length ? patchList[patchList.length - 1].name : null,
    cdn: CDN,
    talent_levels: talentLevels,
    counts: {
      heroes: heroes.length, items: items.length,
      abilities: abilities.length, neutrals: neutrals.length,
      herodata: Object.keys(herodata).length,
    },
  });

  // отдельный файл со списком ключей — по нему заполняется data/locale/ru.json
  write('locale-keys.json', {
    heroes: heroes.map(h => ({ key: h.key, name_en: h.name_en })),
    items: items.filter(i => i.cost > 0).map(i => ({ key: i.key, name_en: i.name_en })),
    neutrals: neutrals.map(n => ({ key: n.key, name_en: n.name_en })),
  });

  console.log(`\nГотово. Патч: ${patchList[patchList.length - 1]?.name}`);
  console.log('Дальше: 1) заполни data/locale/ru.json  2) npm run data:build');
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
