/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — профиль игрока
   ──────────────────────────────────────────────────────────────────────
   Адрес в URL — /u/<технический ник>, потому что ник можно поменять,
   а username нельзя. Свой профиль — тот же экран плюс форма правки.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const TAB_BUILDS = 'builds';
  const TAB_TOPS = 'tops';
  const TAB_THREADS = 'threads';

  async function render(host, params, query) {
    clear(host);
    if (!params.username) {
      // /profile — профиль текущего пользователя
      if (!store.me) { router.go('/login'); return; }
      params = { username: store.me.username };
    }

    host.appendChild(h('div.loading-panel', [h('div.spinner')]));

    // технический ник → id
    const lookup = await api.get('/users/by-name/' + encodeURIComponent(params.username));
    if (!lookup.ok) {
      clear(host);
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Пользователь не найден' }),
        h('p', { text: (lookup.data && lookup.data.error) || 'Такого ника нет' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/', text: '← На главную' })),
      ]));
      return;
    }

    const res = await api.get('/users/' + lookup.data.id);
    clear(host);
    if (!res.ok) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Профиль недоступен' }),
        h('p', { text: (res.data && res.data.error) || 'Ошибка' }),
      ]));
      return;
    }
    const { user, builds, tops, threads } = res.data;
    const isMe = store.me && store.me.id === user.id;

    /* ── шапка ── */
    host.appendChild(h('div.panel', [
      h('div.profile-head', [
        auth.avatarNode(user, 'avatar-lg'),
        h('div.who', [
          h('div.nm', { text: user.nickname }),
          h('div.un', { text: '@' + user.username }),
          user.bio ? h('div', { style: { fontSize: '13.5px', color: 'var(--text-dim)', marginTop: '6px' }, text: user.bio }) : null,
          user.contact ? h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)', marginTop: '4px' }, text: '✉ ' + user.contact }) : null,
        ]),
        h('div.spacer'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' } }, [
          h('div.meta-row', [auth.roleBadge(user), user.is_banned ? h('span.badge.badge-red', { text: 'Забанен' }) : null]),
          h('div.meta-row', [
            h('span', { text: `с нами ${user.joined_ago || '—'}` }),
            user.last_seen_ago ? h('span.dot', { text: '·' }) : null,
            user.last_seen_ago ? h('span', { text: `был ${user.last_seen_ago}` }) : null,
          ]),
        ]),
      ]),
      user.coach_scopes && user.coach_scopes.length ? h('div.field-hint', {
        style: { marginTop: '12px' },
        text: 'Области Coach: ' + (user.coach_scopes.includes('*')
          ? 'оба режима'
          : user.coach_scopes.map(store.modeTitle).join(', ')),
      }) : null,
      isMe ? h('div.btn-row', { style: { marginTop: '14px' } },
        h('button.btn', { type: 'button', text: '✎ Редактировать профиль', onclick: () => openEdit(user) }),
        store.isStaff() ? h('a.btn.btn-primary', { href: '#/builds/new', text: '＋ Собрать билд' }) : null) : null,
    ]));

    /* ── статистика ── */
    const s = user.stats || {};
    host.appendChild(h('div.stat-grid', { style: { marginTop: '16px' } }, [
      stat(s.builds || 0, 'билдов'),
      stat(s.tops || 0, 'топов'),
      stat(s.threads || 0, 'веток'),
      stat(s.verified_builds || 0, 'проверено Coach'),
      stat(s.reputation || 0, 'репутация'),
    ]));

    /* ── вкладки контента ── */
    const tabs = h('div.tabs', { style: { marginTop: '20px' } });
    const content = h('div');
    const state = { tab: query.tab || TAB_BUILDS };

    const TABS = [
      [TAB_BUILDS, `🧰 Билды (${builds.length})`],
      [TAB_TOPS, `🏆 Топы (${tops.length})`],
      [TAB_THREADS, `⑂ Ветки (${threads.length})`],
    ];
    for (const [key, title] of TABS) {
      tabs.appendChild(h(`button.tab${state.tab === key ? '.active' : ''}`, {
        type: 'button', text: title, onclick: () => { state.tab = key; drawTabs(); drawContent(); },
      }));
    }
    function drawTabs() {
      for (const el of tabs.querySelectorAll('.tab')) el.classList.remove('active');
      [...tabs.children][TABS.findIndex(t => t[0] === state.tab)].classList.add('active');
    }

    function drawContent() {
      clear(content);
      if (state.tab === TAB_BUILDS) {
        if (!builds.length) {
          content.appendChild(common.empty({
            icon: '🧰', title: 'Пока нет опубликованных билдов',
            text: isMe ? 'Собери первый билд — это главный способ показать свою игру.' : 'Этот игрок ещё ничего не выложил.',
            action: (isMe && store.isStaff()) ? () => router.go('/builds/new') : null,
            actionLabel: 'Собрать билд',
          }));
          return;
        }
        const grid = h('div.grid.grid-2');
        for (const b of builds) {
          const hero = b.hero_id ? store.heroById.get(b.hero_id) : null;
          grid.appendChild(h('a.card' + (b.is_draft ? '.draft' : ''), { href: '#/builds/' + b.id }, [
            h('div.meta-row', [
              common.modeBadge(b.mode),
              b.is_draft ? h('span.badge.badge-yellow', { text: 'Черновик' }) : null,
              b.verified_at ? h('span.badge.badge-green', { text: '✓ Coach' }) : null,
            ]),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, [
              hero ? h('img', { src: store.heroIcon(hero), alt: '', style: { width: '38px', height: '38px', borderRadius: '50%' } }) : null,
              h('h3', { text: b.title, style: { fontSize: '15px' } }),
            ]),
            h('div.foot', [h('span', { text: ui.ago(b.created_at) })]),
          ]));
        }
        content.appendChild(grid);
        return;
      }

      if (state.tab === TAB_TOPS) {
        if (!tops.length) {
          content.appendChild(common.empty({
            icon: '🏆', title: 'Пока нет топов',
            text: isMe ? 'Собери тир-лист героев или нейтралок.' : 'Этот игрок ещё ничего не выложил.',
            action: (isMe && store.isStaff()) ? () => router.go('/tops/new') : null, actionLabel: 'Собрать топ',
          }));
          return;
        }
        const grid = h('div.grid.grid-2');
        for (const t of tops) {
          grid.appendChild(h('a.card' + (t.is_draft ? '.draft' : ''), { href: '#/tops/' + t.id }, [
            h('div.meta-row', [
              common.modeBadge(t.mode),
              h('span.badge.badge-gold', { text: common.TOP_KIND_RU[t.kind] || t.kind }),
              t.is_draft ? h('span.badge.badge-yellow', { text: 'Черновик' }) : null,
              t.verified_at ? h('span.badge.badge-green', { text: '✓ Coach' }) : null,
            ]),
            h('h3', { text: t.title, style: { fontSize: '15px' } }),
            h('div.foot', [h('span', { text: ui.ago(t.created_at) })]),
          ]));
        }
        content.appendChild(grid);
        return;
      }

      if (!threads.length) {
        content.appendChild(common.empty({
          icon: '⑂', title: 'Пока нет веток',
          text: isMe ? 'Заведи ветку, если нашёл баг или придумал фичу.' : 'Этот игрок ещё ничего не выложил.',
          action: (isMe && store.isStaff()) ? () => router.go('/threads/new') : null, actionLabel: 'Создать ветку',
        }));
        return;
      }
      const STATUS_RU = { open: 'Открыта', confirmed: 'Подтверждено', fixed: 'Исправлено', rejected: 'Отклонено', archived: 'В архиве' };
      const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
      for (const t of threads) {
        list.appendChild(h('a.card', { href: '#/threads/' + t.id, style: { padding: '12px 15px' } }, [
          h('div.meta-row', [
            common.modeBadge(t.mode),
            h('span.badge.badge-grey', { text: STATUS_RU[t.status] || t.status }),
            h('span.spacer', { style: { flex: '1' } }),
            h('span', { text: ui.ago(t.created_at) }),
          ]),
          h('h3', { text: t.title, style: { fontSize: '15px' } }),
        ]));
      }
      content.appendChild(list);
    }

    host.appendChild(tabs);
    host.appendChild(content);
    drawContent();
  }

  function stat(v, k) {
    return h('div.stat', [h('div.v', { text: String(v) }), h('div.k', { text: k })]);
  }

  /* ── правка профиля ── */
  function openEdit(user) {
    const nick = h('input.input', { type: 'text', maxlength: 32, value: user.nickname });
    const bio = h('textarea.textarea', { maxlength: 600, rows: 4, placeholder: 'Кто ты в кастоме, что играешь чаще.' });
    bio.value = user.bio || '';
    const contact = h('input.input', { type: 'text', maxlength: 80, value: user.contact || '', placeholder: 'discord / telegram — по желанию' });
    const email = h('input.input', {
      type: 'email', maxlength: 120, value: user.email || '',
      placeholder: 'you@example.com — по желанию',
    });
    const avatar = h('input.input', { type: 'text', maxlength: 40, value: user.avatar || '', placeholder: 'https://… или пусто' });

    ui.modal({
      title: 'Редактирование профиля',
      body: h('div', [
        h('div.field', [h('label', { text: 'Отображаемое имя' }), nick]),
        h('div.field', [h('label', { text: 'О себе' }), bio]),
        h('div.field', [h('label', { text: 'Контакт' }), contact]),
        h('div.field', [h('label', { text: 'Почта' }), email,
          h('div.field-hint', {
            text: 'Сюда придёт письмо, когда администратор примет или отклонит '
              + 'твою заявку. Другим игрокам почта не показывается.',
          })]),
        h('div.field', [h('label', { text: 'Аватар (ссылка)' }), avatar,
          h('div.field-hint', { text: 'Пусто — будет круг с первой буквой ника.' })]),
        h('div.help-note', { text: 'Технический ник (латиница) менять нельзя — по нему ссылка на профиль.' }),
      ]),
      actions: [
        { label: 'Отмена', kind: 'ghost' },
        {
          label: 'Сохранить', kind: 'primary',
          onClick: async () => {
            const res = await api.patch('/users/me', {
              body: {
                nickname: nick.value.trim(),
                bio: bio.value.trim(),
                contact: contact.value.trim(),
                email: email.value.trim(),
                avatar: avatar.value.trim(),
              },
            });
            if (!res.ok) { ui.apiError(res, 'Не сохранилось'); return false; }
            store.setMe({ user: { ...store.me, ...res.data.user } });
            auth.renderHeader();
            ui.ok('Профиль обновлён');
            router.render();
          },
        },
      ],
    });
  }

  window.views = window.views || {};
  window.views.profile = { render, openEdit };
})();
