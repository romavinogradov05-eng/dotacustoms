/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — админ-панель
   ──────────────────────────────────────────────────────────────────────
   Только для роли admin:
     • обзор: пользователи, контент, жалобы, ожидающие треды
     • удаление билдов, топов, веток, гайдов
     • бан / разбан, смена роли, выдача Coach с областями
     • чтение и решение жалоб, журнал модерации
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { ROLES, COACH_SCOPES, THREAD_STATUS, LIMITS, MODE_KEYS, TOP_KIND_KEYS } = require('../config');
const {
  str, oneOf, bool, bad, notFound, nowIso, paging, timeAgo,
} = require('../util');
const { requireAdmin, destroyUserSessions, hashPassword } = require('../auth');
const { wrap } = require('../http');
const { MODERATION, resolveContent } = require('../notify');

const { FLAG_TARGETS, FLAG_REASONS } = require('./users');

function log(db, actorId, action, type, id, reason = '') {
  db.prepare(`
    insert into mod_log (actor_id, action, target_type, target_id, reason, created_at)
    values (?,?,?,?,?,?)
  `).run(actorId, action, type, id, reason, nowIso());
}

module.exports = function adminRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();
  router.use(requireAdmin);

  // ── обзор ────────────────────────────────────────────────────────────
  router.get('/overview', wrap((_req, res) => {
    const one = sql => db.prepare(sql).get().c;
    res.json({
      users: {
        total: one('select count(*) as c from users'),
        banned: one('select count(*) as c from users where is_banned = 1'),
        coaches: one("select count(*) as c from users where role = 'coach'"),
        new_7d: one("select count(*) as c from users where created_at >= datetime('now','-7 days')"),
      },
      content: {
        builds: one('select count(*) as c from builds'),
        builds_draft: one('select count(*) as c from builds where is_draft = 1'),
        builds_verified: one('select count(*) as c from builds where verified_at is not null'),
        tops: one('select count(*) as c from meta_tops'),
        threads: one('select count(*) as c from threads where is_deleted = 0'),
        threads_deleted: one('select count(*) as c from threads where is_deleted = 1'),
        posts: one('select count(*) as c from posts where is_deleted = 0'),
        guides: one('select count(*) as c from guides where published = 1'),
      },
      queue: {
        flags_open: one("select count(*) as c from flags where status = 'open'"),
        threads_open: one("select count(*) as c from threads where is_deleted = 0 and status = 'open'"),
        threads_confirmed: one("select count(*) as c from threads where is_deleted = 0 and status = 'confirmed'"),
        builds_unverified: one('select count(*) as c from builds where is_draft = 0 and verified_at is null'),
        coach_applications: one("select count(*) as c from users where role = 'user' and bio like '%coach%'"),
      },
    });
  }));

  // ── пользователи ─────────────────────────────────────────────────────
  router.get('/users', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 25, maxSize: 100 });
    const where = ['1=1'];
    const params = [];
    if (req.query.q) {
      where.push('(username like ? or nickname like ? or ban_reason like ?)');
      const like = `%${String(req.query.q).slice(0, 40)}%`;
      params.push(like, like, like);
    }
    if (oneOf(req.query.role, ['user', 'coach', 'admin'], { field: 'роль', required: false })) {
      where.push('role = ?'); params.push(req.query.role);
    }
    if (oneOf(req.query.banned, ['0', '1'], { field: 'бан', required: false })) {
      where.push(bool(req.query.banned) ? 'is_banned = 1' : 'is_banned = 0');
    }
    const rows = db.prepare(`
      select id, username, nickname, avatar, role, bio, contact, is_banned, ban_reason, created_at, last_seen_at
        from users where ${where.join(' and ')} order by created_at desc limit ? offset ?
    `).all(...params, size, offset);
    const total = db.prepare(`select count(*) as c from users where ${where.join(' and ')}`).get(...params).c;

    const scopes = db.prepare('select user_id, scope from coach_scopes').all();
    const byUser = new Map();
    for (const s of scopes) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s.scope);
    }
    res.json({
      items: rows.map(u => ({ ...u, coach_scopes: byUser.get(u.id) || [], ago: timeAgo(u.created_at) })),
      total, page, per_page: size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  router.post('/users/:id/role', wrap((req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('select * from users where id = ?').get(id);
    if (!u) throw notFound('Пользователь не найден');
    const role = oneOf(req.body.role, ['user', 'coach', 'admin'], { field: 'роль' });
    const scopes = Array.isArray(req.body.coach_scopes) ? req.body.coach_scopes : [];
    for (const s of scopes) if (!COACH_SCOPES.includes(s)) throw bad(`Область «${s}» неизвестна`);

    // не даём снять админа с себя, если админов больше нет
    if (u.role === ROLES.ADMIN && role !== ROLES.ADMIN) {
      const admins = db.prepare("select count(*) as c from users where role = 'admin'").get().c;
      if (admins <= 1) throw bad('Нельзя снять роль у последнего администратора');
    }
    if (u.id === req.user.id && role !== ROLES.ADMIN) {
      throw bad('Нельзя снять права с самого себя');
    }

    db.prepare('update users set role = ? where id = ?').run(role, id);
    db.prepare('delete from coach_scopes where user_id = ?').run(id);
    if (role === ROLES.COACH) {
      const ins = db.prepare('insert or ignore into coach_scopes (user_id, scope) values (?,?)');
      const list = scopes.length ? scopes : ['*'];
      for (const s of list) ins.run(id, s);
    }
    log(db, req.user.id, 'set_role', 'user', id, `${u.role} → ${role} [${scopes.join(',') || '-'}]`);
    res.json({ ok: true, role, coach_scopes: db.prepare('select scope from coach_scopes where user_id = ?').all(id).map(r => r.scope) });
  }));

  router.post('/users/:id/ban', wrap((req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('select * from users where id = ?').get(id);
    if (!u) throw notFound('Пользователь не найден');
    if (u.id === req.user.id) throw bad('Нельзя забанить самого себя');
    if (u.role === ROLES.ADMIN) throw bad('Нельзя банить администратора');

    const ban = bool(req.body.banned, true);
    const reason = str(req.body.reason, { field: 'причина', max: 400, required: ban });
    db.prepare('update users set is_banned = ?, ban_reason = ? where id = ?').run(ban ? 1 : 0, reason, id);
    if (ban) destroyUserSessions(db, id);
    log(db, req.user.id, ban ? 'ban' : 'unban', 'user', id, reason);
    res.json({ ok: true, banned: ban });
  }));

  router.post('/users/:id/password', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('select 1 from users where id = ?').get(id)) throw notFound('Пользователь не найден');
    const password = String(req.body.password || '');
    if (password.length < LIMITS.passwordMin) throw bad(`Пароль: минимум ${LIMITS.passwordMin} символов`);
    db.prepare('update users set password_hash = ? where id = ?').run(hashPassword(password), id);
    destroyUserSessions(db, id);
    log(db, req.user.id, 'reset_password', 'user', id, '');
    res.json({ ok: true });
  }));

  // ── удаление любого контента ─────────────────────────────────────────
  router.delete('/content/:type/:id', wrap((req, res) => {
    const type = oneOf(req.params.type, ['build', 'top', 'thread', 'guide', 'post', 'comment'], { field: 'тип' });
    const id = Number(req.params.id);
    const table = { build: 'builds', top: 'meta_tops', thread: 'threads', guide: 'guides', post: 'posts', comment: 'build_comments' }[type];
    const reason = str(req.body?.reason ?? req.query.reason, { field: 'причина', max: 300, required: false });
    const info = db.prepare(`delete from ${table} where id = ?`).run(id);
    if (!info.changes) throw notFound('Объект не найден');
    log(db, req.user.id, `delete_${type}`, type, id, reason);
    res.json({ ok: true });
  }));

  // ── мягкое удаление ветки ────────────────────────────────────────────
  router.post('/threads/:id/hide', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('select 1 from threads where id = ?').get(id)) throw notFound('Ветка не найдена');
    const hide = bool(req.body.hidden, true);
    db.prepare('update threads set is_deleted = ?, is_pinned = 0, updated_at = ? where id = ?')
      .run(hide ? 1 : 0, nowIso(), id);
    log(db, req.user.id, hide ? 'hide_thread' : 'restore_thread', 'thread', id,
         str(req.body?.reason, { field: 'причина', max: 300, required: false }));
    res.json({ ok: true, hidden: hide });
  }));

  // ── жалобы ───────────────────────────────────────────────────────────
  router.get('/flags', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 25, maxSize: 100 });
    const status = oneOf(req.query.status, ['open', 'accepted', 'rejected'], { field: 'статус', required: false, def: 'open' });
    const rows = db.prepare(`
      select f.*, u.nickname as reporter_nickname, u.username as reporter_username
        from flags f join users u on u.id = f.reporter_id
       where f.status = ? order by f.created_at desc limit ? offset ?
    `).all(status, size, offset);
    const total = db.prepare('select count(*) as c from flags where status = ?').get(status).c;
    res.json({ items: rows.map(f => ({ ...f, ago: timeAgo(f.created_at) })), total, page, per_page: size });
  }));

  router.post('/flags/:id/resolve', wrap((req, res) => {
    const id = Number(req.params.id);
    const f = db.prepare('select * from flags where id = ?').get(id);
    if (!f) throw notFound('Жалоба не найдена');
    const status = oneOf(req.body.status, ['accepted', 'rejected'], { field: 'решение' });
    db.prepare('update flags set status = ?, resolved_by = ?, resolved_at = ? where id = ?')
      .run(status, req.user.id, nowIso(), id);
    log(db, req.user.id, 'resolve_flag', 'flag', id, status);
    res.json({ ok: true, status });
  }));

  // ── треды на модерации ───────────────────────────────────────────────
  router.get('/threads', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 25, maxSize: 100 });
    const status = oneOf(req.query.status, THREAD_STATUS, { field: 'статус', required: false, def: 'open' });
    const rows = db.prepare(`
      select t.id, t.title, t.mode, t.category, t.status, t.severity, t.is_pinned, t.is_deleted,
             t.created_at, t.updated_at, u.nickname as author_nickname, u.username as author_username,
             (select count(*) from posts p where p.thread_id = t.id and p.is_deleted = 0) as replies
        from threads t join users u on u.id = t.author_id
       where t.status = ? order by
         case t.severity when 'blocker' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
         t.created_at asc
       limit ? offset ?
    `).all(status, size, offset);
    const total = db.prepare('select count(*) as c from threads where status = ?').get(status).c;
    res.json({ items: rows.map(r => ({ ...r, ago: timeAgo(r.created_at) })), total, page, per_page: size });
  }));

  /* ── очередь модерации ───────────────────────────────────────────────
     Создавать билды и топы могут только Coach и администраторы, и их
     контент публикуется сразу — поэтому очередь обычно пуста. Сюда
     попадают только черновики (у них статус pending): их можно подтвердить
     или отклонить. Разделение на страницы, как в dotadle. */
  const QUEUE = {
    build: { table: 'builds', title: 'Билд', route: '/builds' },
    top: { table: 'meta_tops', title: 'Топ', route: '/tops' },
  };

  router.get('/queue', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 20, maxSize: 50 });
    const type = oneOf(req.query.type, Object.keys(QUEUE), { field: 'раздел', def: 'build' });
    const conf = QUEUE[type];

    const where = ['moderation = ?'];
    const params = [MODERATION.PENDING];
    if (oneOf(req.query.mode, MODE_KEYS, { required: false })) {
      where.push('mode = ?'); params.push(req.query.mode);
    }
    if (type === 'top' && oneOf(req.query.kind, TOP_KIND_KEYS, { required: false })) {
      where.push('kind = ?'); params.push(req.query.kind);
    }
    if (req.query.q) {
      where.push('title like ?');
      params.push(`%${String(req.query.q).slice(0, 60)}%`);
    }

    const rows = db.prepare(`
      select t.*, u.nickname as author_nickname, u.username as author_username, u.role as author_role
        from ${conf.table} t join users u on u.id = t.author_id
       where ${where.join(' and ')}
       order by t.created_at asc, t.id asc
       limit ? offset ?
    `).all(...params, size, offset);

    const total = db.prepare(`select count(*) as c from ${conf.table} where ${where.join(' and ')}`)
      .get(...params).c;

    const counts = {};
    for (const key of Object.keys(QUEUE)) {
      counts[key] = db.prepare(`select count(*) as c from ${QUEUE[key].table} where moderation = ?`)
        .get(MODERATION.PENDING).c;
    }

    res.json({
      items: rows.map(r => ({
        id: r.id,
        type,
        type_title: conf.title,
        title: r.title,
        mode: r.mode,
        kind: r.kind || null,
        patch: r.patch,
        description: r.description,
        stage: r.stage || null,
        created_at: r.created_at,
        ago: timeAgo(r.created_at),
        route: conf.route,
        author: {
          id: r.author_id, nickname: r.author_nickname,
          username: r.author_username, role: r.author_role,
        },
      })),
      total, page, per_page: size,
      pages: Math.max(1, Math.ceil(total / size)),
      counts,
    });
  }));

  // Одно решение на объект: подтвердить или отклонить.
  router.post('/queue/:type/:id', wrap((req, res) => {
    const type = oneOf(req.params.type, Object.keys(QUEUE), { field: 'раздел' });
    const decision = oneOf(req.body.decision, ['approve', 'reject'], { field: 'решение' });
    const note = str(req.body.note, { field: 'комментарий', max: 500, required: false });

    const result = resolveContent(db, {
      type, id: Number(req.params.id), decision,
      admin: req.user, note, mailer: ctx.mailer,
    });
    if (!result) throw notFound(`${QUEUE[type].title} не найден`);

    db.prepare(`
      insert into mod_log (actor_id, action, target_type, target_id, reason, created_at)
      values (?,?,?,?,?,?)
    `).run(req.user.id, `queue_${decision}`, type, Number(req.params.id), note, nowIso());

    if (ctx.mailer) ctx.mailer.flushSoon(db);
    res.json({ ok: true, ...result });
  }));

  // Отклонить всё выбранное на странице — как кнопка в dotadle.
  router.post('/queue/:type/reject-all', wrap((req, res) => {
    const type = oneOf(req.params.type, Object.keys(QUEUE), { field: 'раздел' });
    const ids = Array.isArray(req.body.ids)
      ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 100)
      : [];
    if (!ids.length) throw bad('Нечего отклонять');

    let done = 0;
    for (const id of ids) {
      const r = resolveContent(db, {
        type, id, decision: 'reject', admin: req.user,
        note: 'Отклонено пакетно', mailer: ctx.mailer,
      });
      if (r) {
        db.prepare(`
          insert into mod_log (actor_id, action, target_type, target_id, reason, created_at)
          values (?,?,?,?,?,?)
        `).run(req.user.id, 'queue_reject', type, id, 'Отклонено пакетно', nowIso());
        done++;
      }
    }
    if (ctx.mailer) ctx.mailer.flushSoon(db);
    res.json({ ok: true, done });
  }));

  /* ── очередь писем ──────────────────────────────────────────────────── */
  router.get('/mail-queue', wrap((_req, res) => {
    const rows = db.prepare('select * from email_queue order by created_at desc, id desc limit 100').all();
    res.json({
      items: rows.map(r => ({
        id: r.id, to: r.to_addr, subject: r.subject, status: r.status,
        attempts: r.attempts, last_error: r.last_error, created_at: r.created_at,
      })),
      pending: db.prepare(`select count(*) as c from email_queue where status = 'pending'`).get().c,
    });
  }));

  router.post('/mail-queue/flush', wrap(async (_req, res) => {
    if (!ctx.mailer) throw bad('Почта недоступна');
    res.json(await ctx.mailer.flush(db, { limit: 50 }));
  }));

  // ── журнал модерации ─────────────────────────────────────────────────
  router.get('/log', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 40, maxSize: 100 });
    const rows = db.prepare(`
      select m.*, u.nickname as actor_nickname, u.username as actor_username
        from mod_log m left join users u on u.id = m.actor_id
       order by m.created_at desc limit ? offset ?
    `).all(size, offset);
    const total = db.prepare('select count(*) as c from mod_log').get().c;
    res.json({ items: rows, total, page, per_page: size });
  }));

  // ── бэкап базы (скачать .db) ─────────────────────────────────────────
  router.get('/backup', wrap((_req, res) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = ctx.dbFile;
    if (!file || !fs.existsSync(file)) throw notFound('Файл базы не найден');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="dotacustoms-${Date.now()}.db"`);
    fs.createReadStream(file).pipe(res);
  }));

  return router;
};

module.exports.FLAG_TARGETS = FLAG_TARGETS;
module.exports.FLAG_REASONS = FLAG_REASONS;
