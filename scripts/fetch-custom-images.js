#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — иконки кастомных предметов
   ──────────────────────────────────────────────────────────────────────
   У предметов из Custom Hero Chaos нет id в обычном справочнике Dota,
   а значит нет и иконок на CDN Valve. Иконки лежат на серверах Steam
   внутри гайда, откуда мы их и забираем один раз — дальше приложение
   работает офлайн.

   Кладём в app/images/custom/<ключ>.png, чтобы renderer доставал их той
   же схемой, что и обычные: store.icon(img) → cdn + img.

   Запуск:  npm run data:images
            node scripts/fetch-custom-images.js          # только кастомные
            node scripts/fetch-custom-images.js --force   # перекачать всё
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'data', 'custom', 'chc-items.json');
const OUT_DIR = path.join(ROOT, 'app', 'images', 'custom');

const FORCE = process.argv.includes('--force');
const TIMEOUT_MS = 20_000;

function readCatalog() {
  if (!fs.existsSync(CATALOG)) {
    console.error(`[custom] нет каталога ${path.relative(ROOT, CATALOG)}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
}

/** Скачивает одну картинку. Возвращает статус — для отчёта. */
async function fetchOne(url, target) {
  if (fs.existsSync(target) && fs.statSync(target).size > 0 && !FORCE) {
    return 'skip';
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dotacustoms-fetch' },
    });
    if (!res.ok) return `http ${res.status}`;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return `не картинка (${type})`;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return 'слишком маленький файл';
    fs.writeFileSync(target, buf);
    return 'ok';
  } catch (err) {
    return err.name === 'AbortError' ? 'таймаут' : err.message;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const catalog = readCatalog();
  const items = catalog.items || [];
  console.log(`[custom] предметов в каталоге: ${items.length}`);
  console.log(`[custom] каталог: ${path.relative(ROOT, CATALOG)}`);

  // иконки, вырезанные из скриншотов гайда, перекачивать нельзя:
  // steam_image у них может быть старым, и --force заменил бы свежую
  // вырезку старой картинкой из гайда 2024 года
  const cropped = items.filter(i => i.icon_from === 'crop' && i.steam_image);
  if (cropped.length) {
    console.log(`[custom] вырезано из скриншотов, не перекачиваем: `
      + cropped.map(i => i.key).join(', '));
  }

  const noImage = items.filter(i => !i.steam_image && i.icon_from !== 'crop');
  if (noImage.length) {
    console.log(`[custom] без картинки: ${noImage.map(i => i.key).join(', ')}`);
  }

  const withImage = items.filter(i => i.steam_image && i.icon_from !== 'crop');
  const byStatus = {};
  let bytes = 0;

  for (const item of withImage) {
    const target = path.join(OUT_DIR, `${item.key}.png`);
    const status = await fetchOne(item.steam_image, target);
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'ok') bytes += fs.statSync(target).size;
    if (status !== 'ok' && status !== 'skip') {
      console.log(`  ! ${item.key}: ${status}`);
    }
  }

  console.log(`[custom] готово: ${JSON.stringify(byStatus)}`);
  console.log(`[custom] объём: ${(bytes / 1024).toFixed(0)} КБ в ${OUT_DIR}`);

  const ok = (byStatus.ok || 0) + (byStatus.skip || 0);
  const coverage = withImage.length ? ok / withImage.length : 1;
  console.log(`[custom] покрытие: ${(coverage * 100).toFixed(0)}%`);

  if (coverage < 1) {
    console.log('[custom] часть картинок не скачалась — у таких предметов в пикере '
      + 'будет заглушка вместо иконки. Повтори позже или запусти с --force.');
  }

  // предметы, у которых иконки нет вообще, — честно перечисляем
  const dir = fs.readdirSync(OUT_DIR);
  const withoutFile = items
    .filter(i => i.icon_from !== 'crop')
    .filter(i => !dir.includes(`${i.key}.png`));
  if (withoutFile.length) {
    console.log(`[custom] без файла иконки (нужен crop или --force): `
      + withoutFile.map(i => i.key).join(', '));
  }
}

main().catch(err => {
  console.error('[custom] не получилось:', err);
  process.exit(1);
});
