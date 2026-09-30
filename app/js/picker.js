/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — выбор предмета, героя, таланта, нейтралки
   ──────────────────────────────────────────────────────────────────────
   Один модальный поиск на все случаи: filter по названию/ключу, сортировка
   по цене, показ уже выбранного зачёркнутым. Работает полностью по
   локальному справочнику — без запросов к серверу.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /** Нормализация для поиска: регистр, «ё», лишние пробелы. */
  function norm(s) {
    return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  }

  function haystack(entry) {
    return norm([entry.name, entry.name_en, entry.key].filter(Boolean).join(' '));
  }

  /** Читабельное имя: RU, если отличается, иначе EN. */
  function displayName(entry) {
    if (!entry) return '';
    if (entry.name && entry.name !== entry.key) return entry.name;
    return entry.name_en || entry.name || entry.key;
  }

  /** Цена с валютой: «500 золота» или «1200 осколков» (кастомная валюта CHC). */
  function costText(entry) {
    if (!entry || !entry.cost) return null;
    return entry.currency === 'fragments' ? entry.cost + ' осколков' : entry.cost + ' золота';
  }

  /**
   * pickOne({ title, entries, picked, onPick, makeRow })
   *  entries — массив справочника; picked — Set уже занятых id.
   */
  function pickOne({ title, entries, picked, onPick, renderRow, emptyText, extraFilter }) {
    const input = h('input.input', { type: 'text', placeholder: 'Начни вводить название…', autocomplete: 'off' });
    const results = h('div.picker-results');
    const count = h('div.field-hint');

    const active = new Set(picked || []);

    function refresh() {
      const q = norm(input.value);
      let list = entries;
      if (extraFilter) list = list.filter(extraFilter);
      if (q) {
        list = list.filter(e => haystack(e).includes(q));
        // точное начало имени поднимаем наверх
        list = list.slice().sort((a, b) => {
          const an = norm(displayName(a)).startsWith(q) ? 0 : 1;
          const bn = norm(displayName(b)).startsWith(q) ? 0 : 1;
          return an - bn;
        });
      }
      clear(results);
      const shown = list.slice(0, 300);
      count.textContent = list.length > shown.length
        ? `Показаны первые ${shown.length} из ${list.length}`
        : (list.length ? `${list.length} ${window.ui.plural(list.length, 'вариант', 'варианта', 'вариантов')}` : '');

      if (!list.length) {
        results.appendChild(h('div.empty', { style: { padding: '28px' } }, [
          h('p', { text: emptyText || 'Ничего не нашлось' }),
        ]));
        return;
      }
      for (const entry of shown) {
        const row = (renderRow || defaultRow)(entry, active.has(entry.id));
        row.addEventListener('click', () => {
          m.close();
          onPick(entry);
        });
        results.appendChild(row);
      }
    }

    input.addEventListener('input', window.ui.debounce(refresh, 140));
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const first = results.querySelector('.picker-row');
      if (first) { e.preventDefault(); first.click(); }
    });

    const m = ui.modal({
      title: title || 'Выбор',
      wide: true,
      body: h('div', [
        h('div.field', [input]),
        count,
        results,
      ]),
    });

    refresh();
    setTimeout(() => input.focus(), 50);
    return m;
  }

  function defaultRow(entry, isPicked) {
    const icon = entry.img ? ui.dotaIcon(store.icon(entry.img)) : h('span.icon');
    return h(`button.picker-row${isPicked ? '.picked' : ''}`, { type: 'button' }, [
      icon,
      h('div.info', [
        h('span.nm', { text: displayName(entry) }),
        entry.custom
          ? h('span.sub', { text: customGroupTitle(entry.group) })
          : (entry.name_en && entry.name_en !== entry.name
            ? h('span.sub', { text: entry.name_en }) : null),
      ]),
      entry.cost ? h('span.badge.badge-gold', { text: String(entry.cost) }) : null,
      entry.custom ? h('span.badge.badge-red', { text: 'кастом' }) : null,
      entry.custom ? customModeBadge(entry) : null,
      entry.tier ? h('span.badge.badge-blue', { text: `T${entry.tier}` }) : null,
    ]);
  }

  /** Название группы кастомных предметов («Магические предметы» и т.п.). */
  function customGroupTitle(key) {
    const g = (store.customGroups || []).find(x => x.key === key);
    return g ? g.title : 'Кастомный предмет';
  }

  /** Подпись режима у кастомного предмета. null = доступен везде. */
  function customModeBadge(item) {
    const m = item && item.mode;
    if (!m || m === '*') return null;
    const modes = store.customModes || {};
    const title = modes[m] || m;
    return h('span.badge.badge-yellow', { text: 'только ' + title });
  }

  function heroRow(hero, isPicked) {
    return h(`button.picker-row${isPicked ? '.picked' : ''}`, { type: 'button' }, [
      h('img.icon.round', { src: store.heroIcon(hero), alt: '' }),
      h('div.info', [
        h('span.nm', { text: hero.name }),
        h('span.sub', { text: (hero.roles || []).join(' · ') + ` · сложность ${hero.complexity}/10` }),
      ]),
    ]);
  }

  function abilityRow(ability, isPicked) {
    return h(`button.picker-row${isPicked ? '.picked' : ''}`, { type: 'button' }, [
      ability.img ? ui.dotaIcon(store.abilityIcon(ability)) : h('span.icon'),
      h('div.info', [
        h('span.nm', { text: displayName(ability) }),
        h('span.sub', { text: ability.key }),
      ]),
    ]);
  }

  /** Косметика и расходники — обычно первое, что берут. */
  const CATEGORY_ORDER = [
    ['component', 'Компоненты'],
    ['expensive', 'Дорогие'],
    ['consumable', 'Расходники'],
    ['artifact', 'Артефакты'],
    ['neutral', 'Нейтральные предметы'],
    ['ultimate', 'Ульты (покупаются прямой покупкой)'],
    ['other', 'Прочее'],
  ];

  const CATEGORY_RU = Object.fromEntries(CATEGORY_ORDER);

  /* ── публичные функции выбора ─────────────────────────────────────── */

  /**
   * Выбор героя. Если для режима задан ростер, показываем только тех
   * героев, что реально есть в кастомной игре, — остальные 127 просто
   * мешают выбирать. Ростер настраивается прямо отсюда же, кнопкой
   * внизу списка: раньше для этого надо было править файл и пересобирать
   * датасет, то есть внутри программы настроить его было нельзя.
   */
  function pickHero({ picked, onPick, mode, all = false }) {
    const base = all ? store.heroes : store.heroesFor(mode);
    const m = pickOne({
      title: store.heroesTitle(all ? null : mode),
      entries: base.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      picked, onPick, renderRow: heroRow,
      emptyText: store.roster(mode) && !all
        ? 'Ростер режима пуст — все герои отсеяны. Открой «ростер» и проверь список.'
        : 'Герой не найден',
    });

    if (!mode || all) return m;
    if (!window.rosterView || !rosterView.canEdit(mode)) return m;

    // Кнопка появляется только у того, кто реально может ростер поменять.
    m.body.appendChild(h('div.picker-foot', [
      h('button.btn.btn-sm.btn-ghost', {
        type: 'button', text: '⚙ Ростер режима',
        title: 'Отметить, какие герои есть в ' + (store.mode(mode).title || mode),
        onclick: () => { m.close(); rosterView.render(document.createElement('div'), mode); },
      }),
    ]));
    return m;
  }

  /** Обычные предметы плюс, по желанию, кастомные предметы CHC. */
  function withCustomItems(include, mode) {
    if (!include) return store.items;
    // предметы фильтруются по режиму: у кастомных есть поле mode,
    // у обычных оно не задано, значит доступны везде
    const all = store.items.concat(store.customItems);
    return mode ? all.filter(i => store.itemInMode(i, mode)) : all;
  }

  function pickItem({ picked, onPick, category, withCategories = true, custom = true, mode = null }) {
    let list = withCustomItems(custom, mode);
    if (category) {
      list = list.filter(i => i.category === category || i.group === category);
    } else if (withCategories) {
      // сортируем по нашим группам, внутри — по цене;
      // кастомные всегда в конце, их не купить за золото
      list = list.slice().sort((a, b) => {
        if (!!a.custom !== !!b.custom) return a.custom ? 1 : -1;
        const ai = CATEGORY_ORDER.findIndex(([k]) => k === (a.group || a.category));
        const bi = CATEGORY_ORDER.findIndex(([k]) => k === (b.group || b.category));
        const an = ai < 0 ? CATEGORY_ORDER.length : ai;
        const bn = bi < 0 ? CATEGORY_ORDER.length : bi;
        if (an !== bn) return an - bn;
        if (a.custom) return a.name.localeCompare(b.name, 'ru');
        return (a.cost || 0) - (b.cost || 0);
      });
    }
    return pickOne({
      title: 'Выбор предмета',
      entries: list,
      picked, onPick,
      emptyText: 'Предмет не найден',
    });
  }

  function pickNeutral({ picked, onPick, tier }) {
    let list = store.neutrals;
    if (tier) list = list.filter(n => n.tier === tier);
    list = list.slice().sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, 'ru'));
    return pickOne({
      title: 'Выбор нейтрального предмета',
      entries: list, picked, onPick,
      emptyText: 'Нейтралка не найдена',
    });
  }

  function pickAbility({ picked, onPick, heroId }) {
    // без героя показываем все боевые способности, а не внутренние
    const list = heroId
      ? store.heroAbilities(heroId)
      : store.abilities.filter(a => !a.is_talent && a.hero && a.playable);
    return pickOne({
      title: 'Выбор способности',
      entries: list, picked, onPick, renderRow: abilityRow,
      emptyText: 'Способность не найдена',
    });
  }

  /** Выбор таланта: показываем по уровням, по две опции в строке. */
  function pickTalent({ heroId, picked, onPick, onlyLevel }) {
    const groups = store.heroTalents(heroId);
    const levels = store.TALENT_LEVELS;
    const body = h('div');

    function draw() {
      clear(body);
      groups.forEach((group, gi) => {
        const lvl = levels[gi] || '';
        if (!group.length) return;
        const row = h('div.talent-row', { style: { flexDirection: 'column', gap: '6px' } }, [
          h('span.lvl', { text: lvl ? `${lvl} ур.` : 'Талант' }),
        ]);
        for (const talent of group) {
          const already = (picked || []).includes(talent.id);
          const allowed = !onlyLevel || onlyLevel === lvl;
          const btn = h(`button.choice${already ? '.on' : ''}`, {
            type: 'button',
            style: { width: '100%', textAlign: 'left', opacity: allowed ? '1' : '0.4', cursor: allowed ? 'pointer' : 'not-allowed' },
            text: displayName(talent),
            onclick: () => {
              if (!allowed) { ui.err(`Этот талант выбирается на ${lvl} уровне`); return; }
              m.close();
              onPick(talent);
            },
          });
          row.appendChild(btn);
        }
        body.appendChild(row);
      });
      if (!groups.some(g => g.length)) {
        body.appendChild(h('div.empty', [h('p', { text: 'У этого героя нет талантов в справочнике' })]));
      }
    }

    const m = ui.modal({ title: 'Выбор таланта', wide: true, body });
    draw();
    return m;
  }

  /** Быстрый просмотр карточки — по клику на иконку в готовом билде. */
  function showCard(entry, kind) {
    if (!entry) return;
    const rows = [];
    const push = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push([k, v]); };
    push('Ключ', entry.key);
    if (entry.name_en && entry.name_en !== entry.name) push('English', entry.name_en);
    if (entry.cost) push('Цена', entry.cost);
    if (entry.tier) push('Тир', entry.tier);
    if (entry.hero) {
      const hero = store.heroByKey.get(entry.hero);
      if (hero) push('Герой', hero.name);
    }
    const table = h('dl.kv');
    for (const [k, v] of rows) {
      table.appendChild(h('dt', { text: k }));
      table.appendChild(h('dd', { text: String(v) }));
    }

    // кастомный предмет CHC: описание, характеристики и связи со скиллами
    const custom = entry.custom ? customCard(entry) : null;

    ui.modal({
      title: displayName(entry),
      body: h('div', [
        h('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: '14px' } },
          kind === 'hero'
            ? h('img', { src: store.heroIcon(entry), alt: '', style: { width: '96px', height: '96px', borderRadius: '50%' } })
            // класс пустой, поэтому размер задаём здесь — иначе svg растянется
            : ui.dotaIcon(store.icon(entry.img), 'card-icon')),
        custom || table,
      ]),
    });
  }

  /** Развёрнутая карточка кастомного предмета CHC. */
  function customCard(item) {
    const box = h('div');
    const group = (store.customGroups || []).find(x => x.key === item.group);
    const rel = store.customRelations(item);

    box.appendChild(h('div.meta-row', { style: { justifyContent: 'center', marginBottom: '10px' } }, [
      h(`span.badge.badge-${group ? group.color : 'grey'}`, { text: group ? group.title : 'Кастомный' }),
      item.cost ? h('span.badge.badge-gold', { text: costText(item) }) : null,
      customModeBadge(item),
      item.ability_type ? h('span.badge.badge-grey', { text: item.ability_type }) : null,
      item.damage_type ? h('span.badge.badge-grey', { text: 'урон: ' + item.damage_type }) : null,
      store.customPatch ? h('span.badge.badge-grey', { text: 'патч ' + store.customPatch }) : null,
      item.tier ? h('span.badge.badge-blue', { text: 'уровень ' + (item.tier + 1) }) : null,
    ]));

    if (item.acts_on) {
      box.appendChild(h('p.field-hint', {
        text: 'Действует: ' + item.acts_on,
        style: { marginBottom: '8px' },
      }));
    }

    if (item.summary) box.appendChild(h('p.strong', { text: item.summary, style: { marginBottom: '8px' } }));
    if (item.body) box.appendChild(h('p', { text: item.body, style: { marginBottom: '12px' } }));

    // характеристики: подписи в человеческом виде, а не внутренние ключи
    const statLabels = {
      radius: 'Радиус', stun: 'Оглушение', amp: 'Усиление урона', amp_time: 'Длительность усиления',
      spell_damage: 'Доп. урон по способности', slow: 'Замедление', slow_time: 'Длительность замедления',
      magic_resist: 'Сопротивление магии', dmg_per_stack: 'Рост урона за стак',
      shield_pct: 'Щит', creep_only: 'Только по крипам', max_shield: 'Максимальный щит',
      attack_speed: 'Скорость атаки', base_attack_cut: 'Минус базовая атака', min_base_attack: 'Минимум базовой атаки',
      debuff_time: 'Длительность эффекта', splash: 'Сплэш', splash_radius: 'Радиус сплэша',
      attack_range: 'Дальность атаки', ranged_only: 'Только для дальних', levels: 'Уровней',
      aura_radius: 'Радиус ауры', redirect: 'Перенаправление урона', cooldown: 'Перезарядка',
      evasion_ignore: 'Игнорирование уклонения', stun_chance: 'Шанс оглушения', fear: 'Страх',

      // добавлены вместе с новым каталогом предметов
      damage: 'К урону атак', damage_pct: '% к урону', evasion: 'К уклонению',
      creep_damage: 'Урон по крипам', creep_range: 'Дальность атаки по крипам',
      spell_amp: '% к урону заклинаний', dot_amp: '% урона DoT за атрибут',
      mana_regen_amp: '% к восстановлению маны', spell_vamp: '% вампиризма заклинаниями',
      spell_vamp_amp: '% к усилению вампиризма', spell_damage_pct: '% к урону заклинаний',
      spell_amp_int: '% усиления за интеллект', spell_amp_attr: '% усиления за силу/ловкость',
      mana_to_hp: '% маны в здоровье', mana_to_hp_time: 'Время превращения', vamp_mult: 'Множитель вампиризма',
      charge_mana: 'Мана за заряд', charge_spell: '% урона за заряд',
      charges: 'Зарядов', charges_lost: 'Теряется зарядов',
      projectile_speed: 'К скорости снарядов', max_health: '% к максимальному здоровью',
      armor: 'К броне', lifesteal: '% вампиризма', lifesteal_penalty: '% вампиризма против подопечных',
      attr: 'К атрибуту', max_skills: 'Максимум навыков', uses: 'Раз применений',
      effect_radius: 'Радиус эффекта', attack_range_ranged: 'К дальности (дальний бой)',
      attack_range_melee: 'К дальности (ближний бой)', crit_chance: '% шанс крита',
      crit_damage: '% урона крита', ghost_damage: '% магического урона по призракам',
      share_spell_amp: '% усиления заклинаний с призывами',
      aura_cd: 'Перезарядка ауры', attr_damage: '% базового урона за очко атрибута',
      str_hp: '% макс. здоровья за силу', str_damage: 'Физический урон за силу',
      agi_armor: 'Броня за ловкость', agi_attack_speed: 'Скорость атаки за ловкость',
      magic_damage: 'Магический урон за ловкость', int_spell: '% урона заклинаний за интеллект',
      int_mres: '% сопротивления магии за интеллект',
    };
    const stats = item.stats || {};
    const keys = Object.keys(stats);
    if (keys.length) {
      const list = h('dl.kv');
      for (const k of keys) {
        list.appendChild(h('dt', { text: statLabels[k] || k }));
        list.appendChild(h('dd', {
          text: stats[k] === 1 && /only/.test(k) ? 'да'
            : stats[k] === 1 ? '1' : String(stats[k]).replace('.', ',') + (/_\d/.test(k) ? ' сек.' : ' %'),
        }));
      }
      box.appendChild(h('h4', { text: 'Характеристики', style: { margin: '14px 0 6px' } }));
      box.appendChild(list);
    }

    // цепочка улучшений
    const from = item.upgrades_from ? store.customItem(item.upgrades_from) : null;
    const to = (item.upgrades || []).map(k => store.customItem(k)).filter(Boolean);
    if (from || to.length) {
      box.appendChild(h('h4', { text: 'Улучшения', style: { margin: '14px 0 6px' } }));
      box.appendChild(h('div.chip-row', [
        from ? h('span.chip', { text: 'улучшает: ' + from.name }) : null,
        ...to.map(x => h('span.chip', { text: 'улучшается в: ' + x.name })),
      ]));
    }

    // связи с обычными предметами и со скиллами героев
    if (rel.items.length) {
      box.appendChild(h('h4', { text: 'Похоже на предметы Dota', style: { margin: '14px 0 6px' } }));
      box.appendChild(h('div.chip-row', rel.items.map(x =>
        h('span.chip', { text: x.name || x.name_en }))));
    }
    if (rel.abilities.length) {
      box.appendChild(h('h4', { text: 'Похоже на умения героев', style: { margin: '14px 0 6px' } }));
      box.appendChild(h('div.chip-row', rel.abilities.map(a => {
        const hero = a.hero ? store.heroByKey.get(a.hero) : null;
        return h('span.chip', { text: (hero ? hero.name + ' · ' : '') + (a.name || a.name_en) });
      })));
    }

    if (store.customSource && store.customSource.url) {
      box.appendChild(h('div.help-note', { style: { marginTop: '14px' } }, [
        h('span', { text: 'Описание: ' }),
        h('a', { href: store.customSource.url, target: '_blank', rel: 'noopener noreferrer', text: store.customSource.title }),
      ]));
    }
    return box;
  }

  window.picker = {
    pickHero, pickItem, pickNeutral, pickAbility, pickTalent,
    showCard, customCard, displayName, costText, CATEGORY_RU, customGroupTitle, norm,
  };
})();
