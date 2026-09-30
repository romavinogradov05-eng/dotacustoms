/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — наполнение таблицы гайдов из markdown-файлов
   ──────────────────────────────────────────────────────────────────────
   Файлы лежат в data/seed/guides/*.md. Каждый запуск приложения
   сверяет содержимое: изменил .md — страница обновилась.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assetsDir } = require('./config');
const { nowIso } = require('./util');

/** Разбор front-matter вида `---\nslug: x\ntitle: y\n---` */
function parseGuide(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = raw.slice(m[0].length).replace(/^\s+/, '');
  if (!meta.slug || !meta.title) return null;
  return {
    slug: meta.slug,
    title: meta.title,
    category: meta.category || 'basics',
    summary: meta.summary || '',
    order_index: Number(meta.order) || 0,
    is_official: meta.official === 'false' ? 0 : 1,
    published: meta.published === 'false' ? 0 : 1,
    body,
  };
}

function guidesDir() {
  return path.join(assetsDir(), 'seed', 'guides');
}

/** Наполняет/обновляет таблицу guides. Возвращает счётчики. */
function seedInto(db, dir = guidesDir()) {
  const result = { added: 0, updated: 0, hidden: 0 };
  if (!fs.existsSync(dir)) return result;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const guides = files.map(f => parseGuide(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(Boolean);
  if (!guides.length) return result;

  const now = nowIso();
  const find = db.prepare('select id, body from guides where slug = ?');
  const insert = db.prepare(
    `insert into guides (slug, title, category, summary, body, order_index,
                         is_official, published, author_id, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,null,?,?)`
  );
  const update = db.prepare(
    `update guides set title=?, category=?, summary=?, body=?, order_index=?,
                        is_official=?, published=?, updated_at=? where slug=?`
  );

  for (const g of guides) {
    const row = find.get(g.slug);
    if (row) {
      if (row.body !== g.body) {
        update.run(g.title, g.category, g.summary, g.body, g.order_index,
                   g.is_official, g.published, now, g.slug);
        result.updated++;
      }
    } else {
      insert.run(g.slug, g.title, g.category, g.summary, g.body, g.order_index,
                 g.is_official, g.published, now, now);
      result.added++;
    }
  }

  // официальные гайды, удалённые из папки, скрываем (ссылки на них не ломаются)
  const slugs = new Set(guides.map(g => g.slug));
  for (const g of db.prepare('select slug, is_official from guides').all()) {
    if (slugs.has(g.slug) || !g.is_official) continue;
    db.prepare('update guides set published = 0, updated_at = ? where slug = ?').run(now, g.slug);
    result.hidden++;
  }
  return result;
}

module.exports = { seedInto, parseGuide, guidesDir };
