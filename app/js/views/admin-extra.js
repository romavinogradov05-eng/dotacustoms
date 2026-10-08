/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — админские вкладки: очередь, заявления, почта, доступ
   ──────────────────────────────────────────────────────────────────────
   Всё, что администратору нужно для разбора присланного:
     • очередь модерации (билды и топы обычных игроков) с разбивкой
       на страницы и кнопкой «отклонить все на странице» — как в dotadle;
     • заявки в свободной форме: ник автора, тема, текст, решение;
     • настройка SMTP, чтобы письма о решении доходили;
     • общий доступ по локальной сети, чтобы другие видели билды.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /* ══ очередь модерации ═════════════════════════════════════════════ */

  async function drawQueue(host, query) {
    const state = { type: query.qtype || 'build', page: Number(query.qpage) || 1 };
    const tabs = h('div.tabs');
    const listHost = h('div');
    const pager = h('div.pager');
    const counter = h('div.field-hint', { style: { margin: '10px 0' } });

    function drawTabs(counts) {
      clear(tabs);
      for (const [key, title] of [['build', 'Билды'], ['top', 'Топы']]) {
        const n = (counts || {})[key];
        tabs.appendChild(h(`button.tab${state.type === key ? '.active' : ''}`, {
          type: 'button',
          text: n ? `${title} (${n})` : title,
          onclick: () => { state.type = key; state.page = 1; load(); },
        }));
      }
    }

    async function load() {
      clear(listHost);
      clear(pager);
      const res = await api.get(`/admin/queue?type=${state.type}&page=${state.page}`);
      if (!res.ok) {
        listHost.appendChild(common.empty({
          icon: '⚠', title: 'Не получилось загрузить очередь',
          text: (res.data && res.data.error) || 'Ошибка сервера',
        }));
        return;
      }
      const data = res.data;
      drawTabs(data.counts);
      counter.textContent = data.total
        ? `${data.total} ${ui.plural(data.total, 'заявка', 'заявки', 'заявок')} ждут решения`
        : '';

      if (!data.items.length) {
        listHost.appendChild(common.empty({
          icon: '✅', title: 'Очередь пуста',
          text: 'Все присланное подтверждено или отклонено.',
        }));
        return;
      }

      const picked = new Set();
      for (const item of data.items) {
        const check = h('input', {
          type: 'checkbox',
          onchange: e => {
            if (e.target.checked) picked.add(item.id); else picked.delete(item.id);
          },
        });
        listHost.appendChild(h('div.queue-row', [
          h('label.check', [check, h('span', { text: '' })]),
          h('div.info', [
            h('div.entry-title', [
              h('a', { href: `#${item.route}/${item.id}`, text: item.title }),
              item.patch ? h('span.badge.badge-grey', { text: 'патч ' + item.patch }) : null,
            ]),
            h('div.entry-sub', {
              text: `${item.author.nickname} (@${item.author.username}) · ${item.mode}`
                + (item.kind ? ' · ' + item.kind : '')
                + ` · ${item.ago}`,
            }),
            item.description ? h('div.entry-note', { text: item.description.slice(0, 300) }) : null,
          ]),
          h('div.btn-row', [
            h('button.btn.btn-sm.btn-primary', {
              type: 'button', text: '✓',
              title: 'Подтвердить', onclick: () => decide(item.id, 'approve'),
            }),
            h('button.btn.btn-sm.btn-danger', {
              type: 'button', text: '✕',
              title: 'Отклонить', onclick: () => decide(item.id, 'reject'),
            }),
          ]),
        ]));
      }

      // «Отклонить все» — только для отмеченных, как в dotadle.
      const all = h('div.btn-row', { style: { marginTop: '12px' } }, [
        h('button.btn.btn-sm', {
          type: 'button', text: 'Отметить все на странице',
          onclick: () => {
            data.items.forEach(i => picked.add(i.id));
            listHost.querySelectorAll('input[type=checkbox]').forEach(c => { c.checked = true; });
          },
        }),
        h('button.btn.btn-sm.btn-danger', {
          type: 'button', text: 'Отклонить отмеченные',
          onclick: async () => {
            if (!picked.size) { ui.err('Сначала отметь галочкой нужные строки'); return; }
            if (!confirm(`Отклонить ${picked.size} шт.?`)) return;
            const r = await api.post(`/admin/queue/${state.type}/reject-all`, { body: { ids: [...picked] } });
            if (!r.ok) { ui.err((r.data && r.data.error) || 'Не получилось'); return; }
            ui.ok(`Отклонено: ${r.data.done}`);
            picked.clear();
            load();
          },
        }),
      ]);
      listHost.appendChild(all);

      const mk = (p, label, dis) => h(`button.btn.btn-sm${p === data.page ? '.btn-primary' : ''}`, {
        type: 'button', text: label, disabled: dis || false,
        onclick: () => { state.page = p; load(); },
      });
      if ((data.pages || 1) > 1) {
        pager.appendChild(h('div.pager', [
          mk(Math.max(1, data.page - 1), '←', data.page <= 1),
          h('span.field-hint', { text: `Страница ${data.page} из ${data.pages} · всего ${data.total}` }),
          mk(Math.min(data.pages, data.page + 1), '→', data.page >= data.pages),
        ]));
      }
    }

    async function decide(id, decision) {
      const note = await ui.prompt({
        title: decision === 'approve' ? 'Подтвердить' : 'Отклонить',
        label: 'Комментарий автору (придёт в уведомления и на почту)',
      });
      if (note === null) return;
      const res = await api.post(`/admin/queue/${state.type}/${id}`, { body: { decision, note } });
      if (!res.ok) { ui.err((res.data && res.data.error) || 'Не получилось'); return; }
      ui.ok(decision === 'approve' ? 'Подтверждено' : 'Отклонено');
      load();
    }

    host.appendChild(tabs);
    host.appendChild(counter);
    host.appendChild(listHost);
    host.appendChild(pager);
    load();
  }

  /* ══ заявки в свободной форме ═════════════════════════════════════
     Отдельной копии списка здесь нет: он общий с разделом «Заявки»
     (/reports) — там же пагинация, решение и письмо автору. Дублировать
     его значило бы со временем развести две реализации врозь. */
  async function drawReports(host, query) {
    await window.views.reports.renderList(host, {}, {
      page: query.rpage, status: query.rstatus,
    });
  }

  /* ══ общий доступ по сети ══════════════════════════════════════════ */

  async function drawShare(host) {
    clear(host);
    const box = h('div.panel');
    host.appendChild(box);

    const res = await api.get('/share');
    const info = res.ok ? res.data : { enabled: false, urls: [] };

    const urlsBox = h('div.share-urls');

    function paintUrls() {
      clear(urlsBox);
      if (!info.enabled) {
        urlsBox.appendChild(h('div.field-hint', {
          text: 'Сейчас хаб доступен только на этом компьютере. Никто в сети его не видит.',
        }));
        return;
      }
      urlsBox.appendChild(h('p', {
        text: 'Отдай эти ссылки тем, кому нужен общий доступ. Они откроют хаб '
          + 'в обычном браузере и увидят все билды, топы и ветки.',
      }));
      for (const u of info.urls) {
        urlsBox.appendChild(h('div.share-url', [
          h('code', { text: u }),
          h('button.btn.btn-sm', {
            type: 'button', text: 'Скопировать',
            onclick: () => {
              navigator.clipboard.writeText(u).then(() => ui.ok('Скопировано'), () => ui.err('Не вышло'));
            },
          }),
        ]));
      }
      if (!info.urls.length) {
        urlsBox.appendChild(h('div.field-hint', {
          text: 'Компьютер не подключён к сети — ссылок нет.',
        }));
      }
    }

    const toggle = h('input', { type: 'checkbox', checked: info.enabled ? true : false });
    toggle.addEventListener('change', async () => {
      const on = toggle.checked;
      const r = await api.post('/share', { body: { enabled: on } });
      if (!r.ok) {
        toggle.checked = !on;   // вернуть как было
        ui.err((r.data && r.data.error) || 'Не получилось переключить');
        return;
      }
      Object.assign(info, r.data);
      paintUrls();
      ui.ok(on
        ? 'Общий доступ включён. Ссылки ниже — отдай их друзьям.'
        : 'Общий доступ выключен, хаб снова только на этом компьютере.');
    });

    box.appendChild(h('div.panel-title', { text: '🌐 Общий доступ по локальной сети' }));
    box.appendChild(h('div.help-note', [
      h('b', { text: 'Зачем это нужно. ' }),
      'База одна — локальный файл на этом компьютере. Без общего доступа '
      + 'другие игроки её не видят. С включённым доступом они открывают ссылку '
      + 'в браузере и работают с той же базой: видят твои билды и топы, '
      + 'и добавляют свои.',
    ]));
    box.appendChild(h('label', { style: { display: 'flex', gap: '10px', alignItems: 'center', margin: '14px 0' } }, [
      toggle, h('span', { text: 'Разрешить доступ из локальной сети' }),
    ]));
    box.appendChild(urlsBox);
    box.appendChild(h('div.help-note', { style: { marginTop: '14px' } }, [
      h('b', { text: 'Учти. ' }),
      'Доступ получают все, кто в одной сети и знает адрес. Если сеть не '
      + 'доверенная (интернет-кафе, общий Wi-Fi) — не включай. При выключении '
      + 'хаб снова слушает только 127.0.0.1.',
    ]));
    paintUrls();
  }

  /* ══ почта ═════════════════════════════════════════════════════════ */

  async function drawMail(host) {
    clear(host);
    const res = await api.get('/mail');
    const cfg = res.ok ? (res.data.settings || {}) : {};

    const f = {};
    const mk = (key, label, type, hint) => {
      f[key] = h('input.input', {
        type: type || 'text', value: cfg[key] || '', placeholder: hint || '',
      });
      return h('div.field', [h('label', { text: label }), f[key]]);
    };

    const secure = h('input', { type: 'checkbox', checked: cfg.secure ? true : false });

    const status = h('div.help-note', {
      text: res.ok && res.data.configured
        ? 'Почта настроена — решения будут приходить письмами.'
        : 'Почта не настроена. Решения по заявкам придут в уведомления, но письма не уйдут.',
    });

    const form = h('form', {
      style: { display: 'flex', flexDirection: 'column', gap: '12px' },
      onsubmit: async e => {
        e.preventDefault();
        const r = await api.post('/mail', {
          body: {
            host: f.host.value, port: f.port.value, secure: secure.checked,
            user: f.user.value, pass: f.pass.value, from: f.from.value,
            fromName: f.fromName.value,
          },
        });
        if (!r.ok) { ui.err((r.data && r.data.error) || 'Не получилось сохранить'); return; }
        ui.ok('Настройки сохранены');
        f.pass.value = '';
        drawMail(host);
      },
    }, [
      mk('host', 'Сервер SMTP', 'text', 'например smtp.yandex.ru или smtp.mail.ru'),
      h('div.inline-form', [
        mk('port', 'Порт', 'number', '465 или 587'),
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
          secure, h('span', { text: 'Защищённое соединение (SMTPS, порт 465)' }),
        ]),
      ]),
      mk('user', 'Логин', 'text', 'почта целиком, если сервер требует'),
      mk('pass', 'Пароль', 'password', 'оставь пустым, чтобы не менять'),
      mk('from', 'Адрес отправителя', 'email', 'с него будут приходить письма'),
      mk('fromName', 'Имя отправителя', 'text', 'DotaCustoms'),
      status,
      h('div.btn-row', [
        h('button.btn.btn-primary', { type: 'submit', text: 'Сохранить' }),
        h('button.btn', {
          type: 'button', text: '✉ Отправить тестовое',
          onclick: async () => {
            const r = await api.post('/mail/test', { body: { to: f.user.value } });
            if (!r.ok) { ui.err((r.data && r.data.error) || 'Не отправилось'); return; }
            ui.ok('Тестовое письмо отправлено: ' + r.data.sent_to);
          },
        }),
        h('button.btn', {
          type: 'button', text: 'Отправить очередь',
          onclick: async () => {
            const r = await api.post('/mail/flush', {});
            if (!r.ok) { ui.err((r.data && r.data.error) || 'Не получилось'); return; }
            ui.ok(`Отправлено ${r.data.sent}, с ошибкой ${r.data.failed}`);
          },
        }),
      ]),
    ]);

    host.appendChild(h('div.panel', [
      h('div.panel-title', { text: '✉ Почта для уведомлений' }),
      h('div.help-note', [
        h('b', { text: 'Зачем. ' }),
        'Когда администратор принял или отклонил твою заявку, решение приходит '
        + 'в колокольчик в шапке. Если в профиле указана почта — ещё и письмом.',
      ]),
      form,
    ]));

    // Очередь писем — видно, что не ушло и почему.
    const queueHost = h('div');
    host.appendChild(queueHost);
    const q = await api.get('/admin/mail-queue');
    if (q.ok) {
      host.appendChild(h('div.panel', { style: { marginTop: '18px' } }, [
        h('div.panel-title', [
          h('span', { text: '📮 Очередь писем' }),
          h('span.spacer'),
          h('span.badge.badge-grey', { text: `в ожидании: ${q.data.pending}` }),
        ]),
        q.data.items.length
          ? h('div.entry-list', q.data.items.slice(0, 30).map(m => h('div.entry-row', [
            h('div.info', [
              h('span.nm', { text: m.subject }),
              h('span.note', { text: `${m.to} · попыток ${m.attempts}${m.last_error ? ' · ' + m.last_error : ''}` }),
            ]),
            h(`span.badge.badge-${m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : 'yellow'}`, {
              text: m.status === 'sent' ? 'отправлено' : m.status === 'failed' ? 'ошибка' : 'ждёт',
            }),
          ])))
          : h('div.field-hint', { text: 'Очередь пуста.' }),
      ]));
    }
  }

  /* ══ проверка комментариев и постов веток ═══════════════════════════ */

  // Очередь авто-модерации: здесь живут сообщения, задержанные фильтром
  // (build_comments и posts). Одобрить = опубликовать, отклонить = скрыть.
  async function drawComments(host, query) {
    const state = { status: query.cstatus || 'pending', page: Number(query.cpage) || 1 };
    const listHost = h('div');
    const pager = h('div.pager');
    const counter = h('div.field-hint', { style: { margin: '10px 0' } });
    const statusTabs = h('div.tabs');

    function drawTabs(total) {
      clear(statusTabs);
      for (const [key, title] of [['pending', 'На проверке'], ['done', 'Решённые']]) {
        statusTabs.appendChild(h(`button.tab${state.status === key ? '.active' : ''}`, {
          type: 'button',
          text: key === 'pending' && total ? `${title} (${total})` : title,
          onclick: () => { state.status = key; state.page = 1; load(); },
        }));
      }
    }

    host.appendChild(statusTabs);
    host.appendChild(counter);
    host.appendChild(listHost);
    host.appendChild(pager);

    async function load() {
      clear(listHost);
      clear(pager);
      const res = await api.get(`/admin/comments?status=${state.status}&page=${state.page}`);
      if (!res.ok) {
        listHost.appendChild(common.empty({
          icon: '⚠', title: 'Не получилось загрузить очередь',
          text: (res.data && res.data.error) || 'Ошибка сервера',
        }));
        return;
      }
      const data = res.data;
      drawTabs(data.total);
      counter.textContent = data.total
        ? `${data.total} ${ui.plural(data.total,
            state.status === 'pending' ? 'сообщение' : 'решённое',
            state.status === 'pending' ? 'сообщения' : 'решённых',
            state.status === 'pending' ? 'сообщений' : 'решённых')}`
        : '';

      if (!data.items.length) {
        listHost.appendChild(common.empty({
          icon: '✅', title: state.status === 'pending' ? 'Всё проверено' : 'Пока пусто',
          text: state.status === 'pending'
            ? 'Фильтр ничего не задержал — все сообщения опубликованы.'
            : 'Одобренные и отклонённые сообщения появятся здесь.',
        }));
        return;
      }

      for (const item of data.items) {
        const kindBadge = item.kind === 'post'
          ? h('span.badge.badge-grey', { text: 'ветка' })
          : h('span.badge.badge-yellow', { text: 'билд' });
        listHost.appendChild(h('div.queue-row', [
          h('div.info', [
            h('div.entry-title', [
              kindBadge,
              item.is_deleted ? h('span.badge.badge-red', { text: 'скрыто' }) : null,
              item.moderation === 'pending' ? h('span.badge.badge-pending', { text: '⏳ ждёт' }) : null,
            ]),
            h('div.entry-sub', {
              text: `${item.author_nickname} (@${item.author_username}) · ${item.ago}`
                + (item.parent_id ? ' · ответ' : ''),
            }),
            h('div.entry-note', { text: `В «${item.target_title || '…'}»` }),
            h('div.entry-quote', { text: item.body }),
          ]),
          h('div.btn-row', [
            h('a.btn.btn-sm', { href: `#${item.target_route}`, text: 'Открыть' }),
            h('button.btn.btn-sm.btn-primary', {
              type: 'button', text: '✓', title: 'Опубликовать',
              onclick: () => decide(item, 'approve'),
            }),
            h('button.btn.btn-sm.btn-danger', {
              type: 'button', text: '✕', title: 'Отклонить и скрыть',
              onclick: () => decide(item, 'reject'),
            }),
          ]),
        ]));
      }

      if ((data.pages || 1) > 1) {
        const mk = (p, label, dis) => h(`button.btn.btn-sm${p === data.page ? '.btn-primary' : ''}`, {
          type: 'button', text: label, disabled: dis || false,
          onclick: () => { state.page = p; load(); },
        });
        pager.appendChild(h('div.pager', [
          mk(Math.max(1, data.page - 1), '←', data.page <= 1),
          h('span.field-hint', { text: `Страница ${data.page} из ${data.pages} · всего ${data.total}` }),
          mk(Math.min(data.pages, data.page + 1), '→', data.page >= data.pages),
        ]));
      }
    }

    async function decide(item, decision) {
      const note = await ui.prompt({
        title: decision === 'approve' ? 'Опубликовать сообщение' : 'Отклонить сообщение',
        label: 'Комментарий автору (необязательно)',
      });
      if (note === null) return;
      const res = await api.post('/admin/comments/decide', {
        body: { kind: item.kind, id: item.id, decision, note },
      });
      if (!res.ok) { ui.err((res.data && res.data.error) || 'Не получилось'); return; }
      ui.ok(decision === 'approve' ? 'Опубликовано' : 'Отклонено и скрыто');
      load();
    }

    load();
  }

  window.adminExtra = { drawQueue, drawComments, drawReports, drawShare, drawMail };
})();
