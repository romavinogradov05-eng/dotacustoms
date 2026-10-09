#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — парсер KeyValues (формат данных Dota 2 / Source).
   ──────────────────────────────────────────────────────────────────────
   Формат:
     "Ключ" { ... }          — блок
     "Ключ" "Значение"       — строка
     // строчный комментарий
     (а также блочный комментарий со звёздочкой)
   Внутри блоков один и тот же синтаксис. Возвращаем обычный JS-объект:
   блоки — вложенные объекты, строки — строки. При повторяющемся ключе
   последнее значение побеждает (в исходниках Valve так не бывает, но
   лишняя защита не мешает).

   parseKv(text)            → объект
   loadKvTree(dir)          → { relPath: объект } по всем файлам рекурсивно
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseKv(text) {
  let i = 0;
  const n = text.length;

  const skipWs = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      break;
    }
  };

  const parseString = () => {
    skipWs();
    // Незакавыченные токены встречаются редко, но допускаем их
    // (например, числовые значения без кавычек).
    if (text[i] !== '"') {
      let s = '';
      while (i < n && !/[\s{}]/.test(text[i])) { s += text[i]; i++; }
      if (s) return s;
      throw new Error(`ожидалась строка на позиции ${i}: ${JSON.stringify(text.slice(i, i + 30))}`);
    }
    i++;
    let s = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') { s += text[i + 1]; i += 2; }
      else { s += text[i]; i++; }
    }
    if (text[i] !== '"') throw new Error('не закрыта кавычка');
    i++;
    return s;
  };

  const parseBlock = () => {
    const obj = {};
    for (;;) {
      skipWs();
      if (i >= n) throw new Error('не закрыт блок');
      if (text[i] === '}') { i++; break; }
      const key = parseString();
      skipWs();
      if (text[i] === '{') { i++; obj[key] = parseBlock(); }
      else obj[key] = parseString();
    }
    return obj;
  };

  skipWs();
  if (text[i] === '{') return parseBlock();
  // Верхний уровень: "Ключ" { ... } либо "Ключ" "значение"
  const key = parseString();
  skipWs();
  if (text[i] === '{') { i++; return { [key]: parseBlock() }; }
  return { [key]: parseString() };
}

/** Рекурсивно читает все файлы каталога в объекты по относительным путям. */
function loadKvTree(dir, filter) {
  const out = {};
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(a, r);
      else if (!filter || filter(r)) {
        try { out[r] = parseKv(fs.readFileSync(a, 'utf8')); }
        catch (e) { out[r] = { __error: e.message }; }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

module.exports = { parseKv, loadKvTree };
