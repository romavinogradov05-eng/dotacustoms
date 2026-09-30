/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — ячейка уведомлений в шапке
   ──────────────────────────────────────────────────────────────────────
   Пользователь просил, чтобы решение по его билду приходило «в ячейку
   уведомления». Ячейка — это колокольчик в правом углу шапки: красная
   точка с числом непрочитанных, по клику — выпадающий список.

   Счётчик обновляется сам раз в полминуты, а также после любого действия,
   меняющего состояние. Гостю колокольчик не показывается.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const POLL_MS = 30_000;

  const ICON = {
    moderation: '🛡',
    report: '📨',
    reply: '💬',
    system: '⚙',
  };

  const state = {
    unread: 0,
    items: [],
    open: false,
    loading: false,
    timer: null,
  };

  /* ── загрузка ──────────────────────────────────────────────────────── */

  async function refresh({ withList = false } = {}) {
    if (!store.me) return;
    const res = withList
      ? await api.get('/notifications?limit=20')
      : await api.get('/notifications/unread');
    if (!res.ok) return;

    if (withList) {
      state.items = (res.data && res.data.items) || [];
      state.unread = (res.data && res.data.unread) || 0;
    } else {
      state.unread = (res.data && res.data.unread) || 0;
    }
    paint();
  }

  /* ── отрисовка ─────────────────────────────────────────────────────── */

  let bellNode = null;
  let panelNode = null;

  function paint() {
    if (!store.me || !bellNode) return;
    clear(bellNode);
    bellNode.appendChild(h('span.bell-icon', { text: '🔔' }));
    if (state.unread > 0) {
      bellNode.appendChild(h('span.bell-badge', {
        text: state.unread > 99 ? '99+' : String(state.unread),
        title: `${state.unread} непрочитанных`,
      }));
    }
    bellNode.setAttribute('aria-label',
      state.unread > 0 ? `Уведомления: ${state.unread}` : 'Уведомления');
    bellNode.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    if (panelNode) paintPanel();
  }

  function paintPanel() {
    clear(panelNode);
    if (!state.loading && !state.items.length) {
      panelNode.appendChild(h('div.notif-empty', { text: 'Пока пусто. Здесь появятся решения по твоим билдам и заявкам.' }));
      return;
    }
    for (const n of state.items) {
      const row = h(`div.notif-row${n.is_read ? '' : '.unread'}`, [
        h('div.notif-icon', { text: ICON[n.kind] || '•' }),
        h('div.notif-body', [
          h('div.notif-title', { text: n.title }),
          n.body ? h('div.notif-text', { text: n.body }) : null,
          h('div.notif-meta', { text: ui.ago(n.created_at) }),
        ]),
      ]);
      if (n.link) {
        row.classList.add('clickable');
        row.addEventListener('click', async () => {
          if (!n.is_read) {
            await api.post(`/notifications/${n.id}/read`);
            n.is_read = true;
            state.unread = Math.max(0, state.unread - 1);
          }
          close();
          if (n.link) router.go(n.link);
        });
      } else {
        row.addEventListener('click', async () => {
          if (n.is_read) return;
          await api.post(`/notifications/${n.id}/read`);
          n.is_read = true;
          state.unread = Math.max(0, state.unread - 1);
          paint();
        });
      }
      panelNode.appendChild(row);
    }
  }

  function open() {
    state.open = true;
    state.loading = true;
    paint();
    refresh({ withList: true }).then(() => { state.loading = false; paint(); });
  }

  function close() {
    state.open = false;
    if (panelNode && panelNode.parentNode) panelNode.parentNode.removeChild(panelNode);
    panelNode = null;
    bellNode && bellNode.setAttribute('aria-expanded', 'false');
  }

  /* ── публичное ─────────────────────────────────────────────────────── */

  /** Ставит колокольчик в шапку (или убирает, если вышел пользователь). */
  function mount(host) {
    unmount();
    if (!store.me || !host) return;

    bellNode = h('button.icon-btn.notif-bell', {
      type: 'button',
      title: 'Уведомления',
      onclick: e => {
        e.stopPropagation();
        if (state.open) close(); else open();
      },
    });

    // Колокольчик — первым в шапке. insertBefore есть в обычном DOM,
    // но в упрощённой оболочке тестов его может не быть.
    if (typeof host.insertBefore === 'function') host.insertBefore(bellNode, host.firstChild);
    else host.appendChild(bellNode);
    paint();

    // Клик вне выпадающего списка закрывает его
    document.addEventListener('click', onOutside, true);
    state.timer = setInterval(() => { if (!state.open) refresh(); }, POLL_MS);

    refresh({ withList: true });
  }

  function onOutside(e) {
    if (!state.open) return;
    const panel = document.getElementById('notif-panel');
    if (panel && (panel.contains(e.target) || (bellNode && bellNode.contains(e.target)))) return;
    close();
  }

  function unmount() {
    close();
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (bellNode && bellNode.parentNode) bellNode.parentNode.removeChild(bellNode);
    bellNode = null;
    document.removeEventListener('click', onOutside, true);
  }

  /** Вручную обновить счётчик — после создания билда, заявки и т.п. */
  function bump() { if (store.me) refresh(); }

  window.notifications = { mount, unmount, refresh, bump, close, get unread() { return state.unread; } };
})();
