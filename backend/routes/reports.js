/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — уведомления, заявления в свободной форме, почта
   ──────────────────────────────────────────────────────────────────────
   Пользователь писал жалобу как в dotable, но с разделением на страницы,
   и отдельно — заявление в свободной форме: человек пишет тему и текст
   сам, без привязки к билду или ветке. Заявление уходит администратору,
   админ её принимает или отклоняет, и на почту заявителя приходит
   письмо с решением.

   Форма жалобы на конкретный объект (build / top / thread) осталась в
   users.js → POST /users/flags. Здесь — то, что без объекта.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { ROLES } = require('../config');
const { str, oneOf, bool, bad, notFound, nowIso, timeAgo, paging } = require('../util');
const { requireAuth, requireAdmin } = require('../auth');
const { wrap } = require('../http');
const {
  listNotifications, unreadCount, markRead, markAllRead, notify, notifyAdmins,
} = require('../notify');
const mailer = require('../mailer');

const REPORT_KINDS = [
  { key: 'appeal', title: 'Апелляция', hint: 'Не согласен с решением модератора' },
  { key: 'complaint', title: 'Жалоба', hint: 'Поведение игрока или наполнение сайта' },
  { key: 'other', title: 'Другое', hint: 'Любой другой вопрос или предложение' },
];
const REPORT_KIND_KEYS = REPORT_KINDS.map(k => k.key);

const STATUS_RU = {
  open: { title: 'На рассмотрении', color: 'yellow' },
  accepted: { title: 'Принята', color: 'green' },
  rejected: { title: 'Отклонена', color: 'red' },
};

/** Ограничение длины текста заявления. */
const BODY_MAX = 8000;

function reportPayload(db, r, viewer) {
  const author = db.prepare(
    'select id, username, nickname, avatar, role from users where id = ?',
  ).get(r.author_id);
  const isAdmin = !!viewer && viewer.role === ROLES.ADMIN;
  return {
    id: r.id,
    subject: r.subject,
    body: r.body,
    kind: r.kind,
    status: r.status,
    admin_note: isAdmin || r.author_id === viewer?.id ? r.admin_note : '',
    is_anonymous: !!r.is_anonymous,
    created_at: r.created_at,
    ago: timeAgo(r.created_at),
    resolved_at: r.resolved_at,
    emailed_at: r.emailed_at,
    // Ник автора администратору виден всегда — по нему он и принимает
    // решение. Остальным пользователям nick не отдаётся вовсе.
    author: author ? {
      id: author.id,
      username: author.username,
      nickname: r.is_anonymous && !isAdmin && r.author_id !== viewer?.id
        ? 'Аноним'
        : author.nickname,
      avatar: r.is_anonymous && !isAdmin && r.author_id !== viewer?.id ? '' : author.avatar,
      role: author.role,
    } : null,
  };
}

