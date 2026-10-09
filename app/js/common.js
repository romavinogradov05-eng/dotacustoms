/* ══════════════════════════════════════════════════════════════════════
   DotaCustoms — общие детали интерфейса
   ──────────────────────────────────────────────────────────────────────
   Карточки билдов/топов/веток, переключатели режима, пагинация, пустые
   состояния и голосование. Всё, что встречается больше чем на одном экране,
   живёт здесь, чтобы экраны не дублировали разметку.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const { h, clear } = window.ui;

  /* ── общие мелочи ─────────────────────────────────────────────────── */

  /** Значок режима: CHC или Ratten Run. */
  function modeBadge(mode) {
    const m = store.mode(mode);
    return h(`span.badge.badge-mode-${m.key}`, { text: m.short || m.title });
  }

  /** Палитра тиров: буквенные тиры красятся своими цветами, остальные — по индексу ряда. */
  const TIER_PALETTE = ['S', 'A', 'B', 'C', 'D'];
  function tierColorClass(tier, tierList) {
    if (!tier) return 'none';
    if (TIER_PALETTE.includes(tier)) return tier;
    const list = tierList && tierList.length ? tierList : (store.config.tiers || TIER_PALETTE);
    const idx = list.indexOf(tier);
    return idx >= 0 ? TIER_PALETTE[idx % TIER_PALETTE.length] : '';
  }

  /** Строка «ник · роль · когда». */
  function byline(author, agoText, extra) {
    if (!author) return h('span', { text: 'удалённый автор' });
    const role = author.role === 'admin' ? 'Админ'
      : author.role === 'coach' ? 'Coach' : null;
    return h('span.meta-row', [
      h('a', {
        href: '#/u/' + encodeURIComponent(author.username),
        text: author.nickname || author.username,
        style: { color: 'var(--text-dim)', textDecoration: 'none', fontWeight: '600' },
      }),
      role ? h('span.badge.badge-blue', { text: role }) : null,
      agoText ? h('span.dot', { text: '·' }) : null,
      agoText ? h('span', { text: agoText }) : null,
      extra || null,
    ]);
  }

  /** Метка подтверждения Coach. */
  function verifyBadge(entity) {
    if (!entity || !entity.verified) return null;
    const by = entity.verified_by && entity.verified_by.nickname;
    return h('span.badge.badge-green', {
      title: by ? `Подтвердил ${by}` : 'Подтверждено Coach',
      text: '✓ Coach',
    });
  }

  /** Значок черновика. */
  function draftBadge(entity) {
    if (!entity || !entity.is_draft) return null;
    return h('span.badge.badge-yellow', { text: 'Черновик' });
  }

  /** Компактный ряд иконок предметов. Рамка фиксированная (класс fi),
      поэтому иконки разных пропорций выглядят одинаково. */
  function itemStrip(ids, kind, max) {
    const list = (ids || []).slice(0, max || 8);
    const strip = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } });
    for (const id of list) {
      // anyItemById, а не itemById: кастомные предметы CHC лежат отдельно
      const entry = kind === 'neutral'
        ? store.neutralById.get(id)
        : store.anyItemById(id);
      if (!entry) continue;
      strip.appendChild(h('span.fi', {
        title: picker.displayName(entry),
        style: { width: '55px', height: '40px' },
      }, ui.dotaIcon(store.icon(entry.img), null, kind !== 'neutral')));
    }
    return strip;
  }

  /* ── переключатель режима ─────────────────────────────────────────── */
  function modeTabs(current, onChange, { all = true } = {}) {
    const box = h('div.tabs');
    const options = all ? [{ key: '', title: 'Все режимы' }].concat(store.config.modes) : store.config.modes;
    // Подсветку двигаем прямо на клике: раньше список фильтровался, а
    // активной оставалась прежняя вкладка — переключение выглядело
    // сломанным, хотя данные менялись.
    const tabs = [];
    const paint = now => {
      for (const [key, node] of tabs) node.classList.toggle('active', (now || '') === key);
    };
    for (const m of options) {
      const node = h('button.tab', {
        type: 'button', text: m.title,
        onclick: () => { paint(m.key); onChange(m.key); },
      });
      tabs.push([m.key, node]);
      box.appendChild(node);
    }
    paint(current);
    return box;
  }

  /* ── пагинация ────────────────────────────────────────────────────── */
  function pager({ page, pages, onGo }) {
    if (!pages || pages <= 1) return h('span');
    return h('div.pager', [
      h('button.btn.btn-sm', {
        type: 'button', text: '← Назад', disabled: page <= 1,
        onclick: () => onGo(page - 1),
      }),
      h('span.info', { text: `Страница ${page} из ${pages}` }),
      h('button.btn.btn-sm', {
        type: 'button', text: 'Вперёд →', disabled: page >= pages,
        onclick: () => onGo(page + 1),
      }),
    ]);
  }

  /* ── пустое состояние ─────────────────────────────────────────────── */
  function empty({ icon = '∅', title, text, action, actionLabel, actionHref }) {
    return h('div.empty', [
      h('div.big', { text: icon }),
      title ? h('h4', { text: title }) : null,
      text ? h('p', { text }) : null,
      action ? h('button.btn.btn-primary.btn-sm', { type: 'button', text: actionLabel || 'Действие', onclick: action })
        : (actionHref ? h('a.btn.btn-primary.btn-sm', { href: actionHref, text: actionLabel || 'Открыть' }) : null),
    ]);
  }

  /* ── голосование (билды, топы, ветки, сообщения) ──────────────────── */
  /**
   * voteBox({ score, my, onVote(value) })
   * Три состояния: +1, 0, -1. Повторный клик по активной кнопке снимает голос.
   */
  function voteBox({ score, my, onVote, vertical = true }) {
    const box = h('div.votes' + (vertical ? '.vertical' : ''));
    const up = h(`button.vote-btn.up${my > 0 ? '.on' : ''}`, { type: 'button', title: 'Полезно', text: '▲' });
    const down = h(`button.vote-btn.down${my < 0 ? '.on' : ''}`, { type: 'button', title: 'Бесполезно', text: '▼' });
    const num = h('span.vote-score', { text: String(score || 0) });

    let busy = false;
    const send = async value => {
      if (busy) return;
      busy = true;
      const next = my === value ? 0 : value;
      const res = await api.post(onVote.url, { body: { value: next } });
      busy = false;
      if (!res.ok) { ui.apiError(res, 'Не удалось проголосовать'); return; }
      onVote.onDone(next);
    };
    up.addEventListener('click', () => send(1));
    down.addEventListener('click', () => send(-1));

    box.appendChild(up);
    box.appendChild(num);
    box.appendChild(down);
    return box;
  }

  /* ── жалоба на контент ────────────────────────────────────────────── */
  // Набор причин обязан совпадать с FLAG_REASONS в backend/routes/users.js
  const FLAG_REASONS = [
    ['spam', 'Спам или реклама'],
    ['abuse', 'Оскорбления / токсичность'],
    ['plagiarism', 'Плагиат'],
    ['wrong_info', 'Неверная информация'],
    ['other', 'Другое'],
  ];

  function flagButton({ targetType, targetId, label }) {
    return h('button.icon-btn', {
      type: 'button', title: label || 'Пожаловаться', text: '⚑', style: { fontSize: '13px' },
      onclick: () => {
        if (!store.me) { ui.err('Сначала войди в аккаунт'); return; }
        const select = h('select.select', FLAG_REASONS.map(([k, t]) => h('option', { value: k, text: t })));
        const details = h('textarea.textarea', { placeholder: 'Опиши подробнее (необязательно)', maxlength: 800, rows: 3 });
        ui.modal({
          title: 'Жалоба на контент',
          body: h('div', [
            h('div.field', [h('label', { text: 'Причина' }), select]),
            h('div.field', [h('label', { text: 'Комментарий' }), details]),
            h('div.help-note', { text: 'Жалоба уходит администрации. За ложные жалобы могут ограничить доступ.' }),
          ]),
          actions: [
            { label: 'Отмена', kind: 'ghost' },
            {
              label: 'Отправить', kind: 'primary',
              onClick: async () => {
                const res = await api.post('/users/flags', {
                  body: { target_type: targetType, target_id: targetId, reason: select.value, details: details.value.trim() },
                });
                if (!res.ok) { ui.apiError(res, 'Не удалось отправить жалобу'); return false; }
                ui.ok('Жалоба отправлена');
              },
            },
          ],
        });
      },
    });
  }

  /* ── карточка билда ───────────────────────────────────────────────── */
  function buildCard(b) {
    const hero = b.hero_id ? store.heroById.get(b.hero_id) : null;
    const items = (b.items || []).map(x => x.item_id);
    const meta = [];
    if (b.patch) meta.push('патч ' + b.patch);

    return h('a.card' + (b.is_draft ? '.draft' : ''), { href: '#/builds/' + b.id }, [
      h('div.meta-row', [
        modeBadge(b.mode),
        draftBadge(b),
        verifyBadge(b),
        h('span.spacer', { style: { flex: '1' } }),
        meta.length ? h('span', { text: meta.join(' · ') }) : null,
      ]),
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, [
        hero
          ? h('img.hero-portrait', { src: store.heroIcon(hero), alt: '', style: { width: '46px', height: '46px' } })
          : null,
        h('h3', { text: b.title }),
      ]),
      b.description ? h('div.excerpt', { text: b.description }) : null,
      items.length ? itemStrip(items, 'item', 8) : null,
      h('div.foot', [
        byline(b.author, b.updated_ago),
        h('span.spacer', { style: { flex: '1' } }),
        h('span', { text: `▲ ${b.likes || 0}` }),
        h('span', { text: `💬 ${b.comment_count || 0}` }),
        h('span', { text: `👁 ${b.views || 0}` }),
      ]),
    ]);
  }

  /* ── карточка топ-листа ───────────────────────────────────────────── */
  const TOP_KIND_RU = { heroes: 'Персонажи', neutrals: 'Нейтралки', skills: 'Скиллы' };

  function topCard(t) {
    const kind = TOP_KIND_RU[t.kind] || t.kind;
    const preview = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } });
    const byTier = {};
    for (const e of (t.entries || []).slice(0, 10)) {
      if (!byTier[e.tier]) byTier[e.tier] = [];
      byTier[e.tier].push(e);
    }
    // Позиции без тира тоже показываем — иначе превью карточки пустует.
    const topTiers = t.tiers && t.tiers.length ? t.tiers : store.config.tiers;
    topTiers.concat('').forEach((tier, i) => {
      const list = byTier[tier];
      if (!list) return;
      preview.appendChild(h('span.badge.badge-tier-' + tierColorClass(tier, topTiers), { text: tier || '—' }));
      for (const e of list.slice(0, 4)) {
        const k = e.kind || t.kind;
        const ref = k === 'heroes' ? store.heroById.get(e.ref_id)
          : k === 'neutrals' ? store.neutralById.get(e.ref_id)
            : store.abilityById.get(e.ref_id);
        if (!ref) continue;
        const refLabel = k === 'heroes' || k === 'neutrals'
          ? (ref.name_en || ref.name || ref.key)
          : picker.displayName(ref);
        preview.appendChild(h('span.fi', {
          title: refLabel,
          style: { width: '40px', height: '40px', display: 'inline-block' },
        }, k === 'heroes'
          ? h('img', { src: store.heroIcon(ref), alt: '', style: { width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' } })
          : ui.dotaIcon(store.icon(ref.img), null, true)));
      }
    });

    return h('a.card' + (t.is_draft ? '.draft' : ''), { href: '#/tops/' + t.id }, [
      h('div.meta-row', [
        modeBadge(t.mode),
        h('span.badge.badge-gold', { text: kind }),
        draftBadge(t),
        verifyBadge(t),
      ]),
      h('h3', { text: t.title }),
      t.description ? h('div.excerpt', { text: t.description }) : null,
      preview,
      h('div.foot', [
        byline(t.author, t.updated_ago),
        h('span.spacer', { style: { flex: '1' } }),
        h('span', { text: `▲ ${t.likes || 0}` }),
        h('span', { text: `${t.entry_count || 0} поз.` }),
      ]),
    ]);
  }

  /* ── карточка ветки ───────────────────────────────────────────────── */
  function threadCard(t) {
    const cat = store.category(t.category) || { title: t.category, icon: '💬', color: 'grey' };
    const statusRu = { open: 'Открыта', confirmed: 'Подтверждено', fixed: 'Исправлено', declined: 'Отклонено', duplicate: 'Дубликат' };
    const statusCls = { open: 'badge-grey', confirmed: 'badge-yellow', fixed: 'badge-green', declined: 'badge-red', duplicate: 'badge-grey' };
    return h('a.card', { href: '#/threads/' + t.id }, [
      h('div.meta-row', [
        t.is_pinned ? h('span.badge.badge-gold', { text: '📌 Закреплено' }) : null,
        h(`span.badge.badge-${cat.color === 'grey' ? 'grey' : cat.color}`, { text: `${cat.icon} ${cat.title}` }),
        modeBadge(t.mode),
        h('span.badge', { class: statusCls[t.status] || 'badge-grey', text: statusRu[t.status] || t.status }),
        t.is_locked ? h('span.badge.badge-red', { text: '🔒 Закрыта' }) : null,
      ]),
      h('h3', { text: t.title }),
      t.excerpt ? h('div.excerpt', { text: t.excerpt }) : null,
      h('div.foot', [
        byline(t.author, t.ago),
        h('span.spacer', { style: { flex: '1' } }),
        h('span', { text: `▲ ${t.score || 0}` }),
        h('span', { text: `💬 ${t.replies || 0}` }),
        h('span', { text: `👁 ${t.views || 0}` }),
      ]),
    ]);
  }

  /* ── блок сортировки ──────────────────────────────────────────────── */
  function selectField(label, options, value, onChange, extra) {
    const sel = h('select.select', {
      onchange: e => onChange(e.target.value),
    });
    for (const [k, t] of options) {
      const opt = h('option', { value: k, text: t });
      if (k === String(value)) opt.selected = true;
      sel.appendChild(opt);
    }
    return h('div.field', { class: extra || '' }, [label ? h('label', { text: label }) : null, sel]);
  }

  function inputField(label, { value = '', placeholder = '', onInput, type = 'search', grow } = {}) {
    const input = h('input.input', {
      type, placeholder, value, autocomplete: 'off',
      oninput: onInput ? window.ui.debounce(e => onInput(e.target.value), 260) : null,
    });
    return h('div.field' + (grow ? '.grow' : ''), [label ? h('label', { text: label }) : null, input]);
  }

  /** Постранично грузит список, обновляя контейнер. */
  function listSection({ loader, render, host, emptyState }) {
    const wrap = h('div');
    host.appendChild(wrap);

    async function draw(query) {
      ui.clear(wrap);
      wrap.appendChild(h('div.loading-panel', { style: { padding: '50px 0' } }, h('div.spinner')));
      const res = await loader(query);
      ui.clear(wrap);
      if (!res.ok) {
        wrap.appendChild(h('div.error-panel', { text: (res.data && res.data.error) || 'Не удалось загрузить список' }));
        return;
      }
      const items = res.data.items || [];
      if (!items.length) { wrap.appendChild(emptyState()); return; }
      const grid = h('div.grid.grid-2');
      for (const item of items) grid.appendChild(render(item));
      wrap.appendChild(grid);
      if (res.data.pages > 1) {
        wrap.appendChild(pager({
          page: res.data.page, pages: res.data.pages,
          onGo: p => draw({ ...query, page: p }),
        }));
      }
    }

    return draw;
  }

  /** Крупный переключатель «черновик / опубликован» вместо мелкого свитча:
      текущее состояние написано словами, мимо попасть сложно. */
  function draftToggle(get, set) {
    const btn = h('button.btn.btn-block', { type: 'button' });
    const paint = () => {
      const draft = !!get();
      btn.className = 'btn btn-block' + (draft ? '' : ' btn-primary');
      btn.textContent = draft ? '📝 Черновик — видишь только ты' : '🌍 Опубликован — видят все';
      btn.title = draft
        ? 'Нажми, чтобы опубликовать: после сохранения увидят все'
        : 'Нажми, чтобы вернуть в черновики';
    };
    btn.addEventListener('click', () => { set(!get()); paint(); });
    paint();
    return btn;
  }

  window.common = {
    modeBadge, byline, verifyBadge, draftBadge, draftToggle, itemStrip,
    modeTabs, pager, empty, voteBox, flagButton, FLAG_REASONS,
    buildCard, topCard, threadCard, selectField, inputField, listSection, TOP_KIND_RU,
    tierColorClass,
  };
})();
