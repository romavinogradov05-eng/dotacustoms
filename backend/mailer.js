/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — отправка писем (SMTP без внешних библиотек)
   ──────────────────────────────────────────────────────────────────────
   Зачем свой клиент, а не nodemailer: в проект не хочется тянуть
   зависимость ради шести команд SMTP. Нужный кусок протокола
   (EHLO → AUTH LOGIN → MAIL FROM → RCPT TO → DATA) — это полусотня
   строк, и он читается целиком.

   Главное правило: письмо НИКОГДА не отправляется прямо во время
   запроса пользователя. Заявка или решение кладутся в таблицу
   email_queue, а отправка происходит отдельным шагом. Иначе недоступный
   SMTP превратил бы «принять жалобу» в ошибку, и человек потерял бы
   текст обращения.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { nowIso } = require('./util');

const DEFAULT_TIMEOUT = 15_000;

/* ── настройки почты ─────────────────────────────────────────────────────
   Хранятся в таблице settings, заполняются администратором в разделе
   «Настройки». Пустой host означает «почта не настроена» — тогда
   решение всё равно принимается, просто письмо не уходит. */
const KEYS = {
  host: 'mail_host',
  port: 'mail_port',
  secure: 'mail_secure',        // '1' = SMTPS (465)
  user: 'mail_user',
  pass: 'mail_pass',
  from: 'mail_from',
  fromName: 'mail_from_name',
};

function readConfig(db) {
  const get = k => {
    try {
      const r = db.get('select value from settings where key = ?', k);
      return r ? r.value : '';
    } catch { return ''; }
  };
  return {
    host: get(KEYS.host).trim(),
    port: Number(get(KEYS.port)) || (get(KEYS.secure) === '1' ? 465 : 587),
    secure: get(KEYS.secure) === '1',
    user: get(KEYS.user),
    pass: get(KEYS.pass),
    from: get(KEYS.from).trim(),
    fromName: get(KEYS.fromName).trim() || 'DotaCustoms',
  };
}

const isConfigured = (cfg) => !!(cfg && cfg.host && cfg.from);

/* ── очередь ──────────────────────────────────────────────────────────── */

function queue(db, { to, subject, body }) {
  if (!to || !String(to).includes('@')) return null;
  const info = db.prepare(`
    insert into email_queue (to_addr, subject, body, created_at) values (?,?,?,?)
  `).run(String(to).trim(), String(subject || ''), String(body || ''), nowIso());
  return Number(info.lastInsertRowid);
}

/** Кладёт письмо в очередь, если у пользователя указана почта. */
function queueForUser(db, userId, { subject, body }) {
  try {
    const u = db.get('select email from users where id = ?', Number(userId));
    if (!u || !u.email) return null;   // почты нет — уведомление придёт в колокольчик
    return queue(db, { to: u.email, subject, body });
  } catch {
    return null;
  }
}

const pending = (db, limit = 20) =>
  db.prepare(`select * from email_queue where status = 'pending' order by created_at, id limit ?`)
    .all(limit);

const countPending = db => db.get(`select count(*) as c from email_queue where status = 'pending'`).c;

/* ── SMTP ─────────────────────────────────────────────────────────────── */

/** Разбирает поток SMTP в команды: «250-…» — продолжение, «250 …» — конец. */
function SmtpSession(socket) {
  this.socket = socket;
  this.buffer = '';
  this.waiters = [];
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    this.buffer += chunk;
    this.drain();
  });
}

SmtpSession.prototype.drain = function drain() {
  // Ждём либо строку целиком, либо код с дефисом ( multiline ).
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = /^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/.exec(this.buffer))) {
    const raw = m[0];
    this.buffer = this.buffer.slice(raw.length);
    const code = Number(raw.slice(0, 3));
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ code, text: raw.trim() });
  }
};

SmtpSession.prototype.read = function read(timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = this.waiters.findIndex(w => w.resolve === onDone);
      if (i >= 0) this.waiters.splice(i, 1);
      reject(new Error('SMTP: сервер не ответил вовремя'));
    }, timeout);
    const onDone = (r) => { clearTimeout(timer); resolve(r); };
    this.waiters.push({ resolve: onDone });
  });
};

SmtpSession.prototype.send = async function send(line, timeout) {
  this.socket.write(line + '\r\n');
  return this.read(timeout);
};

/** Ожидаем код из списка, иначе понятная ошибка с ответом сервера. */
async function expect(session, codes, what) {
  const r = await session.read();
  if (!codes.includes(r.code)) {
    throw new Error(`SMTP: ${what} — сервер ответил ${r.code}: ${r.text}`);
  }
  return r;
}

