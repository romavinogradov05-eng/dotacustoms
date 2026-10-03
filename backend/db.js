/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — база данных (SQLite через node-sqlite3-wasm)
   ──────────────────────────────────────────────────────────────────────
   Схема создаётся при первом запуске и обновляется идемпотентно:
   можно запускать скрипт многократно после обновления программы.

   ГЛАВНОЕ ПРАВИЛО ОБНОВЛЕНИЙ: пользовательские данные переживают
   обновление программы. Поэтому
     • новая колонка добавляется через ALTER TABLE в MIGRATIONS,
     • перед первой миграцией делается резервная копия базы,
     • ни одна миграция не делает DROP TABLE.
   Список применённых миграций лежит в таблице migrations.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

// ВАЖНО: node-sqlite3-wasm НЕ подключён на уровне модуля. На Vercel (PG-ветка,
// DATABASE_URL) он не нужен вообще, а его .wasm не попадает в бандл функции —
// require в этом месте уронил бы каждый холодный старт (ENOENT .wasm).
// Единственное использование — ленивый require('./sqlite') в openSqliteLocal.

const { defaultDataDir, ensureDir, MODES } = require('./config');
const { nowIso } = require('./util');

/** Сколько резервных копий базы храним. */
const BACKUP_KEEP = 12;

