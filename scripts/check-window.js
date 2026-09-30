#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — проверка настоящего окна приложения
   ──────────────────────────────────────────────────────────────────────
   Остальные тесты гоняют renderer в самодельном DOM и потому не ловят
   две вещи: нарушения CSP и то, грузятся ли иконки с диска. Здесь
   поднимается настоящий Electron, к нему подключается по CDP, и мы
   спрашиваем у живого окна: что на экране, грузятся ли картинки, чисто
   ли консоль.

   Скрипт сам запускает и закрывает приложение. Запуск:
     npm run check:window
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.CDP_PORT || 9222);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
const say = s => console.log(s);

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function check(name, fn) {
  try {
    const note = await fn();
    pass++;
    say(`  ✓ ${name}${note ? ' — ' + note : ''}`);
  } catch (err) {
    fail++;
    failures.push(`${name}: ${err.message}`);
    say(`  ✗ ${name}\n      ${err.message}`);
  }
}

/* ── где лежит electron ─────────────────────────────────────────────── */
function electronBin() {
  const bin = path.join(ROOT, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (fs.existsSync(bin)) return bin;
  throw new Error('Electron не установлен — выполни node node_modules/electron/install.js');
}

/* ── CDP ────────────────────────────────────────────────────────────── */
async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && /app[/\\]index\.html/.test(t.url || ''));
      if (page) return page;
    } catch { /* Electron ещё поднимается */ }
    await sleep(500);
  }
  throw new Error('окно не появилось за 40 секунд');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      events,
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => reject(new Error('CDP: не удалось подключиться')));
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) events.push(msg);
    });
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

/** Что сейчас на экране. */
const PROBE_VIEW = `(() => {
  const v = document.getElementById('view');
  return {
    hash: location.hash,
    nodes: v.children.length,
    len: v.innerHTML.length,
    panel: (v.querySelector('.error-panel') || {}).textContent || '',
    head: v.textContent.slice(0, 70),
    text: v.textContent,
  };
})()`;

/**
 * Кладёт в страницу <image> с локальным путём и ждёт, пока браузер
 * его действительно нарисует. Если CSP не пускает — ширина останется 0.
 */
const PROBE_IMAGE = `(async () => {
  const url = new URL('images/heroes/icons/antimage.png', location.href).href;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;z-index:99999';
  holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
    + '<image href="' + url + '" width="64" height="64"></image></svg>';
  document.body.appendChild(holder);
  const img = holder.querySelector('image');
  const deadline = Date.now() + 8000;
  let width = 0;
  while (Date.now() < deadline) {
    width = img.getBoundingClientRect().width;
    if (width > 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const href = img.getAttribute('href');
  holder.remove();
  return { href, width, fileProtocol: href.startsWith('file:') };
})()`;

const PROBE_STATE = `({
  title: document.title,
  apiBase: window.dotacustoms && window.dotacustoms.apiBase,
  cdn: window.store && window.store.cdn,
  heroes: window.store && window.store.heroes.length,
  items: window.store && window.store.items.length,
  talents: window.store && window.store.TALENT_LEVELS,
  routes: window.router ? window.router.list().length : 0,
  hasNode: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
  hasIpc: !!(window.dotacustoms && window.dotacustoms.info),
})`;

/** Ждёт, пока выражение в окне станет истинным. */
async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, `!!(${expression})`)) return true;
    if (Date.now() > deadline) throw new Error('не дождались: ' + expression);
    await sleep(300);
  }
}

/** Переходит на маршрут и проверяет, что экран не упал в error-panel. */
async function visitRoute(cdp, route, expectText) {
  await evaluate(cdp, `location.hash = ${JSON.stringify('#' + route)}`);
  await sleep(700);
  const v = await evaluate(cdp, PROBE_VIEW);
  if (route === NOT_FOUND_ROUTE) {
    assert(v.panel.includes('404'), 'нет панели 404');
    assert(!v.head.includes('Регистрация') && !v.head.includes('Главная'),
      'старый экран остался под 404: ' + v.head);
    return '404 без хвостов';
  }
  assert(!v.panel, 'экран упал: ' + v.panel.slice(0, 90));
  if (expectText) {
    // Короткие служебные экраны (просьба войти) намеренно не раздуты,
    // поэтому для них проверяем текст, а не объём.
    assert(v.text.includes(expectText),
      `нет текста «${expectText}»: ` + v.text.slice(0, 160));
    return `ожидаемый текст на месте (${v.len} симв.)`;
  }
  assert(v.len > 200, `почти пусто (${v.len} символов)`);
  assert(v.hash === '#' + route, `hash не тот: ${v.hash}, ожидали #${route}`);
  return `${v.nodes} узлов, ${v.len} симв.`;
}

