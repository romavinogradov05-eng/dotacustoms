#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — кэш иконок для полностью офлайновой работы
   ──────────────────────────────────────────────────────────────────────
   Приложение показывает иконки героев, предметов, нейтралок и способностей.
   По умолчанию они тянутся с CDN Valve — но хаб задуман офлайновым, поэтому
   один раз скачиваем всё в data/images/ и переключаем dataset на локальные
   файлы. Дальше интернет не нужен вообще.

   Скачивание возобновляемое: уже скачанные файлы пропускаются, так что
   прерванный запуск не начинается заново.

   Запуск:  npm run data:images
   Флаги:   --force      скачать заново, даже если файл есть
            --check      ничего не качать, только показать отчёт
            --keep-cdn   не переключать dataset на локальные файлы
            --remote     вернуть dataset на CDN Valve (файлы не трогаем)
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATASET = path.join(ROOT, 'data', 'dota.json');
// кладём иконки рядом с index.html: renderer обращается к ним по
// относительному пути, поэтому папка должна лежать внутри app/
const IMAGES_DIR = path.join(ROOT, 'app', 'images');
// Пометка «иконки локальные»: build-dataset перезаписывает dota.json,
// и без этого файла пересборка вернула бы CDN Valve.
const MODE_FILE = path.join(ROOT, 'data', 'base', 'image-mode.json');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const CHECK = args.has('--check');
const KEEP_CDN = args.has('--keep-cdn');
const REMOTE_ONLY = args.has('--remote');

const REMOTE_CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;

const dataset = readJson(DATASET);
const REMOTE = (dataset.meta && dataset.meta.cdn && dataset.meta.cdn.startsWith('http'))
  ? dataset.meta.cdn
  : REMOTE_CDN;

/** Все пути иконок, которые встречаются в датасете. */
function collectImages(d) {
  const names = new Set();
  const add = entry => {
    if (entry && typeof entry.img === 'string' && entry.img) names.add(entry.img);
  };
  for (const hero of d.heroes || []) add(hero);
  for (const item of d.items || []) add(item);
  for (const n of d.neutrals || []) add(n);
  // Способности берём только боевые: у внутренних (antimage_ebb и подобных)
  // иконки на CDN всё равно нет, и они никогда не рисуются в интерфейсе.
  for (const a of d.abilities || []) {
    if (a && a.playable !== false) add(a);
  }
  return Array.from(names);
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`[images] нет ${path.relative(process.cwd(), file)} — сначала npm run data:build`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 1) + '\n', 'utf8');
}

/** Один файл: скачать, если его ещё нет (или если --force). */
async function fetchOne(name) {
  const target = path.join(IMAGES_DIR, name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0 && !FORCE) {
    return { name, status: 'skip', bytes: fs.statSync(target).size };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${REMOTE}/${name}`, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { name, status: 'bad', code: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { name, status: 'empty' };
    fs.writeFileSync(target, buf);
    return { name, status: 'ok', bytes: buf.length };
  } catch (err) {
    return { name, status: 'fail', error: err.name === 'AbortError' ? 'таймаут' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Очередь с ограничением по параллелизму. */
async function runPool(list, worker, limit) {
  const results = new Array(list.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= list.length) return;
      results[idx] = await worker(list[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const names = collectImages(dataset);

  if (REMOTE_ONLY) {
    dataset.meta.cdn = REMOTE_CDN;
    delete dataset.meta.images_local;
    writeJson(DATASET, dataset);
    // снимаем и метку, иначе следующий data:build вернёт локальные иконки
    try { fs.rmSync(MODE_FILE, { force: true }); } catch { /* уже нет */ }
    console.log('[images] dataset снова ссылается на CDN Valve. Локальные файлы в app/images не тронуты.');
    return;
  }

  console.log('[images] иконок в датасете:', names.length);
  console.log('[images] каталог:', IMAGES_DIR);

  if (CHECK) {
    const missing = names.filter(n => !fs.existsSync(path.join(IMAGES_DIR, n)));
    console.log('[images] скачано:', names.length - missing.length, '| отсутствует:', missing.length);
    if (missing.length) {
      console.log('[images] первые отсутствующие:');
      for (const n of missing.slice(0, 20)) console.log('   ', n);
    }
    if (missing.length > names.length * 0.1) {
      console.log('[images] БОЛЬШЕ 10% файлов отсутствует — запусти без --check');
      process.exitCode = 1;
    }
    return;
  }

  const results = await runPool(names, fetchOne, CONCURRENCY);
  const byStatus = {};
  let bytes = 0;
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    bytes += r.bytes || 0;
  }

  console.log('[images] готово:', JSON.stringify(byStatus));
  console.log('[images] объём:', (bytes / 1024 / 1024).toFixed(1), 'МБ');

  const ok = (byStatus.ok || 0) + (byStatus.skip || 0);
  const coverage = ok / names.length;
  console.log('[images] покрытие:', (coverage * 100).toFixed(1) + '%');

  if (KEEP_CDN) {
    console.log('[images] --keep-cdn: dataset продолжает ссылаться на CDN Valve');
    return;
  }

  if (coverage < 0.9) {
    console.log('[images] покрытие ниже 90% — оставляю CDN Valve, иначе часть иконок будет битой');
    return;
  }

  dataset.meta.cdn = 'images';
  dataset.meta.images_local = true;
  dataset.meta.images_cached_at = new Date().toISOString();
  writeJson(DATASET, dataset);
  // Помечаем и отдельно: `npm run data:build` перезаписывает dota.json
  // и без этой метки снова вернёт CDN Valve, потеряв офлайн-иконки.
  fs.writeFileSync(MODE_FILE, JSON.stringify({
    local: true,
    cached_at: new Date().toISOString(),
    coverage: Number((coverage * 100).toFixed(1)),
  }, null, 1) + '\n', 'utf8');
  console.log('[images] dataset переключён на локальные иконки (meta.cdn = "images")');
  console.log(`[images] метка сохранена: ${path.relative(ROOT, MODE_FILE)}`);
}

main().catch(err => {
  console.error('[images] не получилось:', err);
  process.exit(1);
});
