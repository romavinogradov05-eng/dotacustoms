/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — топы: персонажи, нейтралки, скиллы
   ──────────────────────────────────────────────────────────────────────
   Топ = ранжированный список ref_id (hero / neutral / ability) с тиром
   S–D и заметкой. Coach подтверждает топ так же, как билд.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { MODE_KEYS, TOP_KIND_KEYS, TOP_TIERS, LIMITS, ROLES } = require('../config');
const {
  str, oneOf, bool, bad, notFound, forbidden, nowIso, paging, timeAgo,
} = require('../util');
const { requireAuth, requireStaff, isCoachFor } = require('../auth');
const { wrap } = require('../http');
const { MODERATION, MODERATION_KEYS, moderationFor, notifyAdmins } = require('../notify');

function topPayload(db, t, viewer) {
  const liked = viewer
    ? !!db.prepare('select 1 from top_votes where top_id = ? and user_id = ?').get(t.id, viewer.id)
    : false;
  const likes = db.prepare('select count(*) as c from top_votes where top_id = ?').get(t.id).c;
  const entries = db.prepare(
    'select id, rank, ref_id, tier, note from meta_top_entries where top_id = ? order by rank asc, id asc'
  ).all(t.id);
  return {
    id: t.id,
    mode: t.mode,
    kind: t.kind,
    title: t.title,
    description: t.description,
    patch: t.patch,
    is_draft: !!t.is_draft,
    moderation: t.moderation || MODERATION.APPROVED,
    entries,
    entry_count: entries.length,
    likes,
    my_vote: liked,
    created_at: t.created_at,
    updated_at: t.updated_at,
    updated_ago: timeAgo(t.updated_at),
    verified: !!t.verified_at,
    verified_at: t.verified_at,
    verify_note: t.verify_note,
    verified_by: t.verified_by_name ? {
      nickname: t.verified_by_name, username: t.verified_by_username, role: t.verified_by_role,
    } : null,
    author: {
      id: t.author_id, nickname: t.author_nickname, username: t.author_username,
      avatar: t.author_avatar, role: t.author_role,
    },
    can_edit: !!viewer && (viewer.id === t.author_id || viewer.role === ROLES.ADMIN),
    can_verify: !!viewer && (isCoachFor(db, viewer, t.mode) || viewer.role === ROLES.ADMIN),
    can_delete: !!viewer && (viewer.id === t.author_id || viewer.role === ROLES.ADMIN),
  };
}

const SELECT_TOP = `
  select t.*,
         au.nickname as author_nickname, au.username as author_username,
         au.avatar as author_avatar, au.role as author_role,
         vu.nickname as verified_by_name, vu.username as verified_by_username,
         vu.role as verified_by_role
    from meta_tops t
    join users au on au.id = t.author_id
    left join users vu on vu.id = t.verified_by
`;

/** Приводит записи к виду [{ref_id, rank, tier, note}] с проверками. */
function cleanEntries(list) {
  if (!Array.isArray(list)) throw bad('entries должен быть массивом');
  if (list.length > LIMITS.maxTopEntries) throw bad(`Максимум ${LIMITS.maxTopEntries} позиций`);
  const out = [];
  const seen = new Set();
  for (const [i, raw] of list.entries()) {
    const refId = Number(raw?.ref_id);
    if (!Number.isInteger(refId) || refId <= 0) continue;
    if (seen.has(refId)) continue;
    seen.add(refId);
    out.push({
      ref_id: refId,
      rank: Number.isInteger(Number(raw.rank)) ? Number(raw.rank) : i + 1,
      tier: TOP_TIERS.includes(raw.tier) ? raw.tier : '',
      note: str(raw.note, { field: 'note', max: 400, required: false }),
    });
  }
  if (out.length < LIMITS.minTopEntries) {
    throw bad(`Минимум ${LIMITS.minTopEntries} позиций в топе`);
  }
  return out;
}

function writeEntries(db, topId, entries) {
  db.prepare('delete from meta_top_entries where top_id = ?').run(topId);
  const ins = db.prepare(
    'insert into meta_top_entries (top_id, rank, ref_id, tier, note) values (?,?,?,?,?)'
  );
  for (const e of entries) ins.run(topId, e.rank, e.ref_id, e.tier, e.note);
  ins.finalize();
}