module.exports = function reportRoutes(ctx) {
  const { db } = ctx;
  const router = express.Router();

  /* ══ уведомления (ячейка-колокольчик) ═════════════════════════════ */

  router.get('/notifications', requireAuth, wrap((req, res) => {
    const limit = Math.min(50, Number(req.query.limit) || 20);
    res.json({
      items: listNotifications(db, req.user.id, { limit, onlyUnread: bool(req.query.unread) }),
      unread: unreadCount(db, req.user.id),
    });
  }));

  // Счётчик для шапки — дешёвый запрос, дёргается при загрузке и по таймеру.
  router.get('/notifications/unread', requireAuth, wrap((req, res) => {
    res.json({ unread: unreadCount(db, req.user.id) });
  }));

  router.post('/notifications/:id/read', requireAuth, wrap((req, res) => {
    markRead(db, req.user.id, Number(req.params.id));
    res.json({ ok: true, unread: unreadCount(db, req.user.id) });
  }));

  router.post('/notifications/read-all', requireAuth, wrap((_req, res) => {
    markAllRead(db, req.user.id);
    res.json({ ok: true, unread: 0 });
  }));

  /* ══ мои заявления ════════════════════════════════════════════════ */

  router.get('/reports/mine', requireAuth, wrap((req, res) => {
    const rows = db.prepare(`
      select * from reports where author_id = ? order by created_at desc, id desc limit 50
    `).all(req.user.id);
    res.json({
      items: rows.map(r => ({ ...reportPayload(db, r, req.user), body: r.body })),
      kinds: REPORT_KINDS,
      statuses: STATUS_RU,
    });
  }));

  // Свободная форма: тема + текст. Объекта жалобы нет.
  router.post('/reports', requireAuth, wrap((req, res) => {
    const subject = str(req.body.subject, { field: 'тема', max: 140 });
    const body = str(req.body.body, { field: 'текст', max: BODY_MAX });
    const kind = oneOf(req.body.kind, REPORT_KIND_KEYS, { field: 'тип', def: 'appeal' });
    const anonymous = bool(req.body.is_anonymous) ? 1 : 0;

    const info = db.prepare(`
      insert into reports (author_id, subject, body, kind, is_anonymous, created_at)
      values (?,?,?,?,?,?)
    `).run(req.user.id, subject, body, kind, anonymous, nowIso());
    const id = Number(info.lastInsertRowid);

    const kindTitle = (REPORT_KINDS.find(k => k.key === kind) || {}).title || 'Заявление';
    notifyAdmins(db, {
      kind: 'report',
      title: `${kindTitle}: ${subject}`,
      body: `От ${req.user.nickname} (@${req.user.username})`,
      link: '/admin?tab=reports',
      actorId: req.user.id,
    });

    res.status(201).json({ id, status: 'open' });
  }));

  /* ══ разбор администратором ═══════════════════════════════════════ */

  // Разделение на страницы — как в dotable: по 20 заявок, стрелки внизу.
  router.get('/reports', requireAdmin, wrap((req, res) => {
    const { page, size, offset } = paging(req.query, { defaultSize: 20, maxSize: 50 });
    const where = ['1=1'];
    const params = [];

    if (oneOf(req.query.status, ['open', 'accepted', 'rejected', 'all'], { required: false })) {
      if (req.query.status !== 'all') { where.push('status = ?'); params.push(req.query.status); }
    }
    if (oneOf(req.query.kind, REPORT_KIND_KEYS, { required: false })) {
      where.push('kind = ?'); params.push(req.query.kind);
    }
    if (req.query.q) {
      const like = `%${String(req.query.q).slice(0, 60)}%`;
      where.push('(subject like ? or body like ?)');
      params.push(like, like);
    }

    const rows = db.prepare(`
      select * from reports where ${where.join(' and ')}
       order by (status = 'open') desc, created_at desc, id desc
       limit ? offset ?
    `).all(...params, size, offset);

    const total = db.prepare(`select count(*) as c from reports where ${where.join(' and ')}`)
      .get(...params).c;
    const open = db.prepare(`select count(*) as c from reports where status = 'open'`).get().c;

    res.json({
      items: rows.map(r => reportPayload(db, r, req.user)),
      total, open, page, per_page: size,
      pages: Math.max(1, Math.ceil(total / size)),
      kinds: REPORT_KINDS,
      statuses: STATUS_RU,
      mail: { configured: mailer.isConfigured(mailer.readConfig(db)) },
    });
  }));

  router.get('/reports/:id', requireAdmin, wrap((req, res) => {
    const r = db.prepare('select * from reports where id = ?').get(Number(req.params.id));
    if (!r) throw notFound('Заявка не найдена');
    res.json({ report: reportPayload(db, r, req.user) });
  }));

  // Админ подтверждает, что заявку приняли или отклонили. После этого
  // заявителю уходит письмо на почту из профиля.
  router.post('/reports/:id/resolve', requireAdmin, wrap((req, res) => {
    const r = db.prepare('select * from reports where id = ?').get(Number(req.params.id));
    if (!r) throw notFound('Заявка не найдена');

    const decision = oneOf(req.body.decision, ['accept', 'reject'], { field: 'решение' });
    const note = str(req.body.note, { field: 'комментарий', max: 1000, required: false });
    const status = decision === 'accept' ? 'accepted' : 'rejected';

    db.prepare('update reports set status = ?, admin_note = ?, resolved_by = ?, resolved_at = ? where id = ?')
      .run(status, note, req.user.id, nowIso(), r.id);

    const verb = decision === 'accept' ? 'принята' : 'отклонена';
    notify(db, r.author_id, {
      kind: 'report',
      title: `Заявка «${r.subject}» ${verb}`,
      body: note || (decision === 'accept'
        ? 'Администратор принял вашу заявку.'
        : 'Администратор отклонил вашу заявку.'),
      link: '/reports',
      actorId: req.user.id,
    });

    // Письмо уходит из очереди: недоступный SMTP не должен мешать решению.
    const queued = mailer.queueForUser(db, r.author_id, {
      subject: `DotaCustoms: заявка «${r.subject}» ${verb}`,
      body: [
        'Здравствуйте!',
        '',
        `Ваша заявка «${r.subject}» ${verb} администратором${note ? ` (${req.user.nickname})` : ''}.`,
        '',
        note ? `Комментарий администратора:\n${note}\n` : '',
        decision === 'accept'
          ? 'Спасибо, мы разобрались.'
          : 'Если считаете решение неверным — напишите ещё раз, приложив подробности.',
      ].join('\n'),
    });
    if (queued) {
      db.prepare('update reports set emailed_at = ? where id = ?').run(nowIso(), r.id);
    }
    mailer.flushSoon(db);

    res.json({ ok: true, status, emailed: !!queued });
  }));

  /* ══ почта: настройка и очередь ═══════════════════════════════════ */

  router.get('/mail', requireAdmin, wrap((_req, res) => {
    const cfg = mailer.readConfig(db);
    res.json({
      // пароль наружу не отдаём — только признак, что он задан
      settings: { ...cfg, pass: cfg.pass ? '••••••••' : '' },
      configured: mailer.isConfigured(cfg),
      pending: mailer.countPending(db),
    });
  }));

  router.post('/mail', requireAdmin, wrap((req, res) => {
    const b = req.body || {};
    const set = (key, value) => require('../db').setSetting(db, key, value);
    set(mailer.KEYS.host, str(b.host, { max: 120, required: false }));
    set(mailer.KEYS.port, b.port ? String(Number(b.port)) : '');
    set(mailer.KEYS.secure, bool(b.secure) ? '1' : '0');
    set(mailer.KEYS.user, str(b.user, { max: 120, required: false }));
    // Пустой пароль означает «оставь прежний» — иначе нельзя было бы
    // сохранить настройки, не показывая пароль в форме.
    if (b.pass !== undefined && b.pass && !/^•+$/.test(String(b.pass))) {
      set(mailer.KEYS.pass, String(b.pass));
    }
    set(mailer.KEYS.from, str(b.from, { max: 120, required: false }));
    set(mailer.KEYS.fromName, str(b.fromName, { max: 60, required: false }));

    const cfg = mailer.readConfig(db);
    res.json({ settings: { ...cfg, pass: cfg.pass ? '••••••••' : '' }, configured: mailer.isConfigured(cfg) });
  }));

  // Проверка отправки: письмо самому себе. Если SMTP настроен неверно,
   // пользователь узнает об этом сразу, а не после жалобы гостя.
  router.post('/mail/test', requireAdmin, wrap(async (req, res) => {
    const cfg = mailer.readConfig(db);
    if (!mailer.isConfigured(cfg)) throw bad('Почта не настроена: укажи сервер и адрес отправителя');
    const to = str(req.body.to, { field: 'адрес', max: 120, required: false }) || req.user.email;
    if (!to) throw bad('Укажи адрес для проверки');
    const err = await mailer.sendOne(cfg, {
      to,
      subject: 'DotaCustoms: проверка почты',
      body: `Письмо отправлено ${new Date().toLocaleString('ru-RU')}.\nЕсли вы его видите — почта настроена верно.`,
    });
    if (err) throw bad(`Не отправилось: ${err}`);
    res.json({ ok: true, sent_to: to });
  }));

  router.get('/mail/queue', requireAdmin, wrap((_req, res) => {
    const rows = db.prepare('select * from email_queue order by created_at desc, id desc limit 100').all();
    res.json({
      items: rows.map(r => ({
        id: r.id, to: r.to_addr, subject: r.subject, status: r.status,
        attempts: r.attempts, last_error: r.last_error, created_at: r.created_at, sent_at: r.sent_at,
      })),
      pending: mailer.countPending(db),
    });
  }));

  router.post('/mail/flush', requireAdmin, wrap(async (_req, res) => {
    const cfg = mailer.readConfig(db);
    if (!mailer.isConfigured(cfg)) throw bad('Почта не настроена');
    res.json(await mailer.flush(db, { limit: 50 }));
  }));

  return router;
};
