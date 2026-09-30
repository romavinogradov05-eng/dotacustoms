/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — админ-панель
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const TABS = [
    ['overview', 'Обзор'],
    ['queue', 'Очередь'],
    ['reports', 'Заявки'],
    ['users', 'Пользователи'],
    ['flags', 'Жалобы'],
    ['threads', 'Ветки'],
    ['content', 'Контент'],
    ['share', 'Общий доступ'],
    ['mail', 'Почта'],
    ['log', 'Журнал'],
  ];

  async function render(host, _params, query) {
    clear(host);
    if (!store.isAdmin()) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Доступ закрыт' }),
        h('p', { text: 'Раздел только для администратора.' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/', text: '← На главную' })),
      ]));
      return;
    }

    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Админ-панель' }),
      h('div.sub', { text: 'Роли, баны, жалобы и удаление контента. Каждое действие попадает в журнал.' }),
    ]));

    const tabs = h('div.tabs');
    const content = h('div');
    const state = { tab: query.tab || 'overview' };

    for (const [key, title] of TABS) {
      tabs.appendChild(h(`button.tab${state.tab === key ? '.active' : ''}`, {
        type: 'button', text: title, onclick: () => { state.tab = key; paint(); },
      }));
    }
    function paint() {
      [...tabs.children].forEach((el, i) => el.classList.toggle('active', TABS[i][0] === state.tab));
      const map = {
        overview: drawOverview, users: drawUsers, flags: drawFlags,
        threads: drawThreads, content: drawContent, log: drawLog,
        queue: c => window.adminExtra.drawQueue(c, query),
        reports: c => window.adminExtra.drawReports(c, query),
        share: c => window.adminExtra.drawShare(c),
        mail: c => window.adminExtra.drawMail(c),
      };
      clear(content);
      map[state.tab](content);
    }

    host.appendChild(tabs);
    host.appendChild(content);
    paint();
  }

  /* ══════════════════════════════════════════════════════════════════
     Обзор
     ══════════════════════════════════════════════════════════════════ */
  async function drawOverview(host) {
    host.appendChild(h('div.loading-panel', [h('div.spinner')]));
    const res = await api.get('/admin/overview');
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Не удалось загрузить обзор' }));
      return;
    }
    const o = res.data;

    host.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '👥 Пользователи' })]),
      h('div.stat-grid', [
        stat(o.users.total, 'всего'),
        stat(o.users.new_7d, 'новых за неделю'),
        stat(o.users.coaches, 'coach'),
        stat(o.users.banned, 'в бане'),
      ]),
    ]));

    host.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '📦 Контент' })]),
      h('div.stat-grid', [
        stat(o.content.builds, 'билдов'),
        stat(o.content.builds_verified, 'подтверждено'),
        stat(o.content.tops, 'топов'),
        stat(o.content.threads, 'веток'),
        stat(o.content.posts, 'сообщений'),
        stat(o.content.guides, 'гайдов'),
      ]),
      h('div.btn-row', { style: { marginTop: '14px' } }, [
        h('a.btn.btn-sm.btn-ghost', { href: '#/builds?sort=verified', text: `Без проверки: ${o.queue.builds_unverified} →` }),
        h('a.btn.btn-sm.btn-ghost', { href: '#/builds?sort=new', text: `Черновики: ${o.content.builds_draft} →` }),
      ]),
    ]));

    host.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '📥 Очередь модерации' })]),
      h('div.stat-grid', [
        stat(o.queue.flags_open, 'жалоб', 'flags'),
        stat(o.queue.threads_open, 'открытых багов', 'threads'),
        stat(o.queue.threads_confirmed, 'подтверждённых', 'threads'),
        stat(o.queue.builds_unverified, 'билдов без метки', 'builds'),
      ]),
    ]));

    host.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '🗄 Резервная копия' })]),
      h('p', { style: { color: 'var(--text-dim)', marginBottom: '12px' } },
        'Вся база лежит одним файлом на твоём диске. Скачай копию, если хочешь перенести хаб на другой компьютер.'),
      h('div.btn-row', [
        h('button.btn.btn-primary', { type: 'button', text: '⬇ Скачать базу (.db)', onclick: downloadBackup }),
        h('button.btn', { type: 'button', text: '📂 Открыть папку с базой', onclick: auth.openDataDir }),
      ]),
    ]));
  }

  function downloadBackup() {
    const url = api.BASE + '/admin/backup';
    const token = api.getToken();
    // fetch → blob, потому что обычная ссылка не приложит заголовок Authorization
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error('Ошибка ' + r.status); return r.blob(); })
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dotacustoms-${new Date().toISOString().slice(0, 10)}.db`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        ui.ok('Копия скачана');
      })
      .catch(() => ui.err('Не удалось скачать копию'));
  }

  function stat(v, k, tab) {
    return h('div.stat', [
      tab ? h('a', { href: '#/admin?tab=' + tab, style: { textDecoration: 'none', color: 'inherit' } },
        [h('div.v', { text: String(v || 0) }), h('div.k', { text: k })])
        : [h('div.v', { text: String(v || 0) }), h('div.k', { text: k })],
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════
     Пользователи
     ══════════════════════════════════════════════════════════════════ */
  async function drawUsers(host) {
    const state = { q: '', role: '', banned: '', page: 1 };

    host.appendChild(h('div.filters', [
      common.inputField('Поиск', {
        value: state.q, grow: true, placeholder: 'ник или имя…',
        onInput: v => { state.q = v; state.page = 1; draw(); },
      }),
      common.selectField('Роль', [['', 'Любая'], ['user', 'Игрок'], ['coach', 'Coach'], ['admin', 'Админ']],
        state.role, v => { state.role = v; state.page = 1; draw(); }),
      common.selectField('Бан', [['', 'Любой'], ['1', 'Забаненные'], ['0', 'Активные']],
        state.banned, v => { state.banned = v; state.page = 1; draw(); }),
    ]));

    const listHost = h('div');
    host.appendChild(listHost);

    async function draw() {
      clear(listHost);
      listHost.appendChild(h('div.loading-panel', { style: { padding: '40px 0' } }, h('div.spinner')));
      const qs = new URLSearchParams();
      if (state.q) qs.set('q', state.q);
      if (state.role) qs.set('role', state.role);
      if (state.banned) qs.set('banned', state.banned);
      qs.set('page', state.page);
      qs.set('per_page', '25');
      const res = await api.get('/admin/users?' + qs.toString());
      clear(listHost);
      if (!res.ok) {
        listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Ошибка' }));
        return;
      }
      if (!res.data.items.length) {
        listHost.appendChild(common.empty({ icon: '👤', title: 'Никого не нашли' }));
        return;
      }
      const table = h('table.table');
      table.appendChild(h('thead', h('tr', [
        h('th', { text: 'Игрок' }), h('th', { text: 'Роль' }), h('th', { text: 'Области' }),
        h('th', { text: 'Регистрация' }), h('th', { text: 'Действия' }),
      ])));
      const tbody = h('tbody');
      for (const u of res.data.items) {
        tbody.appendChild(h('tr', [
          h('td', h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
            auth.avatarNode(u, 'avatar-sm'),
            h('div', [
              h('a', { href: '#/u/' + encodeURIComponent(u.username), text: u.nickname,
                style: { color: 'var(--text)', textDecoration: 'none', fontWeight: '600' } }),
              h('div', { style: { fontSize: '11.5px', color: 'var(--text-mute)' }, text: '@' + u.username }),
            ]),
            u.is_banned ? h('span.badge.badge-red', { text: 'БАН' }) : null,
          ])),
          h('td', auth.roleBadge(u) || h('span.badge.badge-grey', { text: 'Игрок' })),
          h('td', h('div.pill-list', (u.coach_scopes || []).length
            ? (u.coach_scopes.includes('*')
              ? [h('span.badge.badge-blue', { text: '*' })]
              : u.coach_scopes.map(sc => h(`span.badge.badge-mode-${sc}`, { text: store.modeShort(sc) })))
            : [h('span', { style: { color: 'var(--text-mute)' }, text: '—' })])),
          h('td', h('span', { style: { fontSize: '12.5px', color: 'var(--text-dim)' }, text: u.ago })),
          h('td', h('div.btn-row', [
            h('button.btn.btn-sm', { type: 'button', text: 'Роль', onclick: () => roleDialog(u, draw) }),
            h('button.btn.btn-sm' + (u.is_banned ? '' : '.btn-danger'), {
              type: 'button', text: u.is_banned ? 'Разбанить' : 'Забанить',
              onclick: () => banDialog(u, draw),
            }),
            h('button.icon-btn', {
              type: 'button', title: 'Сбросить пароль', text: '🔑', style: { fontSize: '11px' },
              onclick: () => passwordDialog(u, draw),
            }),
          ])),
        ]));
      }
      table.appendChild(tbody);
      listHost.appendChild(h('div.table-wrap', table));
      listHost.appendChild(common.pager({ page: res.data.page, pages: res.data.pages, onGo: p => { state.page = p; draw(); } }));
    }

    await draw();
  }

  function roleDialog(user, onDone) {
    const roleSel = h('select.select');
    for (const [v, t] of [['user', 'Игрок'], ['coach', 'Coach'], ['admin', 'Админ']]) {
      const o = h('option', { value: v, text: t });
      if (user.role === v) o.selected = true;
      roleSel.appendChild(o);
    }
    const scopes = { chc: false, rr: false, '*': user.coach_scopes.includes('*') };
    const scopeBox = h('div.choices', { style: { marginTop: '10px' } });
    const boxes = {};
    for (const [key, title] of [['chc', 'CHC'], ['rr', 'Ratten Run'], ['*', 'Оба режима']]) {
      const input = h('input', { type: 'checkbox' });
      input.checked = !!scopes[key];
      boxes[key] = input;
      scopeBox.appendChild(h('label.switch', [input, h('span.track'), h('span.label', { text: title })]));
    }
    function syncScope() { scopeBox.style.display = roleSel.value === 'coach' ? 'flex' : 'none'; }
    roleSel.addEventListener('change', syncScope);
    syncScope();

    ui.modal({
      title: 'Роль: ' + user.nickname,
      body: h('div', [
        h('div.field', [h('label', { text: 'Роль' }), roleSel]),
        h('div.field', [h('label', { text: 'Области Coach' }), scopeBox,
          h('div.field-hint', { text: 'Coach может подтверждать билды и модерировать ветки только в своих областях.' })]),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сохранить', kind: 'primary',
          onClick: async () => {
            const list = Object.keys(boxes).filter(k => boxes[k].checked);
            const res = await api.post(`/admin/users/${user.id}/role`, {
              body: { role: roleSel.value, coach_scopes: roleSel.value === 'coach' ? list : [] },
            });
            if (!res.ok) { ui.apiError(res, 'Не получилось'); return false; }
            ui.ok('Роль обновлена');
            onDone();
          },
        },
      ],
    });
  }

  function banDialog(user, onDone) {
    const reason = h('textarea.textarea', { placeholder: 'За что баним', maxlength: 400, rows: 3 });
    reason.value = user.ban_reason || '';
    ui.modal({
      title: user.is_banned ? 'Разбанить ' + user.nickname : 'Забанить ' + user.nickname,
      body: h('div', [
        h('div.help-note', {
          text: user.is_banned
            ? 'Разбан вернёт доступ. Все его сессии уже уничтожены, вход будет возможен снова.'
            : 'Бан закрывает вход и уничтожает все активные сессии. Контент остаётся на месте.',
        }),
        h('div.field', [h('label', { text: 'Причина' }), reason]),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: user.is_banned ? 'Разбанить' : 'Забанить',
          kind: user.is_banned ? 'primary' : 'danger',
          onClick: async () => {
            const res = await api.post(`/admin/users/${user.id}/ban`, {
              body: { banned: !user.is_banned, reason: reason.value.trim() || null },
            });
            if (!res.ok) { ui.apiError(res, 'Не получилось'); return false; }
            ui.ok(user.is_banned ? 'Разбанен' : 'Забанен');
            onDone();
          },
        },
      ],
    });
  }

  function passwordDialog(user, onDone) {
    const input = h('input.input', { type: 'text', placeholder: `минимум ${store.limit('passwordMin', 6)} символов` });
    ui.modal({
      title: 'Сброс пароля: ' + user.nickname,
      body: h('div', [
        h('div.help-note', { text: 'Сессии игрока будут уничтожены — он войдёт заново с новым паролем.' }),
        h('div.field', [h('label', { text: 'Новый пароль' }), input]),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сбросить', kind: 'danger',
          onClick: async () => {
            if (!input.value) { ui.err('Пароль пустой'); return false; }
            const res = await api.post(`/admin/users/${user.id}/password`, { body: { password: input.value } });
            if (!res.ok) { ui.apiError(res, 'Не получилось'); return false; }
            ui.ok('Пароль сброшен');
            onDone();
          },
        },
      ],
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     Жалобы
     ══════════════════════════════════════════════════════════════════ */
  async function drawFlags(host) {
    const state = { status: 'open' };
    host.appendChild(h('div.filters', [
      common.selectField('Статус', [['open', 'Открытые'], ['accepted', 'Принятые'], ['rejected', 'Отклонённые']],
        state.status, v => { state.status = v; draw(); }),
    ]));
    const listHost = h('div');
    host.appendChild(listHost);

    async function draw() {
      clear(listHost);
      listHost.appendChild(h('div.loading-panel', { style: { padding: '40px 0' } }, h('div.spinner')));
      const res = await api.get('/admin/flags?status=' + state.status);
      clear(listHost);
      if (!res.ok) {
        listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Ошибка' }));
        return;
      }
      const items = res.data.items || [];
      if (!items.length) {
        listHost.appendChild(common.empty({ icon: '⚑', title: 'Жалоб нет' }));
        return;
      }
      const REASON_RU = { spam: 'Спам', abuse: 'Токсичность', plagiarism: 'Плагиат', wrong_info: 'Неверная информация', other: 'Другое' };
      const TYPE_RU = { build: 'билд', top: 'топ', thread: 'ветка', post: 'сообщение', comment: 'комментарий', guide: 'гайд' };
      const table = h('table.table');
      table.appendChild(h('thead', h('tr', [
        h('th', { text: 'На что' }), h('th', { text: 'Причина' }), h('th', { text: 'Кто' }),
        h('th', { text: 'Когда' }), h('th', { text: '' }),
      ])));
      const tbody = h('tbody');
      for (const f of items) {
        const href = { build: '#/builds/' + f.target_id, top: '#/tops/' + f.target_id, thread: '#/threads/' + f.target_id }[f.target_type];
        tbody.appendChild(h('tr', [
          h('td', href
            ? h('a', { href, text: `${TYPE_RU[f.target_type] || f.target_type} #${f.target_id}`, style: { color: 'var(--gold-2)' } })
            : h('span', { text: `${TYPE_RU[f.target_type] || f.target_type} #${f.target_id}` })),
          h('td', h('div', [
            h('div', { style: { fontWeight: '600' }, text: REASON_RU[f.reason] || f.reason }),
            f.details ? h('div', { style: { fontSize: '12.5px', color: 'var(--text-dim)' }, text: f.details }) : null,
          ])),
          h('td', h('span', { text: f.reporter_nickname })),
          h('td', h('span', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: f.ago })),
          h('td', f.status === 'open'
            ? h('div.btn-row', [
              h('button.btn.btn-sm', {
                type: 'button', text: 'Принять',
                onclick: () => resolve(f, 'accepted', draw),
              }),
              h('button.btn.btn-sm.btn-ghost', {
                type: 'button', text: 'Отклонить',
                onclick: () => resolve(f, 'rejected', draw),
              }),
            ])
            : h('span.badge.badge-grey', { text: f.status === 'accepted' ? 'принята' : 'отклонена' })),
        ]));
      }
      table.appendChild(tbody);
      listHost.appendChild(h('div.table-wrap', table));
    }

    async function resolve(f, status, onDone) {
      const yes = await ui.confirm({
        title: status === 'accepted' ? 'Принять жалобу?' : 'Отклонить жалобу?',
        text: 'Решение попадёт в журнал модерации.',
        okLabel: status === 'accepted' ? 'Принять' : 'Отклонить',
      });
      if (!yes) return;
      const res = await api.post(`/admin/flags/${f.id}/resolve`, { body: { status } });
      if (!res.ok) { ui.apiError(res, 'Не получилось'); return; }
      ui.ok('Готово');
      onDone();
    }

    await draw();
  }

  /* ══════════════════════════════════════════════════════════════════
     Ветки на модерации
     ══════════════════════════════════════════════════════════════════ */
  async function drawThreads(host) {
    const STATUS_RU = { open: 'Открыта', confirmed: 'Подтверждено', fixed: 'Исправлено', rejected: 'Отклонено', archived: 'В архиве' };
    const state = { status: 'open' };
    host.appendChild(h('div.filters', [
      common.selectField('Статус', Object.entries(STATUS_RU), state.status, v => { state.status = v; draw(); }),
    ]));
    const listHost = h('div');
    host.appendChild(listHost);

    async function draw() {
      clear(listHost);
      listHost.appendChild(h('div.loading-panel', { style: { padding: '40px 0' } }, h('div.spinner')));
      const res = await api.get('/admin/threads?status=' + state.status);
      clear(listHost);
      if (!res.ok) {
        listHost.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Ошибка' }));
        return;
      }
      const items = res.data.items || [];
      if (!items.length) {
        listHost.appendChild(common.empty({ icon: '⑂', title: 'Пусто' }));
        return;
      }
      const SEV = { low: 'низкая', medium: 'средняя', high: 'высокая', blocker: 'блокер' };
      const table = h('table.table');
      table.appendChild(h('thead', h('tr', [
        h('th', { text: 'Ветка' }), h('th', { text: 'Автор' }), h('th', { text: 'Важность' }),
        h('th', { text: 'Ответов' }), h('th', { text: 'Действия' }),
      ])));
      const tbody = h('tbody');
      for (const t of items) {
        tbody.appendChild(h('tr', [
          h('td', h('div', [
            h('a', { href: '#/threads/' + t.id, text: t.title, style: { color: 'var(--text)', textDecoration: 'none', fontWeight: '600' } }),
            h('div', { style: { fontSize: '11.5px', color: 'var(--text-mute)' }, text: `${t.category} · ${t.ago}${t.is_deleted ? ' · скрыта' : ''}` }),
          ])),
          h('td', h('span', { text: t.author_nickname })),
          h('td', t.severity ? h('span.badge.badge-red', { text: SEV[t.severity] || t.severity }) : h('span', { text: '—' })),
          h('td', h('span', { text: String(t.replies) })),
          h('td', h('div.btn-row', [
            h('button.btn.btn-sm', {
              type: 'button', text: 'Статус',
              onclick: () => threadStatusDialog(t, draw),
            }),
            h('button.btn.btn-sm' + (t.is_deleted ? '' : '.btn-danger'), {
              type: 'button', text: t.is_deleted ? 'Вернуть' : 'Скрыть',
              onclick: () => hideThread(t, draw),
            }),
          ])),
        ]));
      }
      table.appendChild(tbody);
      listHost.appendChild(h('div.table-wrap', table));
    }

    await draw();
  }

  function threadStatusDialog(thread, onDone) {
    const STATUS_RU = { open: 'Открыта', confirmed: 'Подтверждено', fixed: 'Исправлено', rejected: 'Отклонено', archived: 'В архиве' };
    const sel = h('select.select');
    for (const [v, t] of Object.entries(STATUS_RU)) {
      const o = h('option', { value: v, text: t });
      if (thread.status === v) o.selected = true;
      sel.appendChild(o);
    }
    ui.modal({
      title: 'Статус ветки',
      body: h('div', [
        h('p', { style: { marginBottom: '12px' }, text: thread.title }),
        h('div.field', [h('label', { text: 'Новый статус' }), sel]),
        h('div.field-hint', { text: 'Статус меняется через модерацию самой ветки: Coach или администратор.' }),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сохранить', kind: 'primary',
          onClick: async () => {
            const res = await api.post(`/threads/${thread.id}/moderate`, { body: { status: sel.value } });
            if (!res.ok) { ui.apiError(res, 'Не получилось'); return false; }
            ui.ok('Статус обновлён');
            onDone();
          },
        },
      ],
    });
  }

  async function hideThread(thread, onDone) {
    const hide = !thread.is_deleted;
    const reason = await ui.prompt({
      title: hide ? 'Скрыть ветку' : 'Вернуть ветку',
      label: 'Причина',
      maxLength: 300,
      value: hide ? '' : '',
    });
    if (reason === null) return;
    const res = await api.post(`/admin/threads/${thread.id}/hide`, { body: { hidden: hide, reason } });
    if (!res.ok) { ui.apiError(res, 'Не получилось'); return; }
    ui.ok(hide ? 'Ветка скрыта' : 'Ветка возвращена');
    onDone();
  }

  /* ══════════════════════════════════════════════════════════════════
     Контент
     ══════════════════════════════════════════════════════════════════ */
  async function drawContent(host) {
    host.appendChild(h('div.help-note', [
      h('b', { text: 'Удаление контента — навсегда. ' }),
      'Обычно хватает скрыть ветку или снять подтверждение Coach. Удаляй только спам, плагиат и откровенно вредное.',
    ]));

    const sections = [
      { key: 'build', title: 'Билды', path: '/builds', params: { sort: 'new' } },
      { key: 'top', title: 'Топы', path: '/tops', params: {} },
      { key: 'thread', title: 'Ветки', path: '/threads', params: {} },
    ];

    for (const section of sections) {
      const box = h('div.panel', [h('div.panel-title', [h('span', { text: section.title })])]);
      const inner = h('div');
      box.appendChild(inner);
      host.appendChild(box);
      loadList(section, inner);
    }
  }

  async function loadList(section, host) {
    host.appendChild(h('div.loading-panel', { style: { padding: '24px 0' } }, h('div.spinner')));
    const qs = new URLSearchParams({ per_page: '10', ...(section.params || {}) });
    const res = await api.get(section.path + '?' + qs.toString());
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Ошибка' }));
      return;
    }
    const items = res.data.items || [];
    if (!items.length) {
      host.appendChild(h('div.empty', [h('p', { text: 'Пусто' })]));
      return;
    }
    const card = section.key === 'build' ? common.buildCard
      : section.key === 'top' ? common.topCard : common.threadCard;
    const grid = h('div.grid.grid-2');
    for (const item of items) {
      const node = card(item);
      node.appendChild(h('div.btn-row', { style: { marginTop: '8px' } }, [
        h('a.btn.btn-sm.btn-ghost', { href: itemHref(section.key, item), text: 'Открыть' }),
        h('button.btn.btn-sm.btn-danger', {
          type: 'button', text: 'Удалить',
          onclick: () => removeContent(section.key, item, () => loadList(section, host)),
        }),
      ]));
      grid.appendChild(node);
    }
    host.appendChild(grid);
    host.appendChild(h('div.btn-row', { style: { marginTop: '10px' } },
      h('a.btn.btn-sm.btn-ghost', { href: section.path, text: `Все ${section.title.toLowerCase()} →` })));
  }

  function itemHref(type, item) {
    return { build: '#/builds/' + item.id, top: '#/tops/' + item.id, thread: '#/threads/' + item.id }[type];
  }

  function removeContent(type, item, onDone) {
    const reason = h('textarea.textarea', { placeholder: 'Например: спам-реклама стороннего паба', maxlength: 300, rows: 2 });
    ui.modal({
      title: 'Удалить навсегда?',
      body: h('div', [
        h('p', { style: { marginBottom: '12px' } }, ['Будут удалены: ', h('b', { text: item.title || 'объект' })]),
        h('div.help-note', { text: 'Отменить удаление нельзя. Обычно достаточно скрыть ветку или снять метку Coach.' }),
        h('div.field', [h('label', { text: 'Причина' }), reason]),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Удалить', kind: 'danger',
          onClick: async () => {
            const res = await api.delete(`/admin/content/${type}/${item.id}?reason=${encodeURIComponent(reason.value.trim())}`);
            if (!res.ok) { ui.apiError(res, 'Не удалось удалить'); return false; }
            ui.ok('Удалено');
            onDone();
          },
        },
      ],
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     Журнал
     ══════════════════════════════════════════════════════════════════ */
  async function drawLog(host) {
    host.appendChild(h('div.loading-panel', [h('div.spinner')]));
    const res = await api.get('/admin/log');
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Ошибка' }));
      return;
    }
    const items = res.data.items || [];
    if (!items.length) {
      host.appendChild(common.empty({ icon: '📜', title: 'Журнал пуст' }));
      return;
    }
    const ACTION_RU = {
      set_role: 'смена роли', ban: 'бан', unban: 'разбан', reset_password: 'сброс пароля',
      delete_build: 'удаление билда', delete_top: 'удаление топа', delete_thread: 'удаление ветки',
      delete_guide: 'удаление гайда', delete_post: 'удаление сообщения', delete_comment: 'удаление комментария',
      hide_thread: 'скрытие ветки', restore_thread: 'возврат ветки', resolve_flag: 'решение по жалобе',
    };
    const table = h('table.table');
    table.appendChild(h('thead', h('tr', [
      h('th', { text: 'Кто' }), h('th', { text: 'Действие' }), h('th', { text: 'Объект' }),
      h('th', { text: 'Причина' }), h('th', { text: 'Когда' }),
    ])));
    const tbody = h('tbody');
    for (const m of items) {
      tbody.appendChild(h('tr', [
        h('td', h('span', { text: m.actor_nickname || 'система' })),
        h('td', h('span.badge.badge-grey', { text: ACTION_RU[m.action] || m.action })),
        h('td', h('span', { style: { fontSize: '12.5px' }, text: `${m.target_type} #${m.target_id}` })),
        h('td', h('span', { style: { fontSize: '12.5px', color: 'var(--text-dim)' }, text: m.reason || '—' })),
        h('td', h('span', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: ui.ago(m.created_at) })),
      ]));
    }
    table.appendChild(tbody);
    host.appendChild(h('div.table-wrap', table));
  }

  window.views = window.views || {};
  window.views.admin = { render };
})();