const SCHEMA = `
-- ══ Пользователи и роли ══════════════════════════════════════════════
create table if not exists users (
  id            integer primary key autoincrement,
  username      text not null unique,          -- технический ник (латиница)
  nickname      text not null,                 -- отображаемое имя
  password_hash text not null,
  role          text not null default 'user',  -- user | coach | admin
  bio           text not null default '',
  avatar        text not null default '',      -- ключ героя или эмодзи
  contact       text not null default '',      -- телеграм / стим / дискорд
  is_banned     integer not null default 0,
  ban_reason    text not null default '',
  created_at    text not null,
  last_seen_at  text
);
create index if not exists idx_users_role on users(role);

-- области Coach: '*' = все режимы, иначе 'chc' / 'rr'
create table if not exists coach_scopes (
  user_id integer not null references users(id) on delete cascade,
  scope   text not null,
  primary key (user_id, scope)
);

create table if not exists sessions (
  token_hash text primary key,
  user_id    integer not null references users(id) on delete cascade,
  created_at text not null,
  expires_at text not null,
  user_agent text not null default '',
  ip         text not null default ''
);

-- ══ Режимы ═══════════════════════════════════════════════════════════
create table if not exists modes (
  key   text primary key,
  title text not null,
  sort  integer not null default 0
);

-- ══ Билды ════════════════════════════════════════════════════════════
create table if not exists builds (
  id           integer primary key autoincrement,
  author_id    integer not null references users(id) on delete cascade,
  mode         text not null,                  -- chc | rr
  hero_id      integer,                        -- null = билд без привязки к герою
  title        text not null,
  description  text not null default '',
  stage        text not null default 'any',    -- laning | midgame | late | full | any
  patch        text not null default '',
  difficulty   integer not null default 1,     -- 1..5
  is_draft     integer not null default 0,     -- черновик, виден только автору
  items        text not null default '[]',     -- [{item_id, note}]
  skills       text not null default '[]',     -- [{ability_id, rank}]
  talents      text not null default '[]',     -- [ability_id × 5]
  neutrals     text not null default '[]',     -- [{neutral_id, note}]
  views        integer not null default 0,
  created_at   text not null,
  updated_at   text not null,
  verified_by  integer references users(id) on delete set null,
  verified_at  text,
  verify_note  text not null default ''
);
create index if not exists idx_builds_mode  on builds(mode, is_draft, created_at desc);
create index if not exists idx_builds_hero  on builds(hero_id);
create index if not exists idx_builds_auth  on builds(author_id, created_at desc);
create index if not exists idx_builds_top   on builds(verified_at desc, created_at desc);

create table if not exists build_votes (
  build_id   integer not null references builds(id) on delete cascade,
  user_id    integer not null references users(id) on delete cascade,
  value      integer not null default 1,      -- 1 = лайк, -1 = минус
  created_at text not null,
  primary key (build_id, user_id)
);
create index if not exists idx_bvotes_user on build_votes(user_id);

-- комментарии к билдам (тред без статусов)
create table if not exists build_comments (
  id          integer primary key autoincrement,
  build_id    integer not null references builds(id) on delete cascade,
  author_id   integer not null references users(id) on delete cascade,
  body        text not null,
  created_at  text not null,
  edited_at   text,
  is_deleted  integer not null default 0
);
create index if not exists idx_bcomments_build on build_comments(build_id, created_at);

-- ══ Топы (герои / нейтралки / скиллы) ════════════════════════════════
create table if not exists meta_tops (
  id          integer primary key autoincrement,
  author_id   integer not null references users(id) on delete cascade,
  mode        text not null,
  kind        text not null,                   -- heroes | neutrals | skills
  title       text not null,
  description text not null default '',
  patch       text not null default '',
  is_draft    integer not null default 0,
  created_at  text not null,
  updated_at  text not null,
  verified_by integer references users(id) on delete set null,
  verified_at text,
  verify_note text not null default ''
);
create index if not exists idx_tops_mode on meta_tops(mode, kind, is_draft, created_at desc);

create table if not exists meta_top_entries (
  id      integer primary key autoincrement,
  top_id  integer not null references meta_tops(id) on delete cascade,
  rank    integer not null default 0,         -- 1 = лучший
  ref_id  integer not null,                    -- id героя / нейтралки / способности
  tier    text not null default '',            -- S | A | B | C | D
  note    text not null default ''
);
create index if not exists idx_entries_top on meta_top_entries(top_id, rank);
create unique index if not exists uq_entries_ref on meta_top_entries(top_id, ref_id);

create table if not exists top_votes (
  top_id     integer not null references meta_tops(id) on delete cascade,
  user_id    integer not null references users(id) on delete cascade,
  created_at text not null,
  primary key (top_id, user_id)
);

-- ══ Ветви: баги, фичи, обсуждения ════════════════════════════════════
create table if not exists threads (
  id          integer primary key autoincrement,
  author_id   integer not null references users(id) on delete cascade,
  mode        text not null,                  -- chc | rr | any
  category    text not null,                   -- bug | feature | balance | guide | discussion
  title       text not null,
  body        text not null,
  hero_id     integer,
  patch       text not null default '',
  severity    text not null default 'medium',  -- low | medium | high | blocker
  status      text not null default 'open',    -- open | confirmed | fixed | rejected | archived
  is_pinned   integer not null default 0,
  is_locked   integer not null default 0,
  is_deleted  integer not null default 0,
  views       integer not null default 0,
  created_at  text not null,
  updated_at  text not null,
  resolved_by integer references users(id) on delete set null,
  resolved_at text
);
create index if not exists idx_threads_list  on threads(is_deleted, is_pinned desc, updated_at desc);
create index if not exists idx_threads_cat   on threads(category, status, is_deleted);
create index if not exists idx_threads_mode  on threads(mode, is_deleted, updated_at desc);
create index if not exists idx_threads_auth  on threads(author_id, created_at desc);

create table if not exists posts (
  id          integer primary key autoincrement,
  thread_id   integer not null references threads(id) on delete cascade,
  author_id   integer not null references users(id) on delete cascade,
  parent_id   integer references posts(id) on delete cascade,
  body        text not null,
  created_at  text not null,
  edited_at   text,
  is_deleted  integer not null default 0
);
create index if not exists idx_posts_thread on posts(thread_id, created_at);

create table if not exists thread_votes (
  thread_id   integer not null references threads(id) on delete cascade,
  user_id     integer not null references users(id) on delete cascade,
  value       integer not null default 1,
  created_at  text not null,
  primary key (thread_id, user_id)
);

create table if not exists post_votes (
  post_id     integer not null references posts(id) on delete cascade,
  user_id     integer not null references users(id) on delete cascade,
  value       integer not null default 1,
  created_at  text not null,
  primary key (post_id, user_id)
);

-- ══ Руководство для новичков ═════════════════════════════════════════
create table if not exists guides (
  id          integer primary key autoincrement,
  slug        text not null unique,
  title       text not null,
  category    text not null default 'basics', -- basics | chc | rr | builds | rules
  summary     text not null default '',
  body        text not null,
  order_index integer not null default 0,
  is_official integer not null default 1,
  published   integer not null default 1,
  author_id   integer references users(id) on delete set null,
  created_at  text not null,
  updated_at  text not null
);
create index if not exists idx_guides_order on guides(published, order_index);

-- ══ Жалобы на контент ═══════════════════════════════════════════════
create table if not exists flags (
  id          integer primary key autoincrement,
  reporter_id integer not null references users(id) on delete cascade,
  target_type text not null,                   -- build | top | thread | post | comment | guide
  target_id   integer not null,
  reason      text not null,
  details     text not null default '',
  status      text not null default 'open',    -- open | accepted | rejected
  created_at  text not null,
  resolved_by integer references users(id) on delete set null,
  resolved_at text
);
create index if not exists idx_flags_status on flags(status, created_at desc);

-- ══ Лог действий модерации ════════════════════════════════════════════
create table if not exists mod_log (
  id          integer primary key autoincrement,
  actor_id    integer references users(id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   integer,
  reason      text not null default '',
  created_at  text not null
);
create index if not exists idx_modlog_time on mod_log(created_at desc);

-- ══ Настройки приложения ═════════════════════════════════════════════
-- Секрет подписи токенов лежит здесь. Раньше он генерировался при каждом
-- запуске, и после перезапуска все входы слетали — пользователь выходил
-- из аккаунта. Теперь секрет переживает перезапуск.
create table if not exists settings (
  key   text primary key,
  value text not null default ''
);

-- ══ Уведомления (ячейка-колокольчик в шапке) ═════════════════════════
create table if not exists notifications (
  id         integer primary key autoincrement,
  user_id    integer not null references users(id) on delete cascade,
  kind       text not null default 'info',   -- moderation | report | reply | system
  title      text not null,
  body       text not null default '',
  link       text not null default '',       -- маршрут интерфейса, напр. /admin?tab=queue
  actor_id   integer references users(id) on delete set null,
  is_read    integer not null default 0,
  created_at text not null
);
create index if not exists idx_notif_user on notifications(user_id, is_read, created_at desc);

-- ══ Ростер героев кастомных игр ═══════════════════════════════════
-- В справочнике Dota 127 героев, а в CHC и Ratten Run играют не все.
-- Раньше ростер лежал в data/custom/rosters.json, и чтобы им
-- пользоваться, приходилось править файл и пересобирать датасет —
-- то есть прямо в приложении настроить его было нельзя. Теперь он
-- в базе: правится из интерфейса и сразу действует.
--
-- Пустой массив keys = ограничений нет (показываем всех героев).
-- Храним ключи героев (heroes[].key), а не id: ключ читаемый и не
-- меняется при пересборке справочника.
create table if not exists hero_rosters (
  mode       text primary key,          -- chc | rr
  keys       text not null default '[]', -- JSON-массив ключей героев
  note       text not null default '',   -- откуда взялся список
  updated_at text not null,
  updated_by integer references users(id) on delete set null
);

-- ══ Заявления и жалобы в свободной форме ═════════════════════════════
-- Отличие от flags: здесь нет объекта жалобы — пользователь сам пишет
-- тему и текст. Админ принимает или отклоняет, после чего пользователю
-- уходит письмо на почту из профиля.
create table if not exists reports (
  id           integer primary key autoincrement,
  author_id    integer not null references users(id) on delete cascade,
  subject      text not null,                -- тема, обязательна
  body         text not null,                -- свободный текст
  kind         text not null default 'appeal', -- appeal | complaint | other
  status       text not null default 'open', -- open | accepted | rejected
  admin_note   text not null default '',     -- что ответил админ
  is_anonymous integer not null default 0,   -- скрыть ник автора от других
  created_at   text not null,
  resolved_by  integer references users(id) on delete set null,
  resolved_at  text,
  emailed_at   text
);
create index if not exists idx_reports_status on reports(status, created_at desc);
create index if not exists idx_reports_author on reports(author_id, created_at desc);

-- ══ Очередь писем ════════════════════════════════════════════════════
-- Письма не отправляем прямо во время запроса: SMTP может быть недоступен,
-- и пользователь не должен получать ошибку вместо сохранённой заявки.
create table if not exists email_queue (
  id         integer primary key autoincrement,
  to_addr    text not null,
  subject    text not null,
  body       text not null,
  status     text not null default 'pending', -- pending | sent | failed
  attempts   integer not null default 0,
  last_error text not null default '',
  created_at text not null,
  sent_at    text
);
create index if not exists idx_email_status on email_queue(status, created_at);

-- ══ Журнал миграций ══════════════════════════════════════════════════
create table if not exists migrations (
  id         integer primary key autoincrement,
  name       text not null unique,
  applied_at text not null
);
`;

