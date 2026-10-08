/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — ветви: форум багов, фич, баланса и гайдов
   ──────────────────────────────────────────────────────────────────────
   Ветка (thread) + посты (posts) с ответами и голосами.
   Управление статусом/закреплением/закрытием — Coach и администратор.
   Удаление — только администратор.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const {
  MODE_KEYS, THREAD_CATEGORY_KEYS, THREAD_STATUS, THREAD_SEVERITY, LIMITS, ROLES,
} = require('../config');
const {
  str, int, oneOf, bool, bad, notFound, forbidden, nowIso, paging, timeAgo,
} = require('../util');
const { requireAuth, requireStaff, requireAdmin, isCoachFor } = require('../auth');
const { wrap } = require('../http');
const { MODERATION, notifyAdmins } = require('../notify');
const { assertCanChat, moderateText } = require('../modfilter');

const STAFF = [ROLES.ADMIN, ROLES.COACH];

function threadPayload(db, t, viewer) {
  const vote = viewer
    ? db.prepare('select value from thread_votes where thread_id = ? and user_id = ?').get(t.id, viewer.id)
    : null;
  const score = db.prepare(
    'select coalesce(sum(value),0) as s from thread_votes where thread_id = ?'
  ).get(t.id).s;
  const replies = db.prepare(
    'select count(*) as c from posts where thread_id = ? and is_deleted = 0'
  ).get(t.id).c;
  const staff = !!viewer && (STAFF.includes(viewer.role) || isCoachFor(db, viewer, t.mode));
  return {
    id: t.id,
    mode: t.mode,
    category: t.category,
    title: t.title,
    body: t.body,
    excerpt: t.body.length > 220 ? `${t.body.slice(0, 220)}…` : t.body,
    hero_id: t.hero_id,
    patch: t.patch,
    severity: t.severity,
    status: t.status,
    is_pinned: !!t.is_pinned,
    is_locked: !!t.is_locked,
    views: t.views,
    replies,
    score,
    my_vote: vote ? vote.value : 0,
    created_at: t.created_at,
    updated_at: t.updated_at,
    ago: timeAgo(t.created_at),
    updated_ago: timeAgo(t.updated_at),
    resolved_by: t.resolved_by_name ? {
      nickname: t.resolved_by_name, username: t.resolved_by_username, role: t.resolved_by_role,
    } : null,
    resolved_at: t.resolved_at,
    author: {
      id: t.author_id, nickname: t.author_nickname, username: t.author_username,
      avatar: t.author_avatar, role: t.author_role,
    },
    can_edit: !!viewer && (viewer.id === t.author_id || viewer.role === ROLES.ADMIN),
    can_moderate: staff,
    can_delete: !!viewer && viewer.role === ROLES.ADMIN,
  };
}

const SELECT_THREAD = `
  select t.*,
         au.nickname as author_nickname, au.username as author_username,
         au.avatar as author_avatar, au.role as author_role,
         ru.nickname as resolved_by_name, ru.username as resolved_by_username,
         ru.role as resolved_by_role
    from threads t
    join users au on au.id = t.author_id
    left join users ru on ru.id = t.resolved_by
`;

function postPayload(db, p, viewer, threadLocked) {
  const score = db.prepare('select coalesce(sum(value),0) as s from post_votes where post_id = ?')
    .get(p.id).s;
  const myVote = viewer
    ? db.prepare('select value from post_votes where post_id = ? and user_id = ?').get(p.id, viewer.id)
    : null;
  return {
    id: p.id,
    thread_id: p.thread_id,
    parent_id: p.parent_id,
    body: p.is_deleted ? '' : p.body,
    is_deleted: !!p.is_deleted,
    created_at: p.created_at,
    ago: timeAgo(p.created_at),
    edited_at: p.edited_at,
    score,
    my_vote: myVote ? myVote.value : 0,
    author: {
      id: p.author_id, nickname: p.author_nickname, username: p.author_username,
      avatar: p.author_avatar, role: p.author_role,
    },
    can_edit: !!viewer && !threadLocked && (viewer.id === p.author_id || viewer.role === ROLES.ADMIN),
    can_delete: !!viewer && (viewer.id === p.author_id || viewer.role === ROLES.ADMIN),
    pending: p.moderation === MODERATION.PENDING,
  };
}

