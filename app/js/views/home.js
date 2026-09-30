/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — главная
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  function modeCard(m, stats) {
    return h('a.card', { href: '#/builds?mode=' + m.key }, [
      h('div.meta-row', [h(`span.badge.badge-mode-${m.key}`, { text: m.short || m.title })]),
      h('h3', { text: m.title }),
      h('div.excerpt', { text: m.desc || '' }),
      h('div.foot', [
        h('span', { text: `${stats.builds} ${ui.plural(stats.builds, 'билд', 'билда', 'билдов')}` }),
        h('span.dot', { text: '·' }),
        h('span', { text: `${stats.tops} ${ui.plural(stats.tops, 'топ', 'топа', 'топов')}` }),
        h('span.spacer', { style: { flex: '1' } }),
        h('span', { text: 'Открыть →', style: { color: 'var(--gold-2)' } }),
      ]),
    ]);
  }

  async function render(host) {
    clear(host);
    host.appendChild(h('div.loading-panel', [h('div.spacer'), h('div.spinner'), h('p', { text: 'Собираем хаб…' })]));

    const [builds, threads, guides, statsRes] = await Promise.all([
      api.get('/builds?per_page=6&sort=hot'),
      api.get('/threads?per_page=5&sort=active&status=open'),
      api.get('/guides'),
      api.get('/threads/stats'),
    ]);

    clear(host);

    /* ── шапка ── */
    const m = store.prefs.mode;
    host.appendChild(h('div.panel', [
      h('div.page-head', { style: { marginBottom: '14px' } }, [
        h('div', [
          h('h1', { text: 'DotaCustoms' }),
          h('div.sub', {
            text: 'Билды, топы и ветки по кастомам Custom Hero Chaos и Ratten Run. Всё офлайн, всё на твоём диске.',
          }),
        ]),
        h('div.btn-row', [
          h('a.btn.btn-primary', { href: '#/builds/new', text: '＋ Собрать билд' }),
          h('a.btn', { href: '#/threads/new', text: '⑂ Создать ветку' }),
          h('a.btn.btn-ghost', { href: '#/guides', text: '📘 Гайд для новичка' }),
        ]),
      ]),
      h('div.meta-row', [
        h('span.badge.badge-gold', { text: 'патч ' + (store.patch || '—') }),
        h('span', { text: `${store.heroes.length} героев` }),
        h('span.dot', { text: '·' }),
        h('span', { text: `${store.neutrals.length} нейтралок` }),
        h('span.dot', { text: '·' }),
        h('span', { text: 'справочник встроен, интернет не нужен' }),
      ]),
    ]));

    /* ── режимы ── */
    const contentCounts = {};
    for (const mm of store.config.modes) contentCounts[mm.key] = { builds: 0, tops: 0 };
    for (const b of (builds.data && builds.data.items) || []) {
      if (contentCounts[b.mode]) contentCounts[b.mode].builds++;
    }
    // точные числа берём из обзора, если он доступен (только staff) — иначе показываем то, что видно
    const modesWrap = h('div.grid.grid-2', { style: { marginTop: '18px' } });
    for (const mm of store.config.modes) modesWrap.appendChild(modeCard(mm, contentCounts[mm.key]));
    host.appendChild(h('h2.section-title', { text: 'Кастомы' }));
    host.appendChild(modesWrap);

    /* ── свежие билды ── */
    host.appendChild(h('div.panel', { style: { marginTop: '22px' } }, [
      h('div.panel-title', [
        h('span', { text: '🔥 Горячие билды' }),
        h('span.spacer'),
        h('a.btn.btn-sm.btn-ghost', { href: '#/builds', text: 'Все билды →' }),
      ]),
      (builds.data && builds.data.items && builds.data.items.length)
        ? h('div.grid.grid-2', (builds.data.items.map(b => common.buildCard(b))))
        : common.empty({
          icon: '🛠', title: 'Пока нет ни одного билда',
          text: 'Стань первым: собери сборку предметов и скиллов для CHC или Ratten Run.',
          action: () => router.go('/builds/new'), actionLabel: 'Собрать билд',
        }),
    ]));

    /* ── две колонки: ветки и обучение ── */
    const cols = h('div.grid', { style: { gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', marginTop: '18px' } });

    const byCat = {};
    for (const row of (statsRes.data && statsRes.data.by_category) || []) byCat[row.category] = row.c;
    cols.appendChild(h('div.panel', [
      h('div.panel-title', [
        h('span', { text: '⑂ Открытые ветки' }),
        h('span.spacer'),
        h('a.btn.btn-sm.btn-ghost', { href: '#/threads', text: 'Все ветки →' }),
      ]),
      h('div.meta-row', { style: { marginBottom: '12px' } }, [
        h('span.badge.badge-red', { text: `🐛 ${byCat.bug || 0}` }),
        h('span.badge.badge-yellow', { text: `💡 ${byCat.feature || 0}` }),
        h('span.badge.badge-blue', { text: `⚖️ ${byCat.balance || 0}` }),
      ]),
      (threads.data && threads.data.items && threads.data.items.length)
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, threads.data.items.map(common.threadCard))
        : common.empty({
          icon: '🐛', title: 'Веток пока нет',
          text: 'Нашёл баг или придумал фичу? Заведи ветку — автор кастома всё увидит.',
          action: () => router.go('/threads/new'), actionLabel: 'Создать ветку',
        }),
    ]));

    cols.appendChild(h('div.panel', [
      h('div.panel-title', [
        h('span', { text: '📘 Обучение' }),
        h('span.spacer'),
        h('a.btn.btn-sm.btn-ghost', { href: '#/guides', text: 'Все гайды →' }),
      ]),
      h('div.help-note', [
        h('b', { text: 'Новичок в кастоме? ' }),
        'Начни с короткого руководства: что вообще происходит в CHC и Ratten Run, и как не проиграть на первых минутах.',
      ]),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
        ((guides.data && guides.data.items) || []).slice(0, 6).map(g =>
          h('a.card', { href: '#/guides/' + g.slug, style: { padding: '12px 14px' } }, [
            h('h3', { text: g.title, style: { fontSize: '15px' } }),
            g.summary ? h('div.excerpt', { text: g.summary, style: { WebkitLineClamp: '2' } }) : null,
          ]))
      ),
    ]));

    host.appendChild(cols);

    /* ── кастомные предметы ── */
    // В обычном справочнике Dota их нет, поэтому выносим в отдельный блок
    // с прямым заходом — иначе новичок о них вообще не узнает.
    if ((store.customItems || []).length) {
      const sample = store.customItems.slice(0, 8);
      host.appendChild(h('div.panel', { style: { marginTop: '18px' } }, [
        h('div.panel-title', [
          h('span', { text: '📦 Кастомные предметы' }),
          h('span.spacer'),
          h('span.badge.badge-red', {
            text: store.customPatch
              ? `патч ${store.customPatch}`
              : ((store.customSource && store.customSource.updated)
                ? `гайд ${store.customSource.updated}` : 'без патча'),
          }),
          h('a.btn.btn-sm.btn-ghost', { href: '#/custom-items', text: 'Все предметы →' }),
        ]),
        h('div.help-note', [
          h('b', { text: store.customItems.length + ' предметов, которых нет в обычном Dota. ' }),
          'В каждой карточке — характеристики и подсказка, на какое умение героя предмет похож. '
          + 'Добавляются прямо в слоты билда.',
        ]),
        h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '12px' } },
          sample.map(item => h('a.custom-peek', {
            href: '#/custom-items?group=' + item.group,
            title: item.summary || item.name,
          }, [
            ui.dotaIcon(store.customIcon(item)),
            h('span.nm', { text: item.name }),
          ]))
        ),
      ]));
    }

    /* ── кем стать ── */
    host.appendChild(h('div.panel', { style: { marginTop: '18px' } }, [
      h('div.panel-title', { text: 'Кто здесь кто' }),
      h('div.grid.grid-3', [
        h('div.stat', [h('div.v', { text: '🎮' }), h('div.k', { text: 'Игрок' }),
          h('p', { style: { fontSize: '12.5px', color: 'var(--text-dim)', marginTop: '8px' },
            text: 'Публикует билды и топы, создаёт ветки, голосует.' })]),
        h('div.stat', [h('div.v', { text: '🎖' }), h('div.k', { text: 'Coach' }),
          h('p', { style: { fontSize: '12.5px', color: 'var(--text-dim)', marginTop: '8px' },
            text: 'Проверяет билды и топы: ставит метку «подтверждено». Ведёт обучение.' })]),
        h('div.stat', [h('div.v', { text: '🛡' }), h('div.k', { text: 'Админ' }),
          h('p', { style: { fontSize: '12.5px', color: 'var(--text-dim)', marginTop: '8px' },
            text: 'Выдаёт роли, разбирает жалобы, удаляет мусор и ведёт журнал модерации.' })]),
      ]),
      store.me ? null : h('div.help-note', { style: { marginTop: '14px' } }, [
        h('b', { text: 'Первый зарегистрированный аккаунт становится администратором. ' }),
        h('a', { href: '#/register', text: 'Зарегистрироваться', style: { color: 'var(--gold-2)' } }),
        ' — это займёт полминуты.',
      ]),
    ]));
  }

  window.views = window.views || {};
  window.views.home = { render };
})();
