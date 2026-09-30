/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — пользователи, профиль, жалобы на контент
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { LIMITS, ROLES } = require('../config');
const {
  str, oneOf, bad, notFound, nowIso, paging, timeAgo, publicUser,
} = require('../util');
const { requireAuth, coachScopes } = require('../auth');
const { wrap, rateLimit } = require('../http');

const FLAG_TARGETS = ['build', 'top', 'thread', 'post', 'comment', 'guide'];
const FLAG_REASONS = ['spam', 'abuse', 'plagiarism', 'wrong_info', 'other'];

function targetExists(db, type, id) {
  const table = { build: 'builds', top: 'meta_tops', thread: 'threads', post: 'posts', comment: 'build_comments', guide: 'guides' }[type];
  return !!db.prepare(`select 1 from ${table} where id = ?`).get(id);
}

module.exports = function userRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── мой профиль: правка ──────────────────────────────────────────────
  router.patch('/me', requireAuth, wrap((req, res) => {
    const set = {};
    if (req.body.nickname !== undefined) set.nickname = str(req.body.nickname, { field: 'имя', max: LIMITS.nicknameMax });
    if (req.body.bio !== undefined) set.bio = str(req.body.bio, { field: 'о себе', max: LIMITS.bioMax, required: false });
    if (req.body.avatar !== undefined) set.avatar = str(req.body.avatar, { field: 'аватар', max: 40, required: false });
    if (req.body.contact !== undefined) set.contact = str(req.body.contact, { field: 'контакт', max: LIMITS.contactMax, required: false });
    // Почта нужна, чтобы присылать решение по заявке. Проверяем формат
    // здесь, а не при отправке: иначе опечатку обнаружил бы админ.
    if (req.body.email !== undefined) {
      const email = str(req.body.email, { field: 'почта', max: 120, required: false }).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw bad('Почта выглядит неправильно — проверьте адрес');
      }
      set.email = email;
    }
    if (!Object.keys(set).length) throw bad('Нечего сохранять');
    const cols = Object.keys(set).map(k => `${k} = ?`).join(', ');
    db.prepare(`update users set ${cols} where id = ?`).run(...Object.values(set), req.user.id);
    res.json({ user: publicUser(db.prepare('select * from users where id = ?').get(req.user.id)) });
  }));

  // ── список пользователей ─────────────────────────────────────────────
  router.get('/', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 24, maxSize: 60 });
    const where = ['1=1'];
    const params = [];
    if (req.query.q) {
      where.push('(username like ? or nickname like ?)');
      const like = `%${String(req.query.q).slice(0, 40)}%`;
      params.push(like, like);
    }
    if (oneOf(req.query.role, ['user', 'coach', 'admin'], { field: 'роль', required: false })) {
      where.push('role = ?'); params.push(req.query.role);
    }
    const rows = db.prepare(`
      select id, username, nickname, avatar, role, bio, created_at, is_banned from users
       where ${where.join(' and ')} and is_banned = 0
       order by created_at desc limit ? offset ?
    `).all(...params, size, offset);
    const total = db.prepare(`select count(*) as c from users where ${where.join(' and ')} and is_banned = 0`)
      .get(...params).c;

    // области Coach нужны витрине тренеров, это не секрет
    const scopeRows = db.prepare('select user_id, scope from coach_scopes').all();
    const byUser = new Map();
    for (const r of scopeRows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r.scope);
    }

    res.json({
      items: rows.map(u => ({ ...u, coach_scopes: byUser.get(u.id) || [] })),
      total, page, per_page: size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  // ── профиль по техническому нику ────────────────────────────────────
  // Нужен для красивых ссылок /u/<username>: ники не меняются, id — нет.
  router.get('/by-name/:username', wrap((req, res) => {
    const u = db.prepare('select id from users where username = ?')
      .get(String(req.params.username).toLowerCase());
    if (!u) throw notFound('Пользователь не найден');
    const target = db.prepare('select id, is_banned from users where id = ?').get(u.id);
    if (target.is_banned && req.user?.role !== ROLES.ADMIN) throw notFound('Пользователь не найден');
    res.json({ id: target.id });
  }));

  // ── профиль пользователя ─────────────────────────────────────────────
  router.get('/:id', wrap((req, res) => {
    const u = db.prepare('select * from users where id = ?').get(Number(req.params.id));
    if (!u) throw notFound('Пользователь не найден');
    if (u.is_banned && req.user?.role !== ROLES.ADMIN) throw notFound('Пользователь не найден');

    // черновики видит только сам автор (и админ)
    const builds = db.prepare(`
      select b.id, b.title, b.mode, b.hero_id, b.stage, b.verified_at, b.created_at, b.is_draft
        from builds b where b.author_id = ?
        ${u.id === (req.user && req.user.id) ? '' : 'and b.is_draft = 0'}
       order by b.created_at desc limit 20
    `).all(u.id);
    const tops = db.prepare(`
      select t.id, t.title, t.mode, t.kind, t.verified_at, t.created_at, t.is_draft
        from meta_tops t where t.author_id = ?
        ${u.id === (req.user && req.user.id) ? '' : 'and t.is_draft = 0'}
       order by t.created_at desc limit 20
    `).all(u.id);
    const threads = db.prepare(`
      select t.id, t.title, t.mode, t.category, t.status, t.created_at
        from threads t where t.author_id = ? and t.is_deleted = 0
       order by t.created_at desc limit 12
    `).all(u.id);
    const stats = db.prepare(`
      select
        (select count(*) from builds where author_id = ? and is_draft = 0) as builds,
        (select count(*) from meta_tops where author_id = ? and is_draft = 0) as tops,
        (select count(*) from threads where author_id = ? and is_deleted = 0) as threads,
        (select count(*) from builds where verified_by = ? and is_draft = 0) as verified_builds,
        (select coalesce(sum(case when value > 0 then 1 else -1 end), 0) from build_votes bv
           join builds b on b.id = bv.build_id
          where b.author_id = ? and b.is_draft = 0) as reputation
    `).get(u.id, u.id, u.id, u.id, u.id);

    res.json({
      user: {
        ...publicUser(u),
        joined_ago: timeAgo(u.created_at),
        last_seen_ago: u.last_seen_at ? timeAgo(u.last_seen_at) : null,
        is_banned: !!u.is_banned,
        coach_scopes: coachScopes(db, u),
        stats,
      },
      builds, tops, threads,
    });
  }));

  // ── жалоба на контент ────────────────────────────────────────────────
  router.post('/flags', requireAuth, rateLimit({ windowMs: 10 * 60_000, max: 20, message: 'Слишком много жалоб, подожди' }), wrap((req, res) => {
    const target_type = oneOf(req.body.target_type, FLAG_TARGETS, { field: 'тип' });
    const target_id = Number(req.body.target_id);
    if (!Number.isInteger(target_id) || target_id <= 0) throw bad('Некорректный id');
    if (!targetExists(db, target_type, target_id)) throw notFound('Объект жалобы не найден');
    const dup = db.prepare(
      `select 1 from flags where reporter_id = ? and target_type = ? and target_id = ? and status = 'open'`
    ).get(req.user.id, target_type, target_id);
    if (dup) throw bad('Ты уже пожаловался на это');
    const info = db.prepare(`
      insert into flags (reporter_id, target_type, target_id, reason, details, created_at)
      values (?,?,?,?,?,?)
    `).run(
      req.user.id, target_type, target_id,
      oneOf(req.body.reason, FLAG_REASONS, { field: 'причина' }),
      str(req.body.details, { field: 'комментарий', max: 800, required: false }),
      nowIso(),
    );
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  return router;
};

module.exports.FLAG_TARGETS = FLAG_TARGETS;
module.exports.FLAG_REASONS = FLAG_REASONS;
