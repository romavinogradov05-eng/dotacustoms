/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — руководство для новичков
   ──────────────────────────────────────────────────────────────────────
   Гайды лежат в таблице `guides` (наполняются из data/seed/guides/*.md).
   Официальные гайды может править Coach и админ, свои — любой игрок.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { LIMITS, ROLES } = require('../config');
const {
  str, bool, bad, notFound, forbidden, nowIso, slugify, timeAgo,
} = require('../util');
const { requireAuth } = require('../auth');
const { wrap } = require('../http');

function guidePayload(db, g, viewer, full = false) {
  const out = {
    id: g.id,
    slug: g.slug,
    title: g.title,
    category: g.category,
    summary: g.summary,
    order_index: g.order_index,
    is_official: !!g.is_official,
    published: !!g.published,
    updated_at: g.updated_at,
    ago: timeAgo(g.updated_at),
    can_edit: !!viewer && (g.is_official ? (viewer.role === ROLES.ADMIN || viewer.role === ROLES.COACH) : viewer.id === g.author_id || viewer.role === ROLES.ADMIN),
  };
  if (full) {
    out.body = g.body;
    out.author = g.author_id ? {
      id: g.author_id, nickname: g.author_nickname, username: g.author_username, role: g.author_role,
    } : null;
  }
  return out;
}

const SELECT_GUIDE = `
  select g.*, u.nickname as author_nickname, u.username as author_username, u.role as author_role
    from guides g left join users u on u.id = g.author_id
`;

module.exports = function guideRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  // ── список ───────────────────────────────────────────────────────────
  router.get('/', wrap((_req, res) => {
    const rows = db.prepare(`${SELECT_GUIDE} where published = 1 order by order_index asc, id asc`).all();
    res.json({ items: rows.map(g => guidePayload(db, g, null, false)) });
  }));

  // ── страница гайда ───────────────────────────────────────────────────
  router.get('/:slug', wrap((req, res) => {
    const g = db.prepare(`${SELECT_GUIDE} where slug = ? and published = 1`).get(req.params.slug);
    if (!g) throw notFound('Гайд не найден');
    res.json({ guide: guidePayload(db, g, req.user, true) });
  }));

  // ── создать свой гайд ────────────────────────────────────────────────
  router.post('/', requireAuth, wrap((req, res) => {
    const title = str(req.body.title, { field: 'название', max: LIMITS.titleMax });
    const body = str(req.body.body, { field: 'текст гайда', min: 20, max: LIMITS.bodyMax });
    let slug = slugify(req.body.slug || title);
    // уникальность slug
    if (db.prepare('select 1 from guides where slug = ?').get(slug)) {
      slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    }
    const now = nowIso();
    const info = db.prepare(`
      insert into guides (slug, title, category, summary, body, order_index,
                          is_official, published, author_id, created_at, updated_at)
      values (?,?,?,?,?,?,0,?,?,?,?)
    `).run(
      slug, title,
      str(req.body.category, { field: 'категория', max: 40, required: false }) || 'basics',
      str(req.body.summary, { field: 'краткое описание', max: 300, required: false }),
      body,
      900,
      bool(req.body.published, true) ? 1 : 0,
      req.user.id, now, now,
    );
    res.status(201).json({ id: Number(info.lastInsertRowid), slug });
  }));

  // ── изменить ─────────────────────────────────────────────────────────
  router.patch('/:slug', requireAuth, wrap((req, res) => {
    const g = db.prepare('select * from guides where slug = ?').get(req.params.slug);
    if (!g) throw notFound('Гайд не найден');
    const mayEdit = g.is_official
      ? (req.user.role === ROLES.ADMIN || req.user.role === ROLES.COACH)
      : (g.author_id === req.user.id || req.user.role === ROLES.ADMIN);
    if (!mayEdit) throw forbidden('Этот гайд правит Coach или автор');

    const set = {};
    if (req.body.title !== undefined) set.title = str(req.body.title, { field: 'название', max: LIMITS.titleMax });
    if (req.body.summary !== undefined) set.summary = str(req.body.summary, { field: 'описание', max: 300, required: false });
    if (req.body.body !== undefined) set.body = str(req.body.body, { field: 'текст гайда', min: 20, max: LIMITS.bodyMax });
    if (req.body.category !== undefined) set.category = str(req.body.category, { field: 'категория', max: 40, required: false });
    if (req.body.order_index !== undefined) set.order_index = Number(req.body.order_index) || 0;
    if (req.body.published !== undefined) set.published = bool(req.body.published) ? 1 : 0;
    if (!Object.keys(set).length) throw bad('Нечего сохранять');
    set.updated_at = nowIso();
    const cols = Object.keys(set).map(k => `${k} = ?`).join(', ');
    db.prepare(`update guides set ${cols} where slug = ?`).run(...Object.values(set), g.slug);
    res.json({ ok: true });
  }));

  // ── удалить (свой гайд — автор, официальный — админ) ─────────────────
  router.delete('/:slug', requireAuth, wrap((req, res) => {
    const g = db.prepare('select * from guides where slug = ?').get(req.params.slug);
    if (!g) throw notFound('Гайд не найден');
    if (g.is_official) {
      if (req.user.role !== ROLES.ADMIN) throw forbidden('Официальный гайд удаляет только администратор');
    } else if (g.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) {
      throw forbidden('Нельзя удалить чужой гайд');
    }
    db.prepare('delete from guides where id = ?').run(g.id);
    res.json({ ok: true });
  }));

  return router;
};
