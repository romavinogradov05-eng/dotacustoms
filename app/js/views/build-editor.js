/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — редактор билда
   ──────────────────────────────────────────────────────────────────────
   Один и тот же экран и для нового билда (#/builds/new), и для правки
   (#/builds/:id/edit). Состояние держим в локальном объекте, на сервер
   уходит один POST или PATCH.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const C = () => store.config.limits || {};
  const MAX_ITEMS = () => store.limit('maxItems', 6);
  const MAX_SKILLS = () => store.limit('maxSkills', 20);
  const MAX_TALENTS = () => store.limit('maxTalents', store.TALENT_LEVELS.length);
  const MAX_NEUTRALS = () => store.limit('maxNeutrals', 12);

  /** Пустая модель билда. */
  function blank(mode) {
    return {
      id: null,
      mode: mode || (store.config.modes[0] && store.config.modes[0].key) || 'chc',
      hero_id: null,
      title: '',
      description: '',
      patch: store.patch || '',
      is_draft: true,
      items: [],       // [{ item_id, note }]
      skills: [],      // [{ ability_id, rank }]
      talents: [],     // [ability_id]
      neutrals: [],    // [{ neutral_id, note }]
    };
  }

  async function render(host, params) {
    if (!store.me) {
      router.go('/login');
      ui.err('Чтобы собрать билд, нужно войти');
      return;
    }

    clear(host);
    const isEdit = !!params.id;

    // Создавать билды могут только Coach и администраторы. Свою старую
    // сборку автор правит как раньше — это проверяет сервер по can_edit.
    if (!isEdit && !store.isStaff()) {
      host.appendChild(h('div.error-panel', [
        h('h3', { text: 'Нет доступа' }),
        h('p', { text: 'Билды создают Coach и администраторы. Обычный игрок участвует голосами, комментариями, жалобами и заявлениями.' }),
        h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/builds', text: '← К списку' })),
      ]));
      return;
    }

    /* ── исходные данные ── */
    let model = blank();
    let original = null;
    if (isEdit) {
      host.appendChild(h('div.loading-panel', [h('div.spinner')]));
      const res = await api.get('/builds/' + encodeURIComponent(params.id));
      clear(host);
      if (!res.ok) {
        host.appendChild(h('div.error-panel', [
          h('h3', { text: 'Билд не открылся' }),
          h('p', { text: (res.data && res.data.error) || 'Ошибка' }),
          h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/builds', text: '← К списку' })),
        ]));
        return;
      }
      const b = res.data.build;
      if (!b.can_edit) {
        host.appendChild(h('div.error-panel', [
          h('h3', { text: 'Нет доступа' }),
          h('p', { text: 'Редактировать билд может только автор или администратор.' }),
          h('div.btn-row', { style: { marginTop: '14px' } }, h('a.btn', { href: '#/builds/' + b.id, text: '← К билду' })),
        ]));
        return;
      }
      model = {
        id: b.id,
        mode: b.mode,
        hero_id: b.hero_id,
        title: b.title,
        description: b.description || '',
        patch: b.patch || store.patch || '',
        is_draft: !!b.is_draft,
        items: (b.items || []).slice(),
        skills: (b.skills || []).slice(),
        talents: (b.talents || []).slice(),
        neutrals: (b.neutrals || []).slice(),
      };
      original = JSON.stringify(model);
    }

    /* ── заголовок ── */
    host.appendChild(h('div.page-head', [
      h('div', [
        h('h1', { text: isEdit ? 'Правка билда' : 'Новый билд' }),
        h('div.sub', {
          text: 'Накидай предметы, скиллы из пула CHC, таланты и нейтралки. Герой необязателен. Черновик видишь только ты.',
        }),
      ]),
      h('div.btn-row', [
        h('a.btn.btn-ghost', {
          href: isEdit ? '#/builds/' + model.id : '#/builds',
          text: '← Отмена',
        }),
        h('button.btn.btn-primary', { type: 'button', text: '💾 Сохранить', onclick: () => save(false) }),
      ]),
    ]));

    const layout = h('div.build-layout');
    const main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });
    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } });

    /* ═══════ основное ═══════ */
    const modeTabs = h('div.tabs');
    function drawModes() {
      clear(modeTabs);
      for (const m of store.config.modes) {
        modeTabs.appendChild(h(`button.tab${model.mode === m.key ? '.active' : ''}`, {
          type: 'button', text: m.title,
          onclick: () => { model.mode = m.key; drawModes(); drawHeroMeta(); },
        }));
      }
    }
    drawModes();

    const titleInput = h('input.input', {
      type: 'text', maxlength: C().titleMax || 120,
      placeholder: 'Например: Антимаг через БКБ и Блинк — стабильный лейт',
      value: model.title,
      oninput: e => { model.title = e.target.value; },
    });

    const descArea = h('textarea.textarea', {
      maxlength: C().descriptionMax || 4000,
      placeholder: 'Как играть, что важно, чего избегать. Можно использовать markdown (**жирный**, списки, `код`).',
    });
    descArea.value = model.description;
    descArea.addEventListener('input', () => { model.description = descArea.value; });

    /* ── герой ──────────────────────────────────────────────────────────
       Необязательный. В CHC и Ratten Run героя часто назначает сама
       игра, и билд «на весь ростер» — обычное дело, поэтому герой здесь
       не заголовок экрана, а одна строка: видно, что он есть, и его
       можно не задавать вовсе. Пустое hero_id сервер принимает.
       ──────────────────────────────────────────────────────────────── */
    const heroHost = h('div');
    function drawHero() {
      clear(heroHost);
      const hero = model.hero_id ? store.heroById.get(Number(model.hero_id)) : null;

      // Герой остался от прежнего ростера — прямо говорим об этом,
      // иначе билд молча исчезнет из выдачи по режиму.
      const stray = store.heroOutOfRoster(model.mode, model.hero_id);

      if (!hero) {
        heroHost.appendChild(h('div.hero-row', [
          h('span.hero-row-label', { text: 'Герой' }),
          h('span.hero-row-val.dim', [
            h('span', { text: 'не привязан — билд для всего ростера' }),
          ]),
          h('button.btn.btn-sm', {
            type: 'button', text: 'Выбрать',
            onclick: () => picker.pickHero({
              picked: [], mode: model.mode,
              onPick: e => { model.hero_id = e.id; drawHero(); drawHeroMeta(); },
            }),
          }),
        ]));
        return;
      }

      heroHost.appendChild(h('div.hero-row', [
        h('span.hero-row-label', { text: 'Герой' }),
        h('span.hero-row-val', {
          style: { cursor: 'pointer' },
          title: 'Кликни — выбор скиллов из пула CHC (до 20)',
          onclick: () => addSkillOpen(),
        }, [
          h('img.icon.round', { src: store.heroIcon(hero), alt: '' }),
          h('span', { text: hero.name }),
          stray ? h('span.badge.badge-red', {
            text: 'нет в ростере',
            title: 'Герой не входит в ростер режима — билд не покажут в общем списке',
          }) : null,
        ]),
        h('div.btn-row', [
          h('button.btn.btn-sm', {
            type: 'button', text: '⛭ Скиллы',
            title: 'Выбрать скиллы из пула CHC (до 20)',
            onclick: () => addSkillOpen(),
          }),
          h('button.btn.btn-sm', {
            type: 'button', text: 'Сменить',
            onclick: () => picker.pickHero({
              picked: [], mode: model.mode,
              onPick: e => { model.hero_id = e.id; drawHero(); drawHeroMeta(); },
            }),
          }),
          h('button.btn.btn-sm.btn-danger', {
            type: 'button', text: 'Убрать',
            title: 'Билд станет для всего ростера',
            onclick: () => { model.hero_id = null; drawHero(); drawHeroMeta(); },
          }),
        ]),
      ]));
    }
    drawHero();

    function drawHeroMeta() {
      // смена героя сбрасывает скиллы и таланты — они принадлежат герою
      drawSkills();
      drawTalents();
    }

    /* предметы: 6 снаряжения + съеденные (Aghanim's Shard, Moon Shards) —
       заполненные слоты плюс кнопка «добавить», а не фиксированная сетка */
    const itemsHost = h('div');
    function drawItems() {
      clear(itemsHost);
      const grid = h('div.slot-grid');
      for (let i = 0; i < model.items.length; i++) {
        const entry = model.items[i];
        const item = entry ? store.anyItemById(entry.item_id) : null;
        if (!item) continue; // битый id не рисуем
        grid.appendChild(h('div.slot', [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flex: '1', minWidth: '0', cursor: 'pointer' },
            onclick: e => { e.stopPropagation(); picker.showCard(item, 'item'); } }, [
            ui.dotaIcon(store.icon(item.img)),
            h('div.info', [
              h('span.nm', { text: picker.displayName(item) }),
              h('span.sub', { text: item.sub || entry.note || picker.costText(item) || '' }),
            ]),
          ]),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } }, [
            h('button.icon-btn', {
              type: 'button', title: 'Заметка', text: '✎', style: { fontSize: '11px' },
              onclick: async () => {
                const note = await ui.prompt({ title: 'Заметка к предмету', label: 'Когда брать / зачем', value: entry.note || '', maxLength: 300 });
                if (note === null) return;
                entry.note = note;
                drawItems();
              },
            }),
            h('button.icon-btn', {
              type: 'button', title: 'Убрать', text: '✕', style: { fontSize: '11px' },
              onclick: () => { model.items.splice(i, 1); drawItems(); },
            }),
          ]),
        ]));
      }
      itemsHost.appendChild(grid);
      if (model.items.length < MAX_ITEMS()) {
        itemsHost.appendChild(h('div', { style: { marginTop: '6px' } }, h('button.btn.btn-sm.btn-ghost', {
          type: 'button', text: '＋ Добавить предмет',
          onclick: () => addItem(model.items.length),
        })));
      }
      itemsHost.appendChild(h('div.field-hint', {
        text: `Заполнено ${model.items.length} из ${MAX_ITEMS()}. Первые 6 — снаряжение, дальше — съеденные (Aghanim's Shard, Moon Shard, книги). Порядок = порядок покупки.`,
      }));
    }

    function addItem(at) {
      const taken = model.items.map(x => x.item_id);
      picker.pickItem({
        picked: taken,
        // предметы показываем только те, что доступны в режиме билда
        mode: model.mode || null,
        onPick: item => {
          if (model.items.length >= MAX_ITEMS()) { ui.err('Все слоты заняты'); return; }
          model.items.splice(Math.min(at, model.items.length), 0, { item_id: item.id, note: '' });
          drawItems();
        },
      });
    }
    drawItems();

    /* скиллы: герой необязателен — без героя доступен пул CHC (любые
       способности Dota, герой тут статовая оболочка), до 20 штук.
       Выбрал героя — добавляются его способности и выбор кликом по герою. */
    const skillsHost = h('div');
    let skillScope = 'pool'; // 'hero' — способности выбранного героя, 'pool' — весь пул CHC
    function heroSel() { return model.hero_id ? store.heroById.get(Number(model.hero_id)) : null; }

    /** Открыть выбор способности из пула CHC (клик по герою / кнопка «Скиллы»). */
    function addSkillOpen() {
      picker.pickAbility({
        heroId: undefined,               // пул CHC — все боевые способности Dota
        picked: model.skills.map(s => s.ability_id),
        onPick: a => {
          if (model.skills.length >= MAX_SKILLS()) { ui.err('Максимум ' + MAX_SKILLS() + ' скиллов'); return; }
          model.skills.push({ ability_id: a.id, rank: model.skills.length + 1 });
          drawSkills();
        },
      });
    }

    function drawSkills() {
      clear(skillsHost);
      const hero = heroSel();
      if (skillScope === 'hero' && !hero) skillScope = 'pool';

      const tabs = h('div.tabs');
      for (const [key, label] of [['hero', 'Способности героя'], ['pool', 'Пул CHC — любая способность']]) {
        tabs.appendChild(h(`button.tab${skillScope === key ? '.active' : ''}`, {
          type: 'button', text: label, disabled: key === 'hero' && !hero,
          title: key === 'hero' && !hero ? 'Сначала выбери героя выше' : '',
          onclick: () => { skillScope = key; drawSkills(); },
        }));
      }
      skillsHost.appendChild(tabs);
      if (!hero) {
        skillsHost.appendChild(h('div.help-note', {
          text: 'Герой не выбран — берём из пула CHC (до ' + MAX_SKILLS() + '). Выбери героя выше, чтобы открыть его способности и выбор кликом по герою.',
        }));
      }

      const table = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } });
      const chosen = new Set(model.skills.map(s => s.ability_id));

      for (let i = 0; i < MAX_SKILLS(); i++) {
        const entry = model.skills[i];
        const ability = entry ? store.abilityById.get(entry.ability_id) : null;
        const row = h('div.talent-row' + (ability ? '.chosen' : ''), { style: { alignItems: 'center' } });

        row.appendChild(h('span.lvl', { text: `ур. ${i + 1}` }));

        if (ability) {
          row.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', flex: '1', minWidth: '0', cursor: 'pointer' },
            onclick: () => picker.showCard(ability, 'ability') }, [
            ability.img ? ui.dotaIcon(store.abilityIcon(ability)) : h('span.icon'),
            h('span.txt', { text: picker.displayName(ability), style: { color: 'var(--text)' } }),
          ]));
        } else {
          row.appendChild(h('button.btn.btn-sm.btn-ghost', {
            type: 'button', text: '＋ выбрать способность',
            onclick: () => picker.pickAbility({
              heroId: skillScope === 'hero' ? hero.id : undefined,
              picked: Array.from(chosen),
              onPick: a => {
                if (model.skills.length >= MAX_SKILLS()) { ui.err('Максимум ' + MAX_SKILLS() + ' скиллов'); return; }
                model.skills.splice(Math.min(i, model.skills.length), 0, { ability_id: a.id, rank: 0 });
                model.skills.forEach((s, idx) => { s.rank = idx + 1; });
                drawSkills();
              },
            }),
          }));
        }

        if (ability) {
          row.appendChild(h('div', { style: { display: 'flex', gap: '4px' } }, [
            h('button.icon-btn', {
              type: 'button', title: 'Выше', text: '↑', style: { fontSize: '11px' },
              disabled: i === 0,
              onclick: () => { swap(model.skills, i, i - 1); drawSkills(); },
            }),
            h('button.icon-btn', {
              type: 'button', title: 'Ниже', text: '↓', style: { fontSize: '11px' },
              disabled: i === model.skills.length - 1,
              onclick: () => { swap(model.skills, i, i + 1); drawSkills(); },
            }),
            h('button.icon-btn', {
              type: 'button', title: 'Убрать', text: '✕', style: { fontSize: '11px' },
              onclick: () => { model.skills.splice(i, 1); model.skills.forEach((s, idx) => { s.rank = idx + 1; }); drawSkills(); },
            }),
          ]));
        }
        table.appendChild(row);
        if (!ability && i >= model.skills.length) break; // дальше пустых не рисуем
      }
      skillsHost.appendChild(table);
      if (model.skills.length < MAX_SKILLS()) {
        skillsHost.appendChild(h('div.field-hint', {
          text: skillScope === 'pool'
            ? 'Пул CHC — любые способности Dota из справочника, до ' + MAX_SKILLS() + '. У каждой работают свои Аганим/Шард-улучшения.'
              + (hero ? ' Кликни по герою, чтобы выбрать ещё.' : '')
            : `Раскладка: ${model.skills.length} из ${MAX_SKILLS()}. Поставь способности в том порядке, в котором качаешь.`,
        }));
      }
    }
    drawSkills();

    /* таланты */
    const talentsHost = h('div');
    function drawTalents() {
      clear(talentsHost);
      const hero = model.hero_id ? store.heroById.get(model.hero_id) : null;
      if (!hero) {
        talentsHost.appendChild(h('div.help-note', { text: 'Сначала выбери героя — таланты подтянутся автоматически.' }));
        return;
      }
      const groups = store.heroTalents(hero.id);
      if (!groups.some(g => g.length)) {
        talentsHost.appendChild(h('div.help-note', { text: 'Таланты этого героя не найдены в справочнике.' }));
        return;
      }
      const levels = store.TALENT_LEVELS;
      const list = h('div.talent-list');
      for (let i = 0; i < MAX_TALENTS(); i++) {
        const lvl = levels[i];
        const pool = groups[i] || [];
        const talentId = model.talents[i];
        const talent = talentId ? store.abilityById.get(talentId) : null;
        const row = h('div.talent-row' + (talent ? '.chosen' : ''));
        row.appendChild(h('span.lvl', { text: `${lvl} ур.` }));
        if (talent) {
          row.appendChild(h('span.txt', { text: picker.displayName(talent), style: { flex: '1', color: 'var(--text)' } }));
          row.appendChild(h('button.icon-btn', {
            type: 'button', title: 'Убрать', text: '✕', style: { fontSize: '11px' },
            onclick: () => { model.talents[i] = null; drawTalents(); },
          }));
        } else if (pool.length) {
          row.appendChild(h('button.btn.btn-sm.btn-ghost', {
            type: 'button', text: '＋ выбрать талант',
            onclick: () => picker.pickTalent({
              heroId: hero.id, picked: model.talents.filter(Boolean), onlyLevel: lvl,
              onPick: t => { model.talents[i] = t.id; drawTalents(); },
            }),
          }));
        } else {
          row.appendChild(h('span.txt', { text: 'нет вариантов — впиши вручную ниже' }));
        }
        list.appendChild(row);
      }
      talentsHost.appendChild(list);

      // ручной выбор любого таланта героя (если раскладка не сошлась)
      const all = store.heroTalents(hero.id).flat();
      if (all.length) {
        const sel = h('select.select', {
          onchange: e => {
            const id = Number(e.target.value);
            if (!id) return;
            const free = model.talents.findIndex(x => !x);
            const at = free >= 0 ? free : 0;
            model.talents[at] = id;
            drawTalents();
          },
        }, [h('option', { value: '', text: 'Добавить талант вручную…' })]);
        for (const t of all) {
          if (model.talents.includes(t.id)) continue;
          sel.appendChild(h('option', { value: String(t.id), text: picker.displayName(t) }));
        }
        talentsHost.appendChild(h('div.field', { style: { marginTop: '12px' } }, [sel]));
      }
    }
    drawTalents();

    /* нейтралки */
    const neutralsHost = h('div');
    function drawNeutrals() {
      clear(neutralsHost);
      const grid = h('div.slot-grid');
      for (let i = 0; i < MAX_NEUTRALS(); i++) {
        const entry = model.neutrals[i];
        const n = entry ? store.neutralById.get(entry.neutral_id) : null;
        if (!n) {
          grid.appendChild(h('button.slot.empty', {
            type: 'button', text: `＋ тир ${Math.min(5, Math.floor(i / 3) + 1)}`,
            onclick: () => addNeutral(i),
          }));
          continue;
        }
        grid.appendChild(h('div.slot', [
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flex: '1', minWidth: '0', cursor: 'pointer' },
            onclick: e => { e.stopPropagation(); picker.showCard(n, 'neutral'); } }, [
            ui.dotaIcon(store.neutralIcon(n)),
            h('div.info', [
              h('span.nm', { text: picker.displayName(n) }),
              h('span.sub', { text: entry.note || `тир ${n.tier}` }),
            ]),
          ]),
          h('button.icon-btn', {
            type: 'button', title: 'Убрать', text: '✕', style: { fontSize: '11px' },
            onclick: () => { model.neutrals.splice(i, 1); drawNeutrals(); },
          }),
        ]));
      }
      neutralsHost.appendChild(grid);
      neutralsHost.appendChild(h('div.field-hint', {
        text: `Нейтралки чаще всего нужны в Ratten Run. Заполнено ${model.neutrals.length} из ${MAX_NEUTRALS()}.`,
      }));
    }
    function addNeutral(at) {
      picker.pickNeutral({
        picked: model.neutrals.map(x => x.neutral_id),
        onPick: n => {
          if (model.neutrals.length >= MAX_NEUTRALS()) { ui.err('Все слоты заняты'); return; }
          model.neutrals.splice(Math.min(at, model.neutrals.length), 0, { neutral_id: n.id, note: '' });
          drawNeutrals();
        },
      });
    }
    drawNeutrals();

    /* собираем основную колонку */
    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: 'Режим и герой' })]),
      modeTabs,
      h('div.field', [h('label', { text: 'Герой' }), heroHost]),
      h('div.field', [h('label', { text: 'Название билда' }), titleInput]),
      h('div.field', [h('label', { text: 'Описание' }), descArea]),
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '🧰 Предметы' })]),
      itemsHost,
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: `⚡ Скиллы (до ${MAX_SKILLS()})` })]),
      skillsHost,
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '★ Таланты' })]),
      talentsHost,
    ]));

    main.appendChild(h('div.panel', [
      h('div.panel-title', [h('span', { text: '🍃 Нейтральные предметы' })]),
      neutralsHost,
    ]));

    /* ═══════ сайдбар ═══════ */
    const patchInput = h('input.input', {
      type: 'text', maxlength: 12, value: model.patch, placeholder: '7.41',
      oninput: e => { model.patch = e.target.value; },
    });

    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Публикация' }),
      h('div.field', [h('label', { text: 'Патч' }), patchInput]),
      h('div.field', [common.draftToggle(() => model.is_draft, v => { model.is_draft = v; }),
        h('div.field-hint', { text: 'Черновик виден только тебе. Нажми кнопку, чтобы опубликовать для всех.' })]),
      h('div.btn-row', [
        h('button.btn.btn-primary.btn-block', { type: 'button', text: '💾 Сохранить', onclick: () => save(false) }),
        h('button.btn.btn-block', { type: 'button', text: '💾 Сохранить и открыть', onclick: () => save(true) }),
      ]),
      isEdit ? h('button.btn.btn-danger.btn-block', {
        type: 'button', text: 'Удалить билд', style: { marginTop: '10px' },
        onclick: () => views.builds.deleteBuild(model, () => router.go('/builds')),
      }) : null,
    ]));

    side.appendChild(h('div.panel', [
      h('div.panel-title', { text: 'Чек-лист' }),
      h('ul', { style: { marginLeft: '18px', fontSize: '13.5px', color: 'var(--text-dim)', lineHeight: '1.9' } }, [
        h('li', { text: `Название заполнено ${model.title.trim() ? '✓' : '—'}` }),
        h('li', { text: `Герой выбран ${model.hero_id ? '✓' : '—'}` }),
        h('li', { text: `Есть предметы ${model.items.length ? '✓' : '—'}` }),
        h('li', { text: `Есть прокачка ${model.skills.length ? '✓' : '—'}` }),
      ]),
    ]));

    layout.appendChild(main);
    layout.appendChild(side);
    host.appendChild(layout);

    /* ── сохранение ── */
    async function save(openAfter) {
      if (model.title.trim().length < 3) { ui.err('Название слишком короткое'); titleInput.focus(); return; }
      const payload = {
        mode: model.mode,
        hero_id: model.hero_id,
        title: model.title.trim(),
        description: model.description.trim(),
        patch: model.patch.trim(),
        is_draft: model.is_draft,
        items: model.items,
        skills: model.skills,
        talents: model.talents.filter(Boolean),
        neutrals: model.neutrals,
      };

      const res = isEdit
        ? await api.patch('/builds/' + model.id, { body: payload })
        : await api.post('/builds', { body: payload });

      if (!res.ok) { ui.apiError(res, 'Билд не сохранился'); return; }
      store.dropCache('/builds');
      const id = isEdit ? model.id : res.data.id;
      ui.ok(isEdit ? 'Билд обновлён' : 'Билд создан');
      original = JSON.stringify(model);
      if (openAfter) router.go('/builds/' + id);
      else if (model.is_draft) { ui.toast('Билд сохранён как черновик — его видишь только ты'); router.go('/builds/' + id + '/edit'); }
      else router.go('/builds/' + id);
    }

    /* ── предупреждение о несохранённых правках ── */
    window.__buildEditorDirty = () => !!original && JSON.stringify(model) !== original;
  }

  function swap(arr, a, b) {
    if (b < 0 || b >= arr.length) return;
    const t = arr[a]; arr[a] = arr[b]; arr[b] = t;
    arr.forEach((s, i) => { s.rank = i + 1; });
  }

  window.views = window.views || {};
  window.views.buildEditor = { render };
})();
