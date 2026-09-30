/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — билды: сборки предметов, скиллов, талантов, нейтралок
   ──────────────────────────────────────────────────────────────────────
   Создание / чтение / правка / удаление, голоса, комментарии.
   Черновики (is_draft = 1) видны только автору и staff.
   Подтверждение билда — Coach или администратор.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { MODE_KEYS, BUILD_STAGE_KEYS, LIMITS, ROLES } = require('../config');
const {
  str, int, oneOf, bool, bad, notFound, forbidden, nowIso, paging, timeAgo,
  cleanItems, cleanNeutrals, cleanSkills, cleanTalents,
} = require('../util');
const { requireAuth, isCoachFor } = require('../auth');
const { wrap } = require('../http');
const { MODERATION, MODERATION_KEYS, moderationFor, notifyAdmins } = require('../notify');

/** Собирает публичное представление билда. */
function buildPayload(db, b, viewer) {
  const vote = viewer
    ? db.prepare('select value from build_votes where build_id = ? and user_id = ?').get(b.id, viewer.id)
    : null;
  const likes = db.prepare('select count(*) as c from build_votes where build_id = ? and value > 0').get(b.id).c;
  return {
    id: b.id,
    mode: b.mode,
    hero_id: b.hero_id,
    title: b.title,
    description: b.description,
    stage: b.stage,
    patch: b.patch,
    difficulty: b.difficulty,
    is_draft: !!b.is_draft,
    moderation: b.moderation || MODERATION.APPROVED,
    items: JSON.parse(b.items || '[]'),
    skills: JSON.parse(b.skills || '[]'),
    talents: JSON.parse(b.talents || '[]'),
    neutrals: JSON.parse(b.neutrals || '[]'),
    views: b.views,
    created_at: b.created_at,
    updated_at: b.updated_at,
    updated_ago: timeAgo(b.updated_at),
    verified: !!b.verified_at,
    verified_at: b.verified_at,
    verify_note: b.verify_note,
    verified_by: b.verified_by_name ? {
      nickname: b.verified_by_name, username: b.verified_by_username, role: b.verified_by_role,
    } : null,
    author: {
      id: b.author_id, nickname: b.author_nickname, username: b.author_username,
      avatar: b.author_avatar, role: b.author_role,
    },
    likes,
    my_vote: vote ? vote.value : 0,
    can_edit: !!viewer && (viewer.id === b.author_id || viewer.role === ROLES.ADMIN),
    can_verify: !!viewer && (isCoachFor(db, viewer, b.mode) || viewer.role === ROLES.ADMIN),
    can_delete: !!viewer && (viewer.id === b.author_id || viewer.role === ROLES.ADMIN),
  };
}