/* ── запуск ─────────────────────────────────────────────────────────── */
/* ── проверка запуска после аварийного завершения ──────────────────────
   Самая обидная поломка всего проекта: node-sqlite3-wasm внутри Electron
   держит базу каталогом `dotacustoms.db.lock` и снимает его только при
   штатном выходе. После kill остаётся каталог — и все последующие
   запуски падают с «database is locked» навсегда. Пользователь при этом
   ничего не может сделать. Здесь мы это воспроизводим и проверяем фикс. */

function lockPaths(profile) {
  const data = path.join(profile, 'data');
  return { data, lock: path.join(data, 'dotacustoms.db.lock') };
}

async function checkCrashRecovery(bin, profile) {
  const { lock } = lockPaths(profile);

  say('');
  say('Запуск после аварийного завершения');
  const first = spawn(bin, ['.', `--user-data-dir=${profile}`], { cwd: ROOT, stdio: 'ignore' });
  const port1 = await waitForPort(profile, 20000);
  await check('первый запуск поднялся', async () => {
    assert(port1, 'сервер не поднялся');
    return `порт ${port1}`;
  });
  await check('база занята каталогом .lock', async () => {
    assert(fs.existsSync(lock), 'каталога нет — сценарий не воспроизводится');
    return 'lock на месте';
  });

  // Убиваем так же, как диспетчер задач: cleanup не выполняется
  first.kill('SIGKILL');
  await sleep(2500);
  await check('после kill остаётся зависшая блокировка', async () => {
    assert(fs.existsSync(lock), 'lock был убран — воспроизвести нечего');
    return 'именно та поломка';
  });

  // Второй запуск: пользователь жмёт иконку ещё раз
  const second = spawn(bin, ['.', `--user-data-dir=${profile}`], { cwd: ROOT, stdio: 'ignore' });
  const port2 = await waitForPort(profile, 20000);
  await check('повторный запуск поднимается несмотря на lock', async () => {
    assert(port2, 'приложение снова упало — протухшая блокировка не снята');
    const health = await fetch(`http://127.0.0.1:${port2}/api/health`).then(r => r.json());
    assert(health.ok, 'API не отвечает: ' + JSON.stringify(health));
    return `порт ${port2}, /api/health ok`;
  });
  second.kill('SIGKILL');
  await sleep(1500);
}

/**
 * Ждёт работающего сервера и возвращает его порт.
 *
 * Порт берём из лога приложения, но важно брать ПОСЛЕДНЕЕ вхождение:
 * при перезапуске в логе остаётся адрес прошлого процесса, и если взять
 * первый, мы опрошим уже мёртвый порт.
 */
async function waitForPort(profile, timeoutMs) {
  const logFile = path.join(profile, 'logs', 'dotacustoms.log');
  const deadline = Date.now() + timeoutMs;
  let newest = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(logFile)) {
      const all = [...fs.readFileSync(logFile, 'utf8')
        .matchAll(/сервер: http:\/\/127\.0\.0\.1:(\d+)/g)];
      const last = all[all.length - 1];
      if (last) {
        newest = Number(last[1]);
        const res = await fetch(`http://127.0.0.1:${newest}/api/health`).catch(() => null);
        if (res && res.ok) return newest;
      }
    }
    await sleep(400);
  }
  return newest;
}

