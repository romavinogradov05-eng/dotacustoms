/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — утилиты общего назначения
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();

/** Ошибка с HTTP-кодом — её перехватит errorMiddleware. */
class ApiError extends Error {
  constructor(status, message, code = null, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const bad = (msg, details) => new ApiError(400, msg, 'bad_request', details);
const notFound = (msg = 'Не найдено') => new ApiError(404, msg, 'not_found');
const forbidden = (msg = 'Недостаточно прав') => new ApiError(403, msg, 'forbidden');
const unauthorized = (msg = 'Нужно войти в аккаунт') => new ApiError(401, msg, 'unauthorized');
const conflict = (msg) => new ApiError(409, msg, 'conflict');

// ── строки ─────────────────────────────────────────────────────────────

/**
 * Сентинел «значение по умолчанию не передавали». Нужен, чтобы отличить
 * `def: null` (осознанная пустая база) от отсутствующего def: если def
 * задан, поле необязательное и required: true писать не нужно.
 */
const MISSING = Symbol('missing');

function str(v, { field = 'поле', min = 0, max = 1000, trim = true, required = true } = {}) {
  let s = v == null ? '' : String(v);
  if (trim) s = s.trim();
  if (required && !s) throw bad(`«${field}» не может быть пустым`);
  if (s.length < min) throw bad(`«${field}»: минимум ${min} символов`);
  if (s.length > max) throw bad(`«${field}»: максимум ${max} символов`);
  return s;
}

function int(v, { field = 'число', min = -Infinity, max = Infinity, required = true, def = MISSING } = {}) {
  const hasDefault = def !== MISSING;
  if (v === undefined || v === null || v === '') {
    if (required && !hasDefault) throw bad(`«${field}» обязательно`);
    return hasDefault ? def : null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`«${field}» должно быть целым числом`);
  if (n < min || n > max) throw bad(`«${field}»: допустимо от ${min} до ${max}`);
  return n;
}

function oneOf(v, allowed, { field = 'значение', def = MISSING, required = true } = {}) {
  const hasDefault = def !== MISSING;
  if (v === undefined || v === null || v === '') {
    if (required && !hasDefault) throw bad(`«${field}» обязательно`);
    return hasDefault ? def : null;
  }
  const s = String(v);
  if (!allowed.includes(s)) {
    throw bad(`«${field}»: допустимо ${allowed.join(', ')}`);
  }
  return s;
}

const bool = (v, def = false) => (v === undefined || v === null || v === '' ? def : !!v && v !== '0' && v !== 'false');

/** Нормализация ника: только латиница, цифры, _ и - */
function normUsername(v) {
  return String(v || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .slice(0, 20);
}

// ── JSON-поля билда ────────────────────────────────────────────────────
function parseJsonArray(v, fallback = []) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return fallback;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : fallback;
  } catch { return fallback; }
}

/** Сборка предметов: [{item_id, note}] */
function cleanItems(list, { max }) {
  const arr = parseJsonArray(list);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (out.length >= max) break;
    const o = typeof raw === 'object' && raw ? raw : { item_id: raw };
    const itemId = Number(o.item_id ?? o.id);
    if (!Number.isInteger(itemId) || itemId <= 0 || seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ item_id: itemId, note: str(o.note, { field: 'note', max: 300, required: false }) });
  }
  return out;
}

/** Нейтралки: [{neutral_id, note}] */
function cleanNeutrals(list, { max }) {
  const arr = parseJsonArray(list);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (out.length >= max) break;
    const o = typeof raw === 'object' && raw ? raw : { neutral_id: raw };
    const id = Number(o.neutral_id ?? o.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ neutral_id: id, note: str(o.note, { field: 'note', max: 300, required: false }) });
  }
  return out;
}

/** Раскладка скиллов: [{ability_id, rank}] */
function cleanSkills(list, { max }) {
  const arr = parseJsonArray(list);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (out.length >= max) break;
    const o = typeof raw === 'object' && raw ? raw : { ability_id: raw, rank: 1 };
    const id = Number(o.ability_id ?? o.id);
    const rank = Number(o.rank ?? 1);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    if (!Number.isInteger(rank) || rank < 1 || rank > max) continue;
    seen.add(id);
    out.push({ ability_id: id, rank });
  }
  return out;
}

/** Таланты: массив id, по одному на каждый уровень выбора (8/10/15/20 в 7.41) */
function cleanTalents(list, { max }) {
  const arr = parseJsonArray(list);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    if (out.length >= max) break;
    const id = Number(typeof raw === 'object' && raw ? (raw.ability_id ?? raw.id) : raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ── пагинация ──────────────────────────────────────────────────────────
function paging(query, { defaultSize, maxSize }) {
  const page = Math.max(1, Number(query.page) || 1);
  const size = Math.min(maxSize, Math.max(1, Number(query.per_page) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

// ── разное ─────────────────────────────────────────────────────────────
const slugify = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-')
  .replace(/^-+|-+$/g, '').slice(0, 60) || 'page';

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

/** «5 минут назад», «вчера» — для списков. */
function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'только что';
  const m = Math.floor(diff / 60); if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24); if (d === 1) return 'вчера';
  if (d < 7) return `${d} дн назад`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Публичный профиль (без приватных полей). */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    nickname: u.nickname,
    username: u.username,
    role: u.role,
    avatar: u.avatar || '',
    bio: u.bio || '',
    contact: u.contact || '',
    // Почта — личные данные, поэтому наружу (кроме себя) не отдаётся.
    // Свою почту видит только владелец аккаунта.
    email: u.email || '',
    created_at: u.created_at,
  };
}

module.exports = {
  ApiError, bad, notFound, forbidden, unauthorized, conflict,
  str, int, oneOf, bool, normUsername,
  parseJsonArray, cleanItems, cleanNeutrals, cleanSkills, cleanTalents,
  paging, nowIso, slugify, randomId, hashToken, timeAgo, publicUser,
};