module.exports = function buildRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();
  // лимиты с поправкой на датасет (число уровней талантов зависит от патча)
  const C = ctx.limits || LIMITS;

  /**
   * Таланты: столько, сколько уровней выбора в патче.
   * cleanTalents лишние молча обрезает, а таланты игрок выбирал руками —
   * поэтому лимит проверяем сами и отвечаем внятной ошибкой.
   */
  function talentsOrThrow(list) {
    const arr = Array.isArray(list) ? list : [];
    const ids = new Set(
      arr.map(x => Number(typeof x === 'object' && x ? (x.ability_id ?? x.id) : x))
        .filter(n => Number.isInteger(n) && n > 0),
    );
    if (ids.size > C.maxTalents) {
      throw bad(`Выбрано талантов: ${ids.size}, а уровней выбора в этом патче: ${C.maxTalents}`);
    }
    return cleanTalents(arr, { max: C.maxTalents });
  }

  /**
   * Что кому видно.
   * Черновик и неподтверждённый билд — только автору и администратору.
   * Coach-у, который ведёт этот режим, тоже: он и будет подтверждать.
   */
  const visible = (b, viewer) => {
    const draft = !!b.is_draft;
    const pending = (b.moderation || MODERATION.APPROVED) === MODERATION.PENDING;
    if (!draft && !pending) return true;
    if (!viewer) return false;
    if (viewer.id === b.author_id || viewer.role === ROLES.ADMIN) return true;
    return isCoachFor(db, viewer, b.mode);
  };

  // ── список ───────────────────────────────────────────────────────────
  router.get('/', wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 20, maxSize: 60 });
    const where = ['1=1'];
    const params = [];

    const mode = oneOf(req.query.mode, MODE_KEYS, { field: 'режим', required: false });
    if (mode) { where.push('b.mode = ?'); params.push(mode); }

    const heroId = req.query.hero_id ? Number(req.query.hero_id) : null;
    if (heroId) { where.push('b.hero_id = ?'); params.push(heroId); }

    if (req.query.author_id) { where.push('b.author_id = ?'); params.push(Number(req.query.author_id)); }
    if (req.query.author) {
      where.push('b.author_id = (select id from users where username = ?)');
      params.push(String(req.query.author).toLowerCase());
    }
    if (oneOf(req.query.stage, BUILD_STAGE_KEYS, { field: 'стадия', required: false })) {
      where.push('b.stage = ?'); params.push(req.query.stage);
    }
    if (oneOf(req.query.verified, ['0', '1'], { field: 'verified', required: false })) {
      where.push(bool(req.query.verified) ? 'b.verified_at is not null' : 'b.verified_at is null');
    }
    // черновики: по умолчанию видны только опубликованные, но автор и
    // администратор видят и свои. Гость видит только опубликованные.
    if (bool(req.query.drafts, true)) {
      const seesAll = req.user && req.user.role === ROLES.ADMIN;
      if (req.user && !seesAll) {
        where.push('(b.is_draft = 0 or b.author_id = ?)');
        params.push(req.user.id);
      } else if (!req.user) {
        where.push('b.is_draft = 0');
      }
    } else {
      where.push('b.is_draft = 0');
    }

    // Неподтверждённое видно только автору, админу и Coach этого режима.
    const seesAllPending = !!req.user && (req.user.role === ROLES.ADMIN
      || isCoachFor(db, req.user, mode || MODE_KEYS[0]));
    if (req.query.moderation) {
      const m = oneOf(req.query.moderation, MODERATION_KEYS, { field: 'статус', required: false });
      if (m) { where.push('b.moderation = ?'); params.push(m); }
    } else if (seesAllPending) {
      // админу и Coach показываем всё без фильтра
    } else if (req.user) {
      // автор видит и своё неподтверждённое — иначе нельзя понять,
      // отправлено ли на проверку, и нельзя бы исправить
      where.push(`(b.moderation = '${MODERATION.APPROVED}' or b.author_id = ?)`);
      params.push(req.user.id);
    } else {
      where.push(`b.moderation = '${MODERATION.APPROVED}'`);
    }

    if (req.query.q) {
      where.push('(b.title like ? or b.description like ?)');
      const like = `%${String(req.query.q).slice(0, 60)}%`;
      params.push(like, like);
    }

    const sortMap = {
      new: 'b.created_at desc',
      hot: 'like_count desc, b.created_at desc',
      verified: 'b.verified_at is null, b.verified_at desc, b.created_at desc',
      discussed: 'comment_count desc, b.created_at desc',
    };
    const order = sortMap[String(req.query.sort || 'new')] || sortMap.new;

    // счётчики (лайки, комментарии) считаем подзапросами в самом SELECT
    const rows = db.prepare(`
      select b.*,
             au.nickname as author_nickname, au.username as author_username,
             au.avatar as author_avatar, au.role as author_role,
             vu.nickname as verified_by_name, vu.username as verified_by_username,
             vu.role as verified_by_role,
             (select count(*) from build_votes bv where bv.build_id = b.id and bv.value > 0) as like_count,
             (select count(*) from build_comments bc where bc.build_id = b.id and bc.is_deleted = 0) as comment_count
        from builds b
        join users au on au.id = b.author_id
        left join users vu on vu.id = b.verified_by
       where ${where.join(' and ')}
       order by ${order}
       limit ? offset ?
    `).all(...params, size, offset);

    const total = db.prepare(`select count(*) as c from builds b where ${where.join(' and ')}`)
      .get(...params).c;

    res.json({
      items: rows.map(r => buildPayload(db, r, req.user)),
      total, page, per_page: size, pages: Math.max(1, Math.ceil(total / size)),
    });
  }));

  // ── один билд ────────────────────────────────────────────────────────
  router.get('/:id', wrap((req, res) => {
    const b = db.prepare(`
      select b.*,
             au.nickname as author_nickname, au.username as author_username,
             au.avatar as author_avatar, au.role as author_role,
             vu.nickname as verified_by_name, vu.username as verified_by_username,
             vu.role as verified_by_role
        from builds b
        join users au on au.id = b.author_id
        left join users vu on vu.id = b.verified_by
       where b.id = ?
    `).get(Number(req.params.id));
    if (!b) throw notFound('Билд не найден');
    if (!visible(b, req.user)) throw notFound('Билд не найден');

    // счётчик сначала увеличиваем, иначе в ответе вернётся старое значение
    db.prepare('update builds set views = views + 1 where id = ?').run(b.id);
    b.views = Number(b.views || 0) + 1;

    const comments = db.prepare(`
      select c.*, u.nickname, u.username, u.avatar, u.role
        from build_comments c join users u on u.id = c.author_id
       where c.build_id = ? and c.is_deleted = 0
       order by c.created_at asc
    `).all(b.id).map(c => ({
      id: c.id, body: c.body, created_at: c.created_at, ago: timeAgo(c.created_at),
      edited_at: c.edited_at, can_delete: !!req.user && (req.user.id === c.author_id || req.user.role === ROLES.ADMIN),
      author: { id: c.author_id, nickname: c.nickname, username: c.username, avatar: c.avatar, role: c.role },
    }));

    res.json({ build: buildPayload(db, b, req.user), comments });
  }));

  // ── создать ──────────────────────────────────────────────────────────
  router.post('/', requireAuth, wrap((req, res) => {
    const mode = oneOf(req.body.mode, MODE_KEYS, { field: 'режим' });
    const title = str(req.body.title, { field: 'название', max: C.titleMax });
    const heroId = req.body.hero_id ? int(req.body.hero_id, { field: 'герой', min: 1, max: 1000, required: false }) : null;
    const isDraft = bool(req.body.is_draft, false) ? 1 : 0;
    // Coach и админ публикуют сразу, обычному игроку — после подтверждения.
    const moderation = moderationFor(req.user, isDraft);

    const info = db.prepare(`
      insert into builds (author_id, mode, hero_id, title, description, stage, patch,
                          difficulty, is_draft, items, skills, talents, neutrals,
                          moderation, created_at, updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id, mode, heroId, title,
      str(req.body.description, { field: 'описание', max: LIMITS.descriptionMax, required: false }),
      oneOf(req.body.stage, BUILD_STAGE_KEYS, { field: 'стадия', def: 'any' }),
      str(req.body.patch, { field: 'патч', max: 12, required: false }),
      int(req.body.difficulty, { field: 'сложность', min: 1, max: 5, required: false, def: 1 }),
      isDraft,
      JSON.stringify(cleanItems(req.body.items, { max: C.maxItems })),
      JSON.stringify(cleanSkills(req.body.skills, { max: C.maxSkills })),
      JSON.stringify(talentsOrThrow(req.body.talents)),
      JSON.stringify(cleanNeutrals(req.body.neutrals, { max: C.maxNeutrals })),
      moderation, nowIso(), nowIso(),
    );
    const id = Number(info.lastInsertRowid);

    if (moderation === MODERATION.PENDING && !isDraft) {
      notifyAdmins(db, {
        kind: 'moderation',
        title: `Новый билд ждёт подтверждения: «${title}»`,
        body: `${req.user.nickname} (${mode}) прислал билд на проверку.`,
        link: '/admin?tab=queue',
        actorId: req.user.id,
      });
    }

    res.status(201).json({ id, moderation, pending: moderation === MODERATION.PENDING });
  }));

  // ── изменить ─────────────────────────────────────────────────────────
  router.patch('/:id', requireAuth, wrap((req, res) => {
    const b = db.prepare('select * from builds where id = ?').get(Number(req.params.id));
    if (!b) throw notFound('Билд не найден');
    if (b.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) {
      throw forbidden('Редактировать может только автор');
    }
    const set = {};
    if (req.body.title !== undefined) set.title = str(req.body.title, { field: 'название', max: C.titleMax });
    if (req.body.description !== undefined) set.description = str(req.body.description, { field: 'описание', max: LIMITS.descriptionMax, required: false });
    if (req.body.stage !== undefined) set.stage = oneOf(req.body.stage, BUILD_STAGE_KEYS, { field: 'стадия' });
    if (req.body.patch !== undefined) set.patch = str(req.body.patch, { field: 'патч', max: 12, required: false });
    if (req.body.difficulty !== undefined) set.difficulty = int(req.body.difficulty, { field: 'сложность', min: 1, max: 5 });
    if (req.body.hero_id !== undefined) set.hero_id = req.body.hero_id ? int(req.body.hero_id, { field: 'герой', min: 1, max: 1000 }) : null;
    if (req.body.is_draft !== undefined) set.is_draft = bool(req.body.is_draft) ? 1 : 0;
    if (req.body.items !== undefined) set.items = JSON.stringify(cleanItems(req.body.items, { max: C.maxItems }));
    if (req.body.skills !== undefined) set.skills = JSON.stringify(cleanSkills(req.body.skills, { max: C.maxSkills }));
    if (req.body.talents !== undefined) set.talents = JSON.stringify(talentsOrThrow(req.body.talents));
    if (req.body.neutrals !== undefined) set.neutrals = JSON.stringify(cleanNeutrals(req.body.neutrals, { max: C.maxNeutrals }));
    if (req.body.mode !== undefined) set.mode = oneOf(req.body.mode, MODE_KEYS, { field: 'режим' });

    if (!Object.keys(set).length) throw bad('Нечего сохранять');
    set.updated_at = nowIso();
    const cols = Object.keys(set).map(k => `${k} = ?`).join(', ');
    db.prepare(`update builds set ${cols} where id = ?`).run(...Object.values(set), b.id);

    // снять подтверждение, если поменяли содержимое
    if (set.items || set.talents || set.skills || set.neutrals) {
      db.prepare('update builds set verified_at = null, verified_by = null, verify_note = ? where id = ?')
        .run('Содержимое изменено — нужно новое подтверждение', b.id);
    }
    res.json({ ok: true });
  }));

  // ── удалить ──────────────────────────────────────────────────────────
  router.delete('/:id', requireAuth, wrap((req, res) => {
    const b = db.prepare('select * from builds where id = ?').get(Number(req.params.id));
    if (!b) throw notFound('Билд не найден');
    const isOwner = b.author_id === req.user.id;
    if (!isOwner && req.user.role !== ROLES.ADMIN) throw forbidden('Удалить может автор или администратор');
    db.prepare('delete from builds where id = ?').run(b.id);
    res.json({ ok: true });
  }));

  // ── голос ────────────────────────────────────────────────────────────
  router.post('/:id/vote', requireAuth, wrap((req, res) => {
    const id = Number(req.params.id);
    const b = db.prepare('select * from builds where id = ?').get(id);
    if (!b) throw notFound('Билд не найден');
    const value = oneOf(String(req.body.value ?? 1), ['1', '-1', '0'], { field: 'голос' });
    if (Number(value) === 0) {
      db.prepare('delete from build_votes where build_id = ? and user_id = ?').run(id, req.user.id);
    } else {
      // без upsert: удаляем старую строку голоса и пишем заново
      db.prepare('delete from build_votes where build_id = ? and user_id = ?').run(id, req.user.id);
      db.prepare('insert into build_votes (build_id, user_id, value, created_at) values (?,?,?,?)')
        .run(id, req.user.id, Number(value), nowIso());
    }
    res.json({ ok: true });
  }));

  // ── подтверждение Coach ──────────────────────────────────────────────
  router.post('/:id/verify', requireAuth, wrap((req, res) => {
    const id = Number(req.params.id);
    const b = db.prepare('select * from builds where id = ?').get(id);
    if (!b) throw notFound('Билд не найден');
    if (!isCoachFor(db, req.user, b.mode) && req.user.role !== ROLES.ADMIN) {
      throw forbidden('Подтверждать билды может Coach этого режима или администратор');
    }
    const approved = bool(req.body.approved, true);
    const note = str(req.body.note, { field: 'комментарий', max: 600, required: false });
    db.prepare(`
      update builds set verified_at = ?, verified_by = ?, verify_note = ?, updated_at = ? where id = ?
    `).run(approved ? nowIso() : null, approved ? req.user.id : null, note, nowIso(), id);
    res.json({ ok: true });
  }));

  // ── комментарии ──────────────────────────────────────────────────────
  router.post('/:id/comments', requireAuth, wrap((req, res) => {
    const id = Number(req.params.id);
    const b = db.prepare('select id from builds where id = ?').get(id);
    if (!b) throw notFound('Билд не найден');
    const body = str(req.body.body, { field: 'комментарий', max: LIMITS.bodyMax });
    const info = db.prepare(
      'insert into build_comments (build_id, author_id, body, created_at) values (?,?,?,?)'
    ).run(id, req.user.id, body, nowIso());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  }));

  router.delete('/:buildId/comments/:commentId', requireAuth, wrap((req, res) => {
    const cid = Number(req.params.commentId);
    const c = db.prepare('select * from build_comments where id = ? and build_id = ?')
      .get(cid, Number(req.params.buildId));
    if (!c) throw notFound('Комментарий не найден');
    if (c.author_id !== req.user.id && req.user.role !== ROLES.ADMIN) throw forbidden('Нельзя удалить чужой комментарий');
    db.prepare('update build_comments set is_deleted = 1 where id = ?').run(cid);
    res.json({ ok: true });
  }));

  return router;
};

module.exports.buildPayload = buildPayload;
