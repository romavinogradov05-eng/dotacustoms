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
        text: 'Создавать контент и подавать заявки можно только после входа.',
        actionHref: '/register', actionLabel: 'Зарегистрироваться',
      }));
      return;
    }

    // Билды, топы, ветки и гайды создают только Coach и администраторы.
    // Обычному игроку доступна только заявка — и это нормально: голоса,
    // комментарии, жалобы и ответы в ветках остаются за всеми.
    const staff = store.isStaff();

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
      if (!staff && c.key !== 'report') continue; // игроку — только заявления
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
    host.appendChild(h('div.panel', { style: { marginTop: '22px' } }, [
      h('div.panel-title', { text: 'Кто что может' }),
      h('div.help-note', [
        h('b', { text: 'Правило простое. ' }),
        'Билды, топы, ветки и гайды создают Coach и администраторы — и всё '
        + 'опубликованное видно всем сразу, без очереди проверки. Обычный игрок '
        + 'участвует голосами, комментариями, ответами в ветках, жалобами и '
        + 'заявлениями.',
      ]),
      h('div.help-note', { style: { marginTop: '8px' } }, [
        h('b', { text: 'Твоя роль. ' }),
        staff
          ? 'Ты публикуешь сам: твои билды, топы, ветки и гайды видны всем сразу.'
          : 'Сейчас ты обычный игрок: создавать контент могут Coach и админы. '
            + 'Нужна своя тема — подай заявление, его разберёт администратор.',
      ]),
      h('div.help-note', { style: { marginTop: '8px' } }, [
        h('b', { text: 'Как приходит ответ. ' }),
        'Решение по заявлению придёт в уведомления — колокольчик в шапке — и письмом на '
        + 'почту из профиля. Без почты останется только колокольчик. ',
        !staff ? h('a', { href: '/profile', text: 'Указать почту →' }) : null,
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
