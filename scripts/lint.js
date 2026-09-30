#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — простая проверка гигиены кода
   ──────────────────────────────────────────────────────────────────────
   Без внешних зависимостей: ищем неиспользуемые импорты и файлы,
   на которые никто не ссылается. Запуск: npm run lint
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['backend', 'scripts'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = DIRS.flatMap(d => walk(path.join(ROOT, d)));
const problems = [];

const countWord = (src, word) => src.split(new RegExp(`\\b${word}\\b`)).length - 1;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');

  // destructured: const { a, b } = require('…')
  for (const m of src.matchAll(/(?:const|let)\s*\{([^}]+)\}\s*=\s*require\([^)]+\);/g)) {
    const names = m[1].split(',').map(s => s.trim().split(':').pop().trim()).filter(Boolean);
    for (const name of names) {
      if (countWord(src, name) <= 1) problems.push(`${rel}: неиспользуемый импорт «${name}»`);
    }
  }

  // plain: const x = require('…')
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*require\([^)]+\);/g)) {
    if (countWord(src, m[1]) <= 1) problems.push(`${rel}: неиспользуемый require «${m[1]}»`);
  }
}

// Файлы, на которые никто не ссылается. Точки входа (npm scripts, main.js)
// исключаем — они запускаются из командной строки, а не через require.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const entries = new Set(
  Object.values(pkg.scripts || {})
    .flatMap(cmd => String(cmd).match(/[\w./-]+\.js/g) || [])
    .map(s => path.basename(s)),
);
if (pkg.main) entries.add(path.basename(pkg.main));

const extra = [path.join(ROOT, 'main.js'), path.join(ROOT, 'preload.js')].filter(fs.existsSync);
const allSrc = files.map(f => fs.readFileSync(f, 'utf8')).concat(extra.map(f => fs.readFileSync(f, 'utf8')));
for (const file of files) {
  const base = path.basename(file);
  if (base.startsWith('_') || entries.has(base)) continue;
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const stem = path.basename(file, '.js');
  const referenced = allSrc.some(s =>
    s.includes(`/${stem}'`) || s.includes(`/${stem}"`) || s.includes(`./${stem}')`) || s.includes(`../${stem}')`));
  if (!referenced) problems.push(`${rel}: файл никем не подключается`);
}

if (problems.length) {
  for (const p of problems) console.log(p);
  console.log(`\nЗамечаний: ${problems.length}`);
  process.exit(1);
}
console.log(`Проверено файлов: ${files.length}. Замечаний нет.`);