/* ══════════════════════════════════════════════════════════════════════
   Миграции: только ADD COLUMN / CREATE INDEX. Никаких DROP.
   ──────────────────────────────────────────────────────────────────────
   `create table if not exists` в SCHEMA покрывает новые таблицы, а
   изменить схему существующей таблицы так нельзя — поэтому новые
   колонки заводятся здесь, по одной миграции на релиз.
   ══════════════════════════════════════════════════════════════════════ */
const MIGRATIONS = [
  {
    // v1.1 — почта для уведомлений, модерация билдов и топов
    name: '2026-09-29-moderation-email',
    steps: [
      "alter table users     add column email text not null default ''",
      "alter table builds    add column moderation text not null default 'approved'",
      "alter table meta_tops add column moderation text not null default 'approved'",
      'create index if not exists idx_builds_moderation on builds(moderation, created_at desc)',
      'create index if not exists idx_tops_moderation  on meta_tops(moderation, created_at desc)',
    ],
  },
];

/** Колонки, которые уже есть — чтобы ALTER не падал на повторном запуске. */
function columnsOf(db, table) {
  try {
    if (db.dialect === 'pg') {
      return new Set(
        db.all('select column_name as name from information_schema.columns where table_name = ?', table)
          .map(r => r.name),
      );
    }
    return new Set(db.all(`pragma table_info(${table})`).map(r => r.name));
  } catch {
    return new Set();
  }
}

