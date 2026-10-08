/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — схема базы для PostgreSQL (Neon / Vercel)
   ──────────────────────────────────────────────────────────────────────
   Зеркало SQLite-схемы из backend/db.js с двумя отличиями:
     • `integer primary key autoincrement` → `serial primary key`;
     • все внешние ключи объявлены `deferrable` — в обычной работе это
       ничего не меняет (проверки идут немедленно), а скрипт переноса
       данных может сделать `set constraints all deferred`, чтобы вставить
       строки с самоссылками (posts.parent_id) в любом порядке.

   База колонок и индексов совпадает с SQLite — перенос строк тривиален.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const SCHEMA_PG = `
-- ══ Пользователи и роли ══════════════════════════════════════════════
create table if not exists users (
  id            serial primary key,
  username      text not null unique,
  nickname      text not null,
  password_hash text not null,
  role          text not null default 'user',
  bio           text not null default '',
  avatar        text not null default '',
  contact       text not null default '',
  is_banned     integer not null default 0,
  ban_reason    text not null default '',
  chat_ban_until   text,
  chat_ban_forever integer not null default 0,
  chat_ban_reason  text not null default '',
  created_at    text not null,
  last_seen_at  text,
  email         text not null default ''
);
create index if not exists idx_users_role on users(role);

-- области Coach: '*' = все режимы, иначе 'chc' / 'rr'
create table if not exists coach_scopes (
  user_id integer not null references users(id) on delete cascade deferrable,
  scope   text not null,
  primary key (user_id, scope)
);

create table if not exists sessions (
  token_hash text primary key,
  user_id    integer not null references users(id) on delete cascade deferrable,
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
  id           serial primary key,
  author_id    integer not null references users(id) on delete cascade deferrable,
  mode         text not null,
  hero_id      integer,
  title        text not null,
  description  text not null default '',
  stage        text not null default 'any',
  patch        text not null default '',
  difficulty   integer not null default 1,
  is_draft     integer not null default 0,
  items        text not null default '[]',
  skills       text not null default '[]',
  talents      text not null default '[]',
  neutrals     text not null default '[]',
  views        integer not null default 0,
  created_at   text not null,
  updated_at   text not null,
  verified_by  integer references users(id) on delete set null deferrable,
  verified_at  text,
  verify_note  text not null default '',
  moderation   text not null default 'approved'
);
create index if not exists idx_builds_mode  on builds(mode, is_draft, created_at desc);
create index if not exists idx_builds_hero  on builds(hero_id);
create index if not exists idx_builds_auth  on builds(author_id, created_at desc);
create index if not exists idx_builds_top   on builds(verified_at desc, created_at desc);

create table if not exists build_votes (
  build_id   integer not null references builds(id) on delete cascade deferrable,
  user_id    integer not null references users(id) on delete cascade deferrable,
  value      integer not null default 1,
  created_at text not null,
  primary key (build_id, user_id)
);
create index if not exists idx_bvotes_user on build_votes(user_id);

-- комментарии к билдам (тред без статусов)
create table if not exists build_comments (
  id          serial primary key,
  build_id    integer not null references builds(id) on delete cascade deferrable,
  author_id   integer not null references users(id) on delete cascade deferrable,
  body        text not null,
  moderation  text not null default 'approved', -- approved | pending (на проверке)
  created_at  text not null,
  edited_at   text,
  is_deleted  integer not null default 0
);
create index if not exists idx_bcomments_build on build_comments(build_id, created_at);

-- ══ Топы (герои / нейтралки / скиллы) ════════════════════════════════
create table if not exists meta_tops (
  id          serial primary key,
  author_id   integer not null references users(id) on delete cascade deferrable,
  mode        text not null,
  kind        text not null,
  title       text not null,
  description text not null default '',
  patch       text not null default '',
  is_draft    integer not null default 0,
  created_at  text not null,
  updated_at  text not null,
  verified_by integer references users(id) on delete set null deferrable,
  verified_at text,
  verify_note text not null default '',
  moderation  text not null default 'approved',
  tiers       text                        -- JSON-массив названий тиров; NULL = дефолт S…D
);
create index if not exists idx_tops_mode on meta_tops(mode, kind, is_draft, created_at desc);

create table if not exists meta_top_entries (
  id      serial primary key,
  top_id  integer not null references meta_tops(id) on delete cascade deferrable,
  rank    integer not null default 0,
  ref_id  integer not null,
  tier    text not null default '',
  note    text not null default ''
);
create index if not exists idx_entries_top on meta_top_entries(top_id, rank);
create unique index if not exists uq_entries_ref on meta_top_entries(top_id, ref_id);

create table if not exists top_votes (
  top_id     integer not null references meta_tops(id) on delete cascade deferrable,
  user_id    integer not null references users(id) on delete cascade deferrable,
  created_at text not null,
  primary key (top_id, user_id)
);

-- ══ Ветви: баги, фичи, обсуждения ════════════════════════════════════
create table if not exists threads (
  id          serial primary key,
  author_id   integer not null references users(id) on delete cascade deferrable,
  mode        text not null,
  category    text not null,
  title       text not null,
  body        text not null,
  hero_id     integer,
  patch       text not null default '',
  severity    text not null default 'medium',
  status      text not null default 'open',
  is_pinned   integer not null default 0,
  is_locked   integer not null default 0,
  is_deleted  integer not null default 0,
  views       integer not null default 0,
  created_at  text not null,
  updated_at  text not null,
  resolved_by integer references users(id) on delete set null deferrable,
  resolved_at text
);
create index if not exists idx_threads_list  on threads(is_deleted, is_pinned desc, updated_at desc);
create index if not exists idx_threads_cat   on threads(category, status, is_deleted);
create index if not exists idx_threads_mode  on threads(mode, is_deleted, updated_at desc);
create index if not exists idx_threads_auth  on threads(author_id, created_at desc);

create table if not exists posts (
  id          serial primary key,
  thread_id   integer not null references threads(id) on delete cascade deferrable,
  author_id   integer not null references users(id) on delete cascade deferrable,
  parent_id   integer references posts(id) on delete cascade deferrable,
  body        text not null,
  moderation  text not null default 'approved', -- approved | pending (на проверке)
  created_at  text not null,
  edited_at   text,
  is_deleted  integer not null default 0
);
create index if not exists idx_posts_thread on posts(thread_id, created_at);

create table if not exists thread_votes (
  thread_id   integer not null references threads(id) on delete cascade deferrable,
  user_id     integer not null references users(id) on delete cascade deferrable,
  value       integer not null default 1,
  created_at  text not null,
  primary key (thread_id, user_id)
);

create table if not exists post_votes (
  post_id     integer not null references posts(id) on delete cascade deferrable,
  user_id     integer not null references users(id) on delete cascade deferrable,
  value       integer not null default 1,
  created_at  text not null,
  primary key (post_id, user_id)
);

-- ══ Руководство для новичков ═════════════════════════════════════════
create table if not exists guides (
  id          serial primary key,
  slug        text not null unique,
  title       text not null,
  category    text not null default 'basics',
  summary     text not null default '',
  body        text not null,
  order_index integer not null default 0,
  is_official integer not null default 1,
  published   integer not null default 1,
  author_id   integer references users(id) on delete set null deferrable,
  created_at  text not null,
  updated_at  text not null
);
create index if not exists idx_guides_order on guides(published, order_index);

-- ══ Жалобы на контент ═══════════════════════════════════════════════
create table if not exists flags (
  id          serial primary key,
  reporter_id integer not null references users(id) on delete cascade deferrable,
  target_type text not null,
  target_id   integer not null,
  reason      text not null,
  details     text not null default '',
  status      text not null default 'open',
  created_at  text not null,
  resolved_by integer references users(id) on delete set null deferrable,
  resolved_at text
);
create index if not exists idx_flags_status on flags(status, created_at desc);

-- ══ Лог действий модерации ════════════════════════════════════════════
create table if not exists mod_log (
  id          serial primary key,
  actor_id    integer references users(id) on delete set null deferrable,
  action      text not null,
  target_type text not null,
  target_id   integer,
  reason      text not null default '',
  created_at  text not null
);
create index if not exists idx_modlog_time on mod_log(created_at desc);

-- ══ Настройки приложения ═════════════════════════════════════════════
create table if not exists settings (
  key   text primary key,
  value text not null default ''
);

-- ══ Уведомления (ячейка-колокольчик в шапке) ═════════════════════════
create table if not exists notifications (
  id         serial primary key,
  user_id    integer not null references users(id) on delete cascade deferrable,
  kind       text not null default 'info',
  title      text not null,
  body       text not null default '',
  link       text not null default '',
  actor_id   integer references users(id) on delete set null deferrable,
  is_read    integer not null default 0,
  created_at text not null
);
create index if not exists idx_notif_user on notifications(user_id, is_read, created_at desc);

-- ══ Ростер героев кастомных игр ═══════════════════════════════════
create table if not exists hero_rosters (
  mode       text primary key,
  keys       text not null default '[]',
  note       text not null default '',
  updated_at text not null,
  updated_by integer references users(id) on delete set null deferrable
);

-- ══ Заявления и жалобы в свободной форме ═════════════════════════════
create table if not exists reports (
  id           serial primary key,
  author_id    integer not null references users(id) on delete cascade deferrable,
  subject      text not null,
  body         text not null,
  kind         text not null default 'appeal',
  status       text not null default 'open',
  admin_note   text not null default '',
  is_anonymous integer not null default 0,
  created_at   text not null,
  resolved_by  integer references users(id) on delete set null deferrable,
  resolved_at  text,
  emailed_at   text
);
create index if not exists idx_reports_status on reports(status, created_at desc);
create index if not exists idx_reports_author on reports(author_id, created_at desc);

-- ══ Очередь писем ════════════════════════════════════════════════════
create table if not exists email_queue (
  id         serial primary key,
  to_addr    text not null,
  subject    text not null,
  body       text not null,
  status     text not null default 'pending',
  attempts   integer not null default 0,
  last_error text not null default '',
  created_at text not null,
  sent_at    text
);
create index if not exists idx_email_status on email_queue(status, created_at);

-- ══ Журнал миграций ══════════════════════════════════════════════════
create table if not exists migrations (
  id         serial primary key,
  name       text not null unique,
  applied_at text not null
);
`;

module.exports = { SCHEMA_PG };