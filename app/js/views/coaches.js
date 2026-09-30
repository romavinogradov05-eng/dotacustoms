/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — раздел Coach
   ──────────────────────────────────────────────────────────────────────
   Coach — это роль, которая проверяет билды и топы: ставит метку
   «подтверждено» и ведёт обучение по своему режиму. Здесь — витрина
   тренеров, объяснение, что даёт роль, и очередь непроверенного.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  async function render(host) {
    clear(host);
    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Coach' }),
      h('div.sub', { text: 'Тренеры кастомов: проверяют билды, ведут топы и учат новичков.' }),
    ]));

    /* ── объяснение роли ── */
    host.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: 'Что делает Coach' })]),
      h('div.grid.grid-3', [
        h('div', [
          h('div', { style: { fontWeight: '700', color: 'var(--gold-2)', marginBottom: '6px' }, text: '✓ Проверяет сборки' }),
          h('p', { style: { fontSize: '13.5px', color: 'var(--text-dim)' },
            text: 'Открывает билд, смотрит, работает ли он на текущем патче, и ставит метку «подтверждено». Непроверенные билды тоже полезны, но помеченные — проверены.' }),
        ]),
        h('div', [
          h('div', { style: { fontWeight: '700', color: 'var(--gold-2)', marginBottom: '6px' }, text: '⑂ Ведёт ветки' }),
          h('p', { style: { fontSize: '13.5px', color: 'var(--text-dim)' },
            text: 'Меняет статус бага (подтверждён / исправлен / отклонён), закрепляет важные темы, закрывает ветки после фикса.' }),
        ]),
        h('div', [
          h('div', { style: { fontWeight: '700', color: 'var(--gold-2)', marginBottom: '6px' }, text: '📘 Пишет гайды' }),
          h('p', { style: { fontSize: '13.5px', color: 'var(--text-dim)' },
            text: 'Официальные гайды по обучению правят Coach и администратор. Именно отсюда новичок узнаёт, как играть в кастом.' }),
        ]),
      ]),
      h('div.help-note', { style: { marginTop: '14px' } }, [
        h('b', { text: 'Как стать Coach? ' }),
        'Роль выдаёт администратор — обычно после того, как ты несколько билдов опубликовал, и они оказались не мусором. У Coach есть область: ',
        h('b', { text: 'CHC' }), ', ', h('b', { text: 'Ratten Run' }),
        ' или оба сразу.',
      ]),
    ]));

    /* ── витрина ── */
    const listHost = h('div');
    host.appendChild(h('h2.section-title', { text: '🎖 Тренеры' }));
    host.appendChild(listHost);

    const res = await api.get('/users?role=coach&per_page=60');
    if (!res.ok) {
      listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Не удалось загрузить список' }));
      return;
    }
    const coaches = res.data.items || [];
    if (!coaches.length) {
      listHost.appendChild(common.empty({
        icon: '🎖',
        title: 'Coach ещё не назначены',
        text: 'Как только администратор выдаст роль кому-то из игроков, здесь появится витрина тренеров.',
        action: store.isAdmin() ? () => router.go('/admin?tab=users') : null,
        actionLabel: 'Назначить (админ)',
      }));
    } else {
      const grid = h('div.grid.grid-3');
      for (const c of coaches) {
        const scopes = c.coach_scopes || [];
        grid.appendChild(h('a.card', { href: '#/u/' + encodeURIComponent(c.username) }, [
          h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, [
            auth.avatarNode(c, 'avatar-lg'),
            h('div', [
              h('h3', { text: c.nickname, style: { fontSize: '16px' } }),
              h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: '@' + c.username }),
            ]),
          ]),
          h('div.pill-list', [
            scopes.includes('*')
              ? h('span.badge.badge-blue', { text: 'оба режима' })
              : scopes.map(sc => h(`span.badge.badge-mode-${sc}`, { text: store.modeTitle(sc) })),
          ].flat()),
          c.bio ? h('div.excerpt', { text: c.bio }) : null,
          h('div.foot', [h('span', { text: `в хабе ${ui.ago(c.created_at)}` })]),
        ]));
      }
      listHost.appendChild(grid);
    }

    /* ── что делать Coach-у прямо сейчас ── */
    if (store.isCoach()) {
      host.appendChild(h('h2.section-title', { text: '🛠 Твоя очередь' }));
      host.appendChild(h('div.panel', [
        h('p', { style: { color: 'var(--text-dim)', marginBottom: '14px' } },
          'Смотри билды и топы, которые ещё не подтверждены, и открытые баги в твоих режимах.'),
        h('div.btn-row', [
          h('a.btn.btn-primary', { href: '#/builds?sort=verified', text: '🧰 Билды без проверки' }),
          h('a.btn.btn-primary', { href: '#/threads?status=open', text: '🐛 Открытые баги' }),
          h('a.btn', { href: '#/guides', text: '📘 Гайды' }),
          h('a.btn.btn-ghost', { href: '#/builds?sort=verified', text: 'Топы без проверки →' }),
        ]),
      ]));
    }

    /* ── что делать новичку ── */
    host.appendChild(h('h2.section-title', { text: '🧭 С чего начать' }));
    host.appendChild(h('div.panel', [
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
        step('1', 'Прочитай гайд «Старт»', 'Десять минут, чтобы понять правила и кто есть кто.',
          '#/guides', 'Открыть'),
        step('2', 'Выбери режим', 'CHC — хаос и таланты, Ratten Run — лабиринт и экономика. Определись, что тебе ближе.',
          '#/builds', 'Смотреть билды'),
        step('3', 'Собери свой билд', 'Предметы, порядок скиллов, таланты. Сохрани как черновик, доработай, потом открой.',
          '#/builds/new', 'Собрать билд'),
        step('4', 'Найди баг', 'Наткнулся на проблему в кастоме? Заведи ветку — это главный способ сделать кастом лучше.',
          '#/threads/new', 'Создать ветку'),
      ]),
    ]));
  }

  function step(n, title, text, href, cta) {
    return h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-start' } }, [
      h('div', {
        style: {
          width: '34px', height: '34px', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)', fontSize: '16px', color: '#14100a',
          background: 'linear-gradient(180deg, var(--gold-2), var(--gold-3))',
          clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))',
        },
        text: n,
      }),
      h('div', { style: { flex: '1' } }, [
        h('div', { style: { fontWeight: '700', fontSize: '15px' }, text: title }),
        h('div', { style: { fontSize: '13.5px', color: 'var(--text-dim)' }, text }),
      ]),
      h('a.btn.btn-sm.btn-ghost', { href, text: cta }),
    ]);
  }

  window.views = window.views || {};
  window.views.coaches = { render };
})();
