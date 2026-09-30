/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — «Создать»: выбор категории
   ──────────────────────────────────────────────────────────────────────
   Пользователь просил, чтобы создание билда, топа, ветки и прочего было
   отдельными категориями выбора, а не одной кнопкой «+ Билд». Здесь
   каждая сущность — своя плитка, ведущая в свой редактор.

   Топы разделены по категориям (герои, скиллы, нейтралки), потому что
   это разные справочники и разные наборы позиций.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /** Категории создания. kind=null — выбор режима внутри редактора. */
  function categories() {
    const kinds = store.config.top_kinds || [];
    const list = [
      {
        key: 'build', icon: '🧰', title: 'Сборка билда',
        text: 'Предметы, порядок скиллов, таланты и нейтралки для одного героя.',
        href: '/builds/new',
      },
    ];

    for (const k of kinds) {
      list.push({
        key: `top-${k.key}`, icon: k.icon, title: `Топ: ${k.title.toLowerCase()}`,
        text: TOP_HINT[k.key] || 'Список с тирами и позициями.',
        href: `/tops/new?kind=${k.key}`,
        kind: k.key,
      });
    }

    list.push(
      {
        key: 'thread', icon: '⑂', title: 'Ветка (баг или фича)',
        text: 'Обсуждение в стиле Discord: баг, предложение, баланс или общение.',
        href: '/threads/new',
      },
      {
        key: 'guide', icon: '📘', title: 'Гайд или статья',
        text: 'Разбор механики, инструкция для новичков, свои заметки.',
        href: '/guides/new',
      },
      {
        key: 'report', icon: '📨', title: 'Заявление или жалоба',
        text: 'Свободная форма: тема и текст. Уходит администратору, решение приходит в уведомления и на почту.',
        href: '/reports/new',
      },
    );

    return list;
  }

  const TOP_HINT = {
    heroes: 'Каких героев стоит брать в первую очередь в CHC или Ratten Run.',
    neutrals: 'Какие нейтралки выгоднее покупать на линии и в лесу.',
    skills: 'Какие способности героев решают игру.',
  };

  async function render(host, _params, query) {
    clear(host);

    if (!store.me) {
      host.appendChild(common.empty({
        icon: '🔒', title: 'Нужен вход',
        text: 'Создавать билды, топы и заявки можно только после входа.',
        actionHref: '/register', actionLabel: 'Зарегистрироваться',
      }));
      return;
    }

    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Создать' }),
      h('div.sub', {
        text: 'Выбери, что именно хочешь добавить. Каждая категория — '
          + 'отдельный редактор со своими правилами.',
      }),
    ]));

    // Режим можно выбрать заранее — тогда редактор откроется уже с ним.
    if (query.mode) {
      host.appendChild(common.modeTabs(query.mode, m => {
        router.go(m ? `/create?mode=${m}` : '/create');
      }));
    }

    const grid = h('div.create-grid');
    for (const c of categories()) {
      grid.appendChild(h('a.create-card', {
        href: '#' + c.href + (query.mode ? `&mode=${query.mode}` : ''),
      }, [
        h('div.create-icon', { text: c.icon }),
        h('div.info', [
          h('h3', { text: c.title }),
          h('div.sub', { text: c.text }),
        ]),
        h('span.create-go', { text: '→' }),
      ]));
    }
    host.appendChild(grid);

    // Что будет после отправки — чтобы не было сюрпризов.
    const isCoach = store.me.role === 'coach' || store.me.role === 'admin';
    host.appendChild(h('div.panel', { style: { marginTop: '22px' } }, [
      h('div.panel-title', { text: 'Что будет после отправки' }),
      h('div.help-note', [
        h('b', { text: 'Правило подтверждения. ' }),
        'Билд и топ от обычного игрока уходят администратору на подтверждение '
        + 'и появляются в общем списке только после его решения. Coach '
        + 'и администратор публикуют сразу, без ожидания.',
      ]),
      h('div.help-note', { style: { marginTop: '8px' } }, [
        h('b', { text: 'Твоя роль. ' }),
        isCoach
          ? 'Как Coach ты публикуешь сам: твои билды и топы видны всем сразу.'
          : 'Сейчас ты обычный игрок. Пока админ не подтвердит, контент видишь '
            + 'только ты — так его и можно спокойно исправлять.',
      ]),
      h('div.help-note', { style: { marginTop: '8px' } }, [
        h('b', { text: 'Как приходит ответ. ' }),
        'Решение придёт в уведомления — колокольчик в шапке — и письмом на '
        + 'почту из профиля. Без почты останется только колокольчик. ',
        !isCoach ? h('a', { href: '/profile', text: 'Указать почту →' }) : null,
      ]),
    ]));

    // Свои заявки — видно, что с ними.
    const mine = await api.get('/reports/mine');
    if (mine.ok && mine.data && mine.data.items && mine.data.items.length) {
      const statuses = (mine.data.statuses) || {};
      host.appendChild(h('div.panel', { style: { marginTop: '18px' } }, [
        h('div.panel-title', [
          h('span', { text: '📬 Мои заявления' }),
          h('span.spacer'),
          h('a.btn.btn-sm.btn-ghost', { href: '/reports/new', text: 'Новая заявление →' }),
        ]),
        h('div.entry-list', mine.data.items.map(r => h('div.entry-row', [
          h('div.info', [
            h('span.nm', { text: r.subject }),
            h('span.note', { text: r.admin_note || `отправлено ${ui.ago(r.created_at)}` }),
          ]),
          h(`span.badge.badge-${(statuses[r.status] || {}).color || 'grey'}`, {
            text: (statuses[r.status] || {}).title || r.status,
          }),
        ]))),
      ]));
    }
  }

  window.views = window.views || {};
  window.views.create = { render };
})();
