/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — регистрация, вход, выход, текущий пользователь
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { LIMITS } = require('../config');
const { str, bad, conflict, unauthorized, nowIso, publicUser } = require('../util');
const {
  hashPassword, verifyPassword, createSession, destroySession, coachScopes, requireAuth,
} = require('../auth');
const { wrap, rateLimit } = require('../http');
const { chatBanPayload } = require('../modfilter');

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'dota', 'dotacustoms', 'moder', 'модератор']);

function profilePayload(db, user) {
  const counts = db.prepare(`
    select
      (select count(*) from builds   where author_id = ? and is_draft = 0) as builds,
      (select count(*) from meta_tops where author_id = ? and is_draft = 0) as tops,
      (select count(*) from threads  where author_id = ? and is_deleted = 0) as threads,
      (select coalesce(sum(case when value > 0 then 1 else -1 end), 0) from build_votes bv
         join builds b on b.id = bv.build_id
        where b.author_id = ? and b.is_draft = 0) as reputation
  `).get(user.id, user.id, user.id, user.id);
  return {
    ...publicUser(user), coach_scopes: coachScopes(db, user), stats: counts,
    chat_ban: chatBanPayload(db, user.id),
  };
}

module.exports = function authRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  const authLimiter = rateLimit({
    windowMs: 60_000, max: 20,
    message: 'Слишком много попыток входа. Подожди минуту.',
  });

  // ── регистрация ──────────────────────────────────────────────────────
  router.post('/register', authLimiter, wrap((req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw bad('Ник: 3–20 символов, латиница, цифры, «_» и «-». Начинается с буквы или цифры');
    }
    if (RESERVED.has(username)) throw conflict('Этот ник зарезервирован');

    const nickname = str(req.body.nickname, { field: 'отображаемое имя', max: LIMITS.nicknameMax }) || username;
    const password = String(req.body.password || '');
    if (password.length < LIMITS.passwordMin) {
      throw bad(`Пароль: минимум ${LIMITS.passwordMin} символов`);
    }
    if (password.length > LIMITS.passwordMax) throw bad('Пароль слишком длинный');

    const exists = db.prepare('select id from users where username = ?').get(username);
    if (exists) throw conflict('Такой ник уже занят');

    // Почта нужна, чтобы присылать решение по заявке. Необязательна, но
    // если человек её ввёл — ошибку лучше показать сейчас, чем молча
    // не отправить ему письмо через месяц.
    const email = str(req.body.email, { field: 'почта', max: 120, required: false }).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw bad('Почта выглядит неправильно — проверьте адрес');
    }

    const info = db.prepare(`
      insert into users (username, nickname, password_hash, role, bio, avatar, contact,
                         email, created_at, last_seen_at)
      values (?,?,?,?,?,?,?,?,?,?)
    `).run(
      username, nickname, hashPassword(password), 'user',
      str(req.body.bio, { field: 'о себе', max: LIMITS.bioMax, required: false }),
      str(req.body.avatar, { field: 'аватар', max: 40, required: false }),
      str(req.body.contact, { field: 'контакт', max: LIMITS.contactMax, required: false }),
      email,
      nowIso(), nowIso(),
    );

    const userId = Number(info.lastInsertRowid);
    // первый пользователь в пустой базе становится администратором
    const total = db.prepare('select count(*) as c from users').get().c;
    if (total === 1) db.prepare('update users set role = ? where id = ?').run('admin', userId);

    const user = db.prepare('select * from users where id = ?').get(userId);
    const token = createSession(db, userId, { userAgent: req.get('user-agent'), ip: req.ip });
    res.status(201).json({ token, user: profilePayload(db, user) });
  }));

  // ── вход ─────────────────────────────────────────────────────────────
  router.post('/login', authLimiter, wrap((req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!username || !password) throw bad('Введи ник и пароль');

    const user = db.prepare('select * from users where username = ?').get(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('Неверный ник или пароль');
    }
    if (user.is_banned) {
      throw bad(`Аккаунт заблокирован${user.ban_reason ? `: ${user.ban_reason}` : ''}`);
    }
    db.prepare('update users set last_seen_at = ? where id = ?').run(nowIso(), user.id);
    const token = createSession(db, user.id, { userAgent: req.get('user-agent'), ip: req.ip });
    res.json({ token, user: profilePayload(db, user) });
  }));

  // ── выход ────────────────────────────────────────────────────────────
  router.post('/logout', wrap((req, res) => {
    if (req.token) destroySession(db, req.token);
    res.json({ ok: true });
  }));

  // ── кто я ────────────────────────────────────────────────────────────
  router.get('/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: profilePayload(db, req.user) });
  });

  // ── смена пароля ─────────────────────────────────────────────────────
  router.post('/password', requireAuth, wrap((req, res) => {
    const current = String(req.body.current || '');
    const next_ = String(req.body.next || '');
    if (!verifyPassword(current, req.user.password_hash)) throw bad('Текущий пароль неверен');
    if (next_.length < LIMITS.passwordMin) throw bad(`Новый пароль: минимум ${LIMITS.passwordMin} символов`);
    db.prepare('update users set password_hash = ? where id = ?').run(hashPassword(next_), req.user.id);
    destroySession(db, req.token);
    const token = createSession(db, req.user.id, { userAgent: req.get('user-agent'), ip: req.ip });
    res.json({ ok: true, token });
  }));

  return router;
};

module.exports.profilePayload = profilePayload;
