/* Проверка: сессия должна переживать ПЕРЕЗАПУСК сервера.
   Сценарий из жалобы пользователя — «постоянно забывает меня». */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackend } = require('../backend');

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
};

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-session-'));
  console.log('\nDotaCustoms — сессия между перезапусками');
  console.log('─'.repeat(56));
  console.log('  папка данных:', dataDir);

  // ── первый запуск: регистрируемся ──────────────────────────────────
  let backend = createBackend({ dataDir });
  let srv = await backend.listen(0, '127.0.0.1');
  let base = `http://127.0.0.1:${srv.address().port}`;

  const reg = await (await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'persister', nickname: 'Тестовый', password: 'secret123' }),
  })).json();
  ok(!!reg.token, 'регистрация выдала токен');
  const token = reg.token;
  const userId = reg.user && reg.user.id;

  const me1 = await (await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  ok(!!me1.user, 'токен работает сразу после выдачи');

  // ── закрываем сервер, поднимаем заново на ТОЙ ЖЕ папке ──────────────
  backend.close();
  console.log('  ── сервер остановлен, база закрыта ──');

  backend = createBackend({ dataDir });
  srv = await backend.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${srv.address().port}`;
  console.log(`  ── сервер поднят заново на порту ${srv.address().port} ──`);

  // Ключевая проверка: тот же токен после перезапуска
  const me2 = await (await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  ok(!!me2.user, 'ТОТ ЖЕ токен принят после перезапуска',
    me2.user ? `${me2.user.nickname} (id ${me2.user.id})` : JSON.stringify(me2));

  // И заодно логин по паролю после перезапуска
  const login = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'persister', password: 'secret123' }),
  })).json();
  ok(!!login.token, 'вход по паролю после перезапуска');

  // Секрет действительно лежит в базе и не меняется
  const db = backend.db;
  const s1 = db.get("select value from settings where key = 'token_secret'");
  ok(!!s1 && s1.value.length >= 32, 'секрет сохранён в таблице settings');

  backend.close();
  backend = createBackend({ dataDir });
  const s2 = backend.db.get("select value from settings where key = 'token_secret'");
  ok(!!s2 && s2.value === s1.value, 'секрет не меняется между запусками');
  backend.close();

  // ── данные переживают перезапуск ────────────────────────────────────
  backend = createBackend({ dataDir });
  srv = await backend.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${srv.address().port}`;

  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const hero = backend.dataset.heroes.find(h => h.key === 'antimage');
  const build = await (await fetch(`${base}/api/builds`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      mode: 'chc', hero_id: hero.id, title: 'Билд до перезапуска',
      items: [{ item_id: 1 }], skills: [], talents: [],
    }),
  })).json();
  ok(!!build.id, 'билд создан', '#' + build.id);
  backend.close();

  backend = createBackend({ dataDir });
  srv = await backend.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${srv.address().port}`;
  const again = await (await fetch(`${base}/api/builds/${build.id}`)).json();
  ok(!!again.build, 'билд на месте после перезапуска', again.build && again.build.title);

  const me3 = await (await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  ok(!!me3.user && me3.user.id === userId, 'и после второго перезапуска сессия жива');

  // ── миграция идемпотентна ───────────────────────────────────────────
  const mCount = backend.db.get('select count(*) c from migrations').c;
  ok(mCount >= 1, 'миграции записаны в журнал', 'записей: ' + mCount);
  backend.close();
  backend = createBackend({ dataDir });
  const mCount2 = backend.db.get('select count(*) c from migrations').c;
  ok(mCount2 === mCount, 'повторный запуск не дублирует миграции');
  backend.close();

  // ── бэкапы ─────────────────────────────────────────────────────────
  const backups = path.join(dataDir, 'backups');
  const files = fs.existsSync(backups) ? fs.readdirSync(backups) : [];
  ok(files.length > 0, 'резервная копия базы создана', files.join(', ') || 'нет');
  if (files.length) {
    const copy = path.join(backups, files[0]);
    ok(fs.statSync(copy).size > 1000, 'копия не пустая',
      Math.round(fs.statSync(copy).size / 1024) + ' КБ');
  }
  backend.close();

  console.log('\n' + '─'.repeat(56));
  console.log(`  Пройдено: ${pass}   Провалено: ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Ошибка теста:', err); process.exit(1); });
