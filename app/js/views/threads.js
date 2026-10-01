/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — ветки: список, создание и страница обсуждения
   ──────────────────────────────────────────────────────────────────────
   Ветка — это тема (баг, фича, баланс, гайд). Внутри — сообщения с
   ответами (parent_id), как в Discord. Coach/админ могут менять статус,
   закреплять и закрывать ветку.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const STATUS_RU = {
    open: 'Открыта', confirmed: 'Подтверждено', fixed: 'Исправлено',
    rejected: 'Отклонено', archived: 'В архиве',
  };
  const STATUS_CLS = {
    open: 'badge-grey', confirmed: 'badge-yellow', fixed: 'badge-green',
    rejected: 'badge-red', archived: 'badge-grey',
  };
  const SEVERITY_RU = { low: 'низкая', medium: 'средняя', high: 'высокая', blocker: 'блокер' };

  /* ══════════════════════════════════════════════════════════════════
     Список веток
     ══════════════════════════════════════════════════════════════════ */
  async function renderList(host, _params, query) {
    clear(host);
    const state = {
      mode: query.mode || '',
      category: query.category || '',
      status: query.status || '',
      severity: query.severity || '',
      sort: query.sort || 'active',
      q: query.q || '',
      page: Number(query.page) || 1,
    };
    if (query.author) state.author = query.author;
    if (query.pinned === '1') state.pinned = true;

    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Ветки' }),
      h('div.sub', { text: 'Сообщения о багах, идеи и обсуждения кастомов. Нашёл проблему — заведи ветку.' }),
      store.isStaff() ? h('div.btn-row', h('a.btn.btn-primary', { href: '#/threads/new', text: '＋ Создать ветку' })) : null,
    ]));

    if (state.author) {
      host.appendChild(h('div.help-note', [
        'Показаны ветки игрока ', h('b', { text: state.author }), ' ',
        h('a', { href: '#/threads', text: 'сбросить', style: { color: 'var(--gold-2)' } }),
      ]));
    }

    const filters = h('div.filters', [
      common.inputField('Поиск', {
        value: state.q, grow: true, placeholder: 'название или текст…',
        onInput: v => { state.q = v; state.page = 1; draw(); },
      }),
      common.selectField('Категория', [['', 'Все']].concat(store.config.thread_categories.map(c => [c.key, `${c.icon} ${c.title}`])),
        state.category, v => { state.category = v; state.page = 1; draw(); }),
      common.selectField('Статус', [['', 'Любой']].concat(Object.entries(STATUS_RU)),
        state.status, v => { state.status = v; state.page = 1; draw(); }),
      common.selectField('Важность', [['', 'Любая']].concat(Object.entries(SEVERITY_RU)),
        state.severity, v => { state.severity = v; state.page = 1; draw(); }),
      common.selectField('Сортировка', [['active', 'Активные'], ['new', 'Новые'], ['hot', 'Горячие']],
        state.sort, v => { state.sort = v; state.page = 1; draw(); }),
    ]);
    host.appendChild(filters);

    host.appendChild(common.modeTabs(state.mode, v => { state.mode = v; state.page = 1; draw(); }));

    const listHost = h('div');
    host.appendChild(listHost);

    async function draw() {
      clear(listHost);
      listHost.appendChild(h('div.loading-panel', { style: { padding: '60px 0' } }, h('div.spinner')));
      const qs = new URLSearchParams();
      if (state.mode) qs.set('mode', state.mode);
      if (state.category) qs.set('category', state.category);
      if (state.status) qs.set('status', state.status);
      if (state.severity) qs.set('severity', state.severity);
      if (state.sort) qs.set('sort', state.sort);
      if (state.q) qs.set('q', state.q);
      if (state.author) qs.set('author', state.author);
      if (state.pinned) qs.set('pinned', '1');
      qs.set('page', state.page);
      qs.set('per_page', '20');

      const res = await api.get('/threads?' + qs.toString());
      clear(listHost);
      if (!res.ok) {
        listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Не удалось загрузить ветки' }));
        return;
      }
      if (!res.data.items.length) {
        listHost.appendChild(common.empty({
          icon: '🐛', title: 'Веток не нашлось',
          text: 'Попробуй снять фильтры или создай новую — автор кастома читает ветки.',
          action: store.isStaff() ? () => router.go('/threads/new') : null, actionLabel: 'Создать ветку',
        }));
        return;
      }
      const grid = h('div.grid.grid-2');
      for (const t of res.data.items) grid.appendChild(common.threadCard(t));
      listHost.appendChild(grid);
      listHost.appendChild(common.pager({ page: res.data.page, pages: res.data.pages, onGo: p => { state.page = p; draw(); } }));
    }

    await draw();
  }

  /* ══════════════════════════════════════════════════════════════════
     Создание / правка ветки
     ══════════════════════════════════════════════════════════════════ */
  async function renderEditor(host, params) {
    if (!store.me) { router.go('/login'); ui.err('Сначала войди'); return; }
    clear(host);
    const isEdit = !!params.id;
    if (!isEdit && !store.isStaff()) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Нет доступа' }),
        h('p', { text: 'Ветки заводят Coach и администраторы. Обычный игрок отвечает в ветках, голосует, жалуется и подаёт заявления.' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/threads', text: '← К списку' })),
      ]));
      return;
    }

    const model = {
      id: null,
      mode: 'any',
      category: 'bug',
      title: '',
      body: '',
      hero_id: null,
      patch: store.patch || '',
      severity: 'medium',
    };

    if (isEdit) {
      host.appendChild(h('div.loading-panel', [h('div.spinner')]));
      const res = await api.get('/threads/' + encodeURIComponent(params.id));
      clear(host);
      if (!res.ok) {
        host.appendChild(h('div.error-panel', [h('h3', { text: 'Ветка не открылась' }), h('p', { text: (res.data && res.data.error) || '' })]));
        return;
      }
      const t = res.data.thread;
      if (!t.can_edit) {
        host.appendChild(h('div.error-panel', [h('h3', { text: 'Нет доступа' }), h('p', { text: 'Редактировать ветку может автор или администратор.' })]));
        return;
      }
      Object.assign(model, {
        id: t.id, mode: t.mode, category: t.category, title: t.title,
        body: t.body, hero_id: t.hero_id, patch: t.patch || '', severity: t.severity || 'medium',
      });
    }

    host.appendChild(h('div.page-head', [
      h('div', [
        h('h1', { text: isEdit ? 'Правка ветки' : 'Новая ветка' }),
        h('div.sub', { text: 'Опиши проблему или идею по конкретному кастому. Чем точнее — тем быстрее починят.' }),
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: isEdit ? '#/threads/' + model.id : '#/threads', text: '← Отмена' }),
        h('button.btn.btn-primary', { type: 'button', text: '💾 Опубликовать', onclick: save }),
      ]),
    ]));

    /* шаблоны для багов */
    const catTabs = h('div.tabs');
    for (const c of store.config.thread_categories) {
      catTabs.appendChild(h(`button.tab${model.category === c.key ? '.active' : ''}`, {
        type: 'button', text: `${c.icon} ${c.title}`,
        onclick: () => {
          model.category = c.key;
          for (const el of catTabs.querySelectorAll('.tab')) el.classList.remove('active');
          catTabs.querySelectorAll('.tab')[store.config.thread_categories.indexOf(c)].classList.add('active');
          applyTemplate();
        },
      }));
    }

    const titleInput = h('input.input', {
      type: 'text', maxlength: 140, placeholder: 'Кратко: что случилось?',
      value: model.title, oninput: e => { model.title = e.target.value; },
    });
    const bodyArea = h('textarea.textarea', { maxlength: 8000, style: { minHeight: '220px' } });
    bodyArea.value = model.body;
    bodyArea.addEventListener('input', () => { model.body = bodyArea.value; });

    const TEMPLATES = {
      bug: '**Что случилось**\n\n\n**Как повторить**\n1. \n2. \n\n**Что ожидалось**\n\n\n**Скриншот / видео**\n',
      feature: '**Идея**\n\n\n**Зачем это нужно**\n\n\n**Как могло бы работать**\n',
      balance: '**Что не так с балансом**\n\n\n**Предложение**\n\n\n**Почему это лучше текущего**\n',
      guide: '**О чём гайд**\n\n\n**Основные шаги**\n1. \n2. \n',
      discussion: '**Тема**\n\n\n**Моё мнение**\n\n\n**Вопрос к сообществу**\n',
    };
    function applyTemplate() {
      if (model.body.trim()) return;
      const tpl = TEMPLATES[model.category];
      if (!tpl) return;
      model.body = tpl;
      bodyArea.value = tpl;
    }
    if (!isEdit && !model.body) applyTemplate();

    const modeSel = common.selectField('Режим', [['any', 'Оба / не важно']].concat(store.config.modes.map(m => [m.key, m.title])),
      model.mode, v => { model.mode = v; });
    const sevSel = common.selectField('Важность', Object.entries(SEVERITY_RU).map(([k, t]) => [k, t]),
      model.severity, v => { model.severity = v; });
    const patchInput = h('input.input', {
      type: 'text', maxlength: 12, value: model.patch, placeholder: '7.41',
      oninput: e => { model.patch = e.target.value; },
    });

    const heroHost = h('div');
    function drawHero() {
      clear(heroHost);
      const hero = model.hero_id ? store.heroById.get(model.hero_id) : null;
      if (!hero) {
        heroHost.appendChild(h('button.slot.empty', {
          type: 'button', style: { width: '100%' },
          text: '＋ Привязать героя (необязательно)',
          onclick: () => picker.pickHero({ picked: [], onPick: e => { model.hero_id = e.id; drawHero(); } }),
        }));
        return;
      }
      heroHost.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
        h('img', { src: store.heroIcon(hero), alt: '', style: { width: '40px', height: '40px', borderRadius: '50%' } }),
        h('span', { text: hero.name, style: { flex: '1' } }),
        h('button.icon-btn', { type: 'button', text: '✕', onclick: () => { model.hero_id = null; drawHero(); } }),
      ]));
    }
    drawHero();

    const main = h('div.panel', [
      h('div.field', [h('label', { text: 'Категория' }), catTabs]),
      h('div.field', [h('label', { text: 'Заголовок' }), titleInput]),
      h('div.field', [
        h('label', { text: 'Описание' }), bodyArea,
        h('div.field-hint', { text: 'Поддерживается markdown: **жирный**, `код`, списки, цитаты.' }),
      ]),
      h('div.form-grid', [
        h('div.field', [h('label', { text: 'Режим' }), modeSel]),
        h('div.field', [h('label', { text: 'Важность' }), sevSel]),
        h('div.field', [h('label', { text: 'Патч' }), patchInput]),
      ]),
      h('div.field', [h('label', { text: 'Герой' }), heroHost]),
    ]);

    host.appendChild(main);

    async function save() {
      if (model.title.trim().length < 5) { ui.err('Заголовок слишком короткий'); titleInput.focus(); return; }
      if (model.body.trim().length < 10) { ui.err('Опиши подробнее — минимум 10 символов'); bodyArea.focus(); return; }
      const payload = {
        mode: model.mode, category: model.category, title: model.title.trim(),
        body: model.body.trim(), hero_id: model.hero_id, patch: model.patch.trim(),
        severity: model.severity,
      };
      const res = isEdit
        ? await api.patch('/threads/' + model.id, { body: payload })
        : await api.post('/threads', { body: payload });
      if (!res.ok) { ui.apiError(res, 'Ветка не сохранилась'); return; }
      store.dropCache('/threads');
      const id = isEdit ? model.id : res.data.id;
      ui.ok(isEdit ? 'Ветка обновлена' : 'Ветка создана');
      router.go('/threads/' + id);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     Страница ветки
     ══════════════════════════════════════════════════════════════════ */
  async function renderDetail(host, params) {
    clear(host);
    host.appendChild(h('div.loading-panel', [h('div.spinner'), h('p', { text: 'Открываем ветку…' })]));

    const res = await api.get('/threads/' + encodeURIComponent(params.id));
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Ветка не открылась' }),
        h('p', { text: (res.data && res.data.error) || 'Возможно, она удалена' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/threads', text: '← К списку' })),
      ]));
      return;
    }
    const thread = res.data.thread;
    const posts = res.data.posts || [];
    const cat = store.category(thread.category) || { title: thread.category, icon: '💬', color: 'grey' };
    const hero = thread.hero_id ? store.heroById.get(thread.hero_id) : null;

    /* ── заголовок ── */
    host.appendChild(h('div.page-head', [
      h('div', [
        h('div.meta-row', [
          thread.is_pinned ? h('span.badge.badge-gold', { text: '📌 Закреплено' }) : null,
          h(`span.badge.badge-${cat.color === 'grey' ? 'grey' : cat.color}`, { text: `${cat.icon} ${cat.title}` }),
          thread.mode !== 'any' ? common.modeBadge(thread.mode) : h('span.badge.badge-grey', { text: 'Оба режима' }),
          h('span.badge', { class: STATUS_CLS[thread.status] || 'badge-grey', text: STATUS_RU[thread.status] || thread.status }),
          thread.severity && thread.category === 'bug'
            ? h('span.badge.badge-red', { text: 'важность: ' + (SEVERITY_RU[thread.severity] || thread.severity) }) : null,
          thread.patch ? h('span.badge.badge-grey', { text: 'патч ' + thread.patch }) : null,
          thread.is_locked ? h('span.badge.badge-red', { text: '🔒 Закрыта' }) : null,
        ]),
        h('h1', { text: thread.title }),
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', { href: '#/threads', text: '← Все ветки' }),
        thread.can_edit ? h('a.btn', { href: '#/threads/' + thread.id + '/edit', text: '✎ Править' }) : null,
        thread.can_moderate ? h('button.btn', { type: 'button', text: '🛠 Модерация', onclick: () => moderate(thread, () => renderDetail(host, params)) }) : null,
        thread.can_delete ? h('button.btn.btn-danger', {
          type: 'button', text: 'Удалить',
          onclick: () => deleteThread(thread, () => router.go('/threads')),
        }) : null,
        common.flagButton({ targetType: 'thread', targetId: thread.id }),
      ]),
    ]));

    const layout = h('div.build-layout');
    const main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });

    /* ── первое сообщение ── */
    const first = h('div.msg', { class: store.me && store.me.id === thread.author.id ? 'mine' : '' }, [
      auth.avatarNode(thread.author, 'avatar-lg'),
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.head', [
          h('span.nick', { text: thread.author.nickname }),
          auth.roleBadge(thread.author),
          h('span.time', { text: thread.ago }),
          h('span.dot', { text: '·' }),
          h('span.time', { text: `👁 ${thread.views || 0}` }),
        ]),
        h('div.body.md', { html: md.render(thread.body) }),
      ]),
    ]);
    main.appendChild(h('div.panel', [
      h('div.panel-title', [
        h('span', { text: 'Исходное сообщение' }),
        h('span.spacer'),
        common.voteBox({
          score: thread.score || 0, my: thread.my_vote || 0,
          onVote: {
            url: `/threads/${thread.id}/vote`,
            onDone: () => renderDetail(host, params),
          },
        }),
      ]),
      first,
      thread.resolved_by ? h('div.field-hint', {
        style: { marginTop: '10px' },
        text: `Статус поставил ${thread.resolved_by.nickname}${thread.resolved_at ? ' · ' + ui.ago(thread.resolved_at) : ''}`,
      }) : null,
    ]));

    /* ── дерево ответов ── */
    const replyHost = h('div.panel', [
      h('div.panel-title', [
        h('span', { text: `💬 Обсуждение (${posts.length})` }),
      ]),
    ]);
    const tree = h('div.thread-tree');
    replyHost.appendChild(tree);

    const byParent = new Map();
    for (const p of posts) {
      const key = p.parent_id || 0;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(p);
    }

    let replyTo = null;
    const composerWrap = h('div');

    function renderTree() {
      clear(tree);
      const roots = byParent.get(0) || [];
      if (!roots.length) {
        tree.appendChild(h('div.empty', [h('p', { text: 'Пока никто не ответил. Будь первым.' })]));
        return;
      }
      for (const p of roots) tree.appendChild(postNode(p, 0));
    }

    function postNode(p, depth) {
      const node = h('div', { style: depth ? {} : {} });
      const msg = h('div.msg', { class: (store.me && store.me.id === p.author.id ? 'mine ' : '') + (p.is_deleted ? 'deleted' : '') }, [
        auth.avatarNode(p.author, 'avatar-sm'),
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          h('div.head', [
            h('span.nick', { text: p.author.nickname }),
            auth.roleBadge(p.author),
            h('span.time', { text: p.ago }),
            p.edited_at ? h('span.time', { text: '(изменено)' }) : null,
            h('div.tools', [
              !p.is_deleted && store.me ? h('button.icon-btn', {
                type: 'button', title: 'Ответить', text: '↩', style: { fontSize: '12px' },
                onclick: () => startReply(p),
              }) : null,
              p.can_edit && !p.is_deleted ? h('button.icon-btn', {
                type: 'button', title: 'Изменить', text: '✎', style: { fontSize: '12px' },
                onclick: async () => {
                  const text = await ui.prompt({ title: 'Изменить сообщение', value: p.body, multiline: true, maxLength: 8000 });
                  if (text === null || !text.trim()) return;
                  const r = await api.patch(`/threads/${thread.id}/posts/${p.id}`, { body: { body: text.trim() } });
                  if (!r.ok) { ui.apiError(r, 'Не изменилось'); return; }
                  ui.ok('Сообщение изменено');
                  renderDetail(host, params);
                },
              }) : null,
              p.can_delete && !p.is_deleted ? h('button.icon-btn', {
                type: 'button', title: 'Удалить', text: '✕', style: { fontSize: '12px' },
                onclick: async () => {
                  const yes = await ui.confirm({ title: 'Удалить сообщение?', okLabel: 'Удалить', kind: 'danger' });
                  if (!yes) return;
                  const r = await api.delete(`/threads/${thread.id}/posts/${p.id}`);
                  if (!r.ok) { ui.apiError(r, 'Не удалилось'); return; }
                  ui.ok('Сообщение удалено');
                  renderDetail(host, params);
                },
              }) : null,
            ]),
          ]),
          p.is_deleted
            ? h('div.body', { text: '(сообщение удалено)', style: { opacity: '0.7' } })
            : h('div.body.md', { html: md.render(p.body) }),
          p.is_deleted ? null : h('div', { style: { marginTop: '6px' } }, common.voteBox({
            score: p.score || 0, my: p.my_vote || 0, vertical: false,
            onVote: { url: `/threads/${thread.id}/posts/${p.id}/vote`, onDone: () => renderDetail(host, params) },
          })),
        ]),
      ]);
      node.appendChild(msg);

      const kids = byParent.get(p.id) || [];
      if (kids.length) {
        const kids2 = h('div.reply-line.post-children');
        for (const k of kids) kids2.appendChild(postNode(k, depth + 1));
        node.appendChild(kids2);
      }
      return node;
    }

    /* ── форма ответа ── */
    function startReply(p) {
      replyTo = p;
      drawComposer();
      const area = composerWrap.querySelector('textarea');
      if (area) { area.focus(); area.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }

    function drawComposer() {
      clear(composerWrap);
      if (!store.me) {
        composerWrap.appendChild(h('div.help-note', [
          h('a', { href: '#/login', text: 'Войди', style: { color: 'var(--gold-2)' } }),
          ', чтобы отвечать в ветке.',
        ]));
        return;
      }
      if (thread.is_locked) {
        composerWrap.appendChild(h('div.help-note', { text: '🔒 Ветка закрыта — новые сообщения запрещены.' }));
        return;
      }
      const composer = h('div.composer');
      if (replyTo) {
        composer.appendChild(h('div.replying-to', [
          h('span', { text: `Ответ ${replyTo.author.nickname}: ` }),
          h('span', { text: replyTo.body.slice(0, 90) + (replyTo.body.length > 90 ? '…' : ''), style: { opacity: '0.75' } }),
          h('button.icon-btn', {
            type: 'button', text: '✕', style: { marginLeft: 'auto', width: '24px', height: '24px', fontSize: '11px' },
            onclick: () => { replyTo = null; drawComposer(); },
          }),
        ]));
      }
      const area = h('textarea.textarea', { placeholder: replyTo ? 'Твой ответ…' : 'Написать в ветку…', maxlength: 8000 });
      composer.appendChild(area);
      composer.appendChild(h('div.composer-row', h('button.btn.btn-primary', {
        type: 'button', text: replyTo ? 'Ответить' : 'Отправить',
        onclick: async e => {
          const body = area.value.trim();
          if (!body) { ui.err('Пустое сообщение не отправится'); return; }
          e.target.disabled = true;
          const r = await api.post(`/threads/${thread.id}/posts`, { body: { body, parent_id: replyTo ? replyTo.id : null } });
          e.target.disabled = false;
          if (!r.ok) { ui.apiError(r, 'Сообщение не отправилось'); return; }
          ui.ok('Отправлено');
          renderDetail(host, params);
        },
      })));
      composerWrap.appendChild(composer);
    }

    renderTree();
    drawComposer();
    replyHost.appendChild(composerWrap);
    main.appendChild(replyHost);

    /* ── сайдбар ── */
    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Автор ветки' }),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, [
        auth.avatarNode(thread.author, 'avatar-lg'),
        h('div', [
          h('a', { href: '#/u/' + encodeURIComponent(thread.author.username), text: thread.author.nickname,
            style: { fontWeight: '700', color: 'var(--text)', textDecoration: 'none' } }),
          h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: '@' + thread.author.username }),
        ]),
        auth.roleBadge(thread.author),
      ]),
    ]));

    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Сводка' }),
      h('dl.kv', [
        h('dt', { text: 'Создана' }), h('dd', { text: thread.ago }),
        h('dt', { text: 'Обновлена' }), h('dd', { text: thread.updated_ago }),
        h('dt', { text: 'Ответов' }), h('dd', { text: String(posts.length) }),
        h('dt', { text: 'Голосов' }), h('dd', { text: String(thread.score || 0) }),
        h('dt', { text: 'Просмотров' }), h('dd', { text: String(thread.views || 0) }),
      ]),
      hero ? h('div', { style: { marginTop: '14px' } }, [
        h('div.field-hint', { text: 'Привязанный герой' }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' } }, [
          h('img', { src: store.heroIcon(hero), alt: '', style: { width: '40px', height: '40px', borderRadius: '50%' } }),
          h('span', { text: hero.name }),
        ]),
      ]) : null,
    ]));

    if (thread.can_moderate) {
      side.appendChild(h('div.panel', [
        h('div.panel-title', { text: 'Модерация' }),
        h('div.btn-row', [
          h('button.btn.btn-sm' + (thread.is_pinned ? '.btn-primary' : ''), {
            type: 'button', text: thread.is_pinned ? '📌 Открепить' : '📌 Закрепить',
            onclick: () => moderateAction(thread, { is_pinned: !thread.is_pinned }, () => renderDetail(host, params)),
          }),
          h('button.btn.btn-sm' + (thread.is_locked ? '.btn-primary' : ''), {
            type: 'button', text: thread.is_locked ? '🔓 Открыть' : '🔒 Закрыть',
            onclick: () => moderateAction(thread, { is_locked: !thread.is_locked }, () => renderDetail(host, params)),
          }),
        ]),
      ]));
    }

    layout.appendChild(main);
    layout.appendChild(side);
    host.appendChild(layout);
  }

  async function moderateAction(thread, patch, onDone) {
    const res = await api.post(`/threads/${thread.id}/moderate`, { body: patch });
    if (!res.ok) { ui.apiError(res, 'Не получилось'); return; }
    ui.ok('Готово');
    if (onDone) onDone();
  }

  function moderate(thread, onDone) {
    const statusSel = common.selectField('Статус', Object.entries(STATUS_RU), thread.status, () => {});
    const pinTrack = h('input', { type: 'checkbox' }); pinTrack.checked = !!thread.is_pinned;
    const lockTrack = h('input', { type: 'checkbox' }); lockTrack.checked = !!thread.is_locked;

    ui.modal({
      title: 'Модерация ветки',
      body: h('div', [
        statusSel,
        h('div.field', [h('label.switch', [pinTrack, h('span.track'), h('span.label', { text: '📌 Закрепить ветку' })])]),
        h('div.field', [h('label.switch', [lockTrack, h('span.track'), h('span.label', { text: '🔒 Закрыть для новых сообщений' })])]),
        h('div.help-note', { text: 'Coach может менять статус, закреплять и закрывать ветки своего режима.' }),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сохранить', kind: 'primary',
          onClick: async () => {
            const body = {
              status: statusSel.querySelector('select').value,
              is_pinned: pinTrack.checked,
              is_locked: lockTrack.checked,
            };
            const res = await api.post(`/threads/${thread.id}/moderate`, { body });
            if (!res.ok) { ui.apiError(res, 'Не сохранилось'); return false; }
            ui.ok('Ветка обновлена');
            if (onDone) onDone();
          },
        },
      ],
    });
  }

  async function deleteThread(thread, onDone) {
    const yes = await ui.confirm({
      title: 'Удалить ветку?',
      text: `«${thread.title}» и все ответы скроются. Действие необратимо.`,
      okLabel: 'Удалить', kind: 'danger',
    });
    if (!yes) return;
    const res = await api.delete('/threads/' + thread.id);
    if (!res.ok) { ui.apiError(res, 'Не удалось удалить'); return; }
    store.dropCache('/threads');
    ui.ok('Ветка удалена');
    if (onDone) onDone();
  }

  window.views = window.views || {};
  window.views.threads = { renderList, renderEditor, renderDetail, deleteThread };
})();
