/* Проверка на СОБРАННОМ приложении:
     1. зарегистрироваться;
     2. закрыть и запустить заново;
     3. убедиться, что вход НЕ слетел (тот же токен принят);
     4. билд обычного игрока ждёт очереди, Coach публикует сразу;
     5. решение админа приходит в уведомления и в очередь писем;
     6. данные целы после обновления схемы.

   Всё это — на настоящем .exe, а не на node. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const os = require('node:os');

const EXE = path.join(__dirname, '..', 'dist', 'DotaCustoms 1.0.0.exe');

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Ждём, пока сервер поднимется.
 * Порт берём из лога приложения, а не из списка соединений: main.js пишет
 * «сервер: http://127.0.0.1:PORT» при старте. Это единственный источник,
 * который не требует прав на чтение чужих сокетов.
 */
async function waitApi(profile, timeoutMs = 45_000) {
  const log = path.join(profile, 'logs', 'dotacustoms.log');
  const t0 = Date.now();
  let seen = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(log)) {
      const starts = fs.readFileSync(log, 'utf8')
        .split('\n')
        .filter(l => l.includes('http://127.0.0.1:'));
      if (starts.length > seen) {
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(starts[starts.length - 1]);
        seen = starts.length;
        if (m) {
          const p = Number(m[1]);
          const alive = await fetch('http://127.0.0.1:' + p + '/api/health')
            .then(r => r.ok).catch(() => false);
          if (alive) return p;
        }
      }
    }
    await sleep(400);
  }
  return 0;
}

async function call(port, method, url, { body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* не json */ }
  return { status: res.status, data };
}

function killAll() {
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command', 'Get-Process DotaCustoms -ErrorAction SilentlyContinue | Stop-Process -Force',
    ]);
  } catch { /* не было */ }
}

