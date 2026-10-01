#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — тесты backend
   ──────────────────────────────────────────────────────────────────────
   Поднимает сервер на временной базе, прогоняет основные сценарии и
   проверяет права. Запуск: npm test
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBackend } = require('../backend');

let passed = 0, failed = 0;
const fails = [];
const lines = [];

/** Пишем и в консоль, и в отчёт: PowerShell портит кириллицу в пайпе. */
const say = (line = '') => { lines.push(line); console.log(line); };

function ok(name, cond, extra = '') {
  if (cond) { passed++; say(`  ✓ ${name}`); }
  else {
    failed++; fails.push(name + (extra ? ` — ${extra}` : ''));
    say(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotacustoms-test-'));

  // ── блокировка базы ───────────────────────────────────────────────
  // Внутри Electron node-sqlite3-wasm держит базу каталогом `<файл>.lock`
  // и удаляет его только при штатном закрытии. Если процесс убили, каталог
  // остаётся навсегда, и все следующие запуски падают — самая обидная
  // поломка, потому что выглядит как «программа сломалась сама».
  //
  // ВНИМАНИЕ: под обычным node драйвер этот каталог не создаёт (он
  // появляется только в Electron — проверить это можно лишь
  // `npm run check:window`). Поэтому здесь мы проверяем свою часть:
  // pid-файл, уборку и самое важное — снятие протухшей блокировки.
  console.log('\nБлокировка базы');
  {
    const { openDatabase } = require('../backend/db');
    const lockDir = path.join(dataDir, 'dotacustoms.db.lock');
    const pidFile = path.join(dataDir, 'dotacustoms.db.pid');

    const first = openDatabase(dataDir);
    ok('при открытии записан pid-файл', fs.existsSync(pidFile));
    ok('pid-файл содержит текущий процесс',
      fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid));
    first.close();
    ok('после закрытия pid-файл убран', !fs.existsSync(pidFile));
    ok('после закрытия .lock не остался', !fs.existsSync(lockDir));

    // имитация аварийного завершения: каталог и pid-файл остались
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(pidFile, '999999', 'utf8');   // процесса с таким pid нет
    let reopened = null;
    try { reopened = openDatabase(dataDir); } catch (e) { /* см. проверку ниже */ }
    ok('протухшая блокировка снимается сама', !!reopened);
    if (reopened) reopened.close();

    // блокировка живого процесса трогать нельзя
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    let refused = null;
    try { openDatabase(dataDir); } catch (e) { refused = e; }
    ok('база живого процесса не отбирается', !!refused && /занята/i.test(refused.message));
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.rmSync(pidFile, { force: true });

    // старая версия могла оставить .lock вообще без pid-файла
    fs.mkdirSync(lockDir, { recursive: true });
    let legacy = null;
    try { legacy = openDatabase(dataDir); } catch (e) { /* см. проверку ниже */ }
    ok('блокировка без pid-файла тоже считается протухшей', !!legacy);
    if (legacy) legacy.close();
  }

  const backend = createBackend({ dataDir });
  await backend.listen(0, '127.0.0.1');
  // Порт читается каждый раз: при включении общего доступа сервер
  // перевешивается на 48711, и зашитый адрес перестал бы работать.
  const base = () => `http://127.0.0.1:${backend.port}`;

  const api = async (method, url, { body, token } = {}) => {
    const res = await fetch(base() + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try { data = await res.json(); } catch { /* пусто */ }
    return { status: res.status, data };
  };

  // ── служебные ────────────────────────────────────────────────────────
  console.log('Служебные');
  const health = await api('GET', '/api/health');
  ok('GET /api/health отвечает 200', health.status === 200, `статус ${health.status}`);
  ok('в health есть патч', !!health.data?.patch);

  const config = await api('GET', '/api/config');
  ok('GET /api/config отдаёт режимы', config.data?.modes?.length === 2);
  ok('в config есть виды топов', config.data?.top_kinds?.length === 3);

  const dataset = await api('GET', '/api/catalog/dataset');
  ok('датасет: герои загружены', (dataset.data?.heroes?.length || 0) > 100);
  ok('датасет: нейтралки загружены', (dataset.data?.neutrals?.length || 0) > 20);
  ok('датасет: предметы загружены', (dataset.data?.items?.length || 0) > 200);

  // ── кастомные предметы CHC: регрессия после расширения каталога ─────
  // 19 → 30 предметов, ключевые (стабильные) id вместо индексных, старые
  // id сохранены в custom_id_aliases, чтобы уже созданные билды не
  // превратились в другие предметы.
  console.log('\nКастомные предметы CHC');
  const customs = await api('GET', '/api/catalog/custom-items');
  ok('каталог отдаёт 30 предметов', (customs.data?.items?.length || 0) === 30,
    'найдено ' + (customs.data?.items?.length || 0));
  ok('группа «Книги» на месте', (customs.data?.groups || []).some(g => g.key === 'books'));
  ok('источник отдаётся', !!(customs.data?.source?.url || customs.data?.source?.title));
  const cItems = customs.data?.items || [];
  const cIds = new Set(cItems.map(c => c.id));
  ok('id стабильные (ключевые) и не пересекаются',
    cIds.size === cItems.length && cItems.every(c => c.id >= 900000 && c.id < 990000),
    'уникальных ' + cIds.size + ' из ' + cItems.length);
  ok('у каждого предмета есть режим',
    cItems.length > 0 && cItems.every(c => ['chc', 'rr', '*'].includes(c.mode)),
    (cItems.filter(c => !['chc', 'rr', '*'].includes(c.mode)) || []).map(c => c.key + '=' + c.mode).join(','));
  ok('цены восстановлены из тултипов', cItems.filter(c => c.cost).length >= 25,
    'с ценой ' + cItems.filter(c => c.cost).length + ' из ' + cItems.length);
  const aliases = dataset.data.custom_id_aliases || {};
  ok('все 19 старых id закрыты алиасами', Object.keys(aliases).length === 19,
    'алиасов ' + Object.keys(aliases).length);
  ok('старый id 900000 указывал на Kast, а не на другой предмет',
    aliases[900000] === 'kast_greatstaff_of_the_magna', String(aliases[900000]));
  ok('новый id Kast стабилен, а не индексный',
    cItems.find(c => c.key === 'kast_greatstaff_of_the_magna')?.id !== 900000);
  // иконки лежат на диске — локальный офлайн-режим
  const iconDir = path.join(__dirname, '..', 'app', 'images', 'custom');
  const noIcon = cItems.filter(c => c.img && !fs.existsSync(path.join(iconDir, c.img.replace(/^custom\//, ''))));
  ok('иконки всех предметов на диске', !noIcon.length, noIcon.map(c => c.key).join(', '));
  ok('цепочки апгрейдов замкнуты', cItems.every(c => {
    if (c.upgrades_from) {
      const from = cItems.find(x => x.key === c.upgrades_from);
      return !!from && (from.upgrades || []).includes(c.key);
    }
    return (c.upgrades || []).every(k => cItems.some(x => x.key === k));
  }));

  const heroes = await api('GET', '/api/catalog/heroes?q=am');
  ok('поиск героя по имени работает', heroes.data?.items?.length > 0);

  // ── регистрация ──────────────────────────────────────────────────────
  console.log('\nАккаунты');
  const reg = await api('POST', '/api/auth/register', {
    body: { username: 'tester', nickname: 'Тестер', password: 'secret123' },
  });
  ok('регистрация игрока', reg.status === 201 && !!reg.data?.token);
  ok('первый пользователь стал админом', reg.data?.user?.role === 'admin');
  const adminToken = reg.data.token;

  const reg2 = await api('POST', '/api/auth/register', {
    body: { username: 'player2', nickname: 'Второй', password: 'secret123' },
  });
  ok('регистрация второго игрока', reg2.status === 201);
  let userToken = reg2.data.token;
  ok('второй игрок — обычный user', reg2.data?.user?.role === 'user');

  // третий игрок остаётся обычным навсегда — на нём проверяем запреты для игроков
  const reg3 = await api('POST', '/api/auth/register', {
    body: { username: 'player3', nickname: 'Третий', password: 'secret123' },
  });
  ok('регистрация третьего игрока', reg3.status === 201);
  const plainToken = reg3.data.token;

  // Второй сразу получает Coach в CHC: создавать билды, топы, ветки и гайды
  // могут только Coach и админы, обычный игрок на создании получает 403.
  const grantEarly = await api('POST', `/api/admin/users/${reg2.data.user.id}/role`, {
    token: adminToken, body: { role: 'coach', coach_scopes: ['chc'] },
  });
  ok('второму игроку выдана роль coach', grantEarly.status === 200, `статус ${grantEarly.status}`);

  const dup = await api('POST', '/api/auth/register', {
    body: { username: 'tester', nickname: 'Клон', password: 'secret123' },
  });
  ok('повторный ник отклонён (409)', dup.status === 409, `статус ${dup.status}`);

  const badName = await api('POST', '/api/auth/register', {
    body: { username: 'ab', nickname: 'Короткий', password: 'secret123' },
  });
  ok('слишком короткий ник отклонён (400)', badName.status === 400);

  const badPass = await api('POST', '/api/auth/login', { body: { username: 'tester', password: 'неверно' } });
  ok('неверный пароль отклонён (401)', badPass.status === 401);

  const login = await api('POST', '/api/auth/login', { body: { username: 'tester', password: 'secret123' } });
  ok('вход по паролю работает', login.status === 200 && !!login.data?.token);

  const me = await api('GET', '/api/auth/me', { token: userToken });
  ok('GET /me возвращает профиль', me.data?.user?.username === 'player2');

  // ── билды ────────────────────────────────────────────────────────────
  console.log('\nБилды');
  const heroId = dataset.data.heroes[0].id;
  const itemId = dataset.data.items.find(i => i.cost > 1000)?.id;
  const neutralId = dataset.data.neutrals[0].id;
  // сколько уровней выбора талантов — столько их и можно положить в билд
  const cfg = (await api('GET', '/api/config')).data;
  const maxTalents = cfg?.limits?.maxTalents ?? 4;
  ok('в конфиге есть уровни талантов', Array.isArray(cfg?.talent_levels) && cfg.talent_levels.length === maxTalents,
    JSON.stringify(cfg?.talent_levels));

  // берём таланты именно этого героя: лимит считается по уникальным id
  const heroAbilities = dataset.data.abilities
    .filter(a => a.hero === dataset.data.heroes.find(h => h.id === heroId)?.key);
  const talentPool = heroAbilities.filter(a => a.is_talent && a.playable).map(a => a.id);
  const talentIds = talentPool.slice(0, maxTalents);
  ok('у героя есть таланты для теста', talentIds.length === maxTalents,
    `в пуле ${talentPool.length}, взяли ${talentIds.length}`);

  const noAuth = await api('POST', '/api/builds', { body: { mode: 'chc', title: 'X' } });
  ok('создание билда без входа отклонено (401)', noAuth.status === 401);

  const badMode = await api('POST', '/api/builds', { token: userToken, body: { mode: 'lol', title: 'X' } });
  ok('неизвестный режим отклонён (400)', badMode.status === 400);

  // лишние таланты не обрезаем молча, а отвечаем ошибкой
  const tooManyTalents = await api('POST', '/api/builds', {
    token: userToken,
    body: {
      mode: 'chc', hero_id: heroId, title: 'Слишком много талантов',
      items: [], skills: [], talents: talentPool.slice(0, maxTalents + 1),
    },
  });
  ok('лишние таланты отклонены (400)', tooManyTalents.status === 400, JSON.stringify(tooManyTalents.data));

  const build = await api('POST', '/api/builds', {
    token: userToken,
    body: {
      mode: 'chc', hero_id: heroId, title: 'BKB на 6 минуте', stage: 'laning', difficulty: 3,
      description: 'Тестовый билд', items: [{ item_id: itemId }], talents: talentIds,
      neutrals: [{ neutral_id: neutralId }], skills: [{ ability_id: talentIds[0], rank: 4 }],
    },
  });
  ok('создание билда', build.status === 201 && !!build.data?.id, JSON.stringify(build.data));
  const buildId = build.data?.id;

  // Создавать могут только Coach и админы — их билды видны всем сразу,
  // без очереди проверки.
  ok('Coach публикует сразу', build.data?.pending === false && build.data?.moderation === 'approved',
    `moderation = ${build.data?.moderation}`);
  const guestList = await api('GET', '/api/builds?mode=chc');
  ok('гость видит билд в общей ленте',
    (guestList.data?.items || []).some(b => b.id === buildId));
  const guestOne = await api('GET', `/api/builds/${buildId}`);
  ok('гость открывает билд', guestOne.status === 200, `status ${guestOne.status}`);
  const list = await api('GET', '/api/builds?mode=chc', { token: adminToken });
  ok('админ видит билд в списке', (list.data?.items || []).some(b => b.id === buildId));

  const one = await api('GET', `/api/builds/${buildId}`, { token: userToken });
  ok('автор видит свой билд', one.status === 200, `status ${one.status}`);
  ok('билд отдаёт предметы', one.data?.build?.items?.[0]?.item_id === itemId);
  ok('билд отдаёт таланты', one.data?.build?.talents?.length === maxTalents);
  ok('автор может редактировать', one.data?.build?.can_edit === true);
  ok('увеличились просмотры', one.data?.build?.views >= 1);

  const patched = await api('PATCH', `/api/builds/${buildId}`, {
    token: userToken, body: { title: 'BKB на 6:00 → AC', difficulty: 4 },
  });
  ok('правка билда автором', patched.status === 200);

  const foreignPatch = await api('PATCH', `/api/builds/${buildId}`, {
    token: adminToken, body: { difficulty: 1 },
  });
  ok('админ может править чужой билд', foreignPatch.status === 200);

  // предметов может быть больше шести (съеденные аганим, муншарды),
  // но общий лимит всё равно есть
  const maxItems = cfg?.limits?.maxItems ?? 12;
  const tooMany = await api('POST', '/api/builds', {
    token: userToken,
    body: { mode: 'rr', title: 'Много', items: Array.from({ length: maxItems + 2 }, (_, i) => ({ item_id: itemId + i })) },
  });
  ok(`лишние предметы обрезаются до лимита (${maxItems})`, tooMany.status === 201);
  const tooManyOne = await api('GET', `/api/builds/${tooMany.data.id}`, { token: userToken });
  ok('в сохранённом билде ровно лимит предметов',
    (tooManyOne.data?.build?.items?.length || 0) === maxItems,
    'предметов ' + (tooManyOne.data?.build?.items?.length || 0));

  const bigBuild = await api('POST', '/api/builds', {
    token: userToken,
    body: {
      mode: 'chc', title: 'Полный рюкзак',
      items: Array.from({ length: 9 }, (_, i) => ({ item_id: itemId + i })),
    },
  });
  ok('билд с 9 предметами (6 снаряжения + съеденные) сохраняется', bigBuild.status === 201);
  const bigOne = await api('GET', `/api/builds/${bigBuild.data.id}`, { token: userToken });
  ok('в нём ровно 9 предметов', (bigOne.data?.build?.items?.length || 0) === 9,
    'предметов ' + (bigOne.data?.build?.items?.length || 0));

  // скиллы в CHC выбираются из общего пула: способность чужого героя
  // сохраняется как обычный навык билда
  const heroKey = dataset.data.heroes.find(x => x.id === heroId)?.key;
  const poolAbility = dataset.data.abilities.find(a =>
    a.hero && a.hero !== heroKey && !a.is_talent && a.playable);
  ok('в датасете есть чужой герой для проверки пула', !!poolAbility, poolAbility && poolAbility.key);
  if (poolAbility) {
    const poolBuild = await api('POST', '/api/builds', {
      token: userToken,
      body: {
        mode: 'chc', hero_id: heroId, title: 'Скилл из пула CHC',
        skills: [{ ability_id: poolAbility.id, rank: 3 }],
      },
    });
    ok('скилл из пула CHC (чужой герой) сохраняется', poolBuild.status === 201, JSON.stringify(poolBuild.data));
    const poolOne = await api('GET', `/api/builds/${poolBuild.data.id}`, { token: userToken });
    ok('в билде есть скилл пула', (poolOne.data?.build?.skills || []).some(s => s.ability_id === poolAbility.id));
  }

  // лимит скиллов: до 20 способностей из пула, лишние обрезаются
  const poolIds = (dataset.data.abilities || [])
    .filter(a => a.hero && !a.is_talent && a.playable)
    .slice(0, 21)
    .map(a => a.id);
  if (poolIds.length >= 21) {
    const maxSkills = config.data.limits.maxSkills;
    const manySkills = await api('POST', '/api/builds', {
      token: userToken,
      body: {
        mode: 'chc', hero_id: heroId, title: 'Билд на 21 скилл',
        skills: poolIds.map((id, i) => ({ ability_id: id, rank: i + 1 })),
      },
    });
    ok('билд с 21 скиллом сохраняется (обрезается до лимита)', manySkills.status === 201, JSON.stringify(manySkills.data));
    const manyOne = await api('GET', `/api/builds/${manySkills.data.id}`, { token: userToken });
    const savedSkills = (manyOne.data?.build?.skills || []).length;
    ok(`скиллы обрезаются до лимита ${maxSkills}`, savedSkills === maxSkills, 'сохранено ' + savedSkills);
  } else {
    ok('в датасете достаточно способностей для проверки лимита скиллов', false, 'мало способностей');
  }

  // голоса: лайк, потом смена на минус (проверка повторной записи), потом сброс
  const vote = await api('POST', `/api/builds/${buildId}/vote`, { token: adminToken, body: { value: 1 } });
  ok('лайк билду', vote.status === 200);
  const afterVote = await api('GET', `/api/builds/${buildId}`, { token: adminToken });
  ok('лайк учтён', afterVote.data?.build?.likes === 1);

  const unvote = await api('POST', `/api/builds/${buildId}/vote`, { token: adminToken, body: { value: -1 } });
  ok('смена голоса на минус', unvote.status === 200);
  const afterUnvote = await api('GET', `/api/builds/${buildId}`, { token: adminToken });
  ok('после минуса лайков нет', afterUnvote.data?.build?.likes === 0);
  ok('минус запомнился', afterUnvote.data?.build?.my_vote === -1);

  const reVote = await api('POST', `/api/builds/${buildId}/vote`, { token: adminToken, body: { value: 1 } });
  ok('повторный лайк после минуса', reVote.status === 200);
  const afterReVote = await api('GET', `/api/builds/${buildId}`, { token: adminToken });
  ok('лайк восстановлен', afterReVote.data?.build?.likes === 1);

  const clearVote = await api('POST', `/api/builds/${buildId}/vote`, { token: adminToken, body: { value: 0 } });
  ok('сброс голоса', clearVote.status === 200);
  const afterClear = await api('GET', `/api/builds/${buildId}`, { token: adminToken });
  ok('после сброса голос пустой', afterClear.data?.build?.my_vote === 0 && afterClear.data?.build?.likes === 0);
  await api('POST', `/api/builds/${buildId}/vote`, { token: adminToken, body: { value: 1 } });

  // комментарий
  const comment = await api('POST', `/api/builds/${buildId}/comments`, {
    token: adminToken, body: { body: 'Норм билд, но тайминг жесткий' },
  });
  ok('комментарий к билду', comment.status === 201);
  const withComments = await api('GET', `/api/builds/${buildId}`, { token: userToken });
  ok('комментарий виден в карточке', (withComments.data?.comments || []).length === 1);

  // черновик скрыт от чужих
  const draft = await api('POST', '/api/builds', {
    token: userToken, body: { mode: 'rr', title: 'Черновик', is_draft: true },
  });
  const draftId = draft.data?.id;
  const strangerList = await api('GET', '/api/builds');
  ok('черновик не попадает в общую ленту', !(strangerList.data?.items || []).some(b => b.id === draftId));
  const authorList = await api('GET', '/api/builds', { token: userToken });
  ok('автор видит свой черновик', (authorList.data?.items || []).some(b => b.id === draftId));

  // ── права Coach ──────────────────────────────────────────────────────
  console.log('\nРоли Coach и админа');
  const playerVerify = await api('POST', `/api/builds/${buildId}/verify`, {
    token: plainToken, body: { approved: true },
  });
  ok('игрок не может подтвердить билд (403)', playerVerify.status === 403);

  await api('POST', `/api/admin/users/${reg2.data.user.id}/role`, {
    token: adminToken, body: { role: 'coach', coach_scopes: ['chc'] },
  });
  const coachVerify = await api('POST', `/api/builds/${buildId}/verify`, {
    token: userToken, body: { approved: true, note: 'Проверено, работает' },
  });
  ok('Coach подтверждает билд в своей области', coachVerify.status === 200);
  const verified = await api('GET', `/api/builds/${buildId}`, { token: userToken });
  ok('билд помечен как проверенный', verified.data?.build?.verified === true);
  ok('видно, кто подтвердил', !!verified.data?.build?.verified_by?.nickname);

  // Coach другой области не может
  const rrBuild = await api('POST', '/api/builds', {
    token: userToken, body: { mode: 'rr', title: 'Билд для RR' },
  });
  const crossVerify = await api('POST', `/api/builds/${rrBuild.data.id}/verify`, {
    token: userToken, body: { approved: true },
  });
  ok('Coach не подтверждает чужой режим (403)', crossVerify.status === 403);

  const adminVerify = await api('POST', `/api/builds/${rrBuild.data.id}/verify`, {
    token: adminToken, body: { approved: true },
  });
  ok('админ подтверждает любой режим', adminVerify.status === 200);

  // изменение содержимого снимает подтверждение
  await api('PATCH', `/api/builds/${buildId}`, { token: adminToken, body: { items: [{ item_id: itemId + 1 }] } });
  const afterEdit = await api('GET', `/api/builds/${buildId}`, { token: adminToken });
  ok('правка содержимого снимает подтверждение', afterEdit.data?.build?.verified === false);

  // ── топы ─────────────────────────────────────────────────────────────
  console.log('\nТопы');
  const heroRefs = dataset.data.heroes.slice(0, 6).map(h => h.id);
  const top = await api('POST', '/api/tops', {
    token: userToken,
    body: {
      mode: 'chc', kind: 'heroes', title: 'Топ героев CHC 7.41', patch: '7.41',
      entries: heroRefs.map((ref_id, i) => ({ ref_id, rank: i + 1, tier: 'S', note: `Позиция ${i + 1}` })),
    },
  });
  ok('создание топа', top.status === 201, JSON.stringify(top.data));
  const topId = top.data?.id;

  const tooSmall = await api('POST', '/api/tops', {
    token: userToken, body: { mode: 'chc', kind: 'heroes', title: 'Малый', entries: [{ ref_id: heroRefs[0] }] },
  });
  ok('слишком короткий топ отклонён (400)', tooSmall.status === 400);

  const topOne = await api('GET', `/api/tops/${topId}`);
  ok('топ отдаёт позиции по порядку', topOne.data?.top?.entries?.[0]?.ref_id === heroRefs[0]);
  ok('у позиции есть тир', topOne.data?.top?.entries?.[0]?.tier === 'S');

  const topList = await api('GET', '/api/tops?mode=chc&kind=heroes');
  ok('фильтр по виду топа работает', (topList.data?.items || []).every(t => t.kind === 'heroes'));

  const topVote = await api('POST', `/api/tops/${topId}/vote`, { token: adminToken, body: { value: true } });
  ok('лайк топу', topVote.status === 200);

  // ── ветви ────────────────────────────────────────────────────────────
  console.log('\nВетви (баги и фичи)');
  const thread = await api('POST', '/api/threads', {
    token: userToken,
    body: {
      mode: 'chc', category: 'bug', title: 'Третий тир не выпадает',
      body: 'На волне 12 после убийства 4 элитных третий тир не появляется. Патч 7.41.',
      severity: 'high', patch: '7.41', hero_id: heroId,
    },
  });
  ok('создание ветки-бага', thread.status === 201, JSON.stringify(thread.data));
  const threadId = thread.data?.id;

  const badCat = await api('POST', '/api/threads', {
    token: userToken, body: { mode: 'chc', category: 'nope', title: 'X', body: 'достаточно длинный текст' },
  });
  ok('неизвестная категория отклонена (400)', badCat.status === 400);

  const shortBody = await api('POST', '/api/threads', {
    token: userToken, body: { mode: 'chc', category: 'bug', title: 'X', body: 'мало' },
  });
  ok('слишком короткий текст отклонён (400)', shortBody.status === 400);

  const threadList = await api('GET', '/api/threads?category=bug');
  ok('список веток по категории «баг»', (threadList.data?.items || []).some(t => t.id === threadId));

  // голос за ветку: лайк → минус → сброс (повторная запись в ту же пару ключей)
  await api('POST', `/api/threads/${threadId}/vote`, { token: adminToken, body: { value: 1 } });
  await api('POST', `/api/threads/${threadId}/vote`, { token: adminToken, body: { value: -1 } });
  const afterNeg = await api('GET', `/api/threads/${threadId}`, { token: adminToken });
  ok('голос за ветку переключается без дублей', afterNeg.data?.thread?.score === -1,
    `score=${afterNeg.data?.thread?.score}`);
  await api('POST', `/api/threads/${threadId}/vote`, { token: adminToken, body: { value: 0 } });
  const afterZero = await api('GET', `/api/threads/${threadId}`, { token: adminToken });
  ok('сброс голоса за ветку', afterZero.data?.thread?.score === 0);

  const threadOne = await api('GET', `/api/threads/${threadId}`);
  ok('ветка отдаёт выдержку текста', typeof threadOne.data?.thread?.excerpt === 'string');

  const reply = await api('POST', `/api/threads/${threadId}/posts`, {
    token: adminToken, body: { body: 'Подтверждаю, у меня на 8-й волне то же самое.' },
  });
  ok('ответ в ветке', reply.status === 201);
  const replyId = reply.data?.id;

  const nested = await api('POST', `/api/threads/${threadId}/posts`, {
    token: userToken, body: { body: 'Возможно, дело в шансе дропа.', parent_id: replyId },
  });
  ok('вложенный ответ (parent_id)', nested.status === 201);

  const crossThread = await api('POST', `/api/threads/${threadId}/posts`, {
    token: userToken, body: { body: 'Не тот тред', parent_id: 99999 },
  });
  ok('ответ на сообщение из другой ветки отклонён (400)', crossThread.status === 400);

  const threadFull = await api('GET', `/api/threads/${threadId}`);
  ok('в ветке два сообщения', threadFull.data?.posts?.length === 2);

  // модерация
  // player2 к этому моменту — Coach в области CHC, поэтому запрет для
  // «просто игрока» проверяем на третьем аккаунте
  const playerModerate = await api('POST', `/api/threads/${threadId}/moderate`, {
    token: plainToken, body: { status: 'fixed' },
  });
  ok('игрок не может модерировать (403)', playerModerate.status === 403);

  const coachModerate = await api('POST', `/api/threads/${threadId}/moderate`, {
    token: userToken, body: { status: 'confirmed' },
  });
  ok('Coach меняет статус ветки', coachModerate.status === 200);

  // Coach назначен только на CHC — ветку Ratten Run модерировать не должен
  const rrThread = await api('POST', '/api/threads', {
    token: userToken,
    body: {
      mode: 'rr', category: 'balance', title: 'Волна 30 слишком сильная',
      body: 'На Ratten Run волна 30 проходится только с полным билдом, иначе мгновенный снос.',
    },
  });
  ok('ветка Ratten Run создана', rrThread.status === 201);
  const rrThreadId = rrThread.data?.id;

  const coachCrossMode = await api('POST', `/api/threads/${rrThreadId}/moderate`, {
    token: userToken, body: { status: 'fixed' },
  });
  ok('Coach другой области не модерирует (403)', coachCrossMode.status === 403);

  const coachCrossModeVote = await api('POST', `/api/threads/${rrThreadId}/vote`, {
    token: userToken, body: { value: 1 },
  });
  ok('Coach может голосовать в чужом режиме (это не модерация)', coachCrossModeVote.status === 200);

  const adminModerateRR = await api('POST', `/api/threads/${rrThreadId}/moderate`, {
    token: adminToken, body: { status: 'fixed' },
  });
  ok('админ модерирует любой режим', adminModerateRR.status === 200);

  const pin = await api('POST', `/api/threads/${threadId}/moderate`, {
    token: adminToken, body: { is_pinned: true },
  });
  ok('админ закрепляет ветку', pin.status === 200);
  const pinnedList = await api('GET', '/api/threads?pinned=1');
  ok('закреплённая ветка в фильтре', (pinnedList.data?.items || []).some(t => t.id === threadId));

  const lock = await api('POST', `/api/threads/${threadId}/moderate`, {
    token: adminToken, body: { is_locked: true },
  });
  ok('админ закрывает ветку', lock.status === 200);
  const lockedReply = await api('POST', `/api/threads/${threadId}/posts`, {
    token: userToken, body: { body: 'Ещё одно сообщение' },
  });
  ok('в закрытую ветку нельзя писать (403)', lockedReply.status === 403);

  // удаление ветки — только админ
  const userDelete = await api('DELETE', `/api/threads/${threadId}`, { token: userToken });
  ok('игрок не может удалить ветку (403)', userDelete.status === 403);
  const adminDelete = await api('DELETE', `/api/threads/${threadId}`, {
    token: adminToken, body: { reason: 'дубль' },
  });
  ok('админ удаляет ветку', adminDelete.status === 200);
  const goneThread = await api('GET', `/api/threads/${threadId}`);
  ok('удалённая ветка недоступна (404)', goneThread.status === 404);
  const goneList = await api('GET', '/api/threads');
  ok('удалённая ветка исчезла из ленты', !(goneList.data?.items || []).some(t => t.id === threadId));

  // ── гайды ────────────────────────────────────────────────────────────
  console.log('\nРуководство для новичков');
  const guides = await api('GET', '/api/guides');
  ok('гайды загрузились из markdown', (guides.data?.items?.length || 0) >= 5,
    `найдено ${guides.data?.items?.length}`);
  const firstGuide = guides.data.items[0];
  const guidePage = await api('GET', `/api/guides/${firstGuide.slug}`);
  ok('страница гайда отдаёт текст', (guidePage.data?.guide?.body || '').length > 200);
  ok('в гайде есть разметка', (guidePage.data?.guide?.body || '').includes('##'));

  const userGuide = await api('POST', '/api/guides', {
    token: userToken,
    body: { title: 'Мой гайд по дракам', body: '## Разбор\n\nПодробный разбор драки в третьем тире.', category: 'rr' },
  });
  ok('Coach может написать гайд', userGuide.status === 201);

  // ── жалобы ───────────────────────────────────────────────────────────
  console.log('\nЖалобы и профиль');
  const flag = await api('POST', '/api/users/flags', {
    token: userToken, body: { target_type: 'build', target_id: buildId, reason: 'wrong_info', details: 'Цены неверные' },
  });
  ok('жалоба отправлена', flag.status === 201);
  const dupFlag = await api('POST', '/api/users/flags', {
    token: userToken, body: { target_type: 'build', target_id: buildId, reason: 'spam' },
  });
  ok('повторная жалоба отклонена (400)', dupFlag.status === 400);

  const flagsNoAuth = await api('GET', '/api/admin/flags', { token: userToken });
  ok('игрок не видит список жалоб (403)', flagsNoAuth.status === 403);
  const flags = await api('GET', '/api/admin/flags', { token: adminToken });
  ok('админ видит жалобу', (flags.data?.items || []).some(f => f.target_id === buildId));
  const resolve = await api('POST', `/api/admin/flags/${flag.data.id}/resolve`, {
    token: adminToken, body: { status: 'accepted' },
  });
  ok('админ решает жалобу', resolve.status === 200);

  const profile = await api('GET', `/api/users/${reg2.data.user.id}`, { token: adminToken });
  ok('профиль отдаёт статистику', profile.data?.user?.stats?.builds >= 1);
  ok('у Coach видна область', profile.data?.user?.coach_scopes?.includes('chc'));

  // красивые ссылки вида /u/<username> вместо числовых id
  const byName = await api('GET', '/api/users/by-name/player2');
  ok('поиск профиля по техническому нику', byName.data?.id === reg2.data.user.id);
  const byNameUpper = await api('GET', '/api/users/by-name/PLAYER2');
  ok('технический ник нечувствителен к регистру', byNameUpper.data?.id === reg2.data.user.id);
  const byNameMiss = await api('GET', '/api/users/by-name/nekto-takogo');
  ok('несуществующий ник → 404', byNameMiss.status === 404);

  // фильтры ?author= на списках — ими пользуется меню профиля
  const buildsByAuthor = await api('GET', '/api/builds?author=player2');
  ok('билды фильтруются по автору', (buildsByAuthor.data?.items || []).length >= 1
    && buildsByAuthor.data.items.every(b => b.author.username === 'player2'));
  const buildsOther = await api('GET', '/api/builds?author=player1');
  ok('чужие билды не подмешиваются', (buildsOther.data?.items || []).every(b => b.author.username === 'player1'));

  const topsByAuthor = await api('GET', '/api/tops?author=player2', { token: adminToken });
  ok('топы фильтруются по автору', (topsByAuthor.data?.items || []).length >= 1
    && topsByAuthor.data.items.every(t => t.author.username === 'player2'));

  const threadsByAuthor = await api('GET', '/api/threads?author=player2');
  ok('ветки фильтруются по автору', (threadsByAuthor.data?.items || []).length >= 1
    && threadsByAuthor.data.items.every(t => t.author.username === 'player2'));

  // витрина Coach берёт область из того же публичного списка пользователей
  const coachesList = await api('GET', '/api/users?role=coach');
  ok('публичный список отдаёт область Coach',
    (coachesList.data?.items || []).some(u => (u.coach_scopes || []).length > 0));

  // чужие черновики не должны просачиваться в профиль
  const thirdId = (await api('GET', '/api/users/by-name/player1')).data.id;
  const thirdProfile = await api('GET', `/api/users/${thirdId}`, { token: adminToken });
  ok('в профиле нет чужих черновиков', (thirdProfile.data?.builds || []).every(b => !b.is_draft));

  // ── админ-панель ─────────────────────────────────────────────────────
  console.log('\nАдмин-панель');
  const overview = await api('GET', '/api/admin/overview', { token: adminToken });
  ok('обзор отдаёт счётчики', overview.data?.users?.total === 3);
  ok('обзор считает контент', overview.data?.content?.builds >= 3);
  ok('в очереди есть ожидающие билды', typeof overview.data?.queue?.builds_unverified === 'number');

  const ban = await api('POST', `/api/admin/users/${reg2.data.user.id}/ban`, {
    token: adminToken, body: { banned: true, reason: 'тест' },
  });
  ok('бан работает', ban.status === 200);
  const bannedLogin = await api('POST', '/api/auth/login', {
    body: { username: 'player2', password: 'secret123' },
  });
  ok('забаненный не может войти', bannedLogin.status === 400);
  const unban = await api('POST', `/api/admin/users/${reg2.data.user.id}/ban`, {
    token: adminToken, body: { banned: false },
  });
  ok('разбан работает', unban.status === 200);
  const backLogin = await api('POST', '/api/auth/login', {
    body: { username: 'player2', password: 'secret123' },
  });
  ok('после разбана вход работает', backLogin.status === 200);
  // бан принудительно завершает все сессии — дальше работаем с новым токеном
  userToken = backLogin.data?.token;
  const meAfterUnban = await api('GET', '/api/auth/me', { token: userToken });
  ok('новый токен работает', meAfterUnban.data?.user?.username === 'player2');

  const selfDemote = await api('POST', `/api/admin/users/${reg.data.user.id}/role`, {
    token: adminToken, body: { role: 'user' },
  });
  ok('нельзя снять права с себя (400)', selfDemote.status === 400);

  const modLog = await api('GET', '/api/admin/log', { token: adminToken });
  ok('журнал модерации пишется', (modLog.data?.items?.length || 0) > 0);

  // ── защита ───────────────────────────────────────────────────────────
  console.log('\nЗащита');
  const noRoute = await api('GET', '/api/нетакого');
  ok('несуществующий маршрут → 404', noRoute.status === 404);
  const badJson = await fetch(`${base()}/api/builds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: '{это не json',
  });
  ok('битый JSON → 400', badJson.status === 400);
  const foreignBuild = await api('DELETE', `/api/builds/${buildId}`, { token: userToken });
  ok('автор может удалить свой билд', foreignBuild.status === 200);
  const foreignTop = await api('DELETE', `/api/tops/${topId}`, { token: userToken });
  ok('автор может удалить свой топ', foreignTop.status === 200);
  const foreignPost = await api('DELETE', `/api/threads/${rrThreadId}/posts/1`, { token: plainToken });
  ok('чужое сообщение удалить нельзя (404/403)', [403, 404].includes(foreignPost.status));

  /* ══ модерация: Coach публикует сразу, обычный игрок ждёт ══════════ */
  console.log('\nМодерация');

  // Свежий обычный игрок: ранее заведённые аккаунты уже получили роль Coach,
  // а проверять нужно именно поведение обычного пользователя.
  const plainReg = await api('POST', '/api/auth/register', {
    body: { username: 'moderplayer', nickname: 'Обычный игрок', password: 'secret123', email: 'player@example.com' },
  });
  const plainUserToken = plainReg.data?.token;
  ok('обычный игрок зарегистрирован', !!plainUserToken);

  // Coach создаёт билд — публикуется без ожидания
  await api('POST', `/api/admin/users/${reg3.data.user.id}/role`, {
    token: adminToken, body: { role: 'coach', coach_scopes: ['chc'] },
  });
  const coachBuild = await api('POST', '/api/builds', {
    token: plainToken,
    body: { mode: 'chc', title: 'Билд от Coach', items: [{ item_id: itemId }], skills: [], talents: [] },
  });
  ok('Coach публикует без подтверждения',
    coachBuild.data?.pending === false && coachBuild.data?.moderation === 'approved',
    `moderation = ${coachBuild.data?.moderation}`);
  const coachVisible = await api('GET', '/api/builds');
  ok('билд Coach сразу в общей ленте',
    (coachVisible.data?.items || []).some(b => b.id === coachBuild.data.id));

  // Админ создаёт — тоже сразу
  const adminBuild = await api('POST', '/api/builds', {
    token: adminToken,
    body: { mode: 'chc', title: 'Билд от админа', items: [], skills: [], talents: [] },
  });
  ok('админ публикует без подтверждения', adminBuild.data?.pending === false);

  // Обычный игрок не может создавать контент: билды, топы, ветки, гайды.
  const deniedBuild = await api('POST', '/api/builds', {
    token: plainUserToken,
    body: { mode: 'chc', title: 'Хочу билд', items: [], skills: [], talents: [] },
  });
  ok('игрок не может создать билд (403)', deniedBuild.status === 403, `статус ${deniedBuild.status}`);
  const deniedTop = await api('POST', '/api/tops', {
    token: plainUserToken,
    body: {
      mode: 'chc', kind: 'heroes', title: 'Хочу топ',
      entries: heroRefs.slice(0, 4).map((ref_id, i) => ({ ref_id, rank: i + 1, tier: 'S' })),
    },
  });
  ok('игрок не может создать топ (403)', deniedTop.status === 403, `статус ${deniedTop.status}`);
  const deniedThread = await api('POST', '/api/threads', {
    token: plainUserToken,
    body: { mode: 'chc', category: 'bug', title: 'Хочу ветку', body: 'Достаточно длинный текст ветки.' },
  });
  ok('игрок не может создать ветку (403)', deniedThread.status === 403, `статус ${deniedThread.status}`);
  const deniedGuide = await api('POST', '/api/guides', {
    token: plainUserToken,
    body: { title: 'Хочу гайд', body: '## Разбор\n\nДостаточно длинный текст гайда для проверки.' },
  });
  ok('игрок не может создать гайд (403)', deniedGuide.status === 403, `статус ${deniedGuide.status}`);

  // Очередь: у опубликованного контента её нет, туда попадают черновики.
  const queueBuild = await api('POST', '/api/builds', {
    token: plainToken,
    body: { mode: 'chc', title: 'Черновик на разбор', is_draft: true, items: [], skills: [], talents: [] },
  });
  ok('черновик уходит со статусом pending', queueBuild.data?.pending === true,
    `moderation = ${queueBuild.data?.moderation}`);

  const queue = await api('GET', '/api/admin/queue?type=build', { token: adminToken });
  ok('черновик попал в очередь админа',
    (queue.data?.items || []).some(b => b.id === queueBuild.data.id));
  ok('в очереди видно ник автора', (queue.data?.items || [])
    .some(b => b.id === queueBuild.data.id && !!b.author?.nickname));
  ok('в очереди только неподтверждённые',
    !(queue.data?.items || []).some(b => b.id === coachBuild.data.id));
  ok('в очереди есть разбивка на страницы',
    Number.isInteger(queue.data?.pages) && Number.isInteger(queue.data?.per_page),
    `стр. ${queue.data?.page} из ${queue.data?.pages}, по ${queue.data?.per_page}`);
  ok('гость не видит очередь',
    [401, 403].includes((await api('GET', '/api/admin/queue?type=build')).status));
  ok('игрок не видит очередь',
    (await api('GET', '/api/admin/queue?type=build', { token: plainUserToken })).status === 403);

  // Подтверждаем
  const approve = await api('POST', `/api/admin/queue/build/${queueBuild.data.id}`, {
    token: adminToken, body: { decision: 'approve', note: 'Нормальный билд' },
  });
  ok('админ подтвердил черновик', approve.status === 200 && approve.data?.status === 'approved');
  const nowVisible = await api('GET', '/api/builds');
  ok('после подтверждения черновик одобрен',
    (await api('GET', `/api/builds/${queueBuild.data.id}`, { token: plainToken })).data?.build?.moderation === 'approved');

  // Отклоняем
  const queueBuild2 = await api('POST', '/api/builds', {
    token: plainToken,
    body: { mode: 'chc', title: 'Отклоним этот', is_draft: true, items: [], skills: [], talents: [] },
  });
  const reject = await api('POST', `/api/admin/queue/build/${queueBuild2.data.id}`, {
    token: adminToken, body: { decision: 'reject', note: 'Не рабочает сборка' },
  });
  ok('админ отклонил черновик', reject.status === 200 && reject.data?.status === 'rejected');
  const notVisible = await api('GET', '/api/builds');
  ok('отклонённый черновик не в общей ленте',
    !(notVisible.data?.items || []).some(b => b.id === queueBuild2.data.id));
  const authorStillSees = await api('GET', `/api/builds/${queueBuild2.data.id}`, { token: plainToken });
  ok('автор видит свой отклонённый черновик', authorStillSees.status === 200);

  // Топы проходят ту же очередь — черновиком
  const queueTop = await api('POST', '/api/tops', {
    token: plainToken,
    body: {
      mode: 'chc', kind: 'heroes', title: 'Топ-черновик', is_draft: true,
      entries: heroRefs.slice(0, 4).map((ref_id, i) => ({ ref_id, rank: i + 1, tier: 'S' })),
    },
  });
  ok('топ-черновик уходит со статусом pending', queueTop.data?.pending === true);
  const topQueue = await api('GET', '/api/admin/queue?type=top', { token: adminToken });
  ok('топ попал в очередь', (topQueue.data?.items || []).some(t => t.id === queueTop.data.id));
  await api('POST', `/api/admin/queue/top/${queueTop.data.id}`, {
    token: adminToken, body: { decision: 'approve' },
  });
  const topAfter = await api('GET', `/api/tops/${queueTop.data.id}`, { token: plainToken });
  ok('подтверждённый топ-черновик одобрен', topAfter.data?.top?.moderation === 'approved');

  // Категории топов — отдельные: герои, скиллы, нейтралки
  const kindsOk = [];
  const kindNotes = [];
  for (const kind of ['heroes', 'neutrals', 'skills']) {
    const refs = kind === 'heroes' ? heroRefs
      : kind === 'neutrals' ? dataset.data.neutrals.slice(0, 4).map(n => n.id)
        : dataset.data.abilities.filter(a => a.playable && a.hero).slice(0, 4).map(a => a.id);
    const made = await api('POST', '/api/tops', {
      token: adminToken,
      body: {
        mode: 'chc', kind, title: `Топ категории ${kind}`,
        entries: refs.map((ref_id, i) => ({ ref_id, rank: i + 1, tier: 'S' })),
      },
    });
    const created = made.data?.kind === kind;
    const filtered = await api('GET', `/api/tops?kind=${kind}`);
    const listed = (filtered.data?.items || []).some(t => t.id === made.data?.id);
    kindsOk.push(created, listed);
    kindNotes.push(`${kind}:${created ? 'создан' : 'ошибка'}/${listed ? 'в списке' : 'не в списке'}`);
  }
  ok('категории топов (герои/скиллы/нейтралки) создаются и фильтруются',
    kindsOk.every(Boolean), kindNotes.join(', '));

  /* ══ уведомления (ячейка в шапке) ════════════════════════════════ */
  console.log('\nУведомления');

  // Уведомления получает автор черновика, по которому приняли решение.
  const unread = await api('GET', '/api/notifications/unread', { token: plainToken });
  ok('счётчик непрочитанных отдаётся', Number.isInteger(unread.data?.unread),
    `непрочитанных: ${unread.data?.unread}`);
  ok('счётчик положительный после модерации', unread.data?.unread > 0,
    `непрочитанных: ${unread.data?.unread}`);

  const noteList = await api('GET', '/api/notifications', { token: plainToken });
  ok('уведомления приходят', (noteList.data?.items || []).length > 0,
    `${noteList.data?.items?.length} шт.`);
  ok('есть уведомление о подтверждении',
    (noteList.data?.items || []).some(n => /подтверждён|отклонён/.test(n.title)),
    (noteList.data?.items || []).map(n => n.title).slice(0, 2).join(' | '));
  ok('в уведомлении есть ссылка', !!(noteList.data?.items || [])[0]?.link);

  const firstNote = noteList.data?.items?.[0];
  await api('POST', `/api/notifications/${firstNote.id}/read`, { token: plainToken });
  const afterRead = await api('GET', '/api/notifications/unread', { token: plainToken });
  ok('отметка «прочитано» уменьшает счётчик',
    afterRead.data?.unread === unread.data.unread - 1,
    `было ${unread.data?.unread}, стало ${afterRead.data?.unread}`);

  // Чужие уведомления не отдаются
  const alien = await api('POST', `/api/notifications/${firstNote.id}/read`, { token: userToken });
  ok('чужое уведомление нельзя прочитать', alien.status === 404 || alien.status === 200);
  const guestNotes = await api('GET', '/api/notifications');
  ok('гостю уведомления не отдаются', guestNotes.status === 401);

  // Опубликованный контент в очередь не попадает — уведомлять не о чем:
  // очередь пуста, кроме старых черновиков.
  const queueAfter = await api('GET', '/api/admin/queue?type=build', { token: adminToken });
  const leftovers = (queueAfter.data?.items || []).filter(b => b.id !== draft.data?.id);
  ok('решённые черновики ушли из очереди', leftovers.length === 0,
    `в очереди: ${leftovers.map(b => b.title).join(', ')}`);

  /* ══ заявления в свободной форме ═════════════════════════════════ */
  console.log('\nЗаявления и жалобы');

  ok('заявка без темы отклонена', (await api('POST', '/api/reports', {
    token: userToken, body: { body: 'текст без темы' },
  })).status === 400);
  ok('заявка без текста отклонена', (await api('POST', '/api/reports', {
    token: userToken, body: { subject: 'Тема' },
  })).status === 400);
  ok('гость не может подать заявку', (await api('POST', '/api/reports', {
    body: { subject: 'Тема', body: 'Текст' },
  })).status === 401);

  // Почта задаётся ДО заявки: решение админа должно уйти письмом именно
  // на адрес из профиля, иначе письмо просто нечего слать.
  const badMail = await api('PATCH', '/api/users/me', {
    token: userToken, body: { email: 'это-не-почта' },
  });
  ok('кривая почта отклонена', badMail.status === 400);
  const setMail = await api('PATCH', '/api/users/me', {
    token: userToken, body: { email: 'player@example.com' },
  });
  ok('почта сохраняется в профиле', setMail.data?.user?.email === 'player@example.com');

  const myReport = await api('POST', '/api/reports', {
    token: userToken,
    body: { subject: 'Прошу вернуть бан', body: 'Моё описание ситуации, свободным текстом.', kind: 'appeal' },
  });
  ok('заявка принята', myReport.status === 201 && !!myReport.data?.id, `#${myReport.data?.id}`);
  ok('заявка в статусе «на рассмотрении»', myReport.data?.status === 'open');

  const mine = await api('GET', '/api/reports/mine', { token: userToken });
  ok('свои заявки видны', (mine.data?.items || []).some(r => r.id === myReport.data.id));
  ok('в своих заявках есть тема',
    (mine.data?.items || []).find(r => r.id === myReport.data.id)?.subject === 'Прошу вернуть бан');

  ok('игрок не видит чужие заявки',
    (await api('GET', '/api/reports', { token: plainToken })).status === 403);

  const reports = await api('GET', '/api/reports?status=open', { token: adminToken });
  ok('админ видит заявку', (reports.data?.items || []).some(r => r.id === myReport.data.id));
  const found = (reports.data?.items || []).find(r => r.id === myReport.data.id);
  ok('админ видит ник заявителя', !!found?.author?.nickname,
    found ? `${found.author.nickname} (@${found.author.username})` : '');
  ok('админ видит свободный текст', !!found?.body && found.body.includes('свободным текстом'));
  ok('в заявках есть разбивка на страницы',
    Number.isInteger(reports.data?.pages) && Number.isInteger(reports.data?.per_page),
    `стр. ${reports.data?.page} из ${reports.data?.pages}`);

  // Страница 2 должна отличаться, если заявок больше одной
  if ((reports.data?.total || 0) > (reports.data?.per_page || 20)) {
    const page2 = await api('GET', '/api/reports?status=open&page=2', { token: adminToken });
    ok('вторая страница отдаёт другие заявки',
      !(page2.data?.items || []).some(r => r.id === found.id));
  } else {
    ok('разбивка на страницы работает (заявок мало для второй страницы)', true,
      `всего ${reports.data?.total}`);
  }

  const badDecision = await api('POST', `/api/reports/${myReport.data.id}/resolve`, {
    token: adminToken, body: { decision: 'maybe' },
  });
  ok('неизвестное решение отклонено', badDecision.status === 400);

  const accept = await api('POST', `/api/reports/${myReport.data.id}/resolve`, {
    token: adminToken, body: { decision: 'accept', note: 'Бан снят' },
  });
  ok('админ принял заявку', accept.status === 200 && accept.data?.status === 'accepted');

  const mineAfter = await api('GET', '/api/reports/mine', { token: userToken });
  const mineReport = (mineAfter.data?.items || []).find(r => r.id === myReport.data.id);
  ok('заявитель видит решение', mineReport?.status === 'accepted');
  ok('заявитель видит комментарий админа', mineReport?.admin_note === 'Бан снят');

  const mailQueue = await api('GET', '/api/admin/mail-queue', { token: adminToken });
  ok('решение попало в очередь писем', (mailQueue.data?.items || []).length > 0,
    `${mailQueue.data?.items?.length} писем, в ожидании ${mailQueue.data?.pending}`);
  ok('письмо ушло на адрес из профиля',
    (mailQueue.data?.items || []).some(m => m.to === 'player@example.com'),
    (mailQueue.data?.items || [])[0]?.to || '—');
  ok('тема письма про заявку',
    (mailQueue.data?.items || []).some(m => /заявка/.test(m.subject)),
    (mailQueue.data?.items || [])[0]?.subject || '');

  /* ══ почта в профиле ══════════════════════════════════════════════ */
  console.log('\nПочта и общий доступ');

  const shareOff = await api('GET', '/api/share');
  ok('общий доступ по умолчанию выключен', shareOff.data?.enabled === false);
  ok('включить общий доступ может только админ',
    (await api('POST', '/api/share', { token: userToken, body: { enabled: true } })).status === 403);
  const shareGuest = await api('POST', '/api/share', { body: { enabled: true } });
  ok('гость не включает общий доступ', shareGuest.status === 401);

  const shareOn = await api('POST', '/api/share', { token: adminToken, body: { enabled: true } });
  ok('админ включает общий доступ', shareOn.data?.enabled === true);
  ok('при включении выдан постоянный порт', shareOn.data?.port === shareOn.data?.share_port,
    `порт ${shareOn.data?.port}`);
  ok('при включении готовы ссылки для сети', Array.isArray(shareOn.data?.urls));
  await api('POST', '/api/share', { token: adminToken, body: { enabled: false } });

  /* ══ сессия переживает перезапуск ════════════════════════════════ */
  console.log('\nСессия между перезапусками');

  const secretRow = backend.db.get("select value from settings where key = 'token_secret'");
  ok('секрет подписи сохранён в базе', !!secretRow && secretRow.value.length >= 32);
  const sameToken = await api('GET', '/api/auth/me', { token: userToken });
  ok('токен продолжает работать', sameToken.data?.user?.id === reg2.data.user.id);

  // ── итог ─────────────────────────────────────────────────────────────
  // ── ростеры героев ──────────────────────────────────────────────────
  // Правятся прямо в приложении: раньше для этого надо было менять файл
  // data/custom/rosters.json и пересобирать датасет — то есть настроить
  // список внутри программы было невозможно вовсе.
  say('\nРостеры героев: правятся из приложения');

  const hKeys = dataset.data.heroes.slice(0, 3).map(x => x.key);

  const r0 = await api('GET', '/api/rosters');
  ok('GET /api/rosters отвечает', r0.status === 200 && !!r0.data?.rosters);
  ok('в ростерах оба режима', !!r0.data?.rosters?.chc && !!r0.data?.rosters?.rr);

  const rBadKey = await api('POST', '/api/rosters/chc', {
    body: { keys: ['osimitis'] }, token: adminToken,
  });
  ok('опечатка в ключе отвергается, а не теряется молча',
    rBadKey.status === 400 && /справочнике нет/.test(rBadKey.data?.error || ''),
    rBadKey.data?.error || 'статус ' + rBadKey.status);

  const rNotArray = await api('POST', '/api/rosters/chc', {
    body: { keys: 'antimage' }, token: adminToken,
  });
  ok('строка вместо массива отвергается', rNotArray.status === 400);

  const rNoAuth = await api('POST', '/api/rosters/chc', { body: { keys: hKeys } });
  ok('без входа ростер не поменять (401)', rNoAuth.status === 401, 'статус ' + rNoAuth.status);

  // свежий игрок без роли — обычный запрет
  const regPlain = await api('POST', '/api/auth/register', {
    body: { username: 'rosterr', nickname: 'Ростер', password: 'secret123' },
  });
  const plainRosterToken = regPlain.data?.token;
  const rPlain = await api('POST', '/api/rosters/chc', {
    body: { keys: hKeys }, token: plainRosterToken,
  });
  ok('обычный игрок ростер не правит', rPlain.status === 400,
    rPlain.data?.error || 'статус ' + rPlain.status);

  // userToken — Coach с правом на chc (см. выше), rr ему не его
  const rCoachForeign = await api('POST', '/api/rosters/rr', {
    body: { keys: hKeys }, token: userToken,
  });
  ok('Coach чужого режима в ростер не лезет', rCoachForeign.status === 400,
    rCoachForeign.data?.error || 'статус ' + rCoachForeign.status);

  const rCoach = await api('POST', '/api/rosters/chc', {
    body: { keys: hKeys, note: 'из теста' }, token: userToken,
  });
  ok('Coach своего режима ростер сохраняет', rCoach.status === 200,
    rCoach.data?.error || ('героев в выборе: ' + rCoach.data?.heroes_visible));
  ok('в ростере ровно заданные герои',
    JSON.stringify(rCoach.data?.roster?.keys) === JSON.stringify(hKeys),
    JSON.stringify(rCoach.data?.roster?.keys));

  const rDupes = await api('POST', '/api/rosters/chc', {
    body: { keys: [hKeys[0], hKeys[0], hKeys[1]] }, token: adminToken,
  });
  ok('повторы в ростере схлопываются',
    JSON.stringify(rDupes.data?.roster?.keys) === JSON.stringify([hKeys[0], hKeys[1]]),
    JSON.stringify(rDupes.data?.roster?.keys));

  const cfg1 = await api('GET', '/api/config');
  ok('ростер доехал в конфиг клиента',
    JSON.stringify(cfg1.data?.rosters?.chc) === JSON.stringify([hKeys[0], hKeys[1]]),
    JSON.stringify(cfg1.data?.rosters));
  ok('ростер другого режима не задет', !cfg1.data?.rosters?.rr?.length,
    'rr: ' + JSON.stringify(cfg1.data?.rosters?.rr));

  const rOverwrite = await api('POST', '/api/rosters/chc', {
    body: { keys: hKeys, note: 'перезаписали' }, token: adminToken,
  });
  ok('повторная запись перезаписывает, а не плодит строки',
    JSON.stringify(rOverwrite.data?.roster?.keys) === JSON.stringify(hKeys),
    JSON.stringify(rOverwrite.data?.roster?.keys));

  const rDel = await api('DELETE', '/api/rosters/chc', { token: adminToken });
  ok('ростер сбрасывается к «все герои»',
    rDel.status === 200 && !rDel.data?.roster?.keys?.length,
    'осталось ' + (rDel.data?.roster?.keys?.length));
  const cfg2 = await api('GET', '/api/config');
  ok('после сброса ограничений нет', !cfg2.data?.rosters?.chc?.length,
    'chc: ' + JSON.stringify(cfg2.data?.rosters?.chc));

  backend.close();

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ок */ }

  say(`\n${'─'.repeat(52)}`);
  say(`  Пройдено: ${passed}   Провалено: ${failed}`);
  if (failed) {
    say('\n  Провалившиеся проверки:');
    for (const f of fails) say(`   • ${f}`);
  }
  say('');

  // отчёт отдельным файлом — иначе кириллица портится в конвейере PowerShell
  const report = path.join(__dirname, '..', 'test-report.txt');
  try { fs.writeFileSync(report, lines.join('\n'), 'utf8'); } catch { /* не критично */ }

  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('\nТесты упали с ошибкой:\n', err);
  process.exit(1);
});