/**
 * Отправляет одно письмо. Возвращает '' при успехе или текст ошибки.
 * Ошибку не бросаем: вызывающий сам решит, что с ней делать.
 */
async function sendOne(cfg, { to, subject, body }) {
  let socket = null;
  let session = null;
  try {
    const connect = cfg.secure
      ? () => tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : () => net.connect({ host: cfg.host, port: cfg.port });
    socket = await new Promise((resolve, reject) => {
      const s = connect();
      s.setTimeout(DEFAULT_TIMEOUT);
      s.once(cfg.secure ? 'secureConnect' : 'connect', () => resolve(s));
      s.once('error', reject);
      s.once('timeout', () => { s.destroy(); reject(new Error('SMTP: таймаут подключения')); });
    });

    session = new SmtpSession(socket);
    await expect(session, [220], 'приветствие не получено');

    const domain = cfg.from.split('@')[1] || cfg.host;
    await session.send(`EHLO ${domain}`);
    // Сервер может ответить 250 на EHLO; при ошибке пробуем устаревший HELO
    const ehlo = await session.read();
    if (ehlo.code !== 250) await session.send(`HELO ${domain}`);

    if (cfg.user) {
      // Переводим в AUTH LOGIN явно: STARTTLS-обвязку не поддерживаем,
      // поэтому для защищённой отправки нужен порт 465 (secure).
      await session.send('AUTH LOGIN');
      await expect(session, [334], 'сервер не предложил AUTH LOGIN');
      await session.send(Buffer.from(cfg.user, 'utf8').toString('base64'));
      await expect(session, [334], 'логин не принят');
      await session.send(Buffer.from(cfg.pass, 'utf8').toString('base64'));
      await expect(session, [235], 'вход не выполнен');
    }

    await session.send(`MAIL FROM:<${cfg.from}>`);
    await expect(session, [250], 'отправитель не принят');

    await session.send(`RCPT TO:<${to}>`);
    const rcpt = await session.read();
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw new Error(`SMTP: получатель отклонён — ${rcpt.code} ${rcpt.text}`);
    }

    await session.send('DATA');
    await expect(session, [354], 'тело письма не началось');

    const fromHeader = cfg.fromName ? `"${cfg.fromName.replace(/"/g, '')}" <${cfg.from}>` : cfg.from;
    // Точка в начале строки — конец письма в SMTP, поэтому удваиваем её.
    const message = [
      `From: ${fromHeader}`,
      `To: <${to}>`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      '',
      String(body).replace(/\r?\n/g, '\r\n'),
    ].join('\r\n').replace(/^\./gm, '..');

    socket.write(message + '\r\n.\r\n');
    await expect(session, [250], 'письмо не принято сервером');

    try { await session.send('QUIT'); } catch { /* сервер мог уже закрыться */ }
    return '';
  } catch (err) {
    return err && err.message ? err.message : String(err);
  } finally {
    if (socket) { try { socket.destroy(); } catch { /* уже закрыт */ } }
  }
}

/** Тема письма: не-ASCII надо закодировать, иначе почта придёт кракозябрами. */
function encodeHeader(value) {
  const text = String(value || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

/**
 * Обрабатывает очередь. Ошибка не удаляет письмо, а увеличивает счётчик
 * попыток: после MAX_ATTEMPTS письмо помечается failed, чтобы не крутить
 * его вечно, но его можно переотправить вручную из админки.
 */
const MAX_ATTEMPTS = 5;

async function flush(db, { limit = 20 } = {}) {
  const cfg = readConfig(db);
  if (!isConfigured(cfg)) {
    return { sent: 0, failed: 0, skipped: 'SMTP не настроен' };
  }
  const rows = pending(db, limit);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const err = await sendOne(cfg, { to: row.to_addr, subject: row.subject, body: row.body });
    if (err === '') {
      db.prepare(`update email_queue set status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = '' where id = ?`)
        .run(nowIso(), row.id);
      sent++;
    } else {
      const attempts = row.attempts + 1;
      db.prepare('update email_queue set attempts = ?, last_error = ?, status = ? where id = ?')
        .run(attempts, err, attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', row.id);
      failed++;
    }
  }
  return { sent, failed, total: rows.length };
}

/** Отправляет очередь в фоне, не мешая ответу пользователю. */
function flushSoon(db) {
  setTimeout(() => {
    flush(db).catch(err => console.warn('[dotacustoms] очередь писем:', err.message));
  }, 50).unref?.();
}

module.exports = {
  KEYS, readConfig, isConfigured,
  queue, queueForUser, pending, countPending, flush, flushSoon,
  sendOne, MAX_ATTEMPTS,
};
