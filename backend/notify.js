/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — уведомления и модерация
   ──────────────────────────────────────────────────────────────────────
   Правило, о котором просил пользователь:
     • билд/топ от Coach или администратора публикуется сразу;
     • билд/топ от обычного игрока уходит администратору на подтверждение
       и лежит в очереди, пока её не рассмотрели;
     • решение администратора приходит в уведомления (ячейка-колокольчик
       в шапке) и, если у игрока указана почта, на эту почту.

   Модуль не зависит от роутов: и builds, и tops, и reports зовут одни
   и те же функции, поэтому правило нельзя случайно нарушить в одном
   из разделов.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { ROLES } = require('./config');
const { nowIso } = require('./util');

/** Статусы модерации. `approved` — видно всем сразу. */
const MODERATION = { PENDING: 'pending', APPROVED: 'approved', REJECTED: 'rejected' };
const MODERATION_KEYS = Object.values(MODERATION);

/**
 * Нужно ли подтверждение администратора.
 * Coach и администратор публикуют сами — их слово и есть подтверждение.
 */
function needsApproval(user) {
  if (!user) return false;
  if (user.role === ROLES.ADMIN) return false;
  if (user.role === ROLES.COACH) return false;
  return true;
}

/** Черновик всегда остаётся черновиком, независимо от роли. */
function moderationFor(user, isDraft) {
  if (isDraft) return MODERATION.PENDING;
  return needsApproval(user) ? MODERATION.PENDING : MODERATION.APPROVED;
}

/* ── уведомления ──────────────────────────────────────────────────────── */

function notify(db, userId, { kind = 'info', title, body = '', link = '', actorId = null }) {
  if (!userId || !title) return null;
  const info = db.prepare(`
    insert into notifications (user_id, kind, title, body, link, actor_id, created_at)
    values (?,?,?,?,?,?,?)
  `).run(userId, kind, title, body, link, actorId, nowIso());
  return Number(info.lastInsertRowid);
}

function notifyAdmins(db, payload, { except = null } = {}) {
  const rows = db.prepare('select id from users where role = ? and is_banned = 0')
    .all(ROLES.ADMIN);
  let sent = 0;
  for (const r of rows) {
    if (except && r.id === except) continue;
    notify(db, r.id, payload);
    sent++;
  }
  return sent;
}

function unreadCount(db, userId) {
  return db.prepare('select count(*) as c from notifications where user_id = ? and is_read = 0')
    .get(userId).c;
}

function listNotifications(db, userId, { limit = 30, onlyUnread = false } = {}) {
  const rows = onlyUnread
    ? db.prepare(`
        select n.*, u.nickname as actor_nickname
          from notifications n left join users u on u.id = n.actor_id
         where n.user_id = ? and n.is_read = 0
         order by n.created_at desc, n.id desc limit ?
      `).all(userId, limit)
    : db.prepare(`
        select n.*, u.nickname as actor_nickname
          from notifications n left join users u on u.id = n.actor_id
         where n.user_id = ?
         order by n.created_at desc, n.id desc limit ?
      `).all(userId, limit);

  return rows.map(n => ({
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    is_read: !!n.is_read,
    created_at: n.created_at,
    actor: n.actor_nickname ? { nickname: n.actor_nickname } : null,
  }));
}

const markRead = (db, userId, id) =>
  db.prepare('update notifications set is_read = 1 where user_id = ? and id = ?').run(userId, id);

const markAllRead = (db, userId) =>
  db.prepare('update notifications set is_read = 1 where user_id = ? and is_read = 0').run(userId);

/* ── содержимое, ждущее подтверждения ─────────────────────────────────── */

const CONTENT_TABLES = { build: 'builds', top: 'meta_tops' };

/** Заголовок объекта очереди — для уведомления и письма. */
function contentTitle(db, type, id) {
  const table = CONTENT_TABLES[type];
  if (!table) return `#${id}`;
  const row = db.prepare(`select title from ${table} where id = ?`).get(Number(id));
  return row ? row.title : `#${id}`;
}

/**
 * Решение по объекту очереди.
 * approved → объект виден всем; rejected → остаётся только у автора.
 * Автору всегда приходит уведомление, и письмо, если указана почта.
 */
function resolveContent(db, { type, id, decision, admin, note = '', mailer = null }) {
  const table = CONTENT_TABLES[type];
  if (!table) return null;
  const row = db.prepare(`select * from ${table} where id = ?`).get(Number(id));
  if (!row) return null;

  const status = decision === 'approve' ? MODERATION.APPROVED : MODERATION.REJECTED;
  db.prepare(`update ${table} set moderation = ? where id = ?`).run(status, row.id);

  const word = decision === 'approve' ? 'подтверждён' : 'отклонён';
  const what = type === 'build' ? 'Билд' : 'Топ';
  const title = `${what} «${row.title}» ${word} администратором`;

  notify(db, row.author_id, {
    kind: 'moderation',
    title,
    body: note || (decision === 'approve'
      ? 'Содержимое опубликовано, его видят все игроки.'
      : 'Содержимое не опубликовано. Автор может исправить и отправить снова.'),
    link: type === 'build' ? `/builds/${row.id}` : `/tops/${row.id}`,
    actorId: admin ? admin.id : null,
  });

  // Письмо кладу в очередь; отправка — отдельным шагом, чтобы заявка
  // не пропала из-за недоступного SMTP.
  let queued = null;
  if (mailer) {
    queued = mailer.queueForUser(db, row.author_id, {
      subject: `DotaCustoms: ${what.toLowerCase()} «${row.title}» ${word}`,
      body: buildMailBody({ what, row, word, note, admin }),
    });
  }

  return { status, notified: true, emailed: queued };
}

function buildMailBody({ what, row, word, note, admin }) {
  const lines = [
    `Здравствуйте!`,
    ``,
    `Ваш ${what.toLowerCase()} «${row.title}» ${word} администратором${admin ? ` (${admin.nickname})` : ''}.`,
    ``,
  ];
  if (note) lines.push(`Комментарий администратора:`, note, ``);
  lines.push(
    word === 'подтверждён'
      ? 'Теперь его видят все игроки.'
      : 'Он не опубликован. Исправьте замечания и отправьте снова.',
  );
  return lines.join('\n');
}

module.exports = {
  MODERATION, MODERATION_KEYS,
  needsApproval, moderationFor,
  notify, notifyAdmins, unreadCount, listNotifications, markRead, markAllRead,
  contentTitle, resolveContent, CONTENT_TABLES,
};