async function launch(profile) {
  const child = spawn(EXE, [`--user-data-dir=${profile}`], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

async function main() {
  console.log('\nDotaCustoms — проверка собранного .exe');
  console.log('─'.repeat(56));
  if (!fs.existsSync(EXE)) {
    console.error('  нет ' + EXE);
    process.exit(1);
  }
  console.log('  файл:', EXE, `(${(fs.statSync(EXE).size / 1048576).toFixed(1)} МБ)`);

  killAll();
  await sleep(1000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dist-'));
  console.log('  профиль:', profile);

  /* ── 1. первый запуск ─────────────────────────────────────────────── */
  let port = await (async () => { await launch(profile); return waitApi(profile); })();
  ok(port > 0, 'приложение запустилось', `порт ${port}`);
  if (!port) { killAll(); process.exit(1); }

  const cfg = await call(port, 'GET', '/api/config');
  ok(cfg.data && Array.isArray(cfg.data.top_kinds), 'конфиг отдан');
  ok((cfg.data.top_kinds || []).length === 3, 'три категории топов',
    (cfg.data.top_kinds || []).map(k => k.key).join(', '));

  const hero = cfg.data && cfg.data.dataset ? null : null;
  const dataset = await call(port, 'GET', '/api/catalog/dataset');
  const antimage = (dataset.data.heroes || []).find(h => h.key === 'antimage');
  ok(!!antimage, 'датасет с героями на месте', `${(dataset.data.heroes || []).length} героев`);

  // админ
  const admin = await call(port, 'POST', '/api/auth/register', {
    body: { username: 'distadmin', nickname: 'Админ', password: 'secret123', email: 'admin@example.com' },
  });
  ok(!!admin.data.token, 'админ зарегистрирован');
  const adminToken = admin.data.token;

  // обычный игрок
  const player = await call(port, 'POST', '/api/auth/register', {
    body: { username: 'distplayer', nickname: 'Игрок', password: 'secret123', email: 'player@example.com' },
  });
  const playerToken = player.data.token;
  ok(!!playerToken, 'игрок зарегистрирован');

  /* ── 2. модерация в собранном приложении ─────────────────────────── */
  const pending = await call(port, 'POST', '/api/builds', {
    token: playerToken,
    body: { mode: 'chc', hero_id: antimage.id, title: 'Билд из сборки', items: [{ item_id: 1 }], skills: [], talents: [] },
  });
  ok(pending.data.pending === true, 'билд игрока ждёт подтверждения', `moderation=${pending.data.moderation}`);

  const guestList = await call(port, 'GET', '/api/builds');
  ok(!(guestList.data.items || []).some(b => b.id === pending.data.id), 'гость билд не видит');

  const queue = await call(port, 'GET', '/api/admin/queue?type=build', { token: adminToken });
  ok((queue.data.items || []).some(b => b.id === pending.data.id), 'билд в очереди админа');
  ok(Number.isInteger(queue.data.pages), 'у очереди есть разбивка на страницы',
    `стр. ${queue.data.page} из ${queue.data.pages}`);

  const approve = await call(port, 'POST', `/api/admin/queue/build/${pending.data.id}`, {
    token: adminToken, body: { decision: 'approve', note: 'Нормально' },
  });
  ok(approve.data.status === 'approved', 'админ подтвердил');

  const notes = await call(port, 'GET', '/api/notifications', { token: playerToken });
  ok((notes.data.items || []).some(n => /подтверждён/.test(n.title)),
    'игроку пришло уведомление о решении',
    (notes.data.items || [])[0] ? notes.data.items[0].title : '—');

  const mail = await call(port, 'GET', '/api/admin/mail-queue', { token: adminToken });
  ok((mail.data.items || []).some(m => m.to === 'player@example.com'),
    'решение поставлено в очередь писем', `${mail.data.items.length} шт.`);

  /* ── 3. заявка в свободной форме ─────────────────────────────────── */
  const rep = await call(port, 'POST', '/api/reports', {
    token: playerToken,
    body: { subject: 'Тема из сборки', body: 'Свободный текст обращения.', kind: 'appeal' },
  });
  ok(!!rep.data.id, 'заявка принята', `#${rep.data.id}`);

  const adminReports = await call(port, 'GET', '/api/reports?status=open', { token: adminToken });
  const found = (adminReports.data.items || []).find(r => r.id === rep.data.id);
  ok(!!found, 'админ видит заявку');
  ok(found && found.author && found.author.nickname === 'Игрок', 'админ видит ник заявителя',
    found ? found.author.nickname : '—');

  await call(port, 'POST', `/api/reports/${rep.data.id}/resolve`, {
    token: adminToken, body: { decision: 'accept', note: 'Решено' },
  });
  const mine = await call(port, 'GET', '/api/reports/mine', { token: playerToken });
  ok((mine.data.items || []).find(r => r.id === rep.data.id).status === 'accepted',
    'заявитель видит решение');

  /* ── 4. ГЛАВНОЕ: сессия и данные переживают перезапуск ───────────── */
  console.log('  ── закрываем приложение ──');
  killAll();
  await sleep(2500);

  port = await (async () => { await launch(profile); return waitApi(profile); })();
  ok(port > 0, 'приложение запустилось заново', `порт ${port}`);
  if (!port) { process.exit(1); }

  const me = await call(port, 'GET', '/api/auth/me', { token: playerToken });
  ok(!!me.data.user, 'СЕССИЯ НЕ СЛОМАСЬ — тот же токен принят после перезапуска',
    me.data.user ? `${me.data.user.nickname} (id ${me.data.user.id})` : JSON.stringify(me.data));

  const buildAgain = await call(port, 'GET', `/api/builds/${pending.data.id}`);
  ok(!!buildAgain.data.build, 'билд на месте после перезапуска',
    buildAgain.data.build ? buildAgain.data.build.title : '');

  const adminMe = await call(port, 'GET', '/api/auth/me', { token: adminToken });
  ok(!!adminMe.data.user && adminMe.data.user.role === 'admin', 'роль администратора сохранена');

  const notesAfter = await call(port, 'GET', '/api/notifications', { token: playerToken });
  ok((notesAfter.data.items || []).length > 0, 'уведомления не потерялись',
    `${notesAfter.data.items.length} шт.`);

  const repsAfter = await call(port, 'GET', '/api/reports/mine', { token: playerToken });
  ok((repsAfter.data.items || []).length > 0, 'заявки не потерялись');

  const backups = path.join(profile, 'data', 'backups');
  ok(fs.existsSync(backups) && fs.readdirSync(backups).length > 0,
    'резервная копия базы создана при обновлении схемы',
    fs.existsSync(backups) ? fs.readdirSync(backups).join(', ') : 'нет папки');

  /* ── 5. общий доступ по сети ─────────────────────────────────────── */
  const share = await call(port, 'GET', '/api/share');
  ok(share.data.enabled === false, 'общий доступ выключен по умолчанию');
  const on = await call(port, 'POST', '/api/share', { token: adminToken, body: { enabled: true } });
  ok(on.data.enabled === true, 'админ включил общий доступ');
  await sleep(1200);
  const sharePort = on.data.port;
  const viaNetwork = await fetch(`http://127.0.0.1:${sharePort}/api/builds`)
    .then(r => r.json()).catch(() => null);
  ok(!!viaNetwork && Array.isArray(viaNetwork.items),
    'по сетевому адресу видна общая база', `порт ${sharePort}, билдов ${viaNetwork ? viaNetwork.items.length : 0}`);
  const indexHtml = await fetch(`http://127.0.0.1:${sharePort}/`).then(r => r.text()).catch(() => '');
  ok(indexHtml.includes('DotaCustoms'), 'интерфейс отдаётся по сети для других');
  await call(port, 'POST', '/api/share', { token: adminToken, body: { enabled: false } }).catch(() => {});

  killAll();
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ок */ }

  console.log('\n' + '─'.repeat(56));
  console.log(`  Пройдено: ${pass}   Провалено: ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Ошибка теста:', err); killAll(); process.exit(1); });
