/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — справочник кастомных предметов CHC
   ──────────────────────────────────────────────────────────────────────
   В обычном справочнике Dota этих предметов нет: они живут только внутри
   кастомных игр, поэтому и id у них нет, и иконок на CDN Valve.
   Список собран из гайда tv/kub3ik67 и лежит в data/custom/chc-items.json.
   Описания и числа расшифрованы прямо из игровых тултипов на скриншотах.

   Экран показывает предмет, его характеристики, цепочку улучшений и —
   главное — на какие умения героев предмет похож. Последнее полезно
   перед сборкой: видно, что KAST ведёт себя как связка, а Dark Moon Shard
   съедается ради скорости атаки.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  const GROUP_HINT = {
    magic: 'Урон по магии, усиление и контроль.',
    physical: 'Живучесть и урон обычных атак.',
    summoner: 'Работают на призытых сущностей — эффекты уходят по площади, а не в цель.',
    books: 'Навсегда меняют характеристики и набор умений. В Ratten Run выпадают после потери Aegis.',
  };

  /** Дата источника: патч гайд не называет, зато называет день обновления. */
  function sourceStamp() {
    if (store.customPatch) return 'патч ' + store.customPatch;
    const src = store.customSource || {};
    if (src.updated) return 'гайд обновлён ' + src.updated;
    if (src.posted) return 'гайд от ' + src.posted;
    return 'источник не указан';
  }

  /** Плашка режима. Если предмет доступен везде — не показываем ничего. */
  function modeBadge(item) {
    const m = item && item.mode;
    if (!m || m === '*') return null;
    const modes = store.customModes || {};
    return h('span.badge.badge-yellow', { text: 'только ' + (modes[m] || m) });
  }

  /* ── карточка одного предмета ─────────────────────────────────────── */
  function card(item) {
    const group = (store.customGroups || []).find(g => g.key === item.group);
    const el = h('div.custom-card', [
      h('div.custom-head', [
        h('div.custom-icon', { onclick: () => picker.customCard(item) }, ui.dotaIcon(store.customIcon(item))),
        h('div.info', [
          h('h3', { text: item.name, onclick: () => picker.customCard(item) }),
          h('div.sub', { text: item.summary || '' }),
          h('div.meta-row', { style: { marginTop: '6px' } }, [
            group ? h(`span.badge.badge-${group.color}`, { text: group.title }) : null,
            item.tier ? h('span.badge.badge-blue', { text: 'уровень ' + (item.tier + 1) }) : null,
            item.cost ? h('span.badge.badge-gold', { text: picker.costText(item) }) : null,
            modeBadge(item),
            h('span.badge.badge-grey', { text: sourceStamp() }),
          ]),
        ]),
      ]),
      item.body ? h('p.custom-body', { text: item.body }) : null,
      relationsRow(item),
    ]);
    return el;
  }

  /** Связи с обычными предметами Dota и с умениями героев. */
  function relationsRow(item) {
    const rel = store.customRelations(item);
    if (!rel.abilities.length && !rel.items.length) return null;
    const chips = h('div.chip-row');
    for (const x of rel.items) {
      chips.appendChild(h('span.chip', {
        title: 'Похоже на предмет Dota', text: '≈ ' + (x.name || x.name_en),
      }));
    }
    for (const a of rel.abilities) {
      const hero = a.hero ? store.heroByKey.get(a.hero) : null;
      chips.appendChild(h('span.chip.chip-hero', {
        title: 'Похоже на умение героя',
        text: '≈ ' + (hero ? (hero.name_en || hero.name) + ' · ' : '') + (a.name || a.name_en),
      }));
    }
    return h('div.custom-rel', [h('span.k', { text: 'Похоже на:' }), chips]);
  }

  /* ══════════════════════════════════════════════════════════════════
     Экран
     ══════════════════════════════════════════════════════════════════ */
  async function render(host, _params, query) {
    clear(host);
    const items = store.customItems || [];
    if (!items.length) {
      host.appendChild(common.empty({
        icon: '📦', title: 'Каталог пуст',
        text: 'Кастомные предметы не загрузились. Выполни npm run data:build.',
      }));
      return;
    }

    const state = { group: query.group || '', q: query.q || '' };

    host.appendChild(h('div.page-head', [
      h('h1', { text: 'Кастомные предметы' }),
      h('div.sub', {
        text: 'Эти предметы есть только в кастомных играх — в обычном Dota их нет. '
          + items.length + ' шт., ' + sourceStamp() + '.',
      }),
    ]));

    // ── фильтры ──
    const tabs = h('div.tabs');
    const listHost = h('div');
    const counter = h('div.field-hint', { style: { margin: '12px 0' } });

    const search = h('input.input', {
      type: 'search', value: state.q, placeholder: 'Найти предмет…', autocomplete: 'off',
      style: { maxWidth: '340px' },
      oninput: ui.debounce(e => { state.q = e.target.value; draw(); }, 180),
    });

    function drawTabs() {
      clear(tabs);
      const options = [['', 'Все']].concat(
        (store.customGroups || []).map(g => [g.key, g.title]),
      );
      for (const [k, t] of options) {
        tabs.appendChild(h(`button.tab${state.group === k ? '.active' : ''}`, {
          type: 'button', text: t,
          onclick: () => {
            state.group = k;
            drawTabs();
            draw();
          },
        }));
      }
    }

    function draw() {
      clear(listHost);
      let list = items;
      if (state.group) list = list.filter(i => i.group === state.group);

      const q = picker.norm(state.q);
      if (q) {
        list = list.filter(i =>
          picker.norm(i.name).includes(q)
          || picker.norm(i.name_en || '').includes(q)
          || picker.norm(i.summary || '').includes(q));
      }

      // сначала базовые, потом улучшения — так видна структура
      list = list.slice().sort((a, b) => (a.tier || 0) - (b.tier || 0)
        || a.name.localeCompare(b.name, 'ru'));

      counter.textContent = list.length
        ? `${list.length} из ${items.length} ${ui.plural(items.length, 'предмет', 'предмета', 'предметов')}`
        : '';

      if (!list.length) {
        listHost.appendChild(common.empty({
          icon: '🔍', title: 'Ничего не нашлось',
          text: 'Попробуй другое слово или сбрось фильтр группы.',
          action: () => { state.q = ''; state.group = ''; search.value = ''; drawTabs(); draw(); },
          actionLabel: 'Сбросить фильтры',
        }));
        return;
      }

      // группируем по названию группы, чтобы не терялось деление гайда
      const byGroup = new Map();
      for (const item of list) {
        if (!byGroup.has(item.group)) byGroup.set(item.group, []);
        byGroup.get(item.group).push(item);
      }
      for (const [key, groupItems] of byGroup) {
        const g = (store.customGroups || []).find(x => x.key === key);
        listHost.appendChild(h('div.custom-section', [
          h('h2', [
            g ? g.title : key,
            h('span.count', { text: String(groupItems.length) }),
          ]),
          GROUP_HINT[key] ? h('p.field-hint', { text: GROUP_HINT[key] }) : null,
        ]));
        listHost.appendChild(h('div.custom-grid', groupItems.map(card)));
      }
    }

    host.appendChild(h('div.filter-bar', [tabs, search]));
    host.appendChild(counter);
    host.appendChild(listHost);
    drawTabs();
    draw();

    // ── откуда это всё ──
    const src = store.customSource;
    if (src && src.url) {
      host.appendChild(h('div.panel', { style: { marginTop: '24px' } }, [
        h('div.panel-title', { text: 'Откуда этот список' }),
        h('p.field-hint', {
          text: `Описания предметов приведены по гайду «${src.title}» `
            + `${src.author ? `от ${src.author}, ` : ''}опубликованному ${src.posted || '—'}. `
            + (src.updated ? ', обновлён ' + src.updated : '') + '. '
            + (src.note || ''),
        }),
        (src.also || []).length ? h('p.field-hint', {
          text: 'Дополнительно: '
            + src.also.map(a => '«' + a.title + '» (' + (a.author || 'автор не указан') + ')')
              .join(', ') + '.',
        }) : null,
        h('div.btn-row',
          [h('a.btn.btn-sm', {
            href: src.url, target: '_blank', rel: 'noopener noreferrer',
            text: 'Открыть гайд на Steam ↗',
          })].concat((src.also || []).map(a => h('a.btn.btn-sm', {
            href: a.url, target: '_blank', rel: 'noopener noreferrer',
            text: 'Дополнительный гайд ↗',
          })))),
      ]));
    }

    // ── подсказка про редактор ──
    host.appendChild(h('div.help-note', { style: { marginTop: '16px' } }, [
      h('b', { text: 'Как использовать в билде. ' }),
      'Кастомные предметы доступны в редакторе билда в самом конце списка выбора — '
      + 'в слоте вместо цены показывается краткое описание эффекта. '
      + 'Нажми на предмет, чтобы увидеть его характеристики и связи с умениями. '
      + 'Если предмета здесь не хватает — напиши в разделе тредов, каталог пополняется.'
      + (store.customModes && store.customModes.note ? ' ' + store.customModes.note : ''),
    ]));
  }

  window.views = window.views || {};
  window.views.customItems = { render };
})();
