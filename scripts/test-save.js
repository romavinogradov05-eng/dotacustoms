/* Проверка ЖАЛОБЫ «не сохраняешь бд» через настоящий интерфейс.
   Сценарий как у человека: зарегистрировался → собрал билд → опубликовал →
   закрыл программу → открыл снова. Билд и.top сверяются напрямую в файле
   базы, а не по ответу API: иначе «сохранилось» ничего не значит.

   Участвуют два пользователя, потому что правила модерации разные:
     • первый зарегистрированный — админ, его контент выходит сразу;
     • второй — обычный игрок, его контент ждёт подтверждения.
   Если оба контента в одном тесте не различить, проверка модерации
   ничего не говорит. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Database } = require('node-sqlite3-wasm');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;

let pass = 0;
let fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  \u2713 ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  \u2717 ${label}${extra ? ' — ' + extra : ''}`); }
};
const say = s => console.log(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function killAll() {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Process electron,DotaCustoms -ErrorAction SilentlyContinue | Stop-Process -Force']);
  } catch { /* не было */ }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('CDP не подключился')));
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    });
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function findPage() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && /app[/\\]index\.html/.test(t.url || ''));
      if (page) return page;
    } catch { /* Electron ещё поднимается */ }
    await sleep(500);
  }
  throw new Error('окно не появилось');
}