const NOT_FOUND_ROUTE = '/старый-экран';
const GUEST_ROUTES = [
  ['/', 'Главная'],
  ['/builds', 'Билды'],
  ['/tops', 'Топы'],
  ['/threads', 'Ветки'],
  ['/custom-items?group=magic', 'Кастомные: магия'],
  ['/reports', 'Заявки'],
  // Гостем форму заявки не откроют — там короткая просьба войти.
  // Это правильное поведение, а не пустой экран, поэтому сверяем текст.
  ['/reports/new', 'Новая заявка (гость)', 'Нужен вход'],
  ['/tops/kind/skills', 'Топ скиллов'],
  ['/custom-items', 'Кастомные предметы'],
  ['/guides', 'Обучение'],
  ['/coaches', 'Coach'],
  ['/login', 'Вход'],
  ['/register', 'Регистрация'],
  [NOT_FOUND_ROUTE, '404'],
];
async function main() {
  say('');
  say('  DotaCustoms — проверка настоящего окна');
  say('  ' + '─'.repeat(50));

  // отдельный профиль, чтобы не мешать рабочей базе и не ловить блокировку
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dotacustoms-window-'));
  const bin = electronBin();
  say(`  профиль: ${profile}`);
  say(`  порт CDP: ${PORT}`);
  say('');

  const child = spawn(bin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  });

  let cdp = null;
  const cleanup = () => {
    try { cdp && cdp.close(); } catch { /* уже закрыт */ }
    try { child.kill(); } catch { /* уже мёртв */ }
  };

  try {
    const page = await findPage();
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await sleep(1200);

    const state = await evaluate(cdp, PROBE_STATE);
    say('Состояние окна');
    await check('renderer поднялся', async () => {
      assert(state.routes > 0, 'маршруты не зарегистрированы');
      assert(state.heroes > 100, `героев ${state.heroes}`);
      assert(state.items > 300, `предметов ${state.items}`);
      return `${state.heroes} героев, ${state.items} предметов, ${state.routes} маршрутов`;
    });
    await check('база API пришла из preload', async () => {
      assert(/^http:\/\/127\.0\.0\.1:\d+\/api$/.test(state.apiBase || ''), 'apiBase: ' + state.apiBase);
      return state.apiBase;
    });
    await check('Node не просочился в renderer', async () => {
      assert(state.hasNode === false, 'в renderer доступен Node — contextIsolation сломан');
      return 'контекст изолирован';
    });
    await check('иконки лежат локально', async () => {
      assert(state.cdn === 'images', 'cdn: ' + state.cdn + ' (ожидаем images после npm run data:images)');
      return 'meta.cdn = images';
    });
    await check('каталог кастомных предметов загружен', async () => {
      const probe = await evaluate(cdp, `({
        count: (store.customItems || []).length,
        groups: (store.customGroups || []).length,
        patch: store.customPatch,
        first: (store.customItems || [])[0] || null,
      })`);
      assert(probe.count === 30, 'предметов ' + probe.count + ', ожидалось 30');
      assert(probe.groups === 4, 'групп ' + probe.groups + ', ожидалось 4');
      assert(probe.patch === null, 'патч должен быть null: ' + probe.patch);
      assert(probe.first && probe.first.custom === 1, 'нет признака custom');
      return `${probe.count} предметов, ${probe.groups} группы, гайд 3570972414`;
    });

    // иконки кастомных предметов лежат на диске — проверяем через CSP
    const customIcon = await evaluate(cdp, `(async () => {
      const item = store.customItems[0];
      const url = new URL(store.icon(item.img), location.href).href;
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;z-index:99999';
      holder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
        + '<image href="' + url + '" width="64" height="64"></image></svg>';
      document.body.appendChild(holder);
      const img = holder.querySelector('image');
      const deadline = Date.now() + 8000;
      let width = 0;
      while (Date.now() < deadline) {
        width = img.getBoundingClientRect().width;
        if (width > 0) break;
        await new Promise(r => setTimeout(r, 100));
      }
      holder.remove();
      return { url, width, name: item.name };
    })()`);
    await check('иконка кастомного предмета грузится с диска', async () => {
      assert(customIcon.url.startsWith('file:'), 'источник не file://: ' + customIcon.url);
      assert(customIcon.width > 0, 'не отрисовалась — вероятно, запрещена CSP');
      return `${customIcon.name}: ${customIcon.width}px`;
    });

    await check('уведомления и модерация в живой базе', async () => {
      const probe = await evaluate(cdp, `(async () => {
        const roles = await (await fetch(await api.resolveBase() + '/config')).json();
        return {
          topKinds: (roles.top_kinds || []).map(k => k.key),
          talentLevels: roles.talent_levels,
          share: await (await fetch(await api.resolveBase() + '/share')).json(),
        };
      })()`);
      assert(probe.topKinds.length === 3,
        `виды топов: ${probe.topKinds.join(',')} — ожидались герои/нейтралки/скиллы`);
      assert(probe.talentLevels.length === 4, `уровней талантов ${probe.talentLevels.length}`);
      assert(probe.share && probe.share.enabled === false,
        'общий доступ включён по умолчанию — не должен быть');
      return `топы: ${probe.topKinds.join(', ')}; общий доступ выключен`;
    });

    say('');
    say('Ресурсы');
    await check('иконка грузится с диска и проходит CSP', async () => {
      const img = await evaluate(cdp, PROBE_IMAGE);
      assert(img.fileProtocol, 'источник не file://: ' + img.href);
      assert(img.width > 0, 'картинка не отрисовалась — вероятно, запрещена политикой CSP');
      return `${img.width}px, ${img.href.split('/').slice(-2).join('/')}`;
    });

    // заводим аккаунт, чтобы было что открыть в профиле и админке
    const username = 'win' + Date.now().toString(36).slice(-5);
    const reg = await fetch(state.apiBase + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'windowtest1', nickname: 'Оконный' }),
    }).then(r => r.json());
    const token = reg.token;
    await check('регистрация через API приложения', async () => {
      assert(token, 'нет токена: ' + JSON.stringify(reg));
      assert(reg.user.role === 'admin', 'роль: ' + reg.user.role);
      return '@' + reg.user.username + ' (' + reg.user.role + ')';
    });

    // вкладка в том же окне перезагрузится, поэтому токен кладём заранее
    await evaluate(cdp, `api.setToken(${JSON.stringify(token)})`);

    say('');
    say('Экраны (гость)');
    for (const [route, title, expectText] of GUEST_ROUTES) {
      await check(`${title} (#${route})`, () => visitRoute(cdp, route, expectText));
    }

    // перезагружаем окно, чтобы renderer подхватил токен и поднял store.me
    await evaluate(cdp, 'location.reload()');
    await waitFor(cdp, 'window.store && store.ready && !!store.me', 15000);
    const me = await evaluate(cdp, '({ role: store.me.role, name: store.me.username })');
    await check('сессия восстановилась после перезагрузки', async () => {
      assert(me.role === 'admin', 'роль после reload: ' + JSON.stringify(me));
      return '@' + me.name + ' (' + me.role + ')';
    });

    say('');
    say('Экраны (вошедший)');
    for (const [route, title] of [
      ['/builds/new', 'Новый билд'],
      ['/threads/new', 'Новая ветка'],
      ['/create', 'Создать: категории'],
      ['/reports/new', 'Форма заявки'],
      ['/u/' + username, 'Профиль'],
      ['/profile', 'Мой профиль'],
      ['/admin?tab=overview', 'Админка: обзор'],
      ['/admin?tab=queue', 'Админка: очередь'],
      ['/admin?tab=reports', 'Админка: заявки'],
      ['/admin?tab=share', 'Админка: общий доступ'],
      ['/admin?tab=mail', 'Админка: почта'],
      ['/admin?tab=users', 'Админка: пользователи'],
    ]) {
      await check(`${title} (#${route})`, () => visitRoute(cdp, route));
    }

    // Колокольчик уведомлений в живой шапке
    await check('колокольчик уведомлений в шапке', async () => {
      await evaluate(cdp, `location.hash = '#/'`);
      await sleep(500);
      const bell = await evaluate(cdp, `(() => {
        const b = document.querySelector('.notif-bell');
        if (!b) return null;
        return { label: b.getAttribute('aria-label') || '', icon: !!b.querySelector('.bell-icon') };
      })()`);
      assert(bell, 'колокольчик не найден в шапке');
      assert(bell.icon, 'нет иконки внутри колокольчика');
      return bell.label || 'без счётчика';
    });

    say('');
    say('Консоль');
    // 404 от API — ожидаемый ответ на несуществующего пользователя и пустую
    // ленту жалоб, а не поломка; чистые 200 и отсутствие CSP важнее
    const IGNORED = [
      /status of 404 \(Not Found\)/,
      /favicon/i,
    ];
    const problems = cdp.events
      .filter(e => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
      .map(e => `${e.params.entry.level}: ${e.params.entry.text} ${e.params.entry.url || ''}`.trim())
      .concat(cdp.events
        .filter(e => e.method === 'Runtime.exceptionThrown')
        .map(e => 'exception: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)))
      .filter(text => !IGNORED.some(re => re.test(text)));

    await check('в консоли нет ошибок и нарушений CSP', async () => {
      assert(!problems.length, problems.slice(0, 5).join(' | '));
      return 'чисто';
    });
  } finally {
    cleanup();
  }

  // Отдельный профиль: проверка переживания аварийного завершения
  await checkCrashRecovery(bin, fs.mkdtempSync(path.join(os.tmpdir(), 'dotacustoms-crash-')));

  say('');
  say('─'.repeat(52));
  say(`  Пройдено: ${pass}   Провалено: ${fail}`);
  if (failures.length) {
    say('');
    for (const f of failures) say('   • ' + f);
  }
  say('');
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('\n  Проверка не удалась:', err.message);
  process.exit(1);
});
