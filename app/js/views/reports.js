/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — заявления и жалобы в свободной форме
   ──────────────────────────────────────────────────────────────────────
   Форма намеренно без привязки к объекту: человек пишет тему и текст
   сам, как в обычном обращении. Заявление уходит администратору, и его
   ник администратор видит. После решения приходит уведомление в
   колокольчик и письмо на почту из профиля.

   Для гостя и для администратора раздел один и тот же: гостю видны
   только свои заявки, администратору — все, с разбивкой на страницы.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const STATUS = {
    open: { title: 'На рассмотрении', color: 'yellow' },
    accepted: { title: 'Принята', color: 'green' },
    rejected: { title: 'Отклонена', color: 'red' },
  };
  const KIND_TITLE = {
    appeal: 'Апелляция', complaint: 'Жалоба', other: 'Другое',
  };

  /* ══ форма ═════════════════════════════════════════════════════════ */

  async function renderNew(host) {
    clear(host);
    if (!store.me) {
      host.appendChild(common.empty({
        icon: '🔒', title: 'Нужен вход',
        text: 'Подать заявку можно только после входа.',
        actionHref: '/login', actionLabel: 'Войти',
      }));
      return;
    }

    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Заявление или жалоба' }),
      h('div.sub', {
        text: 'Опиши ситуацию своими словами. Тема обязательна — по ней '
          + 'администратор поймёт, о чём речь.',
      }),
    ]));

    if (!store.me.email) {
      host.appendChild(h('div.help-note', { style: { marginBottom: '14px' } }, [
        h('b', { text: 'Почта не указана. ' }),
        'Решение придёт в уведомления (колокольчик в шапке), но письма не будет. ',
        h('a', { href: '/profile', text: 'Указать почту' }),
      ]));
    }

    const subject = h('input.input', {
      type: 'text', maxlength: 140, placeholder: 'Тема: коротко о сути',
    });
    const body = h('textarea.input', {
      rows: 9, maxlength: 8000,
      placeholder: 'Опиши, что случилось или что предлагаешь. Чем конкретнее, тем быстрее разберёмся.',
    });
    const kindBox = h('div.tabs');
    let kind = 'appeal';
    const anonymous = h('input', { type: 'checkbox' });

    function drawKinds() {
      clear(kindBox);
      for (const [key, title] of Object.entries(KIND_TITLE)) {
        kindBox.appendChild(h(`button.tab${kind === key ? '.active' : ''}`, {
          type: 'button', text: title,
          onclick: () => { kind = key; drawKinds(); },
        }));
      }
    }
    drawKinds();

    const err = h('div.field-err.hidden');
    const submit = h('button.btn.btn-primary', { type: 'submit', text: 'Отправить администратору' });

    const form = h('form.inline-form', {
      style: { flexDirection: 'column', alignItems: 'stretch', gap: '14px' },
      onsubmit: async e => {
        e.preventDefault();
        err.classList.add('hidden');
        submit.disabled = true;
        const res = await api.post('/reports', {
          body: {
            subject: subject.value, body: body.value,
            kind, is_anonymous: anonymous.checked,
          },
        });
        submit.disabled = false;
        if (!res.ok) {
          err.textContent = (res.data && res.data.error) || 'Не получилось отправить';
          err.classList.remove('hidden');
          return;
        }
        ui.ok('Заявка отправлена. Ответ придёт в уведомления и на почту.');
        router.go('/reports');
      },
    }, [
      h('div.field', [h('label', { text: 'Тип обращения' }), kindBox]),
      h('div.field', [h('label', { text: 'Тема' }), subject]),
      h('div.field', [h('label', { text: 'Текст' }), body]),
      h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px', color: 'var(--text-dim)' } }, [
        anonymous, h('span', { text: 'Скрыть мой ник в списке заявок (администратор его всё равно увидит)' }),
      ]),
      err,
      h('div.btn-row', [submit, h('a.btn.btn-ghost', { href: '/reports', text: 'Мои заявления' })]),
    ]);

    host.appendChild(h('div.panel', [form]));

    host.appendChild(h('div.help-note', { style: { marginTop: '16px' } }, [
      h('b', { text: 'Как это работает. ' }),
      'Заявцию видит администратор вместе с вашим ником. Когда он подтвердит, что '
      + 'жалобу приняли или отклонили, вы получите уведомление в колокольчике '
      + 'и письмо на адрес, указанный в профиле. Если решение не понравится — '
      + 'подайте новую заявку, приложив подробности.',
    ]));
  }

  /* ══ список ════════════════════════════════════════════════════════ */

  async function renderList(host, _params, query) {
    clear(host);

    host.appendChild(h('div.page-head', [
      h('h1', { text: store.isAdmin() ? 'Заявки и жалобы' : 'Мои заявления' }),
      h('div.sub', {
        text: store.isAdmin()
          ? 'Свободные обращения игроков. Решение уходит автору в уведомления и на почту.'
          : 'Здесь видно, что happened с твоими обращениями.',
      }),
      h('div.btn-row', store.me
        ? [h('a.btn.btn-primary', { href: '#/reports/new', text: '＋ Подать заявку' })]
        : [h('a.btn.btn-primary', { href: '#/login', text: 'Войти' })]),
    ]));

    if (!store.me) {
      host.appendChild(common.empty({
        icon: '📨', title: 'Нужен вход',
        text: 'Свои заявки и ответы на них видны только после входа.',
        actionHref: '/login', actionLabel: 'Войти',
      }));
      return;
    }

    const isAdmin = store.isAdmin();
    const state = {
      page: Number(query.page) || 1,
      status: query.status || (isAdmin ? 'open' : ''),
      kind: query.kind || '',
    };

    const listHost = h('div');
    const pagerHost = h('div.pager');
    const counter = h('div.field-hint', { style: { margin: '10px 0' } });

    if (isAdmin) {
      const tabs = h('div.tabs');
      const options = [
        ['open', 'На рассмотрении'], ['accepted', 'Принятые'],
        ['rejected', 'Отклонённые'], ['all', 'Все'],
      ];
      for (const [key, title] of options) {
        tabs.appendChild(h(`button.tab${state.status === key ? '.active' : ''}`, {
          type: 'button', text: title,
          onclick: () => { state.status = key; state.page = 1; draw(); drawTabs(); },
        }));
      }
      function drawTabs() {
        clear(tabs);
        for (const [key, title] of options) {
          tabs.appendChild(h(`button.tab${state.status === key ? '.active' : ''}`, {
            type: 'button', text: title,
            onclick: () => { state.status = key; state.page = 1; draw(); drawTabs(); },
          }));
        }
      }
      host.appendChild(tabs);
    }

    const kindSel = h('select.input', {
      style: { maxWidth: '220px' },
      onchange: e => { state.kind = e.target.value; state.page = 1; draw(); },
    }, [h('option', { value: '', text: 'Все типы' })]
      .concat(Object.entries(KIND_TITLE).map(([k, t]) => h('option', { value: k, text: t }))));
    kindSel.value = state.kind;
    host.appendChild(h('div.filter-bar', [kindSel]));

    async function draw() {
      clear(listHost);
      clear(pagerHost);
      const qs = new URLSearchParams();
      if (isAdmin && state.status) qs.set('status', state.status);
      if (state.kind) qs.set('kind', state.kind);
      qs.set('page', String(state.page));
      const url = isAdmin ? `/reports?${qs}` : `/reports/mine`;
      const res = await api.get(url);
      if (!res.ok) {
        listHost.appendChild(common.empty({
          icon: '⚠', title: 'Не получилось загрузить',
          text: (res.data && res.data.error) || 'Ошибка сервера',
        }));
        return;
      }
      const items = res.data.items || [];
      counter.textContent = res.data.total !== undefined
        ? `Всего ${res.data.total} ${ui.plural(res.data.total, 'заявка', 'заявки', 'заявок')}`
        : `${items.length} ${ui.plural(items.length, 'заявка', 'заявки', 'заявок')}`;

      if (!items.length) {
        listHost.appendChild(common.empty({
          icon: '📭', title: 'Пусто',
          text: isAdmin ? 'Новых обращений нет.' : 'Ты ещё не подавал заявок.',
          action: isAdmin ? null : () => router.go('/reports/new'),
          actionLabel: isAdmin ? null : 'Подать заявку',
        }));
        return;
      }

      listHost.appendChild(h('div.entry-list', items.map(r => reportRow(r, isAdmin, draw))));
      renderPager(pagerHost, res.data, state, p => { state.page = p; draw(); });
    }

    function reportRow(r, isAdmin, reload) {
      const st = STATUS[r.status] || { title: r.status, color: 'grey' };
      const who = r.author
        ? (r.author.username
          ? h('a', { href: '#/u/' + r.author.username, text: r.author.nickname })
          : h('span', { text: r.author.nickname }))
        : null;

      return h('div.report-card', [
        h('div.report-head', [
          h(`span.badge.badge-${st.color}`, { text: st.title }),
          h('span.badge.badge-grey', { text: KIND_TITLE[r.kind] || r.kind }),
          h('span.spacer'),
          h('span.field-hint', { text: ui.ago(r.created_at) }),
        ]),
        h('h3', { text: r.subject }),
        h('p.report-body', { text: r.body }),
        isAdmin && who ? h('div.field-hint', [h('span', { text: 'От: ' }), who]) : null,
        r.admin_note
          ? h('div.admin-note', [h('b', { text: 'Ответ администратора: ' }), h('span', { text: r.admin_note })])
          : null,
        isAdmin && r.status === 'open' ? h('div.btn-row', [
          h('button.btn.btn-sm.btn-primary', {
            type: 'button', text: '✓ Принять',
            onclick: () => resolve(r.id, 'accept', reload),
          }),
          h('button.btn.btn-sm.btn-danger', {
            type: 'button', text: '✕ Отклонить',
            onclick: () => resolve(r.id, 'reject', reload),
          }),
        ]) : null,
        isAdmin && r.emailed_at ? h('div.field-hint', { text: '✉ письмо отправлено' }) : null,
      ]);
    }

    async function resolve(id, decision, reload) {
      const note = await ui.prompt({
        title: decision === 'accept' ? 'Принять заявку' : 'Отклонить заявку',
        label: 'Комментарий (увидит автор и получит в письме)',
        required: false,
      });
      if (note === null) return;
      const res = await api.post(`/reports/${id}/resolve`, { body: { decision, note } });
      if (!res.ok) { ui.err((res.data && res.data.error) || 'Не получилось'); return; }
      ui.ok(decision === 'accept' ? 'Заявка принята' : 'Заявка отклонена');
      reload();
    }

    host.appendChild(counter);
    host.appendChild(listHost);
    host.appendChild(pagerHost);
    draw();
  }

  /** Разбивка на страницы — как в dotadle. */
  function renderPager(host, data, state, onGo) {
    const pages = data.pages || 1;
    if (pages <= 1) return;
    const page = data.page || state.page;
    const mk = (p, label, disabled) => h(`button.btn.btn-sm${p === page ? '.btn-primary' : ''}`, {
      type: 'button', text: label, disabled: disabled || false,
      onclick: () => onGo(p),
    });
    host.appendChild(h('div.pager', [
      mk(Math.max(1, page - 1), '←', page <= 1),
      h('span.field-hint', { text: `Страница ${page} из ${pages} · всего ${data.total}` }),
      mk(Math.min(pages, page + 1), '→', page >= pages),
    ]));
  }

  window.views = window.views || {};
  window.views.reports = { renderList, renderNew, renderPager };
})();
