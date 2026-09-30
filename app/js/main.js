/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — точка входа
   ──────────────────────────────────────────────────────────────────────
   Здесь три вещи: подъём состояния (справочник + сессия), таблица
   маршрутов и мелкие conveniences вроде подсветки активного пункта и
   подсказок о несохранённых правках.

   Порядок важен: сначала store.boot() (иначе экраны не найдут справочник
   героев), потом восстановление сессии, потом первый рендер.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear, $ } = window.ui;

  /* ── таблица маршрутов ───────────────────────────────────────────── */
  function registerRoutes() {
    const V = window.views;

    router.register('/', (host) => V.home.render(host), { title: 'Главная' });

    // билды
    router.register('/builds', (host, _p, q) => V.builds.renderList(host, _p, q), { title: 'Билды' });
    router.register('/builds/new', (host) => V.buildEditor.render(host, {}), { title: 'Новый билд', guard: 'auth' });
    router.register('/builds/:id/edit', (host, p) => V.buildEditor.render(host, p), { title: 'Правка билда', guard: 'auth' });
    router.register('/builds/:id', (host, p) => V.builds.renderDetail(host, p), { title: 'Билд' });

    // топы. Каждая категория (герои, скиллы, нейтралки) — свой раздел,
    // поэтому у списка и редактора есть маршрут с kind.
    router.register('/tops', (host, _p, q) => V.tops.renderList(host, _p, q), { title: 'Топы' });
    router.register('/tops/kind/:kind', (host, p, q) => V.tops.renderList(host, p, q), { title: 'Топ' });
    router.register('/tops/new', (host, _p, q) => V.tops.renderEditor(host, {}, q), { title: 'Новый топ', guard: 'auth' });
    router.register('/tops/:id/edit', (host, p) => V.tops.renderEditor(host, p), { title: 'Правка топа', guard: 'auth' });
    router.register('/tops/:id', (host, p) => V.tops.renderDetail(host, p), { title: 'Топ' });

    // создание — отдельные категории выбора
    router.register('/create', (host, _p, q) => V.create.render(host, _p, q), { title: 'Создать', guard: 'auth' });

    // заявления и жалобы в свободной форме
    router.register('/reports', (host, _p, q) => V.reports.renderList(host, _p, q), { title: 'Заявки' });
    router.register('/reports/new', (host) => V.reports.renderNew(host), { title: 'Новая заявка', guard: 'auth' });

    // ветки
    router.register('/threads', (host, _p, q) => V.threads.renderList(host, _p, q), { title: 'Ветки' });
    router.register('/threads/new', (host) => V.threads.renderEditor(host, {}), { title: 'Новая ветка', guard: 'auth' });
    router.register('/threads/:id/edit', (host, p) => V.threads.renderEditor(host, p), { title: 'Правка ветки', guard: 'auth' });
    router.register('/threads/:id', (host, p) => V.threads.renderDetail(host, p), { title: 'Ветка' });

    // справочник кастомных предметов CHC
    router.register('/custom-items', (host, p, q) => V.customItems.render(host, p, q), { title: 'Кастомные предметы' });

    // обучение
    router.register('/guides', (host, _p, q) => V.guides.renderList(host, _p, q), { title: 'Обучение' });
    router.register('/guides/new', (host) => V.guides.renderEditor(host, {}), { title: 'Новый гайд', guard: 'auth' });
    router.register('/guides/:slug/edit', (host, p) => V.guides.renderEditor(host, p), { title: 'Правка гайда', guard: 'auth' });
    router.register('/guides/:slug', (host, p) => V.guides.renderDetail(host, p), { title: 'Гайд' });

    // профиль
    router.register('/u/:username', (host, p, q) => V.profile.render(host, p, q), { title: 'Профиль' });
    router.register('/profile', (host, p, q) => V.profile.render(host, { username: null }, q), { title: 'Мой профиль' });

    // роли
    router.register('/coaches', (host) => V.coaches.render(host), { title: 'Coach' });
    router.register('/admin', (host, _p, q) => V.admin.render(host, _p, q), { title: 'Админ-панель' });

    // вход / регистрация
    router.register('/login', (host) => {
      if (store.me) { router.go('/'); return; }
      auth.renderLogin(host, 'login');
    }, { title: 'Вход' });
    router.register('/register', (host) => {
      if (store.me) { router.go('/'); return; }
      auth.renderLogin(host, 'register', noticeForRegister());
    }, { title: 'Регистрация' });

    router.setNotFound((host, url) => {
      clear(host);
      host.appendChild(h('div.error-panel', [
        h('div.big', { text: '404' }),
        h('h3', { text: 'Такой страницы нет' }),
        h('p', { text: 'Адрес ' + url.path + ' никто не описал.' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, [
          h('a.btn.btn-primary', { href: '#/', text: 'На главную' }),
          h('a.btn', { href: '#/builds', text: 'К билдам' }),
          h('button.btn.btn-ghost', { type: 'button', text: '← Назад', onclick: () => history.back() }),
        ]),
      ]));
    });

    document.title = 'DotaCustoms';
  }

  /** Подсказка на экране регистрации: пустая база или уже есть игроки. */
  function noticeForRegister() {
    return store.firstRun
      ? 'База пустая — твой аккаунт станет администратором. Запомни пароль, он понадобится для управления хабом.'
      : null;
  }

  /* ── предупреждение о несохранённых правках ──────────────────────── */
  function watchDirtyState() {
    window.addEventListener('beforeunload', e => {
      if (window.__buildEditorDirty && window.__buildEditorDirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* ── удобства ────────────────────────────────────────────────────── */
  // Ctrl/Cmd+K — быстрый переход к билдам
  function wireShortcuts() {
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'k' || e.key === 'л') { e.preventDefault(); router.go('/builds'); }
      else if (e.key === 't' || e.key === 'е') { e.preventDefault(); router.go('/threads'); }
      else if (e.key === 'g' || e.key === 'п') { e.preventDefault(); router.go('/guides'); }
    });
  }

  /* ── запуск ──────────────────────────────────────────────────────── */
  async function boot() {
    const host = $('#view');

    try {
      await store.boot();
    } catch (err) {
      clear(host);
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Локальный сервер не отвечает' }),
        h('p', { text: err && err.message ? err.message : String(err) }),
        h('div.help-note', {
          text: 'Сервер поднимается вместе с приложением на 127.0.0.1. Если ты открыл index.html в браузере — вернись в приложение.',
        }),
        h('div.btn-row', { style: { marginTop: '14px' } },
          h('button.btn.btn-primary', { type: 'button', text: 'Повторить', onclick: () => location.reload() })),
      ]));
      return;
    }

    // сессия: токен мог остаться с прошлого запуска
    store.firstRun = !api.getToken() && await isEmptyHub();
    await store.restoreSession();

    registerRoutes();
    auth.renderHeader();
    auth.renderFooter();
    watchDirtyState();
    wireShortcuts();

    // уходя со страницы редактора, сбрасываем флаг несохранённых правок
    router.setBefore((from, to) => {
      if (from && to && from.path !== to.path) window.__buildEditorDirty = null;
    });

    // сохраняем последний экран, чтобы вернуться на него после входа
    window.addEventListener('hashchange', () => {
      const p = router.parse().path;
      if (p !== '/login' && p !== '/register') store.setPref('lastRoute', p);
    });

    router.start();
  }

  /** База совсем пустая? Тогда первому аккаунту достанется админка. */
  async function isEmptyHub() {
    const res = await api.get('/users?per_page=1');
    return res.ok && (!res.data.items || res.data.items.length === 0);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
