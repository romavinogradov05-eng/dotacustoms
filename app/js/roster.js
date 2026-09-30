/* Настройка ростера героев прямо в приложении.
   Раньше это был файл data/custom/rosters.json плюс пересборка датасета —
   то есть внутри программы настроить список было нельзя вовсе. */
'use strict';

(function () {
  const { h, clear, modal, closeModal, ok, apiError } = window.ui;

  const ROLES = { ADMIN: 'admin', COACH: 'coach' };

  /** Есть ли право править ростер режима. */
  function canEdit(mode) {
    const me = store.me;
    if (!me) return false;
    if (me.role === ROLES.ADMIN) return true;
    if (me.role !== ROLES.COACH) return false;
    const scopes = me.coach_scopes || [];
    return scopes.includes('*') || scopes.includes(mode);
  }

  /**
   * Экран «ростер героев».
   * mode — 'chc' | 'rr'
   */
  async function render(host, mode) {
    clear(host);
    const res = await api.get('/rosters');
    if (!res.ok) { host.appendChild(h('div.empty', { text: 'Ростер не загрузился' })); return; }
    const roster = (res.data.rosters || {})[mode] || { keys: [] };

    const all = store.heroes.slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    // Если ростер задан, но герои не нашлись — это баг сопоставления
    // ключей, и молчать о нём нельзя.
    const chosen = new Set(roster.keys.map(String));
    const known = all.filter(x => chosen.has(String(x.key)));
    const missing = roster.keys.filter(k => !store.heroByKey.has(String(k)));

    const search = h('input.input', {
      type: 'text', placeholder: 'Поиск по героям…', autocomplete: 'off',
    });
    const list = h('div.roster-list');
    const counter = h('div.field-hint');

    /** Что показываем в списке: ростер, либо чёрный список. */
    let inverted = chosen.size > 0 && chosen.size < all.length;

    function matched() {
      const q = (search.value || '').trim().toLowerCase();
      if (!q) return all;
      return all.filter(x => x.name.toLowerCase().includes(q) || String(x.key).includes(q));
    }

    function paint() {
      clear(list);
      const rows = matched();
      for (const hero of rows) {
        const inRoster = inverted ? !chosen.has(String(hero.key)) : chosen.has(String(hero.key));
        const row = h('button.roster-row' + (inRoster ? '.on' : ''), { type: 'button' }, [
          h('img.icon.round', { src: store.heroIcon(hero), alt: '' }),
          h('span.nm', { text: hero.name }),
          h('span.sub', { text: hero.key }),
          h('span.mark', { text: inRoster ? '✓' : '' }),
        ]);
        row.addEventListener('click', () => {
          if (inverted) chosen.add(String(hero.key));
          else chosen.delete(String(hero.key));
          paint();
        });
        list.appendChild(row);
      }
      if (!rows.length) list.appendChild(h('div.empty', { text: 'Никого не нашлось' }));

      const n = chosen.size;
      counter.textContent = n
        ? `В ростере ${n} из ${all.length} героев${inverted ? ' (режим «вне ростера»)' : ''}`
        : `Ростер не задан — доступны все ${all.length} героев`;
    }

    search.addEventListener('input', paint);
    paint();

    const saveBtn = h('button.btn', {
      type: 'button', text: 'Сохранить ростер',
      onclick: async () => {
        saveBtn.disabled = true;
        const r = await api.post('/rosters/' + mode, {
          body: { keys: [...chosen], note: 'настроен в приложении' },
        });
        saveBtn.disabled = false;
        if (!r.ok) { apiError(r, 'Ростер не сохранён'); return; }
        // Конфиг на клиенте устарел — обновляем, иначе фильтр в редакторе
        // билда останется прежним до перезапуска.
        const cfg = await api.get('/config');
        if (cfg.ok) store.config.rosters = cfg.data.rosters || {};
        ok('Ростер сохранён — в выборе героя ' + (r.data.heroes_visible) + ' героев');
        closeModal();
      },
    });

    const resetBtn = h('button.btn.btn-ghost', {
      type: 'button', text: 'Сбросить (все герои)',
      onclick: async () => {
        resetBtn.disabled = true;
        const r = await api.delete('/rosters/' + mode);
        resetBtn.disabled = false;
        if (!r.ok) { apiError(r, 'Сброс не удался'); return; }
        const cfg = await api.get('/config');
        if (cfg.ok) store.config.rosters = cfg.data.rosters || {};
        ok('Ростер сброшен — доступны все герои');
        closeModal();
      },
    });

    const body = [
      h('div.help-note', {
        text: 'В справочнике Dota ' + all.length + ' героев, а в ' + (store.mode(mode).title || mode)
          + ' играют не все. Отметь тех, кто в игре — и в выборе героя, и в '
          + 'редакторе топа останутся только они. Не отмечать ничего нельзя: '
          + 'пустой ростер означает «доступны все».',
      }),
      missing.length ? h('div.warn-note', {
        text: 'В сохранённом ростере есть ключи, которых нет в справочнике: '
          + missing.join(', ') + '. Они не учитываются.',
      }) : null,
      search,
      counter,
      h('div.btn-row', { style: { marginTop: '8px' } }, [
        h('button.btn.btn-sm.btn-ghost', {
          type: 'button', text: 'Показать всех', onclick: () => { chosen.clear(); inverted = false; paint(); },
        }),
        h('button.btn.btn-sm.btn-ghost', {
          type: 'button', text: 'Отметить всех', onclick: () => {
            for (const x of all) chosen.add(String(x.key));
            inverted = false; paint();
          },
        }),
        h('button.btn.btn-sm.btn-ghost', {
          type: 'button', text: 'Инвертировать выбор', title: 'Отмечать тех, кого в игре НЕТ',
          onclick: () => {
            inverted = !inverted;
            paint();
          },
        }),
      ]),
      list,
    ];

    const actions = canEdit(mode)
      ? [saveBtn, resetBtn]
      : [h('div.field-hint', {
        text: 'Править ростер может админ или Coach с правом на этот режим.',
      })];

    modal({
      title: 'Ростер героев — ' + (store.mode(mode).title || mode),
      body,
      actions,
      wide: true,
    });
  }

  window.rosterView = { render, canEdit };
})();
