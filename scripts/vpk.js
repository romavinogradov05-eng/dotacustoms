#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — чтение VPK (Valve Package, форматы v1/v2)
   ──────────────────────────────────────────────────────────────────────
   Нужен, чтобы вытащить каталог кастомных предметов/скиллов и иконки
   из аддона Ratten Run (workshop 570/3777520860).

   Поддерживает одиночный файл .vpk (данные в том же файле —
   archiveIndex = 0x7fff) и мультифайл name_000.vpk (+ name_dir.vpk).

   API:
     openVpk(file) → { version, files: [{path,size,offset,archive,preload}], read(f) }
   read(f) возвращает Buffer содержимого файла.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SIG = 0x55aa1234;
const DATA_IN_SAME_FILE = 0x7fff;

function openVpk(file) {
  const data = fs.readFileSync(file);
  let p = 0;
  const u32 = () => { const v = data.readUInt32LE(p); p += 4; return v; };
  const u16 = () => { const v = data.readUInt16LE(p); p += 2; return v; };
  const str = () => {
    const start = p;
    while (p < data.length && data[p] !== 0) p++;
    const s = data.toString('utf8', start, p);
    p++; // null
    return s;
  };

  const sig = u32();
  if (sig !== SIG) throw new Error(`не VPK: сигнатура 0x${sig.toString(16)}`);
  const version = u32();
  const treeSize = u32();
  let fileDataSectionSize = 0;
  let restSize = 0;
  if (version === 2) {
    fileDataSectionSize = u32();
    restSize = u32() + u32() + u32(); // archiveMD5 + otherMD5 + signature
  }
  // v1: заголовок 12 байт; v2: 28 байт (tree начинается сразу).
  const treeStart = p;
  const treeEnd = treeStart + treeSize;

  const files = [];
  let dirTreeEnd = treeStart;

  // Дерево: extension → path → name → записи (до 0xffff).
  while (p < treeEnd) {
    const ext = str();
    if (!ext) break;
    while (p < treeEnd) {
      const dir = str();
      if (!dir) break;
      while (p < treeEnd) {
        const name = str();
        if (!name) break;
        while (p < treeEnd) {
          const entryStart = p;
          const crc = u32();
          const preload = u16();
          const archiveIndex = u16();
          const entryOffset = u32();
          const entrySize = u32();
          const terminator = u16();
          // В этом формате запись идёт ПОЛЯМИ, а замыкающий u16 (0xffff) —
          // маркер конца списка записей файла. Сама запись — настоящая,
          // поэтому файл добавляем до проверки терминатора.
          const rel = [ext, dir, name].filter(Boolean).join('/').replace(/\/+/g, '/');
          files.push({ path: rel, crc, preload, archiveIndex, offset: entryOffset, size: entrySize });
          if (preload) p += preload; // preload-данные лежат прямо в дереве
          if (terminator === 0xffff || entryStart + 18 === treeEnd) break;
          if (p === entryStart + 18 && terminator !== 0xffff) break; // страховка от зацикливания
        }
      }
    }
  }
  dirTreeEnd = p;

  // Для одиночного файла данные идут сразу после дерева: offset
  // отсчитывается от конца дерева. Для мультиархива — в name_000.vpk
  // (offset от начала файла-архива).
  const single = fileDataSectionSize > 0 || version === 1;

  function read(f) {
    if (f.archiveIndex === DATA_IN_SAME_FILE || single) {
      const start = dirTreeEnd + f.offset;
      return Buffer.from(data.subarray(start, start + f.size));
    }
    // мультиархив: ищем архив рядом. Дир-файл может называться как
    // name_dir.vpk (архивы name_000.vpk), так и name.vpk (архивы name_000.vpk).
    const base = file.replace(/_dir\.vpk$/i, '').replace(/_\d+\.vpk$/i, '').replace(/\.vpk$/i, '');
    const arch = path.join(path.dirname(file),
      `${path.basename(base)}_${String(f.archiveIndex).padStart(3, '0')}.vpk`);
    const fd = fs.openSync(arch, 'r');
    try {
      const buf = Buffer.alloc(f.size);
      fs.readSync(fd, buf, 0, f.size, f.offset);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  return { file, version, treeSize, single, files, read };
}

module.exports = { openVpk };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/vpk.js <file.vpk> [filter] [limit]'); process.exit(1); }
  const filter = process.argv[3] || '';
  const limit = Number(process.argv[4]) || 300;
  const v = openVpk(file);
  const list = v.files.filter(f => f.path.includes(filter));
  const byExt = {};
  for (const f of v.files) {
    const e = (f.path.split('.').pop() || '?').toLowerCase();
    byExt[e] = (byExt[e] || 0) + 1;
  }
  console.log(`VPK ${file}: версия ${v.version}, файлов ${v.files.length}, один архив: ${v.single}`);
  console.log('расширения:', Object.entries(byExt).sort((a, b) => b[1] - a[1])
    .map(([e, n]) => `${e}×${n}`).join(', '));
  console.log(`-- файлы по фильтру «${filter}» (${list.length}, показано ${Math.min(limit, list.length)}) --`);
  for (const f of list.slice(0, limit)) {
    console.log(`  ${f.size}\t${f.path}`);
  }
}