/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — вход, регистрация и шапка с профилем
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, $, clear } = window.ui;

  /* ── экраны входа и регистрации ───────────────────────────────────── */
  function renderLogin(host, mode, notice) {
    const isReg = mode === 'register';
    const L = store.limit.bind(store);

    const username = h('input.input', {
      type: 'text', autocomplete: 'username', placeholder: 'latin_only_123',
      minlength: L('usernameMin', 3), maxlength: L('usernameMax', 20),
    });
    const nickname = h('input.input', {
      type: 'text', autocomplete: 'nickname', placeholder: 'Как тебя показывать',
      maxlength: L('nicknameMax', 32),
    });
    const password = h('input.input', {
      type: 'password', autocomplete: isReg ? 'new-password' : 'current-password',
      placeholder: isReg ? `минимум ${L('passwordMin', 6)} символов` : '••••••••',
    });
    const email = h('input.input', {
      type: 'email', autocomplete: 'email', maxlength: 120,
      placeholder: 'you@example.com — по желанию',
    });
    const error = h('div.field-error', { style: { display: 'none' } });
    const submit = h('button.btn.btn-primary.btn-block', {
      type: 'submit', text: isReg ? 'Создать аккаунт' : 'Войти',
    });

    const showError = msg => {
      error.textContent = msg;
      error.style.display = msg ? 'block' : 'none';
    };

    const form = h('form', {
      onsubmit: async e => {
        e.preventDefault();
        showError('');
        submit.disabled = true;
        const payload = {
          username: username.value.trim(),
          password: password.value,
        };
        if (isReg) {
          payload.nickname = nickname.value.trim() || payload.username;
          payload.email = email.value.trim();
        }

        const res = await api.post(isReg ? '/auth/register' : '/auth/login', { body: payload, token: null });
        if (res.ok && res.data && res.data.token) {
          api.setToken(res.data.token);
          await afterAuth();
          ui.ok(isReg ? 'Аккаунт создан. Добро пожаловать!' : 'С возвращением!');
          router.go(store.prefs.lastRoute || '/');
          return;
        }
        showError((res.data && res.data.error) || 'Не получилось войти');
        submit.disabled = false;
      },
    }, [
      h('div.field', [h('label', { text: 'Технический ник' }), username,
        h('div.field-hint', { text: 'Латиница, цифры, дефис. Виден только тебе и модераторам.' })]),
      isReg ? h('div.field', [h('label', { text: 'Отображаемое имя' }), nickname,
        h('div.field-hint', { text: 'Это имя увидят все. Можно поменять в профиле.' })]) : null,
      h('div.field', [h('label', { text: 'Пароль' }), password]),
      isReg ? h('div.field', [h('label', { text: 'Почта' }), email,
        h('div.field-hint', {
          text: 'Необязательно. Сюда придёт письмо, когда администратор примет '
            + 'или отклонит твою заявку. Другим игрокам почта не показывается.',
        })]) : null,
      error,
      h('div', { style: { marginTop: '18px' } }, submit),
      h('div', { style: { marginTop: '16px', textAlign: 'center', fontSize: '14px' } }, [
        isReg ? 'Уже есть аккаунт? ' : 'Нет аккаунта? ',
        h('a', {
          href: isReg ? '#/login' : '#/register', style: { color: 'var(--gold-2)' },
          text: isReg ? 'Войти' : 'Зарегистрироваться',
        }),
      ]),
    ]);

    clear(host);
    host.appendChild(h('div', { style: { maxWidth: '430px', margin: '40px auto' } }, [
      h('div.page-head', { style: { justifyContent: 'center', textAlign: 'center' } }, [
        h('h1', { text: isReg ? 'Регистрация' : 'Вход' }),
      ]),
      notice ? h('div.help-note', { text: notice }) : null,
      h('div.panel', form),
      isReg ? h('div.help-note', { style: { marginTop: '18px' } }, [
        h('b', { text: 'Первый аккаунт в пустой базе автоматически становится администратором. ' }),
        'Остальные — обычные игроки. Роль Coach выдаёт администратор после того, как ты начнёшь разбираться в кастоме.',
      ]) : null,
    ]));

    setTimeout(() => username.focus(), 60);
  }

  async function afterAuth() {
    await store.restoreSession();
    renderHeader();
    renderFooter();
  }

  /* ── шапка: вход / меню профиля ──────────────────────────────────── */
  function avatarNode(user, cls) {
    if (user && user.avatar) {
      return h(`img.avatar${cls ? '.' + cls : ''}`, { src: user.avatar, alt: user.nickname || '' });
    }
    const initial = (user && (user.nickname || user.username) || '?').trim().charAt(0).toUpperCase();
    return h(`span.avatar${cls ? '.' + cls : ''}`, { text: initial });
  }

  function roleBadge(user) {
    if (!user) return null;
    if (user.role === 'admin') return h('span.badge.badge-red', { text: 'Админ' });
    if (user.role === 'coach') {
      const scopes = user.coach_scopes || [];
      const label = scopes.includes('*') ? 'Coach · оба режима' : 'Coach · ' + scopes.map(store.modeShort).join(', ');
      return h('span.badge.badge-blue', { text: label });
    }
    return null;
  }

  function userChip(user) {
    const chip = h('div.user-chip', { role: 'button', tabindex: '0', title: 'Профиль и настройки' }, [
      avatarNode(user),
      h('span.nick', { text: user.nickname || user.username }),
    ]);
    const open = () => openUserMenu(chip, user);
    chip.addEventListener('click', open);
    chip.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return chip;
  }

  function openUserMenu(anchor, user) {
    const item = (label, opts = {}) => h('div.choice', {
      style: { width: '100%', textAlign: 'left', cursor: 'pointer' },
      text: label,
      onclick: () => { m.close(); if (opts.onClick) opts.onClick(); },
    });

    const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' } }, [
        avatarNode(user, 'avatar-lg'),
        h('div', [
          h('div', { style: { fontWeight: '700', fontSize: '16px' }, text: user.nickname }),
          h('div', { style: { fontSize: '12.5px', color: 'var(--text-mute)' }, text: '@' + user.username }),
        ]),
        roleBadge(user),
      ]),
      item('Мой профиль', { onClick: () => router.go('/u/' + user.username) }),
      item('Мои билды', { onClick: () => router.go('/builds?author=' + user.username) }),
      item('Мои ветки', { onClick: () => router.go('/threads?author=' + user.username) }),
      user.role === 'coach' || user.role === 'admin'
        ? item('Панель Coach', { onClick: () => router.go('/coaches') }) : null,
      h('hr', { style: { border: 'none', borderTop: '1px solid var(--border)', margin: '6px 0' } }),
      item('Открыть папку с базой', { onClick: openDataDir }),
      h('button.btn.btn-danger.btn-block', {
        type: 'button', text: 'Выйти', style: { marginTop: '6px' },
        onclick: async () => {
          m.close();
          await api.post('/auth/logout');
          api.setToken(null);
          store.setMe(null);
          store.dropCache();
          renderHeader();
          ui.ok('Вы вышли из аккаунта');
          router.go('/');
        },
      }),
    ]);

    const m = ui.modal({ title: 'Аккаунт', body });
    return m;
  }

  function openDataDir() {
    if (!window.dotacustoms || !window.dotacustoms.openDataDir) {
      ui.err('Открыть папку можно только в настольном приложении');
      return;
    }
    window.dotacustoms.openDataDir().then(r => {
      if (r && r.ok) ui.ok('Папка с базой открыта');
      else ui.err((r && r.error) || 'Не удалось открыть папку');
    });
  }

  function renderHeader() {
    const host = document.getElementById('header-right');
    if (!host) return;
    clear(host);

    if (store.me) {
      host.appendChild(h('button.btn.btn-primary.btn-sm', {
        type: 'button', text: '＋ Создать',
        title: 'Билд, топ, ветка, гайд или заявление — отдельные категории',
        onclick: () => router.go('/create'),
      }));
      host.appendChild(h('button.icon-btn', {
        type: 'button', title: 'Создать ветку', text: '⑂',
        style: { fontSize: '15px' },
        onclick: () => router.go('/threads/new'),
      }));
      host.appendChild(userChip(store.me));
      // Колокольчик: сюда приходит решение по билду, заявке и жалобе.
      if (window.notifications) window.notifications.mount(host);
    } else {
      host.appendChild(h('a.btn.btn-ghost.btn-sm', { href: '#/login', text: 'Войти' }));
      host.appendChild(h('a.btn.btn-primary.btn-sm', { href: '#/register', text: 'Регистрация' }));
    }

    // прячем админский пункт от обычных игроков
    const adminLink = document.querySelector('#main-nav a[data-nav="/admin"]');
    if (adminLink) adminLink.classList.toggle('hidden', !store.isAdmin());
  }

  function renderFooter() {
    const info = document.getElementById('footer-info');
    const patch = document.getElementById('footer-patch');
    if (info) {
      const v = window.dotacustoms && window.dotacustoms.info;
      if (v && typeof v.then === 'function') {
        v.then(i => { if (info) info.textContent = `DotaCustoms ${i.version}`; }).catch(() => {});
      } else {
        info.textContent = 'DotaCustoms';
      }
    }
    if (patch) patch.textContent = store.patch ? `патч ${store.patch}` : '';
  }

  window.auth = { renderLogin, renderHeader, renderFooter, avatarNode, roleBadge, afterAuth, openDataDir };
})();
