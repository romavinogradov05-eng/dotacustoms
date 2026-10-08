/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — топы героев, нейтралок и скиллов
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /** Ссылка на сущность топа (герой / нейтралка / способность). */
  function refEntry(kind, refId) {
    if (kind === 'heroes') return store.heroById.get(refId);
    if (kind === 'neutrals') return store.neutralById.get(refId);
    return store.abilityById.get(refId);
  }

  function refIcon(kind, ref) {
    if (!ref) return h('span.icon');
    if (kind === 'heroes') {
      return h('img.icon.round', { src: store.heroIcon(ref), alt: '' });
    }
    return ui.dotaIcon(store.icon(ref.img));
  }

  function refName(kind, ref) {
    if (!ref) return '—';
    if (kind === 'heroes' || kind === 'neutrals') return ref.name_en || ref.name || ref.key;
    return picker.displayName(ref);
  }

  /* ══════════════════════════════════════════════════════════════════
     Список
     ══════════════════════════════════════════════════════════════════ */
  /** Пояснение к каждой категории — зачем она нужна. */
  const KIND_DESC = {
    heroes: 'Каких героев стоит брать в первую очередь. Порядок и тир S…D.',
    neutrals: 'Какие нейтралки выгоднее покупать: на линии, в лесу, за легендарными.',
    skills: 'Какие способности героев решают игру, а какие можно не брать.',
  };

  async function renderList(host, params, query) {
    clear(host);
    // Каждая категория — свой раздел: /tops/kind/heroes и так далее.
    // Пользователь просил, чтобы топы героев, скиллов и нейтралок были
    // отдельными категориями, а не одним списком с фильтром.
    const routeKind = params && params.kind ? params.kind : '';
    const state = {
      // Топы открываются сразу в «Все режимы»: раньше применялся сохранённый
      // prefs.mode ('chc') и пользователь видел только CHC, даже не зная про фильтр.
      mode: query.mode || '',
      kind: routeKind || query.kind || '',
      sort: query.sort || 'new',
      q: query.q || '',
      page: Number(query.page) || 1,
    };
    if (query.author) state.author = query.author;

    const kindMeta = state.kind
      ? (store.config.top_kinds || []).find(k => k.key === state.kind)
      : null;

    // Категории отдельными вкладками — видно, что их три, и какая открыта.
    const kindTabs = h('div.tabs');
    for (const k of [].concat(store.config.top_kinds || [])) {
      kindTabs.appendChild(h(`button.tab${state.kind === k.key ? '.active' : ''}`, {
        type: 'button', text: `${k.icon || ''} ${k.title}`.trim(),
        onclick: () => {
          const qs = new URLSearchParams();
          if (state.mode) qs.set('mode', state.mode);
          qs.set('page', '1');
          router.go(`/tops/kind/${k.key}${qs.toString() ? '?' + qs : ''}`);
        },
      }));
    }
    kindTabs.appendChild(h(`button.tab${!state.kind ? '.active' : ''}`, {
      type: 'button', text: 'Все категории',
      onclick: () => { state.kind = ''; state.page = 1; draw(); drawKindTabs(); },
    }));

    function drawKindTabs() {
      [...kindTabs.children].forEach((el, i) => {
        const keys = (store.config.top_kinds || []).map(k => k.key).concat(['']);
        el.classList.toggle('active', keys[i] === state.kind);
      });
    }

    host.appendChild(h('div.page-head', [
      h('h1', { text: kindMeta ? kindMeta.title : 'Топы' }),
      h('div.sub', {
        text: kindMeta
          ? KIND_DESC[kindMeta.key] || 'Список с тирами, отсортированный по силе.'
          : 'Персонажи, нейтралки и скиллы, отсортированные по силе. Мнение сообщества, подтверждённое Coach.',
      }),
      store.isStaff() ? h('div.btn-row', h('a.btn.btn-primary', {
        href: '#/tops/new' + (state.kind ? `?kind=${state.kind}` : ''),
        text: kindMeta ? `＋ Собрать: ${kindMeta.title.toLowerCase()}` : '＋ Собрать топ',
      })) : null,
    ]));

    if (state.author) {
      host.appendChild(h('div.help-note', [
        'Показаны топы игрока ', h('b', { text: state.author }), ' ',
        h('a', { href: '#/tops', text: 'сбросить', style: { color: 'var(--gold-2)' } }),
      ]));
    }

    host.appendChild(kindTabs);

    host.appendChild(h('div.filters', [
      common.inputField('Поиск', {
        value: state.q, grow: true, placeholder: 'название или описание…',
        onInput: v => { state.q = v; state.page = 1; draw(); },
      }),
      common.selectField('Сортировка', [['new', 'Новые'], ['hot', 'Популярные']],
        state.sort, v => { state.sort = v; state.page = 1; draw(); }),
    ]));

    host.appendChild(common.modeTabs(state.mode, v => { state.mode = v; state.page = 1; draw(); }));

    const listHost = h('div');
    host.appendChild(listHost);

    async function draw() {
      clear(listHost);
      listHost.appendChild(h('div.loading-panel', { style: { padding: '60px 0' } }, h('div.spinner')));
      const qs = new URLSearchParams();
      if (state.mode) qs.set('mode', state.mode);
      if (state.kind) qs.set('kind', state.kind);
      if (state.sort) qs.set('sort', state.sort);
      if (state.q) qs.set('q', state.q);
      if (state.author) qs.set('author', state.author);
      qs.set('page', state.page);
      qs.set('per_page', '18');

      const res = await api.get('/tops?' + qs.toString());
      clear(listHost);
      if (!res.ok) {
        listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Не удалось загрузить топы' }));
        return;
      }
      if (!res.data.items.length) {
        listHost.appendChild(common.empty({
          icon: '🏆', title: 'Топов пока нет',
          text: 'Составь свой тир-лист: кто сильнее всех в CHC, а кто — в Ratten Run.',
          action: store.isStaff() ? () => router.go('/tops/new') : null, actionLabel: 'Собрать топ',
        }));
        return;
      }
      const grid = h('div.grid.grid-2');
      for (const t of res.data.items) grid.appendChild(common.topCard(t));
      listHost.appendChild(grid);
      listHost.appendChild(common.pager({ page: res.data.page, pages: res.data.pages, onGo: p => { state.page = p; draw(); } }));
    }

    await draw();
  }

  /* ══════════════════════════════════════════════════════════════════
     Страница топа
     ══════════════════════════════════════════════════════════════════ */
  async function renderDetail(host, params) {
    clear(host);
    host.appendChild(h('div.loading-panel', [h('div.spinner'), h('p', { text: 'Открываем топ…' })]));

    const res = await api.get('/tops/' + encodeURIComponent(params.id));
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Топ не открылся' }),
        h('p', { text: (res.data && res.data.error) || 'Возможно, он удалён или скрыт' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/tops', text: '← К списку' })),
      ]));
      return;
    }
    const top = res.data.top;

    host.appendChild(h('div.page-head', [
      h('div', [
        h('div.meta-row', [
          common.modeBadge(top.mode),
          h('span.badge.badge-gold', { text: common.TOP_KIND_RU[top.kind] || top.kind }),
          common.draftBadge(top),
          common.verifyBadge(top),
          top.patch ? h('span.badge.badge-grey', { text: 'патч ' + top.patch }) : null,
        ]),
        h('h1', { text: top.title }),
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: '#/tops', text: '← Все топы' }),
        top.can_edit ? h('a.btn', { href: '#/tops/' + top.id + '/edit', text: '✎ Редактировать' }) : null,
        top.can_delete ? h('button.btn.btn-danger', {
          type: 'button', text: 'Удалить',
          onclick: () => deleteTop(top, () => router.go('/tops')),
        }) : null,
        common.flagButton({ targetType: 'top', targetId: top.id }),
      ]),
    ]));

    const main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });

    if (top.description) {
      main.appendChild(h('div.panel', h('div.md', { html: md.render(top.description) })));
    }

    /* Тир-лист доской: метка тира слева, позиции в ряд — так, как на tiermaker */
    const entries = (top.entries || []).slice().sort((a, b) => a.rank - b.rank);
    const board = h('div.panel', [
      h('div.panel-title', [
        h('span', { text: 'Тир-лист' }),
        h('span.spacer'),
        h('span.field-hint', { text: entries.length + ' позиций' }),
      ]),
    ]);

    if (!entries.length) {
      board.appendChild(h('div.empty', [h('p', { text: 'В топе нет позиций' })]));
    } else {
      for (const row of tierboard.rowsOf(entries, top.tiers)) {
        if (!row.items.length) continue;
        const strip = h('div.tl-strip.view');
        for (const e of row.items) {
          const ref = refEntry(top.kind, e.ref_id);
          const c = h('div.tl-card.view', {
            title: (ref ? tierboard.labelOf(top.kind, ref) : '—') + (e.note ? ' — ' + e.note : ''),
          }, [
            tierboard.tileIcon(top.kind, ref),
            e.note ? h('span.tl-note', { text: e.note }) : null,
          ]);
          c.addEventListener('click', () => ref && picker.showCard(ref,
            top.kind === 'heroes' ? 'hero' : top.kind === 'neutrals' ? 'neutral' : 'ability'));
          strip.appendChild(c);
        }
        board.appendChild(h('div.tl-row', [
          h('div.tl-label.tier-' + common.tierColorClass(row.tier, top.tiers), {
            text: row.tier || '—',
          }),
          strip,
        ]));
      }
    }
    main.appendChild(board);

    /* сайдбар */
    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Автор' }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
        auth.avatarNode(top.author, 'avatar-lg'),
        h('div', [
          h('a', {
            href: '#/u/' + encodeURIComponent(top.author.username),
            text: top.author.nickname,
            style: { fontWeight: '700', color: 'var(--text)', textDecoration: 'none' },
          }),
          h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: '@' + top.author.username }),
        ]),
        auth.roleBadge(top.author),
      ]),
      h('dl.kv', { style: { marginTop: '14px' } }, [
        h('dt', { text: 'Обновлён' }), h('dd', { text: top.updated_ago || '—' }),
        h('dt', { text: 'Позиций' }), h('dd', { text: String(top.entry_count || entries.length) }),
      ]),
    ]));

    const voteHost = h('div');
    side.appendChild(h('div.panel', [h('div.panel-title', { text: 'Оценка' }), voteHost]));
    function drawVote() {
      clear(voteHost);
      voteHost.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px' } }, [
        common.voteBox({
          score: top.likes || 0, my: top.my_vote ? 1 : 0,
          onVote: {
            url: `/tops/${top.id}/vote`,
            onDone: on => {
              if (on && !top.my_vote) top.likes = (top.likes || 0) + 1;
              else if (!on && top.my_vote) top.likes = Math.max(0, (top.likes || 0) - 1);
              top.my_vote = on;
              drawVote();
            },
          },
        }),
        h('div', { style: { fontSize: '13px', color: 'var(--text-dim)' }, text: 'Согласен с раскладкой' }),
      ]));
      if (top.verified) {
        voteHost.appendChild(h('div.field-hint', {
          style: { marginTop: '12px' },
          text: `✓ Подтверждено ${top.verified_by ? top.verified_by.nickname : 'Coach'}${top.verify_note ? ': ' + top.verify_note : ''}`,
        }));
      }
      if (top.can_verify) {
        voteHost.appendChild(h('div.btn-row', { style: { marginTop: '12px' } },
          top.verified
            ? h('button.btn.btn-sm', { type: 'button', text: 'Снять подтверждение', onclick: () => verifyTop(top, false, drawVote) })
            : h('button.btn.btn-primary.btn-sm', { type: 'button', text: '✓ Подтвердить топ', onclick: () => verifyTop(top, true, drawVote) })));
      }
    }
    drawVote();

    host.appendChild(h('div.build-layout', [main, side]));
  }

  function entryRow(kind, ref, entry) {
    return h('div.entry-row', {
      title: ref ? refName(kind, ref) : '',
      onclick: () => ref && picker.showCard(ref, kind === 'heroes' ? 'hero' : kind === 'neutrals' ? 'neutral' : 'ability'),
    }, [
      h('span.rank', { text: '#' + entry.rank }),
      refIcon(kind, ref),
      entry.note ? h('div.info', [h('span.note', { text: entry.note })]) : null,
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════
     Редактор
     ══════════════════════════════════════════════════════════════════ */
  async function renderEditor(host, params, query) {
    if (!store.me) { router.go('/login'); ui.err('Сначала войди'); return; }
    clear(host);

    const isEdit = !!params.id;
    if (!isEdit && !store.isStaff()) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Нет доступа' }),
        h('p', { text: 'Топы составляют Coach и администраторы. Обычный игрок участвует голосами.' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/tops', text: '← К списку' })),
      ]));
      return;
    }
    // Категорию можно задать прямо в ссылке: /tops/new?kind=neutrals
    const wantedKind = query && query.kind;
    const FIRST_KIND = store.config.top_kinds[0] ? store.config.top_kinds[0].key : 'heroes';
    const validKind = (store.config.top_kinds || []).some(k => k.key === wantedKind);
    const defaultTiers = () => (store.config.tiers || ['S', 'A', 'B', 'C', 'D']).slice();
    let model = {
      id: null,
      mode: (query && query.mode)
        || (store.config.modes[0] ? store.config.modes[0].key : 'chc'),
      kind: validKind ? wantedKind : FIRST_KIND,
      title: '',
      description: '',
      patch: store.patch || '',
      is_draft: true,
      tiers: defaultTiers(),
      entries: [],
    };

    if (isEdit) {
      host.appendChild(h('div.loading-panel', [h('div.spinner')]));
      const res = await api.get('/tops/' + encodeURIComponent(params.id));
      clear(host);
      if (!res.ok) {
        host.appendChild(h('div.error-panel', [h('h3', { text: 'Топ не открылся' }), h('p', { text: (res.data && res.data.error) || '' })]));
        return;
      }
      const t = res.data.top;
      if (!t.can_edit) {
        host.appendChild(h('div.error-panel', [
          h('h3', { text: 'Нет доступа' }),
          h('p', { text: 'Редактировать топ может автор или администратор.' }),
        ]));
        return;
      }
      model = {
        id: t.id, mode: t.mode, kind: t.kind, title: t.title,
        description: t.description || '', patch: t.patch || '', is_draft: !!t.is_draft,
        tiers: t.tiers && t.tiers.length ? t.tiers.slice() : defaultTiers(),
        entries: (t.entries || []).map(e => ({ ref_id: e.ref_id, rank: e.rank, tier: e.tier || '', note: e.note || '' })),
      };
    }

    host.appendChild(h('div.page-head', [
      h('div', [h('h1', { text: isEdit ? 'Правка топа' : 'Новый топ' })],
        h('div.sub', { text: 'Расставь позиции по тирам. Набор тиров — своя шкала для каждого топа: названия можно менять, добавлять и убирать.' })),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: isEdit ? '#/tops/' + model.id : '#/tops', text: '← Отмена' }),
        h('button.btn.btn-primary', { type: 'button', text: '💾 Сохранить', onclick: save }),
      ]),
    ]));

    const layout = h('div.build-layout');
    const main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });

    const modeTabs = h('div.tabs');
    const kindTabs = h('div.tabs');
    function drawTabs() {
      clear(modeTabs);
      for (const m of store.config.modes) {
        modeTabs.appendChild(h(`button.tab${model.mode === m.key ? '.active' : ''}`, {
          type: 'button', text: m.title, onclick: () => { model.mode = m.key; drawTabs(); },
        }));
      }
      clear(kindTabs);
      for (const k of store.config.top_kinds) {
        kindTabs.appendChild(h(`button.tab${model.kind === k.key ? '.active' : ''}`, {
          type: 'button', text: `${k.icon} ${k.title}`,
          onclick: () => {
            if (model.kind !== k.key && model.entries.length) {
              ui.confirm({ title: 'Сменить вид?', text: 'Список позиций будет очищен, потому что сравнивать героев с предметами нельзя.', okLabel: 'Сменить' })
                .then(yes => { if (!yes) return; model.kind = k.key; model.entries = []; drawTabs(); drawEntries(); });
              return;
            }
            model.kind = k.key; drawTabs(); drawEntries();
          },
        }));
      }
    }
    drawTabs();

    const titleInput = h('input.input', {
      type: 'text', maxlength: 120, placeholder: 'Например: Тир-лист героев CHC 7.41',
      value: model.title, oninput: e => { model.title = e.target.value; },
    });
    const descArea = h('textarea.textarea', { maxlength: 4000, placeholder: 'Почему так? На чём играешь, что заходит в пабе.' });
    descArea.value = model.description;
    descArea.addEventListener('input', () => { model.description = descArea.value; });

    const entriesHost = h('div');
    const statsHost = h('div.field-hint', { style: { marginTop: '10px' } });

    /**
     * Доска тиров вместо плоского списка: строки S…D, карточки
     * перетаскиваются мышью. Кнопки ↑/↓ и выбор тира оставлены рядом с
     * карточкой — перетаскивание не единственный способ, и с клавиатуры
     * так тоже удобнее.
     */
    function drawEntries() {
      clear(entriesHost);
      // Строки тиров показываем всегда, даже пустыми: сразу видно, куда
      // класть позиции. Сама подсказка «перетащи сюда» стоит внутри.
      if (!model.entries.length) {
        entriesHost.appendChild(h('div.field-hint', {
          text: 'Позиций пока нет. Нажми «＋ Добавить позиции» — и карточки '
            + 'можно будет раскладывать по строкам.',
        }));
      }
      {
        entriesHost.appendChild(tierboard.render(model.kind, model.entries, {
          refEntry,
          tiers: model.tiers,
          onAddTier: tier => addEntry(tier),
          onRemove: refId => {
            const i = model.entries.findIndex(e => e.ref_id === refId);
            if (i >= 0) { model.entries.splice(i, 1); drawEntries(); }
          },
          onShift: (refId, delta) => {
            tierboard.shiftEntry(model.entries, refId, delta, model.tiers);
            drawEntries();
          },
          onDrop: (refId, tier, index) => {
            tierboard.moveEntry(model.entries, refId, tier, index, model.tiers);
            drawEntries();
          },
        }));
      }

      // Панель управления под доской: добавление, автотир, подсказки
      entriesHost.appendChild(h('div.btn-row', { style: { marginTop: '14px' } }, [
        h('button.btn', { type: 'button', text: '＋ Добавить позиции', onclick: addEntry }),
        h('button.btn.btn-ghost', {
          type: 'button', text: '⚡ Разложить по тирам', title: 'Раздать поровну по строкам сверху вниз',
          onclick: () => {
            if (!model.entries.length) return;
            const T = model.tiers;
            model.entries.forEach((e, i) => {
              const per = Math.ceil(model.entries.length / T.length);
              e.tier = T[Math.min(T.length - 1, Math.floor(i / Math.max(1, per)))] || '';
            });
            tierboard.renumber(model.entries, model.tiers);
            drawEntries();
          },
        }),
        h('button.btn.btn-ghost', {
          type: 'button', text: '⚠ Всё в «Без тира»',
          title: 'Снять тиры у всех позиций — разложишь вручную',
          onclick: () => {
            model.entries.forEach(e => { e.tier = ''; });
            drawEntries();
          },
        }),
      ]));

      const st = tierboard.stats(model.entries, model.tiers);
      const need = (store.limit('minTopEntries', 3));
      statsHost.textContent =
        `Позиций: ${st.total} (минимум ${need}). С тиром: ${st.placed} из ${st.total}.`
        + (st.placed < st.total ? ' Карточки «Без тира» не считаются — разложи их по строкам.' : '');
      statsHost.style.color = st.total >= need ? '' : 'var(--red)';
    }

    function addEntry(tier) {
      const picked = model.entries.map(e => e.ref_id);
      const opts = {
        picked,
        onPick: ref => {
          if (model.entries.length >= 200) { ui.err('Максимум 200 позиций'); return; }
          model.entries.push({ ref_id: ref.id, rank: model.entries.length + 1, tier: tier || '', note: '' });
          tierboard.renumber(model.entries);
          drawEntries();
        },
      };
      if (model.kind === 'heroes') picker.pickHero({ ...opts, mode: model.mode });
      else if (model.kind === 'neutrals') picker.pickNeutral(opts);
      else picker.pickAbility(opts);
    }
    drawEntries();

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: 'Что за топ' })]),
      h('div.field', [h('label', { text: 'Режим' }), modeTabs]),
      h('div.field', [h('label', { text: 'Вид топа' }), kindTabs]),
      h('div.field', [h('label', { text: 'Название' }), titleInput]),
      h('div.field', [h('label', { text: 'Описание' }), descArea]),
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [
        h('span', { text: '🏆 Тир-лист' }),
        h('span.spacer'),
        h('span.field-hint', { text: 'перетаскивай карточки между строками' }),
      ]),
      h('div.help-note', {
        text: 'Слева — тир, справа — позиции. Тащи карточку в нужную строку; '
          + 'внутри строки порядок тоже меняется перетаскиванием. '
          + 'Набор тиров и их названия настраиваются в панели «Тиры» справа. '
          + 'Кнопки «＋ Добавить» — заполнить список, «Разложить по тирам» — '
          + 'раздать поровну, остальное руками.',
      }),
      entriesHost,
      statsHost,
    ]));

    /* Панель «Тиры» — у каждого топа своя шкала: названия, порядок, количество */
    const TIER_SWATCH = ['#ff7b7b', '#ffc46b', '#ffe08a', '#b6e08a', '#8fd9c0'];
    const tiersHost = h('div');
    function applyTierChange() {
      tierboard.renumber(model.entries, model.tiers);
      drawEntries();
      drawTiers();
    }
    function drawTiers() {
      clear(tiersHost);
      tiersHost.appendChild(h('div.help-note', {
        text: 'Свой набор тиров для этого топа. Переименование переносит позиции, '
          + 'удаление снимает тир с позиций.',
      }));
      if (!model.tiers.length) {
        tiersHost.appendChild(h('div.field-hint', { text: 'Тиров нет — все позиции будут «без тира».' }));
      }
      model.tiers.forEach((tier, i) => {
        const input = h('input.input', {
          type: 'text', maxlength: 24, value: tier, title: 'Название тира',
          style: { flex: '1', minWidth: '0', padding: '4px 8px', fontSize: '13px' },
        });
        input.addEventListener('change', () => {
          const v = input.value.trim();
          if (!v || v === tier) { input.value = tier; return; }
          if (model.tiers.includes(v)) { ui.err('Тир «' + v + '» уже есть'); input.value = tier; return; }
          model.tiers[i] = v;
          for (const e of model.entries) if (e.tier === tier) e.tier = v;
          applyTierChange();
        });
        const chip = h('div.tier-chip', [
          h('span.tier-swatch', { style: { background: TIER_SWATCH[i % TIER_SWATCH.length] } }),
          input,
          h('button.tl-b', { type: 'button', text: '↑', title: 'Строкой выше',
            onclick: () => { if (i > 0) { const t = model.tiers[i]; model.tiers[i] = model.tiers[i - 1]; model.tiers[i - 1] = t; applyTierChange(); } } }),
          h('button.tl-b', { type: 'button', text: '↓', title: 'Строкой ниже',
            onclick: () => { if (i < model.tiers.length - 1) { const t = model.tiers[i]; model.tiers[i] = model.tiers[i + 1]; model.tiers[i + 1] = t; applyTierChange(); } } }),
          h('button.tl-x', {
            type: 'button', text: '✕', title: 'Удалить тир',
            onclick: async () => {
              const used = model.entries.filter(e => e.tier === tier).length;
              const yes = await ui.confirm({
                title: 'Удалить тир «' + tier + '»?',
                text: used
                  ? `Позиций в этом тире: ${used}. Они переедут в «Без тира».`
                  : 'В этом тире нет позиций.',
                okLabel: 'Удалить', kind: 'danger',
              });
              if (!yes) return;
              model.tiers.splice(i, 1);
              for (const e of model.entries) if (e.tier === tier) e.tier = '';
              applyTierChange();
            },
          }),
        ]);
        tiersHost.appendChild(chip);
      });
      const defaultT = (store.config.tiers || ['S', 'A', 'B', 'C', 'D']);
      const isDefault = model.tiers.length === defaultT.length
        && model.tiers.every((t, i) => t === defaultT[i]);
      tiersHost.appendChild(h('div.btn-row', { style: { marginTop: '10px' } }, [
        h('button.btn.btn-sm', {
          type: 'button', text: '＋ Добавить тир',
          onclick: async () => {
            const max = store.limit('maxTopTiers', 12);
            if (model.tiers.length >= max) { ui.err('Максимум ' + max + ' тиров'); return; }
            const name = await ui.prompt({
              title: 'Новый тир',
              label: 'Название (появится последней строкой доски)',
              placeholder: 'например: S++, F-, SS',
              maxLength: 24,
            });
            if (!name) return;
            if (model.tiers.includes(name)) { ui.err('Тир «' + name + '» уже есть'); return; }
            model.tiers.push(name);
            applyTierChange();
          },
        }),
        isDefault ? null : h('button.btn.btn-ghost.btn-sm', {
          type: 'button', text: '↺ Сбросить на S–D',
          title: 'Вернуть набор S/A/B/C/D',
          onclick: async () => {
            const yes = await ui.confirm({
              title: 'Сбросить тиры?',
              text: 'Позиции с тирами, которых нет в S–D, переедут в «Без тира».',
              okLabel: 'Сбросить',
            });
            if (!yes) return;
            model.tiers = defaultT.slice();
            for (const e of model.entries) if (!defaultT.includes(e.tier)) e.tier = '';
            applyTierChange();
          },
        }),
      ]));
    }

    const patchInput = h('input.input', {
      type: 'text', maxlength: 12, value: model.patch, placeholder: '7.41',
      oninput: e => { model.patch = e.target.value; },
    });

    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: '🏷️ Тиры' }),
      tiersHost,
    ]));
    drawTiers();

    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Публикация' }),
      h('div.field', [h('label', { text: 'Патч' }), patchInput]),
      h('div.field', [common.draftToggle(() => model.is_draft, v => { model.is_draft = v; }),
        h('div.field-hint', { text: 'Черновик виден только тебе. Нажми кнопку, чтобы опубликовать для всех.' })]),
      h('button.btn.btn-primary.btn-block', { type: 'button', text: '💾 Сохранить', onclick: save }),
      isEdit ? h('button.btn.btn-danger.btn-block', {
        type: 'button', text: 'Удалить топ', style: { marginTop: '10px' }, onclick: () => deleteTop(model, () => router.go('/tops')),
      }) : null,
    ]));

    layout.appendChild(main);
    layout.appendChild(side);
    host.appendChild(layout);

    async function save() {
      if (model.title.trim().length < 3) { ui.err('Название слишком короткое'); titleInput.focus(); return; }
      if (model.entries.length < 3) { ui.err('Нужно минимум 3 позиции'); return; }
      const payload = {
        mode: model.mode, kind: model.kind, title: model.title.trim(),
        description: model.description.trim(), patch: model.patch.trim(),
        is_draft: model.is_draft, tiers: model.tiers, entries: model.entries,
      };
      const res = isEdit
        ? await api.patch('/tops/' + model.id, { body: payload })
        : await api.post('/tops', { body: payload });
      if (!res.ok) { ui.apiError(res, 'Топ не сохранился'); return; }
      store.dropCache('/tops');
      const id = isEdit ? model.id : res.data.id;
      ui.ok(isEdit ? 'Топ обновлён' : 'Топ создан');
      router.go('/tops/' + id);
    }
  }

  async function deleteTop(top, onDone) {
    const yes = await ui.confirm({
      title: 'Удалить топ?', text: `«${top.title}» исчезнет для всех.`, okLabel: 'Удалить', kind: 'danger',
    });
    if (!yes) return;
    const res = await api.delete('/tops/' + top.id);
    if (!res.ok) { ui.apiError(res, 'Не удалось удалить'); return; }
    store.dropCache('/tops');
    ui.ok('Топ удалён');
    if (onDone) onDone();
  }

  function verifyTop(top, approved, onDone) {
    const note = h('input.input', { placeholder: 'Комментарий проверки (необязательно)', maxlength: 600 });
    ui.modal({
      title: approved ? 'Подтвердить топ' : 'Снять подтверждение',
      body: h('div', [
        h('p', { style: { marginBottom: '12px' }, text: approved
          ? 'Метка Coach значит, что раскладка проверена и актуальна на текущий патч.'
          : 'Подтверждение будет снято.' }),
        approved ? h('div.field', [h('label', { text: 'Заметка' }), note]) : null,
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Готово', kind: 'primary',
          onClick: async () => {
            const res = await api.post(`/tops/${top.id}/verify`, { body: { approved, note: note.value.trim() || null } });
            if (!res.ok) { ui.apiError(res, 'Не получилось'); return false; }
            ui.ok(approved ? 'Топ подтверждён' : 'Подтверждение снято');
            if (onDone) onDone();
          },
        },
      ],
    });
  }

  window.views = window.views || {};
  window.views.tops = { renderList, renderDetail, renderEditor, deleteTop, verifyTop, refEntry, refIcon, refName };
})();