/**
 * Копия базы перед обновлением схемы.
 * WAL-режим означает, что свежие изменения могут лежать ещё и в .wal,
 * поэтому вызывающий код сначала делает checkpoint — иначе в копию
 * попадут не все данные.
 */
function backupDatabase(dataDir, file, tag = 'auto') {
  const dir = path.join(dataDir, 'backups');
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `dotacustoms-${stamp}-${tag}.db`;
  const target = path.join(dir, name);
  fs.copyFileSync(file, target);

  // храним только последние копии, чтобы папка не росла бесконечно
  const all = fs.readdirSync(dir)
    .filter(f => /^dotacustoms-.*\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of all.slice(BACKUP_KEEP)) {
    try { fs.rmSync(path.join(dir, old), { force: true }); } catch { /* занято */ }
  }
  return target;
}

/**
 * Применяет миграции, которых ещё не было.
 * Перед первой миграцией в этом запуске делает резервную копию — если
 * что-то пойдёт не так, данные можно вернуть вручную.
 */
function applyMigrations(db, dataDir, file) {
  let done = 0;
  let backedUp = false;
  for (const m of MIGRATIONS) {
    const already = db.get('select id from migrations where name = ?', m.name);
    if (already) continue;

    if (!backedUp && dataDir && file) {
      try {
        db.run('pragma wal_checkpoint(TRUNCATE)');
      } catch { /* checkpoint не критичен для копии */ }
      try {
        const copy = backupDatabase(dataDir, file, 'migrate');
        console.log(`[dotacustoms] резервная копия базы: ${path.relative(dataDir, copy)}`);
      } catch (err) {
        console.warn('[dotacustoms] не смог сделать резервную копию:', err.message);
      }
      backedUp = true;
    }

    for (const step of m.steps) {
      // ALTER TABLE не поддерживает IF NOT EXISTS, поэтому сверяемся сами
      const alt = /^alter\s+table\s+(\w+)\s+add\s+column\s+(\w+)/i.exec(step);
      if (alt) {
        const [, table, column] = alt;
        if (!columnsOf(db, table).has(column)) db.run(step);
        continue;
      }
      try {
        db.run(step);
      } catch (err) {
        console.warn(`[dotacustoms] миграция «${m.name}», шаг не выполнен: ${err.message}`);
      }
    }

    try {
      db.run('insert into migrations (name, applied_at) values (?,?)', m.name, nowIso());
    } catch (err) {
      // Serverless: миграцию мог применить параллельный инстанс между нашей
      // проверкой и вставкой — unique-конфликт тогда не ошибка.
      const still = db.get('select id from migrations where name = ?', m.name);
      if (!still) throw err;
    }
    done++;
    console.log(`[dotacustoms] миграция применена: ${m.name}`);
  }
  return done;
}

