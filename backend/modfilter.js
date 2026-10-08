/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — модерация чата
   ──────────────────────────────────────────────────────────────────────
   Две вещи, которые админ попросил сделать вместе:

   • чат-бан: пользователь не может писать комментарии к билдам и посты
     в ветках. Читать и голосовать — может. Срок: день / неделя / год /
     навсегда. Администратор пишет всегда.

   • фильтр «неприемлемого»: мат, оскорбления, угрозы, спам-паттерны,
     капс-крик. Помеченный текст не публикуется, а уходит в очередь
     модерации в админке — решение принимает человек, не фильтр.

   Модуль не зависит от роутов: builds и threads зовут одни и те же
   функции, поэтому правило нельзя случайно обойти в одном из разделов.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { ROLES } = require('./config');
const { forbidden } = require('./util');

/* ── чат-бан ─────────────────────────────────────────────────────────── */

/** Активен ли чат-бан у пользователя. Возвращает объект или null. */
function chatBanActive(db, userId) {
  const u = db.prepare('select chat_ban_until, chat_ban_forever, chat_ban_reason from users where id = ?').get(userId);
  if (!u) return null;
  if (u.chat_ban_forever) {
    return { until: null, forever: true, reason: u.chat_ban_reason || '' };
  }
  if (u.chat_ban_until && new Date(u.chat_ban_until).getTime() > Date.now()) {
    return { until: u.chat_ban_until, forever: false, reason: u.chat_ban_reason || '' };
  }
  return null;
}

/** Публичная обёртка — уходит в профиль и /me. */
function chatBanPayload(db, userId) {
  const ban = chatBanActive(db, userId);
  if (!ban) return { active: false };
  return {
    active: true,
    until: ban.until,
    forever: ban.forever,
    reason: ban.reason,
  };
}

/** Кидает 403, если писать нельзя. */
function assertCanChat(db, user) {
  if (!user || user.role === ROLES.ADMIN) return;
  const ban = chatBanActive(db, user.id);
  if (!ban) return;
  const till = ban.forever
    ? 'навсегда'
    : 'до ' + new Date(ban.until).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  throw forbidden(`Чат заблокирован${ban.reason ? ': ' + ban.reason : ''} ${till}`);
}

/* ── фильтр неприемлемого текста ────────────────────────────────────── */

/** Приводим текст к «ровной» строке: нижний регистр, ё→е, без пунктуации. */
function normalize(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(.)\1{3,}/g, '$1$1')        // «хххх» → «хх» (защита от растягивания мата)
    .replace(/[^a-z0-9а-я\s]/g, ' ')      // стираем пунктуацию и эмодзи
    .replace(/\s+/g, ' ')
    .trim();
}

// Словарь проверяем по границам слова: «лох» не срабатывает внутри «лохматый».
// Короткие (3 буквы и меньше) проверяем вхождением — для них границ нет.
const BAD_RU = [
  'хуй', 'хуя', 'хуе', 'хуи', 'хуё', 'пизд', 'бляд', 'бля', 'ебал', 'ебат',
  'ебан', 'ебучи', 'ебаш', 'выеб', 'заеб', 'наеб', 'уеб', 'ебло', 'сука',
  'тварь', 'гандон', 'мудак', 'мудил', 'дебил', 'идиот', 'даун', 'кретин',
  'урод', 'пидор', 'пидр', 'гнида', 'сволочь', 'шалав', 'шлюх', 'мразь',
  'сучёныш', 'сучон', 'проститут', 'лохотрон', 'развод', 'лошара', 'долбоеб',
  'сдохн', 'убью', 'зарежу', 'прибью', 'порву', 'пристрел', 'повесься',
  'удавись', 'сгни', 'умри', 'убейся', 'отрави себя', 'сдохни',
  'рашка', 'хохол', 'жид', 'нигер', 'чурка', 'черномаз', 'пиндос', 'кацап',
];
const BAD_EN = [
  'fuck', 'fuckin', 'fucked', 'fucker', 'motherfuck', 'shit', 'bitch',
  'asshole', 'cunt', 'nigger', 'nigga', 'pussy', 'slut', 'whore', 'bastard',
  'dumbass', 'moron', 'retard', 'faggot', 'kys', 'suck my dick',
];

/** Возвращает совпавшие «слова» (до трёх) или пустой массив. */
function flaggedBy(norm, words) {
  const hits = [];
  for (const w of words) {
    if (w.length <= 3) {
      if (norm.includes(w)) hits.push(w);
    } else {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|[^a-z0-9а-я])' + esc + '([^a-z0-9а-я]|$)', 'i');
      if (re.test(norm)) hits.push(w);
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

/**
 * Оценивает текст. Результат — подсказка человеку, не приговор:
 * { flagged: boolean, reasons: string[] }.
 */
function moderateText(text) {
  const raw = String(text || '');
  const reasons = [];
  const norm = normalize(raw);

  const ru = flaggedBy(norm, BAD_RU);
  if (ru.length) reasons.push(`нецензурное: ${ru.join(', ')}`);
  const en = flaggedBy(norm, BAD_EN);
  if (en.length) reasons.push(`мат (а-ля: ${en.join(', ')})`);

  const links = (raw.match(/https?:\/\/\S+|www\.\S+/gi) || []).length;
  if (links >= 2) reasons.push('несколько ссылок — похоже на рекламу');

  const digits = norm.replace(/\s+/g, '');
  if (/(\+?7\d{10}|8\d{10})/.test(digits)) reasons.push('телефон в сообщении');

  const letters = (norm.match(/[a-zа-я]/g) || []).length;
  const upper = (raw.match(/[A-ZА-ЯЁ]/g) || []).length;
  if (letters > 24 && upper / letters > 0.6) reasons.push('кричащие заглавные буквы');

  if (/(.)\1{8,}/.test(norm)) reasons.push('повторяющиеся символы (спам)');

  return { flagged: reasons.length > 0, reasons };
}

module.exports = {
  chatBanActive, chatBanPayload, assertCanChat, moderateText,
};