function launch(profile) {
  const bin = path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(bin, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  child.unref();
}

async function waitFor(cdp, expr, label) {
  for (let i = 0; i < 80; i++) {
    try { if (await evaluate(cdp, expr)) return; } catch { /* ещё нет */ }
    await sleep(400);
  }
  throw new Error('не дождались: ' + label);
}

/**
 * Читаем базу напрямую с диска — мимо API.
 * node-sqlite3-wasm берёт каталог `<база>.lock` даже при readOnly и снимает
 * его только при штатном закрытии; тест закрывает принудительно, поэтому
 * снимаем каталог так же, как это делает штатный openDatabase.
 */
function query(dbFile, fn) {
  const lock = dbFile + '.lock';
  if (fs.existsSync(lock)) {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* не смогли */ }
  }
  const db = new Database(dbFile, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

async function main() {
  say('\nDotaCustoms — сохранение данных (живой интерфейс + чтение с диска)');
  say('─'.repeat(58));

  killAll();
  await sleep(1200);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-save-'));
  const dbFile = path.join(profile, 'data', 'dotacustoms.db');
  const SUF = String(Date.now()).slice(-6);
  const ADMIN = 'adm' + SUF;
  const PLAYER = 'ply' + SUF;
  const T1 = 'Билд админа ' + SUF;      // публикуется сразу
  const T2 = 'Билд игрока ' + SUF;     // ждёт подтверждения
  const TOP = 'Топ игрока ' + SUF;     // тоже ждёт

  /* ══ сессия 1: оба пользователя создают контент ══ */
  launch(profile);
  let cdp = await connect((await findPage()).webSocketDebuggerUrl);
  await waitFor(cdp, '!!(window.store && store.heroes.length)', 'справочник');
  say('  renderer поднялся');

  const setup = await evaluate(cdp, `(async () => {
    const out = {};
    // 1. Админ: первый в пустой базе становится администратором
    let r = await api.post('/auth/register', { body: {
      username: '${ADMIN}', nickname: 'Админ', password: 'secret123' } });
    if (!r.ok) return { fail: 'регистрация админа: ' + (r.data && r.data.error) };
    api.setToken(r.data.token);
    await store.restoreSession();
    out.adminRole = store.me.role;

    const h = store.heroes.find(x => x.key === 'antimage');
    r = await api.post('/builds', { body: {
      mode: 'chc', hero_id: h.id, title: '${T1}', stage: 'any',
      items: [{ item_id: 1 }], skills: [], talents: [],
    }});
    out.buildAdmin = { ok: r.ok, id: r.data && r.data.id, moderation: r.data && r.data.moderation };

    // 2. Обычный игрок: его контент должен ждать
    r = await api.post('/auth/register', { body: {
      username: '${PLAYER}', nickname: 'Игрок', password: 'secret123' } });
    if (!r.ok) return { fail: 'регистрация игрока: ' + (r.data && r.data.error) };
    api.setToken(r.data.token);
    await store.restoreSession();
    out.playerRole = store.me.role;

    r = await api.post('/builds', { body: {
      mode: 'chc', hero_id: h.id, title: '${T2}', stage: 'any',
      items: [{ item_id: 2 }], skills: [], talents: [],
    }});
    out.buildPlayer = { ok: r.ok, id: r.data && r.data.id, moderation: r.data && r.data.moderation };

    const refs = store.heroes.slice(0, 5).map(x => x.id);
    r = await api.post('/tops', { body: {
      mode: 'chc', kind: 'heroes', title: '${TOP}',
      entries: refs.map((ref_id, i) => ({ ref_id, rank: i + 1, tier: ['S', 'S', 'A', 'B', ''][i] })),
    }});
    out.top = { ok: r.ok, id: r.data && r.data.id, moderation: r.data && r.data.moderation };
    // 3. Билд ВООБЩЕ без героя: в CHC и Ratten Run героя назначает игра,
    //    и такой билд — обычное дело. Если бы сервер требовал hero_id,
    //    он бы просто не сохранился.
    r = await api.post('/auth/login', { body: {
      username: '${ADMIN}', nickname: 'Админ', password: 'secret123' } });
    api.setToken(r.data.token);
    await store.restoreSession();
    r = await api.post('/builds', { body: {
      mode: 'chc', title: '${T1} без героя', stage: 'any',
      items: [{ item_id: 3 }], skills: [], talents: [],
    }});
    out.buildNoHero = { ok: r.ok, id: r.data && r.data.id,
      hero: r.data && r.data.hero_id, err: r.data && r.data.error };

    // 4. Ростер режима — тоже в базе, проверяем после перезапуска.
    const keys = store.heroes.slice(0, 2).map(x => x.key);
    r = await api.post('/rosters/rr', { body: { keys, note: 'из теста' } });
    out.roster = { ok: r.ok, keys: r.data && r.data.roster && r.data.roster.keys,
      err: r.data && r.data.error };
    out.rosterKeys = keys;
    return out;
  })()`);

  ok(!setup.fail, 'оба пользователя зарегистрированы', setup.fail || '');
  ok(setup.adminRole === 'admin', 'первый стал админом', setup.adminRole);
  ok(setup.playerRole === 'user', 'второй — обычный игрок', setup.playerRole);
  ok(setup.buildAdmin.ok && setup.buildAdmin.moderation === 'approved',
    'билд админа ушёл сразу', setup.buildAdmin.moderation);
  ok(setup.buildPlayer.ok && setup.buildPlayer.moderation === 'pending',
    'билд игрока ждёт подтверждения', setup.buildPlayer.moderation);
  ok(setup.top.ok && setup.top.moderation === 'pending',
    'топ игрока ждёт подтверждения', setup.top.moderation);
  ok(setup.buildNoHero.ok && setup.buildNoHero.hero == null,
    'билд без героя сохраняется — герой не обязателен',
    setup.buildNoHero.err || ('id ' + setup.buildNoHero.id + ', hero_id ' + setup.buildNoHero.hero))

  /* ══ файл базы, приложение закрыто ══ */
  cdp.close();
  killAll();
  await sleep(2500);

  ok(fs.existsSync(dbFile), 'файл базы создан', path.basename(dbFile));
  const size1 = fs.statSync(dbFile).size;
  ok(size1 > 50_000, 'база непустая', Math.round(size1 / 1024) + ' КБ');

  const disk1 = query(dbFile, db => ({
    noHero: db.all('select id, title, hero_id from builds where title = ?', [T1 + ' без героя']),
    rosters: db.all('select mode, keys from hero_rosters'),
    b1: db.all('select id, title, moderation, hero_id from builds where title = ?', [T1]),
    b2: db.all('select id, title, moderation from builds where title = ?', [T2]),
    top: db.all('select id, title, moderation from meta_tops where title = ?', [TOP]),
    entries: db.all('select tier from meta_top_entries order by rank').map(x => x.tier),
  }));
  ok(disk1.b1.length === 1 && disk1.b1[0].moderation === 'approved',
    'БИЛД АДМИНА В ФАЙЛЕ', disk1.b1.length ? 'id ' + disk1.b1[0].id + ', ' + disk1.b1[0].moderation : 'НЕ НАЙДЕН');
  ok(disk1.b2.length === 1 && disk1.b2[0].moderation === 'pending',
    'БИЛД ИГРОКА В ФАЙЛЕ, ждёт', disk1.b2.length ? 'id ' + disk1.b2[0].id + ', ' + disk1.b2[0].moderation : 'НЕ НАЙДЕН');
  ok(disk1.top.length === 1, 'ТОП В ФАЙЛЕ', disk1.top.length ? 'id ' + disk1.top[0].id : 'НЕ НАЙДЕН');
  // Жалоба была «персонажи в создании билдов не должны быть + не
  // сохраняешь бд» — проверяем обе половины: hero_id обязан лежать в
  // файле, а билд без героя обязан сохраняться.
  const heroRow = disk1.b1[0];
  ok(heroRow && heroRow.hero_id > 0, 'ГЕРОЙ СОХРАНИЛСЯ В ФАЙЛЕ',
    heroRow ? 'hero_id = ' + heroRow.hero_id : 'БИЛД НЕ НАЙДЕН');
  ok(disk1.noHero.length === 1 && disk1.noHero[0].hero_id === null,
    'билд без героя лёг в файл с пустым hero_id',
    JSON.stringify(disk1.noHero));
  ok(disk1.rosters.length === 1 && disk1.rosters[0].mode === 'rr',
    'ростер режима записан в базу',
    JSON.stringify(disk1.rosters));
  const savedKeys = disk1.rosters.length ? JSON.parse(disk1.rosters[0].keys) : null;
  ok(JSON.stringify(savedKeys) === JSON.stringify(setup.rosterKeys),
    'в ростере именно заданные герои', JSON.stringify(savedKeys));
  ok(disk1.entries.length === 5, 'позиции топа записаны',
    disk1.entries.length + ' шт., тиры: ' + disk1.entries.join(','));

  /* ══ сессия 2: тот же профиль, другой запуск ══ */
  launch(profile);
  cdp = await connect((await findPage()).webSocketDebuggerUrl);
  await waitFor(cdp, '!!(window.store && store.heroes.length)', 'перезапуск');
  say('  ── запустили заново ──');

  const session = await evaluate(cdp, `(async () => {
    api.setToken(null);
    const guestList = await api.get('/builds');
    const guestIds = (guestList.data && guestList.data.items || []).map(x => x.id);
    return {
      adminVisible: guestIds.includes(${setup.buildAdmin.id}),
      playerVisible: guestIds.includes(${setup.buildPlayer.id}),
    };
  })()`);
  ok(session.adminVisible, 'после перезапуска гость видит подтверждённый билд');

  const after2 = await evaluate(cdp, `(async () => {
    const cfg = await api.get('/config');
    const b = await api.get('/builds/${setup.buildAdmin.id}');
    const hero = b.data && b.data.build && b.data.build.hero_id;
    return {
      roster: cfg.data && cfg.data.rosters && cfg.data.rosters.rr,
      visible: store.heroesFor('rr').length,
      hero, heroName: hero ? (store.heroById.get(Number(hero)) || {}).name : null,
    };
  })()`);
  ok(JSON.stringify(after2.roster) === JSON.stringify(setup.rosterKeys),
    'ростер пережил перезапуск', JSON.stringify(after2.roster));
  ok(after2.visible === setup.rosterKeys.length,
    'в выборе героя после перезапуска ровно ростер',
    after2.visible + ' героев');
  ok(after2.hero > 0 && !!after2.heroName,
    'герой билда виден после перезапуска',
    after2.hero + ' = ' + after2.heroName);
  ok(!session.playerVisible, 'неподтверждённый билд гостю не показан — как и задумано');

  // Автор видит свой неподтверждённый билд — иначе «пропал»
  const author = await evaluate(cdp, `(async () => {
    const r = await api.post('/auth/login', { body: { username: '${PLAYER}', password: 'secret123' } });
    api.setToken(r.data.token);
    await store.restoreSession();
    const b = await api.get('/builds/${setup.buildPlayer.id}');
    return { status: b.status, title: b.data && b.data.build && b.data.build.title,
             moderation: b.data && b.data.build && b.data.build.moderation };
  })()`);
  ok(author.status === 200, 'автор видит свой ждущий билд', 'HTTP ' + author.status);
  ok(author.title === T2, 'название сохранилось', String(author.title));
  ok(author.moderation === 'pending', 'и понимает, что он ждёт подтверждения', author.moderation);

  // Админ подтверждает — и билд появляется у всех
  const after = await evaluate(cdp, `(async () => {
    const l = await api.post('/auth/login', { body: { username: '${ADMIN}', password: 'secret123' } });
    api.setToken(l.data.token);
    const a = await api.post('/admin/queue/build/${setup.buildPlayer.id}', { body: { decision: 'approve' } });
    api.setToken(null);
    const list = await api.get('/builds');
    return { approved: a.data && a.data.status,
             visible: (list.data && list.data.items || []).map(x => x.id).includes(${setup.buildPlayer.id}) };
  })()`);
  ok(after.approved === 'approved', 'админ подтвердил билд игрока', after.approved);
  ok(after.visible, 'после подтверждения билд видно гостю');

  // Правка поверх
  await evaluate(cdp, `(async () => {
    const l = await api.post('/auth/login', { body: { username: '${ADMIN}', password: 'secret123' } });
    api.setToken(l.data.token);
    await api.patch('/builds/${setup.buildAdmin.id}', { body: { title: '${T1} v2' } });
    return true;
  })()`);

  /* ══ снова диск ══ */
  cdp.close();
  killAll();
  await sleep(2500);

  const disk2 = query(dbFile, db => ({
    b1: db.all('select id, title, moderation from builds where id = ?', [setup.buildAdmin.id]),
    b2: db.all('select id, title, moderation from builds where id = ?', [setup.buildPlayer.id]),
    counts: {
      users: db.get('select count(*) c from users').c,
      builds: db.get('select count(*) c from builds').c,
      tops: db.get('select count(*) c from meta_tops').c,
      entries: db.get('select count(*) c from meta_top_entries').c,
      guides: db.get('select count(*) c from guides').c,
      notifications: db.get('select count(*) c from notifications').c,
      rosters: db.get('select count(*) c from hero_rosters').c,
    },
  }));
  ok(disk2.b1.length && disk2.b1[0].title === T1 + ' v2',
    'правка дошла до файла', disk2.b1.length ? disk2.b1[0].title : 'НЕ НАЙДЕН');
  ok(disk2.b2.length && disk2.b2[0].moderation === 'approved',
    'подтверждение админа записано', disk2.b2.length ? disk2.b2[0].moderation : '');

  say('  содержимое базы: ' + JSON.stringify(disk2.counts));
  ok(disk2.counts.users === 2 && disk2.counts.builds === 3 && disk2.counts.tops === 1
    && disk2.counts.entries === 5 && disk2.counts.guides >= 7,
    'все сущности на месте');
  ok(disk2.counts.notifications >= 2, 'уведомления записаны', disk2.counts.notifications + ' шт.');

  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ок */ }

  say('\n' + '─'.repeat(58));
  say(`  Пройдено: ${pass}   Провалено: ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error('Ошибка теста:', err.message); killAll(); process.exit(1); });