const SELECT_POST = `
  select p.*,
         u.nickname as author_nickname, u.username as author_username,
         u.avatar as author_avatar, u.role as author_role
    from posts p join users u on u.id = p.author_id
`;

module.exports = function threadRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── список веток ─────────────────────────────────────────────────────
  router.get('/', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 20, maxSize: 60 });
    const where = ['t.is_deleted = 0'];
    const params = [];

    const mode = oneOf(req.query.mode, [...MODE_KEYS, 'any'], { field: 'режим', required: false });
    if (mode) {
      if (mode === 'any') where.push('t.mode in (?,?,?)');
      else { where.push('t.mode = ?'); }
      if (mode === 'any') params.push(...MODE_KEYS); else params.push(mode);
    }
    const cat = oneOf(req.query.category, THREAD_CATEGORY_KEYS, { field: 'категория', required: false });
    if (cat) { where.push('t.category = ?'); params.push(cat); }
    const status = oneOf(req.query.status, THREAD_STATUS, { field: 'статус', required: false });
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (oneOf(req.query.severity, THREAD_SEVERITY, { field: 'важность', required: false })) {
      where.push('t.severity = ?'); params.push(req.query.severity);
    }
    if (req.query.author_id) { where.push('t.author_id = ?'); params.push(Number(req.query.author_id)); }
    if (req.query.author) {
      where.push('t.author_id = (select id from users where username = ?)');
      params.push(String(req.query.author).toLowerCase());
    }
    if (req.query.hero_id) { where.push('t.hero_id = ?'); params.push(Number(req.query.hero_id)); }
    if (req.query.pinned === '1') where.push('t.is_pinned = 1');
    if (req.query.q) {
      where.push('(t.title like ? or t.body like ?)');
      const like = `%${String(req.query.q).slice(0, 60)}%`;
      params.push(like, like);
    }

    const orderMap = {
      hot: `((select coalesce(sum(value),0) from thread_votes tv where tv.thread_id = t.id) + (select count(*) from posts p where p.thread_id = t.id and p.is_deleted = 0) * 2) desc, t.updated_at desc`,
      new: 't.created_at desc',
      active: 't.updated_at desc',
    };
    const order = orderMap[String(req.query.sort || 'active')] || orderMap.active;

    const rows = db.prepare(`
      ${SELECT_THREAD} where ${where.join(' and ')}
       order by t.is_pinned desc, ${order} limit ? offset ?
    `).all(...params, size, offset);
    const total = db.prepare(`select count(*) as c from threads t where ${where.join(' and ')}`)
      .get(...params).c;

    res.json({
      items: rows.map(t => threadPayload(db, t, req.user)),
      total, page, per_page: size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  // ── сводка: сколько открытых багов и фич ждут ───────────────────────
  router.get('/stats', wrap((_req, res) => {
    const byCategory = db.prepare(`
      select category, count(*) as c from threads
       where is_deleted = 0 group by category
    `).all();
    const byStatus = db.prepare(`
      select status, count(*) as c from threads
       where is_deleted = 0 group by status
    `).all();
    res.json({ by_category: byCategory, by_status: byStatus });
  }));

  // ── одна ветка ───────────────────────────────────────────────────────
  router.get('/:id', wrap((req, res) => {
    const t = db.prepare(`${SELECT_THREAD} where t.id = ? and t.is_deleted = 0`)
      .get(Number(req.params.id));
    if (!t) throw notFound('Ветка не найдена');
    db.prepare('update threads set views = views + 1 where id = ?').run(t.id);

    // Публичное — только одобренные сообщения; админ видит ещё и pending.
    const seePending = !!req.user && req.user.role === ROLES.ADMIN;
    const posts = db.prepare(`
      ${SELECT_POST} where p.thread_id = ? and p.is_deleted = 0
        ${seePending ? '' : `and p.moderation = '${MODERATION.APPROVED}'`}
      order by p.created_at asc
    `).all(t.id).map(p => postPayload(db, p, req.user, !!t.is_locked));

    res.json({ thread: threadPayload(db, t, req.user), posts });
  }));

  // ── создать ветку ────────────────────────────────────────────────────
  // Темы заводят только Coach и администраторы; ответы, голоса и жалобы
  // остаются доступны всем вошедшим.
  router.post('/', requireStaff, wrap((req, res) => {
    const mode = oneOf(req.body.mode, [...MODE_KEYS, 'any'], { field: 'режим' });
    const category = oneOf(req.body.category, THREAD_CATEGORY_KEYS, { field: 'категория' });
    const title = str(req.body.title, { field: 'название', max: LIMITS.titleMax });
    const body = str(req.body.body, { field: 'текст', min: 10, max: LIMITS.bodyMax });

    const info = db.prepare(`
      insert into threads (author_id, mode, category, title, body, hero_id, patch,
                          severity, status, created_at, updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, mode, category, title, body,
      req.body.hero_id ? int(req.body.hero_id, { field: 'герой', min: 1, max: 1000, required: false }) : null,
      str(req.body.patch, { field: 'патч', max: 12, required: false }),
      oneOf(req.body.severity, THREAD_SEVERITY, { field: 'важность', def: 'medium' }),
      'open', nowIso(), nowIso(),
    );
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  // ── изменить ветку ───────────────────────────────────────────────────
  router.patch('/:id', requireAuth, wrap((req, res) => {
    const t = db.prepare('select * from threads where id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Ветка не найдена');
    if (t.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) {
      throw forbidden('Редактировать ветку может только автор');
    }
    const set = {};
    if (req.body.title !== undefined) set.title = str(req.body.title, { field: 'название', max: LIMITS.titleMax });
    if (req.body.body !== undefined) set.body = str(req.body.body, { field: 'текст', min: 10, max: LIMITS.bodyMax });
    if (req.body.category !== undefined) set.category = oneOf(req.body.category, THREAD_CATEGORY_KEYS, { field: 'категория' });
    if (req.body.severity !== undefined) set.severity = oneOf(req.body.severity, THREAD_SEVERITY, { field: 'важность' });
    if (req.body.patch !== undefined) set.patch = str(req.body.patch, { field: 'патч', max: 12, required: false });
    if (req.body.hero_id !== undefined) set.hero_id = req.body.hero_id ? int(req.body.hero_id, { field: 'герой', min: 1, max: 1000 }) : null;
    if (!Object.keys(set).length) throw bad('Нечего сохранять');
    set.updated_at = nowIso();
    const cols = Object.keys(set).map(k => `${k} = ?`).join(', ');
    db.prepare(`update threads set ${cols} where id = ?`).run(...Object.values(set), t.id);
    res.json({ ok: true });
  }));

  // ── удалить ветку (админ) ────────────────────────────────────────────
  router.delete('/:id', requireAuth, wrap((req, res) => {
    if (req.user.role !== ROLES.ADMIN) throw forbidden('Удалять ветки может только администратор');
    const t = db.prepare('select id from threads where id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Ветка не найдена');
    // мягкое удаление: контент скрыт из ленты, но остаётся в базе
    db.prepare('update threads set is_deleted = 1, is_pinned = 0, updated_at = ? where id = ?')
      .run(nowIso(), t.id);
    db.prepare(
      `insert into mod_log (actor_id, action, target_type, target_id, reason, created_at)
       values (?,?,?,?,?,?)`
    ).run(req.user.id, 'delete_thread', 'thread', t.id,
         str(req.body?.reason, { field: 'причина', max: 300, required: false }), nowIso());
    res.json({ ok: true });
  }));

  // ── модерация ветки: статус / закрепление / замок ────────────────────
  router.post('/:id/moderate', requireAuth, wrap((req, res) => {
    if (!STAFF.includes(req.user.role)) throw forbidden('Модерировать ветки может Coach или администратор');
    const t = db.prepare('select * from threads where id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Ветка не найдена');
    if (req.user.role === ROLES.COACH && !isCoachFor(db, req.user, t.mode)) {
      throw forbidden('Этот режим не в твоей области Coach');
    }
    const set = {};
    if (req.body.status !== undefined) set.status = oneOf(req.body.status, THREAD_STATUS, { field: 'статус' });
    if (req.body.is_pinned !== undefined) set.is_pinned = bool(req.body.is_pinned) ? 1 : 0;
    if (req.body.is_locked !== undefined) set.is_locked = bool(req.body.is_locked) ? 1 : 0;
    if (!Object.keys(set).length) throw bad('Нечего менять');

    if (set.status && set.status !== 'open' && !t.resolved_at) {
      set.resolved_by = req.user.id;
      set.resolved_at = nowIso();
    }
    set.updated_at = nowIso();
    const cols = Object.keys(set).map(k => `${k} = ?`).join(', ');
    db.prepare(`update threads set ${cols} where id = ?`).run(...Object.values(set), t.id);
    res.json({ ok: true });
  }));

  // ── голос за ветку ───────────────────────────────────────────────────
  router.post('/:id/vote', requireAuth, wrap((req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('select 1 from threads where id = ?').get(id)) throw notFound('Ветка не найдена');
    const value = oneOf(String(req.body.value ?? 1), ['1', '-1', '0'], { field: 'голос' });
    if (Number(value) === 0) {
      db.prepare('delete from thread_votes where thread_id = ? and user_id = ?').run(id, req.user.id);
    } else {
      db.prepare('delete from thread_votes where thread_id = ? and user_id = ?').run(id, req.user.id);
      db.prepare('insert into thread_votes (thread_id, user_id, value, created_at) values (?,?,?,?)')
        .run(id, req.user.id, Number(value), nowIso());
    }
    res.json({ ok: true });
  }));

  // ── посты ───────────────────────────────────────────────────────────
  router.post('/:id/posts', requireAuth, wrap((req, res) => {
    const t = db.prepare('select * from threads where id = ? and is_deleted = 0').get(Number(req.params.id));
    if (!t) throw notFound('Ветка не найдена');
    if (t.is_locked && req.user.role !== ROLES.ADMIN) throw forbidden('Ветка закрыта для новых сообщений');
    assertCanChat(db, req.user);
    const body = str(req.body.body, { field: 'сообщение', min: 1, max: LIMITS.bodyMax });
    const parentId = req.body.parent_id
      ? int(req.body.parent_id, { field: 'ответ на', min: 1, required: false }) : null;
    if (parentId) {
      const p = db.prepare('select thread_id from posts where id = ?').get(parentId);
      if (!p || p.thread_id !== t.id) throw bad('Сообщение, на которое ты отвечаешь, не найдено');
    }
    // Приемлемость решает фильтр, публикует администратор. Помеченное
    // уходит в очередь в админке, автору показываем «отправлено на проверку».
    const verdict = moderateText(body);
    const moderation = verdict.flagged ? MODERATION.PENDING : MODERATION.APPROVED;
    const info = db.prepare(
      'insert into posts (thread_id, author_id, parent_id, body, moderation, created_at) values (?,?,?,?,?,?)'
    ).run(t.id, req.user.id, parentId, body, moderation, nowIso());
    if (moderation === MODERATION.PENDING) {
      notifyAdmins(db, {
        kind: 'moderation',
        title: 'Сообщение в ветке ждёт проверки',
        body: `Возможно неуместное сообщение от ${req.user.nickname} в «${t.title}»: ${verdict.reasons.join('; ')}.`,
        link: '/admin?tab=comments',
        actorId: req.user.id,
      });
    }
    db.prepare('update threads set updated_at = ? where id = ?').run(nowIso(), t.id);
    res.status(201).json({ id: Number(info.lastInsertRowid), moderation, pending: moderation === MODERATION.PENDING });
  }));

  // Удалить все сообщения из ветки — только администратор.
  router.post('/:id/posts/clear', requireAdmin, wrap((req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('select id from threads where id = ?').get(id)) throw notFound('Ветка не найдена');
    const info = db.prepare('update posts set is_deleted = 1 where thread_id = ? and is_deleted = 0').run(id);
    db.prepare(`
      insert into mod_log (actor_id, action, target_type, target_id, reason, created_at)
      values (?,?,?,?,?,?)
    `).run(req.user.id, 'clear_posts', 'thread', id,
      str(req.body?.reason, { field: 'причина', max: 300, required: false }), nowIso());
    res.json({ ok: true, cleared: Number(info.changes) });
  }));

  router.patch('/:id/posts/:postId', requireAuth, wrap((req, res) => {
    const p = db.prepare('select * from posts where id = ? and thread_id = ?')
      .get(Number(req.params.postId), Number(req.params.id));
    if (!p) throw notFound('Сообщение не найдено');
    if (p.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) throw forbidden('Это не твоё сообщение');
    const body = str(req.body.body, { field: 'сообщение', min: 1, max: LIMITS.bodyMax });
    // Правка тоже проходит фильтр: иначе можно было бы отредактировать уже
    // одобренное сообщение и «протащить» неприемлемый текст мимо очереди.
    // Находившееся в очереди сообщение не публикуется само от чистки текста.
    const wasPending = (p.moderation || MODERATION.APPROVED) === MODERATION.PENDING;
    const verdict = moderateText(body);
    const moderation = wasPending || verdict.flagged ? MODERATION.PENDING : MODERATION.APPROVED;
    db.prepare('update posts set body = ?, edited_at = ?, moderation = ? where id = ?').run(body, nowIso(), moderation, p.id);
    if (verdict.flagged) {
      const t = db.prepare('select title from threads where id = ?').get(p.thread_id);
      notifyAdmins(db, {
        kind: 'moderation',
        title: 'Изменённое сообщение ждёт проверки',
        body: `Правка от ${req.user.nickname} в ветке «${t ? t.title : ''}» помечена: ${verdict.reasons.join('; ')}.`,
        link: '/admin?tab=comments',
        actorId: req.user.id,
      });
    }
    res.json({ ok: true, moderation });
  }));

  router.delete('/:id/posts/:postId', requireAuth, wrap((req, res) => {
    const p = db.prepare('select * from posts where id = ? and thread_id = ?')
      .get(Number(req.params.postId), Number(req.params.id));
    if (!p) throw notFound('Сообщение не найдено');
    if (p.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) throw forbidden('Нельзя удалить чужое сообщение');
    db.prepare('update posts set is_deleted = 1 where id = ?').run(p.id);
    res.json({ ok: true });
  }));

  router.post('/:id/posts/:postId/vote', requireAuth, wrap((req, res) => {
    const postId = Number(req.params.postId);
    if (!db.prepare('select 1 from posts where id = ? and thread_id = ?')
      .get(postId, Number(req.params.id))) throw notFound('Сообщение не найдено');
    const value = oneOf(String(req.body.value ?? 1), ['1', '-1', '0'], { field: 'голос' });
    if (Number(value) === 0) {
      db.prepare('delete from post_votes where post_id = ? and user_id = ?').run(postId, req.user.id);
    } else {
      db.prepare('delete from post_votes where post_id = ? and user_id = ?').run(postId, req.user.id);
      db.prepare('insert into post_votes (post_id, user_id, value, created_at) values (?,?,?,?)')
        .run(postId, req.user.id, Number(value), nowIso());
    }
    res.json({ ok: true });
  }));

  return router;
};
