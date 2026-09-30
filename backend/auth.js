/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — пароли, токены, сессии и проверка прав
   ──────────────────────────────────────────────────────────────────────
   Пароли: scrypt (встроен в Node, без нативных зависимостей).
   Токены: подписанные HMAC + запись в таблице sessions — значит любой
   токен можно отозвать (выход со всех устройств, бан аккаунта).
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('node:crypto');
const { ROLES, COACH_SCOPES, LIMITS } = require('./config');
const { ApiError, unauthorized, forbidden, randomId, hashToken, nowIso } = require('./util');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ── секрет подписи токенов ─────────────────────────────────────────────
//
// Секрет ОБЯЗАН ПЕРЕЖИВАТЬ ПЕРЕЗАПУСК, иначе пользователь выходит из
// аккаунта после каждого закрытия программы. Раньше здесь стоял
// crypto.randomBytes(48) на каждый старт процесса: токен, выданный вчера,
// сегодня уже не проходил проверку HMAC, интерфейс получал 401 и стирал
// токен — отсюда и было «постоянно забывает меня». Теперь секрет лежит в
// таблице settings рядом с базой и переживает и перезапуск, и обновление.
let secret = null;

function initSecret(db) {
  // Явный ключ из окружения важнее всего — им пользуются тесты и сервер.
  if (process.env.DOTACUSTOMS_SECRET) {
    secret = Buffer.from(process.env.DOTACUSTOMS_SECRET, 'utf8');
    return 'env';
  }
  if (global.__DOTACUSTOMS_SECRET__) {
    secret = global.__DOTACUSTOMS_SECRET__;
    return 'global';
  }

  const { getSetting, setSetting } = require('./db');
  const stored = getSetting(db, 'token_secret', '');
  if (stored.length >= 32) {
    secret = Buffer.from(stored, 'base64');
    global.__DOTACUSTOMS_SECRET__ = secret;
    return 'stored';
  }
  const fresh = crypto.randomBytes(48);
  setSetting(db, 'token_secret', fresh.toString('base64'));
  secret = fresh;
  global.__DOTACUSTOMS_SECRET__ = secret;
  return 'created';
}

// ── пароли ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const key = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

// ── токены ─────────────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => {
  if (!secret) {
    // Без initSecret подписывать нечем. Раньше здесь был случайный ключ,
    // и этот случай молча ломал все ранее выданные токены.
    throw new Error('Секрет подписи не инициализирован: вызови initSecret(db) при старте');
  }
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
};

/** token = base64url(payloadJSON).подпись */
function createToken(userId, days = LIMITS.sessionDays) {
  const payload = b64u(JSON.stringify({
    uid: Number(userId),
    exp: Date.now() + days * 86400_000,
    jti: randomId(9),
  }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = sign(payload);
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.uid || !data.exp || Date.now() > data.exp) return null;
    return data;
  } catch { return null; }
}

// ── сессии ─────────────────────────────────────────────────────────────
function createSession(db, userId, meta = {}) {
  const token = createToken(userId);
  db.prepare(
    `insert into sessions (token_hash, user_id, created_at, expires_at, user_agent, ip)
     values (?,?,?,?,?,?)`
  ).run(
    hashToken(token), userId, nowIso(),
    new Date(Date.now() + LIMITS.sessionDays * 86400_000).toISOString(),
    String(meta.userAgent || '').slice(0, 300),
    String(meta.ip || '').slice(0, 60),
  );
  return token;
}

function findSessionUser(db, token) {
  const data = readToken(token);
  if (!data) return null;
  const row = db.prepare(
    `select s.expires_at, u.* from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = ?`
  ).get(hashToken(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('delete from sessions where token_hash = ?').run(hashToken(token));
    return null;
  }
  if (row.is_banned) return { banned: true, user: row };
  return { banned: false, user: row };
}

function destroySession(db, token) {
  db.prepare('delete from sessions where token_hash = ?').run(hashToken(token));
}

function destroyUserSessions(db, userId) {
  db.prepare('delete from sessions where user_id = ?').run(userId);
}

// ── middleware ─────────────────────────────────────────────────────────
/** Достаёт req.user из заголовка Authorization: Bearer <token> */
function attachUser(db) {
  return (req, _res, next) => {
    req.token = null;
    req.user = null;
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token) {
      const found = findSessionUser(db, token);
      if (found && !found.banned) {
        req.token = token;
        req.user = found.user;
      } else if (found?.banned) {
        req.user = null;
        req.bannedUser = found.user;
      }
    }
    next();
  };
}

const requireAuth = (req, _res, next) => {
  if (req.bannedUser) return next(new ApiError(403, 'Аккаунт заблокирован', 'banned'));
  if (!req.user) return next(unauthorized());
  next();
};

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) {
    return next(forbidden('Этот раздел доступен только ' +
      (roles.includes(ROLES.ADMIN) ? 'администратору' : 'coach')));
  }
  next();
};

const requireAdmin = requireRole(ROLES.ADMIN);
const requireStaff = requireRole(ROLES.ADMIN, ROLES.COACH);

// ── права Coach ────────────────────────────────────────────────────────
/** Есть ли у пользователя scopes Coach и подходит ли режим. */
function coachScopes(db, user) {
  if (!user) return [];
  if (user.role === ROLES.ADMIN) return ['*'];
  if (user.role !== ROLES.COACH) return [];
  const rows = db.prepare('select scope from coach_scopes where user_id = ?').all(user.id);
  const scopes = rows.map(r => r.scope).filter(s => COACH_SCOPES.includes(s));
  return scopes.length ? scopes : [];
}

const isCoachFor = (db, user, mode) => {
  const s = coachScopes(db, user);
  return s.includes('*') || s.includes(mode);
};

module.exports = {
  hashPassword, verifyPassword,
  initSecret,
  createToken, readToken, createSession, findSessionUser, destroySession, destroyUserSessions,
  attachUser, requireAuth, requireAdmin, requireStaff, requireRole,
  coachScopes, isCoachFor,
};
