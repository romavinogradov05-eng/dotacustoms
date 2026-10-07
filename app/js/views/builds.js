/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — билды: список и страница билда
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /* ── отрисовка сборки предметов ───────────────────────────────────── */
  function itemsBlock(build) {
    const list = build.items || [];
    if (!list.length) return h('div.empty', [h('p', { text: 'Предметы не указаны' })]);
    const grid = h('div.slot-grid');
    for (const entry of list) {
      const item = store.anyItemById(entry.item_id);
      if (!item) continue;
      const noteBits = [item.sub, entry.note, picker.costText(item)].filter(Boolean);
      grid.appendChild(h('div.slot', {
        title: [picker.displayName(item)].concat(noteBits).join(' — '),
        onclick: () => picker.showCard(item, 'item'),
      }, [
        ui.dotaIcon(store.icon(item.img)),
        entry.note ? h('div.info', [h('span.sub', { text: entry.note })] ) : null,
      ]));
    }
    return grid;
  }

  /* ── раскладка скиллов ────────────────────────────────────────────── */
  function skillsBlock(build) {
    const list = build.skills || [];
    if (!list.length) return h('div.empty', [h('p', { text: 'Скиллы не выбраны' })]);
    const wrap = h('div.skill-order');
    const maxRank = Math.max(...list.map(s => s.rank || 1), 1);
    const sorted = list.slice().sort((a, b) => (a.rank || 1) - (b.rank || 1));
    for (const entry of sorted) {
      const ability = store.abilityById.get(entry.ability_id);
      if (!ability) continue;
      const cell = h('div.sk', {
        title: picker.displayName(ability),
        onclick: () => picker.showCard(ability, 'ability'),
      }, [
        h('span.lvl', { text: `ур. ${entry.rank}` }),
        ability.img ? ui.dotaIcon(store.abilityIcon(ability)) : h('span.icon'),
      ]);
      wrap.appendChild(cell);
    }
    if (!wrap.children.length) return h('div.empty', [h('p', { text: 'Способности не найдены в справочнике' })]);
    const legend = h('div.field-hint', {
      text: `Максимальный уровень прокачки в билде: ${maxRank}`,
    });
    return h('div', [wrap, legend]);
  }

  /* ── таланты ─────────────────────────────────────────────────────── */
  function talentsBlock(build) {
    const ids = (build.talents || []).filter(Boolean);
    if (!ids.length) return h('div.empty', [h('p', { text: 'Таланты не выбраны' })]);
    const list = h('div.talent-list');
    for (const id of ids) {
      const talent = store.abilityById.get(id);
      if (!talent) continue;
      list.appendChild(h('div.talent-row.chosen', [
        h('span.lvl', { text: '★' }),
        h('span.txt', { text: picker.displayName(talent) }),
      ]));
    }
    return list;
  }

  /* ── нейтралки ───────────────────────────────────────────────────── */
  function neutralsBlock(build) {
    const list = build.neutrals || [];
    if (!list.length) return h('div.empty', [h('p', { text: 'Нейтральные предметы не указаны' })]);
    const grid = h('div.slot-grid');
    for (const entry of list) {
      const n = store.neutralById.get(entry.neutral_id);
      if (!n) continue;
      const name = n.name_en || n.name || '';
      grid.appendChild(h('div.slot', {
        title: entry.note ? name + ' — ' + entry.note : name,
        onclick: () => picker.showCard(n, 'neutral'),
      }, [
        ui.dotaIcon(store.neutralIcon(n)),
      ]));
    }
    return grid;
  }

  /* ══════════════════════════════════════════════════════════════════
     Список билдов
     ══════════════════════════════════════════════════════════════════ */
  async function renderList(host, _params, query) {
    clear(host);
    const state = {
      mode: query.mode || (store.prefs.mode === 'all' ? '' : store.prefs.mode) || '',
      hero_id: query.hero_id || '',
      sort: query.sort || store.prefs.buildSort || 'new',
      q: query.q || '',
      page: Number(query.page) || 1,
      mine: query.mine === '1',
    };
    if (query.author) state.author = query.author;

    const head = h('div.page-head', [
      h('h1', { text: 'Билды' }),
      h('div.sub', { text: 'Сборки предметов, порядок скиллов и таланты. Подтверждённые отмечены значком Coach.' }),
      store.isStaff() ? h('div.btn-row', h('a.btn.btn-primary', { href: '#/builds/new', text: '＋ Собрать билд' })) : null,
    ]);
    host.appendChild(head);

    if (state.author) {
      host.appendChild(h('div.help-note', [
        'Показаны билды игрока ',
        h('b', { text: state.author }),
        ' ',
        h('a', { href: '#/builds', text: 'сбросить', style: { color: 'var(--gold-2)' } }),
      ]));
    }

    /* фильтры */
    const heroSelect = common.selectField('Герой', [['', 'Все герои']].concat(
      store.heroes.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(hero => [String(hero.id), hero.name])
    ), state.hero_id, v => { state.hero_id = v; state.page = 1; draw(); });

    const filters = h('div.filters', [
      common.inputField('Поиск', {
        value: state.q, grow: true,
        placeholder: 'название или описание билда…',
        onInput: v => { state.q = v; state.page = 1; draw(); },
      }),
      heroSelect,
      common.selectField('Сортировка', [
        ['new', 'Новые'], ['hot', 'Популярные'], ['verified', 'Сначала проверенные'], ['discussed', 'Обсуждаемые'],
      ], state.sort, v => { state.sort = v; store.setPref('buildSort', v); state.page = 1; draw(); }),
      state.mine ? h('div.field', [h('label', { text: 'Мои' }), h('span.badge.badge-gold', { text: 'только мои' })]) : null,
    ]);
    host.appendChild(filters);

    const modes = common.modeTabs(state.mode, v => { state.mode = v; state.page = 1; draw(); });
    host.appendChild(modes);

    const listHost = h('div');
    host.appendChild(listHost);

    async function draw() {
      clear(listHost);
      listHost.appendChild(h('div.loading-panel', { style: { padding: '60px 0' } }, h('div.spinner')));
      const qs = new URLSearchParams();
      if (state.mode) qs.set('mode', state.mode);
      if (state.hero_id) qs.set('hero_id', state.hero_id);
      if (state.sort) qs.set('sort', state.sort);
      if (state.q) qs.set('q', state.q);
      if (state.author) qs.set('author', state.author);
      if (state.mine && store.me) qs.set('author', store.me.username);
      qs.set('page', state.page);
      qs.set('per_page', '18');

      const res = await api.get('/builds?' + qs.toString());
      clear(listHost);
      if (!res.ok) {
        listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Не удалось загрузить билды' }));
        return;
      }
      if (!res.data.items.length) {
        listHost.appendChild(common.empty({
          icon: '🛠',
          title: 'Ничего не нашлось',
          text: 'Попробуй снять фильтры или собери первый билд по этому герою.',
          action: () => router.go('/builds/new'), actionLabel: 'Собрать билд',
        }));
        return;
      }
      const grid = h('div.grid.grid-2');
      for (const b of res.data.items) grid.appendChild(common.buildCard(b));
      listHost.appendChild(grid);
      listHost.appendChild(common.pager({
        page: res.data.page, pages: res.data.pages,
        onGo: p => { state.page = p; draw(); },
      }));
      listHost.appendChild(h('div.field-hint', {
        style: { textAlign: 'center' },
        text: `Всего ${res.data.total} ${ui.plural(res.data.total, 'билд', 'билда', 'билдов')}`,
      }));
    }

    await draw();
  }

  /* ══════════════════════════════════════════════════════════════════
     Страница билда
     ══════════════════════════════════════════════════════════════════ */
  async function renderDetail(host, params) {
    clear(host);
    host.appendChild(h('div.loading-panel', [h('div.spinner'), h('p', { text: 'Открываем билд…' })]));

    const res = await api.get('/builds/' + encodeURIComponent(params.id));
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Билд не открылся' }),
        h('p', { text: (res.data && res.data.error) || 'Возможно, он удалён или скрыт' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/builds', text: '← К списку' })),
      ]));
      return;
    }
    const build = res.data.build;
    const comments = res.data.comments || [];
    const hero = build.hero_id ? store.heroById.get(build.hero_id) : null;

    /* ── заголовок ── */
    host.appendChild(h('div.page-head', [
      h('div', [
        h('div.meta-row', [
          common.modeBadge(build.mode),
          common.draftBadge(build),
          common.verifyBadge(build),
          build.patch ? h('span.badge.badge-grey', { text: 'патч ' + build.patch }) : null,
        ]),
        h('h1', { text: build.title }),
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: '#/builds', text: '← Все билды' }),
        build.can_edit ? h('a.btn', { href: '#/builds/' + build.id + '/edit', text: '✎ Редактировать' }) : null,
        build.can_delete ? h('button.btn.btn-danger', {
          type: 'button', text: 'Удалить',
          onclick: () => deleteBuild(build, () => router.go('/builds')),
        }) : null,
        common.flagButton({ targetType: 'build', targetId: build.id }),
      ]),
    ]));

    const main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });

    /* ── герой и описание ── */
    main.appendChild(h('div.panel', [
      hero ? h('div.hero-banner', [
        h('img.hero-portrait', { src: store.heroIcon(hero), alt: '' }),
        h('div', [
          h('div.hero-name', {
            text: hero.name_en || hero.name,
            title: hero.name_en && hero.name_en !== hero.name ? hero.name : null,
          }),
        ]),
      ]) : h('div.help-note', { text: 'Герой не указан — билд подходит любому персонажу.' }),
      build.description ? h('div.md', { html: md.render(build.description), style: { marginTop: '14px' } }) : null,
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '🧰 Предметы' })]),
      itemsBlock(build),
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '⚡ Скиллы' })]),
      skillsBlock(build),
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '★ Таланты' })]),
      talentsBlock(build),
    ]));

    if (build.mode === 'rr' || (build.neutrals || []).length) {
      main.appendChild(h('div.panel', [
        h('div.panel-title', [h('span', { text: '🍃 Нейтральные предметы' })]),
        neutralsBlock(build),
      ]));
    }

    /* ── сайдбар: автор ── */
    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Автор' }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
        auth.avatarNode(build.author, 'avatar-lg'),
        h('div', [
          h('a', {
            href: '#/u/' + encodeURIComponent(build.author.username),
            text: build.author.nickname,
            style: { fontWeight: '700', color: 'var(--text)', textDecoration: 'none' },
          }),
          h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: '@' + build.author.username }),
        ]),
        auth.roleBadge(build.author),
      ]),
      h('dl.kv', { style: { marginTop: '14px' } }, [
        h('dt', { text: 'Создан' }), h('dd', { text: build.updated_ago || '—' }),
        h('dt', { text: 'Просмотры' }), h('dd', { text: String(build.views || 0) }),
      ]),
    ]));

    /* ── сайдбар: голос ── */
    const voteHost = h('div');
    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Оценка' }),
      voteHost,
    ]));

    function drawVote() {
      clear(voteHost);
      voteHost.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } }, [
        common.voteBox({
          score: build.likes || 0,
          my: build.my_vote || 0,
          onVote: {
            url: `/builds/${build.id}/vote`,
            onDone: value => {
              const before = build.my_vote > 0 || build.my_vote < 0;
              const after = value > 0 || value < 0;
              if (!before && after) build.likes = (build.likes || 0) + 1;
              else if (before && !after) build.likes = Math.max(0, (build.likes || 0) - 1);
              build.my_vote = value;
              drawVote();
            },
          },
        }),
        h('div', [
          h('div', { style: { fontWeight: '700' }, text: `${build.likes || 0} ${ui.plural(build.likes || 0, 'голос', 'голоса', 'голосов')}` }),
          h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: 'Отметь билд, если он реально работает' }),
        ]),
      ]));
      if (build.verified) {
        voteHost.appendChild(h('div.field-hint', {
          style: { marginTop: '12px' },
          text: `✓ Подтверждено ${build.verified_by ? build.verified_by.nickname : 'Coach'}${build.verify_note ? ': ' + build.verify_note : ''}`,
        }));
      }
      if (build.can_verify) {
        voteHost.appendChild(h('div.btn-row', { style: { marginTop: '12px' } },
          build.verified
            ? h('button.btn.btn-sm', {
              type: 'button', text: 'Снять подтверждение',
              onclick: () => verifyBuild(build, false, drawVote),
            })
            : h('button.btn.btn-primary.btn-sm', {
              type: 'button', text: '✓ Подтвердить билд',
              onclick: () => verifyBuild(build, true, drawVote),
            })));
      }
    }
    drawVote();

    /* ── комментарии ── */
    const commentsHost = h('div.panel', [
      h('div.panel-title', [h('span', { text: `💬 Обсуждение (${comments.length})` })]),
    ]);
    const list = h('div.msg-list');
    commentsHost.appendChild(list);
    for (const c of comments) list.appendChild(commentNode(build, c, () => renderDetail(host, params)));

    const composer = h('div.composer');
    if (store.me) {
      const area = h('textarea.textarea', { placeholder: 'Напиши, что думаешь о билде…', maxlength: 2000 });
      composer.appendChild(area);
      composer.appendChild(h('div.composer-row', h('button.btn.btn-primary', {
        type: 'button', text: 'Отправить',
        onclick: async e => {
          const body = area.value.trim();
          if (!body) { ui.err('Пустое сообщение не отправится'); return; }
          e.target.disabled = true;
          const r = await api.post(`/builds/${build.id}/comments`, { body: { body } });
          e.target.disabled = false;
          if (!r.ok) { ui.apiError(r, 'Комментарий не отправился'); return; }
          ui.ok('Комментарий добавлен');
          renderDetail(host, params);
        },
      })));
    } else {
      composer.appendChild(h('div.help-note', [
        h('a', { href: '#/login', text: 'Войди', style: { color: 'var(--gold-2)' } }),
        ', чтобы оставить комментарий.',
      ]));
    }
    commentsHost.appendChild(composer);
    main.appendChild(commentsHost);

    host.appendChild(h('div.build-layout', [main, side]));
  }

  function commentNode(build, c, reload) {
    return h('div.msg' + (store.me && store.me.id === c.author.id ? '.mine' : ''), [
      auth.avatarNode(c.author, 'avatar-sm'),
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.head', [
          h('span.nick', { text: c.author.nickname }),
          auth.roleBadge(c.author),
          h('span.time', { text: c.ago }),
          h('div.tools', [
            c.can_delete ? h('button.icon-btn', {
              type: 'button', title: 'Удалить', text: '✕', style: { fontSize: '12px' },
              onclick: async () => {
                const yes = await ui.confirm({ title: 'Удалить комментарий?', text: 'Действие необратимо.', okLabel: 'Удалить', kind: 'danger' });
                if (!yes) return;
                const r = await api.delete(`/builds/${build.id}/comments/${c.id}`);
                if (!r.ok) { ui.apiError(r, 'Не удалилось'); return; }
                ui.ok('Комментарий удалён');
                reload();
              },
            }) : null,
          ]),
        ]),
        h('div.body.md', { html: md.render(c.body) }),
      ]),
    ]);
  }

  async function deleteBuild(build, onDone) {
    const yes = await ui.confirm({
      title: 'Удалить билд?',
      text: `«${build.title}» исчезнет для всех. Отменить не получится.`,
      okLabel: 'Удалить', kind: 'danger',
    });
    if (!yes) return;
    const res = await api.delete('/builds/' + build.id);
    if (!res.ok) { ui.apiError(res, 'Не удалось удалить'); return; }
    store.dropCache('/builds');
    ui.ok('Билд удалён');
    if (onDone) onDone();
  }

  function verifyBuild(build, verified, onDone) {
    const note = h('input.input', { placeholder: 'Комментарий проверки (необязательно)', maxlength: 300 });
    ui.modal({
      title: verified ? 'Подтвердить билд' : 'Снять подтверждение',
      body: h('div', [
        h('p', {
          style: { marginBottom: '12px' },
          text: verified
            ? 'Метка Coach значит, что билд проверен и работает. Ставь её, только если сам проверил сборку.'
            : 'Метка «подтверждено» будет снята.',
        }),
        verified ? h('div.field', [h('label', { text: 'Заметка' }), note]) : null,
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Готово', kind: 'primary',
          onClick: async () => {
            const res = await api.post(`/builds/${build.id}/verify`, {
              body: { verified, note: note.value.trim() || null },
            });
            if (!res.ok) { ui.apiError(res, 'Не получилось'); return false; }
            ui.ok(verified ? 'Билд подтверждён' : 'Подтверждение снято');
            if (onDone) onDone();
          },
        },
      ],
    });
  }

  window.views = window.views || {};
  window.views.builds = { renderList, renderDetail, itemsBlock, skillsBlock, talentsBlock, neutralsBlock, deleteBuild, verifyBuild };
})();
