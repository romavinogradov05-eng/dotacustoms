#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — декодер vtex_c (текстуры Source 2) → RGBA/PNG
   ──────────────────────────────────────────────────────────────────────
   Формат разобран по эталонному парсеру ValveResourceFormat:
   - заголовок ресурса: FileSize, HeaderVersion=12, Version, blockOffset,
     blockCount, затем блоки { FourCC, offset, size };
   - блок DATA содержит заголовок VTEX (version, flags, reflectivity,
     width, height, depth, format, mips, extra) — а САМИ пиксели лежат
     в конце файла, по смещению DATA.offset + DATA.size;
   - поддерживаемые пиксельные форматы: RGBA8888 (4) и BGRA8888 (28).

   API:
     decodeVtex(buf) → { width, height, format, rgba } | null
     encodePng(width, height, rgba) → Buffer (PNG)
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const zlib = require('node:zlib');

// Значения VTexFormat (ValveResourceFormat/Resource/Enums/VTexFormat.cs)
const FORMAT_RGBA8888 = 4;
const FORMAT_BGRA8888 = 28;

/* ── CRC32 для PNG ────────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Собирает PNG из RGBA-пикселей (8 бит на канал, без фильтрации).
 * Каждая строка предваряется байтом фильтра 0 (None) — так требует PNG.
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Разбирает vtex_c-буфер. Возвращает { width, height, format, rgba }
 * или null, если это не текстура с поддерживаемым форматом.
 * rgba — всегда RGBA8888 (BGRA конвертируется).
 */
function decodeVtex(buf) {
  if (buf.length < 28) return null;
  let p = 0;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };

  u32(); // FileSize
  const headerVersion = u16();
  if (headerVersion !== 12) return null;
  u16(); // Version
  u32(); // blockOffset
  const blockCount = u32();

  // Блоки: { FourCC, offset (относительно позиции после FourCC), size }
  let dataBlock = null;
  for (let i = 0; i < blockCount; i++) {
    const type = buf.toString('ascii', p, p + 4); p += 4;
    const pos = p;
    const offset = pos + u32();
    const size = u32();
    if (type === 'DATA' && !dataBlock) dataBlock = { offset, size };
  }
  if (!dataBlock) return null;

  // Заголовок VTEX
  p = dataBlock.offset;
  const rd = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
  const ru32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const r8 = () => { const v = buf[p]; p += 1; return v; };

  const vtexVersion = rd();
  if (vtexVersion !== 1) return null;
  rd(); // flags
  p += 16; // reflectivity (4 × f32)
  const width = rd(), height = rd(), depth = rd();
  const format = r8();
  const numMips = r8();
  ru32(); // picmip0
  ru32(); // extraDataOffset
  ru32(); // extraDataCount

  if (depth !== 1 || numMips < 1) return null;
  if (format !== FORMAT_RGBA8888 && format !== FORMAT_BGRA8888) return null;

  // Пиксели — в конце файла, по смещению DATA.offset + DATA.size
  const dataOffset = dataBlock.offset + dataBlock.size;
  const need = width * height * 4;
  if (buf.length - dataOffset < need) return null;

  const src = buf.subarray(dataOffset, dataOffset + need);
  const rgba = Buffer.alloc(need);
  if (format === FORMAT_RGBA8888) {
    src.copy(rgba);
  } else {
    // BGRA → RGBA
    for (let i = 0; i < need; i += 4) {
      rgba[i] = src[i + 2];
      rgba[i + 1] = src[i + 1];
      rgba[i + 2] = src[i];
      rgba[i + 3] = src[i + 3];
    }
  }
  return { width, height, format, rgba };
}

module.exports = { decodeVtex, encodePng, FORMAT_RGBA8888, FORMAT_BGRA8888 };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/vtex.js <file.vtex_c> [out.png]'); process.exit(1); }
  const fs = require('node:fs');
  const img = decodeVtex(fs.readFileSync(file));
  if (!img) { console.error('не текстура или неподдерживаемый формат'); process.exit(1); }
  const out = process.argv[3] || file.replace(/\.vtex_c$/i, '.png');
  fs.writeFileSync(out, encodePng(img.width, img.height, img.rgba));
  console.log(`${out}: ${img.width}x${img.height} format=${img.format}`);
}