module.exports = function topRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── список ───────────────────────────────────────────────────────────
  router.get('/', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 20, maxSize: 60 });
    const where = ['1=1'];
    const params = [];

    const mode = oneOf(req.query.mode, MODE_KEYS, { field: 'режим', required: false });
    if (mode) { where.push('t.mode = ?'); params.push(mode); }
    const kind = oneOf(req.query.kind, TOP_KIND_KEYS, { field: 'вид топа', required: false });
    if (kind) { where.push('t.kind = ?'); params.push(kind); }
    if (req.query.author_id) { where.push('t.author_id = ?'); params.push(Number(req.query.author_id)); }
    if (req.query.author) {
      where.push('t.author_id = (select id from users where username = ?)');
      params.push(String(req.query.author).toLowerCase());
    }
    if (oneOf(req.query.verified, ['0', '1'], { field: 'verified', required: false })) {
      where.push(bool(req.query.verified) ? 't.verified_at is not null' : 't.verified_at is null');
    }
    // Черновики и неподтверждённые видит только автор, админ и Coach режима.
    const isStaff = !!req.user && (req.user.role === ROLES.ADMIN
      || (mode ? isCoachFor(db, req.user, mode) : MODE_KEYS.some(m => isCoachFor(db, req.user, m))));
    where.push(isStaff ? '1=1' : '(t.is_draft = 0 or t.author_id = ?)');
    if (!isStaff) params.push(req.user?.id ?? -1);

    if (req.query.moderation) {
      const m = oneOf(req.query.moderation, MODERATION_KEYS, { field: 'статус', required: false });
      if (m) { where.push('t.moderation = ?'); params.push(m); }
    } else if (!isStaff) {
      where.push(`t.moderation = '${MODERATION.APPROVED}'`);
    }

    const order = String(req.query.sort) === 'hot'
      ? '(select count(*) from top_votes tv where tv.top_id = t.id) desc, t.created_at desc'
      : 't.created_at desc';

    const rows = db.prepare(`
      ${SELECT_TOP}
       where ${where.join(' and ')}
       order by ${order}
       limit ? offset ?
    `).all(...params, size, offset);

    const items = rows.map(r => topPayload(db, r, req.user));
    const total = db.prepare(`select count(*) as c from meta_tops t where ${where.join(' and ')}`)
      .get(...params).c;

    res.json({ items, total, page, per_page: size, pages: Math.max(1, Math.ceil(total / size)) });
  }));

  // ── один топ ─────────────────────────────────────────────────────────
  router.get('/:id', wrap((req, res) => {
    const t = db.prepare(`${SELECT_TOP} where t.id = ?`).get(Number(req.params.id));
    if (!t) throw notFound('Топ не найден');
    const pending = (t.moderation || MODERATION.APPROVED) === MODERATION.PENDING;
    if (pending && (!req.user || (req.user.id !== t.author_id
      && req.user.role !== ROLES.ADMIN && !isCoachFor(db, req.user, t.mode)))) {
      throw notFound('Топ не найден');
    }
    if (t.is_draft && (!req.user || (req.user.id !== t.author_id && req.user.role !== ROLES.ADMIN))) {
      throw notFound('Топ не найден');
    }
    res.json({ top: topPayload(db, t, req.user) });
  }));

  // ── создать ──────────────────────────────────────────────────────────
  // Только Coach и администраторы: топы пишет редакция, игроки голосуют.
  router.post('/', requireStaff, wrap((req, res) => {
    const mode = oneOf(req.body.mode, MODE_KEYS, { field: 'режим' });
    const kind = oneOf(req.body.kind, TOP_KIND_KEYS, { field: 'вид топа' });
    const title = str(req.body.title, { field: 'название', max: LIMITS.titleMax });
    const entries = cleanEntries(req.body.entries);
    const isDraft = bool(req.body.is_draft, false) ? 1 : 0;
    // Сюда доходят только Coach и админы (requireStaff) — публикуют сразу.
    const moderation = moderationFor(req.user, isDraft);

    const now = nowIso();
    const info = db.prepare(`
      insert into meta_tops (author_id, mode, kind, title, description, patch, is_draft,
                             moderation, created_at, updated_at)
      values (?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, mode, kind, title,
      str(req.body.description, { field: 'описание', max: LIMITS.descriptionMax, required: false }),
      str(req.body.patch, { field: 'патч', max: 12, required: false }),
      isDraft, moderation, now, now,
    );
    const id = Number(info.lastInsertRowid);
    writeEntries(db, id, entries);

    if (moderation === MODERATION.PENDING && !isDraft) {
      const what = kind === 'heroes' ? 'топ героев' : kind === 'neutrals' ? 'топ нейтралок' : 'топ скиллов';
      notifyAdmins(db, {
        kind: 'moderation',
        title: `Новый ${what} ждёт подтверждения: «${title}»`,
        body: `${req.user.nickname} (${mode}) прислал ${what} на проверку.`,
        link: '/admin?tab=queue',
        actorId: req.user.id,
      });
    }

    res.status(201).json({
      id, kind, mode, entries: entries.length, moderation,
      pending: moderation === MODERATION.PENDING,
    });
  }));

  // ── изменить ─────────────────────────────────────────────────────────
  router.patch('/:id', requireAuth, wrap((req, res) => {
    const t = db.prepare('select * from meta_tops where id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Топ не найден');
    if (t.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) throw forbidden('Редактировать может только автор');

    const set = {};
    if (req.body.title !== undefined) set.title = str(req.body.title, { field: 'название', max: LIMITS.titleMax });
    if (req.body.description !== undefined) set.description = str(req.body.description, { field: 'описание', max: LIMITS.descriptionMax, required: false });
    if (req.body.patch !== undefined) set.patch = str(req.body.patch, { field: 'патч', max: 12, required: false });
    if (req.body.is_draft !== undefined) set.is_draft = bool(req.body.is_draft) ? 1 : 0;
    if (Object.keys(set).length) {
      set.updated_at = nowIso();
      const cols = Object.keys(set).map(k => `${k} = ?`).join(', ');
      db.prepare(`update meta_tops set ${cols} where id = ?`).run(...Object.values(set), t.id);
    }
    if (req.body.entries !== undefined) {
      const entries = cleanEntries(req.body.entries);
      writeEntries(db, t.id, entries);
      db.prepare('update meta_tops set updated_at = ? where id = ?').run(nowIso(), t.id);
      db.prepare('update meta_tops set verified_at = null, verified_by = null, verify_note = ? where id = ?')
        .run('Состав изменён — нужно новое подтверждение', t.id);
    }
    res.json({ ok: true });
  }));

  // ── удалить ──────────────────────────────────────────────────────────
  router.delete('/:id', requireAuth, wrap((req, res) => {
    const t = db.prepare('select * from meta_tops where id = ?').get(Number(req.params.id));
    if (!t) throw notFound('Топ не найден');
    if (t.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) throw forbidden('Удалить может автор или администратор');
    db.prepare('delete from meta_tops where id = ?').run(t.id);
    res.json({ ok: true });
  }));

  // ── лайк ─────────────────────────────────────────────────────────────
  router.post('/:id/vote', requireAuth, wrap((req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare('select 1 from meta_tops where id = ?').get(id)) throw notFound('Топ не найден');
    const on = bool(req.body.value, true);
    if (on) {
      db.prepare('insert or ignore into top_votes (top_id, user_id, created_at) values (?,?,?)')
        .run(id, req.user.id, nowIso());
    } else {
      db.prepare('delete from top_votes where top_id = ? and user_id = ?').run(id, req.user.id);
    }
    res.json({ ok: true });
  }));

  // ── подтверждение Coach ──────────────────────────────────────────────
  router.post('/:id/verify', requireAuth, wrap((req, res) => {
    const id = Number(req.params.id);
    const t = db.prepare('select * from meta_tops where id = ?').get(id);
    if (!t) throw notFound('Топ не найден');
    if (!isCoachFor(db, req.user, t.mode) && req.user.role !== ROLES.ADMIN) {
      throw forbidden('Подтверждать топы может Coach этого режима или администратор');
    }
    const approved = bool(req.body.approved, true);
    db.prepare('update meta_tops set verified_at = ?, verified_by = ?, verify_note = ?, updated_at = ? where id = ?')
      .run(approved ? nowIso() : null, approved ? req.user.id : null,
           str(req.body.note, { field: 'комментарий', max: 600, required: false }), nowIso(), id);
    res.json({ ok: true });
  }));

  return router;
};
