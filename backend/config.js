/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — конфигурация и константы предметной области
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/** Каталог с базой и данными. В Electron его передаёт main.js. */
function defaultDataDir() {
  if (process.env.DOTACUSTOMS_DATA) return path.resolve(process.env.DOTACUSTOMS_DATA);
  if (process.versions.electron) {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(__dirname, '..', '.data');
}

const ROOT = path.join(__dirname, '..');

/** Где лежат статические файлы (датасет, сид-гайды). */
function assetsDir() {
  return path.join(ROOT, 'data');
}

// ── режимы кастомных игр ───────────────────────────────────────────────
const MODES = [
  { key: 'chc', title: 'Custom Hero Chaos', short: 'CHC', color: '#d63b2f', sort: 1,
    desc: 'Случайные герои, случайные способности и таланты. Билд решает всё.' },
  { key: 'rr', title: 'Ratten Run', short: 'Ratten Run', color: '#4eae62', sort: 2,
    desc: 'Долгий забег по лабиринту: экономика, тайминги и нейтралки важнее всего.' },
];
const MODE_KEYS = MODES.map(m => m.key);

// ── роли ───────────────────────────────────────────────────────────────
const ROLES = { USER: 'user', COACH: 'coach', ADMIN: 'admin' };

/** Права Coach по режимам: '*' — по всем. */
const COACH_SCOPES = ['*', ...MODE_KEYS];

// ── статусы багов/фич ──────────────────────────────────────────────────
const THREAD_STATUS = ['open', 'confirmed', 'fixed', 'rejected', 'archived'];
const THREAD_CATEGORIES = [
  { key: 'bug', title: 'Баг', icon: '🐛', color: 'red' },
  { key: 'feature', title: 'Фича / идея', icon: '💡', color: 'yellow' },
  { key: 'balance', title: 'Баланс', icon: '⚖️', color: 'blue' },
  { key: 'guide', title: 'Гайд / разбор', icon: '📘', color: 'green' },
  { key: 'discussion', title: 'Обсуждение', icon: '💬', color: 'purple' },
];
const THREAD_CATEGORY_KEYS = THREAD_CATEGORIES.map(c => c.key);
const THREAD_SEVERITY = ['low', 'medium', 'high', 'blocker'];

// ── виды топов ─────────────────────────────────────────────────────────
const TOP_KINDS = [
  { key: 'heroes', title: 'Топы персонажей', icon: '🗿', ref: 'hero' },
  { key: 'neutrals', title: 'Топы нейтралок', icon: '🍃', ref: 'neutral' },
  { key: 'skills', title: 'Топы скиллов', icon: '⚡', ref: 'ability' },
];
const TOP_KIND_KEYS = TOP_KINDS.map(k => k.key);
const TOP_TIERS = ['S', 'A', 'B', 'C', 'D'];

// ── стадии билда ────────────────────────────────────────────────────────
// Поле убрали из интерфейса, но в базе оно осталось: старые билды и старые
// ссылки вида ?stage=laning не должны ломаться, поэтому значения всё ещё
// валидны на входе. Новые билды приходят без стадии и получают 'any'.
const BUILD_STAGES = [
  { key: 'laning', title: 'Линия / ранняя' },
  { key: 'midgame', title: 'Мид-гейм' },
  { key: 'late', title: 'Лейт' },
  { key: 'full', title: 'Полный билд' },
  { key: 'any', title: 'Не важно' },
];
const BUILD_STAGE_KEYS = BUILD_STAGES.map(s => s.key);

// ── таланты ─────────────────────────────────────────────────────────────
// Уровни, на которых в Dota выбирается талант. Их количество зависит от
// патча (в 7.41 у героя 8 талантов, то есть 4 выбора), поэтому берём из
// датасета, а не из константы. Значение по умолчанию — на случай, если
// датасет собран без herodata.
const TALENT_LEVELS = [8, 10, 15, 20];

// ── ограничения ────────────────────────────────────────────────────────
const LIMITS = {
  usernameMin: 3, usernameMax: 20,
  nicknameMax: 32, bioMax: 600, contactMax: 80,
  passwordMin: 6, passwordMax: 128,
  titleMax: 90, bodyMax: 20000, descriptionMax: 2000,
  maxItems: 12,           // предметы: 6 снаряжения + съеденные (Aghanim's Shard, Moon Shards и т.п.)
  maxSkills: 20,          // скиллы из пула CHC — до 20 способностей
  maxTalents: TALENT_LEVELS.length,   // по одному таланту с каждого уровня
  maxNeutrals: 12,        // нейтралки в Ratten Run
  maxTopEntries: 200,
  minTopEntries: 3,
  maxTopTiers: 12,        // максимум тиров в одном топе
  maxTierName: 24,        // длина названия тира
  maxPages: 100,
  sessionDays: 30,
  bodyBytes: 1024 * 1024,   // максимальный размер JSON-тела запроса
};

const PAGE_SIZE = 20;

const T = {
  ERR_BAD_REQUEST: 'Некорректный запрос',
  ERR_NOT_FOUND: 'Не найдено',
  ERR_FORBIDDEN: 'Недостаточно прав',
  ERR_UNAUTH: 'Нужно войти в аккаунт',
  ERR_CONFLICT: 'Так уже есть',
  ERR_BANNED: 'Аккаунт заблокирован',
  ERR_SERVER: 'Внутренняя ошибка сервера',
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Адреса этой машины в локальной сети.
 * Нужны, чтобы показать пользователю ссылку, по которой к общему хабу
 * зайдут другие: http://192.168.1.5:48711
 */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      // family бывает и 'IPv4', и 4 — зависит от версии Node
      const isV4 = ni.family === 'IPv4' || ni.family === 4;
      if (!isV4 || ni.internal) continue;
      if (out.includes(ni.address)) continue;
      out.push(ni.address);
    }
  }
  return out;
}

/** Порт общего доступа. Постоянный — иначе другие не найдут хаб. */
const SHARE_PORT = Number(process.env.DOTACUSTOMS_SHARE_PORT || 48711);

module.exports = {
  ROOT, MODES, MODE_KEYS, ROLES, COACH_SCOPES,
  THREAD_STATUS, THREAD_CATEGORIES, THREAD_CATEGORY_KEYS, THREAD_SEVERITY,
  TOP_KINDS, TOP_KIND_KEYS, TOP_TIERS,
  BUILD_STAGES, BUILD_STAGE_KEYS,
  TALENT_LEVELS, LIMITS, PAGE_SIZE, T,
  defaultDataDir, assetsDir, ensureDir,
  lanAddresses, SHARE_PORT,
  HOSTNAME: os.hostname(),
};