/**
 * Убирает каталог-блокировку, если её никто не держит.
 *
 * node-sqlite3-wasm реализует блокировки через каталог `<база>.lock`:
 * при открытии он создаётся, при закрытии удаляется. Если процесс убили
 * (диспетчер задач, падение, выключение) — каталог остаётся, и все
 * следующие запуски падают с «database is locked» навсегда.
 *
 * Понять, живой ли владелец, можно по PID: держим его рядом с базой.
 * Процесса нет — значит блокировка протухла, её можно снять.
 */
function clearStaleLock(file) {
  const lock = file + '.lock';
  if (!fs.existsSync(lock)) return null;

  const pid = readPidFile(file);
  if (pid && processAlive(pid)) {
    return pid;   // база действительно занята живым процессом
  }

  try {
    fs.rmSync(lock, { recursive: true, force: true });
    removePidFile(file);
    return null;
  } catch {
    return pid;   // не смогли снять — пусть сообщит исходная ошибка
  }
}

const pidFile = file => file + '.pid';

function readPidFile(file) {
  try {
    const n = Number(fs.readFileSync(pidFile(file), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writePidFile(file) {
  try { fs.writeFileSync(pidFile(file), String(process.pid), 'utf8'); } catch { /* не критично */ }
}

function removePidFile(file) {
  try { fs.rmSync(pidFile(file), { force: true }); } catch { /* уже нет */ }
}

/** Жив ли процесс: kill(pid, 0) не убивает, но сообщает «нет процесса». */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';   // есть, но принадлежит другому пользователю
  }
}

function openDatabase(dataDir = defaultDataDir()) {
  if (process.env.DATABASE_URL) return openPgRemote();
  return openSqliteLocal(dataDir);
}

/** PostgreSQL-ветка: та же схема и миграции, но без файлов и прагм. */
function openPgRemote() {
  const { open } = require('./pg');
  const { SCHEMA_PG } = require('./schema-pg');
  const db = open();
  db.exec(SCHEMA_PG);
  applyMigrations(db, null, null);
  seedModes(db);
  return db;
}

function openSqliteLocal(dataDir) {
  ensureDir(dataDir);
  const file = path.join(dataDir, 'dotacustoms.db');

  // снимаем протухшую блокировку до открытия, иначе SQLite её не видит
  const holder = clearStaleLock(file);

  let db;
  try {
    // Ленивый require: на Vercel (PG-ветка) node-sqlite3-wasm не нужен
    // вовсе, и его bundled .wasm не должен попадать в бандл функции.
    const { open: openSqlite } = require('./sqlite');
    db = openSqlite(file);
    // busy_timeout ставим первым: пока база занята (например, уже открыто
    // второе окно приложения) SQLite ждёт, а не падает с «database is locked».
    db.run('pragma busy_timeout = 5000');
    db.run('pragma journal_mode = WAL');
    db.run('pragma foreign_keys = ON');
    db.exec(SCHEMA);
    writePidFile(file);

    // Обновление схемы — только ADD COLUMN, с резервной копией перед
    // первой применённой миграцией. Пользовательские данные переживают
    // обновление программы.
    applyMigrations(db, dataDir, file);
  } catch (err) {
    if (db) { try { db.close(); } catch { /* уже закрыта */ } }
    if (/lock|locked/i.test(String(err && err.message))) {
      const who = holder ? ` Держатель: процесс ${holder}.` : '';
      throw new Error(
        `База занята другим процессом DotaCustoms:\n${file}\n\n` +
        'Закрой уже открытое окно приложения и запусти снова.' +
        `${who}\n\nЕсли окна нет — удали папку "${file}.lock" и запусти заново.`,
      );
    }
    throw err;
  }

  seedModes(db);

  // при штатном закрытии убираем и блокировку, и pid-файл
  const rawClose = db.close.bind(db);
  db.close = function close() {
    try { rawClose(); } finally {
      removePidFile(file);
      try { fs.rmSync(file + '.lock', { recursive: true, force: true }); } catch { /* уже нет */ }
    }
  };

  return db;
}

function seedModes(db) {
  // ВНИМАНИЕ: `on conflict … do update` драйвер node-sqlite3-wasm выполняет
  // неверно (значения из excluded приходят пустыми), поэтому обновляем явно.
  const find = db.prepare('select key from modes where key = ?');
  const insert = db.prepare('insert into modes (key, title, sort) values (?,?,?)');
  const update = db.prepare('update modes set title = ?, sort = ? where key = ?');
  try {
    for (const m of MODES) {
      if (find.get(m.key)) update.run(m.title, m.sort, m.key);
      else insert.run(m.key, m.title, m.sort);
    }
  } finally {
    find.finalize();
    insert.finalize();
    update.finalize();
  }
}

/**
 * Аварийный сид админа. По умолчанию НЕ выполняется: пароль по умолчанию —
��то дыра, через которую любой, кто откроет приложение, зайдёт админом.
 * Обычно админом становится первый зарегистрировавшийся игрок
 * (см. backend/routes/auth.js), а этот сид нужен только для скриптов
 * восстановления, когда включён DOTACUSTOMS_SEED_ADMIN=1.
 */
function ensureFirstAdmin(db, username, password) {
  if (process.env.DOTACUSTOMS_SEED_ADMIN !== '1') return null;
  const row = db.prepare('select count(*) as c from users').get();
  if (row.c > 0) return null;
  const { hashPassword } = require('./auth');
  db.run(
    `insert into users (username, nickname, password_hash, role, bio, created_at, last_seen_at)
     values (?,?,?,?,?,?,?)`,
    username, username.toUpperCase(), hashPassword(password), 'admin',
    'Основатель хаба. Создан автоматически при первой установке.',
    nowIso(), nowIso(),
  );
  return username;
}

/** Сколько всего пользователей — нужно для подсказки при первом запуске. */
function userCount(db) {
  return db.prepare('select count(*) as c from users').get().c;
}

/* ── настройки (ключ-значение) ────────────────────────────────────────── */

function getSetting(db, key, fallback = '') {
  try {
    const row = db.get('select value from settings where key = ?', key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

/** Апсерт через find-then-update: драйвер неверно выполняет
 *  `on conflict … do update` (значения из excluded приходят пустыми). */
function setSetting(db, key, value) {
  const text = value === null || value === undefined ? '' : String(value);
  const found = db.get('select key from settings where key = ?', key);
  if (found) db.run('update settings set value = ? where key = ?', text, key);
  else db.run('insert into settings (key, value) values (?,?)', key, text);
  return text;
}

function allSettings(db) {
  const out = {};
  for (const row of db.all('select key, value from settings')) out[row.key] = row.value;
  return out;
}

module.exports = {
  openDatabase, ensureFirstAdmin, userCount, seedModes, SCHEMA,
  MIGRATIONS, applyMigrations, backupDatabase,
  getSetting, setSetting, allSettings, BACKUP_KEEP,
};
