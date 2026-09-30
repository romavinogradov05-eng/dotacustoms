#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — иконка приложения
   ──────────────────────────────────────────────────────────────────────
   Рисуем знак сами: тёмный скруглённый квадрат и руна ᛝ из шапки
   приложения (три луча вверх, один вниз). Никаких готовых картинок и
   внешних библиотек — только zlib из Node для упаковки PNG.

   На выходе:
     app/icon.png    — иконка в шапке приложения
     build/icon.png  — иконка окна
     build/icon.ico  — то, что electron-builder кладёт в .exe

   Запуск:  npm run icon
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build');
const BIG = 256;              // мастер-размер, из него собираем все
const SS = 4;                 // суперсэмплинг: рисуем в 4 раза крупнее

/* Палитра — та же, что в style.css */
const INK_OUT = [12, 10, 9];
const INK_IN = [30, 20, 17];
const EDGE = [86, 38, 30];
const RUNE = [214, 59, 47];

/* ══════════════════════════════════════════════════════════════════════
   Мини-растеризатор: прямоугольники, окружности и капсулы по SDF.
   Всё в покрывающем режиме, сглаживание — суперсэмплинг.
   ══════════════════════════════════════════════════════════════════════ */
class Canvas {
  constructor(size) {
    this.size = size;
    this.px = new Float64Array(size * size * 3);
  }

  /** Заливка по предикату (x, y) → true, цвет с альфой 0..1. */
  fill(test, [r, g, b], alpha = 1) {
    const { size, px } = this;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!test(x + 0.5, y + 0.5)) continue;
        const i = (y * size + x) * 3;
        px[i] = px[i] * (1 - alpha) + r * alpha;
        px[i + 1] = px[i + 1] * (1 - alpha) + g * alpha;
        px[i + 2] = px[i + 2] * (1 - alpha) + b * alpha;
      }
    }
  }

  /** Смешивание сразу по альфе одного пикселя. */
  blend(x, y, [r, g, b], a) {
    if (a <= 0) return;
    const { size, px } = this;
    const i = (Math.floor(y) * size + Math.floor(x)) * 3;
    const k = Math.min(1, a);
    px[i] += (r - px[i]) * k;
    px[i + 1] += (g - px[i + 1]) * k;
    px[i + 2] += (b - px[i + 2]) * k;
  }

  /** Усреднение в SS раз — так получаются гладкие края. */
  downsample(target) {
    const { size, px } = this;
    const out = new Uint8Array(target * target * 4);
    for (let y = 0; y < target; y++) {
      for (let x = 0; x < target; x++) {
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = (((y * SS + sy) * size) + (x * SS + sx)) * 3;
            r += px[i]; g += px[i + 1]; b += px[i + 2];
          }
        }
        const n = SS * SS;
        const o = (y * target + x) * 4;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = 255;
      }
    }
    return out;
  }
}

/** Расстояние от точки до отрезка. */
function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Скруглённый прямоугольник со сглаженной границей. */
function roundRect(x0, y0, w, h, r) {
  return (x, y) => {
    const cx = Math.max(x0 + r, Math.min(x0 + w - r, x));
    const cy = Math.max(y0 + r, Math.min(y0 + h - r, y));
    return Math.hypot(x - cx, y - cy) <= r;
  };
}

/** Ломаная постоянной толщины со скруглёнными стыками. */
function strokePolyline(points, width) {
  const half = width / 2;
  return (x, y) => {
    let best = Infinity;
    for (let i = 0; i + 1 < points.length; i++) {
      best = Math.min(best, distToSegment(x, y, points[i], points[i + 1]));
    }
    return best <= half;
  };
}

/* ── PNG ────────────────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  // каждая строка с префиксом-фильтром 0 (None)
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // бит на канал
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── ICO ────────────────────────────────────────────────────────────── */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                 // 0 = иконка
  header.writeUInt16LE(1, 2);                 // 1 = иконка (не курсор)
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((img, i) => {
    const at = i * 16;
    dir[at] = img.size >= 256 ? 0 : img.size;  // 0 в байте = 256
    dir[at + 1] = img.size >= 256 ? 0 : img.size;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(img.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, dir, ...images.map(i => i.png)]);
}

