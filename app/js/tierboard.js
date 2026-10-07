/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — тир-лист (как на tiermaker.com)
   ──────────────────────────────────────────────────────────────────────
   Раньше позиции топа были плоским списком со стрелками «вверх/вниз» и
   выпадающим выбором тира. Сортировать по тиру на глаз в таком виде
   невозможно — а именно сортировка по тирам и есть смысл топа.

   Здесь доска: строки тиров S…D и «без тира», внутри — карточки. Карточку
   можно перетащить в другую строку или в другое место внутри строки.

   Логика перестановок вынесена в чистые функции (moveEntry, orderEntries),
   поэтому она проверяется тестами без браузера: перетаскивание в
   минимальном DOM не воспроизвести, а ошибку в сортировке — легко.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /** Строка для карточек без тира. */
  const NO_TIER = '';

  const tiers = () => (store.config.tiers || ['S', 'A', 'B', 'C', 'D']).slice();

  /* ── чистая логика ─────────────────────────────────────────────────── */

  /**
   * Переносит карточку в другую строку и на позицию внутри неё.
   * entries мутируется на месте — так же, как их держит редактор.
   */
  function moveEntry(entries, refId, toTier, toIndex) {
    const from = entries.findIndex(e => e.ref_id === refId);
    if (from < 0) return entries;
    const [card] = entries.splice(from, 1);
    card.tier = toTier;

    // Находим место вставки уже без вынутой карточки: индексы в новой
    // строке считаются среди оставшихся соседей.
    const inTarget = entries
      .map((e, i) => ({ e, i }))
      .filter(x => (x.e.tier || NO_TIER) === toTier);
    const pos = Math.max(0, Math.min(toIndex, inTarget.length));
    const at = pos >= inTarget.length
      ? (inTarget.length ? inTarget[inTarget.length - 1].i + 1 : entries.length)
      : inTarget[pos].i;

    entries.splice(at, 0, card);
    return renumber(entries);
  }

  /** Переставляет карточку на шаг выше/ниже ВНУТРИ своей строки. */
  function shiftEntry(entries, refId, delta) {
    const card = entries.find(e => e.ref_id === refId);
    if (!card) return entries;
    const tier = card.tier || NO_TIER;
    const row = entries.filter(e => (e.tier || NO_TIER) === tier);
    const at = row.findIndex(e => e.ref_id === refId);
    const next = at + delta;
    if (next < 0 || next >= row.length) return entries;

    const a = entries.indexOf(row[at]);
    const b = entries.indexOf(row[next]);
    const t = entries[a];
    entries[a] = entries[b];
    entries[b] = t;
    return renumber(entries);
  }

  /** Пересчитывает сквозные номера: сначала строки сверху вниз. */
  function renumber(entries) {
    const order = tiers();
    let rank = 1;
    for (const tier of order.concat([NO_TIER])) {
      for (const e of entries) {
        if ((e.tier || NO_TIER) === tier) e.rank = rank++;
      }
    }
    // Позиции с неизвестным тиром (если конфиг изменили) — в конец
    for (const e of entries) if (!e.rank) e.rank = rank++;
    return entries;
  }

  /** Группировка для отрисовки: [{tier, items:[…]}]. */
  function rowsOf(entries) {
    const all = tiers();
    const known = entries.filter(e => all.includes(e.tier));
    const loose = entries.filter(e => !all.includes(e.tier));
    const out = all.map(tier => ({ tier, items: known.filter(e => e.tier === tier) }));
    if (loose.length) out.push({ tier: NO_TIER, items: loose });
    return out;
  }

  /** Сколько всего позиций и сколько без тира — для подсказок. */
  function stats(entries) {
    const all = tiers();
    return {
      total: entries.length,
      placed: entries.filter(e => all.includes(e.tier)).length,
      tiers: all.length,
    };
  }

  /* ── карточка ──────────────────────────────────────────────────────── */

  /** Имя позиции: герои и нейтралки — английским названием, остальное как в справочнике. */
  function labelOf(kind, ref) {
    if (!ref) return '—';
    if (kind === 'heroes' || kind === 'neutrals') return ref.name_en || ref.name || ref.key;
    return ref.name || ref.name_en || ref.key;
  }

  /** Иконка позиции: герой — круглым портретом, нейтралка/способность — иконкой. */
  function tileIcon(kind, ref) {
    if (!ref) return h('span.icon');
    if (kind === 'heroes') {
      return h('img.icon.round', { src: store.heroIcon(ref), alt: '' });
    }
    return ui.dotaIcon(store.icon(ref.img));
  }

  function card(kind, entry, opts) {
    const ref = opts.refEntry(kind, entry.ref_id);
    const node = h('div.tl-card', {
      draggable: 'true',
      tabindex: '0',
      'data-ref': String(entry.ref_id),
      title: (ref ? labelOf(kind, ref) : 'не найден') + (entry.note ? ' — ' + entry.note : ''),
    }, [
      tileIcon(kind, ref),
      // Перетаскивание не единственный способ: на тач-экране и с
      // клавиатуры сдвиг одной кнопкой привычнее.
      h('div.tl-ctl', [
        h('button.tl-b', {
          type: 'button', text: '▲', title: 'Выше',
          onclick: e => { e.stopPropagation(); opts.onShift(entry.ref_id, -1); },
        }),
        h('button.tl-b', {
          type: 'button', text: '▼', title: 'Ниже',
          onclick: e => { e.stopPropagation(); opts.onShift(entry.ref_id, 1); },
        }),
        h('button.tl-x', {
          type: 'button', text: '✕', title: 'Убрать из топа',
          onclick: e => { e.stopPropagation(); opts.onRemove(entry.ref_id); },
        }),
      ]),
    ]);
    node.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('text/plain', String(entry.ref_id));
      ev.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    return node;
  }

  /* ── доска ─────────────────────────────────────────────────────────── */

  /**
   * Собирает доску. onChange вызывается после каждой перестановки —
   * редактор в этот момент перерисовывает поля и считает статистику.
   */
  function render(kind, entries, opts) {
    const board = h('div.tl-board');
    const labelFor = t => (t === NO_TIER ? 'Без тира' : t);

    for (const row of rowsOf(entries)) {
      const strip = h('div.tl-strip', {
        'data-tier': row.tier,
        ondragover: ev => {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          strip.classList.add('over');
          // Метка «вставлять после» ставится на карточке под курсором, но
          // если курсор ушёл на пустое место, её надо снять — иначе она
          // переживёт drag и следующий бросок встанет не туда.
          if (ev.target === strip) {
            for (const c of strip.children) c.dataset.after = 'false';
          }
        },
        ondragleave: ev => {
          // dragleave срабатывает и при переходе между карточками — снимаем
          // подсветку только если курсор действительно покинул строку.
          if (ev.relatedTarget && strip.contains(ev.relatedTarget)) return;
          strip.classList.remove('over');
        },
      });

      for (const entry of row.items) {
        const node = card(kind, entry, opts);
        // Куда именно внутри строки: по половине карточки.
        node.addEventListener('dragover', ev => {
          ev.preventDefault();
          ev.stopPropagation();
          const r = node.getBoundingClientRect();
          node.dataset.after = String(ev.clientX > r.left + r.width / 2);
        });
        strip.appendChild(node);
      }

      strip.addEventListener('drop', ev => {
        ev.preventDefault();
        strip.classList.remove('over');
        const refId = Number(ev.dataTransfer.getData('text/plain'));
        if (!refId) return;

        // Считаем, сколько карточек строки стоят левее точки вставки.
        // Три случая, и все три раньше были сломаны по-разному:
        //   • бросок на карточку слева  — вставляем перед ней;
        //   • бросок на карточку справа — вставляем после неё (dataset.after);
        //   • бросок на пустое место   — вставляем в конец строки.
        // Подсказка «перетащи сюда» карточкой не считается, и перетаскиваемая
        // карточка тоже — из неё позиция вынута, moveEntry считает по остальным.
        let index = 0;
        for (const child of strip.children) {
          if (!child.dataset || !child.dataset.ref) continue;   // подсказка
          if (Number(child.dataset.ref) === refId) continue;    // себя не считаем
          if (child === ev.target) {
            if (child.dataset.after === 'true') index++;
            break;
          }
          index++;
        }

        // Одно изменение модели и одна перерисовка. Раньше после onDrop
        // доска перерисовывалась, а затем с отцепленной разметки читался
        // порядок и модель менялась вторым проходом — карточки «разъезжались».
        opts.onDrop(refId, row.tier, index);
      });

      // Пустая строка должна быть заметно зоной для броска
      if (!row.items.length) {
        strip.appendChild(h('div.tl-hint', { text: 'перетащи сюда' }));
      }

      board.appendChild(h('div.tl-row', [
        h(`div.tl-label${opts.onAddTier ? '.add' : ''}`, {
          text: labelFor(row.tier),
          title: opts.onAddTier ? ('Добавить позицию в тир ' + labelFor(row.tier)) : null,
          onclick: opts.onAddTier ? () => opts.onAddTier(row.tier) : null,
        }),
        strip,
      ]));
    }

    return board;
  }

  window.tierboard = {
    render, moveEntry, shiftEntry, renumber, rowsOf, stats,
    tiers, NO_TIER, labelOf, tileIcon,
  };
})();