/* ══════════════════════════════════════════════════════════════════════
   Сам знак
   ══════════════════════════════════════════════════════════════════════ */
function drawIcon() {
  const S = BIG * SS;
  const c = new Canvas(S);
  const u = S / 100;                 // условная единица: процент от стороны

  // фон: тёмный скруглённый квадрат, рамка и вертикальный градиент
  const margin = u * 6, box = u * 88, radius = u * 20, edge = u * 2.2;
  const outer = roundRect(margin, margin, box, box, radius);
  // «внутренний» прямоугольник: пиксели между ним и outer — это рамка
  const inner = roundRect(margin + edge, margin + edge, box - edge * 2, box - edge * 2, radius - edge);

  for (let y = 0; y < S; y++) {
    const t = Math.max(0, Math.min(1, (y - margin) / box));
    const grad = [
      INK_IN[0] + (INK_OUT[0] - INK_IN[0]) * t,
      INK_IN[1] + (INK_OUT[1] - INK_IN[1]) * t,
      INK_IN[2] + (INK_OUT[2] - INK_IN[2]) * t,
    ];
    for (let x = 0; x < S; x++) {
      if (!outer(x + 0.5, y + 0.5)) continue;
      c.blend(x, y, inner(x + 0.5, y + 0.5) ? grad : EDGE, inner(x + 0.5, y + 0.5) ? 1 : 0.6);
    }
  }

  // руна ᛝ: три луча вверх из центра и стержень вниз
  const cx = S / 2, cy = S * 0.46;
  const up = S * 0.19, down = S * 0.26, side = S * 0.19;
  const rune = [
    [cx - side, cy - up],
    [cx, cy],
    [cx + side, cy - up],
  ];
  const stem = [[cx, cy], [cx, cy + down]];
  const width = S * 0.105;

  // мягкое свечение под руной
  for (let i = 4; i >= 1; i--) {
    const wide = width + i * u * 3.2;
    c.fill(strokePolyline(rune, wide), RUNE, 0.045);
    c.fill(strokePolyline(stem, wide), RUNE, 0.045);
  }
  c.fill(strokePolyline(rune, width), RUNE, 1);
  c.fill(strokePolyline(stem, width), RUNE, 1);

  return c.downsample(BIG);
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const rgba = drawIcon();
  const master = encodePng(rgba, BIG);
  fs.writeFileSync(path.join(OUT, 'icon.png'), master);
  // копия рядом с index.html: renderer грузит её относительным путём
  fs.writeFileSync(path.join(ROOT, 'app', 'icon.png'), master);

  // остальные размеры —Nearest-подобным пересчётом из мастера
  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const images = SIZES.map(size => {
    let png = master;
    if (size !== BIG) {
      const out = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          // усредняем область исходника, соответствующую пикселю
          const x0 = Math.floor(x * BIG / size), x1 = Math.ceil((x + 1) * BIG / size);
          const y0 = Math.floor(y * BIG / size), y1 = Math.ceil((y + 1) * BIG / size);
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          for (let sy = y0; sy < y1; sy++) {
            for (let sx = x0; sx < x1; sx++) {
              const i = (sy * BIG + sx) * 4;
              const al = rgba[i + 3] / 255;
              r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al; n++;
            }
          }
          const o = (y * size + x) * 4;
          out[o] = a ? Math.round(r / a) : 0;
          out[o + 1] = a ? Math.round(g / a) : 0;
          out[o + 2] = a ? Math.round(b / a) : 0;
          out[o + 3] = Math.round(a / n * 255);
        }
      }
      png = encodePng(out, size);
    }
    return { size, png };
  });

  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(images));

  console.log(`[icon] app/icon.png, build/icon.png — ${(master.length / 1024).toFixed(1)} КБ, ${BIG}×${BIG}`);
  console.log(`[icon] build/icon.ico — ${SIZES.join('/')}, `
    + `${(fs.statSync(path.join(OUT, 'icon.ico')).size / 1024).toFixed(1)} КБ`);
}

main();
